import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const directory = fileURLToPath(new URL('.', import.meta.url));
const base = 'http://127.0.0.1:4317/api';
const stage = process.argv[2];
if (!stage || !/^[a-z0-9-]+$/.test(stage)) throw new Error('Supply a stage name.');
const actions = JSON.parse(await readFile(resolve(directory, `${stage}.json`), 'utf8'));
const starting = await (await fetch(`${base}/state`)).json();
const request = { timestamp: new Date().toISOString(), stage, beforeCursor: starting.cursor, endpoint: '/api/actions', actions };
await appendFile(resolve(directory, 'attempts.jsonl'), JSON.stringify({ ...request, event: 'request' }) + '\n');
const response = await fetch(`${base}/actions`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actions }),
});
const result = await response.json();
await appendFile(resolve(directory, 'attempts.jsonl'), JSON.stringify({ event: 'response', stage, timestamp: new Date().toISOString(), status: response.status, cursor: result.cursor, error: result.error }) + '\n');
if (!response.ok) throw new Error(JSON.stringify(result));
await writeFile(resolve(directory, `${stage}-state.json`), JSON.stringify(result, null, 2));
for (const [endpoint, extension] of [['render.png', 'png'], ['project', 'project.json']]) {
  const exported = await fetch(`${base}/${endpoint}`);
  if (!exported.ok) throw new Error(`${endpoint}: ${exported.status}`);
  await writeFile(resolve(directory, `${stage}.${extension}`), Buffer.from(await exported.arrayBuffer()));
}
console.log(JSON.stringify({ stage, actions: actions.length, cursor: result.cursor, pieces: result.state.pieces.length, title: result.state.title }));
