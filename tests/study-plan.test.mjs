import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_STUDY_COMMON_BRIEF,
  DEFAULT_STUDY_PROMPTS,
  DEFAULT_STUDY_REPETITIONS,
  DEFAULT_STUDY_SOURCES_PER_PACK,
  STANDARD_STUDY_PROFILE,
  STUDY_ORDER_ALGORITHM,
  normalizeStudyDraft,
  planStudy,
} from '../public/study-plan.mjs';

const fixtureUrl = new URL('./fixtures/study-draft-v1.json', import.meta.url);
const fixtureText = await readFile(fixtureUrl, 'utf8');
const fixture = () => JSON.parse(fixtureText);
const clone = value => structuredClone(value);
const tuple = cell => [cell.modelId, cell.packId, cell.promptId, cell.repetition, cell.profileId].join('/');
const invalid = input => assert.throws(
  () => normalizeStudyDraft(input),
  error => error instanceof Error && error.status === 400 && error.code === 'INVALID_STUDY_DRAFT',
);

test('documented defaults define the three conditions and standard profile without a provider route', () => {
  assert.equal(DEFAULT_STUDY_COMMON_BRIEF, 'Create an original collage from the provided source images. There is no target image. Give the finished work a title and a short statement.');
  assert.deepEqual(DEFAULT_STUDY_PROMPTS.map(prompt => prompt.text), [
    'Make a portrait of an AI assistant.',
    'Make a portrait of yourself as an AI assistant.',
    'Make a portrait of what it feels like to be you as an AI assistant.',
  ]);
  assert.equal(DEFAULT_STUDY_REPETITIONS, 2);
  assert.equal(DEFAULT_STUDY_SOURCES_PER_PACK, 6);
  assert.deepEqual(STANDARD_STUDY_PROFILE, {
    id: 'standard', label: 'Standard', maxTurns: 12, maxActions: 120, maxPieces: 24, maxOutputTokens: 4096, maxMinutes: 10,
  });
  assert.equal(Object.hasOwn(STANDARD_STUDY_PROFILE, 'model'), false);
  assert.doesNotMatch(fixtureText, /api[_ -]?key|secret|credential/i);
  assert.ok(fixture().models.every(entry => entry.model.startsWith('fixture.invalid/')));
});

test('the fixture plans all 3×2×3×2×1 tuples exactly once', async () => {
  const plan = await planStudy(fixture());
  assert.deepEqual(plan.counts, { models: 3, prompts: 3, packs: 2, repetitions: 2, profiles: 1, cells: 36 });
  assert.deepEqual(plan.dimensions, {
    modelIds: ['level-a', 'level-b', 'level-c'],
    promptIds: ['ai-portrait', 'experience-framing', 'self-portrait'],
    packIds: ['pack-alpha', 'pack-beta'],
    repetitions: [1, 2],
    profileIds: ['standard'],
  });
  assert.equal(plan.cells.length, 36);
  assert.equal(new Set(plan.cells.map(cell => cell.cellId)).size, 36);
  assert.equal(new Set(plan.cells.map(tuple)).size, 36);
  const expected = [];
  for (const model of ['level-a', 'level-b', 'level-c']) {
    for (const pack of ['pack-alpha', 'pack-beta']) {
      for (const prompt of ['ai-portrait', 'experience-framing', 'self-portrait']) {
        for (const repetition of [1, 2]) expected.push(`${model}/${pack}/${prompt}/${repetition}/standard`);
      }
    }
  }
  assert.deepEqual(plan.cells.map(tuple).sort(), expected.sort());
  assert.deepEqual(new Set(plan.executionOrder), new Set(plan.cells.map(cell => cell.cellId)));
  assert.ok(plan.cells.every(cell => /^cell-[a-f0-9]{64}$/.test(cell.cellId)));
  assert.equal(plan.cells.find(cell => tuple(cell) === 'level-a/pack-alpha/experience-framing/2/standard').cellId,
    'cell-01a1110d3f444fae5a0ddd5a258a4476504486102c1126fea0a4aa2a6360be88');
});

