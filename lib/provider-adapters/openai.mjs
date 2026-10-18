/** Provider connections live only in this process; exports never contain keys. */
const API_BASE = 'https://api.openai.com/v1';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function fail(message, status = 400, code = 'PROVIDER_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.providerSafe = true;
  throw error;
}

function safeResponse(value, key) {
  // A provider error or unexpected response must not echo a credential into logs.
  const serialized = JSON.stringify(value);
  return JSON.parse(key ? serialized.split(key).join('[redacted]') : serialized);
}

async function readResponse(response) {
  const chunks = [];
  let size = 0;
  if (!response.body) fail('OpenAI returned an empty response.', 502);
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) fail('OpenAI returned an unexpectedly large response.', 502);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('OpenAI returned an unreadable response.', 502); }
}

function providerError(status, data) {
  if (status === 401) fail('OpenAI rejected this API key. Update the connection and try again.', 401, 'AUTHENTICATION_FAILED');
  if (status === 403) fail('This API key does not have access to the requested OpenAI resource.', 403, 'ACCESS_DENIED');
  if (status === 404) fail('The requested model is unavailable to this API key. Check its model ID.', 400, 'MODEL_UNAVAILABLE');
  if (status === 429) {
    const quota = data?.error?.code === 'insufficient_quota';
    fail(quota ? 'The OpenAI account has insufficient API quota. Check its billing and limits.' : 'OpenAI rate limited this request. The run stopped without automatically retrying.', 429, quota ? 'INSUFFICIENT_QUOTA' : 'RATE_LIMITED');
  }
  if (status === 400 || status === 422) fail('OpenAI rejected the request. Check that this model supports Responses, image input, and the chosen output limit.', 400, 'REQUEST_REJECTED');
  fail('OpenAI could not complete the request. The run stopped without automatically retrying.', 502, 'PROVIDER_UNAVAILABLE');
}

export function createOpenAIAdapter({ environmentKey = process.env.OPENAI_API_KEY || '', fetchImpl = globalThis.fetch } = {}) {
  let sessionKey = '';
  const envKey = typeof environmentKey === 'string' ? environmentKey.trim() : '';
  const metadata = () => ({ id: 'openai', name: 'OpenAI', configured: Boolean(sessionKey || envKey), keySource: sessionKey ? 'session' : envKey ? 'environment' : null });

  async function request(key, path, { body, signal } = {}) {
    const timeout = AbortSignal.timeout(body ? 120_000 : 15_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetchImpl(`${API_BASE}${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: combined,
        headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await readResponse(response);
      if (!response.ok) providerError(response.status, data);
      return safeResponse(data, key);
    } catch (error) {
      if (error.providerSafe) throw error;
      if (combined.aborted) fail(signal?.aborted ? 'The model request was cancelled.' : 'The model request timed out. It was not retried.', 408, 'REQUEST_ABORTED');
      fail('Could not reach OpenAI. Check the connection; this request was not retried.', 502, 'NETWORK_ERROR');
    }
  }

  function capture() {
    const key = sessionKey || envKey;
    if (!key) fail('Connect an OpenAI API key before starting an experiment.', 400, 'MISSING_CREDENTIAL');
    return {
      id: 'openai',
      metadata: { adapter: 'openai-responses-v1', endpoint: `${API_BASE}/responses`, imageDetail: 'high', store: false },
      async generate({ model, instructions, messages, maxOutputTokens, signal }) {
        const input = messages.map(message => {
          if (message.role === 'assistant') return { role: 'assistant', content: message.text };
          const content = [{ type: 'input_text', text: message.text }];
          for (const image of message.images || []) {
            content.push({ type: 'input_text', text: `Image: ${image.id}` });
            content.push({ type: 'input_image', image_url: image.dataUrl, detail: 'high' });
          }
          return { role: 'user', content };
        });
        const raw = await request(key, '/responses', {
          signal,
          body: { model, instructions, input, max_output_tokens: maxOutputTokens, store: false },
        });
        const text = (raw.output || []).filter(item => item.type === 'message')
          .flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('\n');
        // Keep incomplete/refusal outputs for the runner's audit and bounded validation loop.
        const usage = {
          inputTokens: raw.usage?.input_tokens ?? null,
          outputTokens: raw.usage?.output_tokens ?? null,
          totalTokens: raw.usage?.total_tokens ?? null,
        };
        if (raw.usage?.input_tokens_details && typeof raw.usage.input_tokens_details === 'object') {
          usage.inputTokensDetails = { cachedTokens: raw.usage.input_tokens_details.cached_tokens ?? null };
        }
        if (raw.usage?.output_tokens_details && typeof raw.usage.output_tokens_details === 'object') {
          usage.outputTokensDetails = { reasoningTokens: raw.usage.output_tokens_details.reasoning_tokens ?? null };
        }
        return {
          text, raw, model: typeof raw.model === 'string' ? raw.model : null, responseId: raw.id || null,
          usage,
        };
      },
    };
  }

  return {
    id: 'openai',
    metadata,
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
      const models = (Array.isArray(data.data) ? data.data : []).map(item => item.id).filter(id => typeof id === 'string').sort();
      return { ok: true, models, note: 'Authentication checked. Model listing does not verify image support or run an inference request.' };
    },
    capture,
  };
}
