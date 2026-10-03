import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createBatchManager } from '../lib/batches.mjs';
import { createRunManager } from '../lib/runs.mjs';
import { getSharp } from '../lib/render.mjs';
import { drawMaterialIds } from '../public/material-selection.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const snapshot = 'a'.repeat(64);
const deferred = () => { let resolve; const promise = new Promise(a => { resolve = a; }); return { promise, resolve }; };
const output = () => ({ text: JSON.stringify({ decision_note: 'Finished after observing.', actions: [], done: true }), usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } });

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'offcut-batches-test-'));
  const inventory = [];
  for (let index = 0; index < 12; index++) {
    const bytes = await getSharp()({ create: { width: 32, height: 32, channels: 3, background: { r: index * 17, g: 70, b: 200 - index * 9 } } }).png().toBuffer();
    inventory.push({ id: `source-${index}`, name: `Source ${index}`, width: 32, height: 32, dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, credit: 'Fixture archive', license: 'CC0', collection: 'Studio', tags: ['fixture'], provenance: { title: `Work ${index}`, provider: 'fixture', secretKey: 'never-copy-this' } });
  }
  const controls = { snapshot, resolveCalls: 0, factoryCalls: 0, providerCalls: 0, catalogUnavailable: false, providerUnavailable: false, metadataOverride: null, onResolve: null, onFactory: null };
  const metadata = () => inventory.map(({ dataUrl, ...source }) => {
    const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
    return { ...source, sha256: hash(bytes), byteLength: bytes.length, ...(controls.metadataOverride?.(source) ?? {}) };
  });
  const materials = {
    async list() { if (controls.catalogUnavailable) throw new Error('Catalog unavailable'); return { sources: metadata(), snapshot: controls.snapshot }; },
    async resolve(_inventory, ids, hashes, options) {
      controls.resolveCalls++;
      await controls.onResolve?.(ids);
      assert.equal(options.snapshot, snapshot, 'Every material resolution is bound to the reviewed catalog snapshot.');
      if (options.snapshot !== controls.snapshot) throw Object.assign(new Error('Catalog snapshot changed.'), { status: 409 });
      return ids.map(id => {
        const source = inventory.find(item => item.id === id);
        if (!source || hash(Buffer.from(source.dataUrl.split(',')[1], 'base64')) !== hashes[id]) throw Object.assign(new Error('Source changed.'), { status: 409 });
        return structuredClone(source);
      });
    },
  };
  const providerFactory = async () => {
    controls.factoryCalls++;
    if (controls.providerUnavailable) throw Object.assign(new Error('Connect provider.'), { status: 503 });
    await controls.onFactory?.();
    return { secretKey: 'never-copy-connection', generate: async request => { controls.providerCalls++; return options.generate ? options.generate(request, controls) : output(); } };
  };
  let runs = await createRunManager({ dataDir: join(root, 'runs'), providerFactory });
  let batches = await createBatchManager({ dataDir: join(root, 'batches'), runs, materials, getInventory: () => inventory, providerFactory });
  const recipe = { version: 1, algorithm: 'offcut-fisher-yates-v1', seed: 42, catalogSnapshot: snapshot, pinnedIds: [], candidateIds: inventory.map(source => source.id), randomCount: 3 };
  function body(overrides = {}) {
    const selection = overrides.materialSelection ?? recipe;
    const sourceIds = drawMaterialIds(selection);
    return {
      clientRequestId: randomUUID(), spec: { prompt: 'Make a collage.' }, groups: [{ model: 'model-a', count: 2 }, { model: 'model-b', count: 1 }],
      mode: 'explore', materials: 'random', materialSelection: structuredClone(selection), sourceIds,
      sourceHashes: Object.fromEntries(sourceIds.map(id => [id, metadata().find(source => source.id === id).sha256])), ...overrides,
    };
  }
  t.after(async () => { await batches.close(); await runs.close(); await rm(root, { recursive: true, force: true }); });
  return {
    root, inventory, controls, materials, providerFactory, body, recipe,
    get runs() { return runs; }, get batches() { return batches; },
    async restart() {
      await batches.close(); await runs.close();
      runs = await createRunManager({ dataDir: join(root, 'runs'), providerFactory });
      batches = await createBatchManager({ dataDir: join(root, 'batches'), runs, materials, getInventory: () => inventory, providerFactory });
    },
  };
}

