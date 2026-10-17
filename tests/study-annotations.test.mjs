import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudyAnnotationStore } from '../lib/study-annotations.mjs';

const studyId = 'study-11111111-1111-4111-8111-111111111111';
const hash = 'a'.repeat(64);
const manifest = { id: studyId, manifestHash: hash, cells: [{ cellId: `cell-${'1'.repeat(64)}`, sourceIds: ['paper'] }, { cellId: `cell-${'2'.repeat(64)}`, sourceIds: ['paper'] }] };

test('study annotations persist an opaque randomized coding map and append stage versions', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'offcut-annotations-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const studyStore = { get: id => ({ manifest: { ...manifest, id } }) };
  let tick = 0;
  const clock = () => `2026-01-01T00:00:0${tick++}.000Z`;
  const store = await createStudyAnnotationStore({ dataDir, studyStore, clock });
  const first = await store.get(studyId);
  assert.equal(first.cells.length, 2);
  assert.equal(new Set(first.cells.map(cell => cell.displayId)).size, 2);
  assert.deepEqual(first.cells.map(cell => cell.displayIndex), [0, 1]);
  assert.equal(first.cells.every(cell => cell.revision === 0), true);
  const slot = first.cells[0];

  const image = await store.annotate(studyId, {
    displayId: slot.displayId, expectedRevision: 0, rubricVersion: 'rubric-v1', stage: 'image_only',
    codes: ['balance'], uncertainty: 'low', evidence: [{ region: { x: 0.1, y: 0.2, width: 0.4, height: 0.5 } }], notes: 'Initial reading',
  });
  assert.equal(image.annotation.annotationVersion, 1);
  assert.equal(image.annotation.authorLabel, 'single-researcher');
  assert.equal(image.annotation.cellId, slot.cellId);
  assert.equal(image.revision, 1);
  await assert.rejects(() => store.annotate(studyId, { displayId: slot.displayId, expectedRevision: 0, rubricVersion: 'rubric-v1', stage: 'sources_revealed' }), error => error.status === 409 && error.code === 'ANNOTATION_CONFLICT');

  const revealed = await store.annotate(studyId, { displayId: slot.displayId, expectedRevision: 1, rubricVersion: 'rubric-v1', stage: 'sources_revealed', codes: ['material'], evidence: [{ region: { x: 0, y: 0, width: 1, height: 1 }, sourceIndex: 0 }] });
  assert.equal(revealed.annotation.annotationVersion, 2);
  const reread = await store.get(studyId);
  const rereadSlot = reread.cells.find(cell => cell.displayId === slot.displayId);
  assert.equal(rereadSlot.versions.length, 2);
  assert.equal(rereadSlot.versions[0].stage, 'image_only');
  assert.equal(rereadSlot.versions[0].notes, 'Initial reading');
  assert.equal(rereadSlot.versions[1].stage, 'sources_revealed');
  assert.equal(JSON.parse(await readFile(join(dataDir, `${studyId}.json`), 'utf8')).annotationSeed, first.annotationSeed);

  const restarted = await createStudyAnnotationStore({ dataDir, studyStore, clock });
  assert.deepEqual((await restarted.get(studyId)).cells, reread.cells);
});

test('study annotations validate evidence and preserve stage separation', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'offcut-annotations-invalid-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = await createStudyAnnotationStore({ dataDir, studyStore: { get: () => ({ manifest }) } });
  const slot = (await store.get(studyId)).cells[0];
  await assert.rejects(() => store.annotate(studyId, { displayId: slot.displayId, expectedRevision: 0, rubricVersion: 'v1', stage: 'image_only', evidence: [{ region: { x: 0, y: 0, width: 2, height: 1 }, eventSequence: 1 }] }), /normalized/);
  await store.annotate(studyId, { displayId: slot.displayId, expectedRevision: 0, rubricVersion: 'v1', stage: 'image_only' });
  await store.annotate(studyId, { displayId: slot.displayId, expectedRevision: 1, rubricVersion: 'v1', stage: 'sources_revealed' });
  await store.annotate(studyId, { displayId: slot.displayId, expectedRevision: 2, rubricVersion: 'v1', stage: 'trace_revealed' });
  await assert.rejects(() => store.annotate(studyId, { displayId: slot.displayId, expectedRevision: 3, rubricVersion: 'v1', stage: 'image_only' }), error => error.status === 409 && error.code === 'ANNOTATION_STAGE_CONFLICT');
});

