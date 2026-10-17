import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { analyzeRun, analyzeRunDirectory, analysisMarkdown } from '../lib/run-analysis.mjs';

const bytes = Buffer.from('a frozen observation fixture');
const hash = createHash('sha256').update(bytes).digest('hex');
const action = { type: 'describe', title: 'A study', statement: 'A finished arrangement.' };
function fixture() {
  const observation = turn => ({ type: 'observation', turn, step: 0, canvasSha256: hash, images: [{ id: 'canvas', kind: 'canvas', sha256: hash, width: 10, height: 10 }] });
  const events = [
    { type: 'run_started', spec: { model: 'fixture-model', provider: 'fixture', prompt: 'Make a collage.' }, policy: { version: 3, completion: { requiresObservedCanvas: true } }, sourceManifest: [{ id: 'paper', sha256: hash }], canvas: { width: 10, height: 10 }, rules: { maxVertices: 64 } },
    observation(1), { type: 'request', turn: 1, request: { private: 'not copied into analysis' } },
    { type: 'model_output', turn: 1, text: JSON.stringify({ decision_note: 'I intend to place this piece.', actions: [{ type: 'place', pieceId: 'missing' }], done: false }), usageIncomplete: false },
    { type: 'batch_result', turn: 1, accepted: false, code: 'PIECE_NOT_FOUND', step: 0 },
    observation(2), { type: 'request', turn: 2 },
    { type: 'model_output', turn: 2, text: JSON.stringify({ decision_note: 'Finish the description.', actions: [action], done: true }), model: 'fixture-model-returned', usageIncomplete: false },
    { type: 'batch_result', turn: 2, accepted: true, actions: [action], decision_note: 'Finish the description.', done: true, completionDeferred: false, fromStep: 0, step: 1 },
    { type: 'final_review', turn: 2, observedStep: 0, step: 1, canvasSha256: hash },
    { type: 'termination', status: 'completed', reason: 'model_finished', acceptedActions: 1, usageIncomplete: false },
  ].map((e, index) => ({ ...e, sequence: index + 1, at: new Date(1000 * index).toISOString() }));
  return { summary: { id: 'run-fixture', status: 'completed', turns: 2, acceptedActions: 1, rejectedBatches: 1, usageIncomplete: false }, events, project: { cursor: 1, actions: [{ action }] } };
}

test('counts committed actions separately from proposals and links notes to the exact evidence', () => {
  const input = fixture(), before = structuredClone(input), report = analyzeRun(input);
  assert.deepEqual(input, before);
  assert.equal(report.metrics.acceptedActions, 1);
  assert.equal(report.metrics.rejectedBatchRate, 0.5);
  assert.deepEqual(report.metrics.acceptedActionTypes, { describe: 1 });
  assert.equal(report.turns[0].proposedActionCount, 1);
  assert.equal(report.turns[0].acceptedActionCount, 0);
  assert.equal(report.turns[0].noteOrigin, 'model_output_json');
  assert.equal(report.turns[1].noteOrigin, 'batch_result');
  assert.deepEqual(report.turns[0].evidence, { observation: 2, request: 3, output: 4, result: 5, finalReview: null });
  assert.equal(report.finalReviewStatus, 'recorded');
  assert.equal(report.durationMs, 10000);
  assert.equal(report.usageIncomplete, false);
  assert.deepEqual(report.issues, []);
  assert.equal(JSON.stringify(report).includes('not copied into analysis'), false);
});

test('malformed model output stays unknown rather than zero proposed actions or an invented note', () => {
  const input = fixture(); input.events[3].text = '{broken';
  const report = analyzeRun(input);
  assert.equal(report.turns[0].proposedActionCount, null);
  assert.equal(report.turns[0].decisionNote, null);
  assert.equal(report.metrics.turnsWithNotes, 1);
  assert.equal(report.metrics.rejectedBatches, 1);
});

test('missing outputs are retained and incomplete usage is not mistaken for zero usage', () => {
  const input = fixture();
  input.events = input.events.slice(0, 3);
  input.events.push({ type: 'termination', sequence: 4, at: new Date(3000).toISOString(), status: 'failed', reason: 'provider_or_runner_error', acceptedActions: 0, usageIncomplete: true });
  input.summary = { id: 'run-fixture', status: 'failed', turns: 1, acceptedActions: 0, rejectedBatches: 0 };
  input.project = { cursor: 0, actions: [] };
  const report = analyzeRun(input);
  assert.equal(report.metrics.responses, 0);
  assert.equal(report.metrics.resolvedBatches, 0);
  assert.equal(report.metrics.rejectedBatchRate, null);
  assert.equal(report.metrics.requestsWithoutOutputs, 1);
  assert.equal(report.turns[0].outcome, 'no_result');
  assert.equal(report.usageIncomplete, true);
  assert.deepEqual(report.issues, []);
});