test('the v1 seed and sorted cell IDs have a fixed golden execution order', async () => {
  const plan = await planStudy(fixture());
  assert.equal(plan.orderAlgorithm, STUDY_ORDER_ALGORITHM);
  assert.deepEqual(plan.executionOrder.map(id => tuple(plan.cells.find(cell => cell.cellId === id))), [
    'level-b/pack-beta/self-portrait/1/standard',
    'level-a/pack-alpha/ai-portrait/1/standard',
    'level-b/pack-beta/experience-framing/1/standard',
    'level-c/pack-alpha/ai-portrait/2/standard',
    'level-a/pack-beta/self-portrait/2/standard',
    'level-b/pack-beta/self-portrait/2/standard',
    'level-a/pack-beta/self-portrait/1/standard',
    'level-b/pack-alpha/self-portrait/1/standard',
    'level-c/pack-beta/experience-framing/2/standard',
    'level-c/pack-beta/self-portrait/1/standard',
    'level-a/pack-beta/ai-portrait/1/standard',
    'level-b/pack-alpha/ai-portrait/1/standard',
    'level-b/pack-alpha/experience-framing/2/standard',
    'level-a/pack-beta/experience-framing/1/standard',
    'level-c/pack-beta/ai-portrait/2/standard',
    'level-c/pack-beta/ai-portrait/1/standard',
    'level-b/pack-alpha/self-portrait/2/standard',
    'level-c/pack-alpha/experience-framing/1/standard',
    'level-c/pack-alpha/experience-framing/2/standard',
    'level-c/pack-beta/self-portrait/2/standard',
    'level-b/pack-beta/ai-portrait/2/standard',
    'level-c/pack-beta/experience-framing/1/standard',
    'level-a/pack-alpha/self-portrait/2/standard',
    'level-b/pack-beta/experience-framing/2/standard',
    'level-c/pack-alpha/self-portrait/2/standard',
    'level-c/pack-alpha/ai-portrait/1/standard',
    'level-c/pack-alpha/self-portrait/1/standard',
    'level-a/pack-beta/ai-portrait/2/standard',
    'level-a/pack-alpha/experience-framing/1/standard',
    'level-a/pack-beta/experience-framing/2/standard',
    'level-b/pack-beta/ai-portrait/1/standard',
    'level-b/pack-alpha/experience-framing/1/standard',
    'level-a/pack-alpha/ai-portrait/2/standard',
    'level-a/pack-alpha/self-portrait/1/standard',
    'level-a/pack-alpha/experience-framing/2/standard',
    'level-b/pack-alpha/ai-portrait/2/standard',
  ]);
  assert.deepEqual(await planStudy(fixture()), plan);
});

test('changing only the seed changes only execution order', async () => {
  const first = await planStudy(fixture());
  const changedDraft = fixture(); changedDraft.seed++;
  const changed = await planStudy(changedDraft);
  assert.deepEqual(changed.cells, first.cells);
  assert.deepEqual(changed.packIdentities, first.packIdentities);
  assert.deepEqual(changed.counts, first.counts);
  assert.deepEqual(changed.dimensions, first.dimensions);
  assert.notDeepEqual(changed.executionOrder, first.executionOrder);
});

test('definition-list order cannot change cell IDs or the shuffled schedule', async () => {
  const original = await planStudy(fixture());
  const reorderedDraft = fixture();
  reorderedDraft.models.reverse();
  reorderedDraft.prompts.reverse();
  reorderedDraft.packs.reverse();
  const reordered = await planStudy(reorderedDraft);
  assert.deepEqual(reordered.cells, original.cells);
  assert.deepEqual(reordered.executionOrder, original.executionOrder);
  assert.deepEqual(reordered.packIdentities, original.packIdentities);
});

