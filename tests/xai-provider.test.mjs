import test from 'node:test';
import assert from 'node:assert/strict';
import { createXAIAdapter } from '../lib/provider-adapters/xai.mjs';

const key = 'xai-private-key-123';
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const generation = {
  model: 'grok-4.7', instructions: 'Return JSON.', maxOutputTokens: 2048,
  messages: [{ role: 'user', text: 'Inspect.', images: [{ id: 'canvas', dataUrl: 'data:image/png;base64,YQ==' }] }],
};

test('xAI adapter uses stateless Responses image parts and preserves detailed usage', async () => {
  const calls = [];
  const adapter = createXAIAdapter({ environmentKey: key, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return reply({
      id: 'resp_grok_1', model: 'grok-4.7', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"actions":[],"done":true}' }] }],
      usage: { input_tokens: 500, output_tokens: 90, total_tokens: 590, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 50 } },
    });
  } });
  const result = await adapter.capture().generate(generation);
  assert.equal(calls[0].url, 'https://api.x.ai/v1/responses');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${key}`);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.store, false);
  assert.deepEqual(body.input[0].content[2], { type: 'input_image', image_url: generation.messages[0].images[0].dataUrl, detail: 'high' });
  assert.deepEqual(result.usage, {
    inputTokens: 500, outputTokens: 90, totalTokens: 590,
    inputTokensDetails: { cachedTokens: 20 }, outputTokensDetails: { reasoningTokens: 50 },
  });
});

test('xAI discovery exposes only explicitly image-capable models and no credentials', async () => {
  const adapter = createXAIAdapter({ fetchImpl: async () => reply({ data: [
    { id: 'grok-text', input_modalities: ['text'] },
    { id: 'grok-vision-z', input_modalities: ['text', 'image'] },
    { id: 'grok-vision-a', input_modalities: ['image', 'text'] },
  ], echo: key }) });
  adapter.set({ apiKey: key });
  assert.deepEqual((await adapter.test()).models, ['grok-vision-a', 'grok-vision-z']);
  assert.ok(!JSON.stringify([adapter.metadata(), adapter.protocol()]).includes(key));
  assert.equal(adapter.forget().configured, false);
});

test('xAI rejects unsupported image formats before transport and never retries failures', async () => {
  let calls = 0;
  const adapter = createXAIAdapter({ environmentKey: key, fetchImpl: async () => {
    calls++;
    return reply({ error: { code: 'rate_limit_exceeded', message: key } }, 429);
  } });
  await assert.rejects(adapter.capture().generate({
    ...generation, messages: [{ role: 'user', text: 'Inspect.', images: [{ id: 'canvas', dataUrl: 'data:image/webp;base64,YQ==' }] }],
  }), /PNG and JPEG/);
  assert.equal(calls, 0);
  await assert.rejects(adapter.capture().generate(generation), error => error.code === 'RATE_LIMITED' && !error.message.includes(key));
  assert.equal(calls, 1);
});
