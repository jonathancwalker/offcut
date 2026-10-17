import { normalizeRunLimits, normalizeSpec } from './run-spec.mjs';

export const STUDY_DRAFT_VERSION = 1;
export const STUDY_ORDER_ALGORITHM = 'offcut-study-order-v1';
export const STUDY_PACK_ALGORITHM = 'offcut-study-pack-v1';
export const STUDY_CONTENT_ALGORITHM = 'offcut-study-content-v1';
export const DEFAULT_STUDY_COMMON_BRIEF = 'Create an original collage from the provided source images. There is no target image. Give the finished work a title and a short statement.';
export const DEFAULT_STUDY_REPETITIONS = 2;
export const DEFAULT_STUDY_SOURCES_PER_PACK = 6;
export const STANDARD_STUDY_PROFILE = Object.freeze({
  id: 'standard',
  label: 'Standard',
  maxTurns: 12,
  maxActions: 120,
  maxPieces: 24,
  maxOutputTokens: 4096,
  maxMinutes: 10,
});
export const DEFAULT_STUDY_PROMPTS = Object.freeze([
  Object.freeze({ id: 'ai-portrait', label: 'AI portrait', text: 'Make a portrait of an AI assistant.' }),
  Object.freeze({ id: 'self-portrait', label: 'Self-portrait', text: 'Make a portrait of yourself as an AI assistant.' }),
  Object.freeze({ id: 'experience-framing', label: 'Experience framing', text: 'Make a portrait of what it feels like to be you as an AI assistant.' }),
]);
export const STUDY_LIMITS = Object.freeze({
  maxPrompts: 6,
  maxModels: 8,
  maxPacks: 8,
  maxSourcesPerPack: 24,
  maxRepetitions: 10,
  maxProfiles: 1,
  maxCells: 100,
});

const DRAFT_FIELDS = ['version', 'label', 'kind', 'seed', 'commonBrief', 'prompts', 'models', 'packs', 'repetitions', 'profiles', 'notePolicy'];
const PROMPT_FIELDS = ['id', 'label', 'text'];
const MODEL_FIELDS = ['id', 'label', 'provider', 'model'];
const PACK_FIELDS = ['id', 'label', 'catalogSnapshot', 'sourceIds', 'sourceHashes'];
const PROFILE_FIELDS = ['id', 'label', 'maxTurns', 'maxActions', 'maxPieces', 'maxOutputTokens', 'maxMinutes'];
const SLUG = /^[a-z][a-z0-9-]{0,39}$/;
const SOURCE_ID = /^[a-zA-Z0-9_-]{1,100}$/;
const HASH = /^[a-fA-F0-9]{64}$/;
const UINT32_RANGE = 0x100000000;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function fail(message) {
  throw Object.assign(new Error(message), { status: 400, code: 'INVALID_STUDY_DRAFT' });
}

function exactObject(input, fields, message) {
  if (!object(input)
    || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !fields.includes(key))
    || fields.some(key => !Object.hasOwn(input, key))) fail(message);
}

function boundedText(value, label, maximum) {
  if (typeof value !== 'string') fail(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) fail(`${label} must contain 1–${maximum} characters.`);
  return normalized;
}

function slug(value, label) {
  if (typeof value !== 'string' || !SLUG.test(value)) fail(`${label} must be a lowercase slug of 1–40 letters, numbers, or hyphens, starting with a letter.`);
  return value;
}

function unique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) fail(`${label} must be unique.`);
    seen.add(value);
  }
}

function collection(input, label, minimum, maximum, normalize) {
  if (!Array.isArray(input) || input.length < minimum || input.length > maximum) fail(`${label} must contain ${minimum}–${maximum} entries.`);
  return Array.from(input, normalize);
}

function normalizePrompt(input) {
  exactObject(input, PROMPT_FIELDS, 'Each prompt must contain only id, label, and text.');
  return {
    id: slug(input.id, 'Prompt ID'),
    label: boundedText(input.label, 'Prompt label', 120),
    text: boundedText(input.text, 'Prompt text', 12000),
  };
}

function normalizeModel(input) {
  exactObject(input, MODEL_FIELDS, 'Each model must contain only id, label, provider, and model.');
  const id = slug(input.id, 'Model ID');
  const label = boundedText(input.label, 'Model label', 120);
  try {
    const spec = normalizeSpec({ provider: input.provider, model: input.model, prompt: 'Study route validation.' });
    return { id, label, provider: spec.provider, model: spec.model };
  } catch (error) {
    fail(error.message);
  }
}

