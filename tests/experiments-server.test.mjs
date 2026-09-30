import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { startServer } from '../server.mjs';
import { createProviderRegistry } from '../lib/providers.mjs';
import { getSharp, renderPNG } from '../lib/render.mjs';
import { createState, applyAction } from '../lib/engine.mjs';

const secret = 'fixture-secret-never-export';
const cut = { type: 'cut', sourceId: 'paper', pieceId: 'piece', polygon: [[0, 0], [30, 0], [30, 30], [0, 30]] };
const place = { type: 'place', pieceId: 'piece', x: 500, y: 600, scale: 2, rotation: 20 };
const spec = { provider: 'openai', model: 'fixture-vision', prompt: 'Make an original work.', maxTurns: 2, maxActions: 10, maxPieces: 4, maxOutputTokens: 512, maxMinutes: 1 };

async function fixture(t, fetchImpl, { sourceCount = 1 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'offcut-run-api-'));
  const sources = await Promise.all(Array.from({ length: sourceCount }, async (_, index) => {
    const width = 80 + index * 16, height = 80;
    const bytes = await getSharp()({ create: { width, height, channels: 3, background: ['#669955', '#4488bb', '#bb5544'][index % 3] } }).png().toBuffer();
    return { id: index === 0 ? 'paper' : `paper-${index + 1}`, name: `Test paper ${index + 1}`, width, height, dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, credit: 'Local test fixture', license: 'CC0', url: 'https://example.org/fixture' };
  }));
  const launchApp = initialSources => startServer({ port: 0, dataDir: directory, initialSources, persist: false, providerRegistry: createProviderRegistry({ environmentKey: '', fetchImpl }) });
  let app = await launchApp(sources);
  let base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function request(path, body, method = 'POST', headers = {}) {
    const response = await fetch(base + path, body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  async function restart(initialSources = sources) {
    await app.close();
    app = await launchApp(initialSources);
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  return { app, base, request, directory, sources, restart };
}

const completedOutput = () => Response.json({ id: 'response-selection-fixture', model: 'fixture-vision', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ decision_note: 'Finish the fixture.', actions: [], done: true }) }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
const selection = sources => ({ sourceIds: sources.map(source => source.id), sourceHashes: Object.fromEntries(sources.map(source => [source.id, source.sha256])) });

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
  const gif = await fetch(`${base}/api/runs/${id}/render.gif`);
  assert.equal(gif.status, 200);
  assert.equal(gif.headers.get('content-type'), 'image/gif');
  assert.match(gif.headers.get('content-disposition'), new RegExp(`offcut-${id}-playback.gif`));
  const metadata = await getSharp()(Buffer.from(await gif.arrayBuffer())).metadata();
  assert.equal(metadata.pages, project.cursor + 1);
  assert.deepEqual(metadata.delay, [650, 650, 650, 2500]);
  assert.deepEqual((await request(`/api/runs/${id}/project`)).data, project);
  assert.deepEqual((await request(`/api/runs/${id}/export`)).data, bundle);
  assert.deepEqual((await request('/api/project')).data, before);
  assert.equal(turns, 2, 'Export must not call a provider.');
  assert.equal((await request('/api/providers/openai', {}, 'DELETE')).data.configured, false);
});

test('one worker rejects concurrent launches and stop cancels the pending provider call', async t => {
  let started;
  const providerStarted = new Promise(resolve => { started = resolve; });
  const { request, base } = await fixture(t, async (url, options) => {
    started();
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  });
  await request('/api/providers/openai', { apiKey: secret });
  const { data } = await request('/api/runs', spec);
  await providerStarted;
  const runningGIF = await fetch(`${base}/api/runs/${data.run.id}/render.gif`);
  assert.equal(runningGIF.status, 409);
  assert.match((await runningGIF.json()).error, /once this work ends/);
  assert.equal((await request('/api/runs', spec)).status, 409);
  const stopped = await request(`/api/runs/${data.run.id}/stop`, {});
  assert.equal(stopped.data.run.status, 'stopped');
  assert.equal(stopped.data.run.acceptedActions, 0);
  assert.equal(stopped.data.run.usageIncomplete, true);
  const partialGIF = await fetch(`${base}/api/runs/${data.run.id}/render.gif`);
  assert.equal(partialGIF.status, 200);
  const metadata = await getSharp()(Buffer.from(await partialGIF.arrayBuffer())).metadata();
  assert.equal(metadata.pages || 1, 1);
  assert.deepEqual(metadata.delay, [2500]);
});

