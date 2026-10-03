import { mkdir, readFile, readdir, rename, writeFile, copyFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createState, applyAction } from './engine.mjs';
import { getSharp, renderPNG } from './render.mjs';

const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const LIMITS = { maxTurns: [12, 1, 40], maxActions: [120, 1, 240], maxPieces: [24, 1, 64], maxOutputTokens: [4096, 256, 16384], maxMinutes: [10, 1, 60] };
const POLICY = Object.freeze({ version: 3, protocol: 'offcut-actions-v3', initialCanvas: 'blank', maxBatchActions: 12, maxContextTextCharacters: 250000, observation: { version: 1, sourceImages: 'all-every-turn', canvas: 'every-turn', priorImages: 'omitted-text-history-retained', maxEdge: 1536, format: 'png', resize: 'inside-without-enlargement' }, completion: { requiresObservedCanvas: true, reviewWithinTurnBudget: true, actionLimitReviewTurns: 1 }, retries: 'none', costUSD: null });
const RUN_ID = /^run-[a-f0-9-]{36}$/;

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function normalizeSpec(input) {
  if (!object(input)) fail('An experiment spec is required.');
  const allowed = new Set(['provider', 'model', 'prompt', ...Object.keys(LIMITS)]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`Unknown experiment setting: ${key}.`);
  if (input.provider !== 'openai') fail('This runner currently supports the openai provider.');
  if (typeof input.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(input.model)) fail('Choose a valid model identifier.');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 12000) fail('The experiment prompt must contain 1–12000 characters.');
  const spec = { provider: input.provider, model: input.model, prompt: input.prompt.trim() };
  for (const [key, [fallback, min, max]] of Object.entries(LIMITS)) {
    const value = input[key] ?? fallback;
    if (!Number.isInteger(value) || value < min || value > max) fail(`${key} must be an integer from ${min} to ${max}.`);
    spec[key] = value;
  }
  return spec;
}

function normalizeLaunch(input) {
  if (input === undefined) return undefined;
  if (!object(input) || Object.keys(input).length !== 2
    || typeof input.clientRequestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.clientRequestId)
    || typeof input.requestFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.requestFingerprint)) fail('Invalid launch receipt.');
  // Store only the token and fingerprint, never a request body or credentials.
  return { clientRequestId: input.clientRequestId, requestFingerprint: input.requestFingerprint };
}

function decodeImage(dataUrl) {
  const match = typeof dataUrl === 'string' && /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match || !match[2] || match[2].length % 4) fail('Run sources must be embedded PNG, JPEG, or WebP images.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 16 * 1024 * 1024) fail('Each run source must be at most 16 MB.');
  return { bytes, mime: `image/${match[1]}` };
}

async function freezeSources(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 24) fail('Choose between 1 and 24 source images.');
  let state;
  try { state = createState({ sources: clone(input) }); } catch (error) { fail(error.message); }
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
    sourceManifest.push({ ...description, sha256: hash(bytes) });
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

