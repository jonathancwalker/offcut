import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { planStudy } from '../public/study-plan.mjs';
import { createState } from './engine.mjs';
import { effectiveRunPolicy } from './run-policy.mjs';
import { freezeSources } from './runs.mjs';
import { getSharp } from './render.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STUDY_ID = /^study-[a-f0-9-]{36}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_UNION_BYTES = 128 * 1024 * 1024;
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const now = () => new Date().toISOString();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function fail(message, status = 400, code = 'STUDY_ERROR') {
  throw Object.assign(new Error(message), { status, code });
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Study manifests require finite JSON values.');
  return JSON.stringify(value);
}

function manifestDigest(manifest) {
  const { manifestHash, ...immutable } = manifest;
  return sha256(canonicalJSON(immutable));
}

async function durableWrite(file, bytes, flag = 'w') {
  const handle = await open(file, flag, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await durableWrite(temporary, JSON.stringify(value));
  await rename(temporary, file);
}

function decode(dataUrl) {
  const match = typeof dataUrl === 'string' && /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4) fail('A frozen study source is invalid.', 409, 'STUDY_SOURCE_INVALID');
  return { bytes: Buffer.from(match[2], 'base64'), mime: `image/${match[1]}` };
}

function readyState(manifest) {
  return {
    format: 'offcut-study-state', version: 1, id: manifest.id, manifestHash: manifest.manifestHash,
    status: 'ready', updatedAt: manifest.createdAt, terminationReason: null,
    entries: manifest.executionOrder.map((cellId, executionIndex) => ({ cellId, executionIndex, status: 'queued', runId: null, terminationReason: null })),
  };
}

function validState(state, manifest) {
  return object(state)
    && state.format === 'offcut-study-state'
    && state.version === 1
    && state.id === manifest.id
    && state.manifestHash === manifest.manifestHash
    && typeof state.status === 'string'
    && Array.isArray(state.entries)
    && state.entries.length === manifest.executionOrder.length
    && state.entries.every((entry, index) => object(entry)
      && entry.cellId === manifest.executionOrder[index]
      && entry.executionIndex === index
      && typeof entry.status === 'string');
}

function safeSummary(record) {
  const manifest = record.manifest;
  if (!manifest) return { id: record.id, status: 'blocked', issue: record.issue ?? 'Study record is unreadable.' };
  const entries = record.state?.entries ?? [];
  const statuses = Object.create(null);
  for (const entry of entries) statuses[entry.status] = (statuses[entry.status] ?? 0) + 1;
  return {
    id: manifest.id, createdAt: manifest.createdAt, label: manifest.plan.normalizedDraft.label,
    kind: manifest.plan.normalizedDraft.kind, manifestHash: manifest.manifestHash,
    campaignId: manifest.campaign.id, status: record.blocked ? 'blocked' : record.state.status,
    counts: manifest.plan.counts, progress: { total: entries.length, statuses },
    ...(record.issue ? { issue: record.issue } : {}),
  };
}

async function defaultProtocolSnapshot(policy) {
  const sharpVersions = getSharp().versions;
  const allowlist = ['lib/runs.mjs', 'lib/run-policy.mjs', 'lib/engine.mjs', 'lib/render.mjs', 'lib/providers.mjs', 'lib/study-store.mjs', 'public/study-plan.mjs', 'public/run-spec.mjs'];
  const files = [];
  for (const relative of allowlist) files.push({ path: relative, sha256: sha256(await readFile(join(ROOT, relative))) });
  const executionFingerprint = sha256(canonicalJSON({ version: 'offcut-execution-fingerprint-v1', files }));
  const revision = typeof process.env.OFFCUT_CODE_REVISION === 'string' && /^[a-f0-9]{40}$/.test(process.env.OFFCUT_CODE_REVISION)
    ? process.env.OFFCUT_CODE_REVISION : 'development-uncommitted';
  return {
    version: 1,
    runnerPolicy: policy,
    canvas: { width: 1000, height: 1200 },
    rules: { maxVertices: 64, minArea: 16, minScale: 0.05, maxScale: 20 },
    adapter: { provider: 'openai', endpoint: '/v1/responses', imageDetail: 'high', store: false },
    codeRevision: revision,
    codeClean: revision !== 'development-uncommitted' && process.env.OFFCUT_CODE_DIRTY !== '1',
    runtime: { node: process.version, sharp: clone(sharpVersions) },
    executionFingerprint,
    executionFiles: files,
  };
}

