import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudyAnnotationStore } from '../lib/study-annotations.mjs';

const studyId = 'study-11111111-1111-4111-8111-111111111111';
const hash = 'a'.repeat(64);
const manifest = { id: studyId, manifestHash: hash, cells: [{ cellId: `cell-${'1'.repeat(64)}` }, { cellId: `cell-${'2'.repeat(64)}` }] };

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
    codes: ['balance'], uncertainty: 'low', evidence: [{ region: { x: 0.1, y: 0.2, width: 0.4, height: 0.5 }, statementExcerpt: 'A centered form.' }], notes: 'Initial reading',
  });
  assert.equal(image.annotation.annotationVersion, 1);
  assert.equal(image.annotation.authorLabel, 'single-researcher');
  assert.equal(image.annotation.cellId, slot.cellId);
  assert.equal(image.revision, 1);
  await assert.rejects(() => store.annotate(studyId, { displayId: slot.displayId, expectedRevision: 0, rubricVersion: 'rubric-v1', stage: 'sources_revealed' }), error => error.status === 409 && error.code === 'ANNOTATION_CONFLICT');

  const revealed = await store.annotate(studyId, { displayId: slot.displayId, expectedRevision: 1, rubricVersion: 'rubric-v1', stage: 'sources_revealed', codes: ['material'], evidence: [{ region: { x: 0, y: 0, width: 1, height: 1 }, eventSequence: 4 }] });
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
