import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MATERIAL_SELECTION_VERSION,
  MATERIAL_SELECTION_ALGORITHM,
  normalizeMaterialSelection,
  drawMaterialIds,
} from '../public/material-selection.mjs';

const snapshot = 'ab12'.repeat(16);
const makeIds = length => Array.from({ length }, (_, index) => `source-${String(index).padStart(5, '0')}`);
const recipe = (patch = {}) => ({
  version: 1,
  algorithm: 'offcut-fisher-yates-v1',
  seed: 123456789,
  catalogSnapshot: snapshot,
  pinnedIds: [],
  candidateIds: makeIds(8),
  randomCount: 4,
  ...patch,
});
const badRecipe = input => {
  for (const operation of [normalizeMaterialSelection, drawMaterialIds]) {
    assert.throws(() => operation(input), error => error instanceof Error && error.status === 400 && error.code === 'INVALID_MATERIAL_SELECTION');
  }
};

test('the versioned recipe normalizes candidate order and hash while preserving pin order', () => {
  assert.equal(MATERIAL_SELECTION_VERSION, 1);
  assert.equal(MATERIAL_SELECTION_ALGORITHM, 'offcut-fisher-yates-v1');
  const input = recipe({ pinnedIds: ['z', 'outside-pool'], candidateIds: ['z', 'b', 'A', '_', 'a'], catalogSnapshot: snapshot.toUpperCase(), randomCount: 3 });
  assert.deepEqual(normalizeMaterialSelection(input), {
    version: 1,
    algorithm: 'offcut-fisher-yates-v1',
    seed: 123456789,
    catalogSnapshot: snapshot,
    pinnedIds: ['z', 'outside-pool'],
    candidateIds: ['A', '_', 'a', 'b', 'z'],
    randomCount: 3,
  });
  assert.equal(Object.is(normalizeMaterialSelection(recipe({ seed: -0 })).seed, -0), false);
});

test('known vectors pin uint32 Mulberry32 and descending Fisher–Yates behavior', () => {
  // Fixed expected values were also checked with an independent Python
  // uint32 implementation, rather than computed by the sampler under test.
  const vectors = [
    [0, [3, 1, 7, 6, 5, 4, 0, 2]],
    [1, [6, 0, 2, 7, 1, 5, 4, 3]],
    [0xffffffff, [0, 4, 5, 6, 1, 2, 7, 3]],
    [123456789, [2, 0, 5, 1, 3, 4, 7, 6]],
  ];
  const pool = makeIds(8);
  for (const [seed, indices] of vectors) {
    assert.deepEqual(drawMaterialIds(recipe({ seed, candidateIds: [...pool].reverse(), randomCount: 8 })), indices.map(index => pool[index]));
  }
});

test('a large-pool known vector covers rejection of biased final integer buckets', () => {
  // Seed 177 draws 4294962469 at shuffle index 8691. It must be rejected
  // for a bucket size of 8692; modulo-only mapping changes this sample.
  const indices = [2535, 2381, 68, 2555, 1721, 8873, 5498, 5803, 238, 1046, 6304, 1175, 827, 2002, 111, 5644, 9765, 6766, 8813, 9046, 2850, 1942, 4505, 797];
  const pool = makeIds(10000);
  assert.deepEqual(drawMaterialIds(recipe({ seed: 177, candidateIds: pool, randomCount: 24 })), indices.map(index => pool[index]));
});

test('normalization and drawing never mutate or retain mutable input arrays', () => {
  const input = recipe({ pinnedIds: ['outside'], candidateIds: makeIds(8).reverse() });
  const before = structuredClone(input);
  Object.freeze(input.pinnedIds);
  Object.freeze(input.candidateIds);
  Object.freeze(input);
  const normalized = normalizeMaterialSelection(input);
  const first = drawMaterialIds(input);
  assert.deepEqual(drawMaterialIds(input), first);
  assert.deepEqual(input, before);
  normalized.pinnedIds.push('new-pin');
  normalized.candidateIds.reverse();
  first.reverse();
  assert.deepEqual(input, before);
  assert.deepEqual(normalizeMaterialSelection(normalizeMaterialSelection(input)), normalizeMaterialSelection(input));
});

test('catalog permutations do not change a draw and changing only the snapshot does not reseed it', () => {
  const pool = makeIds(80);
  const input = recipe({ candidateIds: pool, randomCount: 24 });
  const expected = drawMaterialIds(input);
  for (const candidateIds of [pool, [...pool].reverse(), [...pool.slice(31), ...pool.slice(0, 31)]]) {
    assert.deepEqual(drawMaterialIds({ ...input, candidateIds }), expected);
  }
  assert.deepEqual(drawMaterialIds({ ...input, catalogSnapshot: '0'.repeat(64) }), expected);
  assert.notDeepEqual(drawMaterialIds({ ...input, seed: input.seed + 1 }), expected);
  assert.equal(new Set(expected).size, 24);
  assert.ok(expected.every(id => pool.includes(id)));
});

test('changing the requested random count extends or shortens the same draw prefix', () => {
  const input = recipe({ candidateIds: makeIds(50), pinnedIds: ['outside', 'source-00004'], randomCount: 22 });
  const complete = drawMaterialIds(input);
  for (let randomCount = 0; randomCount <= 22; randomCount++) {
    assert.deepEqual(drawMaterialIds({ ...input, randomCount }), complete.slice(0, 2 + randomCount));
  }
});