test('ordered images define pack hashes without changing the pack slug-based cell ID', async () => {
  const original = await planStudy(fixture());
  const changedDraft = fixture();
  changedDraft.packs[0].sourceIds.reverse();
  const changed = await planStudy(changedDraft);
  const originalPack = original.packIdentities.find(pack => pack.packId === 'pack-alpha');
  const changedPack = changed.packIdentities.find(pack => pack.packId === 'pack-alpha');
  assert.notEqual(changedPack.sourcePackHash, originalPack.sourcePackHash);
  assert.notEqual(changedPack.contentOnlyPackHash, originalPack.contentOnlyPackHash);
  assert.deepEqual(changed.cells.map(cell => cell.cellId), original.cells.map(cell => cell.cellId));
  assert.notDeepEqual(changed.cells, original.cells);
});

test('prompt assembly is exact and presentation labels do not alter it', async () => {
  const draft = fixture();
  draft.commonBrief = '  First line.\nKeep this line.  ';
  draft.prompts[0].text = '  Subject line.\nKeep that line.  ';
  const planned = await planStudy(draft);
  const prompt = planned.cells.find(cell => cell.promptId === 'ai-portrait').spec.prompt;
  assert.equal(prompt, 'First line.\nKeep this line.\n\nSubject line.\nKeep that line.');
  const relabeled = clone(draft);
  relabeled.label = 'Another study';
  relabeled.prompts[0].label = 'Another prompt label';
  relabeled.models[0].label = 'Another model label';
  relabeled.packs[0].label = 'Another pack label';
  relabeled.profiles[0].label = 'Another profile label';
  const replanned = await planStudy(relabeled);
  assert.equal(replanned.cells.find(cell => cell.promptId === 'ai-portrait').spec.prompt, prompt);
  assert.deepEqual(replanned.cells, planned.cells);
});

test('normalization and planning are detached, deterministic, and do not consult random or time', async () => {
  const draft = fixture();
  const before = clone(draft);
  const originalRandom = Math.random;
  const originalNow = Date.now;
  Math.random = () => { throw new Error('randomness is forbidden'); };
  Date.now = () => { throw new Error('time is forbidden'); };
  try {
    const normalized = normalizeStudyDraft(draft);
    assert.equal(normalized instanceof Promise, false);
    const plan = await planStudy(draft);
    assert.deepEqual(draft, before);
    normalized.models[0].label = 'mutated output';
    normalized.packs[0].sourceIds.reverse();
    plan.cells[0].sourceIds.reverse();
    assert.deepEqual(draft, before);
  } finally {
    Math.random = originalRandom;
    Date.now = originalNow;
  }
});

test('draft, collection, and entry schemas reject unknown, missing, malformed, or duplicate IDs', () => {
  invalid(null);
  invalid({ ...fixture(), unknown: true });
  const missing = fixture(); delete missing.seed; invalid(missing);
  for (const value of [0, 2, '1']) invalid({ ...fixture(), version: value });
  for (const value of ['secondary', '', null]) invalid({ ...fixture(), kind: value });
  for (const value of [-1, 0x100000000, 1.5, '1', null]) invalid({ ...fixture(), seed: value });
  for (const value of ['long_id', '-bad', 'a'.repeat(41), '', null]) {
    const draft = fixture(); draft.prompts[0].id = value; invalid(draft);
  }
  const duplicatePrompt = fixture(); duplicatePrompt.prompts[1].id = duplicatePrompt.prompts[0].id; invalid(duplicatePrompt);
  const duplicateModel = fixture(); duplicateModel.models[1].id = duplicateModel.models[0].id; invalid(duplicateModel);
  const duplicateRoute = fixture(); duplicateRoute.models[1].model = duplicateRoute.models[0].model; invalid(duplicateRoute);
  const duplicatePack = fixture(); duplicatePack.packs[1].id = duplicatePack.packs[0].id; invalid(duplicatePack);
  const duplicateSource = fixture(); duplicateSource.packs[0].sourceIds[1] = duplicateSource.packs[0].sourceIds[0]; invalid(duplicateSource);
  for (const [collectionName, entry] of [['prompts', { extra: true }], ['models', { extra: true }], ['packs', { extra: true }], ['profiles', { extra: true }]]) {
    const draft = fixture(); Object.assign(draft[collectionName][0], entry); invalid(draft);
  }
  const alternateProvider = fixture(); alternateProvider.models[0].provider = 'fixture-provider'; assert.equal(normalizeStudyDraft(alternateProvider).models[0].provider, 'fixture-provider');
  const badProvider = fixture(); badProvider.models[0].provider = 'Fixture Provider'; invalid(badProvider);
  const badRoute = fixture(); badRoute.models[0].model = 'has spaces'; invalid(badRoute);
  const badNotePolicy = fixture(); badNotePolicy.notePolicy = 'verbose-v1'; invalid(badNotePolicy);
});

