import {
  MATERIAL_SELECTION_ALGORITHM,
  MATERIAL_SELECTION_VERSION,
  drawMaterialIds,
} from './material-selection.mjs';

const UINT32_RANGE = 0x100000000;

function fail(message) {
  throw new Error(message);
}

function mixedSeed(seed, index) {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

/** Materialize reproducible random sets before a Study is frozen. */
export function drawStudyMaterialSets({
  sourceIds,
  pinnedIds = [],
  sourceCount,
  drawCount,
  seed,
  catalogSnapshot,
  maxSources = 24,
  maxDraws = 8,
} = {}) {
  if (!Array.isArray(sourceIds) || sourceIds.length < 1) fail('The source collection is empty.');
  if (!Array.isArray(pinnedIds)) fail('Pinned images must be an array.');
  if (!Number.isInteger(sourceCount) || sourceCount < 1 || sourceCount > maxSources) fail(`Images per set must be between 1 and ${maxSources}.`);
  if (!Number.isInteger(drawCount) || drawCount < 1 || drawCount > maxDraws) fail(`Random sets must be between 1 and ${maxDraws}.`);
  if (!Number.isInteger(seed) || seed < 0 || seed >= UINT32_RANGE) fail('Schedule seed must be an integer from 0 to 4294967295.');
  if (pinnedIds.length > sourceCount) fail(`The ${pinnedIds.length} selected pins exceed the ${sourceCount}-image set size.`);
  const available = new Set(sourceIds);
  if (pinnedIds.some(id => !available.has(id))) fail('A selected pin is not available in this collection.');
  if (sourceCount > sourceIds.length) fail(`Only ${sourceIds.length} eligible images are available for a ${sourceCount}-image set.`);

  return Array.from({ length: drawCount }, (_, index) => drawMaterialIds({
    version: MATERIAL_SELECTION_VERSION,
    algorithm: MATERIAL_SELECTION_ALGORITHM,
    seed: mixedSeed(seed, index),
    catalogSnapshot,
    pinnedIds,
    candidateIds: sourceIds,
    randomCount: sourceCount - pinnedIds.length,
  }));
}
