import { mkdir, readFile, readdir, rename, writeFile, copyFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createState, applyAction } from './engine.mjs';
import { getSharp, renderPNG } from './render.mjs';
import { safeMaterialMetadata } from './material-catalog.mjs';
import { normalizeMaterialSelection, drawMaterialIds } from '../public/material-selection.mjs';
import { normalizeSpec } from '../public/run-spec.mjs';
import { effectiveRunPolicy } from './run-policy.mjs';

export { normalizeSpec } from '../public/run-spec.mjs';

const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const RUN_ID = /^run-[a-f0-9-]{36}$/;

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function normalizeBatch(input) {
  if (input === undefined) return undefined;
  if (!object(input) || Reflect.ownKeys(input).length !== 3
    || typeof input.id !== 'string' || !/^batch-[a-f0-9-]{36}$/.test(input.id)
    || !Number.isInteger(input.groupIndex) || input.groupIndex < 0 || input.groupIndex > 7
    || !Number.isInteger(input.runIndex) || input.runIndex < 0 || input.runIndex > 49) fail('Invalid batch provenance.');
  return { id: input.id, groupIndex: input.groupIndex, runIndex: input.runIndex };
}

function normalizeStudy(input) {
  if (input === undefined) return undefined;
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  if (!object(input) || Reflect.ownKeys(input).length !== 4
    || typeof input.id !== 'string' || !(new RegExp(`^study-${uuid}$`)).test(input.id)
    || typeof input.manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.manifestHash)
    || typeof input.cellId !== 'string' || !/^cell-[a-f0-9]{64}$/.test(input.cellId)
    || typeof input.campaignId !== 'string' || !(new RegExp(`^campaign-${uuid}$`)).test(input.campaignId)) fail('Invalid study provenance.');
  return { id: input.id, manifestHash: input.manifestHash, cellId: input.cellId, campaignId: input.campaignId };
}

function normalizeLaunch(input) {
  if (input === undefined) return undefined;
  if (!object(input) || Object.keys(input).length !== 2
    || typeof input.clientRequestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.clientRequestId)
    || typeof input.requestFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.requestFingerprint)) fail('Invalid launch receipt.');
  // Store only the token and fingerprint, never a request body or credentials.
  return { clientRequestId: input.clientRequestId, requestFingerprint: input.requestFingerprint };
}

function normalizeSelectionRecord(input) {
  if (input === undefined) return undefined;
  const fields = ['version', 'algorithm', 'seed', 'catalogSnapshot', 'pinnedIds', 'candidateIds', 'randomCount', 'candidateManifest'];
  if (!object(input) || Reflect.ownKeys(input).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(input, key))) {
    fail('A material selection record must contain only its complete recipe and candidateManifest.');
  }
  const { candidateManifest, ...settings } = input;
  const recipe = normalizeMaterialSelection(settings);
  if (!Array.isArray(candidateManifest) || candidateManifest.length !== recipe.candidateIds.length) {
    fail('The material candidate manifest must contain every candidate exactly once in sorted ID order.');
  }
  const manifest = Array.from(candidateManifest, (entry, index) => {
    if (!object(entry) || Reflect.ownKeys(entry).length !== 2 || !Object.hasOwn(entry, 'id') || !Object.hasOwn(entry, 'sha256')
      || entry.id !== recipe.candidateIds[index] || typeof entry.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(entry.sha256)) {
      fail('Every candidate manifest entry must contain only its matching source ID and a 64-digit hexadecimal SHA-256 hash, in sorted ID order.');
    }
    return { id: entry.id, sha256: entry.sha256.toLowerCase() };
  });
  return { ...recipe, candidateManifest: manifest };
}

function validateSelectionSources(selection, sources, sourceManifest) {
  if (!selection) return;
  const { candidateManifest, ...recipe } = selection;
  const selectedIds = drawMaterialIds(recipe);
  if (selectedIds.length !== sources.length || selectedIds.some((id, index) => id !== sources[index].id)) {
    fail('The supplied sources do not match the recorded material draw in order.');
  }
  const candidateHashes = new Map(candidateManifest.map(entry => [entry.id, entry.sha256]));
  for (const source of sourceManifest) {
    if (candidateHashes.has(source.id) && candidateHashes.get(source.id) !== source.sha256) {
      fail(`Selected source ${source.id} does not match its material candidate hash.`);
    }
  }
}

function decodeImage(dataUrl) {
  const match = typeof dataUrl === 'string' && /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match || !match[2] || match[2].length % 4) fail('Run sources must be embedded PNG, JPEG, or WebP images.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 16 * 1024 * 1024) fail('Each run source must be at most 16 MB.');
  return { bytes, mime: `image/${match[1]}` };
}

