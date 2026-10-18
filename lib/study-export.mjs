import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createState, applyAction } from './engine.mjs';
import { renderPNG } from './render.mjs';
import { readDataRootOwner } from './data-root.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STUDY = /^study-[a-f0-9-]{36}$/;
const RUN = /^run-[a-f0-9-]{36}$/;
const HASH = /^[a-f0-9]{64}$/;
const TERMINAL_RUN = new Set(['completed', 'limit_reached', 'failed', 'stopped', 'interrupted']);
const MAX_JSON = 64 * 1024 * 1024;
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const eventHash = value => sha256(JSON.stringify(value));

function fail(message, code = 'STUDY_EXPORT_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function bounded(file, limit = MAX_JSON) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) fail(`Unsafe or oversized export input: ${file}`);
  return readFile(file);
}

async function json(file) {
  try { return JSON.parse((await bounded(file)).toString('utf8')); }
  catch (error) { fail(`Could not read ${file}: ${error.message}`); }
}

function decode(dataUrl) {
  const match = typeof dataUrl === 'string' && /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4) fail('A run project contains an invalid embedded source.');
  return { bytes: Buffer.from(match[2], 'base64'), mime: `image/${match[1]}` };
}

function safeTree(value, dataDir) {
  const visit = item => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!object(item)) {
      if (typeof item === 'string' && item.includes(dataDir)) fail('Export metadata contains a private local data path.', 'STUDY_EXPORT_LEAK');
      return;
    }
    for (const [key, entry] of Object.entries(item)) {
      if (/api.?key|authorization|access.?token|client.?secret/i.test(key)) fail(`Export metadata contains forbidden credential field ${key}.`, 'STUDY_EXPORT_LEAK');
      visit(entry);
    }
  };
  visit(value);
}

async function writeJSON(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

async function putAsset(outDir, index, bytes, mime) {
  const hash = sha256(bytes);
  if (!index[hash]) {
    const target = join(outDir, 'assets', hash);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    index[hash] = { sha256: hash, byteLength: bytes.length, mime, path: `assets/${hash}` };
  } else if (index[hash].byteLength !== bytes.length || index[hash].mime !== mime) fail(`Asset ${hash} has conflicting metadata.`);
  return hash;
}

function replay(project, assets) {
  const sources = project.sources.map(source => {
    const asset = assets[source.assetSha256];
    if (!asset) fail(`Project source asset ${source.assetSha256} is missing.`);
    return { ...source, dataUrl: `data:${asset.mime};base64,${asset.bytes.toString('base64')}` };
  });
  let state = createState({ id: project.id, sources, rules: project.rules, canvas: project.canvas });
  for (let index = 0; index < project.cursor; index++) state = applyAction(state, project.actions[index].action);
  return state;
}

async function externalProject(input, outDir, assets) {
  const project = clone(input);
  project.sources = [];
  for (const source of input.sources) {
    const { bytes, mime } = decode(source.dataUrl);
    const assetSha256 = await putAsset(outDir, assets, bytes, mime);
    const { dataUrl: _dataUrl, ...metadata } = source;
    project.sources.push({ ...metadata, assetSha256 });
  }
  return project;
}

async function copyOptionalTree(source, destination) {
  if (source === undefined || source === null) return false;
  if (typeof source !== 'string' || !isAbsolute(source)) fail('Optional report paths must be absolute.');
  let entries;
  try { entries = await readdir(source, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail('Optional report inputs cannot contain links or special files.');
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) await copyOptionalTree(from, to);
    else {
      if (!['.json', '.md', '.csv', '.png'].includes(extname(entry.name).toLowerCase())) continue;
      await copyFile(from, to, 0);
    }
  }
  return true;
}

function safeJoin(root, path, label = 'export path') {
  if (typeof path !== 'string' || !path || path.includes('\\')) fail(`Invalid ${label}.`);
  const target = resolve(root, path);
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith('../') || isAbsolute(relation)) fail(`Invalid ${label}.`);
  return target;
}

