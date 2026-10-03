import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import { createRunManager } from '../lib/runs.mjs';
import { getSharp, renderPNG } from '../lib/render.mjs';
import { drawMaterialIds, normalizeMaterialSelection } from '../public/material-selection.mjs';

const spec = { provider: 'openai', model: 'test-vision', prompt: 'Make something surprising from this page.' };
const cut = { type: 'cut', sourceId: 'page', pieceId: 'leaf', polygon: [[0, 0], [40, 0], [40, 40], [0, 40]] };
const place = { type: 'place', pieceId: 'leaf', x: 300, y: 400, scale: 2 };
const describe = { type: 'describe', title: 'A small beginning', statement: 'A piece of a page finds a new place.' };
const output = (actions = [], done = false, decision_note = 'Try this arrangement.') => ({ text: JSON.stringify({ decision_note, actions, done }), raw: { id: 'response-test', status: 'completed' }, usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }, responseId: 'response-test', model: 'test-vision-pinned' });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

async function setup(t, generate) {
  const dataDir = await mkdtemp(join(tmpdir(), 'offcut-runs-'));
  const bytes = await getSharp()({ create: { width: 100, height: 100, channels: 3, background: '#339966' } }).png().toBuffer();
  const source = { id: 'page', name: 'A page', width: 100, height: 100, dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, credit: 'Test fixture', url: 'https://example.org/page', license: 'CC0' };
  let factoryCalls = 0;
  const providerFactory = () => { factoryCalls++; return { generate, privateKey: 'sk-private-test-only', metadata: { adapter: 'test', endpoint: 'https://api.openai.com/v1/responses', imageDetail: 'high', store: false, apiKey: 'sk-metadata-secret' } }; };
  const manager = await createRunManager({ dataDir, providerFactory });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { manager, dataDir, source, bytes, providerFactory, factoryCalls: () => factoryCalls };
}

async function finished(manager, id) {
  for (let count = 0; count < 1000; count++) {
    const run = manager.get(id);
    if (run.status !== 'running') return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('The test run did not finish.');
}

test('two turns send native source/canvas images, freeze inputs, and export exact replayable observations', async t => {
  const requests = [], gate = deferred();
  const { manager, source, factoryCalls } = await setup(t, async request => {
    requests.push(request);
    if (requests.length === 1) { await gate.promise; return output([cut, place]); }
    return output([describe], true);
  });
  const before = structuredClone(source);
  const settings = { ...spec };
  const run = await manager.start({ spec: settings, sources: [source] });
  assert.equal(run.status, 'running');
  settings.prompt = 'Changed after submission';
  source.name = 'Changed studio';
  source.dataUrl = 'destroyed-after-submission';
  gate.resolve();
  const end = await finished(manager, run.id);
  assert.equal(end.status, 'completed');
  assert.equal(end.turns, 2);
  assert.equal(end.acceptedActions, 3);
  assert.equal(end.rejectedBatches, 0);
  assert.deepEqual(end.usage, { inputTokens: 40, outputTokens: 20, totalTokens: 60 });
  assert.equal(end.usageIncomplete, false);
  assert.equal(end.costUSD, null);
  assert.equal(factoryCalls(), 1);
  assert.equal(end.spec.prompt, spec.prompt);
  assert.equal(end.policy.version, 3);
  assert.equal(end.policy.protocol, 'offcut-actions-v3');
  assert.equal(end.policy.completion.requiresObservedCanvas, true);
  assert.equal(end.state.rules.maxVertices, 64);
  assert.equal(end.sourceManifest[0].name, before.name);
  assert.equal(end.state.sources[0].dataUrl, undefined);
  assert.equal(requests[0].messages.length, 1);
  assert.equal(requests[1].messages.length, 3);
  for (const request of requests) {
    const message = request.messages.at(-1);
    assert.equal(message.images.length, 2);
    assert.deepEqual(message.images.map(image => image.id), ['page', 'canvas']);
    assert.ok(message.images.every(image => image.dataUrl.startsWith('data:image/png;base64,')));
    assert.ok(!message.text.includes('base64'));
    assert.equal(request.maxOutputTokens, 4096);
    assert.match(request.instructions, /3–64 vertices/);
    assert.match(request.instructions, /Leave a turn in your budget/);
  }
  assert.equal(requests[1].messages[0].images, undefined);
  assert.notEqual(requests[0].messages[0].images[1].dataUrl, requests[1].messages.at(-1).images[1].dataUrl);
  const project = manager.project(run.id);
  assert.equal(project.sources[0].dataUrl, before.dataUrl);
  assert.deepEqual(project.actions.map(record => record.action), [cut, place, describe]);
  assert.equal(manager.state(run.id, { step: 0 }).pieces.length, 0);
  assert.equal(manager.state(run.id, { step: 1 }).pieces[0].visible, false);
  assert.equal(manager.state(run.id, { step: 2 }).pieces[0].visible, true);
  assert.equal(manager.project(run.id, { step: 1 }).cursor, 1);
  const events = manager.events(run.id);
  assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1));
  assert.equal(events.filter(event => event.type === 'model_output').length, 2);
  const review = events.find(event => event.type === 'final_review');
  assert.equal(review.turn, 2);
  assert.equal(review.observedStep, 2);
  assert.equal(review.step, 3, 'describing the observed canvas needs no extra image turn');
  assert.equal(review.canvasSha256, events.find(event => event.type === 'observation' && event.turn === 2).canvasSha256);
  const bundle = await manager.bundle(run.id);
  assert.equal(bundle.format, 'offcut-run');
  assert.ok(!JSON.stringify(bundle).includes('sk-private-test-only'));
  assert.ok(!JSON.stringify(bundle).includes('sk-metadata-secret'));
  for (const event of events.filter(event => event.type === 'request')) {
    const original = requests[event.turn - 1];
    const restored = structuredClone(event.request);
    restored.messages = restored.messages.map(message => ({ ...message, ...(message.images ? { images: message.images.map(image => ({ id: image.id, dataUrl: bundle.assets[image.sha256].dataUrl })) } : {}) }));
    const { signal, ...sent } = original;
    assert.deepEqual(restored, sent);
  }
  for (const [sha256, asset] of Object.entries(bundle.assets)) {
    assert.equal(createHash('sha256').update(Buffer.from(asset.dataUrl.split(',')[1], 'base64')).digest('hex'), sha256);
  }
  const detached = manager.get(run.id);
  detached.spec.prompt = 'tampered';
  assert.equal(manager.get(run.id).spec.prompt, spec.prompt);
});

