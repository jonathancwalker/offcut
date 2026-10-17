import test from 'node:test';
import assert from 'node:assert/strict';
import { actionSummary, traceSelection } from '../public/run-trace-view.mjs';

test('trace selection never swaps observed, result, and next-observation evidence', () => {
  const trace = { turns: [
    { turn: 1, observedCursor: 2, suppliedImages: [{ id: 'canvas', sha256: 'observed' }], validation: { status: 'rejected' }, committedCursor: { from: 2, to: 2 } },
    { turn: 2, observedCursor: 2, suppliedImages: [{ id: 'canvas', sha256: 'next' }], validation: { status: 'accepted' }, committedCursor: { from: 2, to: 4 } },
  ] };
  const rejected = traceSelection(trace, 0);
  assert.equal(rejected.observed.sha256, 'observed');
  assert.equal(rejected.resultStep, 2);
  assert.equal(rejected.nextObserved.sha256, 'next');
  assert.equal(rejected.rejected, true);
  const accepted = traceSelection(trace, 1);
  assert.equal(accepted.observed.sha256, 'next');
  assert.equal(accepted.resultStep, 4);
  assert.equal(accepted.nextObserved, null);
});

test('attempt labels distinguish unparsed, empty, and typed proposals', () => {
  assert.equal(actionSummary(null), 'Could not parse proposed actions');
  assert.equal(actionSummary([]), 'No actions proposed');
  assert.equal(actionSummary([{ type: 'cut' }, { type: 'place' }, { type: 'cut' }]), '2 cut · 1 place');
});
