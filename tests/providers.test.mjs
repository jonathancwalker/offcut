import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderRegistry } from '../lib/providers.mjs';

const key = 'test-private-key-123';
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const generation = { model: 'fixture-vision', instructions: 'Return JSON.', messages: [{ role: 'user', text: 'Inspect the canvas.', images: [{ id: 'canvas', dataUrl: 'data:image/png;base64,YQ==' }] }], maxOutputTokens: 512 };

test('registry validates and dispatches independent adapter lifecycles', async () => {
  const calls = [];
  const adapter = id => ({
    id,
    metadata: () => ({ id, name: id.toUpperCase(), configured: true, keySource: 'fixture' }),
    protocol: () => ({ adapter: `${id}-v1`, endpoint: `https://${id}.invalid/generate` }),
    set: body => { calls.push([id, 'set', body]); return { id, configured: true }; },
    forget: () => { calls.push([id, 'forget']); return { id, configured: false }; },
    test: async () => { calls.push([id, 'test']); return { models: [`${id}-vision`] }; },
    capture: () => { calls.push([id, 'capture']); return { id, metadata: { adapter: `${id}-v1` }, generate: async () => ({ text: id }) }; },
  });
  const registry = createProviderRegistry({ adapters: [adapter('alpha'), adapter('beta')] });
  assert.deepEqual(registry.ids(), ['alpha', 'beta']);
  assert.deepEqual(registry.list().providers.map(item => item.id), ['alpha', 'beta']);
  assert.deepEqual(registry.protocols(['beta', 'alpha', 'beta']), {
    alpha: { adapter: 'alpha-v1', endpoint: 'https://alpha.invalid/generate' },
    beta: { adapter: 'beta-v1', endpoint: 'https://beta.invalid/generate' },
  });
  assert.deepEqual((await registry.test('beta')).models, ['beta-vision']);
  assert.equal(registry.capture('alpha').id, 'alpha');
  registry.set('beta', { token: 'private' });
  registry.forget('alpha');
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [['beta', 'test'], ['alpha', 'capture'], ['beta', 'set'], ['alpha', 'forget']]);
  assert.throws(() => registry.capture('missing'), error => error.code === 'PROVIDER_UNSUPPORTED' && error.status === 404);
  assert.throws(() => createProviderRegistry({ adapters: [adapter('same'), adapter('same')] }), /duplicated/);
  assert.throws(() => createProviderRegistry({ adapters: [{ id: 'broken' }] }), /missing metadata/);
  const brokenCapture = adapter('broken-capture'); brokenCapture.capture = () => ({ id: 'wrong', metadata: {}, generate() {} });
  assert.throws(() => createProviderRegistry({ adapters: [brokenCapture] }).capture('broken-capture'), /invalid captured connection/);
});

test('adapter attaches images natively and captures the credential without exporting it', async () => {
  const calls = [];
  const registry = createProviderRegistry({ environmentKey: '', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return reply({ id: 'response-1', model: 'fixture-vision-version', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"actions":[],"done":true}' }] }], usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 } });
  } });
  assert.throws(() => registry.capture('openai'), /Connect/);
  registry.set('openai', { apiKey: key });
  const connection = registry.capture('openai');
  registry.set('openai', { apiKey: 'replacement-private-key' });
  const result = await connection.generate(generation);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${key}`);
  assert.equal(calls[0].options.redirect, 'error');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 512);
  assert.equal(body.input[0].content[2].type, 'input_image');
  assert.equal(body.input[0].content[2].detail, 'high');
  assert.equal(body.input[0].content[2].image_url, generation.messages[0].images[0].dataUrl);
  assert.ok(!body.input[0].content[0].text.includes('base64'));
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 8, totalTokens: 38 });
  assert.equal(result.model, 'fixture-vision-version');
  assert.ok(!JSON.stringify([result, registry.list(), connection.metadata]).includes(key));
});

test('connection checks use only model listing and forgetting restores environment connection', async () => {
  const calls = [];
  const registry = createProviderRegistry({ environmentKey: key, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return reply({ data: [{ id: 'b' }, { id: 'a' }] });
  } });
  registry.set('openai', { apiKey: 'session-key-123' });
  assert.equal(registry.list().providers[0].keySource, 'session');
  assert.deepEqual((await registry.test('openai')).models, ['a', 'b']);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(calls.length, 1);
  assert.equal(registry.forget('openai').keySource, 'environment');
  assert.throws(() => registry.set('openai', { apiKey: key, baseUrl: 'https://elsewhere.invalid' }), /only/);
  assert.throws(() => registry.set('openai', { apiKey: 'contains spaces' }), /no spaces/);
});

test('provider failures never echo keys or automatically retry', async () => {
  let calls = 0;
  const registry = createProviderRegistry({ environmentKey: key, fetchImpl: async () => {
    calls++;
    return reply({ error: { message: `Invalid secret ${key}` } }, 401);
  } });
  await assert.rejects(registry.capture('openai').generate(generation), error => {
    assert.equal(error.code, 'AUTHENTICATION_FAILED');
    assert.ok(!error.message.includes(key));
    return true;
  });
  assert.equal(calls, 1);
  const transport = createProviderRegistry({ environmentKey: key, fetchImpl: async () => { throw Object.assign(new Error(key), { status: 599 }); } });
  await assert.rejects(transport.test('openai'), error => !error.message.includes(key) && error.code === 'NETWORK_ERROR');
});

test('unexpected credential echoes in successful provider responses are redacted', async () => {
  const registry = createProviderRegistry({ environmentKey: key, fetchImpl: async () => reply({ output: [{ type: 'message', content: [{ type: 'output_text', text: key }] }] }) });
  const response = await registry.capture('openai').generate(generation);
  assert.equal(response.text, '[redacted]');
  assert.ok(!JSON.stringify(response).includes(key));
  assert.deepEqual(response.usage, { inputTokens: null, outputTokens: null, totalTokens: null });
});

test('adapter preserves billable cache and reasoning usage details without double-counting totals', async () => {
  const registry = createProviderRegistry({ environmentKey: key, fetchImpl: async () => reply({
    id: 'response-detailed', model: 'fixture-vision', output: [],
    usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140, input_tokens_details: { cached_tokens: 75 }, output_tokens_details: { reasoning_tokens: 30 } },
  }) });
  const response = await registry.capture('openai').generate(generation);
  assert.deepEqual(response.usage, {
    inputTokens: 100, outputTokens: 40, totalTokens: 140,
    inputTokensDetails: { cachedTokens: 75 }, outputTokensDetails: { reasoningTokens: 30 },
  });
});
