import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const directory = fileURLToPath(new URL('.', import.meta.url));
const base = 'http://127.0.0.1:4318/api';
const trace = event => appendFile(join(directory, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
const compact = envelope => ({
  ...envelope,
  state: { ...envelope.state, sources: envelope.state.sources.map(({ dataUrl, ...source }) => source) },
});

async function readJSON(endpoint) {
  const response = await fetch(`${base}/${endpoint}`);
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}

export async function getState() {
  const result = compact(await readJSON('state'));
  await trace({ type: 'state_observation', state: result });
  return result;
}

export async function getHelp() {
  const result = await readJSON('help');
  await trace({ type: 'protocol_observation', help: result });
  return result;
}

async function imageObservation(endpoint, label) {
  const before = await readJSON('status');
  const response = await fetch(`${base}/${endpoint}`);
  if (!response.ok) throw new Error(`${endpoint}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const filename = `${Date.now()}-${label.replace(/[^a-zA-Z0-9_-]/g, '-')}-${randomUUID().slice(0, 6)}.png`;
  await mkdir(join(directory, 'observations'), { recursive: true });
  const path = join(directory, 'observations', filename);
  await writeFile(path, bytes);
  await trace({ type: 'image_observation', endpoint, path: `observations/${filename}`, cursor: before.cursor, revision: before.revision, sha256: createHash('sha256').update(bytes).digest('hex') });
  return path;
}

export const source = id => imageObservation(`sources/${encodeURIComponent(id)}`, `source-${id}`);
export const canvas = (label = 'canvas') => imageObservation('render.png', label);

export async function act(actions, note = '') {
  const requestId = randomUUID();
  const list = Array.isArray(actions) ? actions : [actions];
  const before = await readJSON('status');
  await trace({ type: 'action_request', requestId, beforeCursor: before.cursor, note, actions: list });
  let response;
  try {
    response = await fetch(`${base}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actions: list }) });
    const result = await response.json();
    await trace({ type: 'action_response', requestId, status: response.status, cursor: result.cursor, error: result.error });
    if (!response.ok) return { ok: false, status: response.status, error: result.error };
    return { ok: true, ...compact(result) };
  } catch (error) {
    await trace({ type: 'transport_error', requestId, status: response?.status, error: error.message });
    throw error;
  }
}

export async function exportWork() {
  for (const [endpoint, filename] of [['project', 'final-project.json'], ['render.png', 'artwork.png'], ['render.svg', 'artwork.svg']]) {
    const response = await fetch(`${base}/${endpoint}`);
    if (!response.ok) throw new Error(`${endpoint}: ${response.status}`);
    await writeFile(join(directory, filename), Buffer.from(await response.arrayBuffer()));
  }
  const result = await getState();
  await trace({ type: 'export', cursor: result.cursor, files: ['final-project.json', 'artwork.png', 'artwork.svg'] });
  return { title: result.state.title, cursor: result.cursor, pieces: result.state.pieces.length, artwork: join(directory, 'artwork.png') };
}
