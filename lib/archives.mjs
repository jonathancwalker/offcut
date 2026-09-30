import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createState, applyAction } from './engine.mjs';

const DEFAULT_DIRECTORY = fileURLToPath(new URL('../experiments/', import.meta.url));
const RECORDS = Object.freeze({
  'archive-001': {
    directory: '001',
    startingActions: 5,
    provenance: 'Codex continued a human-seeded canvas. Playback includes 5 human actions followed by 48 agent actions. The exact model identifier was not recorded.',
  },
  'archive-002': {
    directory: '002',
    startingActions: 0,
    provenance: 'A fresh agent started from a blank canvas without prior conversation context. The exact model identifier was not recorded.',
  },
});
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function compactState(state) {
  const { sources, ...rest } = state;
  return { ...clone(rest), sources: sources.map(({ dataUrl, ...source }) => clone(source)) };
}

function reconstruct(project) {
  if (!object(project) || project.format !== 'offcut-project' || project.version !== 1
      || !Array.isArray(project.actions) || project.actions.length > 240
      || !Number.isSafeInteger(project.cursor) || project.cursor < 0 || project.cursor > project.actions.length) {
    throw new Error('The saved archive project is invalid.');
  }
  const initial = createState({ id: project.id, sources: project.sources, canvas: project.canvas, rules: project.rules });
  const states = [initial];
  for (const record of project.actions) {
    if (!object(record) || !object(record.action)) throw new Error('The saved archive action is invalid.');
    const next = applyAction(states.at(-1), record.action);
    // Immutable source images are shared across the replay frames.
    next.sources = initial.sources;
    states.push(next);
  }
  return states;
}

/** Read-only access to the two deliberately published, local historical works. */
export function createArchiveCatalog({ directory = DEFAULT_DIRECTORY } = {}) {
  const records = new Map();
  async function load(id) {
    if (!Object.hasOwn(RECORDS, id)) fail('Archived work not found.', 404);
    if (!records.has(id)) {
      const metadata = RECORDS[id];
      const loading = (async () => {
        const bytes = await readFile(join(directory, metadata.directory, 'final-project.json'));
        const project = JSON.parse(bytes.toString('utf8'));
        const states = reconstruct(project);
        const state = states[project.cursor];
        const revision = `${id}:${createHash('sha256').update(bytes).digest('hex')}`;
        const summary = {
          id, recordType: 'archive', status: 'archived',
          createdAt: project.createdAt, updatedAt: project.updatedAt, revision,
          acceptedActions: project.cursor, startingActions: metadata.startingActions,
          title: state.title, spec: { model: null, provider: null },
          sourceManifest: state.sources.map(({ dataUrl, ...source }) => source),
          provenance: metadata.provenance,
        };
        return { project, states, summary };
      })();
      records.set(id, loading);
      loading.catch(() => records.delete(id));
    }
    return records.get(id);
  }
  function stepFor(record, options = {}) {
    const step = options.step ?? record.project.cursor;
    if (!Number.isSafeInteger(step) || step < 0) fail('Replay step must be a non-negative integer.');
    if (step > record.project.cursor) fail('That archived replay step does not exist.', 404);
    return step;
  }
  return {
    async list() {
      const all = await Promise.all(Object.keys(RECORDS).map(load));
      return all.map(record => clone(record.summary)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async get(id) {
      const record = await load(id);
      return { ...clone(record.summary), state: compactState(record.states[record.project.cursor]) };
    },
    async project(id, options) {
      const record = await load(id);
      return { ...clone(record.project), cursor: stepFor(record, options) };
    },
    async state(id, options) {
      const record = await load(id);
      return clone(record.states[stepFor(record, options)]);
    },
  };
}
