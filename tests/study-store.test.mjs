import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudyStore } from '../lib/study-store.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
const sourceHash = createHash('sha256').update(png).digest('hex');
const snapshot = 'a'.repeat(64);
const clone = value => structuredClone(value);

function draft() {
  return {
    version: 1, label: 'Storage test', kind: 'calibration', seed: 7,
    commonBrief: 'Make a collage.',
    prompts: [{ id: 'prompt', label: 'Prompt', text: 'Make something.' }],
    models: [{ id: 'model', label: 'Model', provider: 'openai', model: 'fixture.invalid/model' }],
    packs: [{ id: 'pack', label: 'Pack', catalogSnapshot: snapshot, sourceIds: ['source'], sourceHashes: { source: sourceHash } }],
    repetitions: 1,
    profiles: [{ id: 'profile', label: 'Profile', maxTurns: 12, maxActions: 120, maxPieces: 24, maxOutputTokens: 4096, maxMinutes: 10 }],
    notePolicy: 'short-v1',
  };
}

async function setup(t, protocolSnapshotFactory) {
  const dataDir = await mkdtemp(join(tmpdir(), 'offcut-study-store-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const materials = {
    async resolve(_inventory, ids, hashes) {
      assert.deepEqual(ids, ['source']);
      assert.equal(hashes.source, sourceHash);
      return [{ id: 'source', name: 'Test source', width: 1, height: 1, dataUrl }];
    },
    async list() { return { snapshot }; },
  };
  const campaigns = { get(id) { return { id, status: 'open', rateSnapshotId: 'rate-1', rateSnapshotHash: 'b'.repeat(64), limitMicros: 1000 }; } };
  const getInventory = () => ({ ok: true });
  const store = await createStudyStore({ dataDir, materials, getInventory, campaigns, protocolSnapshotFactory });
  return { dataDir, store, materials, getInventory, campaigns, protocolSnapshotFactory };
}

test('creates an immutable manifest and preserves the idempotent creation receipt', async t => {
  let observedPolicy, observedContext;
  const { dataDir, store } = await setup(t, async (policy, context) => {
    observedPolicy = clone(policy);
    observedContext = clone(context);
    return { version: 1, marker: 'test' };
  });
  const input = { clientRequestId: randomUUID(), draft: draft(), campaignId: 'campaign-test' };
  const first = await store.create(input);
  assert.equal(first.created, true);
  assert.match(first.study.id, /^study-/);
  assert.equal(first.study.manifest.protocolSnapshot.marker, 'test');
  assert.equal(observedPolicy.version, 4);
  assert.equal(observedPolicy.completion.requiresAcceptedDescription, true);
  assert.equal(observedPolicy.instructionsSha256.length, 64);
  assert.deepEqual(observedContext.providers, ['openai']);
  assert.deepEqual(first.study.manifest.sources.map(source => source.id), ['source']);
  assert.deepEqual((await store.create(clone(input))).study, first.study);
  assert.equal((await store.list()).length, 1);
  const manifestFile = join(dataDir, first.study.id, 'manifest.json');
  assert.deepEqual(JSON.parse(await readFile(manifestFile, 'utf8')), first.study.manifest);
});

test('uses only normalized rules to derive policy and freezes source bytes', async t => {
  let receivedRules;
  const { store } = await setup(t, async policy => {
    receivedRules = policy;
    return { version: 1 };
  });
  const result = await store.create({ clientRequestId: randomUUID(), draft: draft(), campaignId: 'campaign-test' });
  assert.equal(receivedRules.protocol, 'offcut-actions-v4');
  assert.equal(receivedRules.initialCanvas, 'blank');
  assert.equal(result.study.manifest.sources[0].byteLength, png.length);
  const asset = await store.asset(result.study.id, 'source');
  assert.deepEqual(asset.bytes, png);
  assert.equal(asset.mime, 'image/png');
});

test('serializes concurrent receipts, recovers missing state, and blocks immutable manifest tampering', async t => {
  const fixture = await setup(t, async () => ({ version: 1 }));
  const input = { clientRequestId: randomUUID(), draft: draft(), campaignId: 'campaign-test' };
  const [left, right] = await Promise.all([fixture.store.create(input), fixture.store.create(clone(input))]);
  assert.equal(left.study.id, right.study.id);
  assert.equal(Number(left.created) + Number(right.created), 1);
  await assert.rejects(
    fixture.store.create({ ...input, draft: { ...input.draft, label: 'Different settings' } }),
    error => error.status === 409 && error.code === 'RECEIPT_CONFLICT',
  );

  const dir = join(fixture.dataDir, left.study.id);
  await mkdir(join(fixture.dataDir, '.study-staging-abandoned'));
  await unlink(join(dir, 'state.json'));
  const disconnectedMaterials = {
    async resolve() { throw new Error('the current catalog must not be consulted'); },
    async list() { throw new Error('the current catalog must not be consulted'); },
  };
  const reopened = await createStudyStore({ ...fixture, dataDir: fixture.dataDir, materials: disconnectedMaterials });
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.get(left.study.id).status, 'ready');
  assert.deepEqual((await reopened.asset(left.study.id, 'source')).bytes, png);

  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.plan.normalizedDraft.label = 'Tampered label';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const blocked = await createStudyStore({ ...fixture, dataDir: fixture.dataDir, materials: disconnectedMaterials });
  assert.equal(blocked.get(left.study.id).status, 'blocked');
  assert.match(blocked.get(left.study.id).issue, /hash mismatch/i);
  assert.throws(() => blocked.manifest(left.study.id), error => error.code === 'STUDY_BLOCKED');
});

test('rejects a catalog swap during freeze and leaves no visible study', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'offcut-study-swap-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const materials = {
    async resolve() { return [{ id: 'source', name: 'Test source', width: 1, height: 1, dataUrl }]; },
    async list() { return { snapshot: 'f'.repeat(64) }; },
  };
  const campaigns = { get(id) { return { id, status: 'open', rateSnapshotId: 'rate-1', rateSnapshotHash: 'b'.repeat(64), limitMicros: 1000 }; } };
  const store = await createStudyStore({ dataDir, materials, getInventory: () => [], campaigns, protocolSnapshotFactory: async () => ({ version: 1 }) });
  await assert.rejects(
    store.create({ clientRequestId: randomUUID(), draft: draft(), campaignId: 'campaign-test' }),
    error => error.status === 409 && error.code === 'CATALOG_CHANGED',
  );
  assert.deepEqual(store.list(), []);
  assert.ok((await readdir(dataDir)).every(name => !name.startsWith('study-')));
});

test('event snapshots recover stale state and preserve an interrupted final append for review', async t => {
  const fixture = await setup(t, async () => ({ version: 1 }));
  const created = await fixture.store.create({ clientRequestId: randomUUID(), draft: draft(), campaignId: 'campaign-test' });
  const id = created.study.id;
  const state = created.study.state;
  state.status = 'paused';
  state.pauseReason = 'test_pause';
  await fixture.store.transition(id, { type: 'study_paused', payload: { reason: 'test_pause' } }, state);
  const dir = join(fixture.dataDir, id);
  await writeFile(join(dir, 'state.json'), JSON.stringify({ stale: true }));
  await appendFile(join(dir, 'events.jsonl'), '{"sequence":2,"type":"partial"');
  const reopened = await createStudyStore({ ...fixture, dataDir: fixture.dataDir });
  assert.equal(reopened.get(id).state.status, 'paused');
  assert.equal(reopened.events(id).length, 1);
  assert.ok((await readdir(dir)).some(name => name.startsWith('events-recovery-')));
});