test('an invalid multi-action batch is rejected atomically and returned as feedback before recovery', async t => {
  let calls = 0;
  const { manager, source } = await setup(t, async request => {
    calls++;
    if (calls === 1) return output([cut, { ...place, pieceId: 'missing' }]);
    if (calls === 3) return output([], true);
    const observation = JSON.parse(request.messages.at(-1).text);
    assert.equal(observation.state.pieces.length, 0);
    assert.equal(observation.actionsRemaining, 120);
    assert.match(observation.feedback, /entire previous batch was rejected/);
    assert.match(observation.feedback, /Unknown piece/);
    return output([cut, place, describe], true);
  });
  const run = await manager.start({ spec, sources: [source] });
  const end = await finished(manager, run.id);
  assert.equal(end.status, 'completed');
  assert.equal(end.rejectedBatches, 1);
  assert.equal(end.acceptedActions, 3);
  assert.equal(manager.state(run.id).pieces.length, 1);
  const events = manager.events(run.id);
  const firstOutput = events.findIndex(event => event.type === 'model_output');
  const firstResult = events.findIndex(event => event.type === 'batch_result');
  assert.ok(firstOutput < firstResult);
  assert.equal(events[firstResult].accepted, false);
  assert.equal(events[firstResult].step, 0);
});

test('malformed outputs and oversized batches consume bounded turns without changing the canvas', async t => {
  let calls = 0;
  const { manager, source } = await setup(t, async () => ++calls === 1 ? { ...output(), text: 'not json' } : output(Array.from({ length: 13 }, () => describe)));
  const run = await manager.start({ spec: { ...spec, maxTurns: 2 }, sources: [source] });
  const end = await finished(manager, run.id);
  assert.equal(end.status, 'limit_reached');
  assert.equal(end.terminationReason, 'turn_limit');
  assert.equal(end.rejectedBatches, 2);
  assert.equal(calls, 2);
  assert.equal(end.acceptedActions, 0);
  assert.equal(manager.state(run.id).pieces.length, 0);
});

test('action and piece limits are enforced by atomic validation, including consumed hidden pieces', async t => {
  let calls = 0;
  const { manager, source } = await setup(t, async () => {
    calls++;
    if (calls === 1) return output([cut, { ...cut, pieceId: 'second', polygon: [[50, 50], [90, 50], [90, 90], [50, 90]] }]);
    if (calls === 3) return output([], false, 'The work needs more edits, but there are no actions left.');
    return output([cut, place]);
  });
  const run = await manager.start({ spec: { ...spec, maxPieces: 1, maxActions: 2 }, sources: [source] });
  const end = await finished(manager, run.id);
  assert.equal(end.status, 'limit_reached');
  assert.equal(end.terminationReason, 'action_limit');
  assert.equal(end.acceptedActions, 2);
  assert.equal(end.rejectedBatches, 1);
  assert.equal(calls, 3, 'the exhausted action budget still allows one final look within the turn budget');
  assert.equal(manager.events(run.id).find(event => event.type === 'batch_result').code, 'PIECE_LIMIT');
});

test('one active run is enforced; stopping aborts an uncooperative provider and ignores its late response', async t => {
  const entered = deferred(), answer = deferred();
  let signal;
  const { manager, source } = await setup(t, async request => { signal = request.signal; entered.resolve(); return answer.promise; });
  const first = manager.start({ spec, sources: [source] });
  await assert.rejects(manager.start({ spec, sources: [source] }), error => error.status === 409);
  const run = await first;
  await entered.promise;
  await assert.rejects(manager.start({ spec, sources: [source] }), error => error.status === 409);
  const stopped = await manager.stop(run.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.terminationReason, 'user_stopped');
  assert.equal(stopped.usageIncomplete, true);
  assert.equal(signal.aborted, true);
  answer.resolve(output([cut, place], true));
  await immediate();
  assert.equal(manager.get(run.id).acceptedActions, 0);
  assert.equal(manager.events(run.id).filter(event => event.type === 'termination').length, 1);
  assert.equal(manager.events(run.id).filter(event => event.type === 'model_output').length, 0);
  assert.equal((await manager.stop(run.id)).status, 'stopped');
});

