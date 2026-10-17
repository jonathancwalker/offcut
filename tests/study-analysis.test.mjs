import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { getSharp } from '../lib/render.mjs';
import { applyAction, createState } from '../lib/engine.mjs';
import { analyzeCollage, measureActionMix, materialReuseJaccard } from '../lib/collage-metrics.mjs';
import { analyzeStudySnapshot, studyRunsCSV, studyRecoveryCSV } from '../lib/study-analysis.mjs';

const idHash = value => createHash('sha256').update(value).digest('hex');

async function sourceFixture() {
  const pixels = Buffer.alloc(10 * 10 * 4, 255);
  const bytes = await getSharp()(pixels, { raw: { width: 10, height: 10, channels: 4 } }).png().toBuffer();
  return { id: 'paper', name: 'Paper', width: 10, height: 10, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
}

async function placedState() {
  const source = await sourceFixture();
  let state = createState({ sources: [source], rules: { minArea: 1 }, canvas: { width: 20, height: 20, background: '#ffffff' } });
  state = applyAction(state, { type: 'cut', sourceId: 'paper', pieceId: 'first', polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] });
  state = applyAction(state, { type: 'place', pieceId: 'first', x: 10, y: 10, rotation: 0, scale: 1 });
  return state;
}

test('collage metrics rasterize native alpha and attribute front-to-back occlusion', async () => {
  const state = await placedState();
  const metrics = await analyzeCollage({ state, acceptedActions: [{ type: 'cut' }, { type: 'place' }, { type: 'describe' }] });
  assert.equal(metrics.canvasArea, 400);
  assert.ok(Math.abs(metrics.coverage - 0.25) < 0.01, `coverage ${metrics.coverage}`);
  assert.ok(Math.abs(metrics.sourceShare.paper - 1) < 1e-9);
  assert.equal(metrics.contributingPieces, 1);
  assert.equal(metrics.materialBreadthNormalized, 0);
  assert.equal(metrics.actionMix.geometricActionDenominator, 2);
  assert.deepEqual(metrics.actionMix.counts, { cut: 1, trim: 0, place: 1, transform: 0, reorder: 0, remove: 0, describe: 1 });
});

test('action and material overlap metrics preserve empty denominators as unknown', () => {
  const mix = measureActionMix();
  assert.equal(mix.proportions.cut, null);
  assert.equal(mix.geometricProportions.cut, null);
  assert.equal(materialReuseJaccard({}, {}), null);
  assert.equal(materialReuseJaccard({ contributingSourceIds: ['a', 'b'] }, { contributingSourceIds: ['b', 'c'] }), 1 / 3);
});

function manifestFixture() {
  const cellId = `cell-${'a'.repeat(64)}`;
  const studyId = 'study-00000000-0000-4000-8000-000000000000';
  return {
    studyId,
    cellId,
    manifest: {
      version: 1, id: studyId, manifestHash: 'b'.repeat(64),
      normalizedDraft: { models: [{ id: 'model', label: 'Model' }], prompts: [{ id: 'prompt', label: 'Prompt' }], packs: [{ id: 'pack', label: 'Pack' }], profiles: [{ id: 'profile', label: 'Profile' }] },
      cells: [{ cellId, modelId: 'model', promptId: 'prompt', packId: 'pack', profileId: 'profile', repetition: 1, spec: { model: 'fixture-model' }, sourceIds: ['paper'], sourceHashes: { paper: 'c'.repeat(64) } }],
      executionOrder: [cellId],
    },
  };
}

test('study snapshot keeps planned cells and reports incomplete run evidence', async () => {
  const { studyId, cellId, manifest } = manifestFixture();
  const state = await placedState();
  manifest.cells[0].sourceHashes.paper = idHash(Buffer.from(state.sources[0].dataUrl.split(',')[1], 'base64'));
  const action = { type: 'cut', sourceId: 'paper', pieceId: 'first', polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] };
  const summary = { id: 'run-00000000-0000-4000-8000-000000000000', status: 'completed', study: { id: studyId, cellId, manifestHash: manifest.manifestHash }, spec: { model: 'fixture-model' }, usageIncomplete: false, costUSD: 0 };
  const events = [
    { type: 'request', turn: 1 },
    { type: 'model_output', turn: 1, text: JSON.stringify({ decision_note: 'Use the paper.', actions: [] }), model: 'fixture-model' },
    { type: 'batch_result', turn: 1, accepted: true, actions: [action] },
  ];
  const project = { id: 'composition', sources: state.sources, rules: state.rules, canvas: state.canvas, cursor: 1, actions: [{ action }] };
  project.sources[0].dataUrl = state.sources[0].dataUrl;
  const report = (await analyzeStudySnapshot({ manifest, entries: [{ cellId, status: 'completed', runId: summary.id }], runs: [{ summary, events, project, recordHashes: { summary: 'd'.repeat(64), events: 'e'.repeat(64), project: 'f'.repeat(64) } }], generatedAt: '2026-01-01T00:00:00.000Z' })).report;
  assert.equal(report.counts.analysisStatus.measured, 1);
  assert.equal(report.noteAvailability.turnsWithNotes, 1);
  assert.equal(report.noteAvailability.returnedResponseDenominator, 1);
  assert.equal(report.cells[0].measurements.coverage, 0);
  assert.match(studyRunsCSV(report, manifest), /cell_id,execution_index/);
  assert.equal(studyRecoveryCSV(report).split('\n').length, 2);
});

test('study CLI writes the complete offline report bundle without touching input data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'offcut-study-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const studyId = 'study-00000000-0000-4000-8000-000000000000';
  const cellId = `cell-${'a'.repeat(64)}`;
  const bytes = Buffer.from('frozen source');
  const sourceHash = idHash(bytes);
  const study = join(root, 'studies', studyId);
  await mkdir(join(study, 'assets'), { recursive: true });
  const manifest = { version: 1, id: studyId, manifestHash: 'b'.repeat(64), normalizedDraft: {}, cells: [{ cellId, modelId: 'model', promptId: 'prompt', packId: 'pack', profileId: 'profile', repetition: 1, spec: { model: 'fixture-model' }, sourceIds: ['paper'], sourceHashes: { paper: sourceHash } }], executionOrder: [cellId] };
  await writeFile(join(study, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(study, 'state.json'), JSON.stringify({ entries: [{ cellId, status: 'not_run', runId: null }] }));
  await writeFile(join(study, 'assets', sourceHash), bytes);
  const out = `${root}-report`;
  t.after(() => rm(out, { recursive: true, force: true }));
  execFileSync(process.execPath, [resolve('scripts/analyze-study.mjs'), '--data-root', root, '--study', studyId, '--out', out], { encoding: 'utf8' });
  assert.deepEqual((await readdir(out)).sort(), ['measurements.json', 'recoveries.csv', 'report.json', 'runs.csv', 'summary.md']);
  assert.equal(JSON.parse(await readFile(join(out, 'report.json'))).counts.analysisStatus.not_run, 1);
  assert.throws(() => execFileSync(process.execPath, [resolve('scripts/analyze-study.mjs'), '--data-root', root, '--study', studyId, '--out', out]));
});
