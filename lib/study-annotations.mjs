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
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

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
function normalizeEvidence(value, { stage, sourceIds = [] } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE) fail(`Evidence must contain at most ${MAX_EVIDENCE} items.`);
  return value.map((item, index) => {
    if (!object(item)) fail(`Evidence item ${index + 1} must be an object.`);
    const allowed = ['region', 'sourceId', 'sourceIndex', 'eventSequence', 'statementExcerpt'];
    if (Reflect.ownKeys(item).some(key => !allowed.includes(key)) || !Object.hasOwn(item, 'region')) fail('Each evidence item requires only a region and an optional event sequence or statement excerpt.');
    const result = { region: rectangle(item.region) };
    if (item.sourceId !== undefined) {
      if (typeof item.sourceId !== 'string' || !sourceIds.includes(item.sourceId)) fail('Evidence sourceId must identify a source in this frozen cell.');
      result.sourceId = item.sourceId;
    }
    if (item.sourceIndex !== undefined) {
      if (!Number.isSafeInteger(item.sourceIndex) || item.sourceIndex < 0 || item.sourceIndex >= sourceIds.length) fail('Evidence sourceIndex must identify a source in this frozen cell.');
      result.sourceIndex = item.sourceIndex;
    }
    if (result.sourceId !== undefined && result.sourceIndex !== undefined) fail('Evidence must use either sourceId or sourceIndex, not both.');
    if (item.eventSequence !== undefined) {
      if (!Number.isSafeInteger(item.eventSequence) || item.eventSequence < 0) fail('Evidence eventSequence must be a non-negative integer.');
      result.eventSequence = item.eventSequence;
    }
    if (item.statementExcerpt !== undefined) result.statementExcerpt = text(item.statementExcerpt, 'Evidence statementExcerpt', 2_000);
    if (stage === 'image_only' && (result.sourceId !== undefined || result.sourceIndex !== undefined || result.eventSequence !== undefined || result.statementExcerpt !== undefined)) fail('Image-only evidence may contain normalized regions only.');
    if (stage === 'sources_revealed' && (result.eventSequence !== undefined || result.statementExcerpt !== undefined)) fail('Sources-stage evidence may contain normalized regions and source references only.');
    if (stage === 'trace_revealed' && result.eventSequence === undefined && result.statementExcerpt === undefined) fail('Trace-stage evidence must identify an event sequence or statement excerpt.');
    if (stage !== 'trace_revealed' && result.sourceId === undefined && result.sourceIndex === undefined && stage === 'sources_revealed') fail('Sources-stage evidence must identify a frozen source.');
    if (result.eventSequence !== undefined && result.statementExcerpt !== undefined) fail('Each evidence item must identify an event sequence or statement excerpt, not both.');
    return result;
  });
}
function normalizeInput(input, { sourceIds = [] } = {}) {
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
  return { rubricVersion, stage: input.stage, codes, uncertainty, evidence: normalizeEvidence(input.evidence, { stage: input.stage, sourceIds }), notes };
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
function validDate(value) { return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value)); }
function validateRecord(record, frozen) {
  if (!object(record) || record.format !== 'offcut-study-annotations' || record.version !== 1 || record.studyId !== frozen.id || record.manifestHash !== frozen.manifestHash || !Number.isSafeInteger(record.annotationSeed) || record.annotationSeed < 0 || record.annotationSeed > 0xffffffff || !validDate(record.createdAt) || !validDate(record.updatedAt) || !Array.isArray(record.cells) || record.cells.length !== frozen.cells.length) fail('The annotation sidecar is malformed and has been blocked.', 409, 'ANNOTATION_STORE_CORRUPT');
  const ids = new Set(frozen.cells.map(cell => cell.cellId));
  const displayIds = new Set();
  const indexes = new Set();
  for (const [arrayIndex, cell] of record.cells.entries()) {
    if (!object(cell) || !CELL_ID.test(cell.cellId) || !ids.has(cell.cellId) || typeof cell.displayId !== 'string' || !DISPLAY_ID.test(cell.displayId) || displayIds.has(cell.displayId) || !Number.isSafeInteger(cell.displayIndex) || cell.displayIndex !== arrayIndex || cell.displayIndex < 0 || cell.displayIndex >= record.cells.length || indexes.has(cell.displayIndex) || !Array.isArray(cell.versions)) fail('The annotation sidecar is malformed and has been blocked.', 409, 'ANNOTATION_STORE_CORRUPT');
    displayIds.add(cell.displayId); indexes.add(cell.displayIndex);
    if (cell.versions.length > STAGES.length) fail('The annotation sidecar is malformed and has been blocked.', 409, 'ANNOTATION_STORE_CORRUPT');
    let previous = -1;
    for (let index = 0; index < cell.versions.length; index++) {
      const version = cell.versions[index];
      if (!object(version) || version.studyId !== record.studyId || version.manifestHash !== record.manifestHash || version.cellId !== cell.cellId || version.annotationVersion !== index + 1 || !STAGE_SET.has(version.stage) || STAGES.indexOf(version.stage) !== previous + 1 || typeof version.authorLabel !== 'string' || !validDate(version.createdAt) || !validDate(version.updatedAt) || !Array.isArray(version.codes) || typeof version.notes !== 'string') fail('The annotation sidecar is malformed and has been blocked.', 409, 'ANNOTATION_STORE_CORRUPT');
      normalizeEvidence(version.evidence, { stage: version.stage, sourceIds: frozen.cells.find(item => item.cellId === cell.cellId)?.sourceIds || [] });
      previous = STAGES.indexOf(version.stage);
    }
  }
  if (indexes.size !== record.cells.length) fail('The annotation sidecar is malformed and has been blocked.', 409, 'ANNOTATION_STORE_CORRUPT');
}
async function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
}

