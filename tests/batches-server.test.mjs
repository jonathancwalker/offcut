import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { startServer } from '../server.mjs';
import { createProviderRegistry } from '../lib/providers.mjs';
import { getSharp } from '../lib/render.mjs';
import { normalizeMaterialSelection, drawMaterialIds } from '../public/material-selection.mjs';
import { planBatch } from '../public/batch-plan.mjs';

const secret = 'batch-fixture-private-key';
const spec = { prompt: 'Make a work from these materials.', maxTurns: 2, maxActions: 10, maxPieces: 4, maxMinutes: 1, maxOutputTokens: 512 };
const completed = () => Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ decision_note: 'Finished.', actions: [], done: true }) }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, fetchImpl = async () => completed()) {
  const directory = await mkdtemp(join(tmpdir(), 'offcut-batch-api-'));
  const sources = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
    const width = 80 + index, height = 80;
    const bytes = await getSharp()({ create: { width, height, channels: 3, background: { r: index * 23, g: 100, b: 200 - index * 15 } } }).png().toBuffer();
    return { id: `paper-${index}`, name: `Paper ${index}`, width, height, dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, license: 'CC0' };
  }));
  const requests = [];
  const launch = () => startServer({ port: 0, dataDir: directory, initialSources: sources, persist: false, logger: { error() {} },
    providerRegistry: createProviderRegistry({ environmentKey: '', fetchImpl: async (url, options) => { requests.push(JSON.parse(options.body)); return fetchImpl(url, options); } }) });
  let app = await launch();
  const base = () => `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, body, method = 'POST', headers = {}) => {
    const response = await fetch(base() + path, body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const restart = async () => { await app.close(); app = await launch(); };
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { request, requests, sources, directory, base, restart };
}

function bodyFor(catalog, changes = {}) {
  const materialSelection = normalizeMaterialSelection({ version: 1, algorithm: 'offcut-fisher-yates-v1', seed: 313, catalogSnapshot: catalog.snapshot,
    pinnedIds: [catalog.sources[0].id], candidateIds: catalog.sources.map(source => source.id), randomCount: 2 });
  const sourceIds = drawMaterialIds(materialSelection);
  return { clientRequestId: randomUUID(), spec, groups: [{ model: 'model-alpha', count: 2 }, { model: 'model-beta', count: 2 }],
    mode: 'explore', materials: 'pinned-random', materialSelection, sourceIds,
    sourceHashes: Object.fromEntries(sourceIds.map(id => [id, catalog.sources.find(source => source.id === id).sha256])), ...changes };
}
const plannerInput = body => ({ groups: body.groups, mode: body.mode, materials: body.materials, materialSelection: body.materialSelection });
async function finished(request, id) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const batch = (await request(`/api/batches/${id}`)).data.batch;
    if (batch.status !== 'running') return batch;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Batch did not finish.');
}

test('Explore launches independent frozen draws by model group; Compare reuses the same indexed draws', async t => {
  const { request, requests, base } = await fixture(t);
  await request('/api/providers/openai', { apiKey: secret });
  const catalog = (await request('/api/source-catalog')).data;
  for (const mode of ['explore', 'compare']) {
    const body = bodyFor(catalog, { mode });
    const expected = planBatch(plannerInput(body));
    const response = await request('/api/batches', body);
    assert.equal(response.status, 202, JSON.stringify(response.data));
    const batch = await finished(request, response.data.batch.id);
    assert.equal(batch.status, 'completed');
    assert.equal(batch.totalRuns, 4);
    assert.equal(batch.finishedRuns, 4);
    assert.equal(batch.completedRuns, 4);
    assert.deepEqual(batch.entries.map(entry => entry.sourceIds), expected.entries.map(entry => entry.sourceIds));
    assert.deepEqual(batch.entries.map(entry => entry.seed), expected.entries.map(entry => entry.seed));
    if (mode === 'compare') assert.deepEqual(batch.entries[0].sourceIds, batch.entries[2].sourceIds);
    else assert.notEqual(batch.entries[0].seed, batch.entries[2].seed);
    assert.equal(batch.launch.clientRequestId, body.clientRequestId);
    assert.ok(!JSON.stringify(batch).includes(secret));
    for (const entry of batch.entries) {
      const run = (await request(`/api/runs/${entry.runId}`)).data.run;
      assert.deepEqual(run.batch, { id: batch.id, groupIndex: entry.groupIndex, runIndex: entry.runIndex });
      assert.deepEqual(run.sourceManifest.map(source => source.id), entry.sourceIds);
      assert.equal(run.materialSelection.seed, entry.seed);
      assert.equal(run.spec.model, body.groups[entry.groupIndex].model);
      const bundle = (await request(`/api/runs/${entry.runId}/export`)).data;
      assert.deepEqual(bundle.events.find(event => event.type === 'run_started').batch, run.batch);
    }
    const source = batch.sourceManifest[0];
    const image = await fetch(`${base()}/api/batches/${batch.id}/sources/${source.id}`);
    assert.equal(image.status, 200);
    assert.equal(createHash('sha256').update(Buffer.from(await image.arrayBuffer())).digest('hex'), source.sha256);
    assert.equal((await request(`/api/batches/${batch.id}/sources/missing`)).status, 404);
    assert.equal((await request(`/api/batches/${batch.id}/stop`)).status, 405);
  }
  assert.deepEqual(requests.map(item => item.model), ['model-alpha', 'model-alpha', 'model-beta', 'model-beta', 'model-alpha', 'model-alpha', 'model-beta', 'model-beta']);
  assert.equal((await request('/api/batches')).data.batches.length, 2);
});

test('a batch excludes competing launches and uses frozen queued materials after the live inventory is removed', async t => {
  const entered = deferred(), release = deferred();
  let calls = 0;
  const { request, requests, restart, base } = await fixture(t, async () => {
    if (++calls === 1) { entered.resolve(); await release.promise; }
    return completed();
  });
  t.after(() => release.resolve());
  await request('/api/providers/openai', { apiKey: secret });
  const catalog = (await request('/api/source-catalog')).data;
  const body = bodyFor(catalog);
  const started = await request('/api/batches', body);
  assert.equal(started.status, 202, JSON.stringify(started.data));
  await entered.promise;
  const id = started.data.batch.id;
  assert.equal((await request('/api/runs', { provider: 'openai', model: 'another-model', ...spec })).status, 409);
  assert.equal((await request('/api/batches', { ...body, clientRequestId: randomUUID() })).status, 409);
  assert.equal((await request('/api/batches', body)).data.batch.id, id);
  assert.equal((await request('/api/batches', { ...body, mode: 'compare' })).status, 409);
  await request('/api/reset', { keepSources: false });
  assert.equal((await request('/api/source-catalog')).data.sources.length, 0);
  release.resolve();
  const batch = await finished(request, id);
  assert.equal(batch.status, 'completed');
  assert.equal(requests.length, 4);
  assert.equal((await request('/api/batches', body)).data.batch.id, id);
  await restart();
  assert.equal((await request('/api/providers')).data.providers[0].configured, false);
  const retried = await request('/api/batches', body);
  assert.equal(retried.status, 202, JSON.stringify(retried.data));
  assert.equal(retried.data.batch.id, id);
  assert.equal(requests.length, 4);
  const source = batch.sourceManifest[0];
  assert.equal((await fetch(`${base()}/api/batches/${id}/sources/${source.id}`)).status, 200);
});

test('stop cancels the active child and leaves the remaining plan explicitly unstarted', async t => {
  const entered = deferred(), release = deferred();
  const { request, requests } = await fixture(t, async () => { entered.resolve(); await release.promise; return completed(); });
  t.after(() => release.resolve());
  await request('/api/providers/openai', { apiKey: secret });
  const body = bodyFor((await request('/api/source-catalog')).data);
  const started = await request('/api/batches', body);
  assert.equal(started.status, 202, JSON.stringify(started.data));
  await entered.promise;
  const stopped = await request(`/api/batches/${started.data.batch.id}/stop`, {});
  assert.equal(stopped.status, 200, JSON.stringify(stopped.data));
  const batch = (await request(`/api/batches/${started.data.batch.id}`)).data.batch;
  assert.equal(batch.status, 'stopped');
  assert.equal(batch.entries.filter(entry => entry.status === 'stopped').length, 1);
  assert.equal(batch.entries.filter(entry => entry.status === 'not_run').length, 3);
  release.resolve();
  assert.equal(requests.length, 1);
  assert.equal((await request('/api/batches', body)).data.batch.id, batch.id);
});

test('invalid batch plans and stale reviewed sets are rejected before any model calls or saved batches', async t => {
  const { request, requests } = await fixture(t);
  await request('/api/providers/openai', { apiKey: secret });
  const catalog = (await request('/api/source-catalog')).data;
  const body = bodyFor(catalog);
  for (const [patch, status] of [
    [{ groups: [{ model: 'model-alpha', count: 0 }] }, 400],
    [{ groups: [{ model: 'model-alpha', count: 50 }, { model: 'model-beta', count: 1 }] }, 400],
    [{ groups: [{ model: 'invalid model', count: 2 }] }, 400],
    [{ materials: 'random' }, 400],
    [{ sourceIds: [...body.sourceIds].reverse() }, 400],
    [{ materialSelection: { ...body.materialSelection, catalogSnapshot: '0'.repeat(64) } }, 409],
    [{ sourceHashes: { ...body.sourceHashes, [body.sourceIds[0]]: '0'.repeat(64) } }, 409],
    [{ spec: { ...spec, maxTurns: 0 } }, 400],
    [{ apiKey: 'do-not-store-extra-fields' }, 400],
  ]) {
    const result = await request('/api/batches', { ...body, ...patch });
    assert.equal(result.status, status, JSON.stringify(result.data));
  }
  assert.equal((await request('/api/batches', body, 'POST', { Origin: 'https://external.invalid' })).status, 403);
  assert.equal((await request('/api/batches')).data.batches.length, 0);
  assert.equal((await request('/api/runs')).data.runs.length, 0);
  assert.equal(requests.length, 0);
});

test('closing and reopening the server interrupts a batch without silently resuming queued calls', async t => {
  const entered = deferred(), release = deferred();
  const { request, requests, restart } = await fixture(t, async () => { entered.resolve(); await release.promise; return completed(); });
  t.after(() => release.resolve());
  await request('/api/providers/openai', { apiKey: secret });
  const body = bodyFor((await request('/api/source-catalog')).data);
  const started = await request('/api/batches', body);
  assert.equal(started.status, 202, JSON.stringify(started.data));
  await entered.promise;
  await restart();
  release.resolve();
  const batch = (await request(`/api/batches/${started.data.batch.id}`)).data.batch;
  assert.equal(batch.status, 'interrupted');
  const child = (await request(`/api/runs/${batch.entries[0].runId}`)).data.run;
  assert.equal(child.status, 'interrupted');
  assert.equal(child.terminationReason, 'server_closed');
  assert.equal(batch.usageIncomplete, true);
  assert.equal(batch.entries.filter(entry => entry.status === 'not_run').length, 3);
  assert.equal(requests.length, 1);
  assert.equal((await request('/api/batches', body)).data.batch.id, batch.id);
  assert.equal(requests.length, 1);
});
