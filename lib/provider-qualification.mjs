const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const routeKey = (provider, route) => `${provider}\n${route}`;

function containsCredential(value) {
  let found = false;
  const visit = item => {
    if (found || item === null || item === undefined) return;
    if (typeof item === 'string') { found = /(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~-]{8,})/i.test(item); return; }
    if (Array.isArray(item)) return item.forEach(visit);
    if (!object(item)) return;
    for (const [key, entry] of Object.entries(item)) {
      if (/api.?key|authorization|access.?token|client.?secret/i.test(key)) { found = true; return; }
      visit(entry);
    }
  };
  visit(value);
  return found;
}

export function qualifyRun({ run, events, project, reservations = [] } = {}) {
  const outputs = (events || []).filter(event => event.type === 'model_output');
  const requests = (events || []).filter(event => event.type === 'request');
  const results = (events || []).filter(event => event.type === 'batch_result');
  const outputTurns = new Set(outputs.map(event => event.turn));
  const resultByTurn = new Map(results.map(event => [event.turn, event]));
  const nativeImage = requests.length > 0 && requests.every(event => event.request?.messages?.some(message => Array.isArray(message.images) && message.images.length > 0) && outputTurns.has(event.turn));
  const parseableActionJSON = outputs.length > 0 && outputs.every(event => { const result = resultByTurn.get(event.turn); return result && result.failureStage !== 'parse'; });
  const completeUsage = outputs.length > 0 && outputs.every(event => event.usageIncomplete === false && ['inputTokens', 'outputTokens', 'totalTokens'].every(key => Number.isSafeInteger(event.usage?.[key]) && event.usage[key] >= 0));
  const settledUsage = requests.length > 0 && requests.every(event => reservations.some(item => item.requestId === event.requestId && ['settled', 'reconciled'].includes(item.status)));
  const deterministicReplay = object(project) && Array.isArray(project.actions) && Number.isInteger(project.cursor) && project.cursor === project.actions.length;
  const credentialFree = !containsCredential({ run, events, project });
  return {
    accessible: outputs.length > 0,
    nativeImage,
    parseableActionJSON,
    completeUsage,
    settledUsage,
    deterministicReplay,
    credentialFree,
    returnedModels: [...new Set(outputs.map(event => event.model).filter(value => typeof value === 'string'))],
    responseIds: [...new Set(outputs.map(event => event.responseId).filter(value => typeof value === 'string'))],
  };
}

/** Build a read-only route report from durable calibration evidence. No provider call is made. */
export function buildQualificationReport({ studies, runs, campaigns, rateSnapshots = [], generatedAt = new Date().toISOString() } = {}) {
  if (!studies || !runs || !campaigns) throw new TypeError('Study, run, and campaign readers are required.');
  const rows = new Map();
  for (const snapshot of rateSnapshots) for (const route of snapshot.routes || []) {
    const provider = route.provider || snapshot.provider, requestedRoute = route.requestedRoute;
    if (typeof provider !== 'string' || typeof requestedRoute !== 'string') continue;
    rows.set(routeKey(provider, requestedRoute), { provider, requestedRoute, priced: true, rateSnapshotId: snapshot.id, calibrationEvidence: [] });
  }
  for (const summary of studies.list()) {
    if (summary.kind !== 'calibration') continue;
    const detail = studies.get(summary.id), frozen = detail.manifest;
    if (!frozen) continue;
    const campaign = campaigns.get(frozen.campaign.id);
    for (const entry of detail.state?.entries || []) {
      const cell = frozen.cells?.find(item => item.cellId === entry.cellId);
      if (!cell) continue;
      const key = routeKey(cell.spec.provider, cell.spec.model);
      const row = rows.get(key) || { provider: cell.spec.provider, requestedRoute: cell.spec.model, priced: false, rateSnapshotId: null, calibrationEvidence: [] };
      rows.set(key, row);
      if (!entry.runId) continue;
      let run, events, project;
      try { run = runs.get(entry.runId); events = runs.events(entry.runId); project = runs.project(entry.runId); } catch { continue; }
      const evidence = qualifyRun({ run, events, project, reservations: campaign.reservations || [] });
      row.calibrationEvidence.push({ studyId: frozen.id, studyStatus: summary.status, manifestHash: frozen.manifestHash, campaignId: frozen.campaign.id, executionFingerprint: frozen.protocolSnapshot?.executionFingerprint ?? null, packHashes: (frozen.plan?.packIdentities || []).map(pack => pack.contentOnlyPackHash), cellId: cell.cellId, runId: entry.runId, status: entry.status, adapter: clone(frozen.protocolSnapshot?.adapters?.[cell.spec.provider] ?? null), ...evidence });
    }
  }
  const routes = [...rows.values()].map(row => {
    const calibrated = row.calibrationEvidence.some(evidence => evidence.studyStatus === 'completed' && ['completed', 'limit_reached'].includes(evidence.status) && evidence.accessible && evidence.nativeImage && evidence.parseableActionJSON && evidence.completeUsage && evidence.settledUsage && evidence.deterministicReplay && evidence.credentialFree);
    return { ...row, accessible: row.calibrationEvidence.some(evidence => evidence.accessible), calibrated, primaryEligible: row.priced && calibrated };
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.requestedRoute.localeCompare(b.requestedRoute));
  return { format: 'offcut-provider-qualification', version: 1, generatedAt, routes };
}
