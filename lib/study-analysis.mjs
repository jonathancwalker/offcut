import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeCollage, materialReuseJaccard } from './collage-metrics.mjs';
import { applyAction, createState } from './engine.mjs';

export const STUDY_ANALYSIS_VERSION = 1;
const STUDY_ID = /^study-[a-f0-9-]{36}$/;
const CELL_ID = /^cell-[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const RUN_ID = /^run-[a-f0-9-]{36}$/;
const TERMINAL = new Set(['completed', 'limit_reached', 'failed', 'stopped', 'interrupted']);
const ENTRY_STATUS = new Set(['queued', 'starting', 'running', ...TERMINAL, 'not_run']);
const EVENT_TYPES = new Set(['run_started', 'observation', 'request', 'model_output', 'batch_result', 'final_review', 'termination', 'budget_denied', 'error', 'recovery']);
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Study records contain non-canonical JSON.');
  return JSON.stringify(value);
}
const manifestDigest = manifest => sha256(Buffer.from(canonicalJSON(Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'manifestHash')))));

function issue(code, detail, extra = {}) { return { code, detail, ...extra }; }

function parseJSON(bytes, label) {
  try { return JSON.parse(bytes); }
  catch { throw new Error(`${label} is not valid JSON.`); }
}

function validateManifest(manifest, studyId) {
  if (!object(manifest) || manifest.format !== 'offcut-study' || manifest.version !== 1 || manifest.id !== studyId || !HASH.test(manifest.manifestHash ?? '') || manifestDigest(manifest) !== manifest.manifestHash) {
    throw new Error('Study manifest identity or version is invalid.');
  }
  if (!Array.isArray(manifest.cells) || !manifest.cells.length || !Array.isArray(manifest.executionOrder)) throw new Error('Study manifest needs cells and an execution order.');
  const ids = new Set();
  for (const cell of manifest.cells) {
    if (!object(cell) || !CELL_ID.test(cell.cellId ?? '') || ids.has(cell.cellId)
      || !['modelId', 'promptId', 'packId', 'profileId'].every(key => typeof cell[key] === 'string' && cell[key])
      || !Number.isInteger(cell.repetition) || cell.repetition < 1
      || !object(cell.spec) || typeof cell.spec.model !== 'string'
      || !Array.isArray(cell.sourceIds) || !cell.sourceIds.length || !object(cell.sourceHashes)) throw new Error('Study manifest contains an invalid cell.');
    if (cell.sourceIds.some(id => typeof id !== 'string' || !HASH.test(cell.sourceHashes[id] ?? ''))
      || Object.keys(cell.sourceHashes).length !== cell.sourceIds.length) throw new Error(`Cell ${cell.cellId} has an invalid source manifest.`);
    ids.add(cell.cellId);
  }
  if (manifest.executionOrder.length !== ids.size || new Set(manifest.executionOrder).size !== ids.size
    || manifest.executionOrder.some(id => !ids.has(id))) throw new Error('Study execution order does not contain each cell exactly once.');
  return manifest;
}

/** PR07 state adapter: only the shared documented entry fields are consumed. */
export function normalizeStudyEntries(state, cells, studyId = null, manifestHash = null) {
  if (!object(state) || state.format !== 'offcut-study-state' || state.version !== 1 || (studyId !== null && state.id !== studyId) || (manifestHash !== null && state.manifestHash !== manifestHash) || !Array.isArray(state.entries)) throw new Error('Study state identity or entries are invalid.');
  const known = new Set(cells.map(cell => cell.cellId));
  const entries = new Map();
  if (state.entries.length !== cells.length) throw new Error('Study state entries do not match the frozen cell count.');
  for (const [index, entry] of state.entries.entries()) {
    if (!object(entry) || !known.has(entry.cellId) || entries.has(entry.cellId) || !ENTRY_STATUS.has(entry.status)
      || entry.executionIndex !== index || entry.cellId !== cells[index].cellId
      || (entry.runId !== null && entry.runId !== undefined && !RUN_ID.test(entry.runId))) throw new Error('Study state contains an invalid, reordered, or duplicate entry.');
    entries.set(entry.cellId, { cellId: entry.cellId, status: entry.status, runId: entry.runId ?? null });
  }
  return entries;
}

