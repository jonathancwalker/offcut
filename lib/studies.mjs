import { createHash, randomUUID } from 'node:crypto';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const OPERATIONAL = new Set(['provider_or_runner_error', 'persistence_error', 'server_closed', 'unknown_usage', 'campaign_reconciliation_required', 'study_budget']);
const RETRYABLE_PREFLIGHT = new Set(['MISSING_CREDENTIAL']);
const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(message, status = 400, code = 'STUDY_CONTROL_ERROR') {
  throw Object.assign(new Error(message), { status, code });
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : canonicalJSON(value)).digest('hex');

function controlInput(body, requireManifest = false) {
  const allowed = requireManifest ? ['clientRequestId', 'manifestHash'] : ['clientRequestId'];
  if (!object(body) || Reflect.ownKeys(body).length !== allowed.length || allowed.some(key => !Object.hasOwn(body, key))) fail(`Study control requires only ${allowed.join(' and ')}.`);
  if (typeof body.clientRequestId !== 'string' || !UUID.test(body.clientRequestId)) fail('clientRequestId must be a UUID.');
  if (requireManifest && (typeof body.manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.manifestHash))) fail('manifestHash must be a SHA-256 hash.');
  return clone(body);
}

function summary(state) {
  const statuses = Object.create(null);
  for (const entry of state.entries) statuses[entry.status] = (statuses[entry.status] ?? 0) + 1;
  return { ...clone(state), progress: { total: state.entries.length, statuses } };
}

