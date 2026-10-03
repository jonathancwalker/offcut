import { mkdir, readFile, readdir, rename, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { planBatch } from '../public/batch-plan.mjs';
import { drawMaterialIds } from '../public/material-selection.mjs';
import { freezeSources, normalizeSpec } from './runs.mjs';
import { safeMaterialMetadata } from './material-catalog.mjs';

const BATCH_ID = /^batch-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const SOURCE_ID = /^[a-zA-Z0-9_-]{1,100}$/;
const MAX_UNION_BYTES = 128 * 1024 * 1024;
const MAX_RUN_BYTES = 24 * 1024 * 1024;
const TERMINAL_CHILD = new Set(['completed', 'limit_reached', 'failed', 'stopped', 'interrupted']);
const SUCCESS_CHILD = new Set(['completed', 'limit_reached']);
const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }

async function writeDurable(file, bytes, flags = 'w') {
  const handle = await open(file, flags, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function atomicJSON(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeDurable(temporary, JSON.stringify(data));
  await rename(temporary, file);
}

function normalizeBody(input) {
  const fields = ['clientRequestId', 'spec', 'groups', 'mode', 'materials', 'materialSelection', 'sourceIds', 'sourceHashes'];
  if (!object(input) || Reflect.ownKeys(input).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(input, key))) fail('Supply a complete batch setup without extra settings.');
  if (typeof input.clientRequestId !== 'string' || !UUID.test(input.clientRequestId)) fail('A valid clientRequestId is required to launch a batch.');
  if (!object(input.spec) || Reflect.ownKeys(input.spec).some(key => !['prompt', 'maxTurns', 'maxActions', 'maxPieces', 'maxOutputTokens', 'maxMinutes'].includes(key))) fail('Batch settings may contain only the brief and run budgets.');
  const plan = planBatch({ groups: input.groups, mode: input.mode, materials: input.materials, materialSelection: input.materialSelection });
  // Validate every model and budget before reading images or capturing a connection.
  const specs = plan.groups.map(group => normalizeSpec({ ...input.spec, provider: 'openai', model: group.model }));
  const { provider, model, ...spec } = specs[0];
  const reviewed = drawMaterialIds(plan.materialSelection);
  if (!Array.isArray(input.sourceIds) || canonical(input.sourceIds) !== canonical(reviewed)) fail('The reviewed image set does not match the material draw. Review your selection before launching.');
  if (!object(input.sourceHashes) || Object.keys(input.sourceHashes).length !== reviewed.length
    || reviewed.some(id => !Object.hasOwn(input.sourceHashes, id) || typeof input.sourceHashes[id] !== 'string' || !HASH.test(input.sourceHashes[id]))
    || Object.keys(input.sourceHashes).some(id => !reviewed.includes(id))) fail('Supply the exact image hashes for the reviewed draw.');
  return { plan, spec, specs };
}

/** A durable, sequential queue. Restart never resumes a paid provider request. */
export async function createBatchManager({ dataDir, runs, materials, getInventory, providerFactory }) {
  if (typeof dataDir !== 'string' || !dataDir || !runs || !materials || typeof getInventory !== 'function' || typeof providerFactory !== 'function') throw new TypeError('Batch storage, runs, materials, inventory, and provider factory are required.');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const batches = new Map(), receipts = new Map();
  let active = null, starting = null, closed = false;

  function find(id) {
    if (typeof id !== 'string' || !BATCH_ID.test(id) || !batches.has(id)) fail('Batch not found.', 404);
    return batches.get(id);
  }
  function save(batch) {
    batch.record.updatedAt = now();
    const snapshot = clone(batch.record);
    batch.write = batch.write.then(() => atomicJSON(join(batch.dir, 'batch.json'), snapshot));
    return batch.write;
  }
  function summarize(batch) {
    const record = batch.record;
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    for (const entry of record.entries) {
      for (const key of Object.keys(usage)) usage[key] += entry.usage?.[key] ?? 0;
    }
    return clone({
      id: record.id, status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt, launch: record.launch,
      mode: record.mode, materials: record.materials, groups: record.groups, totalRuns: record.totalRuns,
      completedRuns: record.entries.filter(entry => entry.status === 'completed').length,
      finishedRuns: record.entries.filter(entry => TERMINAL_CHILD.has(entry.status)).length,
      activeRunId: record.entries.find(entry => entry.status === 'running')?.runId ?? null,
      terminationReason: record.terminationReason, usage, usageIncomplete: record.entries.some(entry => entry.usageIncomplete === true), costUSD: null,
    });
  }
  function detail(batch) {
    const { spec, version, seedAlgorithm, materialSelection, candidateManifest, sourceManifest, entries } = batch.record;
    return { ...summarize(batch), ...clone({ spec, version, seedAlgorithm, materialSelection, candidateManifest, sourceManifest, entries }) };
  }
  function outcome(entry, run) {
    entry.runId = run.id;
    entry.status = run.status;
    entry.terminationReason = run.terminationReason ?? null;
    entry.usage = clone(run.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    entry.usageIncomplete = run.usageIncomplete === true;
  }
  async function finish(batch, status, reason) {
    batch.record.status = status;
    batch.record.terminationReason = reason;
    for (const entry of batch.record.entries) if (entry.status === 'queued') {
      entry.status = 'not_run';
      entry.terminationReason = reason;
    }
    await save(batch);
  }

  async function asset(batch, sourceId) {
    if (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId)) fail('Batch source not found.', 404);
    const source = batch.record.sourceManifest.find(item => item.id === sourceId);
    if (!source) fail('Batch source not found.', 404);
    if (!HASH.test(source.sha256) || !Number.isSafeInteger(source.byteLength) || source.byteLength < 1 || source.byteLength > 16 * 1024 * 1024
      || !['image/png', 'image/jpeg', 'image/webp'].includes(source.mime)) fail('The frozen batch source metadata is invalid.', 500);
    const handle = await open(join(batch.dir, 'assets', source.sha256), 'r');
    let bytes;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== source.byteLength) fail('The frozen batch source failed its integrity check.', 500);
      const buffer = Buffer.alloc(source.byteLength + 1);
      let count = 0;
      while (count < buffer.length) {
        const read = await handle.read(buffer, count, buffer.length - count, null);
        if (!read.bytesRead) break;
        count += read.bytesRead;
      }
      bytes = buffer.subarray(0, count);
    } finally { await handle.close(); }
    if (bytes.length !== source.byteLength || hash(bytes) !== source.sha256) fail('The frozen batch source failed its integrity check.', 500);
    return { bytes, mime: source.mime };
  }
  async function loadSources(batch, entry) {
    const result = [];
    for (const id of entry.sourceIds) {
      const description = batch.record.sourceManifest.find(item => item.id === id);
      const { bytes, mime } = await asset(batch, id);
      const { sha256, byteLength, mime: _mime, ...metadata } = description;
      result.push({ ...metadata, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` });
    }
    return result;
  }
  function cancelChild(batch, id) {
    return batch.cancel?.status === 'interrupted' || closed ? runs.interrupt(id) : runs.stop(id);
  }
  async function execute(batch) {
    try {
      for (const entry of batch.record.entries) {
        if (batch.cancel || closed) break;
        const sources = await loadSources(batch, entry);
        if (batch.cancel || closed) break;
        // The immutable child token already exists on disk, even if the process
        // fails after the child commits but before its run ID is saved here.
        const run = await runs.start({
          spec: { ...batch.record.spec, provider: 'openai', model: entry.model }, sources, launch: entry.launch,
          materialSelection: { ...batch.record.materialSelection, seed: entry.seed, candidateManifest: batch.record.candidateManifest },
          batch: { id: batch.record.id, groupIndex: entry.groupIndex, runIndex: entry.runIndex },
        });
        outcome(entry, run);
        await save(batch);
        if (batch.cancel || closed) await cancelChild(batch, run.id);
        const ended = await runs.wait(run.id);
        outcome(entry, ended);
        await save(batch);
        if (batch.cancel || closed) break;
        if (!SUCCESS_CHILD.has(ended.status)) {
          await finish(batch, ended.status === 'stopped' ? 'stopped' : ended.status === 'interrupted' ? 'interrupted' : 'failed', `child_${ended.status}`);
          return;
        }
      }
      if (batch.cancel || closed) await finish(batch, batch.cancel?.status ?? 'interrupted', batch.cancel?.reason ?? 'server_closed');
      else await finish(batch, 'completed', 'all_runs_finished');
    } catch (error) {
      const current = batch.record.entries.find(entry => entry.status === 'running' && entry.runId);
      if (current) {
        try { outcome(current, await cancelChild(batch, current.runId)); } catch { /* Original failure remains authoritative. */ }
      }
      // Never persist arbitrary provider errors, which may contain credentials.
      await finish(batch, batch.cancel?.status ?? 'failed', batch.cancel?.reason ?? 'batch_runner_error').catch(() => {
        batch.record.status = 'failed';
        batch.record.terminationReason = 'persistence_error';
      });
    } finally {
      if (active === batch.record.id) active = null;
    }
  }

  // Recover child linkage from its precommitted token. Reconcile actual durable
  // outcomes, then stop the queue permanently; never auto-resume on restart.
  const childReceipts = new Map(runs.list().filter(run => run.launch).map(run => [run.launch.clientRequestId, run]));
  for (const directory of await readdir(dataDir, { withFileTypes: true })) {
    if (!directory.isDirectory() || !BATCH_ID.test(directory.name)) continue;
    const dir = join(dataDir, directory.name);
    let record;
    try { record = JSON.parse(await readFile(join(dir, 'batch.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (record.format !== 'offcut-batch' || record.version !== 1 || record.id !== directory.name || !Array.isArray(record.entries)
      || !Array.isArray(record.sourceManifest) || record.sourceManifest.some(source => !object(source) || !SOURCE_ID.test(source.id) || !HASH.test(source.sha256)
        || !Number.isSafeInteger(source.byteLength) || source.byteLength < 1 || source.byteLength > 16 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(source.mime))
      || !UUID.test(record.launch?.clientRequestId) || !HASH.test(record.launch?.requestFingerprint)) throw new Error(`Cannot recover batch ${directory.name}: invalid batch record.`);
    const batch = { dir, record, cancel: null, task: null, write: Promise.resolve() };
    for (const entry of record.entries) {
      const child = childReceipts.get(entry.launch.clientRequestId);
      if (child) {
        if (child.launch.requestFingerprint !== entry.launch.requestFingerprint || child.batch?.id !== record.id
          || child.batch.groupIndex !== entry.groupIndex || child.batch.runIndex !== entry.runIndex) throw new Error(`Cannot recover batch ${record.id}: child receipt mismatch.`);
        outcome(entry, child);
      } else if (entry.runId) throw new Error(`Cannot recover batch ${record.id}: a recorded child is missing.`);
    }
    batches.set(record.id, batch);
    if (receipts.has(record.launch.clientRequestId)) throw new Error('Cannot recover duplicate batch launch receipts.');
    receipts.set(record.launch.clientRequestId, record.id);
    if (record.status === 'running') {
      const allFinished = record.entries.every(entry => SUCCESS_CHILD.has(entry.status));
      await finish(batch, allFinished ? 'completed' : record.stopRequested ? 'stopped' : 'interrupted', allFinished ? 'all_runs_finished' : record.stopRequested ? 'user_stopped' : 'server_restarted');
    } else await save(batch);
  }

  async function createBatch(body, fingerprint) {
    const { plan, spec } = normalizeBody(body);
    if (runs.list().some(run => run.status === 'running')) fail('A run is already in progress. Wait for it to finish or stop it before launching a batch.', 409);
    const inventory = clone(await getInventory());
    const catalog = await materials.list(inventory);
    if (catalog.snapshot !== plan.materialSelection.catalogSnapshot) fail('The source collection changed. Refresh and review the batch before launching.', 409);
    const byId = new Map(catalog.sources.map(source => [source.id, source]));
    const candidateManifest = plan.materialSelection.candidateIds.map(id => {
      if (!byId.has(id)) fail('A candidate image is no longer available. Refresh your selection.', 409);
      return { id, sha256: byId.get(id).sha256 };
    });
    for (const id of body.sourceIds) if (!byId.has(id) || byId.get(id).sha256 !== body.sourceHashes[id]) fail('A reviewed image changed or is no longer available. Review the batch again.', 409);
    const union = [...new Set(plan.entries.flatMap(entry => entry.sourceIds))];
    const unionHashes = new Map();
    for (const entry of plan.entries) {
      let bytes = 0;
      for (const id of entry.sourceIds) {
        const source = byId.get(id);
        if (!source) fail('A selected image is no longer available. Refresh your selection.', 409);
        if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 1 || source.byteLength > 16 * 1024 * 1024 || !HASH.test(source.sha256)) fail('A selected image has invalid size or hash metadata.', 409);
        bytes += source.byteLength;
        unionHashes.set(source.sha256, source.byteLength);
      }
      if (bytes > MAX_RUN_BYTES) fail('At least one planned run exceeds 24 MiB of source images. Use fewer or smaller images.');
    }
    if ([...unionHashes.values()].reduce((sum, size) => sum + size, 0) > MAX_UNION_BYTES) fail('This batch needs more than 128 MiB of distinct source images. Choose fewer runs or smaller images.');
    const id = `batch-${randomUUID()}`, dir = join(dataDir, id), staging = join(dataDir, `.pending-${randomUUID()}`);
    await mkdir(join(staging, 'assets'), { recursive: true, mode: 0o700 });
    try {
      const sourceManifest = [], written = new Set();
      let frozenBytes = 0;
      // Only one source is loaded at a time. Catalog expansion cannot turn batch
      // acceptance into an unbounded image allocation.
      for (const sourceId of union) {
        if (closed) fail('The batch runner is closing.', 503);
        const original = (await materials.resolve(inventory, [sourceId], { [sourceId]: byId.get(sourceId).sha256 }, { snapshot: catalog.snapshot }))[0];
        const frozen = await freezeSources([original]);
        const source = frozen.sources[0];
        const bytes = Buffer.from(source.dataUrl.split(',')[1], 'base64');
        const mime = /^data:([^;]+);/.exec(source.dataUrl)[1], sha256 = hash(bytes);
        if (sha256 !== byId.get(sourceId).sha256 || bytes.length !== byId.get(sourceId).byteLength) fail('A source image changed while freezing the batch. Review and launch again.', 409);
        if (!written.has(sha256)) {
          frozenBytes += bytes.length;
          if (frozenBytes > MAX_UNION_BYTES) fail('The frozen batch exceeds 128 MiB of distinct source images.');
          await writeDurable(join(staging, 'assets', sha256), bytes, 'wx');
          written.add(sha256);
        }
        sourceManifest.push({ ...frozen.sourceManifest[0], ...safeMaterialMetadata(original), byteLength: bytes.length, mime });
      }
      // Attribution and candidate membership belong to the reviewed snapshot,
      // not a catalog concurrently replaced during asset reads.
      if ((await materials.list(inventory)).snapshot !== catalog.snapshot) fail('The source collection changed while freezing the batch. Refresh and review it again.', 409);
      if (closed) fail('The batch runner is closing.', 503);
      const connection = await providerFactory('openai');
      if (!connection || typeof connection.generate !== 'function') fail('The selected provider is not connected.', 503);
      if (closed) fail('The batch runner is closing.', 503);
      const createdAt = now();
      const record = {
        format: 'offcut-batch', version: plan.version, id, status: 'running', createdAt, updatedAt: createdAt,
        launch: { clientRequestId: body.clientRequestId, requestFingerprint: fingerprint }, spec,
        seedAlgorithm: plan.seedAlgorithm, mode: plan.mode, materials: plan.materials, groups: plan.groups,
        totalRuns: plan.totalRuns, materialSelection: plan.materialSelection, candidateManifest, sourceManifest,
        terminationReason: null, stopRequested: false,
        entries: plan.entries.map(entry => ({
          ...entry, launch: { clientRequestId: randomUUID(), requestFingerprint: hash(canonical({ batchId: id, spec, entry, sourceHashes: entry.sourceIds.map(sourceId => [sourceId, byId.get(sourceId).sha256]) })) },
          runId: null, status: 'queued', terminationReason: null,
        })),
      };
      await atomicJSON(join(staging, 'batch.json'), record);
      await rename(staging, dir);
      const batch = { dir, record, cancel: null, task: null, write: Promise.resolve() };
      batches.set(id, batch);
      receipts.set(body.clientRequestId, id);
      active = id;
      batch.task = execute(batch);
      return detail(batch);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async function stopBatch(batch, status, reason) {
    if (batch.record.status === 'running') {
      batch.cancel ??= { status, reason };
      if (reason === 'user_stopped') batch.record.stopRequested = true;
      // Persist intent before touching the active child. A restart cannot advance
      // the queue between these two operations.
      await save(batch);
      const child = batch.record.entries.find(entry => entry.status === 'running' && entry.runId);
      if (child) await cancelChild(batch, child.runId);
    }
    await batch.task;
    return detail(batch);
  }

  return {
    start(input) {
      let body, fingerprint;
      try {
        body = clone(input);
        if (!object(body) || typeof body.clientRequestId !== 'string' || !UUID.test(body.clientRequestId)) fail('A valid clientRequestId is required to launch a batch.');
        fingerprint = hash(canonical(body));
        const receipt = receipts.get(body.clientRequestId);
        if (receipt) {
          const batch = find(receipt);
          if (batch.record.launch.requestFingerprint !== fingerprint) fail('This batch launch token was already used with different settings.', 409);
          return Promise.resolve(detail(batch));
        }
        if (starting?.id === body.clientRequestId) {
          if (starting.fingerprint !== fingerprint) fail('This batch launch token is already being used with different settings.', 409);
          return starting.promise;
        }
        if (closed) fail('The batch runner is closing.', 503);
        if (starting || active) fail('A batch is already in progress. Wait for it to finish or stop it before launching another.', 409);
      } catch (error) { return Promise.reject(error); }
      const promise = createBatch(body, fingerprint).finally(() => { starting = null; });
      starting = { id: body.clientRequestId, fingerprint, promise };
      return promise;
    },
    list() { return [...batches.values()].map(summarize).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },
    get(id) { return detail(find(id)); },
    hasActive() { return Boolean(starting || active); },
    async asset(id, sourceId) { return asset(find(id), sourceId); },
    async stop(id) { return stopBatch(find(id), 'stopped', 'user_stopped'); },
    async wait(id) { const batch = find(id); await batch.task; return detail(batch); },
    async close() {
      closed = true;
      await starting?.promise.catch(() => {});
      if (active) await stopBatch(find(active), 'interrupted', 'server_closed');
      await Promise.all([...batches.values()].map(batch => batch.task));
    },
  };
}
