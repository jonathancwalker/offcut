const CHAT_BASE = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const MODELS_URL = 'https://dashscope-intl.aliyuncs.com/api/v1/models';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function fail(message, status = 400, code = 'PROVIDER_ERROR') {
  throw Object.assign(new Error(message), { status, code, providerSafe: true });
}

async function readResponse(response) {
  const chunks = [];
  let size = 0;
  if (!response.body) fail('Alibaba Model Studio returned an empty response.', 502);
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) fail('Alibaba Model Studio returned an unexpectedly large response.', 502);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('Alibaba Model Studio returned an unreadable response.', 502); }
}

function providerError(status, data) {
  const code = data?.error?.code || data?.code;
  if (status === 401 || code === 'InvalidApiKey') fail('Alibaba Model Studio rejected this API key. Update the connection and try again.', 401, 'AUTHENTICATION_FAILED');
  if (status === 403) fail('This API key does not have access to the requested Qwen model.', 403, 'ACCESS_DENIED');
  if (status === 404) fail('The requested Qwen model is unavailable in the Singapore endpoint.', 400, 'MODEL_UNAVAILABLE');
  if (status === 429 || /Throttl|Quota/i.test(code || '')) fail('Alibaba Model Studio rate limited this request or has no remaining quota. The run stopped without retrying.', 429, 'RATE_LIMITED');
  if (status === 400 || status === 422) fail('Alibaba Model Studio rejected the request. Check the Qwen vision model, image input, and output limit.', 400, 'REQUEST_REJECTED');
  fail('Alibaba Model Studio could not complete the request. The run stopped without retrying.', 502, 'PROVIDER_UNAVAILABLE');
}

function imageUrl(dataUrl) {
  if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl || '')) fail('Qwen image input must be an embedded PNG, JPEG, or WebP image.');
  return { url: dataUrl };
}

function redact(value, key) {
  const serialized = JSON.stringify(value);
  return JSON.parse(key ? serialized.split(key).join('[redacted]') : serialized);
}

export function createAlibabaAdapter({ environmentKey = process.env.DASHSCOPE_API_KEY || '', fetchImpl = globalThis.fetch } = {}) {
  let sessionKey = '';
  const envKey = typeof environmentKey === 'string' ? environmentKey.trim() : '';
  const metadata = () => ({ id: 'alibaba', name: 'Alibaba Qwen', configured: Boolean(sessionKey || envKey), keySource: sessionKey ? 'session' : envKey ? 'environment' : null });

  async function request(key, url, { body, signal } = {}) {
    const timeout = AbortSignal.timeout(body ? 120_000 : 15_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetchImpl(url, {
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
      fail('Could not reach Alibaba Model Studio. Check the connection; this request was not retried.', 502, 'NETWORK_ERROR');
    }
  }

  function capture() {
    const key = sessionKey || envKey;
    if (!key) fail('Connect an Alibaba Model Studio API key before starting an experiment.', 400, 'MISSING_CREDENTIAL');
    return {
      id: 'alibaba',
      metadata: { adapter: 'alibaba-openai-chat-v1', endpoint: `${CHAT_BASE}/chat/completions`, region: 'Singapore', nativeImageParts: true },
      async generate({ model, instructions, messages, maxOutputTokens, signal }) {
        const bodyMessages = [{ role: 'system', content: instructions }, ...messages.map(message => ({
          role: message.role,
          content: message.role === 'assistant' ? message.text : [
            { type: 'text', text: message.text },
            ...(message.images || []).flatMap(image => [{ type: 'text', text: `Image: ${image.id}` }, { type: 'image_url', image_url: imageUrl(image.dataUrl) }]),
          ],
        }))];
        const raw = await request(key, `${CHAT_BASE}/chat/completions`, {
          signal,
          body: { model, messages: bodyMessages, max_tokens: maxOutputTokens, stream: false, enable_thinking: false },
        });
        const text = (raw.choices || []).map(choice => choice.message?.content).filter(value => typeof value === 'string').join('\n');
        const usage = {
          inputTokens: raw.usage?.prompt_tokens ?? null,
          outputTokens: raw.usage?.completion_tokens ?? null,
          totalTokens: raw.usage?.total_tokens ?? null,
        };
        if (Number.isSafeInteger(raw.usage?.prompt_tokens_details?.cached_tokens)) usage.inputTokensDetails = { cachedTokens: raw.usage.prompt_tokens_details.cached_tokens };
        if (Number.isSafeInteger(raw.usage?.completion_tokens_details?.reasoning_tokens)) usage.outputTokensDetails = { reasoningTokens: raw.usage.completion_tokens_details.reasoning_tokens };
        return { text, raw, model: typeof raw.model === 'string' ? raw.model : null, responseId: raw.id || raw.request_id || null, usage };
      },
    };
  }

  return {
    id: 'alibaba', metadata,
    protocol() { return { adapter: 'alibaba-openai-chat-v1', endpoint: `${CHAT_BASE}/chat/completions`, region: 'Singapore', nativeImageParts: true, thinking: false }; },
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
      const data = await request(key, MODELS_URL);
      const entries = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
      const models = entries.map(item => item?.id || item?.model || item?.model_name).filter(id => typeof id === 'string').sort();
      return { ok: true, models, note: 'Authentication and Singapore model listing checked. Run calibration to verify vision access and billing.' };
    },
    capture,
  };
}
