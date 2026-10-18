import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQualificationReport, qualifyRun } from '../lib/provider-qualification.mjs';

const output = { type: 'model_output', turn: 1, model: 'returned-v1', responseId: 'response-1', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }, usageIncomplete: false };
const request = { type: 'request', turn: 1, requestId: 'run-1:turn:1', request: { messages: [{ role: 'user', images: [{ id: 'canvas' }] }] } };
const accepted = { type: 'batch_result', turn: 1, accepted: true, actions: [] };
const project = { actions: [], cursor: 0 };

test('qualification requires native images, parseable actions, complete settled usage, replay, and redaction', () => {
  const good = qualifyRun({ run: {}, events: [request, output, accepted], project, reservations: [{ requestId: request.requestId, status: 'settled' }] });
  assert.deepEqual(good, { accessible: true, nativeImage: true, parseableActionJSON: true, completeUsage: true, settledUsage: true, deterministicReplay: true, credentialFree: true, returnedModels: ['returned-v1'], responseIds: ['response-1'] });
  assert.equal(qualifyRun({ run: {}, events: [request, { ...output, usageIncomplete: true }, accepted], project, reservations: [] }).completeUsage, false);
  assert.equal(qualifyRun({ run: { authorization: 'secret' }, events: [request, output, accepted], project, reservations: [] }).credentialFree, false);
});

test('route report marks only complete priced calibration evidence primary eligible', () => {
  const manifest = { id: 'study-cal', manifestHash: 'a'.repeat(64), campaign: { id: 'campaign-1' }, protocolSnapshot: { adapters: { google: { adapter: 'gemini-v1' } } }, cells: [{ cellId: 'cell-1', spec: { provider: 'google', model: 'gemini-test' } }] };
  const studies = { list: () => [{ id: 'study-cal', kind: 'calibration', status: 'completed' }], get: () => ({ manifest, state: { entries: [{ cellId: 'cell-1', runId: 'run-1', status: 'completed' }] } }) };
  const runs = { get: () => ({ id: 'run-1' }), events: () => [request, output, accepted], project: () => project };
  const campaigns = { get: () => ({ reservations: [{ requestId: request.requestId, status: 'settled' }] }) };
  const report = buildQualificationReport({ studies, runs, campaigns, rateSnapshots: [{ id: 'google-rates', provider: 'google', routes: [{ provider: 'google', requestedRoute: 'gemini-test' }] }], generatedAt: '2026-10-17T00:00:00.000Z' });
  assert.equal(report.routes[0].primaryEligible, true);
  assert.equal(report.routes[0].calibrationEvidence[0].campaignId, 'campaign-1');
  assert.equal(report.routes[0].calibrationEvidence[0].adapter.adapter, 'gemini-v1');
});