test('pinning sampled images removes them from the existing shuffled order and draws replacements', () => {
  const input = recipe({ candidateIds: makeIds(20), randomCount: 20 });
  const shuffled = drawMaterialIds(input);
  const pinnedIds = [shuffled[3], shuffled[0], 'outside'];
  const expectedExtras = shuffled.filter(id => !pinnedIds.includes(id)).slice(0, 10);
  assert.deepEqual(drawMaterialIds({ ...input, pinnedIds, randomCount: 10 }), [...pinnedIds, ...expectedExtras]);
  const reorderedPins = [...pinnedIds].reverse();
  assert.deepEqual(drawMaterialIds({ ...input, pinnedIds: reorderedPins, randomCount: 10 }), [...reorderedPins, ...expectedExtras]);
});

test('a pin outside the candidate pool leaves the random draw unchanged', () => {
  const input = recipe({ candidateIds: makeIds(60), randomCount: 8 });
  const randomIds = drawMaterialIds(input);
  assert.deepEqual(drawMaterialIds({ ...input, pinnedIds: ['outside'] }), ['outside', ...randomIds]);
});

test('manual-only recipes need no candidate pool and maintain the chosen pin order', () => {
  const pinnedIds = ['second', 'first'];
  assert.deepEqual(drawMaterialIds(recipe({ pinnedIds, candidateIds: [], randomCount: 0 })), pinnedIds);
  assert.deepEqual(drawMaterialIds(recipe({ pinnedIds, candidateIds: ['second', 'first'], randomCount: 0 })), pinnedIds);
  assert.deepEqual(drawMaterialIds(recipe({ pinnedIds: makeIds(24), candidateIds: [], randomCount: 0 })), makeIds(24));
});

test('random-only sampling can select the whole pool without duplicates', () => {
  const candidateIds = makeIds(24);
  const selected = drawMaterialIds(recipe({ pinnedIds: [], candidateIds, randomCount: 24 }));
  assert.equal(selected.length, 24);
  assert.equal(new Set(selected).size, 24);
  assert.deepEqual([...selected].sort(), candidateIds);
});

test('an insufficient unpinned pool is rejected without silently reducing the count', () => {
  const input = recipe({ pinnedIds: ['a', 'outside'], candidateIds: ['a', 'b', 'c'], randomCount: 3 });
  const before = structuredClone(input);
  for (const operation of [normalizeMaterialSelection, drawMaterialIds]) {
    assert.throws(() => operation(input), error => error.status === 400 && /Requested 3 random images, but only 2/.test(error.message));
  }
  assert.deepEqual(input, before);
  assert.deepEqual(drawMaterialIds({ ...input, randomCount: 2 }).slice(0, 2), ['a', 'outside']);
  badRecipe(recipe({ pinnedIds: ['only'], candidateIds: ['only'], randomCount: 1 }));
  badRecipe(recipe({ candidateIds: [], randomCount: 1 }));
});

test('recipes require the exact field set, supported version and algorithm, and a snapshot hash', () => {
  for (const input of [null, undefined, false, [], 'recipe', 1, () => {}]) badRecipe(input);
  for (const field of Object.keys(recipe())) {
    const missing = recipe(); delete missing[field]; badRecipe(missing);
  }
  badRecipe(Object.create(recipe()));
  badRecipe({ ...recipe(), extra: true });
  badRecipe({ ...recipe(), [Symbol('extra')]: true });
  for (const version of [0, 2, '1', null]) badRecipe(recipe({ version }));
  for (const algorithm of ['fisher-yates', 'offcut-fisher-yates-v2', '', null]) badRecipe(recipe({ algorithm }));
  for (const catalogSnapshot of ['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), '0x' + 'a'.repeat(62), null, 123]) {
    badRecipe(recipe({ catalogSnapshot }));
  }
});

test('seeds must be explicit unsigned 32-bit integers', () => {
  for (const seed of [-1, 1.5, 0x100000000, Number.MAX_SAFE_INTEGER, Infinity, NaN, '1', null, undefined, true]) {
    badRecipe(recipe({ seed }));
  }
  for (const seed of [0, 1, 0xffffffff]) assert.equal(normalizeMaterialSelection(recipe({ seed })).seed, seed);
});

test('pin and candidate IDs use bounded unique source identifiers', () => {
  for (const key of ['pinnedIds', 'candidateIds']) {
    for (const value of [null, {}, 'source', [1], [null], [''], [' '], ['a/b'], ['a.b'], ['a'.repeat(101)], ['same', 'same'], Array(1)]) {
      badRecipe(recipe({ [key]: value }));
    }
  }
  assert.deepEqual(drawMaterialIds(recipe({ pinnedIds: ['x'.repeat(100), '_A-09'], candidateIds: [], randomCount: 0 })), ['x'.repeat(100), '_A-09']);
  assert.equal(normalizeMaterialSelection(recipe({ candidateIds: ['A', 'a', 'B', 'b'], randomCount: 4 })).candidateIds.length, 4);
});

test('recipe size and requested image count stay within explicit bounds', () => {
  badRecipe(recipe({ pinnedIds: makeIds(25), randomCount: 0 }));
  badRecipe(recipe({ candidateIds: makeIds(10001) }));
  for (const randomCount of [-1, 25, 0.5, NaN, Infinity, '2', null]) badRecipe(recipe({ randomCount }));
  badRecipe(recipe({ pinnedIds: [], randomCount: 0 }));
  badRecipe(recipe({ pinnedIds: ['outside'], candidateIds: makeIds(24), randomCount: 24 }));
  assert.equal(drawMaterialIds(recipe({ candidateIds: makeIds(200), randomCount: 24 })).length, 24);
});