function labels(manifest) {
  const draft = manifest.plan?.normalizedDraft ?? manifest.normalizedDraft;
  const map = collection => new Map((draft?.[collection] ?? []).map(item => [item.id, item.label]));
  return { models: map('models'), prompts: map('prompts'), packs: map('packs'), profiles: map('profiles') };
}

function dataUrlBytes(dataUrl) {
  const match = typeof dataUrl === 'string' && /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match || !match[1] || match[1].length % 4) throw new Error('Run source is not a supported embedded raster image.');
  return Buffer.from(match[1], 'base64');
}

function parseEvents(bytes) {
  const lines = bytes.toString('utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const events = lines.map((line, index) => {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error(`Unreadable JSON on event line ${index + 1}.`); }
    if (!object(event) || event.sequence !== index + 1 || (event.turn !== undefined && (!Number.isSafeInteger(event.turn) || event.turn < 1))) throw new Error(`Event sequence or turn mismatch on line ${index + 1}.`);
    return event;
  });
  validateEvents(events);
  return events;
}

function validateEvents(events, summary = null) {
  if (!Array.isArray(events)) throw new Error('Run events must be an array.');
  if (events.length && events[0]?.type !== 'run_started') throw new Error('Run event history must begin with run_started.');
  const requests = new Map();
  for (const [index, event] of events.entries()) {
    if (!object(event) || event.sequence !== index + 1 || (event.turn !== undefined && (!Number.isSafeInteger(event.turn) || event.turn < 1))) throw new Error(`Event sequence or turn mismatch on line ${index + 1}.`);
    if (!EVENT_TYPES.has(event.type)) throw new Error(`Unknown run event type ${String(event.type)}.`);
    if (event.type === 'request') {
      if (requests.has(event.turn)) throw new Error(`Duplicate request turn ${event.turn}.`);
      requests.set(event.turn, { index, output: false, result: false });
    } else if (event.type === 'model_output' || event.type === 'batch_result') {
      const turn = requests.get(event.turn);
      if (!turn) throw new Error(`Event ${event.type} has no preceding request.`);
      if (event.type === 'model_output') { if (turn.output || turn.result || index <= [...requests.values()].find(value => value === turn).index) throw new Error('Model output ordering is invalid.'); turn.output = true; }
      else { if (!turn.output || turn.result) throw new Error('Batch result ordering is invalid.'); turn.result = true; }
    } else if (event.type === 'budget_denied') {
      const turn = event.turn === undefined ? null : requests.get(event.turn);
      if (turn && (turn.output || turn.result)) throw new Error('Budget denial ordering is invalid.');
      if (turn) { turn.result = true; turn.budgetDenied = true; }
    } else if (event.type === 'termination' && index !== events.length - 1) throw new Error('Termination must be the final event.');
  }
  const terminal = events.at(-1)?.type === 'termination';
  for (const turn of requests.values()) if ((!turn.result && !terminal) || (!turn.output && !turn.budgetDenied && !terminal)) throw new Error('Each request must have a completed result or a terminal failure.');
  if (terminal && summary) {
    const final = events.at(-1);
    if (final.status !== summary.status || (final.reason ?? null) !== (summary.terminationReason ?? null)) throw new Error('Termination evidence does not match the run summary.');
  }
  return true;
}