test('a failed run exports its committed partial work without resuming model calls', async t => {
  let turns = 0;
  const { request, base } = await fixture(t, async () => {
    if (++turns > 1) throw new Error('Simulated provider failure.');
    const output = { decision_note: 'Save this fragment.', actions: [cut, place], done: false };
    return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] });
  });
  await request('/api/providers/openai', { apiKey: secret });
  const started = await request('/api/runs', spec);
  const id = started.data.run.id;
  const run = await finished(request, id);
  assert.equal(run.status, 'failed');
  const project = (await request(`/api/runs/${id}/project`)).data;
  assert.equal(project.cursor, 2);
  const before = (await request(`/api/runs/${id}/export`)).data;
  const response = await fetch(`${base}/api/runs/${id}/render.gif`);
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  const metadata = await getSharp()(bytes).metadata();
  assert.equal(metadata.pages, 3);
  assert.deepEqual(metadata.delay, [650, 650, 2500]);
  const first = await getSharp()(bytes, { page: 0 }).raw().toBuffer();
  const final = await getSharp()(bytes, { page: 2 }).raw().toBuffer();
  assert.notDeepEqual(final, first);
  assert.deepEqual((await request(`/api/runs/${id}/export`)).data, before);
  assert.equal(turns, 2);
});

test('source catalog exposes compact metadata and exact original-byte hashes', async t => {
  const { request, base, sources } = await fixture(t, completedOutput, { sourceCount: 3 });
  const catalog = await request('/api/source-catalog');
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.data.limits, { maxSources: 24 });
  assert.equal(catalog.data.sources.length, 3);
  for (const [index, source] of catalog.data.sources.entries()) {
    const { dataUrl, ...metadata } = sources[index];
    const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
    assert.deepEqual(source, { ...metadata, sha256: createHash('sha256').update(bytes).digest('hex'), previewUrl: `/api/sources/${source.id}` });
    assert.deepEqual(Buffer.from(await (await fetch(base + source.previewUrl)).arrayBuffer()), bytes);
  }
  assert.ok(!JSON.stringify(catalog.data).includes('base64'));
});

test('selected sources are frozen in the requested order and only those images reach the model', async t => {
  const requests = [];
  const { request, sources } = await fixture(t, async (url, options) => { requests.push(JSON.parse(options.body)); return completedOutput(); }, { sourceCount: 3 });
  await request('/api/providers/openai', { apiKey: secret });
  const catalog = (await request('/api/source-catalog')).data.sources;
  const chosen = [catalog[2], catalog[0]];
  const before = (await request('/api/project')).data;
  const started = await request('/api/runs', { ...spec, ...selection(chosen) });
  assert.equal(started.status, 202, JSON.stringify(started.data));
  assert.deepEqual(started.data.run.sourceManifest.map(source => source.id), chosen.map(source => source.id));
  assert.deepEqual(started.data.run.sourceManifest.map(source => source.sha256), chosen.map(source => source.sha256));
  assert.deepEqual((await request('/api/project')).data, before);
  await request('/api/reset', { keepSources: false });
  const run = await finished(request, started.data.run.id);
  assert.equal(run.status, 'completed');
  assert.equal(requests.length, 1);
  const sentImages = requests[0].input.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'input_image') : []);
  assert.equal(sentImages.length, 3, 'two chosen sources plus the canvas');
  const frozen = (await request(`/api/runs/${run.id}/project`)).data;
  assert.deepEqual(frozen.sources, [sources[2], sources[0]]);
  assert.equal((await request('/api/source-catalog')).data.sources.length, 0);
});

