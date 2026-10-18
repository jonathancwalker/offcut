const API_BASE = 'https://api.x.ai/v1';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function fail(message, status = 400, code = 'PROVIDER_ERROR') {
  throw Object.assign(new Error(message), { status, code, providerSafe: true });
}

async function readResponse(response) {
  const chunks = [];
  let size = 0;
  if (!response.body) fail('xAI returned an empty response.', 502);
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) fail('xAI returned an unexpectedly large response.', 502);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('xAI returned an unreadable response.', 502); }
}

function providerError(status, data) {
  const code = data?.error?.code;
  if (status === 401) fail('xAI rejected this API key. Update the connection and try again.', 401, 'AUTHENTICATION_FAILED');
  if (status === 403) fail('This API key does not have access to the requested Grok model.', 403, 'ACCESS_DENIED');
  if (status === 404) fail('The requested Grok model is unavailable to this API key.', 400, 'MODEL_UNAVAILABLE');
  if (status === 429 || code === 'rate_limit_exceeded') fail('xAI rate limited this request or the team has no remaining credits. The run stopped without retrying.', 429, 'RATE_LIMITED');
  if (status === 400 || status === 422) fail('xAI rejected the request. Check that the Grok model accepts image input and the selected source formats.', 400, 'REQUEST_REJECTED');
  fail('xAI could not complete the request. The run stopped without retrying.', 502, 'PROVIDER_UNAVAILABLE');
}

function imageDataUrl(dataUrl) {
  if (!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl || '')) fail('Grok supports embedded PNG and JPEG images for this experiment.');
  return dataUrl;
}

function redact(value, key) {
  const serialized = JSON.stringify(value);
  return JSON.parse(key ? serialized.split(key).join('[redacted]') : serialized);
}

export function createXAIAdapter({ environmentKey = process.env.XAI_API_KEY || '', fetchImpl = globalThis.fetch } = {}) {
  let sessionKey = '';
  const envKey = typeof environmentKey === 'string' ? environmentKey.trim() : '';
  const metadata = () => ({ id: 'xai', name: 'xAI Grok', configured: Boolean(sessionKey || envKey), keySource: sessionKey ? 'session' : envKey ? 'environment' : null });

  async function request(key, path, { body, signal } = {}) {
    const timeout = AbortSignal.timeout(body ? 180_000 : 15_000);
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
      if (combined.aborted) fail(signal?.aborted ? 'The model request was cancelled.' : 'The model request timed out. It was not retried.', 408, 'REQUEST_ABORTED');
      fail('Could not reach xAI. Check the connection; this request was not retried.', 502, 'NETWORK_ERROR');
    }
  }

  function capture() {
    const key = sessionKey || envKey;
    if (!key) fail('Connect an xAI API key before starting an experiment.', 400, 'MISSING_CREDENTIAL');
    return {
      id: 'xai',
      metadata: { adapter: 'xai-responses-v1', endpoint: `${API_BASE}/responses`, imageDetail: 'high', store: false },
      async generate({ model, instructions, messages, maxOutputTokens, signal }) {
        const input = messages.map(message => {
          if (message.role === 'assistant') return { role: 'assistant', content: message.text };
          return {
            role: 'user',
            content: [{ type: 'input_text', text: message.text }, ...(message.images || []).flatMap(image => [
              { type: 'input_text', text: `Image: ${image.id}` }, { type: 'input_image', image_url: imageDataUrl(image.dataUrl), detail: 'high' },
            ])],
          };
        });
        const raw = await request(key, '/responses', { signal, body: { model, instructions, input, max_output_tokens: maxOutputTokens, store: false } });
        const text = (raw.output || []).filter(item => item.type === 'message')
          .flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('\n');
        const usage = {
          inputTokens: raw.usage?.input_tokens ?? null,
          outputTokens: raw.usage?.output_tokens ?? null,
          totalTokens: raw.usage?.total_tokens ?? null,
        };
        if (raw.usage?.input_tokens_details && typeof raw.usage.input_tokens_details === 'object') usage.inputTokensDetails = { cachedTokens: raw.usage.input_tokens_details.cached_tokens ?? null };
        if (raw.usage?.output_tokens_details && typeof raw.usage.output_tokens_details === 'object') usage.outputTokensDetails = { reasoningTokens: raw.usage.output_tokens_details.reasoning_tokens ?? null };
        return { text, raw, model: typeof raw.model === 'string' ? raw.model : null, responseId: raw.id || null, usage };
      },
    };
  }

  return {
    id: 'xai', metadata,
    protocol() { return { adapter: 'xai-responses-v1', endpoint: `${API_BASE}/responses`, imageDetail: 'high', store: false, studyAccounting: 'qualification_required' }; },
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
      const data = await request(key, '/models');
      const entries = Array.isArray(data.data) ? data.data : [];
      const models = entries.filter(item => Array.isArray(item.input_modalities) && item.input_modalities.includes('image'))
        .map(item => item?.id).filter(id => typeof id === 'string').sort();
      return { ok: true, models, note: 'Authentication and image-capable model listing checked. Grok remains unavailable to budgeted Studies until an image-token bound is qualified.' };
    },
    capture,
  };
}
