import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { accountProviderUsage, accountUsage, estimateProviderRequest, estimateRequest, getRateBook, getRateSnapshot } from './model-rates.mjs';

const CAMPAIGN_ID = /^campaign-[a-f0-9-]{36}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const REQUEST_ID = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/;
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fail(message, status = 400, code = 'CAMPAIGN_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

function exactKeys(input, keys, label) {
  if (!object(input) || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) fail(`${label} must contain only ${keys.join(', ')}.`);
}

function safeMicros(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000) fail(`${label} must be an integer number of microdollars from 0 to 1000000000000.`);
  return value;
}

function normalizeUsage(input) {
  if (!object(input)) return null;
  const integerOrNull = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const inputTokens = integerOrNull(input.inputTokens);
  const outputTokens = integerOrNull(input.outputTokens);
  const totalTokens = integerOrNull(input.totalTokens);
  const usage = { inputTokens, outputTokens, totalTokens };
  if (object(input.inputTokensDetails)) usage.inputTokensDetails = { cachedTokens: integerOrNull(input.inputTokensDetails.cachedTokens) };
  if (object(input.outputTokensDetails)) usage.outputTokensDetails = { reasoningTokens: integerOrNull(input.outputTokensDetails.reasoningTokens) };
  return usage;
}

function reconstruction(config, events) {
  const reservations = new Map();
  const reconciliations = new Map();
  for (const event of events) {
    if (event.type === 'reservation_created') {
      if (reservations.has(event.requestId)) throw new Error(`Campaign ${config.id} has a duplicate request reservation.`);
      reservations.set(event.requestId, { ...clone(event), status: 'reserved' });
      continue;
    }
    if (event.type === 'reservation_dispatching') {
      const item = [...reservations.values()].find(value => value.reservationId === event.reservationId);
      if (!item || item.status !== 'reserved') throw new Error(`Campaign ${config.id} has an invalid dispatch transition.`);
      item.status = 'dispatching';
      item.dispatchingAt = event.at;
      continue;
    }
    if (event.type === 'reservation_settled') {
      const item = [...reservations.values()].find(value => value.reservationId === event.reservationId);
      if (!item || !['dispatching', 'unresolved'].includes(item.status)) throw new Error(`Campaign ${config.id} has an invalid settlement transition.`);
      Object.assign(item, clone(event), { status: 'settled' });
      continue;
    }
    if (event.type === 'reservation_unresolved') {
      const item = [...reservations.values()].find(value => value.reservationId === event.reservationId);
      if (!item || !['dispatching', 'unresolved'].includes(item.status)) throw new Error(`Campaign ${config.id} has an invalid unresolved transition.`);
      item.status = 'unresolved';
      item.unresolvedReason = event.reason;
      continue;
    }
    if (event.type === 'reservation_released') {
      const item = [...reservations.values()].find(value => value.reservationId === event.reservationId);
      if (!item || item.status !== 'reserved') throw new Error(`Campaign ${config.id} released a reservation that may have been dispatched.`);
      item.status = 'released';
      item.releasedAt = event.at;
      continue;
    }
    if (event.type === 'reservation_reconciled') {
      const item = [...reservations.values()].find(value => value.reservationId === event.reservationId);
      if (!item || !['dispatching', 'unresolved'].includes(item.status)) throw new Error(`Campaign ${config.id} has an invalid reconciliation transition.`);
      Object.assign(item, clone(event), { status: 'reconciled' });
      if (reconciliations.has(event.clientRequestId)) throw new Error(`Campaign ${config.id} has a duplicate reconciliation receipt.`);
      reconciliations.set(event.clientRequestId, item);
      continue;
    }
    throw new Error(`Campaign ${config.id} contains an unknown ledger event.`);
  }
  return { reservations, reconciliations };
}

