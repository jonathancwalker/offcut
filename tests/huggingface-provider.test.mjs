import test from 'node:test';
import assert from 'node:assert/strict';
import { createHuggingFaceAdapter } from '../lib/provider-adapters/huggingface.mjs';

const key = 'hf_private_token_123';
const route = 'deepseek-ai/DeepSeek-V4.1-Flash:baseten';
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const generation = {
  model: route, instructions: 'Return JSON.', maxOutputTokens: 2048,
  messages: [{ role: 'user', text: 'Inspect.', images: [{ id: 'canvas', dataUrl: 'data:image/png;base64,YQ==' }] }],
};

test('Hugging Face adapter sends native VLM parts to an explicitly pinned inference provider', async () => {
  const calls = [];
  const adapter = createHuggingFaceAdapter({ environmentKey: key, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return reply({
      id: 'hf-chat-1', model: route, choices: [{ message: { content: '{"actions":[],"done":true}' } }],
      usage: { prompt_tokens: 350, completion_tokens: 70, total_tokens: 420 },
    });
  } });
  const result = await adapter.capture().generate(generation);
  assert.equal(calls[0].url, 'https://router.huggingface.co/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${key}`);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, route);
  assert.equal(body.stream, false);
  assert.equal(body.messages[1].content[2].image_url.url, generation.messages[0].images[0].dataUrl);
  assert.deepEqual(result.usage, { inputTokens: 350, outputTokens: 70, totalTokens: 420 });
});

test('Hugging Face discovery gates DeepSeek and every open model on declared vision plus a live provider', async () => {
  const adapter = createHuggingFaceAdapter({ fetchImpl: async () => reply({ data: [
    { id: 'deepseek-ai/DeepSeek-R1', architecture: { input_modalities: ['text'] }, providers: [{ provider: 'novita', status: 'live' }] },
    { id: 'deepseek-ai/DeepSeek-V4.1-Flash', architecture: { input_modalities: ['text', 'image'] }, providers: [{ provider: 'baseten', status: 'live' }, { provider: 'offline', status: 'staging' }] },
    { id: 'Qwen/Qwen2.5-VL-7B-Instruct', architecture: { input_modalities: ['image', 'text'] }, providers: [{ provider: 'hf-inference', status: 'live' }] },
  ], echo: key }) });
  adapter.set({ apiKey: key });
  assert.deepEqual((await adapter.test()).models, ['Qwen/Qwen2.5-VL-7B-Instruct:hf-inference', route]);
  assert.ok(!JSON.stringify([adapter.metadata(), adapter.protocol()]).includes(key));
  assert.equal(adapter.forget().configured, false);
});

test('Hugging Face rejects unpinned automatic routing before transport and does not retry failures', async () => {
  let calls = 0;
  const adapter = createHuggingFaceAdapter({ environmentKey: key, fetchImpl: async () => {
    calls++;
    return reply({ error: { message: key } }, 429);
  } });
  await assert.rejects(adapter.capture().generate({ ...generation, model: 'deepseek-ai/DeepSeek-V4.1-Flash' }), /explicit inference-provider suffix/);
  assert.equal(calls, 0);
  await assert.rejects(adapter.capture().generate(generation), error => error.code === 'RATE_LIMITED' && !error.message.includes(key));
  assert.equal(calls, 1);
});