test('A complete plan is durable before the first provider call; children run sequentially with exact frozen materials', async t => {
  const first = deferred(), release = deferred();
  let running = 0, maximum = 0, store;
  const f = await fixture(t, { generate: async (_request, controls) => {
    running++; maximum = Math.max(maximum, running);
    const batch = JSON.parse(await readFile(join(store.root, 'batches', store.id, 'batch.json'), 'utf8'));
    assert.equal(batch.entries.length, 3);
    assert.ok(batch.entries.every(entry => entry.launch.clientRequestId && entry.launch.requestFingerprint));
    assert.ok(batch.sourceManifest.every(source => source.sha256 && !source.dataUrl));
    if (controls.providerCalls === 1) { first.resolve(); await release.promise; }
    running--;
    return output();
  } });
  const before = structuredClone(f.inventory), body = f.body();
  const batch = await f.batches.start(body);
  store = { root: f.root, id: batch.id };
  await first.promise;
  const union = [...new Set(batch.entries.flatMap(entry => entry.sourceIds))];
  assert.equal(f.controls.resolveCalls, union.length, 'Each used source is frozen once, not per child.');
  f.controls.catalogUnavailable = true;
  f.inventory.length = 0;
  body.groups[0].count = 40;
  release.resolve();
  const end = await f.batches.wait(batch.id);
  assert.equal(end.status, 'completed');
  assert.equal(end.completedRuns, 3);
  assert.equal(end.finishedRuns, 3);
  assert.equal(maximum, 1);
  assert.deepEqual(end.usage, { inputTokens: 15, outputTokens: 9, totalTokens: 24 });
  assert.equal(f.controls.providerCalls, 3);
  assert.equal(f.controls.factoryCalls, 4, 'One admission check plus one private connection per child.');
  for (const entry of end.entries) {
    const child = f.runs.get(entry.runId);
    assert.deepEqual(child.batch, { id: batch.id, groupIndex: entry.groupIndex, runIndex: entry.runIndex });
    assert.deepEqual(child.launch, entry.launch);
    assert.deepEqual(f.runs.project(entry.runId).sources.map(source => source.id), entry.sourceIds);
    assert.equal(child.materialSelection.seed, entry.seed);
    for (const source of f.runs.project(entry.runId).sources) assert.equal(source.dataUrl, before.find(original => original.id === source.id).dataUrl);
    assert.equal(child.sourceManifest[0].provenance.secretKey, undefined);
    assert.equal(f.runs.events(entry.runId)[0].batch.id, batch.id);
    assert.equal((await f.runs.bundle(entry.runId)).run.batch.id, batch.id);
  }
  const stored = await readFile(join(f.root, 'batches', batch.id, 'batch.json'), 'utf8');
  assert.ok(!stored.includes('never-copy'));
  assert.ok(!stored.includes('base64'));
  const firstSource = end.sourceManifest[0];
  const asset = await f.batches.asset(batch.id, firstSource.id);
  assert.equal(hash(asset.bytes), firstSource.sha256);
  await assert.rejects(f.batches.asset(batch.id, 'unknown'), error => error.status === 404);
});

test('Compare and Same preserve their distinct source policies in persisted child runs', async t => {
  const f = await fixture(t);
  const selected = { ...f.recipe, pinnedIds: ['source-11'], randomCount: 2 };
  const compare = await f.batches.start(f.body({ mode: 'compare', materials: 'pinned-random', materialSelection: selected, groups: [{ model: 'a', count: 2 }, { model: 'b', count: 2 }] }));
  const end = await f.batches.wait(compare.id);
  assert.deepEqual(end.entries[0].sourceIds, end.entries[2].sourceIds);
  assert.deepEqual(end.entries[1].sourceIds, end.entries[3].sourceIds);
  assert.ok(end.entries.every(entry => entry.sourceIds[0] === 'source-11'));
  const manual = { ...f.recipe, pinnedIds: ['source-3', 'source-1'], candidateIds: [], randomCount: 0 };
  const same = await f.batches.start(f.body({ materials: 'same', materialSelection: manual }));
  await f.batches.wait(same.id);
  for (const entry of same.entries) assert.deepEqual(entry.sourceIds, ['source-3', 'source-1']);
});