function outputDecisionNote(event) {
  if (typeof event?.decision_note === 'string') return event.decision_note;
  if (typeof event?.text !== 'string') return null;
  try {
    const parsed = JSON.parse(event.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    return typeof parsed?.decision_note === 'string' ? parsed.decision_note : null;
  } catch { return null; }
}

function acceptedActions(events) {
  return events.filter(event => event.type === 'batch_result' && event.accepted === true).flatMap(event => {
    if (!Array.isArray(event.actions)) throw new Error('Accepted batch result is missing its actions array.');
    return event.actions.map(action => {
      if (!object(action) || typeof action.type !== 'string') throw new Error('Accepted batch result contains a malformed action.');
      return action;
    });
  });
}

function replayProject(project, events, summary = null) {
  if (!object(project) || !Array.isArray(project.sources) || !Array.isArray(project.actions)) throw new Error('Run project checkpoint is invalid.');
  validateEvents(events, summary);
  const actions = acceptedActions(events);
  const checkpoint = project.actions.map(record => record?.action);
  if (JSON.stringify(checkpoint) !== JSON.stringify(actions) || project.cursor !== actions.length) throw new Error('Run checkpoint differs from committed accepted actions.');
  let state = createState({ id: project.id, sources: project.sources, rules: project.rules, canvas: project.canvas });
  let cursor = 0;
  for (const event of events.filter(item => item.type === 'batch_result')) {
    const batch = event.accepted === true ? event.actions : [];
    if (event.accepted === true && !Array.isArray(batch)) throw new Error('Accepted batch result is missing its actions array.');
    if (event.fromStep !== undefined && event.fromStep !== cursor) throw new Error('Accepted action step continuity is invalid.');
    if (event.step !== undefined && event.step !== cursor + batch.length) throw new Error('Batch result step continuity is invalid.');
    if (event.accepted === true) cursor += batch.length;
  }
  for (const action of actions) state = applyAction(state, action);
  return { state, actions };
}

function verifySources(project, cell) {
  if (project.sources.length !== cell.sourceIds.length || project.sources.some((source, index) => source.id !== cell.sourceIds[index])) {
    throw new Error('Run sources differ from the frozen cell source order.');
  }
  for (const source of project.sources) if (sha256(dataUrlBytes(source.dataUrl)) !== cell.sourceHashes[source.id]) {
    throw new Error(`Run source ${source.id} differs from the frozen cell hash.`);
  }
}

function recoveryRows(cell, runId, events) {
  const requests = events.filter(event => event.type === 'request' && Number.isSafeInteger(event.turn)).sort((a, b) => a.turn - b.turn);
  const results = new Map(events.filter(event => event.type === 'batch_result' && Number.isSafeInteger(event.turn)).map(event => [event.turn, event]));
  return events.filter(event => event.type === 'batch_result' && event.accepted === false).map(rejected => {
    const next = requests.find(request => request.turn > rejected.turn) ?? null;
    const nextResult = next ? results.get(next.turn) ?? null : null;
    const nextAccepted = nextResult?.accepted === true;
    const nextActions = nextAccepted && Array.isArray(nextResult.actions) ? nextResult.actions : [];
    return {
      cellId: cell.cellId,
      runId,
      rejectedTurn: rejected.turn,
      failureStage: rejected.failureStage ?? null,
      code: rejected.code ?? null,
      failedActionIndex: Number.isInteger(rejected.failedActionIndex) ? rejected.failedActionIndex : null,
      nextRequestedTurn: next?.turn ?? null,
      primaryRecovery: next ? nextAccepted : null,
      nextAcceptedGeometricBatch: next ? nextAccepted && nextActions.some(action => action?.type === 'cut' || action?.type === 'trim') : null,
    };
  });
}

function runEvidence(summary, events, accounting = null) {
  const requests = events.filter(event => event.type === 'request').length;
  const outputs = events.filter(event => event.type === 'model_output');
  const results = events.filter(event => event.type === 'batch_result');
  const notedTurns = new Set();
  for (const event of events) {
    const note = event.type === 'model_output' ? outputDecisionNote(event) : event.type === 'batch_result' && event.accepted === true ? event.decision_note : null;
    if (typeof note === 'string' && note.trim()) notedTurns.add(Number.isSafeInteger(event.turn) ? `turn:${event.turn}` : `event:${event.sequence}`);
  }
  const notes = notedTurns.size;
  const returnedModels = [...new Set(outputs.map(event => event.model).filter(value => typeof value === 'string' && value))].sort(compare);
  const noProviderRequest = requests === 0 && outputs.length === 0;
  const chargeMicros = noProviderRequest ? 0 : accounting?.chargeMicros ?? null;
  const costUSD = chargeMicros !== null ? chargeMicros / 1_000_000 : null;
  return {
    requestedModel: summary.spec?.model ?? null,
    returnedModels,
    requestedTurns: requests,
    returnedResponses: outputs.length,
    rejectedTurns: results.filter(event => event.accepted === false).length,
    turnsWithNotes: notes,
    noteDenominator: outputs.length,
    costUSD,
    costComplete: noProviderRequest || accounting?.complete === true,
    usageIncomplete: summary.usageIncomplete !== false,
    chargeMicros,
    costUnresolved: !noProviderRequest && accounting?.complete !== true,
  };
}

function describe(values, denominatorCells) {
  const present = values.filter(Number.isFinite).sort((a, b) => a - b);
  return { denominatorCells, observed: present.length, missing: denominatorCells - present.length, values: present };
}

function groupDistributions(cells, key) {
  const grouped = new Map();
  for (const cell of cells) {
    const value = cell[key];
    if (!grouped.has(value)) grouped.set(value, []);
    grouped.get(value).push(cell);
  }
  return Object.fromEntries([...grouped].sort(([a], [b]) => compare(a, b)).map(([id, rows]) => [id, {
    cells: rows.length,
    measured: rows.filter(row => row.measurements).length,
    coverage: describe(rows.map(row => row.measurements?.coverage), rows.length),
    materialBreadth: describe(rows.map(row => row.measurements?.materialBreadth), rows.length),
    contributingPieces: describe(rows.map(row => row.measurements?.contributingPieces), rows.length),
  }]));
}

function statusCounts(cells, key) {
  const counts = {};
  for (const cell of cells) counts[cell[key]] = (counts[cell[key]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => compare(a, b)));
}

/** Analyze explicit immutable-manifest, scheduler-entry and stable-run inputs. */
export async function analyzeStudySnapshot({ manifest, entries, runs, manifestBytesHash = null, stateBytesHash = null, generatedAt = new Date().toISOString(), assetIssues = [], accounting = new Map() }) {
  validateManifest(manifest, manifest.id);
  const entryMap = entries instanceof Map ? entries : normalizeStudyEntries({ format: 'offcut-study-state', version: 1, id: manifest.id, manifestHash: manifest.manifestHash, entries }, manifest.cells, manifest.id, manifest.manifestHash);
  const cellMap = new Map(manifest.cells.map(cell => [cell.cellId, cell]));
  const runByCell = new Map();
  const reportIssues = [...assetIssues];
  for (const run of runs) {
    const provenance = run.summary?.study;
    if (!provenance || provenance.id !== manifest.id) continue;
    if (!cellMap.has(provenance.cellId)) { reportIssues.push(issue('UNKNOWN_CELL_RUN', `Run ${run.summary.id} refers to a cell outside this manifest.`, { runId: run.summary.id })); continue; }
    if (runByCell.has(provenance.cellId)) { reportIssues.push(issue('DUPLICATE_CELL_RUN', `More than one run refers to ${provenance.cellId}.`, { cellId: provenance.cellId })); continue; }
    runByCell.set(provenance.cellId, run);
  }
  const badAssetCells = new Set(assetIssues.flatMap(item => item.cellIds ?? []));
  const order = new Map(manifest.executionOrder.map((id, index) => [id, index]));
  const outputCells = [];
  const recoveries = [];
  for (const cell of manifest.cells) {
    const entry = entryMap.get(cell.cellId) ?? { cellId: cell.cellId, status: 'missing', runId: null };
    const run = runByCell.get(cell.cellId);
    const row = {
      cellId: cell.cellId,
      executionIndex: order.get(cell.cellId),
      modelId: cell.modelId,
      promptId: cell.promptId,
      packId: cell.packId,
      repetition: cell.repetition,
      profileId: cell.profileId,
      entryStatus: entry.status,
      runId: entry.runId ?? run?.summary?.id ?? null,
      outcome: run?.summary?.status ?? (entry.status === 'not_run' ? 'not_run' : null),
      terminationReason: run?.summary?.terminationReason ?? null,
      analysisStatus: 'not_measured',
      evidence: null,
      measurements: null,
      issues: [],
      recordHashes: run?.recordHashes ?? null,
    };
    if (!entryMap.has(cell.cellId)) row.issues.push(issue('MISSING_ENTRY', 'The scheduler state has no entry for this manifest cell.'));
    if (entry.runId && (!run || run.summary.id !== entry.runId)) row.issues.push(issue('RUN_LINK_MISSING', 'The scheduler run link has no matching stable run record.'));
    if (run && entry.runId && run.summary.id !== entry.runId) {
      row.issues.push(issue('RUN_LINK_MISMATCH', 'The scheduler and run records link different run IDs.'));
      row.analysisStatus = 'invalid';
      outputCells.push(row);
      continue;
    }
    if (!run) {
      row.analysisStatus = entry.status === 'not_run' ? 'not_run' : ENTRY_STATUS.has(entry.status) && !TERMINAL.has(entry.status) ? 'unsettled' : 'missing';
      outputCells.push(row);
      continue;
    }
    if (run.skippedReason) {
      row.analysisStatus = 'skipped';
      row.issues.push(issue('RUN_SKIPPED', run.skippedReason));
      outputCells.push(row);
      continue;
    }
    if (run.summary.study.manifestHash !== manifest.manifestHash || run.summary.study.cellId !== cell.cellId) {
      row.analysisStatus = 'invalid';
      row.issues.push(issue('MANIFEST_MISMATCH', 'Run study provenance does not match the immutable manifest.'));
      outputCells.push(row);
      continue;
    }
    if (!TERMINAL.has(run.summary.status)) {
      row.analysisStatus = 'skipped';
      row.issues.push(issue('RUN_ACTIVE', 'Run is not terminal and was not measured.'));
      outputCells.push(row);
      continue;
    }
    if (badAssetCells.has(cell.cellId)) {
      row.analysisStatus = 'invalid';
      row.issues.push(issue('FROZEN_ASSET_INVALID', 'A frozen source asset for this cell is missing or corrupt.'));
      outputCells.push(row);
      continue;
    }
    try {
      verifySources(run.project, cell);
      const replay = replayProject(run.project, run.events, run.summary);
      row.evidence = runEvidence(run.summary, run.events, accounting.get(run.summary.id) ?? null);
      row.measurements = await analyzeCollage({ state: replay.state, acceptedActions: replay.actions });
      row.analysisStatus = 'measured';
      recoveries.push(...recoveryRows(cell, run.summary.id, run.events));
    } catch (error) {
      row.analysisStatus = 'invalid';
      row.issues.push(issue('RUN_RECORD_INVALID', error.message));
    }
    outputCells.push(row);
  }
  outputCells.sort((a, b) => a.executionIndex - b.executionIndex);
  const pairwiseMaterialReuse = [];
  const byPack = new Map();
  for (const cell of outputCells.filter(row => row.measurements)) {
    if (!byPack.has(cell.packId)) byPack.set(cell.packId, []);
    byPack.get(cell.packId).push(cell);
  }
  for (const [packId, packCells] of [...byPack].sort(([a], [b]) => compare(a, b))) {
    packCells.sort((a, b) => compare(a.cellId, b.cellId));
    for (let first = 0; first < packCells.length; first++) for (let second = first + 1; second < packCells.length; second++) {
      pairwiseMaterialReuse.push({ packId, firstCellId: packCells[first].cellId, secondCellId: packCells[second].cellId, jaccard: materialReuseJaccard(packCells[first].measurements, packCells[second].measurements) });
    }
  }
  const totalNotes = outputCells.reduce((sum, cell) => sum + (cell.evidence?.turnsWithNotes ?? 0), 0);
  const noteDenominator = outputCells.reduce((sum, cell) => sum + (cell.evidence?.noteDenominator ?? 0), 0);
  const costKnown = outputCells.filter(cell => cell.evidence?.costComplete).length;
  return {
    report: {
      format: 'offcut-study-analysis',
      version: STUDY_ANALYSIS_VERSION,
      generatedAt,
      studyId: manifest.id,
      manifestHash: manifest.manifestHash,
      inputHashes: { manifest: manifestBytesHash, state: stateBytesHash, runs: Object.fromEntries(runs.filter(run => run.summary?.id && run.recordHashes).map(run => [run.summary.id, run.recordHashes]).sort(([a], [b]) => compare(a, b))) },
      counts: { cells: outputCells.length, entryStatus: statusCounts(outputCells, 'entryStatus'), analysisStatus: statusCounts(outputCells, 'analysisStatus') },
      noteAvailability: { turnsWithNotes: totalNotes, returnedResponseDenominator: noteDenominator },
      costCompleteness: { completeCells: costKnown, unresolvedCells: outputCells.filter(cell => cell.evidence?.costUnresolved).length, runCellDenominator: outputCells.filter(cell => cell.runId).length },
      distributions: { byPack: groupDistributions(outputCells, 'packId'), byPrompt: groupDistributions(outputCells, 'promptId') },
      pairwiseMaterialReuse,
      recoveries,
      cells: outputCells,
      issues: reportIssues,
      interpretation: [
        'Measurements describe recorded material use and composition; they do not score artistic merit or infer hidden reasoning.',
        'Pairwise Jaccard values are dependent summaries within a source pack, not additional independent runs.',
      ],
    },
    measurements: {
      format: 'offcut-study-measurements',
      version: STUDY_ANALYSIS_VERSION,
      studyId: manifest.id,
      manifestHash: manifest.manifestHash,
      cells: outputCells.map(cell => ({ cellId: cell.cellId, analysisStatus: cell.analysisStatus, measurements: cell.measurements })),
      pairwiseMaterialReuse,
    },
  };
}

async function stableFiles(paths, { afterSnapshot, kind, id } = {}) {
  const first = await Promise.all(paths.map(path => readFile(path)));
  await afterSnapshot?.({ kind, id, paths: [...paths] });
  const second = await Promise.all(paths.map(path => readFile(path)));
  if (first.some((bytes, index) => sha256(bytes) !== sha256(second[index]))) throw new Error('Record changed during analysis; retry after it is settled.');
  return { bytes: first, hashes: first.map(sha256) };
}

export async function campaignAccounting(dataRoot, campaignId, afterSnapshot) {
  const accounting = new Map();
  if (typeof campaignId !== 'string') return accounting;
  const base = join(dataRoot, 'campaigns', campaignId);
  let snapshot;
  try { snapshot = await stableFiles([join(base, 'config.json'), join(base, 'ledger.jsonl')], { afterSnapshot, kind: 'campaign', id: campaignId }); }
  catch (error) { if (error.code === 'ENOENT') return accounting; throw error; }
  const config = parseJSON(snapshot.bytes[0], 'Campaign config');
  if (config.format !== 'offcut-campaign' || ![1, 2].includes(config.version) || config.id !== campaignId) throw new Error('Campaign config identity is invalid.');
  let previousHash = null;
  const reservations = new Map();
  const lines = snapshot.bytes[1].toString('utf8').split('\n').filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const event = parseJSON(Buffer.from(line), 'Campaign ledger event');
    const { eventHash, ...unsigned } = event;
    const expected = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
    if (event.sequence !== index + 1 || event.previousHash !== previousHash || eventHash !== expected) throw new Error('Campaign ledger hash chain is invalid.');
    previousHash = eventHash;
    if (event.type === 'reservation_created') {
      if (reservations.has(event.reservationId) || typeof event.runId !== 'string') throw new Error('Campaign ledger contains a duplicate or invalid reservation.');
      reservations.set(event.reservationId, { ...event, status: 'reserved' });
    }
    else {
      const item = reservations.get(event.reservationId);
      if (!item) throw new Error('Campaign ledger references an unknown reservation.');
      if (event.type === 'reservation_dispatching' && item.status === 'reserved') item.status = 'dispatching';
      else if (event.type === 'reservation_settled' && ['dispatching', 'unresolved'].includes(item.status)) Object.assign(item, event, { status: 'settled' });
      else if (event.type === 'reservation_unresolved' && ['dispatching', 'unresolved'].includes(item.status)) Object.assign(item, event, { status: 'unresolved' });
      else if (event.type === 'reservation_reconciled' && ['dispatching', 'unresolved'].includes(item.status)) Object.assign(item, event, { status: 'reconciled' });
      else if (event.type === 'reservation_released' && item.status === 'reserved') item.status = 'released';
      else throw new Error('Campaign ledger contains an unknown event.');
    }
  }
  const byRun = new Map();
  for (const item of reservations.values()) {
    if (!byRun.has(item.runId)) byRun.set(item.runId, []);
    byRun.get(item.runId).push(item);
  }
  for (const [runId, items] of byRun) {
    const complete = items.every(item => ['settled', 'reconciled', 'released'].includes(item.status));
    const charges = items.filter(item => ['settled', 'reconciled'].includes(item.status)).map(item => item.chargeMicros);
    const chargesValid = charges.every(value => Number.isSafeInteger(value) && value >= 0);
    accounting.set(runId, { status: complete && chargesValid ? 'complete' : 'unresolved', complete: complete && chargesValid, chargeMicros: complete && chargesValid ? charges.reduce((sum, value) => sum + value, 0) : null, reservations: items.length });
  }
  return accounting;
}