export async function freezeSources(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 24) fail('Choose between 1 and 24 source images.');
  let state, materialMetadata;
  try {
    const originalSources = clone(input);
    state = createState({ sources: originalSources });
    // Copy provenance before the first image-read await, just like the pixels.
    materialMetadata = new Map(originalSources.map(source => [source.id, safeMaterialMetadata(source)]));
  } catch (error) { fail(error.message); }
  const sourceManifest = [];
  let totalBytes = 0;
  for (const source of state.sources) {
    const { bytes } = decodeImage(source.dataUrl);
    totalBytes += bytes.length;
    if (totalBytes > 24 * 1024 * 1024) fail('Run sources must total no more than 24 MB.');
    let metadata;
    try { metadata = await getSharp()(bytes, { limitInputPixels: 20_000_000, failOn: 'error' }).metadata(); }
    catch { fail(`Source ${source.id} could not be opened.`); }
    if (metadata.width !== source.width || metadata.height !== source.height || metadata.pages > 1 || !['png', 'jpeg', 'webp'].includes(metadata.format)) fail(`Source ${source.id} has inconsistent dimensions or an unsupported image format.`);
    const { dataUrl, ...description } = source;
    sourceManifest.push({ ...description, sha256: hash(bytes), ...materialMetadata.get(source.id) });
  }
  return { sources: state.sources, sourceManifest };
}

function compactState(state) {
  const { sources, ...rest } = state;
  return { ...clone(rest), sources: sources.map(({ dataUrl, ...source }) => clone(source)) };
}

// Metadata and unplaced material do not change the image the model just saw.
// Comparing the visible draw list also handles no-op edits and batches that
// return a piece to its original position without requiring a redundant turn.
function visibleScene(state) {
  return JSON.stringify({ canvas: state.canvas, pieces: state.pieces.filter(piece => piece.visible) });
}

function parseOutput(text, reviewOnly = false) {
  if (typeof text !== 'string' || text.length > 250000) fail('Return one JSON object no larger than 250000 characters.');
  const stripped = text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
  let result;
  try { result = JSON.parse(stripped); } catch { fail('The response was not valid JSON. Return {decision_note, actions, done}.'); }
  if (!object(result) || Object.keys(result).some(key => !['decision_note', 'actions', 'done'].includes(key))) fail('Return only decision_note, actions, and done.');
  if (typeof result.decision_note !== 'string' || result.decision_note.length > 2000) fail('decision_note must be a string of at most 2000 characters.');
  if (typeof result.done !== 'boolean' || !Array.isArray(result.actions) || result.actions.length > 12 || (!result.done && !result.actions.length && !reviewOnly)) fail('Use a boolean done and at most 12 actions; an empty batch is allowed only when done is true or reviewOnly is true.');
  return result;
}

function tokenUsage(input = {}) {
  const safe = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const inputTokens = safe(input?.inputTokens), outputTokens = safe(input?.outputTokens);
  return { inputTokens, outputTokens, totalTokens: Number.isSafeInteger(input?.totalTokens) && input.totalTokens >= 0 ? input.totalTokens : inputTokens + outputTokens };
}

const completeUsage = usage => object(usage) && ['inputTokens', 'outputTokens', 'totalTokens'].every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0);

function detailedUsage(input = {}) {
  const usage = tokenUsage(input);
  if (object(input.inputTokensDetails)) usage.inputTokensDetails = {
    cachedTokens: Number.isSafeInteger(input.inputTokensDetails.cachedTokens) && input.inputTokensDetails.cachedTokens >= 0 ? input.inputTokensDetails.cachedTokens : null,
  };
  if (object(input.outputTokensDetails)) usage.outputTokensDetails = {
    reasoningTokens: Number.isSafeInteger(input.outputTokensDetails.reasoningTokens) && input.outputTokensDetails.reasoningTokens >= 0 ? input.outputTokensDetails.reasoningTokens : null,
  };
  return usage;
}

function accountingUsage(input = {}) {
  const integerOrNull = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const usage = {
    inputTokens: integerOrNull(input?.inputTokens),
    outputTokens: integerOrNull(input?.outputTokens),
    totalTokens: integerOrNull(input?.totalTokens),
  };
  if (object(input?.inputTokensDetails)) usage.inputTokensDetails = { cachedTokens: integerOrNull(input.inputTokensDetails.cachedTokens) };
  if (object(input?.outputTokensDetails)) usage.outputTokensDetails = { reasoningTokens: integerOrNull(input.outputTokensDetails.reasoningTokens) };
  return usage;
}

