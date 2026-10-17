import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildRunTrace } from './run-trace.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const countTypes = actions => Object.fromEntries([...new Set(actions.map(a => a.type))].sort().map(type => [type, actions.filter(a => a.type === type).length]));
const fingerprint = value => sha256(JSON.stringify(value));
const terminal = new Set(['completed', 'failed', 'stopped', 'interrupted', 'limit_reached']);

// This extracts declared text, not a judgment about its truth or the validity of
// proposed actions. Rejected proposals remain distinct from committed actions.
function proposal(text) {
  if (typeof text !== 'string') return null;
  try {
    const parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    return object(parsed) ? parsed : null;
  } catch { return null; }
}

/** Derive measurements from the event record without opening a run manager. */
export function analyzeRun({ summary, events, project }) {
  if (!object(summary) || !Array.isArray(events) || events.some(e => !object(e))) throw new Error('Expected a run summary and an array of events.');
  const issues = [];
  const noteIssue = (code, detail) => issues.push({ code, detail });
  if (events.some((e, i) => e.sequence !== i + 1)) noteIssue('EVENT_SEQUENCE', 'Event sequence numbers are not consecutive from 1.');
  const starts = events.filter(e => e.type === 'run_started');
  if (starts.length !== 1 || events[0]?.type !== 'run_started') noteIssue('RUN_START', 'Expected exactly one opening run_started event.');
  const start = starts[0] || {};
  const endings = events.filter(e => e.type === 'termination');
  if (endings.length > 1) noteIssue('TERMINATION_COUNT', 'More than one terminal event is recorded.');
  const ending = endings.at(-1);
  if (terminal.has(summary.status) && !ending) noteIssue('MISSING_TERMINATION', 'The summary is terminal but its event record has no termination.');
  if (ending && summary.status !== ending.status) noteIssue('STATUS_MISMATCH', 'Summary and terminal event disagree.');
  const status = ending?.status ?? summary.status;
  const spec = start.spec ?? summary.spec ?? {};
  const policy = start.policy ?? summary.policy ?? null;
  const sources = start.sourceManifest ?? summary.sourceManifest ?? [];
  const byTurn = new Map();
  for (const event of events) {
    if (!Number.isSafeInteger(event.turn) || event.turn < 1) continue;
    if (!byTurn.has(event.turn)) byTurn.set(event.turn, []);
    byTurn.get(event.turn).push(event);
  }
  let cursor = 0;
  const acceptedActions = [];
  const turns = [...byTurn].sort(([a], [b]) => a - b).map(([turn, records]) => {
    const one = type => {
      const matches = records.filter(e => e.type === type);
      if (matches.length > 1) noteIssue('DUPLICATE_TURN_EVENT', `Turn ${turn} has ${matches.length} ${type} events.`);
      return matches[0];
    };
    const observation = one('observation'), request = one('request'), output = one('model_output'), result = one('batch_result'), review = one('final_review');
    if (request && (!observation || observation.sequence >= request.sequence)) noteIssue('OBSERVATION_LINK', `Turn ${turn} has no preceding observation.`);
    if (output && (!request || request.sequence >= output.sequence)) noteIssue('OUTPUT_LINK', `Turn ${turn} has no preceding request.`);
    if (result && (!output || output.sequence >= result.sequence)) noteIssue('RESULT_LINK', `Turn ${turn} has no preceding model output.`);
    if (observation && observation.step !== cursor) noteIssue('OBSERVED_STEP', `Turn ${turn} observes step ${observation.step}, expected ${cursor}.`);
    const parsed = proposal(output?.text);
    const actions = result?.accepted === true && Array.isArray(result.actions) ? result.actions : [];
    if (result?.accepted === true) {
      if (!Array.isArray(result.actions) || result.fromStep !== cursor || result.step !== cursor + actions.length) noteIssue('ACTION_CURSOR', `Turn ${turn} has inconsistent committed action boundaries.`);
      acceptedActions.push(...actions);
      cursor += actions.length;
    } else if (result && result.step !== cursor) noteIssue('REJECTION_CURSOR', `Rejected turn ${turn} changes the recorded cursor.`);
    const reviewLinked = review ? Boolean(observation && result?.accepted === true && result.done === true && result.completionDeferred !== true && review.sequence > result.sequence && review.observedStep === observation.step && review.step === result.step && review.canvasSha256 === observation.canvasSha256) : null;
    if (review && !reviewLinked) noteIssue('FINAL_REVIEW_LINK', `Turn ${turn} final review does not match its observation and accepted result.`);
    const fromResult = typeof result?.decision_note === 'string';
    const note = fromResult ? result.decision_note : typeof parsed?.decision_note === 'string' ? parsed.decision_note : null;
    return {
      turn,
      evidence: { observation: observation?.sequence ?? null, request: request?.sequence ?? null, output: output?.sequence ?? null, result: result?.sequence ?? null, finalReview: review?.sequence ?? null },
      observedStep: observation?.step ?? null,
      resultingStep: result?.step ?? null,
      images: (observation?.images ?? []).map(({ id, kind, sha256, width, height }) => ({ id, kind, sha256, width, height })),
      outcome: result?.accepted === true ? 'accepted' : result?.accepted === false ? 'rejected' : 'no_result',
      rejectionCode: result?.accepted === false ? result.code ?? 'UNKNOWN' : null,
      proposedActionCount: Array.isArray(parsed?.actions) ? parsed.actions.length : null,
      acceptedActionCount: actions.length,
      acceptedActionTypes: countTypes(actions),
      decisionNote: note,
      noteOrigin: note === null ? null : fromResult ? 'batch_result' : 'model_output_json',
      completionRequested: typeof result?.done === 'boolean' ? result.done : typeof parsed?.done === 'boolean' ? parsed.done : null,
      completionDeferred: typeof result?.completionDeferred === 'boolean' ? result.completionDeferred : null,
      finalReviewLinked: reviewLinked,
      usage: output?.usage ?? null,
      usageIncomplete: output ? output.usageIncomplete !== false : Boolean(request),
    };
  });
  const requests = turns.filter(t => t.evidence.request !== null).length;
  const responses = turns.filter(t => t.evidence.output !== null).length;
  const results = turns.filter(t => t.evidence.result !== null).length;
  const rejected = turns.filter(t => t.outcome === 'rejected').length;
  if (summary.acceptedActions !== undefined && summary.acceptedActions !== acceptedActions.length) noteIssue('SUMMARY_ACTIONS', 'Summary accepted-action count differs from the committed events.');
  if (ending?.acceptedActions !== undefined && ending.acceptedActions !== acceptedActions.length) noteIssue('TERMINAL_ACTIONS', 'Terminal accepted-action count differs from the committed events.');
  if (summary.turns !== undefined && summary.turns !== requests) noteIssue('SUMMARY_TURNS', 'Summary turn count differs from recorded requests.');
  if (summary.rejectedBatches !== undefined && summary.rejectedBatches !== rejected) noteIssue('SUMMARY_REJECTIONS', 'Summary rejection count differs from the recorded results.');
  if (project && (project.cursor !== acceptedActions.length || JSON.stringify(project.actions?.map(r => r.action)) !== JSON.stringify(acceptedActions))) noteIssue('PROJECT_ACTIONS', 'Project checkpoint differs from the accepted event sequence.');
  const reviewRequired = policy?.completion?.requiresObservedCanvas;
  if (status === 'completed' && reviewRequired === true && !turns.some(t => t.finalReviewLinked === true)) noteIssue('MISSING_FINAL_REVIEW', 'The saved completion policy requires a linked final review.');
  const startedAt = start.at ?? summary.createdAt ?? null;
  const duration = ending && startedAt ? Date.parse(ending.at) - Date.parse(startedAt) : null;
  const { model, provider, ...settings } = spec;
  const recovery = project ? buildRunTrace({ summary, events, project }).recovery : [];
  return {
    id: summary.id, status, terminationReason: ending?.reason ?? summary.terminationReason ?? null,
    provider: provider ?? null, model: model ?? null,
    returnedModels: [...new Set(events.filter(e => e.type === 'model_output' && e.model).map(e => e.model))],
    policyVersion: policy?.version ?? null,
    sourceCount: sources.length,
    sourcePackSha256: fingerprint(sources.map(({ id, sha256 }) => ({ id, sha256 }))),
    protocolSha256: fingerprint({ settings, policy, rules: start.rules ?? null, canvas: start.canvas ?? null }),
    startedAt, durationMs: Number.isFinite(duration) && duration >= 0 ? duration : null,
    metrics: {
      requestedTurns: requests, responses, resolvedBatches: results, rejectedBatches: rejected,
      rejectedBatchRate: results ? rejected / results : null,
      acceptedActions: acceptedActions.length, acceptedActionTypes: countTypes(acceptedActions),
      turnsWithNotes: turns.filter(t => t.decisionNote !== null && t.decisionNote.trim()).length,
      requestsWithoutOutputs: turns.filter(t => t.evidence.request !== null && t.evidence.output === null).length,
      deferredCompletions: turns.filter(t => t.completionDeferred === true).length,
      linkedFinalReviews: turns.filter(t => t.finalReviewLinked === true).length,
      rejectedTurnsWithFollowup: recovery.filter(row => row.nextRequestSequence !== null).length,
      immediateAcceptedRecoveries: recovery.filter(row => row.primaryRecovery === true).length,
      immediateAcceptedGeometricRecoveries: recovery.filter(row => row.nextAcceptedGeometricBatch === true).length,
    },
    finalReviewStatus: turns.some(t => t.finalReviewLinked === true) ? 'recorded' : reviewRequired === true ? 'not_recorded' : 'not_required_or_unknown',
    usage: ending?.usage ?? summary.usage ?? null,
    usageIncomplete: (ending?.usageIncomplete ?? summary.usageIncomplete) !== false || turns.some(t => t.usageIncomplete),
    costUSD: null,
    issues, turns, recovery,
  };
}

