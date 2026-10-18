import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleAdapter } from '../lib/provider-adapters/google.mjs';

const key = 'google-private-key-123';
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const generation = {
  model: 'gemini-3.8-flash', instructions: 'Return JSON.', maxOutputTokens: 1024,
  messages: [{ role: 'user', text: 'Inspect.', images: [{ id: 'canvas', dataUrl: 'data:image/png;base64,YQ==' }] }],
};

test('Google adapter sends native inline images and normalizes thinking usage', async () => {
  const calls = [];
  const adapter = createGoogleAdapter({ environmentKey: key, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return reply({
      responseId: 'google-response-1', modelVersion: 'gemini-3.8-flash',
      candidates: [{ content: { parts: [{ text: '{"actions":[],"done":true}' }] } }],
      usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 40, thoughtsTokenCount: 60, totalTokenCount: 400, cachedContentTokenCount: 10 },
    });
  } });
  const result = await adapter.capture().generate(generation);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers['x-goog-api-key'], key);
  assert.match(calls[0].url, /gemini-3\.8-flash:generateContent$/);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.contents[0].parts[2].inlineData, { mimeType: 'image/png', data: 'YQ==' });
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(result.usage, {
    inputTokens: 300, outputTokens: 100, totalTokens: 400,
    inputTokensDetails: { cachedTokens: 10 }, outputTokensDetails: { reasoningTokens: 60 },
  });
  assert.equal(result.model, generation.model);
});

test('Google connection lists only generateContent models and never returns credentials', async () => {
  const adapter = createGoogleAdapter({ fetchImpl: async () => reply({
    models: [
      { name: 'models/gemini-z', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embed-only', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] },
    ], echo: key,
  }) });
  adapter.set({ apiKey: key });
  const result = await adapter.test();
  assert.deepEqual(result.models, ['gemini-a', 'gemini-z']);
  assert.ok(!JSON.stringify([result, adapter.metadata(), adapter.protocol()]).includes(key));
  assert.equal(adapter.forget().configured, false);
});

test('Google failures are bounded, classified, and do not retry or echo keys', async () => {
  let calls = 0;
  const adapter = createGoogleAdapter({ environmentKey: key, fetchImpl: async () => {
    calls++;
    return reply({ error: { status: 'PERMISSION_DENIED', message: key } }, 403);
  } });
  await assert.rejects(adapter.capture().generate(generation), error => error.code === 'ACCESS_DENIED' && !error.message.includes(key));
  assert.equal(calls, 1);
});
