/** Reproducible material selection, shared by the browser preview and server. */
export const MATERIAL_SELECTION_VERSION = 1;
export const MATERIAL_SELECTION_ALGORITHM = 'offcut-fisher-yates-v1';

const FIELDS = ['version', 'algorithm', 'seed', 'catalogSnapshot', 'pinnedIds', 'candidateIds', 'randomCount'];
const SOURCE_ID = /^[a-zA-Z0-9_-]{1,100}$/;
const UINT32_RANGE = 0x100000000;

function fail(message) {
  throw Object.assign(new Error(message), { status: 400, code: 'INVALID_MATERIAL_SELECTION' });
}

function ids(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} must be an array of at most ${maximum} source IDs.`);
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== 'string' || !SOURCE_ID.test(id)) fail(`${label} must contain valid source IDs: 1–100 letters, numbers, underscores, or hyphens.`);
    if (seen.has(id)) fail(`${label} cannot contain duplicate source IDs.`);
    seen.add(id);
  }
  return [...value];
}

/** Validate the whole recipe and return an independent, canonical copy. */
export function normalizeMaterialSelection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Supply a material selection recipe.');
  if (Reflect.ownKeys(input).some(key => !FIELDS.includes(key)) || FIELDS.some(key => !Object.hasOwn(input, key))) {
    fail(`A material selection recipe must contain exactly these fields: ${FIELDS.join(', ')}.`);
  }
  if (input.version !== MATERIAL_SELECTION_VERSION) fail(`Material selection version must be ${MATERIAL_SELECTION_VERSION}.`);
  if (input.algorithm !== MATERIAL_SELECTION_ALGORITHM) fail(`Material selection algorithm must be ${MATERIAL_SELECTION_ALGORITHM}.`);
  if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed >= UINT32_RANGE) fail('Material selection seed must be an integer from 0 to 4294967295.');
  if (typeof input.catalogSnapshot !== 'string' || !/^[a-fA-F0-9]{64}$/.test(input.catalogSnapshot)) fail('Catalog snapshot must be a 64-digit hexadecimal hash.');
  const pinnedIds = ids(input.pinnedIds, 'Pinned images', 24);
  const candidateIds = ids(input.candidateIds, 'Candidate images', 10000).sort();
  if (!Number.isInteger(input.randomCount) || input.randomCount < 0 || input.randomCount > 24) fail('Random image count must be an integer from 0 to 24.');
  if (pinnedIds.length + input.randomCount < 1 || pinnedIds.length + input.randomCount > 24) fail('Pinned and random images together must total between 1 and 24.');
  const pinned = new Set(pinnedIds);
  const available = candidateIds.reduce((count, id) => count + (pinned.has(id) ? 0 : 1), 0);
  if (input.randomCount > available) {
    fail(`Requested ${input.randomCount} random images, but only ${available} are available after excluding pinned images. Reduce the random count or expand the candidate pool.`);
  }
  return {
    version: MATERIAL_SELECTION_VERSION,
    algorithm: MATERIAL_SELECTION_ALGORITHM,
    seed: input.seed >>> 0,
    catalogSnapshot: input.catalogSnapshot.toLowerCase(),
    pinnedIds,
    candidateIds,
    randomCount: input.randomCount,
  };
}

// These exact uint32 operations, descending shuffle order, and rejection rule
// define offcut-fisher-yates-v1. Changing them requires a new algorithm ID.
function mulberry32(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
}

function randomIndex(nextUint32, size) {
  // Discard the incomplete final bucket instead of biasing a modulo result.
  const limit = UINT32_RANGE - (UINT32_RANGE % size);
  let value;
  do { value = nextUint32(); } while (value >= limit);
  return value % size;
}

/** Return pins in insertion order, followed by the reproducible random draw. */
export function drawMaterialIds(input) {
  const recipe = normalizeMaterialSelection(input);
  const pool = recipe.candidateIds;
  const nextUint32 = mulberry32(recipe.seed);
  for (let index = pool.length - 1; index > 0; index--) {
    const other = randomIndex(nextUint32, index + 1);
    [pool[index], pool[other]] = [pool[other], pool[index]];
  }
  // Shuffle the full eligible pool first. Pinning one result then merely
  // removes it from the random order, preserving all other relative choices.
  const pinned = new Set(recipe.pinnedIds);
  const randomIds = pool.filter(id => !pinned.has(id)).slice(0, recipe.randomCount);
  return [...recipe.pinnedIds, ...randomIds];
}
