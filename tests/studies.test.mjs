import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createStudyManager } from '../lib/studies.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const cellId = value => `cell-${digest(value)}`;

function fixture(count = 3) {
  const id = `study-${randomUUID()}`;
  const cells = Array.from({ length: count }, (_, index) => ({
    cellId: cellId(String(index)),
    spec: { provider: 'openai', model: 'gpt-5.6-luna', prompt: `Prompt ${index}`, maxTurns: 2, maxActions: 12, maxPieces: 4, maxOutputTokens: 512, maxMinutes: 1 },
    sourceIds: ['paper'], sourceHashes: { paper: digest('paper') },
  }));
  const manifest = {
    id, manifestHash: digest(id), executionOrder: cells.map(cell => cell.cellId), cells,
    campaign: { id: `campaign-${randomUUID()}` },
    plan: { normalizedDraft: { kind: 'calibration' } },
    protocolSnapshot: { executionFingerprint: digest('protocol'), codeClean: false },
  };
  const state = {
    format: 'offcut-study-state', version: 1, id, manifestHash: manifest.manifestHash,
    status: 'ready', updatedAt: new Date().toISOString(), terminationReason: null,
    entries: manifest.executionOrder.map((id, executionIndex) => ({ cellId: id, executionIndex, status: 'queued', runId: null, terminationReason: null })),
  };
  const events = [];
  const store = {
    list: () => [{ id, kind: manifest.plan.normalizedDraft.kind, status: state.status }],
    get: () => ({ id, kind: manifest.plan.normalizedDraft.kind, status: state.status, state: structuredClone(state), manifest: structuredClone(manifest) }),
    manifest: () => structuredClone(manifest),
    async verifyCompatibility() { return { compatible: true }; },
    async resolveSources() { return [{ id: 'paper', name: 'Paper', width: 16, height: 16, dataUrl: 'data:image/png;base64,AA==' }]; },
    async transition(_id, event, next) { Object.assign(state, structuredClone(next)); events.push({ ...event, state: structuredClone(next) }); },
  };
  const campaigns = { get: () => ({ status: 'active', availableMicros: 1_000_000 }), guard: () => ({ reserve() {} }) };
  return { id, manifest, state, store, campaigns, events };
}

function runFixture(outcomes = []) {
  const launches = [], byToken = new Map();
  return {
    launches, byToken,
    findLaunch(token) { return byToken.get(token) ?? null; },
    async start(input) {
      launches.push({ ...input, sources: structuredClone(input.sources), spec: structuredClone(input.spec), launch: structuredClone(input.launch), study: structuredClone(input.study) });
      const run = { id: `run-${randomUUID()}`, status: 'running', launch: input.launch, study: input.study, turns: 1, terminationReason: null };
      byToken.set(input.launch.clientRequestId, run);
      return structuredClone(run);
    },
    async wait(id) {
      const run = [...byToken.values()].find(value => value.id === id);
      const outcome = outcomes.shift() ?? { status: 'completed', terminationReason: 'model_finished' };
      Object.assign(run, outcome);
      return structuredClone(run);
    },
    get(id) { return structuredClone([...byToken.values()].find(value => value.id === id)); },
    async stop(id) { const run = [...byToken.values()].find(value => value.id === id); Object.assign(run, { status: 'stopped', terminationReason: 'user_stopped' }); return structuredClone(run); },
    async interrupt(id) { const run = [...byToken.values()].find(value => value.id === id); Object.assign(run, { status: 'interrupted', terminationReason: 'server_closed' }); return structuredClone(run); },
  };
}

test('runs every frozen cell once in exact order and retains ordinary failures in the matrix', async () => {
  const f = fixture(6);
  const runs = runFixture([
    { status: 'completed', terminationReason: 'model_finished' },
    { status: 'failed', terminationReason: 'invalid_model_output' },
    { status: 'limit_reached', terminationReason: 'turn_limit' },
  ]);
  const manager = await createStudyManager({ store: f.store, runs, campaigns: f.campaigns });
  const started = await manager.start(f.id, { clientRequestId: randomUUID(), manifestHash: f.manifest.manifestHash });
  assert.equal(started.status, 'running');
  const ended = await manager.wait(f.id);
  assert.equal(ended.status, 'completed');
  assert.deepEqual(runs.launches.map(item => item.study.cellId), f.manifest.executionOrder);
  assert.deepEqual(ended.entries.slice(0, 3).map(entry => entry.status), ['completed', 'failed', 'limit_reached']);
  assert.ok(ended.entries.every(entry => entry.childClientRequestId && entry.childFingerprint));
  assert.equal(new Set(runs.launches.map(item => item.launch.clientRequestId)).size, 6);
});