/** Read stored runs directly: never starts a server, resumes, or rewrites data. */
export async function analyzeRunDirectory(directory) {
  const report = { format: 'offcut-run-analysis', version: 1, generatedAt: new Date().toISOString(), runs: [], skipped: [], errors: [], warnings: [] };
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.filter(e => e.isDirectory() && e.name.startsWith('run-')).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    try {
      const summaryBytes = await readFile(join(path, 'run.json'));
      const summary = JSON.parse(summaryBytes);
      if (!terminal.has(summary.status)) { report.skipped.push({ id: entry.name, reason: 'Not a terminal saved run; left untouched.' }); continue; }
      const eventBytes = await readFile(join(path, 'events.jsonl'));
      const events = eventBytes.toString('utf8').trim().split('\n').filter(Boolean).map((line, index) => {
        try { return JSON.parse(line); } catch { throw new Error(`Unreadable JSON on event line ${index + 1}.`); }
      });
      const projectBytes = await readFile(join(path, 'project.json'));
      const run = analyzeRun({ summary, events, project: JSON.parse(projectBytes) });
      if (summary.id !== entry.name) run.issues.push({ code: 'RUN_ID', detail: 'Directory name and saved run ID disagree.' });
      const hashes = [...new Set([
        ...events.filter(e => e.type === 'run_started').flatMap(e => (e.sourceManifest ?? []).map(s => s.sha256)),
        ...run.turns.flatMap(t => t.images.map(image => image.sha256)),
        ...events.filter(e => e.type === 'observation').map(e => e.canvasSha256),
      ])];
      run.assets = { referenced: hashes.length, verified: 0 };
      for (const hash of hashes) {
        if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) { run.issues.push({ code: 'ASSET_HASH', detail: 'An asset reference is not a SHA-256 hash.' }); continue; }
        try {
          if (sha256(await readFile(join(path, 'assets', hash))) !== hash) run.issues.push({ code: 'ASSET_BYTES', detail: `Asset ${hash} does not match its hash.` });
          else run.assets.verified++;
        } catch { run.issues.push({ code: 'ASSET_MISSING', detail: `Asset ${hash} could not be read.` }); }
      }
      run.recordHashes = { summary: sha256(summaryBytes), events: sha256(eventBytes), project: sha256(projectBytes) };
      // A run that changed while being read is not a stable analysis snapshot.
      if (sha256(await readFile(join(path, 'run.json'))) !== run.recordHashes.summary
        || sha256(await readFile(join(path, 'events.jsonl'))) !== run.recordHashes.events
        || sha256(await readFile(join(path, 'project.json'))) !== run.recordHashes.project) {
        report.skipped.push({ id: entry.name, reason: 'Record changed during analysis; retry after it is settled.' }); continue;
      }
      report.runs.push(run);
    } catch (error) { report.errors.push({ id: entry.name, message: error.message }); }
  }
  if (new Set(report.runs.map(r => r.protocolSha256)).size > 1) report.warnings.push('These runs use different recorded protocols, settings or rules. Do not treat pooled differences as a model effect.');
  if (new Set(report.runs.map(r => r.sourcePackSha256)).size > 1) report.warnings.push('These runs use different ordered source packs. Match material conditions before comparing models.');
  report.warnings.push('Counts describe observable behavior. Notes are model-authored statements; no explanation truth, creativity score, or internal reasoning is inferred.');
  return report;
}

