import test from 'node:test';
import assert from 'node:assert/strict';
import { planBatch, normalizeBatchPlan, BATCH_LIMITS, BATCH_SEED_ALGORITHM } from '../public/batch-plan.mjs';
import { drawMaterialIds } from '../public/material-selection.mjs';

const recipe = {
  version: 1, algorithm: 'offcut-fisher-yates-v1', seed: 123, catalogSnapshot: 'a'.repeat(64),
  pinnedIds: [], candidateIds: Array.from({ length: 30 }, (_, index) => `photo-${index}`), randomCount: 6,
};
const setup = overrides => ({ groups: [{ model: 'first', count: 3 }, { model: 'second', count: 2 }], mode: 'explore', materials: 'random', materialSelection: recipe, ...overrides });

test('Explore uses independent deterministic seeds and preserves the reviewed first draw', () => {
  const plan = planBatch(setup());
  assert.equal(plan.seedAlgorithm, BATCH_SEED_ALGORITHM);
  assert.equal(plan.totalRuns, 5);
  assert.deepEqual(plan.entries.map(entry => [entry.index, entry.groupIndex, entry.runIndex]), [[0, 0, 0], [1, 0, 1], [2, 0, 2], [3, 1, 0], [4, 1, 1]]);
  assert.deepEqual(plan.entries.map(entry => entry.seed), [123, 2654435892, 1013904365, 3668340134, 2027808607]);
  assert.deepEqual(plan.entries[0].sourceIds, drawMaterialIds(recipe));
  assert.deepEqual(plan, planBatch(setup()));
  assert.equal(new Set(plan.entries.map(entry => entry.seed)).size, 5);
});

test('Compare matches each ordinal across models and allows unequal group counts', () => {
  const plan = planBatch(setup({ mode: 'compare' }));
  assert.deepEqual(plan.entries[0].sourceIds, plan.entries[3].sourceIds);
  assert.deepEqual(plan.entries[1].sourceIds, plan.entries[4].sourceIds);
  assert.equal(plan.entries[2].runIndex, 2);
  assert.notEqual(plan.entries[2].seed, plan.entries[1].seed);
});

test('Same freezes the reviewed selection for every entry, including manual-only materials', () => {
  for (const mode of ['explore', 'compare']) {
    const manual = { ...recipe, pinnedIds: ['photo-9', 'photo-3'], candidateIds: [], randomCount: 0 };
    const plan = planBatch(setup({ mode, materials: 'same', materialSelection: manual }));
    for (const entry of plan.entries) {
      assert.deepEqual(entry.sourceIds, manual.pinnedIds);
      assert.equal(entry.seed, manual.seed);
    }
  }
});

test('Fresh extras keep pins in insertion order, exclude them from the draw, and never duplicate', () => {
  const pinned = { ...recipe, pinnedIds: ['outside-pool', 'photo-4'], randomCount: 4 };
  const plan = planBatch(setup({ materials: 'pinned-random', materialSelection: pinned }));
  for (const entry of plan.entries) {
    assert.deepEqual(entry.sourceIds.slice(0, 2), pinned.pinnedIds);
    assert.equal(entry.sourceIds.length, 6);
    assert.equal(new Set(entry.sourceIds).size, 6);
    assert.deepEqual(entry.sourceIds, drawMaterialIds({ ...pinned, seed: entry.seed }));
  }
});

test('A plan is detached from its inputs and previews do not mutate seeds or pool order', () => {
  const input = structuredClone(setup());
  const before = structuredClone(input);
  const plan = planBatch(input);
  assert.deepEqual(input, before);
  input.groups[0].count = 1;
  input.materialSelection.pinnedIds.push('changed');
  assert.equal(plan.groups[0].count, 3);
  assert.deepEqual(plan.materialSelection.pinnedIds, []);
  assert.notEqual(plan.entries[0].sourceIds, plan.entries[1].sourceIds);
});

test('Plan constraints reject impossible modes, counts, models, duplicate or insufficient materials', () => {
  const invalid = [
    { mode: 'anything' }, { materials: 'anything' }, { groups: [] },
    { groups: Array.from({ length: 9 }, () => ({ model: 'a', count: 1 })) },
    { groups: [{ model: 'a', count: 0 }] }, { groups: [{ model: 'a', count: 1.5 }] },
    { groups: [{ model: 'a', count: 50 }, { model: 'b', count: 1 }] },
    { groups: [{ model: 'a b', count: 1 }] }, { groups: [{ model: 'a', count: 1, key: 'secret' }] },
    { materials: 'random', materialSelection: { ...recipe, pinnedIds: ['photo-1'] } },
    { materials: 'pinned-random' },
    { materials: 'pinned-random', materialSelection: { ...recipe, pinnedIds: ['photo-1'], randomCount: 0 } },
    { materialSelection: { ...recipe, candidateIds: ['one'], randomCount: 2 } },
    { materialSelection: { ...recipe, candidateIds: ['one', 'one'] } },
    { unsupported: 'secret' },
  ];
  for (const settings of invalid) assert.throws(() => normalizeBatchPlan(setup(settings)), error => error.status === 400);
  assert.deepEqual(BATCH_LIMITS, { maxGroups: 8, maxRunsPerGroup: 50, maxRuns: 50 });
});

test('All 50 slots remain distinct at uint32 seed boundaries; a small pool may legitimately repeat sets', () => {
  for (const seed of [0, 0xffffffff]) {
    const plan = planBatch(setup({ groups: [{ model: 'a', count: 50 }], materialSelection: { ...recipe, seed, candidateIds: ['only'], randomCount: 1 } }));
    assert.equal(new Set(plan.entries.map(entry => entry.seed)).size, 50);
    assert.ok(plan.entries.every(entry => entry.sourceIds[0] === 'only'));
    assert.ok(plan.entries.every(entry => Number.isInteger(entry.seed) && entry.seed >= 0 && entry.seed <= 0xffffffff));
  }
});
