import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportStudy, verifyStudyExport } from '../lib/study-export.mjs';
import { getSharp } from '../lib/render.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function refreshChecksums(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await refreshChecksums(join(directory, entry.name), path));
    else if (path !== 'checksums.json') {
      const bytes = await readFile(join(directory, entry.name));
      files.push({ path, sha256: hash(bytes), byteLength: bytes.length });
    }
  }
  if (!prefix) await writeFile(join(directory, 'checksums.json'), `${JSON.stringify({ format: 'offcut-study-export-checksums', version: 1, files: files.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2)}\n`);
  return files;
}

async function fixture(t, { secret = false, active = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'offcut-export-data-'));
  const out = `${root}-artifact`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(out, { recursive: true, force: true })]));
  const studyId = `study-${randomUUID()}`, campaignId = `campaign-${randomUUID()}`, runId = `run-${randomUUID()}`;
  const cellId = `cell-${'a'.repeat(64)}`;
  const sourceBytes = await getSharp()({ create: { width: 4, height: 4, channels: 4, background: '#a04020' } }).png().toBuffer();
  const sourceHash = hash(sourceBytes);
  const source = { id: 'paper', name: 'Paper', width: 4, height: 4, sha256: sourceHash, mime: 'image/png', byteLength: sourceBytes.length, license: 'CC0' };
  const cell = { cellId, modelId: 'model', promptId: 'prompt', packId: 'pack', profileId: 'profile', repetition: 1, spec: { provider: 'openai', model: 'fixture/model' }, sourceIds: ['paper'], sourceHashes: { paper: sourceHash } };
  const manifest = { format: 'offcut-study', version: 1, id: studyId, createdAt: '2026-01-01T00:00:00.000Z', plan: { normalizedDraft: { label: 'Fixture study', commonBrief: 'Make a self portrait.' } }, executionOrder: [cellId], cells: [cell], sources: [source], campaign: { id: campaignId }, protocolSnapshot: { executionFiles: [] } };
  manifest.manifestHash = hash(canonical(manifest));
  const state = { format: 'offcut-study-state', version: 1, id: studyId, manifestHash: manifest.manifestHash, status: active ? 'running' : 'completed', entries: [{ cellId, executionIndex: 0, status: active ? 'running' : 'completed', runId, terminationReason: null }] };
  const studyDir = join(root, 'studies', studyId), runDir = join(root, 'runs', runId), campaignDir = join(root, 'campaigns', campaignId);
  await Promise.all([mkdir(join(studyDir, 'assets'), { recursive: true }), mkdir(join(runDir, 'assets'), { recursive: true }), mkdir(campaignDir, { recursive: true })]);
  await Promise.all([
    writeFile(join(studyDir, 'manifest.json'), JSON.stringify(manifest)), writeFile(join(studyDir, 'state.json'), JSON.stringify(state)), writeFile(join(studyDir, 'assets', sourceHash), sourceBytes),
    writeFile(join(campaignDir, 'config.json'), JSON.stringify({ format: 'offcut-campaign', version: 1, id: campaignId, limitMicros: 50_000_000, rateSnapshot: { id: 'rates-v1', hash: 'b'.repeat(64) } })), writeFile(join(campaignDir, 'ledger.jsonl'), ''),
  ]);
  const dataUrl = `data:image/png;base64,${sourceBytes.toString('base64')}`;
  const project = { id: 'fixture', sources: [{ id: 'paper', name: 'Paper', width: 4, height: 4, dataUrl }], canvas: { width: 20, height: 20, background: '#ffffff' }, rules: {}, actions: [], cursor: 0 };
  const run = { id: runId, status: active ? 'running' : 'completed', study: { id: studyId, manifestHash: manifest.manifestHash, cellId }, title: 'Untitled', statement: secret ? 'sk-should-never-export' : 'A quiet blank field.' };
  const events = [
    { sequence: 1, type: 'run_started' },
    { sequence: 2, type: 'request', turn: 1, requestId: `${runId}:turn:1`, request: { messages: [{ role: 'user', images: [{ id: 'paper', sha256: sourceHash, mime: 'image/png' }] }] } },
    { sequence: 3, type: 'model_output', turn: 1, model: 'fixture/returned', responseId: 'response-fixture', text: '{}', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }, usageIncomplete: false },
    { sequence: 4, type: 'batch_result', turn: 1, accepted: true, actions: [] },
    { sequence: 5, type: 'termination', status: 'completed' },
  ];
  await Promise.all([writeFile(join(runDir, 'run.json'), JSON.stringify(run)), writeFile(join(runDir, 'project.json'), JSON.stringify(project)), writeFile(join(runDir, 'events.jsonl'), `${events.map(JSON.stringify).join('\n')}\n`)]);
  return { root, out, studyId, manifestHash: manifest.manifestHash };
}