test('invalid, missing, and stale source selections are rejected before any model call', async t => {
  let calls = 0;
  const { request, sources } = await fixture(t, async () => { calls++; return completedOutput(); }, { sourceCount: 2 });
  await request('/api/providers/openai', { apiKey: secret });
  const catalog = (await request('/api/source-catalog')).data.sources;
  const valid = selection([catalog[0]]);
  for (const [patch, status] of [
    [{ sourceIds: [], sourceHashes: {} }, 400],
    [{ sourceIds: Array.from({ length: 25 }, (_, index) => `paper-${index}`), sourceHashes: {} }, 400],
    [{ sourceIds: ['paper', 'paper'], sourceHashes: valid.sourceHashes }, 400],
    [{ sourceIds: [42], sourceHashes: { 42: catalog[0].sha256 } }, 400],
    [{ sourceIds: ['paper'] }, 400],
    [{ sourceIds: ['paper'], sourceHashes: {} }, 400],
    [{ sourceIds: ['paper'], sourceHashes: { ...valid.sourceHashes, extra: catalog[1].sha256 } }, 400],
    [{ sourceIds: ['paper'], sourceHashes: { paper: [catalog[0].sha256] } }, 400],
    [{ sourceIds: ['missing'], sourceHashes: { missing: catalog[0].sha256 } }, 409],
    [{ sourceIds: ['paper'], sourceHashes: { paper: '0'.repeat(64) } }, 409],
    [{ sourceHashes: valid.sourceHashes }, 400],
  ]) {
    const result = await request('/api/runs', { ...spec, ...patch });
    assert.equal(result.status, status, JSON.stringify(result.data));
  }
  const changed = (await request('/api/project')).data;
  changed.sources[0] = { ...sources[0], dataUrl: sources[1].dataUrl };
  assert.equal((await request('/api/project', changed)).status, 200);
  const stale = await request('/api/runs', { ...spec, ...valid });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /changed/);
  await request('/api/reset', { keepSources: false });
  const removed = await request('/api/runs', { ...spec, ...valid });
  assert.equal(removed.status, 409);
  assert.match(removed.data.error, /no longer available/);
  assert.equal(calls, 0);
  assert.equal((await request('/api/runs')).data.runs.length, 0);
});

test('launch tokens deduplicate concurrent retries, conflict on changed settings, and survive restart', async t => {
  let calls = 0;
  const { request, restart, directory } = await fixture(t, async () => { calls++; return completedOutput(); }, { sourceCount: 2 });
  await request('/api/providers/openai', { apiKey: secret });
  const sources = (await request('/api/source-catalog')).data.sources;
  const payload = { ...spec, ...selection(sources), clientRequestId: randomUUID() };
  const reordered = Object.fromEntries(Object.entries({ ...payload, sourceHashes: Object.fromEntries(Object.entries(payload.sourceHashes).reverse()) }).reverse());
  const [first, duplicate] = await Promise.all([request('/api/runs', payload), request('/api/runs', reordered)]);
  assert.equal(first.status, 202, JSON.stringify(first.data));
  assert.equal(duplicate.status, 202, JSON.stringify(duplicate.data));
  assert.equal(duplicate.data.run.id, first.data.run.id);
  const id = first.data.run.id;
  assert.equal(first.data.run.launch.clientRequestId, payload.clientRequestId);
  assert.match(first.data.run.launch.requestFingerprint, /^[a-f0-9]{64}$/);
  await finished(request, id);
  assert.equal((await request('/api/runs', { ...payload, prompt: 'Changed prompt.' })).status, 409);
  assert.equal((await request('/api/runs', { ...payload, sourceIds: [...payload.sourceIds].reverse() })).status, 409);
  assert.equal((await request('/api/runs', { ...payload, clientRequestId: '' })).status, 400);
  await request('/api/reset', { keepSources: false });
  assert.equal((await request('/api/runs', payload)).data.run.id, id, 'receipts are checked before the changed current inventory');
  await restart([]);
  assert.equal((await request('/api/providers')).data.providers[0].configured, false);
  const retried = await request('/api/runs', payload);
  assert.equal(retried.status, 202, JSON.stringify(retried.data));
  assert.equal(retried.data.run.id, id);
  assert.equal(retried.data.run.status, 'completed');
  assert.deepEqual(retried.data.run.launch, first.data.run.launch);
  assert.equal((await request('/api/runs', { ...payload, maxTurns: 3 })).status, 409);
  assert.equal((await request('/api/runs')).data.runs.length, 1);
  assert.equal(calls, 1);
  for (const file of ['run.json', 'events.jsonl']) assert.ok(!(await readFile(join(directory, 'runs', id, file), 'utf8')).includes(secret));
});