function normalizePack(input) {
  exactObject(input, PACK_FIELDS, 'Each source pack must contain only id, label, catalogSnapshot, sourceIds, and sourceHashes.');
  const id = slug(input.id, 'Source-pack ID');
  const label = boundedText(input.label, 'Source-pack label', 120);
  if (typeof input.catalogSnapshot !== 'string' || !HASH.test(input.catalogSnapshot)) fail('Each source pack needs a 64-digit hexadecimal catalog snapshot hash.');
  if (!Array.isArray(input.sourceIds) || input.sourceIds.length < 1 || input.sourceIds.length > STUDY_LIMITS.maxSourcesPerPack) {
    fail(`Each source pack must contain 1–${STUDY_LIMITS.maxSourcesPerPack} ordered source IDs.`);
  }
  const sourceIds = Array.from(input.sourceIds, sourceId => {
    if (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId)) fail('Source IDs must contain 1–100 letters, numbers, underscores, or hyphens.');
    return sourceId;
  });
  unique(sourceIds, sourceId => sourceId, 'Source IDs within a pack');
  if (!object(input.sourceHashes)
    || Reflect.ownKeys(input.sourceHashes).some(key => typeof key !== 'string')
    || Reflect.ownKeys(input.sourceHashes).length !== sourceIds.length
    || sourceIds.some(sourceId => !Object.hasOwn(input.sourceHashes, sourceId))
    || Reflect.ownKeys(input.sourceHashes).some(sourceId => !sourceIds.includes(sourceId))) {
    fail('Each source pack must map exactly its selected source IDs to hashes.');
  }
  const sourceHashes = Object.fromEntries(sourceIds.map(sourceId => {
    const value = input.sourceHashes[sourceId];
    if (typeof value !== 'string' || !HASH.test(value)) fail(`Source ${sourceId} must have a 64-digit hexadecimal SHA-256 hash.`);
    return [sourceId, value.toLowerCase()];
  }));
  unique(Object.values(sourceHashes), value => value, 'Source image hashes within a pack');
  return { id, label, catalogSnapshot: input.catalogSnapshot.toLowerCase(), sourceIds, sourceHashes };
}

function normalizeProfile(input) {
  exactObject(input, PROFILE_FIELDS, `The v1 resource profile must contain only ${PROFILE_FIELDS.join(', ')}.`);
  const id = slug(input.id, 'Profile ID');
  const label = boundedText(input.label, 'Profile label', 120);
  let limits;
  try { limits = normalizeRunLimits(input, { requireAll: true }); }
  catch (error) { fail(error.message); }
  return { id, label, ...limits };
}

/** Validate a complete v1 draft and return a detached, normalized copy. */
export function normalizeStudyDraft(draft) {
  exactObject(draft, DRAFT_FIELDS, `A study draft must contain exactly these fields: ${DRAFT_FIELDS.join(', ')}.`);
  if (draft.version !== STUDY_DRAFT_VERSION) fail(`Study draft version must be ${STUDY_DRAFT_VERSION}.`);
  const label = boundedText(draft.label, 'Study label', 120);
  if (!['calibration', 'primary'].includes(draft.kind)) fail('Study kind must be calibration or primary.');
  if (!Number.isInteger(draft.seed) || draft.seed < 0 || draft.seed >= UINT32_RANGE) fail('Study seed must be an integer from 0 to 4294967295.');
  const commonBrief = boundedText(draft.commonBrief, 'Common brief', 10000);
  const prompts = collection(draft.prompts, 'Prompts', 1, STUDY_LIMITS.maxPrompts, normalizePrompt);
  const models = collection(draft.models, 'Models', 1, STUDY_LIMITS.maxModels, normalizeModel);
  const packs = collection(draft.packs, 'Source packs', 1, STUDY_LIMITS.maxPacks, normalizePack);
  if (!Number.isInteger(draft.repetitions) || draft.repetitions < 1 || draft.repetitions > STUDY_LIMITS.maxRepetitions) {
    fail(`Repetitions must be an integer from 1 to ${STUDY_LIMITS.maxRepetitions}.`);
  }
  const profiles = collection(draft.profiles, 'Profiles', 1, STUDY_LIMITS.maxProfiles, normalizeProfile);
  if (draft.notePolicy !== 'short-v1') fail('Study notePolicy must be short-v1.');
  unique(prompts, prompt => prompt.id, 'Prompt IDs');
  unique(models, model => model.id, 'Model IDs');
  unique(models, model => `${model.provider}\n${model.model}`, 'Model routes');
  unique(packs, pack => pack.id, 'Source-pack IDs');
  unique(profiles, profile => profile.id, 'Profile IDs');
  for (const prompt of prompts) {
    const resolved = `${commonBrief}\n\n${prompt.text}`;
    if (resolved.length > 12000) fail(`Resolved prompt ${prompt.id} exceeds 12000 characters.`);
  }
  const cells = models.length * prompts.length * packs.length * draft.repetitions * profiles.length;
  if (cells > STUDY_LIMITS.maxCells) fail(`A v1 study can contain at most ${STUDY_LIMITS.maxCells} cells.`);
  return {
    version: STUDY_DRAFT_VERSION,
    label,
    kind: draft.kind,
    seed: draft.seed >>> 0,
    commonBrief,
    prompts,
    models,
    packs,
    repetitions: draft.repetitions,
    profiles,
    notePolicy: 'short-v1',
  };
}

