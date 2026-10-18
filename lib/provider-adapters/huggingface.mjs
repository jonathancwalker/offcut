const API_BASE = 'https://router.huggingface.co/v1';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const PINNED_ROUTE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+:[a-z0-9-]+$/;

function fail(message, status = 400, code = 'PROVIDER_ERROR') {
  throw Object.assign(new Error(message), { status, code, providerSafe: true });
}

async function readResponse(response) {
  const chunks = [];
  let size = 0;
  if (!response.body) fail('Hugging Face returned an empty response.', 502);
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) fail('Hugging Face returned an unexpectedly large response.', 502);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('Hugging Face returned an unreadable response.', 502); }
}

function providerError(status, data) {
  if (status === 401) fail('Hugging Face rejected this token. Update the connection and try again.', 401, 'AUTHENTICATION_FAILED');
  if (status === 403) fail('This token or account cannot use the selected inference provider.', 403, 'ACCESS_DENIED');
  if (status === 404) fail('The selected open VLM route is no longer available.', 400, 'MODEL_UNAVAILABLE');
  if (status === 429) fail('Hugging Face or its inference provider rate limited this request. The run stopped without retrying.', 429, 'RATE_LIMITED');
  if (status === 400 || status === 422) fail('The inference provider rejected the request. Recheck that this exact route supports conversational image input.', 400, 'REQUEST_REJECTED');
  fail('Hugging Face could not complete the request. The run stopped without retrying.', 502, 'PROVIDER_UNAVAILABLE');
}

function imageUrl(dataUrl) {
  if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl || '')) fail('The open VLM route requires an embedded PNG, JPEG, or WebP image.');
  return { url: dataUrl };
}

function redact(value, key) {
  const serialized = JSON.stringify(value);
  return JSON.parse(key ? serialized.split(key).join('[redacted]') : serialized);
}

export function createHuggingFaceAdapter({ environmentKey = process.env.HF_TOKEN || '', fetchImpl = globalThis.fetch } = {}) {
  let sessionKey = '';
  const envKey = typeof environmentKey === 'string' ? environmentKey.trim() : '';
  const metadata = () => ({ id: 'huggingface', name: 'Hugging Face VLM', configured: Boolean(sessionKey || envKey), keySource: sessionKey ? 'session' : envKey ? 'environment' : null });

  async function request(key, path, { body, signal } = {}) {
    const timeout = AbortSignal.timeout(body ? 180_000 : 20_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetchImpl(`${API_BASE}${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: combined,
        headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await readResponse(response);
      if (!response.ok) providerError(response.status, data);
      return redact(data, key);
    } catch (error) {
      if (error.providerSafe) throw error;
      if (combined.aborted) fail(signal?.aborted ? 'The model request was cancelled.' : 'The open-model request timed out. It was not retried.', 408, 'REQUEST_ABORTED');
      fail('Could not reach Hugging Face. Check the connection; this request was not retried.', 502, 'NETWORK_ERROR');
    }
  }

  function capture() {
    const key = sessionKey || envKey;
    if (!key) fail('Connect a Hugging Face token with Inference Providers permission before starting an experiment.', 400, 'MISSING_CREDENTIAL');
    return {
      id: 'huggingface',
      metadata: { adapter: 'huggingface-chat-completions-v1', endpoint: `${API_BASE}/chat/completions`, explicitInferenceProvider: true, nativeImageParts: true },
      async generate({ model, instructions, messages, maxOutputTokens, signal }) {
        if (!PINNED_ROUTE.test(model)) fail('Choose an image-capable Hugging Face route with an explicit inference-provider suffix.', 400, 'MODEL_UNAVAILABLE');
        const bodyMessages = [{ role: 'system', content: instructions }, ...messages.map(message => ({
          role: message.role,
          content: message.role === 'assistant' ? message.text : [
            { type: 'text', text: message.text },
            ...(message.images || []).flatMap(image => [{ type: 'text', text: `Image: ${image.id}` }, { type: 'image_url', image_url: imageUrl(image.dataUrl) }]),
          ],
        }))];
        const raw = await request(key, '/chat/completions', { signal, body: { model, messages: bodyMessages, max_tokens: maxOutputTokens, stream: false } });
        const text = (raw.choices || []).map(choice => choice.message?.content).filter(value => typeof value === 'string').join('\n');
        const usage = { inputTokens: raw.usage?.prompt_tokens ?? null, outputTokens: raw.usage?.completion_tokens ?? null, totalTokens: raw.usage?.total_tokens ?? null };
        if (Number.isSafeInteger(raw.usage?.prompt_tokens_details?.cached_tokens)) usage.inputTokensDetails = { cachedTokens: raw.usage.prompt_tokens_details.cached_tokens };
        if (Number.isSafeInteger(raw.usage?.completion_tokens_details?.reasoning_tokens)) usage.outputTokensDetails = { reasoningTokens: raw.usage.completion_tokens_details.reasoning_tokens };
        return { text, raw, model: typeof raw.model === 'string' ? raw.model : model, responseId: raw.id || null, usage };
      },
    };
  }

  return {
    id: 'huggingface', metadata,
    protocol() { return { adapter: 'huggingface-chat-completions-v1', endpoint: `${API_BASE}/chat/completions`, explicitInferenceProvider: true, nativeImageParts: true, studyAccounting: 'qualification_required' }; },
    set(body) {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'apiKey')) fail('Supply only a Hugging Face token.');
      if (typeof body.apiKey !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(body.apiKey.trim())) fail('Enter a valid token with no spaces.');
      sessionKey = body.apiKey.trim();
      return metadata();
    },
    forget() { sessionKey = ''; return metadata(); },
    async test() {
      const key = sessionKey || envKey;
      if (!key) fail('Enter a Hugging Face token first.');
      const data = await request(key, '/models');
      const entries = Array.isArray(data.data) ? data.data : [];
      const models = entries.filter(item => item?.architecture?.input_modalities?.includes('image'))
        .flatMap(item => (item.providers || []).filter(provider => provider?.status === 'live' && typeof provider.provider === 'string')
          .map(provider => `${item.id}:${provider.provider}`)).filter(id => PINNED_ROUTE.test(id)).sort();
      return {
        ok: true, models,
        note: 'Only routes whose live provider metadata declares image input are shown. This is the required gate for DeepSeek and other open models; run calibration before collection.',
      };
    },
    capture,
  };
}