test('a deadline aborts an in-flight request even when the provider ignores its signal', async t => {
  const entered = deferred();
  const { manager, source } = await setup(t, async () => { entered.resolve(); return new Promise(() => {}); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = await manager.start({ spec: { ...spec, maxMinutes: 1 }, sources: [source] });
  await entered.promise;
  t.mock.timers.tick(60001);
  for (let count = 0; count < 10000 && manager.get(run.id).status === 'running'; count++) await immediate();
  const end = manager.get(run.id);
  assert.equal(end.status, 'limit_reached');
  assert.equal(end.terminationReason, 'time_limit');
  assert.equal(end.usageIncomplete, true);
  t.mock.timers.reset();
});

test('restart reconstructs committed batches from events and repairs a stale project checkpoint without duplicates', async t => {
  let calls = 0;
  const { manager, source, dataDir, providerFactory } = await setup(t, async () => ++calls === 1 ? output([cut, place, describe], true) : output([], true));
  const run = await manager.start({ spec, sources: [source] });
  await finished(manager, run.id);
  const expectedPNG = await renderPNG(manager.state(run.id));
  await manager.close();
  const runDir = join(dataDir, run.id);
  await writeFile(join(runDir, 'project.json'), await readFile(join(runDir, 'initial.project.json')));
  const restarted = await createRunManager({ dataDir, providerFactory });
  t.after(() => restarted.close());
  assert.equal(restarted.get(run.id).status, 'completed');
  assert.equal(restarted.project(run.id).actions.length, 3);
  assert.equal(restarted.state(run.id).pieces.length, 1);
  assert.deepEqual(await renderPNG(restarted.state(run.id)), expectedPNG);
  assert.equal(restarted.events(run.id).filter(event => event.type === 'termination').length, 1);
  assert.equal(restarted.events(run.id).filter(event => event.type === 'final_review').length, 1);
  assert.equal(JSON.parse(await readFile(join(runDir, 'project.json'), 'utf8')).cursor, 3);
});

test('recovery preserves a saved earlier policy instead of relabeling it as trim-capable', async t => {
  const { manager, source, dataDir, providerFactory } = await setup(t, async request =>
    output(JSON.parse(request.messages.at(-1).text).turn === 1 ? [cut, place] : [], true));
  const run = await manager.start({ spec, sources: [source] });
  await finished(manager, run.id);
  await manager.close();
  const runDir = join(dataDir, run.id);
  const saved = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
  const priorPolicy = { ...saved.policy, version: 2, protocol: 'offcut-actions-v2' };
  saved.policy = priorPolicy;
  await writeFile(join(runDir, 'run.json'), JSON.stringify(saved));
  const events = manager.events(run.id);
  events.find(event => event.type === 'run_started').policy = priorPolicy;
  await writeFile(join(runDir, 'events.jsonl'), events.map(event => JSON.stringify(event) + '\n').join(''));
  const restarted = await createRunManager({ dataDir, providerFactory });
  t.after(() => restarted.close());
  assert.deepEqual(restarted.get(run.id).policy, priorPolicy);
  assert.deepEqual(restarted.events(run.id).find(event => event.type === 'run_started').policy, priorPolicy);
  assert.deepEqual(restarted.state(run.id), manager.state(run.id));
});

test('a finish request with visual edits stays running until the rendered result is reviewed', async t => {
  const enteredReview = deferred(), confirm = deferred();
  const requests = [];
  const { manager, source } = await setup(t, async request => {
    requests.push(request);
    if (requests.length === 1) return output([cut, place, describe], true);
    enteredReview.resolve();
    await confirm.promise;
    return output([], true, 'The displayed result is finished.');
  });
  const run = await manager.start({ spec, sources: [source] });
  await enteredReview.promise;
  assert.equal(manager.get(run.id).status, 'running');
  assert.equal(manager.get(run.id).acceptedActions, 3);
  assert.equal(manager.get(run.id).rejectedBatches, 0);
  assert.equal(manager.events(run.id).find(event => event.type === 'batch_result').completionDeferred, true);
  assert.equal(manager.events(run.id).some(event => event.type === 'termination'), false);
  const reviewMessage = requests[1].messages.at(-1);
  assert.match(JSON.parse(reviewMessage.text).feedback, /Finishing is deferred/);
  const displayed = Buffer.from(reviewMessage.images.at(-1).dataUrl.split(',')[1], 'base64');
  assert.deepEqual(displayed, await renderPNG(manager.state(run.id)));
  assert.notEqual(requests[0].messages.at(-1).images.at(-1).dataUrl, reviewMessage.images.at(-1).dataUrl);
  confirm.resolve();
  const end = await finished(manager, run.id);
  assert.equal(end.status, 'completed');
  assert.equal(end.turns, 2);
  const review = manager.events(run.id).find(event => event.type === 'final_review');
  assert.equal(review.observedStep, 3);
  assert.equal(review.canvasSha256, createHash('sha256').update(displayed).digest('hex'));
});

test('revisions during a final look require the revised canvas to be observed again', async t => {
  const requests = [];
  const move = { type: 'transform', pieceId: 'leaf', x: 650, rotation: 35 };
  const { manager, source } = await setup(t, async request => {
    requests.push(request);
    if (requests.length === 1) return output([cut, place], true);
    if (requests.length === 2) return output([move], true);
    return output([describe], true);
  });
  const run = await manager.start({ spec, sources: [source] });
  const end = await finished(manager, run.id);
  assert.equal(end.status, 'completed');
  assert.equal(end.turns, 3);
  assert.deepEqual(manager.project(run.id).actions.map(record => record.action), [cut, place, move, describe]);
  assert.notEqual(requests[1].messages.at(-1).images.at(-1).dataUrl, requests[2].messages.at(-1).images.at(-1).dataUrl);
  const events = manager.events(run.id);
  assert.deepEqual(events.filter(event => event.type === 'batch_result').map(event => event.completionDeferred), [true, true, false]);
  assert.equal(events.find(event => event.type === 'final_review').observedStep, 3);
});

test('trim observations expose reusable offcuts and holes, with final review, export and recovery', async t => {
  const requests = [];
  const trim = { type: 'trim', pieceId: 'leaf', newPieceId: 'leaf-refined', polygon: [[10, 10], [30, 10], [30, 30], [10, 30]] };
  let placeOffcut;
  const { manager, source, dataDir, providerFactory } = await setup(t, async request => {
    requests.push(request);
    if (requests.length === 1) return output([cut, place]);
    if (requests.length === 2) return output([trim], true);
    if (requests.length === 3) {
      const observed = JSON.parse(request.messages.at(-1).text);
      const parent = observed.state.pieces.find(piece => piece.id === 'leaf');
      const retained = observed.state.pieces.find(piece => piece.id === trim.newPieceId);
      const offcut = observed.state.pieces.find(piece => piece.parentPieceId === 'leaf' && piece.trimRole === 'offcut');
      assert.equal(parent.visible, false);
      assert.equal(parent.supersededBy, retained.id);
      assert.deepEqual(new Set(parent.childPieceIds), new Set([retained.id, offcut.id]));
      assert.equal(retained.parentPieceId, parent.id);
      assert.equal(retained.trimRole, 'retained');
      assert.equal(retained.visible, true);
      assert.match(offcut.id, /^piece-\d+$/);
      assert.equal(offcut.visible, false);
      assert.equal(offcut.holes.length, 1, 'cutting out the center leaves a reusable ring');
      assert.equal(observed.state.pieces.filter(piece => !piece.supersededBy).length, 2);
      assert.equal(observed.state.rules.maxPieces, 2, 'retired history does not consume usable capacity');
      assert.equal(observed.actionsRemaining, 117);
      placeOffcut = { type: 'place', pieceId: offcut.id, x: 600, y: 600 };
      return output([placeOffcut], true, 'Place the saved offcut beside the retained square.');
    }
    return output([describe], true);
  });
  const run = await manager.start({ spec: { ...spec, maxPieces: 2 }, sources: [source] });
  const end = await finished(manager, run.id);
  assert.equal(end.status, 'completed');
  assert.equal(end.turns, 4);
  assert.equal(end.acceptedActions, 5);
  assert.equal(end.rejectedBatches, 0);
  assert.match(requests[0].instructions, /"type":"trim","pieceId":"existing-id","newPieceId":"new-unique-id"/);
  assert.match(requests[0].instructions, /Every connected offcut also becomes a usable child/);
  assert.match(requests[0].instructions, /retired parents do not count/);
  assert.match(requests[0].instructions, /Holes cannot be filled by a later trim/);
  assert.match(requests[0].instructions, /8192 boundary vertices/);
  const trimmedMessage = requests[2].messages.at(-1);
  assert.deepEqual(Buffer.from(trimmedMessage.images.at(-1).dataUrl.split(',')[1], 'base64'), await renderPNG(manager.state(run.id, { step: 3 })));
  const finalMessage = requests[3].messages.at(-1);
  const observedOffcut = JSON.parse(finalMessage.text).state.pieces.find(piece => piece.id === placeOffcut.pieceId);
  assert.equal(observedOffcut.visible, true);
  assert.equal(observedOffcut.holes.length, 1);
  const expected = manager.state(run.id);
  const expectedPNG = await renderPNG(expected);
  assert.deepEqual(Buffer.from(finalMessage.images.at(-1).dataUrl.split(',')[1], 'base64'), expectedPNG);
  assert.notEqual(requests[1].messages.at(-1).images.at(-1).dataUrl, trimmedMessage.images.at(-1).dataUrl);
  assert.notEqual(trimmedMessage.images.at(-1).dataUrl, finalMessage.images.at(-1).dataUrl);
  const { data, info } = await getSharp()(expectedPNG).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
  assert.deepEqual(pixel(600, 600), [246, 241, 231], 'the placed offcut retains its empty center');
  assert.deepEqual(pixel(630, 600), [51, 153, 102], 'offcut material remains available for placement');
  assert.deepEqual(pixel(300, 400), [51, 153, 102], 'the retained center stays in its original pose');
  const events = manager.events(run.id);
  assert.equal(events.find(event => event.type === 'batch_result' && event.turn === 2).completionDeferred, true);
  assert.equal(events.find(event => event.type === 'batch_result' && event.turn === 3).completionDeferred, true);
  assert.equal(events.find(event => event.type === 'final_review').observedStep, 4);
  const bundle = await manager.bundle(run.id);
  assert.deepEqual(bundle.project.actions.map(record => record.action), [cut, place, trim, placeOffcut, describe]);
  const savedObservation = JSON.parse(bundle.events.find(event => event.type === 'request' && event.turn === 3).request.messages.at(-1).text);
  assert.deepEqual(savedObservation.state.pieces, JSON.parse(trimmedMessage.text).state.pieces);
  assert.deepEqual(manager.project(run.id).actions.map(record => record.action), [cut, place, trim, placeOffcut, describe]);
  assert.equal(manager.state(run.id, { step: 2 }).pieces[0].supersededBy, undefined);
  await manager.close();
  await writeFile(join(dataDir, run.id, 'project.json'), await readFile(join(dataDir, run.id, 'initial.project.json')));
  const restarted = await createRunManager({ dataDir, providerFactory });
  t.after(() => restarted.close());
  assert.deepEqual(restarted.state(run.id), expected);
  assert.deepEqual(await renderPNG(restarted.state(run.id)), expectedPNG);
  assert.equal(restarted.get(run.id).policy.version, 3);
  assert.equal(restarted.events(run.id).filter(event => event.type === 'final_review').length, 1);
});

test('a batch that trims then tries to restore the parent leaves no partial child', async t => {
  let calls = 0;
  const trim = { type: 'trim', pieceId: 'leaf', newPieceId: 'child', polygon: [[10, 0], [40, 0], [40, 40], [10, 40]] };
  const { manager, source } = await setup(t, async request => {
    if (++calls === 1) return output([cut, place]);
    if (calls === 2) return output([trim, place]);
    const observed = JSON.parse(request.messages.at(-1).text);
    assert.equal(observed.state.pieces.length, 1);
    assert.equal(observed.state.pieces[0].visible, true);
    assert.equal(observed.state.pieces[0].supersededBy, undefined);
    assert.equal(observed.actionsRemaining, 118);
    return output([], true);
  });
  const run = await manager.start({ spec, sources: [source] });
  const end = await finished(manager, run.id);
  assert.equal(end.status, 'completed');
  assert.equal(end.rejectedBatches, 1);
  assert.equal(end.acceptedActions, 2);
  assert.equal(manager.events(run.id).find(event => event.type === 'batch_result' && !event.accepted).code, 'PIECE_RETIRED');
});

test('last-turn edits are preserved as partial work and never reported as reviewed completion', async t => {
  let calls = 0;
  const { manager, source } = await setup(t, async () => { calls++; return output([cut, place, describe], true); });
  const run = await manager.start({ spec: { ...spec, maxTurns: 1 }, sources: [source] });
  const end = await finished(manager, run.id);
  assert.equal(end.status, 'limit_reached');
  assert.equal(end.terminationReason, 'turn_limit');
  assert.equal(end.acceptedActions, 3);
  assert.equal(end.rejectedBatches, 0);
  assert.equal(calls, 1);
  assert.equal(manager.events(run.id).some(event => event.type === 'final_review'), false);
});

test('an exhausted action allowance gets exactly one read-only final look within remaining turns', async t => {
  const cases = [
    { name: 'confirm', response: output([], true), status: 'completed', rejected: 0 },
    { name: 'decline', response: output([], false), status: 'limit_reached', rejected: 0 },
    { name: 'malformed', response: { ...output(), text: 'not JSON' }, status: 'limit_reached', rejected: 1 },
    { name: 'attempt an edit', response: output([{ type: 'remove', pieceId: 'leaf' }], true), status: 'limit_reached', rejected: 1 },
  ];
  for (const scenario of cases) await t.test(scenario.name, async t => {
    let calls = 0;
    const { manager, source } = await setup(t, async request => {
      calls++;
      if (calls === 1) return output([cut, place], true);
      const observation = JSON.parse(request.messages.at(-1).text);
      assert.equal(observation.reviewOnly, true);
      assert.equal(observation.actionsRemaining, 0);
      assert.equal(observation.state.pieces[0].visible, true);
      assert.match(observation.feedback, /action budget is exhausted/);
      return scenario.response;
    });
    const run = await manager.start({ spec: { ...spec, maxActions: 2, maxTurns: 4 }, sources: [source] });
    const end = await finished(manager, run.id);
    assert.equal(end.status, scenario.status);
    assert.equal(end.terminationReason, scenario.status === 'completed' ? 'model_finished' : 'action_limit');
    assert.equal(end.acceptedActions, 2);
    assert.equal(end.rejectedBatches, scenario.rejected);
    assert.equal(calls, 2);
    assert.equal(manager.state(run.id).pieces[0].visible, true);
    assert.equal(manager.events(run.id).filter(event => event.type === 'final_review').length, scenario.status === 'completed' ? 1 : 0);
  });
});

test('net-zero edits and hidden material do not force redundant canvas reviews', async t => {
  const transform = x => ({ type: 'transform', pieceId: 'leaf', x });
  const scenarios = [
    { name: 'unplaced cut', batches: [[cut, describe]] },
    { name: 'place then remove', batches: [[cut, place, { type: 'remove', pieceId: 'leaf' }, describe]] },
    { name: 'transform then revert', batches: [[cut, place], [transform(600), transform(300), describe]] },
    { name: 'reorder across hidden material', batches: [[cut, place, { ...cut, pieceId: 'hidden', polygon: [[50, 50], [90, 50], [90, 90], [50, 90]] }], [{ type: 'reorder', pieceId: 'leaf', index: 1 }, describe]] },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async t => {
    let calls = 0;
    const { manager, source } = await setup(t, async () => {
      assert.ok(calls < scenario.batches.length, 'must not make a redundant provider call');
      return output(scenario.batches[calls++], calls === scenario.batches.length);
    });
    const run = await manager.start({ spec, sources: [source] });
    const end = await finished(manager, run.id);
    assert.equal(end.status, 'completed');
    assert.equal(calls, scenario.batches.length);
    const review = manager.events(run.id).find(event => event.type === 'final_review');
    assert.ok(review.step > review.observedStep);
    assert.deepEqual(await renderPNG(manager.state(run.id)), await renderPNG(manager.state(run.id, { step: review.observedStep })));
  });
});

test('stopping during final review preserves accepted edits and ignores a late confirmation', async t => {
  const reviewing = deferred(), answer = deferred();
  let calls = 0;
  const { manager, source } = await setup(t, async () => {
    if (++calls === 1) return output([cut, place], true);
    reviewing.resolve();
    return answer.promise;
  });
  const run = await manager.start({ spec, sources: [source] });
  await reviewing.promise;
  await manager.stop(run.id);
  answer.resolve(output([], true));
  await immediate();
  assert.equal(manager.get(run.id).status, 'stopped');
  assert.equal(manager.get(run.id).acceptedActions, 2);
  assert.equal(manager.events(run.id).some(event => event.type === 'final_review'), false);
  assert.equal(manager.events(run.id).filter(event => event.type === 'termination').length, 1);
});

test('unfinished runs become interrupted on restart; a partial event tail is preserved and recovered', async t => {
  const entered = deferred();
  const { manager, source, dataDir, providerFactory } = await setup(t, async () => { entered.resolve(); return new Promise(() => {}); });
  const run = await manager.start({ spec, sources: [source] });
  await entered.promise;
  await manager.close();
  const runDir = join(dataDir, run.id);
  const events = manager.events(run.id).filter(event => event.type !== 'termination');
  await writeFile(join(runDir, 'events.jsonl'), events.map(event => JSON.stringify(event) + '\n').join(''));
  await appendFile(join(runDir, 'events.jsonl'), '{"sequence":');
  const restarted = await createRunManager({ dataDir, providerFactory });
  t.after(() => restarted.close());
  const end = restarted.get(run.id);
  assert.equal(end.status, 'interrupted');
  assert.equal(end.terminationReason, 'server_restarted');
  assert.equal(end.usageIncomplete, true);
  assert.equal(end.acceptedActions, 0);
  assert.ok((await readdir(runDir)).some(name => name.startsWith('events-recovery-')));
  assert.equal(restarted.events(run.id).at(-1).type, 'termination');
  assert.equal(restarted.events(run.id).at(-2).type, 'recovery');
});

test('provider errors fail once with unknown usage and never trigger a hidden retry', async t => {
  let calls = 0;
  const { manager, source } = await setup(t, async () => { calls++; throw Object.assign(new Error('Provider temporarily unavailable.'), { code: 'PROVIDER_FAILURE' }); });
  const run = await manager.start({ spec, sources: [source] });
  const end = await finished(manager, run.id);
  assert.equal(end.status, 'failed');
  assert.equal(end.usageIncomplete, true);
  assert.equal(calls, 1);
  assert.equal(manager.events(run.id).find(event => event.type === 'error').error.code, 'PROVIDER_FAILURE');
});

test('the fixed textual context budget ends a run without silently dropping prior output', async t => {
  let calls = 0;
  const { manager, source } = await setup(t, async request => {
    calls++;
    assert.ok(request.instructions.length + request.messages.reduce((sum, message) => sum + message.text.length, 0) <= 250000);
    return { ...output(), text: '{'.repeat(90000) };
  });
  const run = await manager.start({ spec: { ...spec, maxTurns: 10 }, sources: [source] });
  const end = await finished(manager, run.id);
  assert.equal(end.status, 'limit_reached');
  assert.equal(end.terminationReason, 'context_limit');
  assert.equal(end.turns, 3);
  assert.equal(calls, 3);
  assert.equal(end.rejectedBatches, 3);
  assert.equal(end.policy.maxContextTextCharacters, 250000);
});

test('spec validation rejects unknown fields and invalid bounds before invoking a provider', async t => {
  const { manager, source, factoryCalls } = await setup(t, async () => output([], true));
  for (const patch of [{ provider: 'other' }, { apiKey: 'never-store-this' }, { maxTurns: 41 }, { maxMinutes: 0 }, { maxOutputTokens: 255 }, { maxPieces: 65 }, { maxActions: 241 }, { model: '' }, { prompt: '' }]) {
    await assert.rejects(manager.start({ spec: { ...spec, ...patch }, sources: [source] }), error => error.status === 400);
  }
  await assert.rejects(manager.start({ spec, sources: [] }), error => error.status === 400);
  await assert.rejects(manager.start({ spec, sources: [{ ...source, width: 99 }] }), error => error.status === 400);
  assert.equal(factoryCalls(), 0);
  assert.throws(() => manager.get('../../credentials'), error => error.status === 404);
  assert.equal(manager.list().length, 0);
});

test('launch metadata is bounded, contains no extra fields, and is saved before provider execution', async t => {
  let persisted;
  const { manager, source, dataDir, factoryCalls } = await setup(t, async request => {
    const id = JSON.parse(request.messages.at(-1).text).state.id;
    persisted = JSON.parse(await readFile(join(dataDir, id, 'run.json'), 'utf8'));
    return output([], true);
  });
  const launch = { clientRequestId: randomUUID(), requestFingerprint: 'a'.repeat(64) };
  for (const invalid of [null, [], {}, { ...launch, apiKey: 'do-not-store' }, { ...launch, clientRequestId: '' }, { ...launch, requestFingerprint: [] }]) {
    await assert.rejects(manager.start({ spec, sources: [source], launch: invalid }), error => error.status === 400);
  }
  assert.equal(factoryCalls(), 0);
  const run = await manager.start({ spec, sources: [source], launch });
  const expected = { ...launch };
  launch.requestFingerprint = 'b'.repeat(64);
  await finished(manager, run.id);
  assert.deepEqual(persisted.launch, expected);
  assert.deepEqual(manager.get(run.id).launch, expected);
  assert.deepEqual(manager.events(run.id).find(event => event.type === 'run_started').launch, expected);
  assert.equal(factoryCalls(), 1);
});

function selectionRecord(source, patch = {}) {
  const sha256 = createHash('sha256').update(Buffer.from(source.dataUrl.split(',')[1], 'base64')).digest('hex');
  const recipe = normalizeMaterialSelection({ version: 1, algorithm: 'offcut-fisher-yates-v1', seed: 7, catalogSnapshot: 'a'.repeat(64), pinnedIds: [], candidateIds: [source.id], randomCount: 1, ...patch });
  return { ...recipe, candidateManifest: recipe.candidateIds.map(id => ({ id, sha256 })) };
}

test('material selection is frozen before execution, exported, and recovered from the launch event', async t => {
  const entered = deferred(), gate = deferred();
  let persistedSummary, persistedEvent;
  const { manager, source, dataDir, providerFactory, factoryCalls } = await setup(t, async request => {
    const id = JSON.parse(request.messages.at(-1).text).state.id;
    persistedSummary = JSON.parse(await readFile(join(dataDir, id, 'run.json'), 'utf8'));
    persistedEvent = JSON.parse((await readFile(join(dataDir, id, 'events.jsonl'), 'utf8')).split('\n')[0]);
    entered.resolve();
    await gate.promise;
    return output([], true);
  });
  const materialSelection = selectionRecord(source, { candidateIds: ['alpha', 'page', 'zeta'], pinnedIds: ['page'], randomCount: 1 });
  const expected = structuredClone(materialSelection);
  const { candidateManifest, ...recipe } = materialSelection;
  const selectedIds = drawMaterialIds(recipe);
  const sources = selectedIds.map(id => ({ ...source, id, name: id }));
  const expectedSources = structuredClone(sources);
  const starting = manager.start({ spec, sources, materialSelection });
  // Mutations while image validation is awaiting must not affect the receipt.
  materialSelection.seed = 100;
  materialSelection.candidateIds.reverse();
  materialSelection.pinnedIds.push('later-pin');
  materialSelection.candidateManifest[0].sha256 = 'b'.repeat(64);
  sources[0].name = 'Changed after launch';
  sources[0].dataUrl = 'broken-after-launch';
  const run = await starting;
  await entered.promise;
  assert.deepEqual(persistedSummary.materialSelection, expected);
  assert.deepEqual(persistedEvent.materialSelection, expected);
  assert.deepEqual(run.materialSelection, expected);
  gate.resolve();
  assert.equal((await finished(manager, run.id)).status, 'completed');
  const bundle = await manager.bundle(run.id);
  assert.deepEqual(bundle.run.materialSelection, expected);
  assert.deepEqual(bundle.events.find(event => event.type === 'run_started').materialSelection, expected);
  assert.deepEqual(bundle.project.sources, expectedSources);
  assert.equal(bundle.project.materialSelection, undefined, 'The standalone artwork format is unchanged');
  run.materialSelection.candidateManifest[0].sha256 = 'c'.repeat(64);
  bundle.run.materialSelection.pinnedIds.push('mutated-export');
  assert.deepEqual(manager.get(run.id).materialSelection, expected);
  assert.equal(factoryCalls(), 1);

  await manager.close();
  const summaryPath = join(dataDir, run.id, 'run.json');
  const staleSummary = JSON.parse(await readFile(summaryPath, 'utf8'));
  staleSummary.materialSelection = { apiKey: 'checkpoint-secret-must-not-survive' };
  await writeFile(summaryPath, JSON.stringify(staleSummary));
  const restarted = await createRunManager({ dataDir, providerFactory });
  t.after(() => restarted.close());
  assert.deepEqual(restarted.get(run.id).materialSelection, expected);
  assert.deepEqual((await restarted.bundle(run.id)).run.materialSelection, expected);
  assert.deepEqual(JSON.parse(await readFile(summaryPath, 'utf8')).materialSelection, expected);
  assert.ok(!JSON.stringify(await restarted.bundle(run.id)).includes('checkpoint-secret-must-not-survive'));
  assert.equal(factoryCalls(), 1, 'Recovery never invokes a provider');
});

test('invalid selection receipts, source order, and candidate hashes fail before provider capture', async t => {
  const { manager, source, factoryCalls } = await setup(t, async () => output([], true));
  const valid = selectionRecord(source);
  const invalid = [
    null, [], {}, { ...valid, apiKey: 'never-store-selection-secret' },
    { ...valid, version: 2 }, { ...valid, algorithm: 'unknown' },
    { ...valid, seed: -1 }, { ...valid, catalogSnapshot: 'invalid' },
    { ...valid, pinnedIds: [{ apiKey: 'never-store-selection-secret' }] },
    { ...valid, candidateIds: ['page', 'page'] },
    { ...valid, candidateManifest: undefined }, { ...valid, candidateManifest: [] },
    { ...valid, candidateManifest: [...valid.candidateManifest, ...valid.candidateManifest] },
    { ...valid, candidateManifest: [{ id: 'other', sha256: valid.candidateManifest[0].sha256 }] },
    { ...valid, candidateManifest: [{ ...valid.candidateManifest[0], apiKey: 'never-store-selection-secret' }] },
    { ...valid, candidateManifest: [{ id: 'page', sha256: {} }] },
    { ...valid, candidateManifest: [{ id: 'page', sha256: 'b'.repeat(64) }] },
    { ...valid, candidateManifest: Array(1) },
  ];
  for (const materialSelection of invalid) {
    await assert.rejects(manager.start({ spec, sources: [source], materialSelection }), error => error.status === 400);
  }
  const twoSources = [source, { ...source, id: 'second' }];
  const two = selectionRecord(source, { candidateIds: ['page', 'second'], pinnedIds: ['page', 'second'], randomCount: 0 });
  await assert.rejects(manager.start({ spec, sources: twoSources.reverse(), materialSelection: two }), /do not match.*in order/);
  await assert.rejects(manager.start({ spec, sources: [source], materialSelection: two }), /do not match.*in order/);
  const wrongManifestOrder = { ...two, candidateManifest: [...two.candidateManifest].reverse() };
  await assert.rejects(manager.start({ spec, sources: [source, { ...source, id: 'second' }], materialSelection: wrongManifestOrder }), /sorted ID order/);
  assert.equal(factoryCalls(), 0);
  assert.equal(manager.list().length, 0);
});

test('pins outside the candidate pool are retained and manual-only recipes can have no candidates', async t => {
  const { manager, source } = await setup(t, async () => output([], true));
  const random = { ...source, id: 'random-page' };
  const materialSelection = selectionRecord(source, { pinnedIds: ['page'], candidateIds: ['random-page'], randomCount: 1 });
  const started = await manager.start({ spec, sources: [source, random], materialSelection });
  const end = await finished(manager, started.id);
  assert.deepEqual(end.materialSelection.pinnedIds, ['page']);
  assert.deepEqual(end.sourceManifest.map(item => item.id), ['page', 'random-page']);
  assert.deepEqual(end.materialSelection.candidateManifest.map(item => item.id), ['random-page']);
  const manual = selectionRecord(source, { pinnedIds: ['page'], candidateIds: [], randomCount: 0 });
  const manualRun = await manager.start({ spec, sources: [source], materialSelection: manual });
  assert.equal((await finished(manager, manualRun.id)).status, 'completed');
  assert.deepEqual(manager.get(manualRun.id).materialSelection, manual);
});

test('legacy launches remain valid and recovery does not invent a material selection recipe', async t => {
  const { manager, source, dataDir, providerFactory, factoryCalls } = await setup(t, async () => output([], true));
  const run = await manager.start({ spec, sources: [source] });
  await finished(manager, run.id);
  assert.equal(Object.hasOwn(manager.get(run.id), 'materialSelection'), false);
  assert.equal(Object.hasOwn(manager.events(run.id)[0], 'materialSelection'), false);
  await manager.close();
  const summaryPath = join(dataDir, run.id, 'run.json');
  const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  summary.materialSelection = selectionRecord(source);
  await writeFile(summaryPath, JSON.stringify(summary));
  const restarted = await createRunManager({ dataDir, providerFactory });
  t.after(() => restarted.close());
  assert.equal(Object.hasOwn(restarted.get(run.id), 'materialSelection'), false);
  assert.equal(Object.hasOwn((await restarted.bundle(run.id)).run, 'materialSelection'), false);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(summaryPath, 'utf8')), 'materialSelection'), false);
  assert.equal(factoryCalls(), 1);
});