async function readCampaignSnapshot(dataDir, campaignId) {
  if (typeof campaignId !== 'string' || !/^campaign-[a-f0-9-]{36}$/.test(campaignId)) fail('Study campaign identity is invalid.');
  const directory = join(dataDir, 'campaigns', campaignId);
  const [configBytes, ledgerBytes] = await Promise.all([
    bounded(join(directory, 'config.json')),
    bounded(join(directory, 'ledger.jsonl')),
  ]);
  const config = JSON.parse(configBytes);
  if (config.id !== campaignId || config.format !== 'offcut-campaign' || config.version !== 1) fail('Campaign config is invalid.');
  const reservations = new Map();
  const requestIds = new Set();
  const reconciliationIds = new Set();
  let prior = null;
  const events = ledgerBytes.toString('utf8').split('\n').filter(Boolean).map((line, index) => {
    const event = JSON.parse(line);
    const { eventHash: recorded, ...unsigned } = event;
    if (event.sequence !== index + 1 || event.previousHash !== prior || recorded !== eventHash(unsigned)) fail('Campaign ledger integrity check failed.');
    prior = recorded;
    if (event.type === 'reservation_created') {
      if (typeof event.reservationId !== 'string' || reservations.has(event.reservationId) || typeof event.requestId !== 'string' || requestIds.has(event.requestId)) fail('Campaign ledger contains a duplicate reservation.');
      requestIds.add(event.requestId);
      reservations.set(event.reservationId, { ...event, status: 'reserved' });
    }
    else {
      const item = reservations.get(event.reservationId);
      if (!item) fail('Campaign ledger references an unknown reservation.');
      if (event.type === 'reservation_dispatching') {
        if (item.status !== 'reserved') fail('Campaign ledger has an invalid dispatch transition.');
        item.status = 'dispatching';
      } else if (event.type === 'reservation_settled') {
        if (!['dispatching', 'unresolved'].includes(item.status)) fail('Campaign ledger has an invalid settlement transition.');
        Object.assign(item, event, { status: 'settled' });
      } else if (event.type === 'reservation_unresolved') {
        if (!['dispatching', 'unresolved'].includes(item.status)) fail('Campaign ledger has an invalid unresolved transition.');
        Object.assign(item, event, { status: 'unresolved' });
      } else if (event.type === 'reservation_released') {
        if (item.status !== 'reserved') fail('Campaign ledger released a reservation after dispatch.');
        Object.assign(item, event, { status: 'released' });
      } else if (event.type === 'reservation_reconciled') {
        if (!['dispatching', 'unresolved'].includes(item.status) || typeof event.clientRequestId !== 'string' || reconciliationIds.has(event.clientRequestId)) fail('Campaign ledger has an invalid reconciliation transition.');
        reconciliationIds.add(event.clientRequestId);
        Object.assign(item, event, { status: 'reconciled' });
      }
      else fail('Campaign ledger contains an unknown event.');
    }
    return event;
  });
  const unsettled = [...reservations.values()].filter(item => ['reserved', 'dispatching', 'unresolved'].includes(item.status));
  if (unsettled.length) fail('Resolve reserved or uncertain campaign charges before exporting.', 'CAMPAIGN_UNSETTLED');
  return {
    format: 'offcut-campaign-export', version: 1, id: campaignId,
    rateSnapshotId: config.rateSnapshot?.id ?? null, rateSnapshotHash: config.rateSnapshot?.hash ?? null,
    rateBookId: config.rateBook?.id ?? null, rateBookHash: config.rateBook?.hash ?? null,
    rateSnapshots: (config.rateBook?.snapshots ?? []).map(snapshot => ({ id: snapshot.id, provider: snapshot.provider, hash: snapshot.hash })),
    limitMicros: config.limitMicros,
    reservations: [...reservations.values()].map(item => ({
      reservationId: item.reservationId, requestId: item.requestId, runId: item.runId, turn: item.turn,
      provider: item.provider ?? 'openai', requestedRoute: item.requestedRoute, status: item.status, reservedMicros: item.reservedMicros,
      ...(Number.isSafeInteger(item.chargeMicros) ? { chargeMicros: item.chargeMicros } : {}),
      ...(typeof item.returnedModel === 'string' ? { returnedModel: item.returnedModel } : {}),
      ...(typeof item.responseId === 'string' ? { responseId: item.responseId } : {}),
      ...(object(item.usage) ? { usage: clone(item.usage) } : {}),
      accountingComplete: ['settled', 'reconciled'].includes(item.status),
    })),
    recordHashes: { config: sha256(configBytes), ledger: sha256(ledgerBytes) },
    eventCount: events.length,
  };
}