function totals(campaign) {
  let accountedMicros = 0, reservedMicros = 0, uncertainMicros = 0, overrun = false;
  for (const item of campaign.reservations.values()) {
    if (item.status === 'settled' || item.status === 'reconciled') accountedMicros += item.chargeMicros;
    else if (item.status === 'reserved') reservedMicros += item.reservedMicros;
    else if (item.status === 'dispatching' || item.status === 'unresolved') uncertainMicros += item.reservedMicros;
    overrun ||= item.overrun === true;
  }
  const availableMicros = campaign.config.limitMicros - accountedMicros - reservedMicros - uncertainMicros;
  const status = overrun || availableMicros < 0 ? 'blocked' : uncertainMicros > 0 ? 'reconciliation_required' : 'active';
  return { limitMicros: campaign.config.limitMicros, accountedMicros, reservedMicros, uncertainMicros, availableMicros, status };
}

function summary(campaign, { details = false } = {}) {
  const value = {
    id: campaign.config.id,
    createdAt: campaign.config.createdAt,
    ...(campaign.config.version === 1 ? {
      rateSnapshotId: campaign.config.rateSnapshot.id,
      rateSnapshotHash: campaign.config.rateSnapshot.hash,
    } : {
      rateBookId: campaign.config.rateBook.id,
      rateBookHash: campaign.config.rateBook.hash,
      rateSnapshots: campaign.config.rateBook.snapshots.map(snapshot => ({ id: snapshot.id, provider: snapshot.provider, hash: snapshot.hash })),
    }),
    allowanceLabel: 'Study allowance',
    ...totals(campaign),
  };
  if (details) {
    if (campaign.config.version === 1) value.rateSnapshot = clone(campaign.config.rateSnapshot);
    else value.rateBook = clone(campaign.config.rateBook);
    value.reservations = [...campaign.reservations.values()].map(item => ({
      reservationId: item.reservationId, requestId: item.requestId, runId: item.runId, turn: item.turn,
      provider: item.provider ?? 'openai', requestedRoute: item.requestedRoute, status: item.status, reservedMicros: item.reservedMicros,
      ...(Number.isSafeInteger(item.chargeMicros) ? { chargeMicros: item.chargeMicros } : {}),
      ...(item.unresolvedReason ? { unresolvedReason: item.unresolvedReason } : {}),
      ...(item.overrun ? { overrun: true } : {}),
    }));
  }
  return value;
}

async function append(campaign, type, data = {}) {
  const unsigned = { sequence: campaign.events.length + 1, at: now(), type, previousHash: campaign.events.at(-1)?.eventHash ?? null, ...clone(data) };
  const event = { ...unsigned, eventHash: hash(unsigned) };
  const handle = await open(join(campaign.dir, 'ledger.jsonl'), 'a', 0o600);
  try { await handle.writeFile(`${JSON.stringify(event)}\n`); await handle.sync(); } finally { await handle.close(); }
  campaign.events.push(event);
  const state = reconstruction(campaign.config, campaign.events);
  campaign.reservations = state.reservations;
  campaign.reconciliations = state.reconciliations;
  return event;
}