test('pause waits for the current cell, resume is explicit, and stop marks the remainder not_run', async () => {
  const f = fixture(3);
  let release;
  const runs = runFixture();
  runs.wait = id => new Promise(resolve => { release = () => { const run = [...runs.byToken.values()].find(value => value.id === id); Object.assign(run, { status: 'completed', terminationReason: 'model_finished' }); resolve(structuredClone(run)); }; });
  runs.stop = async id => { const run = [...runs.byToken.values()].find(value => value.id === id); Object.assign(run, { status: 'stopped', terminationReason: 'user_stopped' }); release?.(); return structuredClone(run); };
  const manager = await createStudyManager({ store: f.store, runs, campaigns: f.campaigns });
  const token = randomUUID();
  await manager.start(f.id, { clientRequestId: token, manifestHash: f.manifest.manifestHash });
  for (let attempt = 0; attempt < 20 && !release; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await manager.start(f.id, { clientRequestId: token, manifestHash: f.manifest.manifestHash })).status, 'running');
  await manager.pause(f.id, { clientRequestId: randomUUID() });
  assert.equal(manager.get(f.id).status, 'pausing');
  release();
  await manager.wait(f.id);
  assert.equal(manager.get(f.id).status, 'paused');
  assert.equal(runs.launches.length, 1);
  await manager.resume(f.id, { clientRequestId: randomUUID(), manifestHash: f.manifest.manifestHash });
  for (let attempt = 0; attempt < 20 && runs.launches.length < 2; attempt++) await new Promise(resolve => setImmediate(resolve));
  await manager.stop(f.id, { clientRequestId: randomUUID() });
  const ended = manager.get(f.id);
  assert.equal(ended.status, 'stopped');
  assert.equal(ended.entries.filter(entry => entry.status === 'not_run').length, 1);
});

test('resume retries a credential preflight failure that never created a run', async () => {
  const f = fixture(2);
  const runs = runFixture();
  const start = runs.start.bind(runs);
  let keyAvailable = false;
  runs.start = async input => {
    if (!keyAvailable) throw Object.assign(new Error('Connect a key.'), { code: 'MISSING_CREDENTIAL' });
    return start(input);
  };
  const manager = await createStudyManager({ store: f.store, runs, campaigns: f.campaigns });

  await manager.start(f.id, { clientRequestId: randomUUID(), manifestHash: f.manifest.manifestHash });
  await manager.wait(f.id);
  const paused = manager.get(f.id);
  assert.equal(paused.status, 'paused');
  assert.deepEqual(paused.entries.map(entry => entry.status), ['failed', 'queued']);
  assert.equal(paused.entries[0].runId, null);

  keyAvailable = true;
  await manager.resume(f.id, { clientRequestId: randomUUID(), manifestHash: f.manifest.manifestHash });
  const completed = await manager.wait(f.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.entries.map(entry => entry.status), ['completed', 'completed']);
  assert.deepEqual(runs.launches.map(item => item.study.cellId), f.manifest.executionOrder);
  assert.deepEqual(f.events.find(event => event.type === 'study_resumed').payload.requeuedCellIds, [f.manifest.executionOrder[0]]);
});

test('restart reconciles a durable child receipt and never launches automatically', async () => {
  const f = fixture(1);
  const entry = f.state.entries[0];
  entry.status = 'starting';
  entry.childClientRequestId = randomUUID();
  entry.childFingerprint = digest('child');
  f.state.status = 'running';
  const runs = runFixture();
  runs.byToken.set(entry.childClientRequestId, {
    id: `run-${randomUUID()}`, status: 'interrupted', terminationReason: 'server_closed', turns: 1,
    launch: { clientRequestId: entry.childClientRequestId, requestFingerprint: entry.childFingerprint },
    study: { id: f.id, cellId: entry.cellId },
  });
  const manager = await createStudyManager({ store: f.store, runs, campaigns: f.campaigns });
  assert.equal(manager.get(f.id).status, 'paused');
  assert.equal(manager.get(f.id).entries[0].status, 'interrupted');
  assert.equal(runs.launches.length, 0);
  assert.equal(f.events.at(-1).type, 'study_recovered');
});

test('stopping an already paused study closes every queued cell without needing a live task', async () => {
  const f = fixture(2);
  f.state.status = 'paused';
  const manager = await createStudyManager({ store: f.store, runs: runFixture(), campaigns: f.campaigns });
  const ended = await manager.stop(f.id, { clientRequestId: randomUUID() });
  assert.equal(ended.status, 'stopped');
  assert.deepEqual(ended.entries.map(entry => entry.status), ['not_run', 'not_run']);
});

test('admission failures make zero child calls and preserve a ready study', async () => {
  const f = fixture(1);
  f.store.verifyCompatibility = async () => { throw Object.assign(new Error('changed code'), { status: 409, code: 'CODE_MISMATCH' }); };
  const runs = runFixture();
  const manager = await createStudyManager({ store: f.store, runs, campaigns: f.campaigns });
  await assert.rejects(manager.start(f.id, { clientRequestId: randomUUID(), manifestHash: f.manifest.manifestHash }), error => error.code === 'CODE_MISMATCH');
  assert.equal(runs.launches.length, 0);
  assert.equal(manager.get(f.id).status, 'ready');
});

test('primary collection cannot start before every selected route has different-pack calibration evidence', async () => {
  const f = fixture(1);
  f.manifest.plan.normalizedDraft.kind = 'primary';
  f.manifest.plan.packIdentities = [{ contentOnlyPackHash: digest('primary-pack') }];
  f.manifest.protocolSnapshot.codeClean = true;
  const runs = runFixture();
  const manager = await createStudyManager({ store: f.store, runs, campaigns: f.campaigns });
  await assert.rejects(
    manager.start(f.id, { clientRequestId: randomUUID(), manifestHash: f.manifest.manifestHash }),
    error => error.code === 'MODEL_COMPATIBILITY_UNVERIFIED',
  );
  assert.equal(runs.launches.length, 0);
});