function normalizeRequestGuard(input) {
  if (input === undefined) return null;
  const methods = ['reserve', 'markDispatching', 'settle', 'releaseUndispatched'];
  if (!object(input) || methods.some(method => typeof input[method] !== 'function')) fail('Invalid request spending guard.');
  return input;
}

function providerMetadata(connection) {
  const metadata = connection.metadata ?? {};
  // Persist only the provider's public protocol settings, never the connection.
  return { adapter: typeof metadata.adapter === 'string' ? metadata.adapter.slice(0, 100) : null, endpoint: metadata.endpoint === 'https://api.openai.com/v1/responses' ? metadata.endpoint : null, imageDetail: ['auto', 'low', 'high', 'original'].includes(metadata.imageDetail) ? metadata.imageDetail : null, store: typeof metadata.store === 'boolean' ? metadata.store : null };
}

async function atomicJSON(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
  await rename(temporary, file);
}

async function abortable(operation, signal) {
  if (signal.aborted) throw signal.reason;
  let onAbort;
  const interrupted = new Promise((resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Run interrupted.'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(operation), interrupted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** Runs own immutable source snapshots and never mutate the live studio. */
export async function createRunManager({ dataDir, providerFactory } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('A run storage directory is required.');
  if (typeof providerFactory !== 'function') throw new Error('A provider factory is required.');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const runs = new Map();
  let active = null, starting = null, closed = false;

  function find(id) {
    if (typeof id !== 'string' || !RUN_ID.test(id) || !runs.has(id)) fail('Experiment not found.', 404);
    return runs.get(id);
  }
  function summary(run) { return clone(run.summary); }
  function descriptionEvidence(run, state = run.states.at(-1), pendingActions = []) {
    if (run.summary.policy?.completion?.requiresAcceptedDescription !== true) return undefined;
    const actions = [...run.project.actions.map(record => record.action), ...pendingActions];
    const titleAccepted = actions.some(action => action?.type === 'describe' && Object.hasOwn(action, 'title'));
    const statementAccepted = actions.some(action => action?.type === 'describe' && Object.hasOwn(action, 'statement'));
    const titleNonblank = typeof state?.title === 'string' && Boolean(state.title.trim());
    const statementNonblank = typeof state?.statement === 'string' && Boolean(state.statement.trim());
    return { required: true, titleAccepted, statementAccepted, titleNonblank, statementNonblank, complete: titleAccepted && statementAccepted && titleNonblank && statementNonblank };
  }
  async function saveSummary(run) { await atomicJSON(join(run.dir, 'run.json'), run.summary); }
  async function append(run, type, data = {}) {
    const event = { sequence: run.events.length + 1, at: now(), type, ...clone(data) };
    // A durable event is the commit record. Project checkpoints are rebuildable.
    const file = await open(join(run.dir, 'events.jsonl'), 'a', 0o600);
    try { await file.writeFile(`${JSON.stringify(event)}\n`); await file.sync(); } finally { await file.close(); }
    run.events.push(event);
    run.summary.updatedAt = event.at;
    run.summary.revision = `${run.summary.id}:${event.sequence}`;
    return event;
  }
  async function checkpoint(run) {
    run.project.updatedAt = run.summary.updatedAt;
    await atomicJSON(join(run.dir, 'project.json'), run.project);
    await saveSummary(run);
  }
  async function putAsset(run, bytes) {
    const sha256 = hash(bytes);
    try { await writeFile(join(run.dir, 'assets', sha256), bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return sha256;
  }
  async function observeImage(run, id, bytes, width, height, kind, originalHash) {
    const observed = await getSharp()(bytes, { limitInputPixels: 20_000_000 }).resize({ width: run.summary.policy.observation.maxEdge, height: run.summary.policy.observation.maxEdge, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    const sha256 = await putAsset(run, observed.data);
    return { attachment: { id, dataUrl: `data:image/png;base64,${observed.data.toString('base64')}` }, description: { id, kind, mime: 'image/png', sha256, originalSha256: originalHash ?? hash(bytes), originalWidth: width, originalHeight: height, width: observed.info.width, height: observed.info.height } };
  }
  async function finish(run, status, reason) {
    if (run.summary.status !== 'running') return;
    const description = descriptionEvidence(run);
    if (description) run.summary.description = description;
    await append(run, 'termination', { status, reason, turns: run.summary.turns, acceptedActions: run.summary.acceptedActions, usage: run.summary.usage, usageIncomplete: run.summary.usageIncomplete, costUSD: null, ...(description ? { description } : {}) });
    run.summary.status = status;
    run.summary.terminationReason = reason;
    await checkpoint(run);
  }
  function cancelled(run) {
    if (run.controller.signal.aborted) throw run.controller.signal.reason;
  }
  async function execute(run, connection) {
    let guardedRequest = null;
    const deadline = setTimeout(() => {
      run.cancel = { status: 'limit_reached', reason: 'time_limit' };
      run.controller.abort(new Error('Experiment time limit reached.'));
    }, run.summary.spec.maxMinutes * 60000);
    try {
      const sources = [];
      for (const source of run.project.sources) {
        cancelled(run);
        const { bytes } = decodeImage(source.dataUrl);
        await putAsset(run, bytes);
        sources.push(await observeImage(run, source.id, bytes, source.width, source.height, 'source', hash(bytes)));
      }
      const history = [];
      let feedback = 'This is a new, empty canvas. Make an original composition from these materials.';
      while (run.summary.turns < run.summary.spec.maxTurns) {
        cancelled(run);
        const reviewOnly = run.summary.acceptedActions >= run.summary.spec.maxActions;
        if (reviewOnly && descriptionEvidence(run)?.complete === false) return await finish(run, 'limit_reached', 'action_limit');
        const turn = run.summary.turns + 1;
        const observedStep = run.project.cursor;
        const current = run.states.at(-1);
        const canvasBytes = await renderPNG(current);
        const canvasHash = await putAsset(run, canvasBytes);
        const canvas = await observeImage(run, 'canvas', canvasBytes, current.canvas.width, current.canvas.height, 'canvas', canvasHash);
        cancelled(run);
        const images = [...sources, canvas];
        const descriptions = images.map(image => image.description);
        await append(run, 'observation', { turn, step: run.project.cursor, images: descriptions, canvasSha256: canvasHash });
        const userText = JSON.stringify({ brief: run.summary.spec.prompt, turn, turnsRemainingIncludingThis: run.summary.spec.maxTurns - turn + 1, actionsRemaining: run.summary.spec.maxActions - run.summary.acceptedActions, reviewOnly, feedback: reviewOnly ? `${feedback} The action budget is exhausted. Inspect this final canvas. Submit actions: [] and done: true if satisfied, or done: false to leave the work unfinished.` : feedback, images: descriptions, state: compactState(current) });
        const userMessage = { role: 'user', text: userText, images: images.map(image => image.attachment) };
        const request = { model: run.summary.spec.model, instructions: run.summary.policy.instructions, maxOutputTokens: run.summary.spec.maxOutputTokens, messages: [...history, userMessage] };
        const contextCharacters = request.instructions.length + request.messages.reduce((sum, message) => sum + message.text.length, 0);
        if (contextCharacters > run.summary.policy.maxContextTextCharacters) return await finish(run, 'limit_reached', 'context_limit');
        const requestId = `${run.summary.id}:turn:${turn}`;
        if (run.requestGuard) {
          let reservation;
          try { reservation = await run.requestGuard.reserve({ requestId, runId: run.summary.id, turn, study: clone(run.summary.study), request, images: descriptions }); }
          catch (error) {
            if (!['STUDY_BUDGET_DENIED', 'UNPRICED_REQUEST', 'CAMPAIGN_BLOCKED', 'CAMPAIGN_RECONCILIATION_REQUIRED'].includes(error?.code)) throw error;
            cancelled(run);
            await append(run, 'budget_denied', { turn, requestId, code: typeof error?.code === 'string' ? error.code : 'UNPRICED_REQUEST', error: 'The study allowance did not admit this request.' });
            return await finish(run, 'limit_reached', 'study_budget');
          }
          guardedRequest = { reservationId: reservation.reservationId, stage: 'reserved' };
          cancelled(run);
        }
        // Hash references point to the exact image bytes sent in native image parts.
        await append(run, 'request', { turn, requestId, request: { ...request, messages: request.messages.map(message => ({ ...message, ...(message.images ? { images: descriptions.map(({ id, sha256, mime }) => ({ id, sha256, mime })) } : {}) })) } });
        run.summary.turns = turn;
        run.summary.usageIncomplete = true;
        await saveSummary(run);
        cancelled(run);
        if (run.requestGuard) {
          // If this call fails after committing its ledger entry, dispatch is
          // uncertain. Never release the reservation in that crash window.
          guardedRequest.stage = 'dispatching';
          await run.requestGuard.markDispatching(guardedRequest.reservationId);
        }
        const output = await abortable(() => connection.generate({ ...request, signal: run.controller.signal }), run.controller.signal);
        const usage = detailedUsage(output?.usage);
        const reportedUsage = accountingUsage(output?.usage);
        const usageIncomplete = !completeUsage(output?.usage);
        await append(run, 'model_output', { turn, text: typeof output?.text === 'string' ? output.text : '', raw: output?.raw ?? null, model: output?.model ?? null, responseId: output?.responseId ?? null, usage, usageIncomplete });
        if (run.requestGuard) {
          await run.requestGuard.settle({ reservationId: guardedRequest.reservationId, usage: reportedUsage, responseId: output?.responseId ?? null, returnedModel: output?.model ?? null });
          guardedRequest = null;
        }
        run.hadIncompleteUsage ||= usageIncomplete;
        run.summary.usageIncomplete = run.hadIncompleteUsage;
        for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) run.summary.usage[key] += usage[key];
        history.push({ role: 'user', text: userText }, { role: 'assistant', text: typeof output?.text === 'string' ? output.text : '' });
        cancelled(run);
        let parsed;
        try {
          parsed = parseOutput(output?.text, reviewOnly);
        } catch (error) {
          run.summary.rejectedBatches++;
          feedback = `Your entire previous batch was rejected; no actions were applied. ${error.message}`;
          await append(run, 'batch_result', { turn, accepted: false, failureStage: 'parse', code: error.code ?? 'INVALID_OUTPUT', error: error.message, step: run.project.cursor });
          await saveSummary(run);
          cancelled(run);
          if (reviewOnly) return await finish(run, 'limit_reached', 'action_limit');
          continue;
        }
        if (reviewOnly && parsed.actions.length) {
          const error = new Error('The action budget is exhausted. This final review cannot apply more actions.');
          run.summary.rejectedBatches++;
          await append(run, 'batch_result', { turn, accepted: false, failureStage: 'review_limit', code: 'ACTION_LIMIT', error: error.message, actions: parsed.actions, decision_note: parsed.decision_note, done: parsed.done, step: run.project.cursor });
          await saveSummary(run);
          cancelled(run);
          return await finish(run, 'limit_reached', 'action_limit');
        }
        const nextStates = [];
        let next = current, failedAction;
        for (let index = 0; index < parsed.actions.length; index++) {
          try {
            next = applyAction(next, parsed.actions[index]);
            next.sources = run.project.sources;
            nextStates.push(next);
          } catch (error) {
            failedAction = { error, index };
            break;
          }
        }
        if (failedAction) {
          run.summary.rejectedBatches++;
          feedback = `Your entire previous batch was rejected; no actions were applied. ${failedAction.error.message}`;
          await append(run, 'batch_result', { turn, accepted: false, failureStage: 'action', failedActionIndex: failedAction.index, code: failedAction.error.code ?? 'INVALID_ACTION', error: failedAction.error.message, actions: parsed.actions, decision_note: parsed.decision_note, done: parsed.done, step: run.project.cursor });
          await saveSummary(run);
          cancelled(run);
          continue;
        }
        cancelled(run);
        const canvasChanged = visibleScene(current) !== visibleScene(nextStates.at(-1) ?? current);
        const nextState = nextStates.at(-1) ?? current;
        const description = descriptionEvidence(run, nextState, parsed.actions);
        const completionDeferralReasons = parsed.done ? [
          ...(canvasChanged ? ['unobserved_canvas'] : []),
          ...(description?.complete === false ? ['missing_description'] : []),
        ] : [];
        const completionDeferred = completionDeferralReasons.length > 0;
        const result = await append(run, 'batch_result', { turn, accepted: true, actions: parsed.actions, decision_note: parsed.decision_note, done: parsed.done, completionDeferred, completionDeferralReasons, ...(description ? { description } : {}), fromStep: run.project.cursor, step: run.project.cursor + parsed.actions.length });
        run.states.push(...nextStates);
        run.project.actions.push(...parsed.actions.map(action => ({ action: clone(action), at: result.at })));
        run.project.cursor = run.project.actions.length;
        run.summary.acceptedActions = run.project.cursor;
        run.summary.title = run.states.at(-1).title;
        if (description) run.summary.description = description;
        await checkpoint(run);
        cancelled(run);
        if (parsed.done && !completionDeferred) {
          await append(run, 'final_review', { turn, observedStep, step: run.project.cursor, canvasSha256: canvasHash });
          cancelled(run);
          return await finish(run, 'completed', 'model_finished');
        }
        if (reviewOnly) return await finish(run, 'limit_reached', 'action_limit');
        if (completionDeferred) {
          const requirements = [];
          if (completionDeferralReasons.includes('unobserved_canvas')) requirements.push('inspect the updated canvas attached to the next turn before confirming completion');
          if (completionDeferralReasons.includes('missing_description')) requirements.push('supply both a nonblank title and a nonblank artist statement through accepted describe actions');
          feedback = `Finishing is deferred: ${requirements.join('; ')}. Remaining budget: ${run.summary.spec.maxTurns - run.summary.turns} turns and ${run.summary.spec.maxActions - run.summary.acceptedActions} actions.`;
        } else feedback = `Accepted all ${parsed.actions.length} actions. Inspect the updated canvas and continue or finish.`;
      }
      cancelled(run);
      await finish(run, 'limit_reached', 'turn_limit');
    } catch (error) {
      if (guardedRequest?.stage === 'reserved') {
        await run.requestGuard.releaseUndispatched(guardedRequest.reservationId).catch(() => {});
        guardedRequest = null;
      }
      if (run.cancel) await finish(run, run.cancel.status, run.cancel.reason);
      else {
        await append(run, 'error', { error: { name: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : null, message: String(error?.message ?? 'The experiment failed.').slice(0, 2000) } });
        await finish(run, 'failed', 'provider_or_runner_error');
      }
    } finally {
      clearTimeout(deadline);
      if (active === run.summary.id) active = null;
    }
  }

  // Events, not the most recent checkpoint, determine which actions committed.
  for (const directory of await readdir(dataDir, { withFileTypes: true })) {
    if (!directory.isDirectory() || !RUN_ID.test(directory.name)) continue;
    const dir = join(dataDir, directory.name);
    let saved;
    try { saved = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const initial = JSON.parse(await readFile(join(dir, 'initial.project.json'), 'utf8'));
    let raw = '';
    try { raw = await readFile(join(dir, 'events.jsonl'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const events = [];
    let validBytes = 0, damagedTail = false;
    const lines = raw.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line && index === lines.length - 1) break;
      try {
        if (index === lines.length - 1) throw new Error('Incomplete event tail.');
        const event = JSON.parse(line);
        if (event.sequence !== events.length + 1) throw new Error('Event sequence mismatch.');
        events.push(event);
        validBytes += Buffer.byteLength(line + '\n');
      } catch (error) {
        if (lines.slice(index + 1).some(value => value.trim())) throw new Error(`Cannot recover experiment ${directory.name}: damaged event history.`);
        damagedTail = true;
        break;
      }
    }
    if (damagedTail) {
      await copyFile(join(dir, 'events.jsonl'), join(dir, `events-recovery-${Date.now()}.jsonl`));
      await writeFile(join(dir, 'events.jsonl'), Buffer.from(raw).subarray(0, validBytes), { mode: 0o600 });
    }
    const initialState = createState({ sources: initial.sources, rules: initial.rules, canvas: initial.canvas, id: initial.id });
    const run = { dir, summary: saved, project: { ...initial, actions: [], cursor: 0 }, states: [initialState], events, controller: new AbortController(), cancel: null, task: null, hadIncompleteUsage: false, requestGuard: null };
    // Selection provenance belongs to the durable launch event, never a stale
    // checkpoint. Legacy launches without a recipe remain unlabelled.
    const materialSelection = normalizeSelectionRecord(events.find(event => event.type === 'run_started')?.materialSelection);
    const started = events.find(event => event.type === 'run_started');
    const batch = normalizeBatch(started?.batch);
    const study = normalizeStudy(started?.study);
    if (batch && study) throw new Error(`Cannot recover experiment ${directory.name}: batch and study provenance are mutually exclusive.`);
    const launch = normalizeLaunch(started?.launch);
    delete run.summary.batch;
    delete run.summary.study;
    delete run.summary.launch;
    if (batch) run.summary.batch = batch;
    if (study) run.summary.study = study;
    if (launch) run.summary.launch = launch;
    if (started?.policy && object(started.policy)) run.summary.policy = clone(started.policy);
    delete run.summary.materialSelection;
    if (materialSelection) {
      const sourceManifest = initialState.sources.map(source => ({ id: source.id, sha256: hash(decodeImage(source.dataUrl).bytes) }));
      validateSelectionSources(materialSelection, initialState.sources, sourceManifest);
      run.summary.materialSelection = materialSelection;
    }
    run.summary.turns = 0;
    run.summary.rejectedBatches = 0;
    run.summary.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let termination;
    const committedTurns = new Set();
    const requestedTurns = new Set(), returnedTurns = new Set();
    for (const event of events) {
      if (event.type === 'request') { run.summary.turns = Math.max(run.summary.turns, event.turn); requestedTurns.add(event.turn); }
      if (event.type === 'model_output') {
        returnedTurns.add(event.turn);
        run.hadIncompleteUsage ||= event.usageIncomplete === true;
        const usage = tokenUsage(event.usage);
        for (const key of Object.keys(usage)) run.summary.usage[key] += usage[key];
      }
      if (event.type === 'batch_result') {
        if (!event.accepted) { run.summary.rejectedBatches++; continue; }
        if (committedTurns.has(event.turn) || event.fromStep !== run.project.actions.length) throw new Error(`Cannot recover experiment ${directory.name}: duplicate or out-of-order batch.`);
        committedTurns.add(event.turn);
        for (const action of event.actions) {
          const next = applyAction(run.states.at(-1), action);
          next.sources = run.project.sources;
          run.states.push(next);
          run.project.actions.push({ action: clone(action), at: event.at });
        }
        if (event.step !== run.project.actions.length) throw new Error(`Cannot recover experiment ${directory.name}: inconsistent batch checkpoint.`);
      }
      if (event.type === 'termination') termination = event;
    }
    run.project.cursor = run.project.actions.length;
    run.summary.acceptedActions = run.project.cursor;
    run.summary.title = run.states.at(-1).title;
    delete run.summary.description;
    const description = descriptionEvidence(run);
    if (description) run.summary.description = description;
    run.summary.revision = `${run.summary.id}:${events.length}`;
    run.summary.updatedAt = events.at(-1)?.at ?? saved.createdAt;
    run.summary.costUSD = null;
    run.summary.usageIncomplete = run.hadIncompleteUsage || [...requestedTurns].some(turn => !returnedTurns.has(turn));
    run.summary.status = termination?.status ?? 'running';
    run.summary.terminationReason = termination?.reason ?? null;
    runs.set(run.summary.id, run);
    if (damagedTail) await append(run, 'recovery', { reason: 'incomplete_event_tail', originalLogPreserved: true });
    if (!termination) await finish(run, 'interrupted', 'server_restarted');
    else await checkpoint(run);
  }

  async function createRun(input) {
    const spec = normalizeSpec(input?.spec);
    const launch = normalizeLaunch(input?.launch);
    const materialSelection = normalizeSelectionRecord(input?.materialSelection);
    const batch = normalizeBatch(input?.batch);
    const study = normalizeStudy(input?.study);
    if (batch && study) fail('Batch and study provenance are mutually exclusive.');
    const requestGuard = normalizeRequestGuard(input?.requestGuard);
    if (study && !requestGuard) fail('Study runs require an injected request guard.', 503);
    if (!study && requestGuard) fail('A request spending guard is only valid for a trusted study run.');
    const { sources, sourceManifest } = await freezeSources(input?.sources);
    validateSelectionSources(materialSelection, sources, sourceManifest);
    if (closed) fail('The experiment runner is closing.', 503);
    // The connection captures credentials privately, once, for this run.
    const connection = await providerFactory(spec.provider);
    if (!connection || typeof connection.generate !== 'function') fail('The selected provider is not connected.', 503);
    if (closed) fail('The experiment runner is closing.', 503);
    const id = `run-${randomUUID()}`, createdAt = now();
    const state = createState({ id, sources, rules: { maxActions: spec.maxActions, maxPieces: spec.maxPieces } });
    const policy = effectiveRunPolicy({ rules: state.rules, study: Boolean(study) });
    const project = { format: 'offcut-project', version: 1, id, createdAt, updatedAt: createdAt, sources: state.sources, canvas: state.canvas, rules: state.rules, actions: [], cursor: 0 };
    const provider = providerMetadata(connection);
    const run = { dir: join(dataDir, id), summary: { id, status: 'running', createdAt, updatedAt: createdAt, spec, ...(launch ? { launch } : {}), ...(materialSelection ? { materialSelection } : {}), ...(batch ? { batch } : {}), ...(study ? { study } : {}), policy, provider, turns: 0, acceptedActions: 0, rejectedBatches: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, usageIncomplete: false, costUSD: null, title: state.title, terminationReason: null, sourceManifest, revision: `${id}:0` }, project, states: [state], events: [], controller: new AbortController(), cancel: null, task: null, hadIncompleteUsage: false, requestGuard };
    const description = descriptionEvidence(run);
    if (description) run.summary.description = description;
    await mkdir(join(run.dir, 'assets'), { recursive: true, mode: 0o700 });
    await atomicJSON(join(run.dir, 'initial.project.json'), project);
    await append(run, 'run_started', { spec, ...(launch ? { launch } : {}), ...(materialSelection ? { materialSelection } : {}), ...(batch ? { batch } : {}), ...(study ? { study } : {}), policy: clone(policy), provider, sourceManifest, canvas: state.canvas, rules: state.rules });
    // The launch receipt is durable before execute can make any provider call.
    await checkpoint(run);
    runs.set(id, run);
    active = id;
    run.task = execute(run, connection).catch(error => {
      // Persistence failures cannot be represented as a trustworthy committed
      // event; leave the log recoverable and expose the failure in this process.
      run.summary.status = 'failed';
      run.summary.terminationReason = 'persistence_error';
      run.summary.updatedAt = now();
      if (active === id) active = null;
    });
    return summary(run);
  }

  function stepFor(run, options = {}) {
    const step = options.step ?? run.project.cursor;
    if (!Number.isInteger(step) || step < 0) fail('Replay step must be a non-negative integer.');
    if (step > run.project.actions.length) fail('That experiment replay step does not exist.', 404);
    return step;
  }
  async function stopRun(run, status, reason) {
    if (run.summary.status === 'running') {
      run.cancel ??= { status, reason };
      run.controller.abort(new Error('Experiment stopped.'));
    }
    // A terminal status can be visible while its final checkpoint is flushing.
    await run.task;
    return summary(run);
  }

  return {
    start(input) {
      if (closed) return Promise.reject(Object.assign(new Error('The experiment runner is closing.'), { status: 503 }));
      if (input?.launch?.clientRequestId) {
        const existing = [...runs.values()].find(run => run.summary.launch?.clientRequestId === input.launch.clientRequestId);
        if (existing) {
          if (existing.summary.launch.requestFingerprint !== input.launch.requestFingerprint) {
            return Promise.reject(Object.assign(new Error('This launch identifier was already used with different settings.'), { status: 409, code: 'RECEIPT_CONFLICT' }));
          }
          return Promise.resolve(summary(existing));
        }
      }
      if (starting || active) return Promise.reject(Object.assign(new Error('An experiment is already running. Stop it or wait for it to finish.'), { status: 409 }));
      starting = createRun(input).finally(() => { starting = null; });
      return starting;
    },
    findLaunch(clientRequestId) {
      if (typeof clientRequestId !== 'string') return null;
      const run = [...runs.values()].find(item => item.summary.launch?.clientRequestId === clientRequestId);
      return run ? summary(run) : null;
    },
    list() { return [...runs.values()].map(summary).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },
    get(id) { const run = find(id); return { ...summary(run), state: compactState(run.states.at(-1)) }; },
    events(id) { return clone(find(id).events); },
    project(id, options) { const run = find(id); return { ...clone(run.project), cursor: stepFor(run, options) }; },
    state(id, options) { const run = find(id); return clone(run.states[stepFor(run, options)]); },
    async bundle(id) {
      const run = find(id);
      // Snapshot metadata before awaiting reads so a running export is coherent.
      const output = { format: 'offcut-run', version: 1, run: summary(run), project: clone(run.project), events: clone(run.events), assets: {} };
      for (const source of output.project.sources) {
        const { bytes, mime } = decodeImage(source.dataUrl);
        output.assets[hash(bytes)] = { mime, dataUrl: source.dataUrl };
      }
      const references = new Map();
      for (const event of output.events) if (event.type === 'observation') {
        references.set(event.canvasSha256, 'image/png');
        for (const image of event.images) references.set(image.sha256, image.mime);
      }
      for (const [sha256, mime] of references) if (!output.assets[sha256]) {
        const bytes = await readFile(join(run.dir, 'assets', sha256));
        output.assets[sha256] = { mime, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
      }
      return output;
    },
    async asset(id, sha256) {
      const run = find(id);
      if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) fail('Observation image not found.', 404);
      try { return await readFile(join(run.dir, 'assets', sha256)); }
      catch (error) { if (error.code === 'ENOENT') fail('Observation image not found.', 404); throw error; }
    },
    async stop(id) { return stopRun(find(id), 'stopped', 'user_stopped'); },
    async interrupt(id) { return stopRun(find(id), 'interrupted', 'server_closed'); },
    async wait(id) { const run = find(id); await run.task; return summary(run); },
    async close() {
      closed = true;
      await starting?.catch(() => {});
      if (active) await stopRun(find(active), 'interrupted', 'server_closed');
      await Promise.all([...runs.values()].map(run => run.task));
    },
  };
}
