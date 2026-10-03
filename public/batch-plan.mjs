import { normalizeMaterialSelection, drawMaterialIds } from './material-selection.mjs';

export const BATCH_PLAN_VERSION = 1;
export const BATCH_SEED_ALGORITHM = 'offcut-batch-seeds-v1';
export const BATCH_LIMITS = Object.freeze({ maxGroups: 8, maxRunsPerGroup: 50, maxRuns: 50 });

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(message) { throw Object.assign(new Error(message), { status: 400, code: 'INVALID_BATCH_PLAN' }); }

/** Only scheduling and materials live here; provider budgets are validated server-side. */
export function normalizeBatchPlan(input) {
  const fields = ['groups', 'mode', 'materials', 'materialSelection'];
  if (!object(input) || Reflect.ownKeys(input).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(input, key))) {
    fail('A batch plan requires only groups, mode, materials, and materialSelection.');
  }
  if (!['explore', 'compare'].includes(input.mode)) fail('Choose Explore or Compare models.');
  if (!['same', 'random', 'pinned-random'].includes(input.materials)) fail('Choose the same images, fresh random images, or pins with fresh random images.');
  if (!Array.isArray(input.groups) || input.groups.length < 1 || input.groups.length > BATCH_LIMITS.maxGroups) fail('Choose between 1 and 8 model groups.');
  const groups = Array.from(input.groups, group => {
    if (!object(group) || Reflect.ownKeys(group).length !== 2 || !Object.hasOwn(group, 'model') || !Object.hasOwn(group, 'count')) fail('Each model group needs only model and count.');
    if (typeof group.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(group.model)) fail('Choose a valid model identifier for every group.');
    if (!Number.isInteger(group.count) || group.count < 1 || group.count > BATCH_LIMITS.maxRunsPerGroup) fail('Each model group needs between 1 and 50 runs.');
    return { model: group.model, count: group.count };
  });
  if (groups.reduce((sum, group) => sum + group.count, 0) > BATCH_LIMITS.maxRuns) fail('A batch can contain at most 50 runs in total.');
  const materialSelection = normalizeMaterialSelection(input.materialSelection);
  if (input.materials === 'random' && materialSelection.pinnedIds.length) fail('Fresh random images requires no pins. Unpin these images or choose pins with fresh random images.');
  if (input.materials === 'pinned-random' && (!materialSelection.pinnedIds.length || !materialSelection.randomCount)) fail('Pins with fresh random images needs at least one pinned image and one random image.');
  return { groups, mode: input.mode, materials: input.materials, materialSelection };
}

/** The odd increment is bijective modulo 2^32; distinct slots never share a seed. */
export function planBatch(input) {
  const plan = normalizeBatchPlan(input);
  const entries = [];
  for (const [groupIndex, group] of plan.groups.entries()) {
    for (let runIndex = 0; runIndex < group.count; runIndex++) {
      const index = entries.length;
      const slot = plan.materials === 'same' ? 0 : plan.mode === 'compare' ? runIndex : index;
      const seed = (plan.materialSelection.seed + Math.imul(slot, 0x9e3779b9)) >>> 0;
      entries.push({ index, groupIndex, runIndex, model: group.model, seed, sourceIds: drawMaterialIds({ ...plan.materialSelection, seed }) });
    }
  }
  return { version: BATCH_PLAN_VERSION, seedAlgorithm: BATCH_SEED_ALGORITHM, ...plan, totalRuns: entries.length, entries };
}