function canonicalJSON(value) {
  const active = new Set();
  const encode = item => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('Canonical JSON does not support nonfinite numbers.');
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      if (active.has(item)) throw new TypeError('Canonical JSON does not support circular values.');
      active.add(item);
      const output = `[${item.map(entry => {
        if (entry === undefined) throw new TypeError('Canonical JSON does not support undefined.');
        return encode(entry);
      }).join(',')}]`;
      active.delete(item);
      return output;
    }
    if (object(item)) {
      if (active.has(item)) throw new TypeError('Canonical JSON does not support circular values.');
      active.add(item);
      const keys = Reflect.ownKeys(item);
      if (keys.some(key => typeof key !== 'string')) throw new TypeError('Canonical JSON supports only string object keys.');
      const output = `{${keys.sort(compare).map(key => {
        if (item[key] === undefined) throw new TypeError('Canonical JSON does not support undefined.');
        return `${JSON.stringify(key)}:${encode(item[key])}`;
      }).join(',')}}`;
      active.delete(item);
      return output;
    }
    throw new TypeError(`Canonical JSON does not support ${typeof item}.`);
  };
  return encode(value);
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(canonicalJSON(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

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
  const limit = UINT32_RANGE - (UINT32_RANGE % size);
  let value;
  do { value = nextUint32(); } while (value >= limit);
  return value % size;
}

function shuffledCellIds(cells, seed) {
  const ids = cells.map(cell => cell.cellId).sort(compare);
  const nextUint32 = mulberry32(seed);
  for (let index = ids.length - 1; index > 0; index--) {
    const other = randomIndex(nextUint32, index + 1);
    [ids[index], ids[other]] = [ids[other], ids[index]];
  }
  return ids;
}

/** Build stable cells and a reproducible execution order without external I/O. */
export async function planStudy(draft) {
  const normalizedDraft = normalizeStudyDraft(draft);
  const packIdentities = await Promise.all(normalizedDraft.packs.map(async pack => {
    const orderedSources = pack.sourceIds.map(id => ({ id, sha256: pack.sourceHashes[id] }));
    return {
      packId: pack.id,
      sourcePackHash: await sha256({ algorithm: STUDY_PACK_ALGORITHM, catalogSnapshot: pack.catalogSnapshot, sources: orderedSources }),
      contentOnlyPackHash: await sha256({ algorithm: STUDY_CONTENT_ALGORITHM, sha256: orderedSources.map(source => source.sha256) }),
    };
  }));
  packIdentities.sort((left, right) => compare(left.packId, right.packId));
  const packIdentityById = new Map(packIdentities.map(identity => [identity.packId, identity]));
  const unresolved = [];
  for (const model of normalizedDraft.models) {
    for (const prompt of normalizedDraft.prompts) {
      const resolvedPrompt = `${normalizedDraft.commonBrief}\n\n${prompt.text}`;
      for (const pack of normalizedDraft.packs) {
        for (let repetition = 1; repetition <= normalizedDraft.repetitions; repetition++) {
          for (const profile of normalizedDraft.profiles) {
            const identity = {
              modelId: model.id,
              promptId: prompt.id,
              packId: pack.id,
              repetition,
              profileId: profile.id,
              notePolicy: normalizedDraft.notePolicy,
            };
            unresolved.push({ identity, model, pack, profile, resolvedPrompt });
          }
        }
      }
    }
  }
  const cells = await Promise.all(unresolved.map(async ({ identity, model, pack, profile, resolvedPrompt }) => ({
    cellId: `cell-${await sha256(identity)}`,
    ...identity,
    spec: normalizeSpec({ provider: model.provider, model: model.model, prompt: resolvedPrompt, ...normalizeRunLimits(profile, { requireAll: true }) }),
    catalogSnapshot: pack.catalogSnapshot,
    sourceIds: [...pack.sourceIds],
    sourceHashes: { ...pack.sourceHashes },
    sourcePackHash: packIdentityById.get(pack.id).sourcePackHash,
    contentOnlyPackHash: packIdentityById.get(pack.id).contentOnlyPackHash,
  })));
  cells.sort((left, right) => compare(left.cellId, right.cellId));
  const executionOrder = shuffledCellIds(cells, normalizedDraft.seed);
  return {
    version: STUDY_DRAFT_VERSION,
    orderAlgorithm: STUDY_ORDER_ALGORITHM,
    normalizedDraft,
    dimensions: {
      modelIds: normalizedDraft.models.map(model => model.id).sort(compare),
      promptIds: normalizedDraft.prompts.map(prompt => prompt.id).sort(compare),
      packIds: normalizedDraft.packs.map(pack => pack.id).sort(compare),
      repetitions: Array.from({ length: normalizedDraft.repetitions }, (_, index) => index + 1),
      profileIds: normalizedDraft.profiles.map(profile => profile.id).sort(compare),
    },
    counts: {
      models: normalizedDraft.models.length,
      prompts: normalizedDraft.prompts.length,
      packs: normalizedDraft.packs.length,
      repetitions: normalizedDraft.repetitions,
      profiles: normalizedDraft.profiles.length,
      cells: cells.length,
    },
    packIdentities,
    cells,
    executionOrder,
  };
}