test('study annotations reject duplicate stages, early evidence, and malformed sidecars', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'offcut-annotations-schema-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = await createStudyAnnotationStore({ dataDir, studyStore: { get: () => ({ manifest }) } });
  const slot = (await store.get(studyId)).cells[0];
  await assert.rejects(() => store.annotate(studyId, { displayId: slot.displayId, expectedRevision: 0, rubricVersion: 'v1', stage: 'image_only', evidence: [{ region: { x: 0, y: 0, width: 1, height: 1 }, eventSequence: 1 }] }), error => error.code === 'ANNOTATION_INVALID');
  await store.annotate(studyId, { displayId: slot.displayId, expectedRevision: 0, rubricVersion: 'v1', stage: 'image_only' });
  await assert.rejects(() => store.annotate(studyId, { displayId: slot.displayId, expectedRevision: 1, rubricVersion: 'v1', stage: 'image_only' }), error => error.code === 'ANNOTATION_STAGE_CONFLICT');
  const malformed = JSON.parse(await readFile(join(dataDir, `${studyId}.json`), 'utf8'));
  malformed.cells[0].displayIndex = 99;
  await writeFile(join(dataDir, `${studyId}.json`), JSON.stringify(malformed));
  const restarted = await createStudyAnnotationStore({ dataDir, studyStore: { get: () => ({ manifest }) } });
  await assert.rejects(() => restarted.get(studyId), error => error.code === 'ANNOTATION_STORE_CORRUPT');
});

test('opaque review surface releases only the requested stage', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'offcut-review-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const reviewManifest = { id: studyId, manifestHash: hash, executionOrder: [manifest.cells[0].cellId], plan: { normalizedDraft: { label: 'Review fixture', kind: 'calibration', models: [{ id: 'model-secret', provider: 'openai', model: 'model-secret' }], prompts: [{ id: 'prompt-secret', text: 'Prompt secret' }] } }, cells: [{ ...manifest.cells[0], modelId: 'model-secret', promptId: 'prompt-secret' }] };
  const studyStore = { get: () => ({ manifest: reviewManifest, state: { entries: [{ cellId: manifest.cells[0].cellId, status: 'completed', runId: 'run-secret' }] } }), asset: async () => ({ bytes: Buffer.from('source'), mime: 'image/png' }) };
  const runs = { get: () => ({ provider: 'openai', spec: { model: 'model-secret' }, title: 'Secret title', description: 'Secret statement' }), events: () => [{ sequence: 1, type: 'model_output', turn: 1, model: 'model-returned', text: 'I chose the upper edge.' }, { sequence: 2, type: 'batch_result', turn: 1, accepted: true, decision_note: 'Create tension.', actions: [{ type: 'place' }] }], state: () => ({ canvas: { width: 10, height: 10 } }) };
  const store = await createStudyAnnotationStore({ dataDir, studyStore, runs });
  const list = await store.reviewList(studyId);
  assert.equal(Object.hasOwn(list.cards[0], 'cellId'), false);
  const displayId = list.cards[0].displayId;
  const initial = await store.review(studyId, displayId);
  assert.equal(Object.hasOwn(initial, 'trace'), false);
  assert.equal(Object.hasOwn(initial, 'sources'), false);
  assert.equal(Object.hasOwn(initial, 'runId'), false);
  await assert.rejects(() => store.reviewSource(studyId, displayId, 0, 1), error => error.code === 'REVIEW_SOURCE_UNAVAILABLE');
  await assert.rejects(() => store.review(studyId, displayId, 2), error => error.code === 'REVIEW_STAGE_CONFLICT');
  await store.annotate(studyId, { displayId, expectedRevision: 0, rubricVersion: 'v1', stage: 'image_only' });
  const sources = await store.review(studyId, displayId, 1);
  assert.equal(sources.sources.length, 1);
  assert.equal(Object.hasOwn(sources, 'trace'), false);
  await store.annotate(studyId, { displayId, expectedRevision: 1, rubricVersion: 'v1', stage: 'sources_revealed', evidence: [{ region: { x: 0, y: 0, width: 1, height: 1 }, sourceId: 'paper' }] });
  const trace = await store.review(studyId, displayId, 2);
  assert.equal(trace.trace.requestedModel.model, 'model-secret');
  assert.deepEqual(trace.trace.returnedModels, ['model-returned']);
  assert.equal(trace.trace.events[0].text, 'I chose the upper edge.');
  assert.equal(trace.trace.events[1].decisionNote, 'Create tension.');
  assert.equal(trace.trace.status, 'completed');
});