/** Run a frozen Study matrix sequentially. No live catalog input is accepted. */
export async function createStudyManager({ store, runs, campaigns, admission = {} } = {}) {
  if (!store || !runs || !campaigns || typeof store.transition !== 'function' || typeof store.resolveSources !== 'function') {
    throw new TypeError('Study store, run manager, and campaign manager are required.');
  }
  const contexts = new Map();
  let activeId = null;
  let closed = false;

  for (const item of store.list()) {
    if (item.status === 'blocked') continue;
    const detail = store.get(item.id);
    contexts.set(item.id, { id: item.id, state: clone(detail.state), task: null, activeRunId: null });
  }
  const context = id => {
    const value = contexts.get(id);
    if (!value) fail('Study not found.', 404, 'STUDY_NOT_FOUND');
    return value;
  };
  const manifest = id => store.manifest(id);

  async function persist(ctx, type, payload = {}) {
    ctx.state.updatedAt = now();
    await store.transition(ctx.id, { type, at: ctx.state.updatedAt, payload }, ctx.state);
  }

  function priorReceipt(ctx, action, body) {
    ctx.state.controls ??= {};
    const fingerprint = sha256({ action, body });
    const previous = ctx.state.controls[body.clientRequestId];
    if (previous) {
      if (previous.action !== action || previous.fingerprint !== fingerprint) fail('This control identifier was already used with different settings.', 409, 'RECEIPT_CONFLICT');
      return { duplicate: true, fingerprint };
    }
    return { duplicate: false, fingerprint };
  }

  function saveReceipt(ctx, action, body, fingerprint) {
    ctx.state.controls[body.clientRequestId] = { action, fingerprint, at: now() };
  }

  function uncalibratedRoutes(target) {
    if (target.plan.normalizedDraft.kind !== 'primary') return [];
    const needed = new Set(target.cells.map(cell => `${cell.spec.provider}\n${cell.spec.model}`));
    const primaryPacks = new Set((target.plan.packIdentities ?? []).map(pack => pack.contentOnlyPackHash));
    for (const candidate of store.list()) {
      if (candidate.kind !== 'calibration' || candidate.status !== 'completed') continue;
      const detail = store.get(candidate.id);
      const frozen = detail.manifest;
      if (frozen.campaign.id !== target.campaign.id || frozen.protocolSnapshot.executionFingerprint !== target.protocolSnapshot.executionFingerprint) continue;
      if ((frozen.plan.packIdentities ?? []).every(pack => primaryPacks.has(pack.contentOnlyPackHash))) continue;
      for (const entry of detail.state.entries) {
        if (!entry.runId || !['completed', 'limit_reached'].includes(entry.status)) continue;
        const cell = frozen.cells.find(value => value.cellId === entry.cellId);
        let run;
        try { run = runs.get(entry.runId); } catch { continue; }
        if (cell && run.turns > 0) needed.delete(`${cell.spec.provider}\n${cell.spec.model}`);
      }
    }
    return [...needed];
  }

  async function reviewAdmission(ctx) {
    const frozen = manifest(ctx.id);
    if (typeof store.verifyCompatibility === 'function') await store.verifyCompatibility(ctx.id);
    if (frozen.plan.normalizedDraft.kind === 'primary') {
      if (frozen.protocolSnapshot.codeClean !== true) fail('Primary collection requires a committed clean code snapshot.', 409, 'CODE_SNAPSHOT_UNVERIFIED');
      if (uncalibratedRoutes(frozen).length) fail('Run and finish calibration for every selected model route before primary collection.', 409, 'MODEL_COMPATIBILITY_UNVERIFIED');
    }
    const campaign = campaigns.get(frozen.campaign.id);
    if (campaign.status !== 'active' || campaign.availableMicros <= 0) fail('The Study allowance cannot admit another request.', 409, campaign.status === 'reconciliation_required' ? 'CAMPAIGN_RECONCILIATION_REQUIRED' : 'CAMPAIGN_BLOCKED');
    await admission.review?.({ study: summary(ctx.state), manifest: clone(frozen), campaign: clone(campaign) });
    return frozen;
  }

  async function reconcile(ctx) {
    if (!['running', 'pausing', 'stopping'].includes(ctx.state.status)) return;
    let blocked = false;
    for (const entry of ctx.state.entries) {
      if (!['starting', 'running'].includes(entry.status)) continue;
      const child = entry.childClientRequestId ? runs.findLaunch?.(entry.childClientRequestId) : null;
      if (!child) {
        if (entry.runId) { blocked = true; entry.status = 'failed'; entry.terminationReason = 'missing_child_receipt'; }
        else entry.status = 'queued';
        continue;
      }
      if (child.launch?.requestFingerprint !== entry.childFingerprint || child.study?.id !== ctx.id || child.study?.cellId !== entry.cellId) {
        blocked = true; entry.status = 'failed'; entry.terminationReason = 'child_receipt_mismatch'; continue;
      }
      entry.runId = child.id;
      entry.status = child.status === 'running' ? 'interrupted' : child.status;
      entry.terminationReason = child.terminationReason ?? (child.status === 'running' ? 'server_restarted' : null);
    }
    ctx.state.status = blocked ? 'blocked' : 'paused';
    ctx.state.pauseReason = blocked ? 'recovery_mismatch' : 'server_restarted';
    await persist(ctx, blocked ? 'study_blocked' : 'study_recovered', { reason: ctx.state.pauseReason });
  }
  for (const ctx of contexts.values()) await reconcile(ctx);

  function childFingerprint(frozen, cell) {
    return sha256({ studyId: frozen.id, manifestHash: frozen.manifestHash, cellId: cell.cellId, spec: cell.spec,
      sources: cell.sourceIds.map(id => [id, cell.sourceHashes[id]]), executionFingerprint: frozen.protocolSnapshot.executionFingerprint });
  }

  async function runCell(ctx, frozen, entry) {
    const cell = frozen.cells.find(value => value.cellId === entry.cellId);
    if (!cell) fail('The immutable execution order references a missing cell.', 409, 'STUDY_BLOCKED');
    entry.childClientRequestId ??= randomUUID();
    entry.childFingerprint ??= childFingerprint(frozen, cell);
    entry.status = 'starting';
    entry.terminationReason = null;
    await persist(ctx, 'entry_starting', { cellId: entry.cellId, clientRequestId: entry.childClientRequestId, fingerprint: entry.childFingerprint });
    let child = runs.findLaunch?.(entry.childClientRequestId);
    if (child && (child.launch?.requestFingerprint !== entry.childFingerprint || child.study?.id !== ctx.id || child.study?.cellId !== entry.cellId)) {
      fail('A child launch receipt conflicts with the frozen Study cell.', 409, 'CHILD_RECEIPT_MISMATCH');
    }
    if (!child) {
      const sources = await store.resolveSources(ctx.id, entry.cellId);
      child = await runs.start({
        spec: clone(cell.spec), sources, requestGuard: campaigns.guard(frozen.campaign.id),
        launch: { clientRequestId: entry.childClientRequestId, requestFingerprint: entry.childFingerprint },
        study: { id: frozen.id, manifestHash: frozen.manifestHash, cellId: cell.cellId, campaignId: frozen.campaign.id },
      });
    }
    entry.runId = child.id;
    entry.status = 'running';
    ctx.activeRunId = child.id;
    await persist(ctx, 'entry_started', { cellId: entry.cellId, runId: child.id });
    if (ctx.state.status === 'stopping') await runs.stop(child.id);
    const ended = child.status === 'running' ? await runs.wait(child.id) : child;
    ctx.activeRunId = null;
    entry.status = ended.status;
    entry.terminationReason = ended.terminationReason ?? null;
    await persist(ctx, 'entry_terminal', { cellId: entry.cellId, runId: child.id, status: entry.status, terminationReason: entry.terminationReason });
    return ended;
  }

  async function execute(ctx, frozen) {
    try {
      while (!closed && ['running', 'pausing', 'stopping'].includes(ctx.state.status)) {
        if (ctx.state.status === 'stopping') break;
        const entry = ctx.state.entries.find(value => value.status === 'queued');
        if (!entry) break;
        let ended;
        try { ended = await runCell(ctx, frozen, entry); }
        catch (error) {
          entry.status = 'failed';
          entry.terminationReason = error.code ?? 'child_launch_failed';
          ctx.state.status = 'paused';
          ctx.state.pauseReason = entry.terminationReason;
          await persist(ctx, 'study_paused', { reason: ctx.state.pauseReason, cellId: entry.cellId });
          return;
        }
        if (OPERATIONAL.has(ended.terminationReason)) {
          ctx.state.status = 'paused';
          ctx.state.pauseReason = ended.terminationReason;
          await persist(ctx, 'study_paused', { reason: ctx.state.pauseReason, cellId: entry.cellId });
          return;
        }
        if (ctx.state.status === 'pausing') break;
      }
      if (closed) {
        ctx.state.status = 'paused';
        ctx.state.pauseReason = 'server_closed';
        await persist(ctx, 'study_paused', { reason: 'server_closed' });
      } else if (ctx.state.status === 'stopping') {
        for (const entry of ctx.state.entries) if (['queued', 'starting'].includes(entry.status)) entry.status = 'not_run';
        ctx.state.status = 'stopped';
        ctx.state.pauseReason = null;
        await persist(ctx, 'study_stopped', { reason: 'user_stopped' });
      } else if (ctx.state.status === 'pausing') {
        ctx.state.status = 'paused';
        ctx.state.pauseReason = 'user_pause';
        await persist(ctx, 'study_paused', { reason: 'user_pause' });
      } else if (!ctx.state.entries.some(entry => entry.status === 'queued')) {
        ctx.state.status = 'completed';
        ctx.state.pauseReason = null;
        await persist(ctx, 'study_completed');
      }
    } finally {
      if (activeId === ctx.id) activeId = null;
      try { await admission.release?.(ctx.id); } catch {}
    }
  }

  async function launch(id, action, body, requiredStatus) {
    if (closed) fail('The Study scheduler is closing.', 503, 'STUDY_SCHEDULER_CLOSED');
    const input = controlInput(body, true);
    const ctx = context(id);
    const checked = priorReceipt(ctx, action, input);
    if (checked.duplicate) return summary(ctx.state);
    if (ctx.state.status !== requiredStatus) fail(`This Study must be ${requiredStatus} before ${action}.`, 409, 'INVALID_STUDY_STATE');
    const frozen = await reviewAdmission(ctx);
    if (input.manifestHash !== frozen.manifestHash) fail('The reviewed Study manifest does not match.', 409, 'MANIFEST_MISMATCH');
    if (activeId && activeId !== id) fail('Another Study is active.', 409, 'LAUNCH_ADMISSION_BUSY');
    await admission.acquire?.(id);
    try {
      saveReceipt(ctx, action, input, checked.fingerprint);
      const requeuedCellIds = [];
      if (action === 'resume') {
        for (const entry of ctx.state.entries) {
          if (entry.status !== 'failed' || entry.runId || !RETRYABLE_PREFLIGHT.has(entry.terminationReason)) continue;
          entry.status = 'queued';
          entry.terminationReason = null;
          requeuedCellIds.push(entry.cellId);
        }
      }
      ctx.state.status = 'running';
      ctx.state.pauseReason = null;
      await persist(ctx, action === 'start' ? 'study_started' : 'study_resumed', {
        clientRequestId: input.clientRequestId,
        manifestHash: input.manifestHash,
        ...(requeuedCellIds.length ? { requeuedCellIds } : {}),
      });
      activeId = id;
      ctx.task = execute(ctx, frozen);
      return summary(ctx.state);
    } catch (error) {
      ctx.state.status = 'blocked';
      ctx.state.pauseReason = 'control_persistence_error';
      try { await admission.release?.(id); } catch {}
      throw error;
    }
  }

  return {
    register(id) {
      if (contexts.has(id)) return summary(contexts.get(id).state);
      const detail = store.get(id);
      if (detail.status === 'blocked') fail('A blocked Study cannot be scheduled.', 409, 'STUDY_BLOCKED');
      const ctx = { id, state: clone(detail.state), task: null, activeRunId: null };
      contexts.set(id, ctx);
      return summary(ctx.state);
    },
    list() { return store.list(); },
    get(id) { return summary(context(id).state); },
    hasActive() { return Boolean(activeId || [...contexts.values()].some(ctx => ['running', 'pausing', 'stopping'].includes(ctx.state.status))); },
    start(id, body) { return launch(id, 'start', body, 'ready'); },
    resume(id, body) { return launch(id, 'resume', body, 'paused'); },
    async pause(id, body) {
      const input = controlInput(body); const ctx = context(id);
      const checked = priorReceipt(ctx, 'pause', input);
      if (checked.duplicate) return summary(ctx.state);
      if (ctx.state.status !== 'running') fail('Only a running Study can pause after its current work.', 409, 'INVALID_STUDY_STATE');
      saveReceipt(ctx, 'pause', input, checked.fingerprint);
      ctx.state.status = 'pausing';
      await persist(ctx, 'study_pause_requested', { clientRequestId: input.clientRequestId });
      return summary(ctx.state);
    },
    async stop(id, body) {
      const input = controlInput(body); const ctx = context(id);
      const checked = priorReceipt(ctx, 'stop', input);
      if (checked.duplicate) return summary(ctx.state);
      if (!['running', 'pausing', 'paused'].includes(ctx.state.status)) fail('This Study cannot be stopped in its current state.', 409, 'INVALID_STUDY_STATE');
      saveReceipt(ctx, 'stop', input, checked.fingerprint);
      ctx.state.status = 'stopping';
      await persist(ctx, 'study_stop_requested', { clientRequestId: input.clientRequestId });
      if (ctx.activeRunId) await runs.stop(ctx.activeRunId);
      if (ctx.task) await ctx.task;
      if (ctx.state.status === 'stopping') {
        for (const entry of ctx.state.entries) if (['queued', 'starting'].includes(entry.status)) entry.status = 'not_run';
        ctx.state.status = 'stopped';
        await persist(ctx, 'study_stopped', { reason: 'user_stopped' });
      }
      return summary(ctx.state);
    },
    async close(id, body) {
      const input = controlInput(body); const ctx = context(id);
      const checked = priorReceipt(ctx, 'close', input);
      if (checked.duplicate) return summary(ctx.state);
      if (ctx.state.status !== 'paused') fail('Only a paused Study can be closed.', 409, 'INVALID_STUDY_STATE');
      saveReceipt(ctx, 'close', input, checked.fingerprint);
      for (const entry of ctx.state.entries) if (entry.status === 'queued') entry.status = 'not_run';
      ctx.state.status = 'stopped';
      ctx.state.terminationReason = 'researcher_closed';
      await persist(ctx, 'study_closed', { clientRequestId: input.clientRequestId });
      return summary(ctx.state);
    },
    async wait(id) { const ctx = context(id); await ctx.task; return summary(ctx.state); },
    async closeAll() {
      closed = true;
      for (const ctx of contexts.values()) {
        if (!['running', 'pausing', 'stopping'].includes(ctx.state.status)) continue;
        ctx.state.status = 'stopping';
        if (ctx.activeRunId) await runs.interrupt(ctx.activeRunId);
      }
      await Promise.all([...contexts.values()].map(ctx => ctx.task).filter(Boolean));
    },
  };
}