/** Durable, append-only researcher annotations for frozen Studies. */
export async function createStudyAnnotationStore({ dataDir, studyStore, runs = null, clock = nowISO }) {
  if (typeof dataDir !== 'string' || !dataDir || !studyStore || typeof studyStore.get !== 'function') throw new TypeError('Annotation storage and study store are required.');
  await mkdir(dataDir, { recursive: true });
  const records = new Map();
  for (const entry of await readdir(dataDir, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filenameStudyId = entry.name.slice(0, -5);
    try { records.set(STUDY_ID.test(filenameStudyId) ? filenameStudyId : `invalid-${filenameStudyId}`, JSON.parse(await readFile(join(dataDir, entry.name), 'utf8'))); }
    catch { if (STUDY_ID.test(filenameStudyId)) records.set(filenameStudyId, { studyId: filenameStudyId, format: 'invalid' }); }
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
    if (record && (record.format !== 'offcut-study-annotations' || record.version !== 1 || record.studyId !== id)) validateRecord(record, frozen);
    if (record && record.manifestHash !== frozen.manifestHash) fail('Annotations belong to a different immutable Study manifest.', 409, 'ANNOTATION_MANIFEST_MISMATCH');
    if (!record) {
      const seed = seedFor();
      const ordered = shuffle(frozen.cells.map(cell => cell.cellId), seed);
      record = { format: 'offcut-study-annotations', version: 1, studyId: id, manifestHash: frozen.manifestHash, annotationSeed: seed, createdAt: clock(), updatedAt: clock(), cells: ordered.map((cellId, displayIndex) => ({ cellId, displayIndex, displayId: opaqueId(), versions: [] })) };
      records.set(id, record);
      await atomicJSON(join(dataDir, `${id}.json`), record);
    }
    validateRecord(record, frozen);
    return record;
  }
  function findCell(record, input) {
    const key = input.displayId ?? input.cellId;
    const cell = record.cells.find(item => item.displayId === key || item.cellId === key);
    if (!cell) fail('Annotation cell not found.', 404, 'ANNOTATION_CELL_NOT_FOUND');
    return cell;
  }
  function reviewCell(record, id, displayId) {
    const cell = record.cells.find(item => item.displayId === displayId);
    if (!cell) fail('Review cell not found.', 404, 'ANNOTATION_CELL_NOT_FOUND');
    const frozen = manifest(id);
    const sourceCell = frozen.cells.find(item => item.cellId === cell.cellId);
    const entry = frozen.executionOrder?.indexOf(cell.cellId) >= 0 ? (studyStore.get(id).state?.entries || []).find(item => item.cellId === cell.cellId) : null;
    return { cell, sourceCell, entry, frozen };
  }
  function savedStage(cell) { return cell.versions.length ? STAGES.indexOf(cell.versions.at(-1).stage) : -1; }
  async function review(id, displayId, requestedStage) {
    const record = await ensure(id);
    const { cell, sourceCell, entry } = reviewCell(record, id, displayId);
    const saved = savedStage(cell);
    const stage = requestedStage === undefined ? Math.max(0, saved) : requestedStage;
    if (!Number.isInteger(stage) || stage < 0 || stage >= STAGES.length || stage > saved + 1) fail('This review stage is not available yet.', 409, 'REVIEW_STAGE_CONFLICT');
    const result = { displayId: cell.displayId, displayIndex: cell.displayIndex, revision: cell.versions.length, stage: STAGES[stage], image: { available: entry?.status === 'completed' && Boolean(entry.runId), url: `/api/studies/${id}/review/${cell.displayId}/image` } };
    if (stage >= 1) result.sources = (sourceCell?.sourceIds || []).map((_, index) => ({ index, url: `/api/studies/${id}/review/${cell.displayId}/sources/${index}?stage=1` }));
    if (stage >= 2) {
      const summary = entry?.runId && runs ? await Promise.resolve().then(() => runs.get(entry.runId)).catch(() => null) : null;
      const events = entry?.runId ? await Promise.resolve().then(() => traceEvents(entry.runId)).catch(() => []) : [];
      const returnedModels = [...new Set(events.filter(event => event.type === 'model_output' && event.model).map(event => event.model))];
      const model = sourceCell ? stateModel(sourceCell, frozenFor(id).plan) : null;
      result.trace = { requestedModel: model, returnedModels, status: entry?.status || 'unknown', prompt: modelPrompt(sourceCell, frozenFor(id).plan), title: summary?.title || null, statement: summary?.description || null, events };
    }
    return result;
  }
  function frozenFor(id) { return manifest(id); }
  function stateModel(cell, plan) { const model = plan.normalizedDraft.models.find(item => item.id === cell.modelId); return model ? { provider: model.provider, model: model.model } : null; }
  function modelPrompt(cell, plan) { return plan.normalizedDraft.prompts.find(item => item.id === cell.promptId)?.text || null; }
  function traceEvents(runId) {
    if (!runId || !runs || typeof runs.events !== 'function') return [];
    return runs.events(runId).flatMap(event => {
      const base = { sequence: event.sequence, type: event.type, at: event.at ?? null, turn: event.turn ?? null };
      if (event.type === 'model_output') return [{ ...base, model: event.model ?? null, text: typeof event.text === 'string' ? event.text : '' }];
      if (event.type === 'batch_result') return [{ ...base, accepted: event.accepted === true, code: event.code ?? null, error: event.error ?? null, decisionNote: event.decision_note ?? null, done: event.done ?? null, actions: Array.isArray(event.actions) ? clone(event.actions) : [] }];
      if (event.type === 'budget_denied') return [{ ...base, code: event.code ?? null, error: event.error ?? null }];
      if (event.type === 'termination') return [{ ...base, status: event.status ?? null, reason: event.reason ?? null }];
      if (event.type === 'error') return [{ ...base, error: clone(event.error ?? null) }];
      if (event.type === 'final_review') return [{ ...base, observedStep: event.observedStep ?? null, step: event.step ?? null }];
      return [];
    });
  }
  async function reviewList(id) {
    const record = await ensure(id); const frozen = manifest(id);
    return { studyId: id, label: frozen.plan.normalizedDraft.label, kind: frozen.plan.normalizedDraft.kind, cards: record.cells.map(cell => ({ displayId: cell.displayId, displayIndex: cell.displayIndex, revision: cell.versions.length, stage: STAGES[Math.max(0, savedStage(cell))] })) };
  }
  async function reviewImage(id, displayId) {
    const record = await ensure(id); const { cell, entry } = reviewCell(record, id, displayId);
    if (!entry?.runId || entry.status !== 'completed' || !runs) fail('The final image is unavailable.', 404, 'REVIEW_ASSET_UNAVAILABLE');
    return runs.state(entry.runId);
  }
  async function reviewSource(id, displayId, index, requestedStage) {
    const record = await ensure(id); const { cell, sourceCell } = reviewCell(record, id, displayId);
    if (requestedStage !== 1 || savedStage(cell) < 0 || !Number.isSafeInteger(index) || index < 0 || index >= (sourceCell?.sourceIds || []).length) fail('The source is unavailable until the sources stage is explicitly revealed.', 404, 'REVIEW_SOURCE_UNAVAILABLE');
    return studyStore.asset(id, sourceCell.sourceIds[index]);
  }
  return {
    async get(id, options) { return safeView(await ensure(id), options); },
    async reviewList(id) { return reviewList(id); },
    async review(id, displayId, requestedStage) { return review(id, displayId, requestedStage); },
    async reviewImage(id, displayId) { return reviewImage(id, displayId); },
    async reviewSource(id, displayId, index, requestedStage) { return reviewSource(id, displayId, index, requestedStage); },
    async annotate(id, input) {
      const record = await ensure(id);
      const cell = findCell(record, input);
      const frozen = manifest(id);
      const normalized = normalizeInput(input, { sourceIds: frozen.cells.find(item => item.cellId === cell.cellId)?.sourceIds || [] });
      const revision = cell.versions.length;
      const latestStage = cell.versions.length ? Math.max(...cell.versions.map(version => STAGES.indexOf(version.stage))) : -1;
      const requestedStage = STAGES.indexOf(normalized.stage);
      if (requestedStage !== latestStage + 1) fail('Each annotation stage may be saved exactly once, in image-only, sources-revealed, trace-revealed order.', 409, 'ANNOTATION_STAGE_CONFLICT');
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
