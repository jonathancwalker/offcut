import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlibabaAdapter } from '../lib/provider-adapters/alibaba.mjs';

const key = 'dashscope-private-key-123';
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const generation = {
  model: 'qwen3-vl-32b-instruct', instructions: 'Return JSON.', maxOutputTokens: 2048,
  messages: [{ role: 'user', text: 'Inspect.', images: [{ id: 'canvas', dataUrl: 'data:image/jpeg;base64,YQ==' }] }],
};

test('Alibaba adapter sends Qwen native image parts with thinking disabled', async () => {
  const calls = [];
  const adapter = createAlibabaAdapter({ environmentKey: key, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return reply({
      id: 'chatcmpl-qwen-1', model: generation.model,
      choices: [{ message: { content: '{"actions":[],"done":true}' } }],
      usage: { prompt_tokens: 400, completion_tokens: 50, total_tokens: 450, prompt_tokens_details: { cached_tokens: 20, image_tokens: 300 }, completion_tokens_details: { reasoning_tokens: 0 } },
    });
  } });
  const result = await adapter.capture().generate(generation);
  assert.equal(calls[0].url, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${key}`);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.enable_thinking, false);
  assert.equal(body.stream, false);
  assert.equal(body.messages[1].content[2].image_url.url, generation.messages[0].images[0].dataUrl);
  assert.deepEqual(result.usage, {
    inputTokens: 400, outputTokens: 50, totalTokens: 450,
    inputTokensDetails: { cachedTokens: 20 }, outputTokensDetails: { reasoningTokens: 0 },
  });
});

test('Alibaba discovery accepts the documented model catalog shapes and hides keys', async () => {
  const adapter = createAlibabaAdapter({ fetchImpl: async url => {
    assert.equal(url, 'https://dashscope-intl.aliyuncs.com/api/v1/models');
    return reply({ data: [{ id: 'qwen-z' }, { model_name: 'qwen-a' }], echo: key });
  } });
  adapter.set({ apiKey: key });
  assert.deepEqual((await adapter.test()).models, ['qwen-a', 'qwen-z']);
  assert.ok(!JSON.stringify([adapter.metadata(), adapter.protocol()]).includes(key));
  assert.equal(adapter.forget().configured, false);
});

test('Alibaba failures are classified without retries or credential echoes', async () => {
  let calls = 0;
  const adapter = createAlibabaAdapter({ environmentKey: key, fetchImpl: async () => {
    calls++;
    return reply({ code: 'Throttling', message: key }, 429);
  } });
  await assert.rejects(adapter.capture().generate(generation), error => error.code === 'RATE_LIMITED' && !error.message.includes(key));
  assert.equal(calls, 1);
});
