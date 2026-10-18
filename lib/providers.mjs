import { createOpenAIAdapter } from './provider-adapters/openai.mjs';
import { createGoogleAdapter } from './provider-adapters/google.mjs';
import { createAnthropicAdapter } from './provider-adapters/anthropic.mjs';
import { createAlibabaAdapter } from './provider-adapters/alibaba.mjs';
import { createXAIAdapter } from './provider-adapters/xai.mjs';
import { createHuggingFaceAdapter } from './provider-adapters/huggingface.mjs';

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,39}$/;

function fail(message, status = 400, code = 'PROVIDER_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.providerSafe = true;
  throw error;
}

function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || !PROVIDER_ID.test(adapter.id || '')) {
    throw new TypeError('Each provider adapter needs a lowercase provider id.');
  }
  for (const method of ['metadata', 'protocol', 'set', 'forget', 'test', 'capture']) {
    if (typeof adapter[method] !== 'function') throw new TypeError(`Provider ${adapter.id} is missing ${method}().`);
  }
  const metadata = adapter.metadata();
  if (!metadata || metadata.id !== adapter.id || typeof metadata.name !== 'string' || typeof metadata.configured !== 'boolean') {
    throw new TypeError(`Provider ${adapter.id} returned invalid connection metadata.`);
  }
  return adapter;
}

function validateConnection(adapter, connection) {
  if (!connection || typeof connection !== 'object' || connection.id !== adapter.id || typeof connection.generate !== 'function'
    || !connection.metadata || typeof connection.metadata !== 'object' || Array.isArray(connection.metadata)) {
    throw new TypeError(`Provider ${adapter.id} returned an invalid captured connection.`);
  }
  return connection;
}

/** Process-local dispatch. Each adapter owns its credentials and wire format. */
export function createProviderRegistry({
  environmentKey = process.env.OPENAI_API_KEY || '',
  environmentKeys = {},
  fetchImpl = globalThis.fetch,
  adapters,
} = {}) {
  const configured = adapters ?? [
    createOpenAIAdapter({ environmentKey: environmentKeys.openai ?? environmentKey, fetchImpl }),
    createGoogleAdapter({ environmentKey: environmentKeys.google ?? process.env.GEMINI_API_KEY ?? '', fetchImpl }),
    createAnthropicAdapter({ environmentKey: environmentKeys.anthropic ?? process.env.ANTHROPIC_API_KEY ?? '', fetchImpl }),
    createAlibabaAdapter({ environmentKey: environmentKeys.alibaba ?? process.env.DASHSCOPE_API_KEY ?? '', fetchImpl }),
    createXAIAdapter({ environmentKey: environmentKeys.xai ?? process.env.XAI_API_KEY ?? '', fetchImpl }),
    createHuggingFaceAdapter({ environmentKey: environmentKeys.huggingface ?? process.env.HF_TOKEN ?? '', fetchImpl }),
  ];
  if (!Array.isArray(configured) || configured.length < 1) throw new TypeError('At least one provider adapter is required.');
  const registry = new Map();
  for (const candidate of configured) {
    const adapter = validateAdapter(candidate);
    if (registry.has(adapter.id)) throw new TypeError(`Provider adapter ${adapter.id} is duplicated.`);
    registry.set(adapter.id, adapter);
  }

  const adapter = id => {
    if (typeof id !== 'string' || !PROVIDER_ID.test(id)) fail('Choose a valid provider identifier.');
    const value = registry.get(id);
    if (!value) fail('This provider is not supported yet.', 404, 'PROVIDER_UNSUPPORTED');
    return value;
  };

  return {
    ids: () => [...registry.keys()],
    has: id => registry.has(id),
    list: () => ({ providers: [...registry.values()].map(value => value.metadata()), defaultModel: '' }),
    protocols: ids => {
      if (!Array.isArray(ids) || ids.length < 1) throw new TypeError('At least one provider protocol is required.');
      return Object.fromEntries([...new Set(ids)].sort().map(id => {
        const value = adapter(id).protocol();
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Provider ${id} returned invalid protocol metadata.`);
        return [id, structuredClone(value)];
      }));
    },
    set: (id, body) => adapter(id).set(body),
    forget: id => adapter(id).forget(),
    test: id => adapter(id).test(),
    capture: id => { const value = adapter(id); return validateConnection(value, value.capture()); },
  };
}

export { createOpenAIAdapter } from './provider-adapters/openai.mjs';
export { createGoogleAdapter } from './provider-adapters/google.mjs';
export { createAnthropicAdapter } from './provider-adapters/anthropic.mjs';
export { createAlibabaAdapter } from './provider-adapters/alibaba.mjs';
export { createXAIAdapter } from './provider-adapters/xai.mjs';
export { createHuggingFaceAdapter } from './provider-adapters/huggingface.mjs';
