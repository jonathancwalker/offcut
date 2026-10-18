import assert from 'node:assert/strict';
import test from 'node:test';
import { drawStudyMaterialSets } from '../public/study-materials.mjs';

const sourceIds = Array.from({ length: 40 }, (_, index) => `source-${index + 1}`);
const catalogSnapshot = 'a'.repeat(64);

test('matched Study material draws are deterministic and preserve pins', () => {
  const input = {
    sourceIds,
    pinnedIds: ['source-2', 'source-7'],
    sourceCount: 12,
    drawCount: 4,
    seed: 17,
    catalogSnapshot,
  };
  const first = drawStudyMaterialSets(input);
  const second = drawStudyMaterialSets(input);
  assert.deepEqual(first, second);
  assert.equal(first.length, 4);
  for (const draw of first) {
    assert.equal(draw.length, 12);
    assert.deepEqual(draw.slice(0, 2), input.pinnedIds);
    assert.equal(new Set(draw).size, draw.length);
  }
  assert.ok(new Set(first.map(draw => draw.join('\n'))).size > 1);
});

test('matched Study material draws enforce the engine limits', () => {
  assert.throws(() => drawStudyMaterialSets({ sourceIds, sourceCount: 25, drawCount: 1, seed: 1, catalogSnapshot }), /between 1 and 24/);
  assert.throws(() => drawStudyMaterialSets({ sourceIds, pinnedIds: sourceIds.slice(0, 7), sourceCount: 6, drawCount: 1, seed: 1, catalogSnapshot }), /pins exceed/);
  assert.throws(() => drawStudyMaterialSets({ sourceIds: sourceIds.slice(0, 4), sourceCount: 6, drawCount: 1, seed: 1, catalogSnapshot }), /Only 4 eligible/);
});
