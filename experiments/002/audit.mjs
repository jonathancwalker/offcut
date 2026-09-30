import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createState, applyAction } from '../../lib/engine.mjs';
import { renderPNG, renderSVG } from '../../lib/render.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const readJSON = async name => JSON.parse(await readFile(join(directory, name), 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const initial = await readJSON('initial-project.json');
const final = await readJSON('final-project.json');
const setup = await readJSON('setup.json');
const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);

assert.equal(initial.cursor, 0);
assert.equal(initial.actions.length, 0);
assert.equal(final.id, initial.id);
assert.deepEqual(final.sources, initial.sources);
assert.deepEqual(final.canvas, initial.canvas);
assert.deepEqual(final.rules, initial.rules);
assert.equal(final.cursor, final.actions.length);

let state = createState({ sources: initial.sources, canvas: initial.canvas, rules: initial.rules, id: initial.id });
for (const record of final.actions) state = applyAction(state, record.action);
const responses = new Map(events.filter(e => e.type === 'action_response').map(e => [e.requestId, e]));
const requests = events.filter(e => e.type === 'action_request');
const accepted = requests.filter(e => responses.get(e.requestId)?.status === 200);
assert.deepEqual(accepted.flatMap(e => e.actions), final.actions.map(e => e.action));
assert.ok(requests.every(e => responses.has(e.requestId)), 'Every action request must have a recorded response.');

const renderedPNG = await renderPNG(state);
assert.deepEqual(await readFile(join(directory, 'artwork.png')), renderedPNG);
assert.equal(await readFile(join(directory, 'artwork.svg'), 'utf8'), renderSVG(state));
const observations = events.filter(e => e.type === 'image_observation');
for (const observation of observations) {
  assert.equal(sha(await readFile(join(directory, observation.path))), observation.sha256);
}

let originalWorktableUnchanged = null;
try {
  const response = await fetch('http://127.0.0.1:4317/api/project');
  if (response.ok) originalWorktableUnchanged = sha(JSON.stringify(await response.json())) === setup.mainProjectSha256;
} catch { /* The original server may be stopped; its saved backup is retained. */ }

const countTypes = actions => Object.fromEntries([...new Set(actions.map(a => a.type))].map(type => [type, actions.filter(a => a.type === type).length]));
const result = {
  title: state.title,
  statement: state.statement,
  startingActions: 0,
  acceptedActions: final.cursor,
  attemptedActions: requests.reduce((count, request) => count + request.actions.length, 0),
  acceptedBatches: accepted.length,
  rejectedBatches: requests.filter(e => responses.get(e.requestId)?.status !== 200).length,
  fragments: state.pieces.length,
  visibleFragments: state.pieces.filter(p => p.visible).length,
  sourceCount: state.sources.length,
  actionTypes: countTypes(final.actions.map(e => e.action)),
  sourceImageObservations: observations.filter(e => e.endpoint.startsWith('sources/')).length,
  canvasImageObservations: observations.filter(e => e.endpoint === 'render.png').length,
  sourceInventoryUnchanged: true,
  sourcePixelsIdenticalToExperiment001: setup.sourcePixelsIdenticalToExperiment001,
  rulesAndCanvasUnchanged: true,
  historyMatchesRecordedAcceptedRequests: true,
  allActionsPassedEngineReplay: true,
  exportedImagesMatchReplayExactly: true,
  observationFileHashesVerified: true,
  originalWorktableUnchanged,
  imageSha256: sha(renderedPNG),
  auditAt: new Date().toISOString(),
};
await writeFile(join(directory, 'run-summary.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