test('Durable launch receipts survive retry, catalog deletion, provider disconnection and restart without extra calls', async t => {
  const f = await fixture(t), body = f.body();
  const [first, duplicate] = await Promise.all([f.batches.start(body), f.batches.start(structuredClone(body))]);
  assert.equal(first.id, duplicate.id);
  await f.batches.wait(first.id);
  const calls = f.controls.factoryCalls;
  f.controls.catalogUnavailable = true; f.controls.providerUnavailable = true;
  assert.equal((await f.batches.start(body)).id, first.id);
  await assert.rejects(f.batches.start({ ...body, mode: 'compare' }), error => error.status === 409);
  await f.restart();
  assert.equal((await f.batches.start(body)).id, first.id);
  assert.equal(f.batches.list()[0].launch.clientRequestId, body.clientRequestId);
  assert.equal(f.controls.factoryCalls, calls);
  assert.equal(f.runs.list().length, 3);
});

test('All invalid plans, reviewed hashes and byte budgets fail before provider capture or run creation', async t => {
  const f = await fixture(t);
  const invalid = [
    { spec: { prompt: 'x', maxTurns: 0 } }, { spec: { prompt: 'x', apiKey: 'secret' } },
    { groups: [{ model: 'ok', count: 1 }, { model: 'bad model', count: 1 }] },
    { groups: [{ model: 'a', count: 50 }, { model: 'b', count: 1 }] },
    { materials: 'pinned-random' }, { extra: 'secret' },
    { sourceIds: ['source-1'] }, { sourceHashes: {} },
    { materialSelection: { ...f.recipe, catalogSnapshot: 'b'.repeat(64) } },
  ];
  for (const patch of invalid) await assert.rejects(f.batches.start(f.body(patch)), error => [400, 409].includes(error.status));
  const changed = f.body(); changed.sourceHashes[changed.sourceIds[0]] = 'c'.repeat(64);
  await assert.rejects(f.batches.start(changed), error => error.status === 409);
  f.controls.metadataOverride = () => ({ byteLength: 9 * 1024 * 1024 });
  await assert.rejects(f.batches.start(f.body()), /24 MiB/);
  f.controls.metadataOverride = () => ({ byteLength: 12 * 1024 * 1024 });
  const broad = { ...f.recipe, randomCount: 1 };
  await assert.rejects(f.batches.start(f.body({ materialSelection: broad, groups: [{ model: 'a', count: 50 }] })), /128 MiB/);
  assert.equal(f.controls.factoryCalls, 0);
  assert.equal(f.controls.resolveCalls, 0);
  assert.equal(f.runs.list().length, 0);
  assert.equal(f.batches.list().length, 0);
});

test('A malformed frozen image and a changing catalog abort acceptance without leaving an executable batch', async t => {
  const f = await fixture(t);
  const body = f.body();
  f.controls.onResolve = () => { f.controls.snapshot = 'b'.repeat(64); };
  await assert.rejects(f.batches.start(body), error => error.status === 409);
  assert.equal(f.controls.factoryCalls, 0);
  assert.deepEqual(await readdir(join(f.root, 'batches')), []);
  f.controls.onResolve = null; f.controls.snapshot = snapshot;
  const source = f.inventory.find(item => item.id === body.sourceIds[0]);
  source.width = 999;
  await assert.rejects(f.batches.start(f.body()), /inconsistent dimensions/);
  assert.equal(f.controls.factoryCalls, 0);
  assert.deepEqual(await readdir(join(f.root, 'batches')), []);
});

test('A provider failure stops the queue; a budget-limited child still permits the next run', async t => {
  const f = await fixture(t, { generate: async () => { throw new Error('Provider failed with private details'); } });
  const failed = await f.batches.start(f.body());
  const end = await f.batches.wait(failed.id);
  assert.equal(end.status, 'failed');
  assert.equal(end.finishedRuns, 1);
  assert.equal(end.usageIncomplete, true);
  assert.deepEqual(end.entries.map(entry => entry.status), ['failed', 'not_run', 'not_run']);
  assert.equal(f.controls.providerCalls, 1);
  assert.ok(!JSON.stringify(end).includes('private details'));
  const limited = await fixture(t, { generate: async () => ({ ...output(), text: 'invalid output' }) });
  const started = await limited.batches.start(limited.body({ spec: { prompt: 'Try it.', maxTurns: 1 }, groups: [{ model: 'a', count: 2 }] }));
  const ended = await limited.batches.wait(started.id);
  assert.equal(ended.status, 'completed');
  assert.equal(ended.completedRuns, 0);
  assert.equal(ended.finishedRuns, 2);
  assert.ok(ended.entries.every(entry => entry.status === 'limit_reached'));
});

