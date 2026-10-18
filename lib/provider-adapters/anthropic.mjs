const API_BASE = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function fail(message, status = 400, code = 'PROVIDER_ERROR') {
  throw Object.assign(new Error(message), { status, code, providerSafe: true });
}

async function readResponse(response) {
  const chunks = [];
  let size = 0;
  if (!response.body) fail('Anthropic returned an empty response.', 502);
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) fail('Anthropic returned an unexpectedly large response.', 502);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('Anthropic returned an unreadable response.', 502); }
}

function providerError(status, data) {
  const type = data?.error?.type;
  if (status === 401 || type === 'authentication_error') fail('Anthropic rejected this API key. Update the connection and try again.', 401, 'AUTHENTICATION_FAILED');
  if (status === 403 || type === 'permission_error') fail('This API key does not have access to the requested Claude model.', 403, 'ACCESS_DENIED');
  if (status === 404 || type === 'not_found_error') fail('The requested Claude model is unavailable. Check its exact model ID.', 400, 'MODEL_UNAVAILABLE');
  if (status === 429 || type === 'rate_limit_error') fail('Anthropic rate limited this request. The run stopped without retrying.', 429, 'RATE_LIMITED');
  if (status === 400 || status === 413 || status === 422 || type === 'invalid_request_error') fail('Anthropic rejected the request. Check image support, context size, and the output limit.', 400, 'REQUEST_REJECTED');
  fail('Anthropic could not complete the request. The run stopped without retrying.', 502, 'PROVIDER_UNAVAILABLE');
}

function imageSource(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl || '');
  if (!match) fail('Claude image input must be an embedded PNG, JPEG, or WebP image.');
  return { type: 'base64', media_type: match[1], data: match[2] };
}

function redact(value, key) {
  const serialized = JSON.stringify(value);
  return JSON.parse(key ? serialized.split(key).join('[redacted]') : serialized);
}

export function createAnthropicAdapter({ environmentKey = process.env.ANTHROPIC_API_KEY || '', fetchImpl = globalThis.fetch } = {}) {
  let sessionKey = '';
  const envKey = typeof environmentKey === 'string' ? environmentKey.trim() : '';
  const metadata = () => ({ id: 'anthropic', name: 'Anthropic Claude', configured: Boolean(sessionKey || envKey), keySource: sessionKey ? 'session' : envKey ? 'environment' : null });

  async function request(key, path, { body, signal } = {}) {
    const timeout = AbortSignal.timeout(body ? 120_000 : 15_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetchImpl(`${API_BASE}${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: combined,
        headers: { 'x-api-key': key, 'anthropic-version': API_VERSION, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await readResponse(response);
      if (!response.ok) providerError(response.status, data);
      return redact(data, key);
    } catch (error) {
      if (error.providerSafe) throw error;
      if (combined.aborted) fail(signal?.aborted ? 'The model request was cancelled.' : 'The model request timed out. It was not retried.', 408, 'REQUEST_ABORTED');
      fail('Could not reach Anthropic. Check the connection; this request was not retried.', 502, 'NETWORK_ERROR');
    }
  }

  function capture() {
    const key = sessionKey || envKey;
    if (!key) fail('Connect an Anthropic API key before starting an experiment.', 400, 'MISSING_CREDENTIAL');
    return {
      id: 'anthropic',
      metadata: { adapter: 'anthropic-messages-v1', endpoint: `${API_BASE}/v1/messages`, base64Images: true, apiVersion: API_VERSION },
      async generate({ model, instructions, messages, maxOutputTokens, signal }) {
        const bodyMessages = messages.map(message => ({
          role: message.role,
          content: [
            { type: 'text', text: message.text },
            ...(message.images || []).flatMap(image => [{ type: 'text', text: `Image: ${image.id}` }, { type: 'image', source: imageSource(image.dataUrl) }]),
          ],
        }));
        const raw = await request(key, '/v1/messages', { signal, body: { model, system: instructions, messages: bodyMessages, max_tokens: maxOutputTokens } });
        const text = (raw.content || []).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
        const baseInputTokens = raw.usage?.input_tokens ?? null;
        const outputTokens = raw.usage?.output_tokens ?? null;
        const cachedTokens = (raw.usage?.cache_read_input_tokens ?? 0) + (raw.usage?.cache_creation_input_tokens ?? 0);
        const inputTokens = Number.isSafeInteger(baseInputTokens) && Number.isSafeInteger(cachedTokens) ? baseInputTokens + cachedTokens : null;
        const usage = { inputTokens, outputTokens, totalTokens: Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens) ? inputTokens + outputTokens : null };
        if (cachedTokens) usage.inputTokensDetails = { cachedTokens };
        return { text, raw, model: typeof raw.model === 'string' ? raw.model : null, responseId: raw.id || null, usage };
      },
    };
  }

  return {
    id: 'anthropic', metadata,
    protocol() { return { adapter: 'anthropic-messages-v1', endpoint: `${API_BASE}/v1/messages`, apiVersion: API_VERSION, base64Images: true }; },
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
      const data = await request(key, '/v1/models?limit=1000');
      const models = (Array.isArray(data.data) ? data.data : []).map(item => item?.id).filter(id => typeof id === 'string').sort();
      return { ok: true, models, note: 'Authentication and model listing checked. Run calibration to verify image support and billing.' };
    },
    capture,
  };
}