test('frozen material manifests retain bounded catalog provenance and omit arbitrary metadata', async t => {
  const gate = deferred();
  const { manager, source, dataDir, providerFactory } = await setup(t, async () => { await gate.promise; return output([], true); });
  source.collection = 'Cleveland Museum of Art';
  source.tags = ['bird', 'paper', 'bird'];
  source.apiKey = 'source-secret-must-not-persist';
  source.provenance = {
    provider: 'museum', recordId: '123', title: 'A bird', creator: 'An artist',
    url: 'https://example.org/collection/123', originalSha256: 'd'.repeat(64),
    rightsEvidence: { share_license_status: 'CC0', policyUrl: 'https://example.org/rights', apiKey: 'rights-secret-must-not-persist' },
    normalization: { maxEdge: 900, format: 'jpeg', quality: 88, fullImage: true, path: '/private/never-persist' },
    alsoCatalogedAs: [{ provider: 'second-museum', recordId: '456', apiKey: 'alias-secret-must-not-persist' }],
    apiKey: 'provenance-secret-must-not-persist', path: '/private/never-persist', unexpected: { secret: 'nested-secret-must-not-persist' },
  };
  const starting = manager.start({ spec, sources: [source] });
  source.collection = 'Changed after start';
  source.tags.push('changed-tag');
  source.provenance.creator = 'Changed creator';
  source.provenance.normalization.quality = 1;
  const run = await starting;
  gate.resolve();
  await finished(manager, run.id);
  const manifest = manager.get(run.id).sourceManifest[0];
  assert.equal(manifest.collection, 'Cleveland Museum of Art');
  assert.deepEqual(manifest.tags, ['bird', 'paper']);
  assert.equal(manifest.provenance.creator, 'An artist');
  assert.deepEqual(manifest.provenance.rightsEvidence, { share_license_status: 'CC0', policyUrl: 'https://example.org/rights' });
  assert.deepEqual(manifest.provenance.normalization, { maxEdge: 900, format: 'jpeg', quality: 88, fullImage: true });
  assert.deepEqual(manifest.provenance.alsoCatalogedAs, [{ provider: 'second-museum', recordId: '456' }]);
  const bundle = await manager.bundle(run.id);
  assert.deepEqual(bundle.events[0].sourceManifest, bundle.run.sourceManifest);
  assert.ok(!JSON.stringify(bundle).includes('must-not-persist'));
  assert.ok(!JSON.stringify(bundle).includes('/private/never-persist'));
  assert.equal(bundle.project.sources[0].collection, undefined);
  assert.equal(bundle.project.sources[0].provenance, undefined);
  assert.equal(bundle.project.sources[0].credit, 'Test fixture');
  assert.equal(bundle.project.sources[0].license, 'CC0');
  await manager.close();
  const restarted = await createRunManager({ dataDir, providerFactory });
  t.after(() => restarted.close());
  assert.deepEqual(restarted.get(run.id).sourceManifest[0], manifest);
});

