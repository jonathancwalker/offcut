const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function fail(message, status = 400, code = 'PROVIDER_ERROR') {
  throw Object.assign(new Error(message), { status, code, providerSafe: true });
}

async function readResponse(response) {
  const chunks = [];
  let size = 0;
  if (!response.body) fail('Google returned an empty response.', 502);
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) fail('Google returned an unexpectedly large response.', 502);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('Google returned an unreadable response.', 502); }
}

function providerError(status, data) {
  const providerStatus = data?.error?.status;
  if (status === 401 || providerStatus === 'UNAUTHENTICATED') fail('Google rejected this API key. Update the connection and try again.', 401, 'AUTHENTICATION_FAILED');
  if (status === 403 || providerStatus === 'PERMISSION_DENIED') fail('This API key does not have access to the requested Google model.', 403, 'ACCESS_DENIED');
  if (status === 404) fail('The requested Google model is unavailable. Check its exact model ID.', 400, 'MODEL_UNAVAILABLE');
  if (status === 429 || providerStatus === 'RESOURCE_EXHAUSTED') fail('Google rate limited this request or the project has no remaining quota. The run stopped without retrying.', 429, 'RATE_LIMITED');
  if (status === 400 || status === 422) fail('Google rejected the request. Check that this model supports image input and the chosen output limit.', 400, 'REQUEST_REJECTED');
  fail('Google could not complete the request. The run stopped without retrying.', 502, 'PROVIDER_UNAVAILABLE');
}

function inlineData(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl || '');
  if (!match) fail('Google image input must be an embedded PNG, JPEG, or WebP image.');
  return { mimeType: match[1], data: match[2] };
}

function redact(value, key) {
  const serialized = JSON.stringify(value);
  return JSON.parse(key ? serialized.split(key).join('[redacted]') : serialized);
}

export function createGoogleAdapter({ environmentKey = process.env.GEMINI_API_KEY || '', fetchImpl = globalThis.fetch } = {}) {
  let sessionKey = '';
  const envKey = typeof environmentKey === 'string' ? environmentKey.trim() : '';
  const metadata = () => ({ id: 'google', name: 'Google Gemini', configured: Boolean(sessionKey || envKey), keySource: sessionKey ? 'session' : envKey ? 'environment' : null });

  async function request(key, path, { body, signal } = {}) {
    const timeout = AbortSignal.timeout(body ? 120_000 : 15_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetchImpl(`${API_BASE}${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: combined,
        headers: { 'x-goog-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await readResponse(response);
      if (!response.ok) providerError(response.status, data);
      return redact(data, key);
    } catch (error) {
      if (error.providerSafe) throw error;
      if (combined.aborted) fail(signal?.aborted ? 'The model request was cancelled.' : 'The model request timed out. It was not retried.', 408, 'REQUEST_ABORTED');
      fail('Could not reach Google. Check the connection; this request was not retried.', 502, 'NETWORK_ERROR');
    }
  }

  function capture() {
    const key = sessionKey || envKey;
    if (!key) fail('Connect a Google Gemini API key before starting an experiment.', 400, 'MISSING_CREDENTIAL');
    return {
      id: 'google',
      metadata: { adapter: 'google-generate-content-v1beta', endpoint: `${API_BASE}/models/{model}:generateContent`, inlineImages: true },
      async generate({ model, instructions, messages, maxOutputTokens, signal }) {
        const contents = messages.map(message => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [
            { text: message.text },
            ...(message.images || []).flatMap(image => [{ text: `Image: ${image.id}` }, { inlineData: inlineData(image.dataUrl) }]),
          ],
        }));
        const raw = await request(key, `/models/${encodeURIComponent(model)}:generateContent`, {
          signal,
          body: {
            systemInstruction: { parts: [{ text: instructions }] }, contents,
            generationConfig: { maxOutputTokens, responseMimeType: 'application/json' },
          },
        });
        const text = (raw.candidates || []).flatMap(candidate => candidate.content?.parts || []).map(part => typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n');
        const inputTokens = raw.usageMetadata?.promptTokenCount ?? null;
        const visibleOutput = raw.usageMetadata?.candidatesTokenCount ?? null;
        const reasoningTokens = raw.usageMetadata?.thoughtsTokenCount ?? 0;
        const outputTokens = Number.isSafeInteger(visibleOutput) && Number.isSafeInteger(reasoningTokens) ? visibleOutput + reasoningTokens : null;
        const usage = { inputTokens, outputTokens, totalTokens: raw.usageMetadata?.totalTokenCount ?? null };
        if (Number.isSafeInteger(raw.usageMetadata?.cachedContentTokenCount)) usage.inputTokensDetails = { cachedTokens: raw.usageMetadata.cachedContentTokenCount };
        if (Number.isSafeInteger(reasoningTokens)) usage.outputTokensDetails = { reasoningTokens };
        return { text, raw, model: typeof raw.modelVersion === 'string' ? raw.modelVersion : null, responseId: raw.responseId || null, usage };
      },
    };
  }

  return {
    id: 'google', metadata,
    protocol() { return { adapter: 'google-generate-content-v1beta', endpoint: `${API_BASE}/models/{model}:generateContent`, inlineImages: true, responseMimeType: 'application/json' }; },
    set(body) {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'apiKey')) fail('Supply only an API key.');
      if (typeof body.apiKey !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(body.apiKey.trim())) fail('Enter a valid API key with no spaces.');
      sessionKey = body.apiKey.trim();
      return metadata();
    },
    forget() { sessionKey = ''; return metadata(); },
    async test() {
      const key = sessionKey || envKey;
      if (!key) fail('Enter an API key first.');
      const data = await request(key, '/models?pageSize=1000');
      const models = (Array.isArray(data.models) ? data.models : [])
        .filter(item => Array.isArray(item.supportedGenerationMethods) && item.supportedGenerationMethods.includes('generateContent'))
        .map(item => typeof item.name === 'string' ? item.name.replace(/^models\//, '') : '').filter(Boolean).sort();
      return { ok: true, models, note: 'Authentication and generateContent listing checked. Run calibration to verify image support and billing.' };
    },
    capture,
  };
}
