import { mkdir, readdir, readFile, rename, open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const STAGES = Object.freeze(['image_only', 'sources_revealed', 'trace_revealed']);
const STAGE_SET = new Set(STAGES);
const STUDY_ID = /^study-[a-f0-9-]{36}$/;
const HASH = /^[a-f0-9]{64}$/;
const CELL_ID = /^cell-[a-f0-9]{64}$/;
const DISPLAY_ID = /^view-[a-z0-9-]{20,80}$/;
const MAX_NOTES = 20_000;
const MAX_EVIDENCE = 100;
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nowISO = () => new Date().toISOString();

function fail(message, status = 400, code = 'ANNOTATION_INVALID') {
  throw Object.assign(new Error(message), { status, code });
}
function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
}
function jsonSize(value, label, maxBytes) {
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(value)); } catch { fail(`${label} must be valid JSON.`); }
  if (bytes > maxBytes) fail(`${label} is too large.`);
  return clone(value);
}
function rectangle(value) {
  if (!object(value) || Reflect.ownKeys(value).some(key => !['x', 'y', 'width', 'height'].includes(key))
    || !['x', 'y', 'width', 'height'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]))) {
    fail('Evidence regions require normalized x, y, width, and height numbers.');
  }
  if (value.x < 0 || value.y < 0 || value.width <= 0 || value.height <= 0 || value.x + value.width > 1 || value.y + value.height > 1) {
    fail('Evidence regions must fit within normalized 0–1 image coordinates.');
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}
function normalizeEvidence(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE) fail(`Evidence must contain at most ${MAX_EVIDENCE} items.`);
  return value.map((item, index) => {
    if (!object(item)) fail(`Evidence item ${index + 1} must be an object.`);
    const allowed = ['region', 'eventSequence', 'statementExcerpt'];
    if (Reflect.ownKeys(item).some(key => !allowed.includes(key)) || !Object.hasOwn(item, 'region')) fail('Each evidence item requires only a region and an optional event sequence or statement excerpt.');
    const result = { region: rectangle(item.region) };
    if (item.eventSequence !== undefined) {
      if (!Number.isSafeInteger(item.eventSequence) || item.eventSequence < 0) fail('Evidence eventSequence must be a non-negative integer.');
      result.eventSequence = item.eventSequence;
    }
    if (item.statementExcerpt !== undefined) result.statementExcerpt = text(item.statementExcerpt, 'Evidence statementExcerpt', 2_000);
    if (result.eventSequence === undefined && result.statementExcerpt === undefined) fail('Each evidence item must identify an event sequence or statement excerpt.');
    if (result.eventSequence !== undefined && result.statementExcerpt !== undefined) fail('Each evidence item must identify an event sequence or statement excerpt, not both.');
    return result;
  });
}
function normalizeInput(input) {
  if (!object(input)) fail('An annotation object is required.');
  const allowed = ['displayId', 'cellId', 'expectedRevision', 'rubricVersion', 'stage', 'codes', 'uncertainty', 'evidence', 'notes'];
  if (Reflect.ownKeys(input).some(key => !allowed.includes(key))) fail(`Annotations may contain only ${allowed.join(', ')}.`);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('expectedRevision must be a non-negative integer.');
  if (!STAGE_SET.has(input.stage)) fail(`stage must be one of: ${STAGES.join(', ')}.`);
  const rubricVersion = text(input.rubricVersion, 'rubricVersion', 200);
  if (input.codes !== undefined && (!Array.isArray(input.codes) || input.codes.length > 100 || input.codes.some(code => typeof code !== 'string' || !code.trim() || code.length > 200))) fail('codes must be an array of short strings.');
  const codes = input.codes === undefined ? [] : input.codes.map(code => code.trim());
  let uncertainty = input.uncertainty;
  if (uncertainty === undefined) uncertainty = null;
  else uncertainty = jsonSize(uncertainty, 'uncertainty', 20_000);
  const notes = input.notes === undefined ? '' : text(input.notes, 'notes', MAX_NOTES);
  return { rubricVersion, stage: input.stage, codes, uncertainty, evidence: normalizeEvidence(input.evidence), notes };
}
function seedFor() { return randomBytes(4).readUInt32BE(0); }
function opaqueId() { return `view-${randomUUID().replaceAll('-', '')}`; }
function shuffle(values, seed) {
  let state = seed >>> 0;
  const next = () => { state = (state + 0x6D2B79F5) >>> 0; let t = Math.imul(state ^ state >>> 15, state | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return (t ^ t >>> 14) >>> 0; };
  const result = values.slice();
  for (let i = result.length - 1; i > 0; i--) { const j = next() % (i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
function safeView(record, { includeVersions = true } = {}) {
  return {
    studyId: record.studyId, manifestHash: record.manifestHash, annotationSeed: record.annotationSeed,
    cells: record.cells.map(cell => ({ displayId: cell.displayId, displayIndex: cell.displayIndex, ...(includeVersions ? { cellId: cell.cellId, revision: cell.versions.length, versions: clone(cell.versions) } : { revision: cell.versions.length }) })),
    createdAt: record.createdAt, updatedAt: record.updatedAt,
  };
}
async function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
}

/** Durable, append-only researcher annotations for frozen Studies. */
export async function createStudyAnnotationStore({ dataDir, studyStore, clock = nowISO }) {
  if (typeof dataDir !== 'string' || !dataDir || !studyStore || typeof studyStore.get !== 'function') throw new TypeError('Annotation storage and study store are required.');
  await mkdir(dataDir, { recursive: true });
  const records = new Map();
  for (const entry of await readdir(dataDir, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(await readFile(join(dataDir, entry.name), 'utf8'));
      if (object(record) && STUDY_ID.test(record.studyId) && HASH.test(record.manifestHash) && Array.isArray(record.cells)) records.set(record.studyId, record);
    } catch { /* An invalid sidecar is ignored; the study remains available for recovery. */ }
  }
  function manifest(id) {
    if (typeof id !== 'string' || !STUDY_ID.test(id)) fail('Study not found.', 404, 'STUDY_NOT_FOUND');
    let study;
    try { study = studyStore.get(id); } catch (error) { fail(error.message || 'Study not found.', error.status || 404, error.code || 'STUDY_NOT_FOUND'); }
    if (!study?.manifest?.manifestHash || !Array.isArray(study.manifest.cells)) fail('Study manifest is unavailable.', 409, 'STUDY_BLOCKED');
    return study.manifest;
  }
  async function ensure(id) {
    const frozen = manifest(id);
    let record = records.get(id);
    if (record && record.manifestHash !== frozen.manifestHash) fail('Annotations belong to a different immutable Study manifest.', 409, 'ANNOTATION_MANIFEST_MISMATCH');
    if (!record) {
      const seed = seedFor();
      const ordered = shuffle(frozen.cells.map(cell => cell.cellId), seed);
      record = { format: 'offcut-study-annotations', version: 1, studyId: id, manifestHash: frozen.manifestHash, annotationSeed: seed, createdAt: clock(), updatedAt: clock(), cells: ordered.map((cellId, displayIndex) => ({ cellId, displayIndex, displayId: opaqueId(), versions: [] })) };
      records.set(id, record);
      await atomicJSON(join(dataDir, `${id}.json`), record);
    }
    return record;
  }
  function findCell(record, input) {
    const key = input.displayId ?? input.cellId;
    const cell = record.cells.find(item => item.displayId === key || item.cellId === key);
    if (!cell) fail('Annotation cell not found.', 404, 'ANNOTATION_CELL_NOT_FOUND');
    return cell;
  }
  return {
    async get(id, options) { return safeView(await ensure(id), options); },
    async annotate(id, input) {
      const record = await ensure(id);
      const normalized = normalizeInput(input);
      const cell = findCell(record, input);
      const revision = cell.versions.length;
      const latestStage = cell.versions.length ? Math.max(...cell.versions.map(version => STAGES.indexOf(version.stage))) : -1;
      const requestedStage = STAGES.indexOf(normalized.stage);
      if (requestedStage < latestStage || requestedStage > latestStage + 1) fail('Annotation stages must be saved in image-only, sources-revealed, trace-revealed order.', 409, 'ANNOTATION_STAGE_CONFLICT');
      if (input.expectedRevision !== revision) fail(`Annotation revision is ${revision}; reload before saving.`, 409, 'ANNOTATION_CONFLICT');
      const timestamp = clock();
      const version = { studyId: id, manifestHash: record.manifestHash, cellId: cell.cellId, annotationVersion: revision + 1, rubricVersion: normalized.rubricVersion, stage: normalized.stage, authorLabel: 'single-researcher', createdAt: timestamp, updatedAt: timestamp, codes: normalized.codes, uncertainty: normalized.uncertainty, evidence: normalized.evidence, notes: normalized.notes };
      cell.versions.push(version);
      record.updatedAt = timestamp;
      await atomicJSON(join(dataDir, `${id}.json`), record);
      return { annotation: clone(version), revision: cell.versions.length, displayId: cell.displayId };
    },
    list() { return [...records.values()].map(record => safeView(record, { includeVersions: false })); },
  };
}
export { STAGES };
