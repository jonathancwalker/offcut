import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunTrace } from '../lib/run-trace.mjs';

const source = { id: 'paper', name: 'Paper', width: 100, height: 100, dataUrl: 'data:image/png;base64,AA==' };
const project = { id: 'fixture', cursor: 0, actions: [], sources: [source], canvas: { width: 100, height: 100 }, rules: { maxActions: 20, maxPieces: 10 } };
const event = (sequence, type, turn, extra = {}) => ({ sequence, type, turn, at: new Date(sequence * 1000).toISOString(), ...extra });

test('trace links observed, attempted, rejected and next accepted evidence without advancing a rejection', () => {
  const bad = { type: 'cut', sourceId: 'paper', pieceId: 'bad', polygon: [[0, 0], [90, 90], [0, 90], [90, 0]] };
  const retry = { type: 'cut', sourceId: 'paper', pieceId: 'good', polygon: [[0, 0], [30, 0], [30, 30], [0, 30]] };
  const events = [
    event(1, 'observation', 1, { step: 0, images: [{ id: 'canvas', kind: 'canvas', mime: 'image/png', sha256: 'a'.repeat(64), width: 100, height: 100 }] }),
    event(2, 'request', 1, { request: { messages: [{ images: [{ id: 'canvas', mime: 'image/png', sha256: 'a'.repeat(64) }] }] } }),
    event(3, 'model_output', 1, { text: JSON.stringify({ decision_note: '', actions: [bad], done: false }) }),
    event(4, 'batch_result', 1, { accepted: false, failureStage: 'action', failedActionIndex: 0, code: 'INVALID_POLYGON', error: 'crossing', step: 0, submittedActions: [bad], decision_note: '' }),
    event(5, 'observation', 2, { step: 0, images: [] }), event(6, 'request', 2),
    event(7, 'model_output', 2, { text: JSON.stringify({ decision_note: 'simpler', actions: [retry], done: false }) }),
    event(8, 'batch_result', 2, { accepted: true, actions: [retry], decision_note: 'simpler', done: false, fromStep: 0, step: 1 }),
  ];
  const input = { summary: { id: 'run-fixture', status: 'completed' }, events, project };
  const before = structuredClone(input), trace = buildRunTrace(input);
  assert.deepEqual(input, before);
  assert.equal(trace.turns[0].committedCursor.from, 0);
  assert.equal(trace.turns[0].committedCursor.to, 0);
  assert.equal(trace.turns[0].suppliedImages[0].width, 100);
  assert.equal(trace.turns[0].nextTurn, 6);
  assert.equal(trace.turns[0].decisionNote, '');
  assert.equal(trace.recovery[0].primaryRecovery, true);
  assert.equal(trace.recovery[0].nextAcceptedGeometricBatch, true);
  assert.equal(trace.recovery[0].failedGeometry.polygonArea, null);
  assert.equal(trace.recovery[0].failedGeometry.boundingBoxSourceRatio, 0.81);
  assert.equal(trace.recovery[0].relatedProposalIndex, 0);
  assert.equal(trace.recovery[0].relatedGeometry.polygonArea, 900);
  assert.equal(trace.recovery[0].deltas.vertexCount, 0);
});

test('invalid JSON and legacy rejection preserve unknowns instead of inventing actions or causes', () => {
  const events = [event(1, 'observation', 1, { step: 0, images: [] }), event(2, 'request', 1), event(3, 'model_output', 1, { text: '{broken' }), event(4, 'batch_result', 1, { accepted: false, code: 'INVALID_OUTPUT', step: 0 })];
  const trace = buildRunTrace({ summary: { id: 'run-old', status: 'failed' }, events, project });
  assert.equal(trace.turns[0].parseStatus, 'invalid_json');
  assert.equal(trace.turns[0].proposedActions, null);
  assert.equal(trace.turns[0].decisionNote, null);
  assert.equal(trace.recovery[0].relatedProposalStatus, 'causal_action_unknown');
  assert.equal(trace.recovery[0].primaryRecovery, null);
});

test('recovery considers only the immediate requested turn and first same-operation/source proposal', () => {
  const failed = { type: 'cut', sourceId: 'paper', pieceId: 'one', polygon: [[0, 0], [50, 0], [50, 50]] };
  const other = { type: 'describe', title: 'Only words' };
  const events = [
    event(1, 'observation', 1, { step: 0, images: [] }), event(2, 'request', 1), event(3, 'model_output', 1, { text: JSON.stringify({ actions: [failed], done: false }) }), event(4, 'batch_result', 1, { accepted: false, failureStage: 'action', failedActionIndex: 0, code: 'INVALID_POLYGON', step: 0, submittedActions: [failed] }),
    event(5, 'observation', 2, { step: 0, images: [] }), event(6, 'request', 2), event(7, 'model_output', 2, { text: JSON.stringify({ actions: [other], done: false }) }), event(8, 'batch_result', 2, { accepted: true, actions: [other], fromStep: 0, step: 1 }),
    event(9, 'observation', 3, { step: 1, images: [] }), event(10, 'request', 3), event(11, 'model_output', 3, { text: JSON.stringify({ actions: [failed], done: false }) }), event(12, 'batch_result', 3, { accepted: true, actions: [failed], fromStep: 1, step: 2 }),
  ];
  const trace = buildRunTrace({ summary: { id: 'run-immediate', status: 'completed' }, events, project });
  assert.equal(trace.recovery[0].primaryRecovery, true);
  assert.equal(trace.recovery[0].nextAcceptedGeometricBatch, false);
  assert.equal(trace.recovery[0].relatedProposalStatus, 'no_related_proposal');
});

test('accepted description history stays at its turn and final writing is not inserted into earlier turns', () => {
  const describe = { type: 'describe', title: 'Final title', statement: 'Final statement' };
  const events = [
    event(1, 'observation', 1, { step: 0, images: [] }), event(2, 'request', 1), event(3, 'model_output', 1, { text: JSON.stringify({ actions: [], done: false }) }), event(4, 'batch_result', 1, { accepted: true, actions: [], fromStep: 0, step: 0 }),
    event(5, 'observation', 2, { step: 0, images: [] }), event(6, 'request', 2), event(7, 'model_output', 2, { text: JSON.stringify({ actions: [describe], done: true }) }), event(8, 'batch_result', 2, { accepted: true, actions: [describe], fromStep: 0, step: 1 }),
  ];
  const trace = buildRunTrace({ summary: { id: 'run-writing', status: 'completed' }, events, project });
  assert.deepEqual(trace.turns[0].writingAfter, { title: null, statement: null });
  assert.deepEqual(trace.turns[1].writingAfter, { title: 'Final title', statement: 'Final statement' });
});