async function assertNoLeaks(directory, dataDir) {
  for (const entry of await fileInventory(directory)) {
    if (!/\.(?:json|jsonl|md|csv|html|js|css)$/i.test(entry.path)) continue;
    const text = await readFile(join(directory, entry.path), 'utf8');
    if (text.includes(dataDir) || /(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~-]{8,})/i.test(text)) {
      fail(`Export file ${entry.path} contains a local path or credential-like value.`, 'STUDY_EXPORT_LEAK');
    }
  }
}

async function fileInventory(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail('Export output contains an unsafe file.');
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await fileInventory(join(directory, entry.name), rel));
    else if (rel !== 'checksums.json') {
      const bytes = await readFile(join(directory, entry.name));
      files.push({ path: rel, sha256: sha256(bytes), byteLength: bytes.length });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function relativeFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await relativeFiles(join(directory, entry.name), name));
    else if (entry.isFile()) files.push(name);
  }
  return files.sort();
}

/** Create a key-free, read-only study artifact without starting app services or providers. */
export async function exportStudy({ dataDir, studyId, outDir, analysisDir, annotationsDir } = {}) {
  if (![dataDir, outDir].every(value => typeof value === 'string' && isAbsolute(value)) || !STUDY.test(studyId)) fail('Use absolute data/output paths and a valid Study ID.');
  dataDir = resolve(dataDir); outDir = resolve(outDir);
  const relation = relative(dataDir, outDir);
  if (!relation || (!relation.startsWith('..') && !isAbsolute(relation))) fail('Export output must be outside the data root.');
  if (await readDataRootOwner(dataDir)) fail('Stop Offcut or use a verified backup before exporting.', 'DATA_ROOT_LOCKED');
  try { await stat(outDir); fail('Export output already exists.', 'STUDY_EXPORT_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const studyDir = join(dataDir, 'studies', studyId);
  const manifest = await json(join(studyDir, 'manifest.json'));
  const state = await json(join(studyDir, 'state.json'));
  if (manifest.id !== studyId || !HASH.test(manifest.manifestHash) || state.id !== studyId || state.manifestHash !== manifest.manifestHash) fail('Study manifest/state linkage is invalid.');
  const { manifestHash, ...immutable } = manifest;
  if (sha256(canonicalJSON(immutable)) !== manifestHash) fail('Study manifest hash mismatch.');
  if (['running', 'pausing', 'stopping'].includes(state.status)) fail('Only a settled Study can be exported.', 'STUDY_ACTIVE');

  const campaign = await readCampaignSnapshot(dataDir, manifest.campaign.id);
  const destination = outDir;
  const staging = `${destination}.staging-${randomUUID()}`;
  await mkdir(staging, { mode: 0o700 });
  try {
  const assets = {}, sourceCredits = [];
  for (const source of manifest.sources) {
    const bytes = await bounded(join(studyDir, 'assets', source.sha256), 16 * 1024 * 1024);
    if (sha256(bytes) !== source.sha256 || bytes.length !== source.byteLength) fail(`Frozen source ${source.id} failed integrity checks.`);
    await putAsset(staging, assets, bytes, source.mime);
    sourceCredits.push({ ...clone(source), assetPath: `assets/${source.sha256}` });
  }

  const cellById = new Map(manifest.cells.map(cell => [cell.cellId, cell]));
  const cells = [], works = [];
  for (const entry of state.entries) {
    const cell = cellById.get(entry.cellId);
    if (!cell) fail(`State references unknown cell ${entry.cellId}.`);
    const row = { cellId: entry.cellId, executionIndex: entry.executionIndex, status: entry.status, terminationReason: entry.terminationReason ?? null,
      runId: entry.runId ?? null, modelId: cell.modelId, promptId: cell.promptId, packId: cell.packId, repetition: cell.repetition, profileId: cell.profileId,
      provider: cell.spec.provider, requestedModel: cell.spec.model, returnedModel: null, responseIds: [], usage: [], accountingComplete: false,
      adapterProtocol: clone(manifest.protocolSnapshot?.adapters?.[cell.spec.provider] ?? null), workPath: null };
    if (entry.runId) {
      if (!RUN.test(entry.runId)) fail(`Cell ${entry.cellId} has an invalid run ID.`);
      const runDir = join(dataDir, 'runs', entry.runId);
      const run = await json(join(runDir, 'run.json'));
      if (run.study?.id !== studyId || run.study?.manifestHash !== manifestHash || run.study?.cellId !== entry.cellId) fail(`Run ${entry.runId} is linked to a different Study cell.`);
      if (!TERMINAL_RUN.has(run.status)) fail(`Run ${entry.runId} is not terminal.`, 'STUDY_ACTIVE');
      const rawProject = await json(join(runDir, 'project.json'));
      const project = await externalProject(rawProject, staging, assets);
      const events = (await bounded(join(runDir, 'events.jsonl'))).toString('utf8').split('\n').filter(Boolean).map((line, index) => {
        let event;
        try { event = JSON.parse(line); } catch { fail(`Run ${entry.runId} has invalid JSON on event line ${index + 1}.`); }
        if (!object(event) || event.sequence !== index + 1) fail(`Run ${entry.runId} has an invalid event sequence.`);
        return event;
      });
      for (const assetEntry of await readdir(join(runDir, 'assets'), { withFileTypes: true })) {
        if (!assetEntry.isFile() || !HASH.test(assetEntry.name)) continue;
        const bytes = await bounded(join(runDir, 'assets', assetEntry.name), 64 * 1024 * 1024);
        if (sha256(bytes) !== assetEntry.name) fail(`Run asset ${assetEntry.name} failed integrity checks.`);
        const description = events.flatMap(event => event.images ?? []).find(image => image.sha256 === assetEntry.name);
        await putAsset(staging, assets, bytes, description?.mime ?? 'image/png');
      }
      const replayAssets = Object.fromEntries(Object.entries(assets).map(([key, value]) => [key, { ...value, bytes: null }]));
      for (const source of project.sources) replayAssets[source.assetSha256].bytes = await readFile(join(staging, assets[source.assetSha256].path));
      const finalState = replay(project, replayAssets);
      const finalPNG = await renderPNG(finalState);
      const base = `works/${entry.cellId}`;
      for (const value of [run, project, events]) safeTree(value, dataDir);
      await writeJSON(join(staging, base, 'run.json'), run);
      await writeJSON(join(staging, base, 'project.json'), project);
      await writeJSON(join(staging, base, 'events.json'), events);
      await mkdir(join(staging, base), { recursive: true, mode: 0o700 });
      await writeFile(join(staging, base, 'final.png'), finalPNG, { flag: 'wx', mode: 0o600 });
      const returnedModels = [...new Set(events.filter(event => event.type === 'model_output' && typeof event.model === 'string').map(event => event.model))];
      row.returnedModel = returnedModels.length ? returnedModels.join(', ') : null;
      const outputs = events.filter(event => event.type === 'model_output');
      row.responseIds = [...new Set(outputs.map(event => event.responseId).filter(value => typeof value === 'string'))];
      row.usage = outputs.map(event => ({ turn: event.turn, usage: clone(event.usage ?? null), usageIncomplete: event.usageIncomplete !== false }));
      const reservations = campaign.reservations.filter(item => item.runId === entry.runId);
      row.accountingComplete = reservations.length > 0 && reservations.every(item => item.accountingComplete);
      const requestedTurns = new Set(events.filter(event => event.type === 'request').map(event => event.turn));
      const outputTurns = new Set(outputs.map(event => event.turn));
      const resultByTurn = new Map(events.filter(event => event.type === 'batch_result').map(event => [event.turn, event]));
      row.qualification = {
        nativeImage: events.filter(event => event.type === 'request').every(event => event.request?.messages?.some(message => Array.isArray(message.images) && message.images.length > 0) && outputTurns.has(event.turn)) && requestedTurns.size > 0,
        parseableActionJSON: outputs.length > 0 && outputs.every(event => { const result = resultByTurn.get(event.turn); return Boolean(result && result.failureStage !== 'parse'); }),
        completeUsage: outputs.length > 0 && outputs.every(event => event.usageIncomplete === false),
        settledUsage: row.accountingComplete,
        deterministicReplay: project.cursor === project.actions.length,
      };
      row.workPath = base;
      works.push({ cellId: entry.cellId, runId: entry.runId, status: entry.status, title: finalState.title, statement: finalState.statement, finalImage: `${base}/final.png`, events: `${base}/events.json`, project: `${base}/project.json` });
    }
    cells.push(row);
  }
  if (cells.length !== manifest.executionOrder.length || cells.some((cell, index) => cell.cellId !== manifest.executionOrder[index])) fail('The complete cell table does not match the frozen execution order.');

  const qualifications = { format: 'offcut-study-qualification-evidence', version: 1, studyId, manifestHash, routes: [...new Set(cells.map(cell => `${cell.provider}\n${cell.requestedModel}`))].map(key => { const [provider, requestedRoute] = key.split('\n'), evidence = cells.filter(cell => cell.provider === provider && cell.requestedModel === requestedRoute && cell.runId).map(cell => ({ cellId: cell.cellId, runId: cell.runId, status: cell.status, returnedModel: cell.returnedModel, responseIds: cell.responseIds, usage: cell.usage, accountingComplete: cell.accountingComplete, adapterProtocol: cell.adapterProtocol, ...cell.qualification })); return { provider, requestedRoute, evidence }; }) };
  for (const value of [manifest, state, campaign, sourceCredits, cells, works, qualifications]) safeTree(value, dataDir);
  await writeJSON(join(staging, 'study', 'manifest.json'), manifest);
  await writeJSON(join(staging, 'study', 'state.json'), state);
  await writeJSON(join(staging, 'campaign.json'), campaign);
  await writeJSON(join(staging, 'sources.json'), sourceCredits);
  await writeJSON(join(staging, 'assets.json'), assets);
  await writeJSON(join(staging, 'qualifications.json'), qualifications);
  const hasAnalysis = await copyOptionalTree(analysisDir, join(staging, 'analysis'));
  const hasAnnotations = await copyOptionalTree(annotationsDir, join(staging, 'annotations'));
  for (const name of ['index.html', 'app.js', 'style.css']) await copyFile(join(ROOT, 'public', 'study-export', name), join(staging, name));
  const exportIndex = { format: 'offcut-study-export', version: 1, studyId, manifestHash, createdAt: new Date().toISOString(), campaign: 'campaign.json', manifest: 'study/manifest.json', state: 'study/state.json', sources: 'sources.json', assets: 'assets.json', qualifications: 'qualifications.json', cells, works,
    ...(hasAnalysis ? { analysis: { path: 'analysis', files: await relativeFiles(join(staging, 'analysis')) } } : {}),
    ...(hasAnnotations ? { annotations: { path: 'annotations', files: await relativeFiles(join(staging, 'annotations')) } } : {}) };
  safeTree(exportIndex, dataDir);
  await writeJSON(join(staging, 'export.json'), exportIndex);
  await assertNoLeaks(staging, dataDir);
  const files = await fileInventory(staging);
  await writeJSON(join(staging, 'checksums.json'), { format: 'offcut-study-export-checksums', version: 1, files });
  await rename(staging, destination);
  return { directory: destination, studyId, cells: cells.length, attempted: works.length, assets: Object.keys(assets).length, files: files.length };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Verify hashes, cell/run linkage, current code compatibility, and final replay pixels. */
export async function verifyStudyExport(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) fail('Use an absolute export directory.');
  directory = resolve(directory);
  const checksums = await json(join(directory, 'checksums.json'));
  const actual = await fileInventory(directory);
  if (canonicalJSON(actual) !== canonicalJSON(checksums.files)) fail('Export checksum inventory mismatch.', 'STUDY_EXPORT_CHECKSUM');
  const index = await json(join(directory, 'export.json'));
  const manifest = await json(safeJoin(directory, index.manifest, 'manifest path'));
  const state = await json(safeJoin(directory, index.state, 'state path'));
  if (index.studyId !== manifest.id || index.manifestHash !== manifest.manifestHash || state.manifestHash !== manifest.manifestHash) fail('Export Study linkage mismatch.');
  const { manifestHash, ...immutable } = manifest;
  if (!HASH.test(manifestHash) || sha256(canonicalJSON(immutable)) !== manifestHash) fail('Export Study manifest hash mismatch.');
  if (index.cells.length !== manifest.executionOrder.length || index.cells.some((cell, position) => cell.cellId !== manifest.executionOrder[position])) fail('Export cell table is incomplete or reordered.');
  const qualifications = await json(safeJoin(directory, index.qualifications, 'qualification path'));
  if (qualifications.format !== 'offcut-study-qualification-evidence' || qualifications.version !== 1 || qualifications.studyId !== index.studyId || qualifications.manifestHash !== manifestHash || !Array.isArray(qualifications.routes)) fail('Export qualification evidence is invalid.');
  for (const route of qualifications.routes) {
    if (typeof route.provider !== 'string' || typeof route.requestedRoute !== 'string' || !Array.isArray(route.evidence)) fail('Export route qualification is invalid.');
    for (const evidence of route.evidence) {
      const cell = index.cells.find(item => item.cellId === evidence.cellId);
      if (!cell || cell.runId !== evidence.runId || cell.provider !== route.provider || cell.requestedModel !== route.requestedRoute) fail('Export qualification linkage mismatch.');
    }
  }
  for (const file of manifest.protocolSnapshot.executionFiles ?? []) {
    if (!object(file) || typeof file.path !== 'string' || !/^(?:lib|public)\/[A-Za-z0-9._/-]+$/.test(file.path) || file.path.includes('..') || !HASH.test(file.sha256 ?? '')) fail('Recorded implementation inventory is invalid.');
    if (sha256(await readFile(safeJoin(ROOT, file.path, 'implementation path'))) !== file.sha256) fail('The current code does not match the recorded Study implementation.', 'CODE_MISMATCH');
  }
  const assetIndex = await json(join(directory, 'assets.json'));
  const assets = {};
  for (const [hash, descriptor] of Object.entries(assetIndex)) {
    if (!HASH.test(hash) || !object(descriptor) || descriptor.sha256 !== hash || !Number.isSafeInteger(descriptor.byteLength) || typeof descriptor.mime !== 'string') fail('Export asset index is invalid.');
    const bytes = await bounded(safeJoin(directory, descriptor.path, 'asset path'), 64 * 1024 * 1024);
    if (sha256(bytes) !== hash || bytes.length !== descriptor.byteLength) fail(`Export asset ${hash} failed verification.`);
    assets[hash] = { ...descriptor, bytes };
  }
  for (const work of index.works) {
    const cell = index.cells.find(item => item.cellId === work.cellId);
    if (!cell || cell.runId !== work.runId || cell.workPath !== `works/${work.cellId}`) fail('Export work/cell linkage mismatch.');
    const run = await json(safeJoin(directory, `${cell.workPath}/run.json`, 'run path'));
    if (run.id !== work.runId || run.study?.id !== index.studyId || run.study?.manifestHash !== manifestHash || run.study?.cellId !== work.cellId) fail('Export run linkage mismatch.');
    const project = await json(safeJoin(directory, work.project, 'project path'));
    const final = await bounded(safeJoin(directory, work.finalImage, 'final image path'), 64 * 1024 * 1024);
    if (!Buffer.from(await renderPNG(replay(project, assets))).equals(final)) fail(`Final rendering mismatch for ${work.cellId}.`);
  }
  return { valid: true, studyId: index.studyId, cells: index.cells.length, attempted: index.works.length, assets: Object.keys(assets).length };
}