test('Stop persists its intent, aborts an uncooperative child, and never starts the remainder', async t => {
  const began = deferred(), forever = deferred();
  const f = await fixture(t, { generate: async () => { began.resolve(); await forever.promise; return output(); } });
  const batch = await f.batches.start(f.body());
  await began.promise;
  await assert.rejects(f.batches.start(f.body()), error => error.status === 409);
  const ended = await f.batches.stop(batch.id);
  assert.equal(ended.status, 'stopped');
  assert.deepEqual(ended.entries.map(entry => entry.status), ['stopped', 'not_run', 'not_run']);
  assert.equal(ended.finishedRuns, 1);
  assert.equal(f.batches.hasActive(), false);
  assert.equal(JSON.parse(await readFile(join(f.root, 'batches', batch.id, 'batch.json'), 'utf8')).stopRequested, true);
  forever.resolve();
  await f.restart();
  assert.equal(f.batches.get(batch.id).status, 'stopped');
  assert.equal(f.controls.providerCalls, 1);
});

test('Restart finds a child by its precommitted launch token even when the saved queue missed its run ID', async t => {
  const began = deferred(), forever = deferred();
  const f = await fixture(t, { generate: async () => { began.resolve(); await forever.promise; return output(); } });
  const batch = await f.batches.start(f.body());
  await began.promise;
  await f.batches.stop(batch.id);
  const original = f.batches.get(batch.id).entries[0].runId;
  const file = join(f.root, 'batches', batch.id, 'batch.json');
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.status = 'running'; record.stopRequested = false;
  for (const entry of record.entries) { entry.runId = null; entry.status = 'queued'; entry.terminationReason = null; }
  await writeFile(file, JSON.stringify(record));
  const calls = f.controls.factoryCalls;
  await f.restart();
  const recovered = f.batches.get(batch.id);
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.terminationReason, 'server_restarted');
  assert.equal(recovered.entries[0].runId, original);
  assert.deepEqual(recovered.entries.map(entry => entry.status), ['stopped', 'not_run', 'not_run']);
  assert.equal(f.controls.factoryCalls, calls);
  forever.resolve();
});

test('Closing while a child admission is pending waits for cancellation and never advances the queue', async t => {
  const f = await fixture(t);
  const admission = deferred(), release = deferred();
  f.controls.onFactory = async () => {
    if (f.controls.factoryCalls === 2) { admission.resolve(); await release.promise; }
  };
  const batch = await f.batches.start(f.body());
  await admission.promise;
  const closing = f.batches.close();
  release.resolve();
  await closing;
  const end = f.batches.get(batch.id);
  assert.equal(end.status, 'interrupted');
  assert.equal(end.entries[0].status, 'interrupted');
  assert.equal(end.entries[0].terminationReason, 'server_closed');
  assert.ok(end.entries.slice(1).every(entry => entry.status === 'not_run'));
  assert.equal(f.controls.providerCalls, 0);
  assert.equal(f.batches.hasActive(), false);
});

test('A disconnected provider leaves no accepted batch; shutdown during source freeze makes no provider calls', async t => {
  const f = await fixture(t);
  f.controls.providerUnavailable = true;
  await assert.rejects(f.batches.start(f.body()), error => error.status === 503);
  assert.equal(f.batches.list().length, 0);
  assert.equal(f.runs.list().length, 0);
  assert.deepEqual(await readdir(join(f.root, 'batches')), []);
  f.controls.providerUnavailable = false;
  const entered = deferred(), release = deferred();
  f.controls.onResolve = async () => { entered.resolve(); await release.promise; };
  const starting = f.batches.start(f.body());
  await entered.promise;
  const closed = f.batches.close();
  release.resolve();
  await assert.rejects(starting, error => error.status === 503);
  await closed;
  assert.equal(f.controls.factoryCalls, 1, 'Only the earlier disconnected-provider check captured a connection.');
  assert.equal(f.controls.providerCalls, 0);
  assert.deepEqual(await readdir(join(f.root, 'batches')), []);
});

test('Frozen assets reject changed bytes and recovery rejects unsafe asset metadata', async t => {
  const f = await fixture(t);
  const batch = await f.batches.start(f.body({ groups: [{ model: 'a', count: 1 }] }));
  const ended = await f.batches.wait(batch.id);
  const source = ended.sourceManifest[0];
  await writeFile(join(f.root, 'batches', batch.id, 'assets', source.sha256), 'changed');
  await assert.rejects(f.batches.asset(batch.id, source.id), /integrity check/);
  const file = join(f.root, 'batches', batch.id, 'batch.json');
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.sourceManifest[0].sha256 = '../../private-file';
  await writeFile(file, JSON.stringify(record));
  await assert.rejects(f.restart(), /invalid batch record/);
});
