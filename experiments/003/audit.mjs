import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import { createState, applyAction } from '../../lib/engine.mjs';
import { renderPNG, renderSVG } from '../../lib/render.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const readJSON = async name => JSON.parse(await readFile(join(directory, name), 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const initial = await readJSON('initial-project.json');
const final = await readJSON('final-project.json');
const setup = await readJSON('setup.json');
const dispatch = await readJSON('dispatch.json');
const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);

assert.equal(initial.cursor, 0);
assert.equal(initial.actions.length, 0);
assert.equal(initial.sources.length, 6);
assert.equal(new Set(initial.sources.map(source => source.id)).size, 6);
assert.equal(final.id, initial.id);
assert.deepEqual(final.sources, initial.sources);
assert.deepEqual(final.canvas, initial.canvas);
assert.deepEqual(final.rules, initial.rules);
assert.deepEqual(initial.canvas, setup.constraints.canvas);
assert.deepEqual(initial.rules, setup.constraints.rules);
assert.equal(final.cursor, final.actions.length);
assert.ok(final.cursor <= initial.rules.maxActions);
assert.equal(dispatch.fork_turns, 'none');
assert.equal(dispatch.priorConversationPassed, false);
assert.equal(sha((await readFile(join(directory, dispatch.promptFile), 'utf8')).trimEnd()), dispatch.promptSha256);

const pool = [...setup.selection.candidates];
assert.equal(pool.length, setup.selection.candidateCount);
assert.equal(new Set(pool.map(source => source.id)).size, pool.length);
assert.equal(setup.selection.draws.length, 6);
const chosen = setup.selection.draws.map((draw, index) => {
  assert.equal(draw.draw, index + 1);
  assert.equal(draw.remainingPoolSize, pool.length);
  assert.ok(Number.isInteger(draw.index) && draw.index >= 0 && draw.index < pool.length);
  const source = pool.splice(draw.index, 1)[0];
  assert.equal(draw.sourceId, source.id);
  return source;
});
assert.deepEqual(chosen.map(source => source.id), setup.selection.selectedIds);
assert.deepEqual(initial.sources.map(source => source.id), setup.selection.selectedIds);
for (const source of initial.sources) {
  const expected = chosen.find(candidate => candidate.id === source.id);
  const bytes = Buffer.from(source.dataUrl.split(',')[1], 'base64');
  assert.equal(sha(bytes), expected.sha256);
  assert.equal(sha(bytes), setup.selection.selectedHashes[source.id]);
}

let state = createState({ sources: initial.sources, canvas: initial.canvas, rules: initial.rules, id: initial.id });
for (const record of final.actions) {
  state = applyAction(state, record.action);
  state.sources = initial.sources;
}
assert.ok(state.pieces.length <= initial.rules.maxPieces);
const responseEvents = events.filter(event => event.type === 'action_response');
const responses = new Map(responseEvents.map(event => [event.requestId, event]));
assert.equal(responses.size, responseEvents.length);
const requests = events.filter(event => event.type === 'action_request');
assert.equal(new Set(requests.map(event => event.requestId)).size, requests.length);
assert.ok(requests.length <= setup.constraints.maxBatches);
assert.ok(requests.every(event => responses.has(event.requestId)), 'Every submitted batch must have a recorded response.');
assert.ok(responseEvents.every(event => requests.some(request => request.requestId === event.requestId)));
assert.ok(requests.every(event => event.actions.length >= 1 && event.actions.length <= setup.constraints.maxActionsPerBatch));
const accepted = requests.filter(event => responses.get(event.requestId).status === 200);
assert.deepEqual(accepted.flatMap(event => event.actions), final.actions.map(record => record.action));
let cursor = 0;
for (const request of requests) {
  assert.equal(request.beforeCursor, cursor);
  const response = responses.get(request.requestId);
  if (response.status === 200) {
    cursor += request.actions.length;
    assert.equal(response.cursor, cursor);
  }
}
assert.equal(cursor, final.cursor);

const renderedPNG = await renderPNG(state);
assert.deepEqual(await readFile(join(directory, 'artwork.png')), renderedPNG);
assert.equal(await readFile(join(directory, 'artwork.svg'), 'utf8'), renderSVG(state));
const observations = events.filter(event => event.type === 'image_observation');
for (const observation of observations) {
  const path = resolve(directory, observation.path);
  assert.ok(path.startsWith(resolve(directory) + sep));
  assert.equal(sha(await readFile(path)), observation.sha256);
}
const observedSources = new Set(observations.filter(event => event.endpoint.startsWith('sources/')).map(event => decodeURIComponent(event.endpoint.slice('sources/'.length))));
assert.deepEqual([...observedSources].sort(), initial.sources.map(source => source.id).sort());

// Updated timestamps can change when the server reloads a saved project.
// Compare artwork and source history, excluding that incidental timestamp.
const substantiveProject = project => Object.fromEntries(['id', 'createdAt', 'sources', 'canvas', 'rules', 'actions', 'cursor'].map(key => [key, project[key]]));
let originalWorktableUnchanged = null;
let originalProjectVerifiedAgainstBackup = false;
try {
  const before = JSON.parse(await readFile(new URL('../../.data/experiment-003/main-before.json', import.meta.url), 'utf8'));
  assert.equal(sha(JSON.stringify(before)), setup.mainProjectSha256);
  originalProjectVerifiedAgainstBackup = true;
  let response;
  try { response = await fetch('http://127.0.0.1:4317/api/project'); } catch { /* Main server may be stopped. */ }
  if (response?.ok) originalWorktableUnchanged = JSON.stringify(substantiveProject(before)) === JSON.stringify(substantiveProject(await response.json()));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const actions = final.actions.map(record => record.action);
const usedSources = [...new Set(actions.filter(action => action.type === 'cut').map(action => action.sourceId))];
const result = {
  title: state.title,
  statement: state.statement,
  startingActions: 0,
  acceptedActions: final.cursor,
  attemptedActions: requests.reduce((count, request) => count + request.actions.length, 0),
  acceptedBatches: accepted.length,
  rejectedBatches: requests.length - accepted.length,
  fragments: state.pieces.length,
  visibleFragments: state.pieces.filter(piece => piece.visible).length,
  sourceCount: state.sources.length,
  sourcesUsed: usedSources.length,
  usedSourceIds: usedSources,
  actionTypes: Object.fromEntries([...new Set(actions.map(action => action.type))].map(type => [type, actions.filter(action => action.type === type).length])),
  sourceImageObservations: observations.filter(event => event.endpoint.startsWith('sources/')).length,
  canvasImageObservations: observations.filter(event => event.endpoint === 'render.png').length,
  allSelectedSourcesRetrieved: true,
  recordedDrawsMatchSelection: true,
  sourceHashesMatchSelection: true,
  sourceInventoryUnchanged: true,
  rulesAndCanvasUnchanged: true,
  promptHashVerified: true,
  historyMatchesRecordedAcceptedRequests: true,
  batchAndActionLimitsRespected: true,
  allActionsPassedEngineReplay: true,
  exportedImagesMatchReplayExactly: true,
  observationFileHashesVerified: true,
  originalProjectVerifiedAgainstBackup,
  originalWorktableUnchanged,
  imageSha256: sha(renderedPNG),
  auditAt: new Date().toISOString(),
};
await writeFile(join(directory, 'run-summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