export function analysisMarkdown(report) {
  const cell = value => String(value ?? 'Unknown').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
  const lines = ['# Offcut run inventory', '', `${report.runs.length} records analyzed; ${report.skipped.length} skipped; ${report.errors.length} unreadable.`, '', '| Work | Model | Policy | Outcome | Requests | Accepted actions | Rejected / resolved batches | Notes | Record issues |', '| --- | --- | ---: | --- | ---: | ---: | --- | ---: | ---: |'];
  for (const run of report.runs) lines.push(`| ${[run.id, run.model, run.policyVersion, run.status, run.metrics.requestedTurns, run.metrics.acceptedActions, `${run.metrics.rejectedBatches} / ${run.metrics.resolvedBatches}`, run.metrics.turnsWithNotes, run.issues.length].map(cell).join(' | ')} |`);
  lines.push('', 'The rejection denominator is recorded batch results, not individual actions. Missing responses and malformed text are retained separately in the JSON. A linked final-review event establishes the recorded observation/result relationship, not perceptual understanding. Hash checks establish stored-byte consistency; they do not independently verify renderer correctness.', '', '## Interpretation', '');
  lines.push(...report.warnings.map(warning => `- ${warning}`));
  for (const run of report.runs.filter(r => r.issues.length)) lines.push('', `## ${cell(run.id)}`, '', ...run.issues.map(issue => `- ${cell(issue.code)}: ${cell(issue.detail)}`));
  if (report.skipped.length || report.errors.length) lines.push('', '## Unanalyzed records', '', ...[...report.skipped, ...report.errors].map(item => `- ${cell(item.id)}: ${cell(item.reason ?? item.message)}`));
  return lines.join('\n') + '\n';
}