test('batch provenance and launch linkage are validated before connection, frozen, and recovered from the durable launch event', async t => {
  const { manager, source, dataDir, providerFactory, factoryCalls } = await setup(t, async () => output([], true));
  const batch = { id: `batch-${randomUUID()}`, groupIndex: 1, runIndex: 7 };
  const launch = { clientRequestId: randomUUID(), requestFingerprint: 'd'.repeat(64) };
  for (const invalid of [{ ...batch, privateKey: 'secret' }, { ...batch, id: 'other' }, { ...batch, groupIndex: 8 }, { ...batch, runIndex: 50 }]) {
    await assert.rejects(manager.start({ spec, sources: [source], batch: invalid }), /batch provenance/);
  }
  assert.equal(factoryCalls(), 0);
  const original = structuredClone(batch);
  const starting = manager.start({ spec, sources: [source], batch, launch });
  batch.groupIndex = 4;
  const run = await starting;
  const ended = await manager.wait(run.id);
  assert.equal(ended.status, 'completed');
  const file = join(dataDir, run.id, 'run.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.status, 'completed', 'wait resolves after the final checkpoint is durable.');
  assert.deepEqual(ended.batch, original);
  assert.deepEqual(manager.events(run.id)[0].batch, original);
  assert.deepEqual((await manager.bundle(run.id)).run.batch, original);
  await manager.close();
  saved.batch = { ...original, groupIndex: 6 };
  saved.launch = { clientRequestId: randomUUID(), requestFingerprint: 'a'.repeat(64) };
  await writeFile(file, JSON.stringify(saved));
  const recovered = await createRunManager({ dataDir, providerFactory });
  t.after(() => recovered.close());
  assert.deepEqual(recovered.get(run.id).batch, original);
  assert.deepEqual(recovered.get(run.id).launch, launch);
  assert.equal(factoryCalls(), 1);
});

test('legacy run recovery removes invented batch labels from a stale summary', async t => {
  const { manager, source, dataDir, providerFactory } = await setup(t, async () => output([], true));
  const run = await manager.start({ spec, sources: [source] });
  await manager.wait(run.id);
  await manager.close();
  const file = join(dataDir, run.id, 'run.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.batch = { id: `batch-${randomUUID()}`, groupIndex: 0, runIndex: 0 };
  await writeFile(file, JSON.stringify(saved));
  const recovered = await createRunManager({ dataDir, providerFactory });
  t.after(() => recovered.close());
  assert.equal(Object.hasOwn(recovered.get(run.id), 'batch'), false);
});
