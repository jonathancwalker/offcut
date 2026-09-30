import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';
import { createProviderRegistry } from '../lib/providers.mjs';
import { getSharp, renderPNG } from '../lib/render.mjs';
import { createState, applyAction } from '../lib/engine.mjs';

const secret = 'fixture-secret-never-export';
const cut = { type: 'cut', sourceId: 'paper', pieceId: 'piece', polygon: [[0, 0], [30, 0], [30, 30], [0, 30]] };
const place = { type: 'place', pieceId: 'piece', x: 500, y: 600, scale: 2, rotation: 20 };
const spec = { provider: 'openai', model: 'fixture-vision', prompt: 'Make an original work.', maxTurns: 2, maxActions: 10, maxPieces: 4, maxOutputTokens: 512, maxMinutes: 1 };

async function fixture(t, fetchImpl) {
  const directory = await mkdtemp(join(tmpdir(), 'offcut-run-api-'));
  const bytes = await getSharp()({ create: { width: 80, height: 80, channels: 3, background: '#669955' } }).png().toBuffer();
  const source = { id: 'paper', name: 'Test paper', width: 80, height: 80, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
  const registry = createProviderRegistry({ environmentKey: '', fetchImpl });
  const app = await startServer({ port: 0, dataDir: directory, initialSources: [source], persist: false, providerRegistry: registry });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function request(path, body, method = 'POST', headers = {}) {
    const response = await fetch(base + path, body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  return { app, base, request, directory };
}

async function finished(request, id) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const { data } = await request(`/api/runs/${id}`);
    if (data.run.status !== 'running') return data.run;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Test run did not finish.');
}

test('experiment API connects privately, preserves the studio and exports an exactly replayable run', async t => {
  let turns = 0;
  const requests = [];
  const { request, base, directory } = await fixture(t, async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'fixture-vision' }] });
    const output = ++turns === 1
      ? { decision_note: 'Place the first fragment.', actions: [cut, place], done: false }
      : { decision_note: 'Give the work its title.', actions: [{ type: 'describe', title: 'Fixture collage', statement: 'A test, not a model experiment.' }], done: true };
    return Response.json({ id: `response-${turns}`, model: 'fixture-vision', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }], usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 } });
  });
  assert.equal((await request('/api/providers')).data.providers[0].configured, false);
  assert.equal((await request('/api/runs', spec)).status, 400);
  assert.equal((await request('/api/providers/openai', { apiKey: secret }, 'POST', { Origin: 'https://external.invalid' })).status, 403);
  assert.equal((await request('/api/providers/openai', { apiKey: secret })).data.configured, true);
  assert.deepEqual((await request('/api/providers/openai/test', {})).data.models, ['fixture-vision']);
  assert.equal(turns, 0);
  await request('/api/actions', { type: 'describe', title: 'Keep the studio intact' });
  const before = (await request('/api/project')).data;
  const started = await request('/api/runs', spec);
  assert.equal(started.status, 202, JSON.stringify(started.data));
  const id = started.data.run.id;
  const run = await finished(request, id);
  assert.equal(run.status, 'completed');
  assert.equal(run.acceptedActions, 3);
  assert.equal(run.turns, 2);
  assert.deepEqual(run.usage, { inputTokens: 24, outputTokens: 14, totalTokens: 38 });
  assert.deepEqual((await request('/api/project')).data, before);
  assert.equal((await request('/api/runs')).data.runs.length, 1);
  const project = (await request(`/api/runs/${id}/project`)).data;
  const bundle = (await request(`/api/runs/${id}/export`)).data;
  assert.equal(bundle.format, 'offcut-run');
  assert.ok(bundle.events.some(event => event.type === 'observation'));
  assert.ok(Object.keys(bundle.assets).length > 0);
  assert.ok(!JSON.stringify(bundle).includes(secret));
  assert.ok(!(await readFile(join(directory, 'runs', id, 'events.jsonl'), 'utf8')).includes(secret));
  const requestsToModel = requests.filter(item => item.url.endsWith('/responses'));
  assert.equal(requestsToModel.length, 2);
  assert.ok(JSON.parse(requestsToModel[0].options.body).input.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'input_image')));
  let state = createState({ id: project.id, sources: project.sources, canvas: project.canvas, rules: project.rules });
  for (const { action } of project.actions) state = applyAction(state, action);
  const image = await fetch(`${base}/api/runs/${id}/render.png`);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), await renderPNG(state));
  assert.equal((await fetch(`${base}/api/runs/${id}/render.png?step=0`)).status, 200);
  assert.equal((await fetch(`${base}/api/runs/${id}/render.png?step=4`)).status, 404);
  assert.equal((await request('/api/providers/openai', {}, 'DELETE')).data.configured, false);
});

test('one worker rejects concurrent launches and stop cancels the pending provider call', async t => {
  let started;
  const providerStarted = new Promise(resolve => { started = resolve; });
  const { request } = await fixture(t, async (url, options) => {
    started();
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  });
  await request('/api/providers/openai', { apiKey: secret });
  const { data } = await request('/api/runs', spec);
  await providerStarted;
  assert.equal((await request('/api/runs', spec)).status, 409);
  const stopped = await request(`/api/runs/${data.run.id}/stop`, {});
  assert.equal(stopped.data.run.status, 'stopped');
  assert.equal(stopped.data.run.acceptedActions, 0);
  assert.equal(stopped.data.run.usageIncomplete, true);
});