test('older completion policies are not retroactively failed for lacking a final review', () => {
  const input = fixture(); input.events[0].policy = { version: 1 };
  input.events = input.events.filter(e => e.type !== 'final_review').map((e, index) => ({ ...e, sequence: index + 1 }));
  const report = analyzeRun(input);
  assert.equal(report.finalReviewStatus, 'not_required_or_unknown');
  assert.deepEqual(report.issues, []);
  input.events[0].policy = { version: 3, completion: { requiresObservedCanvas: true } };
  assert.ok(analyzeRun(input).issues.some(i => i.code === 'MISSING_FINAL_REVIEW'));
});

test('inconsistent cursor, final observation, checkpoint and sequence are surfaced as record issues', () => {
  const input = fixture();
  input.events[8].fromStep = 4;
  input.events[9].canvasSha256 = 'b'.repeat(64);
  input.events[3].sequence = 30;
  input.project.cursor = 20;
  const report = analyzeRun(input);
  const codes = report.issues.map(i => i.code);
  for (const code of ['EVENT_SEQUENCE', 'ACTION_CURSOR', 'FINAL_REVIEW_LINK', 'PROJECT_ACTIONS', 'MISSING_FINAL_REVIEW']) assert.ok(codes.includes(code), code);
});

async function diskFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'offcut-analysis-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runs = join(root, 'runs'), dir = join(runs, 'run-fixture');
  await mkdir(join(dir, 'assets'), { recursive: true });
  const input = fixture();
  await writeFile(join(dir, 'run.json'), JSON.stringify(input.summary));
  await writeFile(join(dir, 'events.jsonl'), input.events.map(e => JSON.stringify(e)).join('\n') + '\n');
  await writeFile(join(dir, 'project.json'), JSON.stringify(input.project));
  await writeFile(join(dir, 'assets', hash), bytes);
  return { root, runs, dir, input };
}

test('disk analysis verifies assets without changing input records, including corrupted and missing files', async t => {
  const { runs, dir } = await diskFixture(t);
  const files = ['run.json', 'events.jsonl', 'project.json', `assets/${hash}`];
  const before = await Promise.all(files.map(file => readFile(join(dir, file))));
  const first = await analyzeRunDirectory(runs);
  assert.equal(first.runs.length, 1);
  assert.deepEqual(first.runs[0].assets, { referenced: 1, verified: 1 });
  assert.deepEqual(first.runs[0].issues, []);
  assert.deepEqual(await Promise.all(files.map(file => readFile(join(dir, file)))), before);
  await writeFile(join(dir, 'assets', hash), 'changed');
  assert.ok((await analyzeRunDirectory(runs)).runs[0].issues.some(i => i.code === 'ASSET_BYTES'));
  await rm(join(dir, 'assets', hash));
  assert.ok((await analyzeRunDirectory(runs)).runs[0].issues.some(i => i.code === 'ASSET_MISSING'));
});

test('running and unreadable records remain visible in report denominators', async t => {
  const { runs } = await diskFixture(t);
  await mkdir(join(runs, 'run-active'));
  await writeFile(join(runs, 'run-active', 'run.json'), JSON.stringify({ status: 'running' }));
  await mkdir(join(runs, 'run-broken'));
  await writeFile(join(runs, 'run-broken', 'run.json'), '{broken');
  const report = await analyzeRunDirectory(runs);
  assert.equal(report.runs.length, 1); assert.equal(report.skipped.length, 1); assert.equal(report.errors.length, 1);
  const markdown = analysisMarkdown(report);
  assert.match(markdown, /1 records analyzed; 1 skipped; 1 unreadable/);
  assert.match(markdown, /run-broken/);
});

test('CLI writes a separate report, refuses existing output and rejects output inside run storage', async t => {
  const { root, runs, dir } = await diskFixture(t);
  const cli = resolve('scripts/analyze-runs.mjs'), out = join(root, 'report');
  const call = output => execFileSync(process.execPath, [cli, '--runs', runs, '--out', output], { encoding: 'utf8', stdio: 'pipe' });
  assert.match(call(out), /1 runs analyzed/);
  assert.deepEqual((await readdir(out)).sort(), ['report.json', 'summary.md']);
  const saved = await readFile(join(out, 'report.json'));
  assert.throws(() => call(out));
  assert.deepEqual(await readFile(join(out, 'report.json')), saved);
  assert.throws(() => call(join(dir, 'analysis')));
  assert.equal((await readdir(dir)).includes('analysis'), false);
});