function instructions(rules) {
  return `You are making a collage in Offcut using ONLY the supplied source material. Follow the user's artistic brief, and inspect the images attached to each turn before deciding what to do.
Return one JSON object, without commentary outside it: {"decision_note":"a brief description of the next decision, not private reasoning","actions":[...],"done":false}. decision_note is at most 2000 characters. Submit at most 12 actions per turn. Set done true only after inspecting the latest canvas and deciding it is finished. Leave a turn in your budget to look at the result of your last visual edits. If done true accompanies edits that change the visible composition, the edits are accepted but finishing waits for another observation and your confirmation. On that next turn you may revise, or finish with no visual changes (describe is allowed). Otherwise submit at least one action. If reviewOnly is true, the action budget is exhausted: inspect the canvas, submit an empty actions array, and set done true if satisfied or false to end unfinished. Review turns count toward the same turn, time, and output-token limits. A batch is atomic: if any action is invalid, the entire batch is rejected. You can correct it on your next turn while budgets remain.
Available actions and exact fields:
{"type":"cut","sourceId":"id","pieceId":"chosen-id","polygon":[[x,y],[x,y],[x,y]]}
{"type":"trim","pieceId":"existing-id","newPieceId":"new-unique-id","polygon":[[x,y],[x,y],[x,y]]}
{"type":"place","pieceId":"id","x":500,"y":600,"rotation":0,"scale":1}
{"type":"transform","pieceId":"id","x":500,"y":600,"rotation":30,"scale":1}
{"type":"reorder","pieceId":"id","index":0}
{"type":"remove","pieceId":"id"}
{"type":"describe","title":"Title","statement":"Artist statement"}
Cuts and trim masks use ORIGINAL source-image pixel coordinates, even when the attached observation has been resized. Input polygons need 3–${rules.maxVertices} vertices, no crossing edges, at least ${rules.minArea} square source pixels, and must stay inside that source. Cuts from the same source cannot overlap already consumed material, including material held by hidden or retired pieces. Each cut creates an initially hidden piece. Place makes it visible.
Trim physically divides one usable piece. Its polygon is a mask: only existing parent material inside that mask is retained, so the mask may extend outside the parent or across its holes without adding any material. A trim must retain some material and separate some offcut; empty or unchanged results are rejected. Every connected retained component becomes a child, preserving retained pixels in their exact canvas position and layer and inheriting visibility, rotation, and scale. Every connected offcut also becomes a usable child, initially hidden in the tray. You can place, transform, reorder, remove, or trim those offcuts. The first retained child uses the required unique newPieceId; additional retained children and all offcuts receive generated piece-N IDs. Inspect the returned state before referring to generated IDs. Each child records parentPieceId and trimRole (retained or offcut). A piece's polygon is its outer boundary; optional holes are arrays of source-coordinate polygons representing absent material. Holes cannot be filled by a later trim. Supply only the polygon mask in a trim action; the engine derives any holes.
The parent becomes permanently hidden and unusable, with supersededBy naming the first retained child and childPieceIds listing all children. Use child IDs afterward. The same source material cannot be cut again, but the offcuts remain available through their child IDs. Each trim costs one action. The ${rules.maxPieces}-piece limit counts usable pieces, including hidden offcuts; retired parents do not count. The trim is rejected atomically if all its children would exceed that limit. Generated child boundaries and small scraps are preserved even below the input minimum area or above the input vertex limit; a trim whose complete output exceeds 8192 boundary vertices is rejected. Removal hides a usable piece without freeing material or capacity.
Placement x/y is the center of the piece's outer bounding box on the canvas, rotation is clockwise degrees, and scale is uniform from ${rules.minScale} to ${rules.maxScale}. Piece order is back to front, including hidden and retired pieces; index 0 is the back. Transform does not unhide a piece. Explicit placement centers must lie inside the canvas; edges may extend off-canvas. Trim automatically adjusts child centers to preserve source-pixel positions, even if a derived center falls outside the canvas. No generated pixels, filters, added type, new image sources, code execution, or other tools are available. The state lists all pieces, including hidden and retired ones, and remaining turn/action budgets are provided. Describe counts as an action. Use explicit pieceId values for stable references. Finish with a title and statement if the budget permits.`;
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
export async function createRunManager({ dataDir, providerFactory }) {
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
    const observed = await getSharp()(bytes, { limitInputPixels: 20_000_000 }).resize({ width: POLICY.observation.maxEdge, height: POLICY.observation.maxEdge, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    const sha256 = await putAsset(run, observed.data);
    return { attachment: { id, dataUrl: `data:image/png;base64,${observed.data.toString('base64')}` }, description: { id, kind, mime: 'image/png', sha256, originalSha256: originalHash ?? hash(bytes), originalWidth: width, originalHeight: height, width: observed.info.width, height: observed.info.height } };
  }
  async function finish(run, status, reason) {
    if (run.summary.status !== 'running') return;
    await append(run, 'termination', { status, reason, turns: run.summary.turns, acceptedActions: run.summary.acceptedActions, usage: run.summary.usage, usageIncomplete: run.summary.usageIncomplete, costUSD: null });
    run.summary.status = status;
    run.summary.terminationReason = reason;
    await checkpoint(run);
  }
  function cancelled(run) {
    if (run.controller.signal.aborted) throw run.controller.signal.reason;
  }
  async function execute(run, connection) {
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
        const request = { model: run.summary.spec.model, instructions: instructions(current.rules), maxOutputTokens: run.summary.spec.maxOutputTokens, messages: [...history, userMessage] };
        const contextCharacters = request.instructions.length + request.messages.reduce((sum, message) => sum + message.text.length, 0);
        if (contextCharacters > POLICY.maxContextTextCharacters) return await finish(run, 'limit_reached', 'context_limit');
        // Hash references point to the exact image bytes sent in native image parts.
        await append(run, 'request', { turn, request: { ...request, messages: request.messages.map(message => ({ ...message, ...(message.images ? { images: descriptions.map(({ id, sha256, mime }) => ({ id, sha256, mime })) } : {}) })) } });
        run.summary.turns = turn;
        run.summary.usageIncomplete = true;
        await saveSummary(run);
        cancelled(run);
        const output = await abortable(() => connection.generate({ ...request, signal: run.controller.signal }), run.controller.signal);
        cancelled(run);
        const usage = tokenUsage(output?.usage);
        const usageIncomplete = !completeUsage(output?.usage);
        await append(run, 'model_output', { turn, text: typeof output?.text === 'string' ? output.text : '', raw: output?.raw ?? null, model: output?.model ?? null, responseId: output?.responseId ?? null, usage, usageIncomplete });
        run.hadIncompleteUsage ||= usageIncomplete;
        run.summary.usageIncomplete = run.hadIncompleteUsage;
        for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) run.summary.usage[key] += usage[key];
        history.push({ role: 'user', text: userText }, { role: 'assistant', text: typeof output?.text === 'string' ? output.text : '' });
        cancelled(run);
        let parsed, nextStates;
        try {
          parsed = parseOutput(output?.text, reviewOnly);
          if (reviewOnly && parsed.actions.length) fail('The action budget is exhausted. This final review cannot apply more actions.');
          nextStates = [];
          let next = current;
          for (const action of parsed.actions) {
            next = applyAction(next, action);
            next.sources = run.project.sources;
            nextStates.push(next);
          }
        } catch (error) {
          run.summary.rejectedBatches++;
          feedback = `Your entire previous batch was rejected; no actions were applied. ${error.message}`;
          await append(run, 'batch_result', { turn, accepted: false, code: error.code ?? 'INVALID_OUTPUT', error: error.message, step: run.project.cursor });
          await saveSummary(run);
          cancelled(run);
          if (reviewOnly) return await finish(run, 'limit_reached', 'action_limit');
          continue;
        }
        cancelled(run);
        const canvasChanged = visibleScene(current) !== visibleScene(nextStates.at(-1) ?? current);
        const completionDeferred = parsed.done && canvasChanged;
        const result = await append(run, 'batch_result', { turn, accepted: true, actions: parsed.actions, decision_note: parsed.decision_note, done: parsed.done, completionDeferred, fromStep: run.project.cursor, step: run.project.cursor + parsed.actions.length });
        run.states.push(...nextStates);
        run.project.actions.push(...parsed.actions.map(action => ({ action: clone(action), at: result.at })));
        run.project.cursor = run.project.actions.length;
        run.summary.acceptedActions = run.project.cursor;
        run.summary.title = run.states.at(-1).title;
        await checkpoint(run);
        cancelled(run);
        if (parsed.done && !completionDeferred) {
          await append(run, 'final_review', { turn, observedStep, step: run.project.cursor, canvasSha256: canvasHash });
          cancelled(run);
          return await finish(run, 'completed', 'model_finished');
        }
        if (reviewOnly) return await finish(run, 'limit_reached', 'action_limit');
        feedback = `Accepted all ${parsed.actions.length} actions. ${completionDeferred ? 'Finishing is deferred until you inspect the updated canvas attached to your next turn. You may revise, or confirm done without changing the visible composition.' : 'Inspect the updated canvas and continue or finish.'}`;
      }
      cancelled(run);
      await finish(run, 'limit_reached', 'turn_limit');
    } catch (error) {
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
    const run = { dir, summary: saved, project: { ...initial, actions: [], cursor: 0 }, states: [initialState], events, controller: new AbortController(), cancel: null, task: null, hadIncompleteUsage: false };
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
    const { sources, sourceManifest } = await freezeSources(input?.sources);
    if (closed) fail('The experiment runner is closing.', 503);
    // The connection captures credentials privately, once, for this run.
    const connection = await providerFactory(spec.provider);
    if (!connection || typeof connection.generate !== 'function') fail('The selected provider is not connected.', 503);
    if (closed) fail('The experiment runner is closing.', 503);
    const id = `run-${randomUUID()}`, createdAt = now();
    const state = createState({ id, sources, rules: { maxActions: spec.maxActions, maxPieces: spec.maxPieces } });
    const project = { format: 'offcut-project', version: 1, id, createdAt, updatedAt: createdAt, sources: state.sources, canvas: state.canvas, rules: state.rules, actions: [], cursor: 0 };
    const provider = providerMetadata(connection);
    const run = { dir: join(dataDir, id), summary: { id, status: 'running', createdAt, updatedAt: createdAt, spec, ...(launch ? { launch } : {}), policy: clone(POLICY), provider, turns: 0, acceptedActions: 0, rejectedBatches: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, usageIncomplete: false, costUSD: null, title: state.title, terminationReason: null, sourceManifest, revision: `${id}:0` }, project, states: [state], events: [], controller: new AbortController(), cancel: null, task: null, hadIncompleteUsage: false };
    await mkdir(join(run.dir, 'assets'), { recursive: true, mode: 0o700 });
    await atomicJSON(join(run.dir, 'initial.project.json'), project);
    await append(run, 'run_started', { spec, ...(launch ? { launch } : {}), policy: clone(POLICY), provider, sourceManifest, canvas: state.canvas, rules: state.rules });
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
      if (starting || active) return Promise.reject(Object.assign(new Error('An experiment is already running. Stop it or wait for it to finish.'), { status: 409 }));
      starting = createRun(input).finally(() => { starting = null; });
      return starting;
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
    async close() {
      closed = true;
      await starting?.catch(() => {});
      if (active) await stopRun(find(active), 'interrupted', 'server_closed');
      await Promise.all([...runs.values()].map(run => run.task));
    },
  };
}