test('source hash maps are exact and reject malformed or repeated image bytes', () => {
  const extra = fixture(); extra.packs[0].sourceHashes.unknown = 'e'.repeat(64); invalid(extra);
  const missing = fixture(); delete missing.packs[0].sourceHashes['alpha-one']; invalid(missing);
  const malformed = fixture(); malformed.packs[0].sourceHashes['alpha-one'] = 'not-a-hash'; invalid(malformed);
  const malformedSnapshot = fixture(); malformedSnapshot.packs[0].catalogSnapshot = 'bad'; invalid(malformedSnapshot);
  const repeatedBytes = fixture(); repeatedBytes.packs[0].sourceHashes['alpha-two'] = repeatedBytes.packs[0].sourceHashes['alpha-one']; invalid(repeatedBytes);
  const normalized = normalizeStudyDraft(fixture());
  assert.deepEqual(Object.keys(normalized.packs[0].sourceHashes), normalized.packs[0].sourceIds);
});

test('v1 profile, collection, matrix, and resolved-prompt limits are strict', () => {
  for (const profiles of [[], [fixture().profiles[0], { ...fixture().profiles[0], id: 'second' }]]) invalid({ ...fixture(), profiles });
  for (const [key, value] of [['maxTurns', 41], ['maxActions', 0], ['maxPieces', 65], ['maxOutputTokens', 255], ['maxMinutes', 61]]) {
    const draft = fixture(); draft.profiles[0][key] = value; invalid(draft);
  }
  const missingLimit = fixture(); delete missingLimit.profiles[0].maxTurns; invalid(missingLimit);
  const tooManySources = fixture();
  tooManySources.packs[0].sourceIds = Array.from({ length: 25 }, (_, index) => `source-${index}`);
  tooManySources.packs[0].sourceHashes = Object.fromEntries(tooManySources.packs[0].sourceIds.map((id, index) => [id, index.toString(16).padStart(64, '0')]));
  invalid(tooManySources);
  const tooManyCells = fixture();
  tooManyCells.repetitions = 3;
  tooManyCells.models.push(
    { id: 'level-d', label: 'D', provider: 'openai', model: 'fixture.invalid/offcut-level-d' },
    { id: 'level-e', label: 'E', provider: 'openai', model: 'fixture.invalid/offcut-level-e' },
    { id: 'level-f', label: 'F', provider: 'openai', model: 'fixture.invalid/offcut-level-f' },
  );
  invalid(tooManyCells);
  const overlongPrompt = fixture();
  overlongPrompt.commonBrief = 'a'.repeat(10000);
  overlongPrompt.prompts[0].text = 'b'.repeat(1999);
  invalid(overlongPrompt);
  const longCommonBrief = fixture(); longCommonBrief.commonBrief = 'a'.repeat(10001); invalid(longCommonBrief);
  for (const repetitions of [0, 11, 1.5, '2']) invalid({ ...fixture(), repetitions });
});
