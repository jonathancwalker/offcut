import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCampaignManager } from '../lib/study-budget.mjs';
import { accountUsage, estimateProviderRequest, estimateRequest, getRateBook, getRateSnapshot, listRateBooks, listRateSnapshots } from '../lib/model-rates.mjs';

const snapshotId = 'openai-standard-2026-10-17';
const rateBookId = 'offcut-reviewed-rates-2026-10-17';
const route = 'gpt-5.6-luna';
const runId = index => `run-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const image = (id = 'canvas', width = 1000, height = 1200) => ({ id, width, height, sha256: String(id.length).padStart(64, '0'), mime: 'image/png' });
const request = (overrides = {}) => ({
  model: route,
  instructions: 'Return JSON.',
  messages: [{ role: 'user', text: 'Inspect the work.', images: [{ id: 'canvas', dataUrl: 'data:image/png;base64,private-image-bytes' }] }],
  maxOutputTokens: 512,
  ...overrides,
});

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'offcut-campaigns-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const manager = await createCampaignManager({ dataDir });
  return { dataDir, manager };
}

async function campaign(manager, limitMicros = 50_000_000) {
  return manager.create({ clientRequestId: randomUUID(), limitMicros, rateSnapshotId: snapshotId });
}

test('reviewed snapshots use exact route matching, documented image bounds, and integer upward rounding', () => {
  const snapshots = listRateSnapshots();
  assert.equal(snapshots.length, 3);
  const snapshot = snapshots.find(value => value.id === snapshotId);
  assert.match(snapshot.hash, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.reviewedAt, '2026-10-17T00:00:00.000Z');
  assert.ok(snapshot.sourceUrls.every(url => url.startsWith('https://developers.openai.com/')));
  const small = estimateRequest(snapshot, { request: request(), images: [image()] });
  const moreHistory = estimateRequest(snapshot, { request: request({ messages: [
    { role: 'user', text: 'Earlier observation.' }, { role: 'assistant', text: 'Earlier answer.' }, request().messages[0],
  ] }), images: [image()] });
  const moreImages = estimateRequest(snapshot, { request: request({ messages: [{ ...request().messages[0], images: [
    request().messages[0].images[0], { id: 'source', dataUrl: 'data:image/png;base64,also-private' },
  ] }] }), images: [image(), image('source', 1536, 1536)] });
  const moreOutput = estimateRequest(snapshot, { request: request({ maxOutputTokens: 4096 }), images: [image()] });
  assert.ok(moreHistory.estimator.inputTokenBound > small.estimator.inputTokenBound);
  assert.ok(moreImages.estimator.imageTokenBound > small.estimator.imageTokenBound);
  assert.ok(moreOutput.reservedMicros > small.reservedMicros);
  assert.equal(moreOutput.estimator.outputTokenBound, 4096);
  assert.equal(accountUsage(snapshot, { requestedRoute: route, returnedModel: route, usage: { inputTokens: 1, outputTokens: 0 } }).chargeMicros, 1);
  assert.throws(() => estimateRequest(snapshot, { request: request({ model: 'gpt-5.6-luna-latest-ish' }), images: [image()] }), error => error.code === 'UNPRICED_REQUEST');
  assert.throws(() => accountUsage(snapshot, { requestedRoute: route, returnedModel: `${route}-unknown`, usage: { inputTokens: 1, outputTokens: 1 } }), error => error.code === 'UNRESOLVED_USAGE');
});

test('rate books select exact provider snapshots and reject unpriced providers before dispatch', async t => {
  const books = listRateBooks();
  assert.equal(books.length, 1);
  assert.match(books[0].hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(books[0].snapshots.map(value => value.provider), ['openai', 'google', 'anthropic']);
  const estimate = estimateProviderRequest(getRateBook(rateBookId), { provider: 'openai', request: request(), images: [image()] });
  assert.equal(estimate.provider, 'openai');
  assert.throws(
    () => estimateProviderRequest(getRateBook(rateBookId), { provider: 'xai', request: request(), images: [image()] }),
    error => error.code === 'UNPRICED_REQUEST',
  );
  const { dataDir, manager } = await fixture(t);
  const created = (await manager.create({ clientRequestId: randomUUID(), limitMicros: estimate.reservedMicros, rateBookId })).campaign;
  assert.equal(created.rateBookId, rateBookId);
  const reservation = await manager.guard(created.id).reserve({ provider: 'openai', requestId: `${runId(40)}:turn:1`, runId: runId(40), turn: 1, request: request(), images: [image()] });
  assert.equal(reservation.provider, 'openai');
  await assert.rejects(
    manager.guard(created.id).reserve({ provider: 'xai', requestId: `${runId(41)}:turn:1`, runId: runId(41), turn: 1, request: request(), images: [image()] }),
    error => error.code === 'UNPRICED_REQUEST',
  );
  const reopened = await createCampaignManager({ dataDir });
  assert.equal(reopened.get(created.id).rateBookHash, created.rateBookHash);
});

test('allowance equality succeeds, a one-micro shortage fails, and duplicate creation is durable', async t => {
  const { dataDir, manager } = await fixture(t);
  const estimate = estimateRequest(getRateSnapshot(snapshotId), { request: request(), images: [image()] });
  const receipt = randomUUID();
  const created = await manager.create({ clientRequestId: receipt, limitMicros: estimate.reservedMicros, rateSnapshotId: snapshotId });
  assert.equal(created.created, true);
  const duplicate = await manager.create({ clientRequestId: receipt, limitMicros: estimate.reservedMicros, rateSnapshotId: snapshotId });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.campaign.id, created.campaign.id);
  await assert.rejects(manager.create({ clientRequestId: receipt, limitMicros: estimate.reservedMicros + 1, rateSnapshotId: snapshotId }), error => error.code === 'RECEIPT_CONFLICT');
  const allowed = manager.guard(created.campaign.id);
  const reservation = await allowed.reserve({ requestId: `${runId(1)}:turn:1`, runId: runId(1), turn: 1, request: request(), images: [image()] });
  assert.equal(reservation.reservedMicros, estimate.reservedMicros);
  assert.equal(manager.get(created.campaign.id).availableMicros, 0);

  const short = (await manager.create({ clientRequestId: randomUUID(), limitMicros: estimate.reservedMicros - 1, rateSnapshotId: snapshotId })).campaign;
  await assert.rejects(manager.guard(short.id).reserve({ requestId: `${runId(2)}:turn:1`, runId: runId(2), turn: 1, request: request(), images: [image()] }), error => error.code === 'STUDY_BUDGET_DENIED');
  const reopened = await createCampaignManager({ dataDir });
  assert.equal(reopened.get(created.campaign.id).reservedMicros, 0, 'restart releases a reservation proven not dispatched');
  assert.equal(reopened.get(created.campaign.id).availableMicros, estimate.reservedMicros);
});

test('concurrent reservations serialize and cannot overspend one request worth of allowance', async t => {
  const { manager } = await fixture(t);
  const estimate = estimateRequest(getRateSnapshot(snapshotId), { request: request(), images: [image()] });
  const created = (await campaign(manager, estimate.reservedMicros)).campaign;
  const guard = manager.guard(created.id);
  const results = await Promise.allSettled([1, 2].map(index => guard.reserve({
    requestId: `${runId(index)}:turn:1`, runId: runId(index), turn: 1, request: request(), images: [image()],
  })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'STUDY_BUDGET_DENIED').length, 1);
  assert.equal(manager.get(created.id).availableMicros, 0);
});

test('settled spend survives restart and a second study cannot reset the shared allowance', async t => {
  const { manager, dataDir } = await fixture(t);
  const estimate = estimateRequest(getRateSnapshot(snapshotId), { request: request(), images: [image()] });
  const created = (await campaign(manager, estimate.reservedMicros)).campaign;
  const first = manager.guard(created.id);
  const reservation = await first.reserve({ requestId: `${runId(21)}:turn:1`, runId: runId(21), turn: 1, request: request(), images: [image()] });
  await first.markDispatching(reservation.reservationId);
  await first.settle({ reservationId: reservation.reservationId, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, responseId: 'resp_first_study', returnedModel: route });
  const restarted = await createCampaignManager({ dataDir });
  assert.ok(restarted.get(created.id).accountedMicros > 0);
  await assert.rejects(restarted.guard(created.id).reserve({ requestId: `${runId(22)}:turn:1`, runId: runId(22), turn: 1, request: request(), images: [image()] }), error => error.code === 'STUDY_BUDGET_DENIED');
});

test('settlement is idempotent, preserves usage detail, and malformed accounting stays uncertain', async t => {
  const { manager, dataDir } = await fixture(t);
  const created = (await campaign(manager)).campaign;
  const guard = manager.guard(created.id);
  const reservation = await guard.reserve({ requestId: `${runId(3)}:turn:1`, runId: runId(3), turn: 1, request: request(), images: [image()] });
  await guard.markDispatching(reservation.reservationId);
  const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150, inputTokensDetails: { cachedTokens: 80 }, outputTokensDetails: { reasoningTokens: 20 } };
  const first = await guard.settle({ reservationId: reservation.reservationId, usage, responseId: 'resp_1', returnedModel: route });
  const second = await guard.settle({ reservationId: reservation.reservationId, usage, responseId: 'resp_1', returnedModel: route });
  assert.equal(first.chargeMicros, second.chargeMicros);
  assert.deepEqual(first.usage, usage);
  assert.equal(manager.get(created.id).accountedMicros, first.chargeMicros);
  await assert.rejects(guard.settle({ reservationId: reservation.reservationId, usage: { ...usage, outputTokens: 51 }, responseId: 'resp_1', returnedModel: route }), error => error.code === 'SETTLEMENT_CONFLICT');

  const unresolved = await guard.reserve({ requestId: `${runId(4)}:turn:1`, runId: runId(4), turn: 1, request: request(), images: [image()] });
  await guard.markDispatching(unresolved.reservationId);
  await assert.rejects(guard.settle({ reservationId: unresolved.reservationId, usage: { inputTokens: null, outputTokens: null }, responseId: 'resp_2', returnedModel: route }), error => error.code === 'UNRESOLVED_USAGE');
  const state = manager.get(created.id);
  assert.equal(state.status, 'reconciliation_required');
  assert.equal(state.uncertainMicros, unresolved.reservedMicros);
  await assert.rejects(guard.reserve({ requestId: `${runId(5)}:turn:1`, runId: runId(5), turn: 1, request: request(), images: [image()] }), error => error.code === 'CAMPAIGN_RECONCILIATION_REQUIRED');
  const ledger = await readFile(join(dataDir, created.id, 'ledger.jsonl'), 'utf8');
  assert.ok(!ledger.includes('private-image-bytes'));
});

test('dispatched reservations survive restart and reconciliation appends evidence without changing allowance', async t => {
  const { manager, dataDir } = await fixture(t);
  const created = (await campaign(manager, 1_000_000)).campaign;
  const guard = manager.guard(created.id);
  const reservation = await guard.reserve({ requestId: `${runId(6)}:turn:1`, runId: runId(6), turn: 1, request: request(), images: [image()] });
  await guard.markDispatching(reservation.reservationId);
  const restarted = await createCampaignManager({ dataDir });
  assert.equal(restarted.get(created.id).status, 'reconciliation_required');
  assert.equal(restarted.get(created.id).uncertainMicros, reservation.reservedMicros);
  const reconciliationId = randomUUID();
  const body = { clientRequestId: reconciliationId, reservationId: reservation.reservationId, chargeMicros: 1234, evidenceNote: 'Checked provider usage report for this response.' };
  const reconciled = await restarted.reconcile(created.id, body);
  assert.equal(reconciled.limitMicros, 1_000_000);
  assert.equal(reconciled.accountedMicros, 1234);
  assert.equal(reconciled.uncertainMicros, 0);
  assert.deepEqual(await restarted.reconcile(created.id, body), reconciled);
  await assert.rejects(restarted.reconcile(created.id, { ...body, chargeMicros: 1235 }), error => error.code === 'RECEIPT_CONFLICT');
  await assert.rejects(restarted.reconcile(created.id, { ...body, clientRequestId: randomUUID(), evidenceNote: 'Bearer secret-should-not-save' }), /credentials/);
});

test('an estimator under-bound records the actual overrun and blocks the campaign', async t => {
  const { manager } = await fixture(t);
  const created = (await campaign(manager, 50_000_000)).campaign;
  const guard = manager.guard(created.id);
  const reservation = await guard.reserve({ requestId: `${runId(7)}:turn:1`, runId: runId(7), turn: 1, request: request({ maxOutputTokens: 1 }), images: [image()] });
  await guard.markDispatching(reservation.reservationId);
  const settled = await guard.settle({ reservationId: reservation.reservationId, usage: { inputTokens: reservation.estimator.inputTokenBound + 1_000_000, outputTokens: 1, totalTokens: reservation.estimator.inputTokenBound + 1_000_001 }, responseId: 'resp_overrun', returnedModel: route });
  assert.equal(settled.overrun, true);
  assert.equal(manager.get(created.id).status, 'blocked');
  await assert.rejects(guard.reserve({ requestId: `${runId(8)}:turn:1`, runId: runId(8), turn: 1, request: request(), images: [image()] }), error => error.code === 'CAMPAIGN_BLOCKED');
});

test('restart refuses a changed money ledger instead of reconstructing a false balance', async t => {
  const { manager, dataDir } = await fixture(t);
  const created = (await campaign(manager)).campaign;
  await manager.guard(created.id).reserve({ requestId: `${runId(30)}:turn:1`, runId: runId(30), turn: 1, request: request(), images: [image()] });
  const ledgerPath = join(dataDir, created.id, 'ledger.jsonl');
  const event = JSON.parse((await readFile(ledgerPath, 'utf8')).trim());
  event.reservedMicros++;
  await writeFile(ledgerPath, `${JSON.stringify(event)}\n`);
  await assert.rejects(createCampaignManager({ dataDir }), /damaged ledger/);
});
