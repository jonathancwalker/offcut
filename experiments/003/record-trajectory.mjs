import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const directory = fileURLToPath(new URL('.', import.meta.url));
const project = JSON.parse(await readFile(join(directory, 'final-project.json'), 'utf8'));
const summary = JSON.parse(await readFile(join(directory, 'run-summary.json'), 'utf8'));
const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
const requests = events.filter(event => event.type === 'action_request');
const responses = new Map(events.filter(event => event.type === 'action_response').map(event => [event.requestId, event]));
const escape = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const sourceName = id => project.sources.find(source => source.id === id)?.name || id;
function describe(action) {
  if (action.type === 'cut') return `Cut ${action.polygon.length}-vertex polygon from ${sourceName(action.sourceId)}`;
  if (action.type === 'reorder') return `Move to layer ${action.index} (0 = back)`;
  if (action.type === 'describe') return `Save title: ${action.title}; save statement`;
  return Object.entries(action).filter(([key]) => key !== 'pieceId').map(([key, value]) => key === 'type' ? value : `${key}=${value}`).join('; ');
}
const lines = [
  `# Recorded trajectory — ${summary.title}`,
  '',
  'Generated from the saved action history and client events. Batch notes are public intent notes supplied by the artist, not a transcript of internal reasoning. Times are UTC. Exact polygons and submitted actions remain in `events.jsonl`.',
  '',
];
let cursor = 0;
for (const [index, request] of requests.entries()) {
  const response = responses.get(request.requestId);
  const accepted = response?.status === 200;
  lines.push(`## Batch ${index + 1}${accepted ? '' : ' — rejected'}`, '', `Intent: ${request.note || '(No note supplied.)'}`, '', `Request: ${request.at}. Response: HTTP ${response?.status ?? 'unrecorded'}${accepted ? `; history cursor ${response.cursor}` : `; ${response?.error || 'unrecorded error'}`}.`, '');
  lines.push('| Step | Fragment | Action |', '| ---: | --- | --- |');
  for (const action of request.actions) {
    if (accepted) cursor++;
    lines.push(`| ${accepted ? cursor : 'Rejected'} | ${escape(action.pieceId || 'Composition')} | ${escape(describe(action))} |`);
  }
  lines.push('');
  const start = events.indexOf(request);
  const next = requests[index + 1] ? events.indexOf(requests[index + 1]) : events.length;
  for (const observation of events.slice(start, next).filter(event => event.type === 'image_observation' && event.endpoint === 'render.png')) {
    lines.push(`Canvas checkpoint at action ${observation.cursor}: [${observation.path}](${observation.path})`, '');
  }
}
lines.push(`The final export is [artwork.png](artwork.png). Replay all ${summary.acceptedActions} accepted actions at [Work A003](http://127.0.0.1:4317/work.html?run=archive-003).`, '');
await writeFile(join(directory, 'trajectory.md'), lines.join('\n'));
console.log(`Recorded ${requests.length} batches and ${cursor} accepted actions.`);
