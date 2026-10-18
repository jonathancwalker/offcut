import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicAdapter } from '../lib/provider-adapters/anthropic.mjs';

const key = 'anthropic-private-key-123';
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const generation = {
  model: 'claude-sonnet-5', instructions: 'Return JSON.', maxOutputTokens: 1024,
  messages: [{ role: 'user', text: 'Inspect.', images: [{ id: 'canvas', dataUrl: 'data:image/webp;base64,YQ==' }] }],
};

test('Anthropic adapter sends native image blocks and normalizes complete usage', async () => {
  const calls = [];
  const adapter = createAnthropicAdapter({ environmentKey: key, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return reply({
      id: 'msg_fixture', model: 'claude-sonnet-5', content: [{ type: 'text', text: '{"actions":[],"done":true}' }],
      usage: { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
    });
  } });
  const result = await adapter.capture().generate(generation);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].options.headers['x-api-key'], key);
  assert.equal(calls[0].options.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.messages[0].content[2], { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'YQ==' } });
  assert.equal(body.max_tokens, 1024);
  assert.deepEqual(result.usage, { inputTokens: 315, outputTokens: 40, totalTokens: 355, inputTokensDetails: { cachedTokens: 15 } });
  assert.equal(result.responseId, 'msg_fixture');
});

test('Anthropic model discovery is sorted and connection metadata never exposes keys', async () => {
  const adapter = createAnthropicAdapter({ fetchImpl: async () => reply({ data: [{ id: 'claude-z' }, { id: 'claude-a' }], echo: key }) });
  adapter.set({ apiKey: key });
  assert.deepEqual((await adapter.test()).models, ['claude-a', 'claude-z']);
  assert.ok(!JSON.stringify([adapter.metadata(), adapter.protocol()]).includes(key));
  assert.equal(adapter.forget().configured, false);
});

test('Anthropic failures are classified without retries or credential echoes', async () => {
  let calls = 0;
  const adapter = createAnthropicAdapter({ environmentKey: key, fetchImpl: async () => {
    calls++;
    return reply({ error: { type: 'rate_limit_error', message: key } }, 429);
  } });
  await assert.rejects(adapter.capture().generate(generation), error => error.code === 'RATE_LIMITED' && !error.message.includes(key));
  assert.equal(calls, 1);
});