test('exports every cell, externalizes source bytes, and verifies replay without a provider', async t => {
  const f = await fixture(t);
  const result = await exportStudy({ dataDir: f.root, studyId: f.studyId, outDir: f.out });
  assert.equal(result.cells, 1);
  assert.equal(result.attempted, 1);
  const index = JSON.parse(await readFile(join(f.out, 'export.json')));
  assert.equal(index.cells[0].returnedModel, 'fixture/returned');
  assert.equal(index.cells[0].provider, 'openai');
  assert.deepEqual(index.cells[0].responseIds, ['response-fixture']);
  assert.equal(index.cells[0].qualification.nativeImage, true);
  assert.equal(index.cells[0].status, 'completed');
  const qualifications = JSON.parse(await readFile(join(f.out, index.qualifications)));
  assert.equal(qualifications.routes[0].requestedRoute, 'fixture/model');
  assert.equal(qualifications.routes[0].evidence[0].completeUsage, true);
  assert.ok(!String(await readFile(join(f.out, index.works[0].project))).includes('base64'));
  assert.deepEqual(await verifyStudyExport(f.out), { valid: true, studyId: f.studyId, cells: 1, attempted: 1, assets: 1 });
  await assert.rejects(exportStudy({ dataDir: f.root, studyId: f.studyId, outDir: f.out }), error => error.code === 'STUDY_EXPORT_EXISTS');
});

test('refuses active roots/studies and credential-like export content', async t => {
  const active = await fixture(t, { active: true });
  await assert.rejects(exportStudy({ dataDir: active.root, studyId: active.studyId, outDir: active.out }), error => error.code === 'STUDY_ACTIVE');
  const locked = await fixture(t);
  await writeFile(join(locked.root, '.offcut-writer.lock'), JSON.stringify({ format: 'offcut-writer-lock' }));
  await assert.rejects(exportStudy({ dataDir: locked.root, studyId: locked.studyId, outDir: locked.out }), error => error.code === 'DATA_ROOT_LOCKED');
  const secret = await fixture(t, { secret: true });
  await assert.rejects(exportStudy({ dataDir: secret.root, studyId: secret.studyId, outDir: secret.out }), error => error.code === 'STUDY_EXPORT_LEAK');
});

test('verification rejects changed files and path traversal', async t => {
  const f = await fixture(t);
  await exportStudy({ dataDir: f.root, studyId: f.studyId, outDir: f.out });
  await writeFile(join(f.out, 'style.css'), 'changed');
  await assert.rejects(verifyStudyExport(f.out), error => error.code === 'STUDY_EXPORT_CHECKSUM');

  await rm(f.out, { recursive: true, force: true });
  await exportStudy({ dataDir: f.root, studyId: f.studyId, outDir: f.out });
  const index = JSON.parse(await readFile(join(f.out, 'export.json')));
  index.manifest = '../outside.json';
  await writeFile(join(f.out, 'export.json'), JSON.stringify(index));
  await refreshChecksums(f.out);
  await assert.rejects(verifyStudyExport(f.out), /Invalid manifest path/);
});