/** Read study/run files directly. This module never initializes a server or provider. */
export async function analyzeStudyDirectory({ dataRoot, studyId, generatedAt, afterSnapshot } = {}) {
  if (typeof dataRoot !== 'string' || !dataRoot || !STUDY_ID.test(studyId ?? '')) throw new Error('Use an absolute data root and a normalized study ID.');
  const studyDirectory = join(dataRoot, 'studies', studyId);
  const studySnapshot = await stableFiles([join(studyDirectory, 'manifest.json'), join(studyDirectory, 'state.json')], { afterSnapshot, kind: 'study', id: studyId });
  const manifest = validateManifest(parseJSON(studySnapshot.bytes[0], 'Study manifest'), studyId);
  const cellsById = new Map(manifest.cells.map(cell => [cell.cellId, cell]));
  const scheduledCells = manifest.executionOrder.map(cellId => cellsById.get(cellId));
  const entries = normalizeStudyEntries(parseJSON(studySnapshot.bytes[1], 'Study state'), scheduledCells, manifest.id, manifest.manifestHash);
  const assetCells = new Map();
  for (const cell of manifest.cells) for (const hash of Object.values(cell.sourceHashes)) {
    if (!assetCells.has(hash)) assetCells.set(hash, []);
    assetCells.get(hash).push(cell.cellId);
  }
  const assetIssues = [];
  for (const [hash, cellIds] of [...assetCells].sort(([a], [b]) => compare(a, b))) {
    try {
      const bytes = await readFile(join(studyDirectory, 'assets', hash));
      if (sha256(bytes) !== hash) assetIssues.push(issue('ASSET_CORRUPT', `Frozen source asset ${hash} differs from its recorded hash.`, { hash, cellIds }));
    } catch {
      assetIssues.push(issue('ASSET_MISSING', `Frozen source asset ${hash} could not be read.`, { hash, cellIds }));
    }
  }
  const accounting = await campaignAccounting(dataRoot, manifest.campaign?.id, afterSnapshot);
  const runs = [];
  const runRoot = join(dataRoot, 'runs');
  let directories = [];
  try { directories = await readdir(runRoot, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const directory of directories.filter(entry => entry.isDirectory() && RUN_ID.test(entry.name)).sort((a, b) => compare(a.name, b.name))) {
    const base = join(runRoot, directory.name);
    const paths = [join(base, 'run.json'), join(base, 'events.jsonl'), join(base, 'project.json')];
    try {
      const snapshot = await stableFiles(paths, { afterSnapshot, kind: 'run', id: directory.name });
      const summary = parseJSON(snapshot.bytes[0], `Run ${directory.name} summary`);
      if (summary.study?.id !== studyId) continue;
      const record = { summary, events: parseEvents(snapshot.bytes[1]), project: parseJSON(snapshot.bytes[2], `Run ${directory.name} project`), recordHashes: { summary: snapshot.hashes[0], events: snapshot.hashes[1], project: snapshot.hashes[2] } };
      if (!TERMINAL.has(summary.status)) record.skippedReason = 'Run is active or otherwise unsettled.';
      runs.push(record);
    } catch (error) {
      // If the first summary is readable, preserve the linked cell in the denominator.
      try {
        const summary = JSON.parse(await readFile(paths[0], 'utf8'));
        if (summary.study?.id === studyId) runs.push({ summary, skippedReason: error.message, events: [], project: null, recordHashes: null });
      } catch {}
    }
  }
  return analyzeStudySnapshot({ manifest, entries, runs, manifestBytesHash: studySnapshot.hashes[0], stateBytesHash: studySnapshot.hashes[1], generatedAt, assetIssues, accounting });
}

function csvCell(value, text = false) {
  if (value === null || value === undefined) return '';
  let output = Array.isArray(value) ? value.join('|') : String(value);
  if (text && /^[\s]*[=+\-@]/.test(output)) output = `'${output}`;
  return /[",\r\n]/.test(output) ? `"${output.replace(/"/g, '""')}"` : output;
}

const RUN_COLUMNS = ['cell_id', 'execution_index', 'entry_status', 'analysis_status', 'run_id', 'model_id', 'model_label', 'requested_model', 'returned_models', 'prompt_id', 'prompt_label', 'pack_id', 'pack_label', 'profile_id', 'profile_label', 'repetition', 'outcome', 'termination_reason', 'requested_turns', 'returned_responses', 'rejected_turns', 'turns_with_notes', 'note_denominator', 'cost_usd', 'cost_complete', 'usable_pieces', 'placed_pieces', 'contributing_pieces', 'coverage', 'material_breadth', 'material_breadth_normalized'];
const RECOVERY_COLUMNS = ['cell_id', 'run_id', 'rejected_turn', 'failure_stage', 'code', 'failed_action_index', 'next_requested_turn', 'primary_recovery', 'next_accepted_geometric_batch'];

export function studyRunsCSV(report, manifest) {
  const names = labels(manifest);
  const rows = report.cells.map(cell => {
    const evidence = cell.evidence ?? {}, metrics = cell.measurements ?? {};
    return [cell.cellId, cell.executionIndex, cell.entryStatus, cell.analysisStatus, cell.runId, cell.modelId, names.models.get(cell.modelId), evidence.requestedModel, evidence.returnedModels, cell.promptId, names.prompts.get(cell.promptId), cell.packId, names.packs.get(cell.packId), cell.profileId, names.profiles.get(cell.profileId), cell.repetition, cell.outcome, cell.terminationReason, evidence.requestedTurns, evidence.returnedResponses, evidence.rejectedTurns, evidence.turnsWithNotes, evidence.noteDenominator, evidence.costUSD, evidence.costComplete, metrics.usablePieces, metrics.placedPieces, metrics.contributingPieces, metrics.coverage, metrics.materialBreadth, metrics.materialBreadthNormalized];
  });
  return [RUN_COLUMNS.join(','), ...rows.map(row => row.map(value => csvCell(value, true)).join(','))].join('\n') + '\n';
}

export function studyRecoveryCSV(report) {
  const rows = report.recoveries.map(row => [row.cellId, row.runId, row.rejectedTurn, row.failureStage, row.code, row.failedActionIndex, row.nextRequestedTurn, row.primaryRecovery, row.nextAcceptedGeometricBatch]);
  return [RECOVERY_COLUMNS.join(','), ...rows.map(row => row.map(value => csvCell(value, true)).join(','))].join('\n') + '\n';
}

function markdownCell(value) { return String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' '); }

export function studySummaryMarkdown(report, manifest) {
  const names = labels(manifest);
  const lines = [
    '# Offcut study measurements', '',
    `${report.counts.cells} planned cells; ${report.counts.analysisStatus.measured ?? 0} measured; ${(report.counts.analysisStatus.not_run ?? 0)} not run; ${(report.counts.analysisStatus.invalid ?? 0) + (report.counts.analysisStatus.skipped ?? 0)} invalid or skipped.`, '',
    '| Cell | Model | Prompt | Pack | Rep | Entry outcome | Analysis | Coverage | Material breadth | Contributing pieces |',
    '| --- | --- | --- | --- | ---: | --- | --- | ---: | ---: | ---: |',
  ];
  for (const cell of report.cells) lines.push(`| ${[cell.cellId, names.models.get(cell.modelId) ?? cell.modelId, names.prompts.get(cell.promptId) ?? cell.promptId, names.packs.get(cell.packId) ?? cell.packId, cell.repetition, cell.outcome ?? cell.entryStatus, cell.analysisStatus, cell.measurements?.coverage, cell.measurements?.materialBreadth, cell.measurements?.contributingPieces].map(markdownCell).join(' | ')} |`);
  lines.push('', '## Denominators', '', `Notes were present on ${report.noteAvailability.turnsWithNotes} of ${report.noteAvailability.returnedResponseDenominator} returned responses. Complete recorded cost was available for ${report.costCompleteness.completeCells} of ${report.costCompleteness.runCellDenominator} linked run cells.`, '', 'Measurements describe source use, placement and alpha-weighted visible area. Transparent pixels, holes, canvas clipping and front-to-back occlusion affect contribution. Pairwise source-set overlap is reported only within a frozen pack and does not create extra independent observations.');
  if (report.issues.length || report.cells.some(cell => cell.issues.length)) {
    lines.push('', '## Record issues', '');
    for (const item of report.issues) lines.push(`- ${markdownCell(item.code)}: ${markdownCell(item.detail)}`);
    for (const cell of report.cells) for (const item of cell.issues) lines.push(`- ${markdownCell(cell.cellId)} — ${markdownCell(item.code)}: ${markdownCell(item.detail)}`);
  }
  return lines.join('\n') + '\n';
}
