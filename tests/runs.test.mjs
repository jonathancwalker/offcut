import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import { createRunManager } from '../lib/runs.mjs';
import { getSharp, renderPNG } from '../lib/render.mjs';

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
    return output([cut, place]);
  });
  const run = await manager.start({ spec: { ...spec, maxPieces: 1, maxActions: 2 }, sources: [source] });
  const end = await finished(manager, run.id);
  assert.equal(end.status, 'limit_reached');
  assert.equal(end.terminationReason, 'action_limit');
  assert.equal(end.acceptedActions, 2);
  assert.equal(end.rejectedBatches, 1);
  assert.equal(calls, 2);
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
  const { manager, source, dataDir, providerFactory } = await setup(t, async () => output([cut, place, describe], true));
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
  assert.equal(JSON.parse(await readFile(join(runDir, 'project.json'), 'utf8')).cursor, 3);
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