/** Freeze reproducible study inputs without starting a provider or run manager. */
export async function createStudyStore({ dataDir, materials, getInventory, campaigns, protocolSnapshotFactory = defaultProtocolSnapshot }) {
  if (typeof dataDir !== 'string' || !dataDir || !materials || typeof getInventory !== 'function' || !campaigns || typeof protocolSnapshotFactory !== 'function') {
    throw new TypeError('Study storage, materials, inventory, campaigns, and protocol snapshot factory are required.');
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const studies = new Map(), receipts = new Map();
  let creationTail = Promise.resolve();

  async function inspectDirectory(id) {
    const dir = join(dataDir, id);
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
      if (!object(manifest) || manifest.format !== 'offcut-study' || manifest.version !== 1 || manifest.id !== id || !HASH.test(manifest.manifestHash)) throw new Error('invalid immutable manifest');
      let state;
      try { state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        state = readyState(manifest);
        await atomicJSON(join(dir, 'state.json'), state);
      }
      const record = { id, dir, manifest, state, blocked: false, issue: null };
      if (manifestDigest(manifest) !== manifest.manifestHash) {
        record.blocked = true; record.issue = 'Manifest hash mismatch.';
      }
      if (!record.blocked && !validState(state, manifest)) {
        record.blocked = true; record.issue = 'Study state does not match its immutable manifest.';
      }
      if (!record.blocked) for (const source of manifest.sources) {
        try {
          const info = await stat(join(dir, 'assets', source.sha256));
          if (!info.isFile() || info.size !== source.byteLength || sha256(await readFile(join(dir, 'assets', source.sha256))) !== source.sha256) throw new Error();
        } catch { record.blocked = true; record.issue = `Frozen source ${source.id} failed integrity checks.`; break; }
      }
      if (record.blocked) record.state = { ...record.state, status: 'blocked', terminationReason: 'integrity_error' };
      return record;
    } catch (error) {
      return { id, dir, manifest: null, state: null, blocked: true, issue: `Study record is blocked: ${error.message}` };
    }
  }

  for (const entry of await readdir(dataDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !STUDY_ID.test(entry.name)) continue;
    const record = await inspectDirectory(entry.name);
    studies.set(entry.name, record);
    const receipt = record.manifest?.createReceipt;
    if (receipt?.clientRequestId) {
      if (receipts.has(receipt.clientRequestId)) throw new Error('A study creation receipt was reused.');
      receipts.set(receipt.clientRequestId, { id: entry.name, requestFingerprint: receipt.requestFingerprint });
    }
  }

  function find(id) {
    if (typeof id !== 'string' || !STUDY_ID.test(id) || !studies.has(id)) fail('Study not found.', 404, 'STUDY_NOT_FOUND');
    return studies.get(id);
  }

  async function preview(draft) {
    const plan = await planStudy(draft);
    return { normalizedDraft: plan.normalizedDraft, cells: plan.cells, executionOrder: plan.executionOrder, counts: plan.counts, dimensions: plan.dimensions, validation: { valid: true } };
  }

  async function create(input) {
    if (!object(input) || Reflect.ownKeys(input).length !== 3 || !['clientRequestId', 'draft', 'campaignId'].every(key => Object.hasOwn(input, key))) fail('Study creation requires only clientRequestId, draft, and campaignId.');
    if (typeof input.clientRequestId !== 'string' || !UUID.test(input.clientRequestId)) fail('clientRequestId must be a UUID.');
    const requestFingerprint = sha256(canonicalJSON({ draft: input.draft, campaignId: input.campaignId }));
    const prior = receipts.get(input.clientRequestId);
    if (prior) {
      if (prior.requestFingerprint !== requestFingerprint) fail('This study creation identifier was already used with different settings.', 409, 'RECEIPT_CONFLICT');
      return { study: detail(find(prior.id)), created: false };
    }
    const plan = await planStudy(input.draft);
    let campaign;
    try { campaign = campaigns.get(input.campaignId); }
    catch { fail('Choose an existing Study allowance.', 409, 'CAMPAIGN_NOT_FOUND'); }
    if (campaign.status === 'blocked') fail('The selected Study allowance is blocked.', 409, 'CAMPAIGN_BLOCKED');
    const id = `study-${randomUUID()}`, createdAt = now(), staging = join(dataDir, `.study-staging-${randomUUID()}`), dir = join(dataDir, id);
    await mkdir(join(staging, 'assets'), { recursive: true, mode: 0o700 });
    try {
      const inventory = clone(getInventory());
      const sourceMap = new Map(), written = new Set();
      let unionBytes = 0;
      for (const pack of plan.normalizedDraft.packs) {
        const resolved = await materials.resolve(inventory, pack.sourceIds, pack.sourceHashes, { snapshot: pack.catalogSnapshot });
        const frozen = await freezeSources(resolved);
        for (let index = 0; index < resolved.length; index++) {
          const source = resolved[index], entry = frozen.sourceManifest[index], image = decode(source.dataUrl);
          if (sha256(image.bytes) !== pack.sourceHashes[source.id]) fail(`Source ${source.id} changed while freezing.`, 409, 'SOURCE_CHANGED');
          if (!written.has(entry.sha256)) {
            unionBytes += image.bytes.length;
            if (unionBytes > MAX_UNION_BYTES) fail('The study exceeds 128 MiB of distinct frozen source bytes.');
            await durableWrite(join(staging, 'assets', entry.sha256), image.bytes, 'wx');
            written.add(entry.sha256);
          }
          const descriptor = { ...entry, mime: image.mime, byteLength: image.bytes.length };
          const previous = sourceMap.get(source.id);
          if (previous && canonicalJSON(previous) !== canonicalJSON(descriptor)) fail(`Source ID ${source.id} resolves inconsistently across packs.`, 409, 'SOURCE_CHANGED');
          sourceMap.set(source.id, descriptor);
        }
      }
      // Catch a catalog swap that happened after the final per-pack read.
      const currentCatalog = await materials.list(inventory);
      if (plan.normalizedDraft.packs.some(pack => pack.catalogSnapshot !== currentCatalog.snapshot)) fail('The collection changed while freezing the study. Refresh and review it again.', 409, 'CATALOG_CHANGED');
      const firstCell = plan.cells[0];
      // createState supplies the exact normalized rule defaults. The study
      // manifest already contains frozen source metadata; no synthetic source
      // data URL should be introduced merely to derive the policy.
      const state = createState({ id, rules: { maxActions: firstCell.spec.maxActions, maxPieces: firstCell.spec.maxPieces } });
      const policy = effectiveRunPolicy({ rules: state.rules, study: true });
      const protocolSnapshot = await protocolSnapshotFactory(policy);
      const manifest = {
        format: 'offcut-study', version: 1, id, createdAt,
        createReceipt: { clientRequestId: input.clientRequestId, requestFingerprint },
        plan, executionOrder: plan.executionOrder, cells: plan.cells,
        sources: [...sourceMap.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        campaign: { id: campaign.id, rateSnapshotId: campaign.rateSnapshotId, rateSnapshotHash: campaign.rateSnapshotHash, limitMicros: campaign.limitMicros },
        protocolSnapshot,
      };
      manifest.manifestHash = manifestDigest(manifest);
      const stateRecord = readyState(manifest);
      await durableWrite(join(staging, 'manifest.json'), JSON.stringify(manifest), 'wx');
      await durableWrite(join(staging, 'events.jsonl'), '', 'wx');
      await durableWrite(join(staging, 'state.json'), JSON.stringify(stateRecord), 'wx');
      await rename(staging, dir);
      const record = { id, dir, manifest, state: stateRecord, blocked: false, issue: null };
      studies.set(id, record);
      receipts.set(input.clientRequestId, { id, requestFingerprint });
      return { study: detail(record), created: true };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  function detail(record) {
    const summary = safeSummary(record);
    if (!record.manifest) return summary;
    return { ...summary, manifest: clone(record.manifest), state: clone(record.state), campaign: clone(record.manifest.campaign) };
  }

  return {
    preview,
    create(input) {
      const next = creationTail.then(() => create(clone(input)));
      creationTail = next.catch(() => {});
      return next;
    },
    list() { return [...studies.values()].map(safeSummary).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); },
    get(id) { return detail(find(id)); },
    manifest(id) { const record = find(id); if (record.blocked) fail(record.issue, 409, 'STUDY_BLOCKED'); return clone(record.manifest); },
    async asset(id, sourceId) {
      const record = find(id);
      if (record.blocked || !record.manifest) fail('Study source is unavailable.', 409, 'STUDY_BLOCKED');
      const source = record.manifest.sources.find(item => item.id === sourceId);
      if (!source) fail('Study source not found.', 404, 'STUDY_SOURCE_NOT_FOUND');
      const bytes = await readFile(join(record.dir, 'assets', source.sha256));
      if (bytes.length !== source.byteLength || sha256(bytes) !== source.sha256) fail('Study source failed integrity checks.', 409, 'STUDY_BLOCKED');
      return { bytes, mime: source.mime };
    },
  };
}