/** Durable local allowance accounting. It never contacts a provider. */
export async function createCampaignManager({ dataDir }) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('A campaign storage directory is required.');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const campaigns = new Map();
  const creationReceipts = new Map();
  const tails = new Map();
  let creationTail = Promise.resolve();

  const serialized = (id, operation) => {
    const previous = tails.get(id) || Promise.resolve();
    const next = previous.then(operation);
    tails.set(id, next.catch(() => {}));
    return next;
  };

  for (const entry of await readdir(dataDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !CAMPAIGN_ID.test(entry.name)) continue;
    const dir = join(dataDir, entry.name);
    const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    if (config.format !== 'offcut-campaign' || ![1, 2].includes(config.version) || config.id !== entry.name || !CAMPAIGN_ID.test(config.id)
      || !UUID.test(config.clientRequestId) || !Number.isSafeInteger(config.limitMicros) || config.limitMicros < 1) {
      throw new Error(`Campaign ${entry.name} has an invalid immutable config.`);
    }
    const reviewed = config.version === 1 ? getRateSnapshot(config.rateSnapshot?.id) : getRateBook(config.rateBook?.id);
    const stored = config.version === 1 ? config.rateSnapshot : config.rateBook;
    const reference = config.version === 1 ? { limitMicros: config.limitMicros, rateSnapshotId: reviewed.id } : { limitMicros: config.limitMicros, rateBookId: reviewed.id };
    if (JSON.stringify(stored) !== JSON.stringify(reviewed)) throw new Error(`Campaign ${entry.name} references changed reviewed rates.`);
    if (config.requestFingerprint !== hash(reference)) throw new Error(`Campaign ${entry.name} has an invalid creation receipt.`);
    let raw = '';
    try { raw = await readFile(join(dir, 'ledger.jsonl'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let previousHash = null;
    const events = raw.split('\n').filter(Boolean).map((line, index) => {
      const event = JSON.parse(line);
      const { eventHash, ...unsigned } = event;
      if (event.sequence !== index + 1 || event.previousHash !== previousHash || eventHash !== hash(unsigned)) {
        throw new Error(`Campaign ${entry.name} has a damaged ledger sequence.`);
      }
      previousHash = eventHash;
      return event;
    });
    const state = reconstruction(config, events);
    const campaign = { dir, config, events, ...state };
    campaigns.set(config.id, campaign);
    if (creationReceipts.has(config.clientRequestId)) throw new Error('A campaign creation receipt was reused.');
    creationReceipts.set(config.clientRequestId, config);
  }

  // A durable reservation with no dispatch marker proves that this process did
  // not cross the network boundary. Release it explicitly during recovery.
  for (const campaign of campaigns.values()) {
    for (const item of [...campaign.reservations.values()]) if (item.status === 'reserved') {
      await append(campaign, 'reservation_released', { reservationId: item.reservationId, reason: 'recovered_before_dispatch' });
    }
  }

  function find(id) {
    if (typeof id !== 'string' || !CAMPAIGN_ID.test(id) || !campaigns.has(id)) fail('Campaign not found.', 404, 'CAMPAIGN_NOT_FOUND');
    return campaigns.get(id);
  }

  async function create(input) {
    const legacy = object(input) && Object.hasOwn(input, 'rateSnapshotId');
    exactKeys(input, ['clientRequestId', 'limitMicros', legacy ? 'rateSnapshotId' : 'rateBookId'], 'Campaign creation');
    if (!UUID.test(input.clientRequestId)) fail('clientRequestId must be a UUID.');
    const limitMicros = safeMicros(input.limitMicros, 'limitMicros');
    if (limitMicros < 1) fail('limitMicros must be at least one microdollar.');
    const reviewedRates = legacy ? getRateSnapshot(input.rateSnapshotId) : getRateBook(input.rateBookId);
    const rateReference = legacy ? { rateSnapshotId: reviewedRates.id } : { rateBookId: reviewedRates.id };
    const requestFingerprint = hash({ limitMicros, ...rateReference });
    const existing = creationReceipts.get(input.clientRequestId);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) fail('This campaign creation identifier was already used with different settings.', 409, 'RECEIPT_CONFLICT');
      return { campaign: summary(find(existing.id), { details: true }), created: false };
    }
    const id = `campaign-${randomUUID()}`, createdAt = now();
    const config = {
      format: 'offcut-campaign', version: legacy ? 1 : 2, id, createdAt, clientRequestId: input.clientRequestId,
      requestFingerprint, limitMicros, ...(legacy ? { rateSnapshot: reviewedRates } : { rateBook: reviewedRates }),
    };
    const staging = join(dataDir, `.campaign-staging-${randomUUID()}`), dir = join(dataDir, id);
    await mkdir(staging, { mode: 0o700 });
    await writeFile(join(staging, 'config.json'), JSON.stringify(config), { flag: 'wx', mode: 0o600 });
    await writeFile(join(staging, 'ledger.jsonl'), '', { flag: 'wx', mode: 0o600 });
    await rename(staging, dir);
    const campaign = { dir, config, events: [], reservations: new Map(), reconciliations: new Map() };
    campaigns.set(id, campaign);
    creationReceipts.set(input.clientRequestId, config);
    return { campaign: summary(campaign, { details: true }), created: true };
  }

  function guard(id) {
    find(id);
    return {
      async reserve({ requestId, runId, turn, provider, request, images }) {
        return serialized(id, async () => {
          const campaign = find(id);
          if (!REQUEST_ID.test(requestId) || typeof runId !== 'string' || !/^run-[a-f0-9-]{36}$/.test(runId) || !Number.isInteger(turn) || turn < 1) fail('Invalid request reservation identity.');
          const selectedProvider = campaign.config.version === 1 ? 'openai' : provider;
          const estimate = campaign.config.version === 1
            ? { provider: selectedProvider, ...estimateRequest(campaign.config.rateSnapshot, { request, images }) }
            : estimateProviderRequest(campaign.config.rateBook, { provider: selectedProvider, request, images });
          const existing = campaign.reservations.get(requestId);
          if (existing) {
            if ((existing.provider ?? 'openai') !== estimate.provider || existing.requestHash !== estimate.requestHash || existing.runId !== runId || existing.turn !== turn) fail('This request identifier was already used for different estimator inputs.', 409, 'RECEIPT_CONFLICT');
            if (existing.status !== 'reserved') fail('This request was already dispatched and cannot be sent again.', 409, 'CAMPAIGN_RECONCILIATION_REQUIRED');
            return clone(existing);
          }
          const balance = totals(campaign);
          if (balance.status === 'blocked') fail('The study allowance is blocked pending review.', 409, 'CAMPAIGN_BLOCKED');
          if (balance.status === 'reconciliation_required') fail('A dispatched request has unresolved billing.', 409, 'CAMPAIGN_RECONCILIATION_REQUIRED');
          if (estimate.reservedMicros > balance.availableMicros) fail('The next model request exceeds the remaining study allowance.', 409, 'STUDY_BUDGET_DENIED');
          const reservationId = `reservation-${randomUUID()}`;
          await append(campaign, 'reservation_created', { reservationId, requestId, runId, turn, ...estimate });
          return clone(campaign.reservations.get(requestId));
        });
      },
      async markDispatching(reservationId) {
        return serialized(id, async () => {
          const campaign = find(id);
          const item = [...campaign.reservations.values()].find(value => value.reservationId === reservationId);
          if (!item) fail('Reservation not found.', 404, 'RESERVATION_NOT_FOUND');
          if (item.status === 'dispatching') return clone(item);
          if (item.status !== 'reserved') fail('Only an undispatched reservation can cross the transport boundary.', 409, 'INVALID_RESERVATION_STATE');
          await append(campaign, 'reservation_dispatching', { reservationId });
          return clone([...campaign.reservations.values()].find(value => value.reservationId === reservationId));
        });
      },
      async settle({ reservationId, usage, responseId, returnedModel }) {
        return serialized(id, async () => {
          const campaign = find(id);
          let item = [...campaign.reservations.values()].find(value => value.reservationId === reservationId);
          if (!item) fail('Reservation not found.', 404, 'RESERVATION_NOT_FOUND');
          const normalizedUsage = normalizeUsage(usage);
          const safeResponseId = typeof responseId === 'string' && /^[a-zA-Z0-9._:-]{1,200}$/.test(responseId) ? responseId : null;
          const settlementFingerprint = hash({ usage: normalizedUsage, responseId: safeResponseId, returnedModel });
          if (item.status === 'settled') {
            if (item.settlementFingerprint !== settlementFingerprint) fail('This reservation was already settled with different usage.', 409, 'SETTLEMENT_CONFLICT');
            return clone(item);
          }
          if (!['dispatching', 'unresolved'].includes(item.status)) fail('Only a dispatched reservation can be settled.', 409, 'INVALID_RESERVATION_STATE');
          let accounted;
          try {
            accounted = campaign.config.version === 1
              ? { provider: 'openai', ...accountUsage(campaign.config.rateSnapshot, { requestedRoute: item.requestedRoute, returnedModel, usage: normalizedUsage }) }
              : accountProviderUsage(campaign.config.rateBook, { provider: item.provider, requestedRoute: item.requestedRoute, returnedModel, usage: normalizedUsage });
          }
          catch (error) {
            if (item.status !== 'unresolved') await append(campaign, 'reservation_unresolved', { reservationId, reason: error.code === 'UNRESOLVED_USAGE' ? error.message : 'Usage could not be accounted.' });
            throw error;
          }
          const overrun = accounted.chargeMicros > item.reservedMicros;
          await append(campaign, 'reservation_settled', {
            reservationId, settlementFingerprint, responseId: safeResponseId,
            returnedModel, usage: normalizedUsage, ...accounted, overrun,
          });
          item = [...campaign.reservations.values()].find(value => value.reservationId === reservationId);
          return clone(item);
        });
      },
      async releaseUndispatched(reservationId, reason = 'cancelled_before_dispatch') {
        return serialized(id, async () => {
          const campaign = find(id);
          const item = [...campaign.reservations.values()].find(value => value.reservationId === reservationId);
          if (!item) fail('Reservation not found.', 404, 'RESERVATION_NOT_FOUND');
          if (item.status === 'released') return clone(item);
          if (item.status !== 'reserved') fail('A reservation cannot be released after dispatch may have begun.', 409, 'INVALID_RESERVATION_STATE');
          await append(campaign, 'reservation_released', { reservationId, reason: String(reason).slice(0, 100) });
          return clone([...campaign.reservations.values()].find(value => value.reservationId === reservationId));
        });
      },
    };
  }

  async function reconcile(id, input) {
    exactKeys(input, ['clientRequestId', 'reservationId', 'chargeMicros', 'evidenceNote'], 'Reconciliation');
    if (!UUID.test(input.clientRequestId)) fail('clientRequestId must be a UUID.');
    if (typeof input.reservationId !== 'string' || !/^reservation-[a-f0-9-]{36}$/.test(input.reservationId)) fail('reservationId is invalid.');
    const chargeMicros = safeMicros(input.chargeMicros, 'chargeMicros');
    if (typeof input.evidenceNote !== 'string' || !input.evidenceNote.trim() || input.evidenceNote.trim().length > 2000) fail('evidenceNote must contain 1–2000 characters.');
    if (/\b(?:sk-[a-zA-Z0-9_-]{8,}|Bearer\s+\S+)/i.test(input.evidenceNote)) fail('Do not put credentials in reconciliation evidence.');
    return serialized(id, async () => {
      const campaign = find(id);
      const fingerprint = hash({ reservationId: input.reservationId, chargeMicros, evidenceNote: input.evidenceNote.trim() });
      const previous = campaign.reconciliations.get(input.clientRequestId);
      if (previous) {
        if (previous.reconciliationFingerprint !== fingerprint) fail('This reconciliation identifier was already used with different evidence.', 409, 'RECEIPT_CONFLICT');
        return summary(campaign, { details: true });
      }
      const item = [...campaign.reservations.values()].find(value => value.reservationId === input.reservationId);
      if (!item) fail('Reservation not found.', 404, 'RESERVATION_NOT_FOUND');
      if (!['dispatching', 'unresolved'].includes(item.status)) fail('Only unresolved dispatched requests can be reconciled.', 409, 'INVALID_RESERVATION_STATE');
      await append(campaign, 'reservation_reconciled', {
        reservationId: input.reservationId, clientRequestId: input.clientRequestId, reconciliationFingerprint: fingerprint,
        chargeMicros, evidenceNote: input.evidenceNote.trim(), overrun: chargeMicros > item.reservedMicros,
      });
      return summary(campaign, { details: true });
    });
  }

  return {
    create(input) {
      const next = creationTail.then(() => create(input));
      creationTail = next.catch(() => {});
      return next;
    },
    list() { return [...campaigns.values()].map(campaign => summary(campaign)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },
    get(id) { return summary(find(id), { details: true }); },
    has(id) { try { find(id); return true; } catch { return false; } },
    guard,
    reconcile,
  };
}
