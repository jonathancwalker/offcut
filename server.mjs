import http from 'node:http';
import { readFile, writeFile, rename, mkdir, realpath, stat, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createState, applyAction } from './lib/engine.mjs';
import { getSharp, renderSVG, renderPNG } from './lib/render.mjs';
import { createProviderRegistry } from './lib/providers.mjs';
import { createRunManager } from './lib/runs.mjs';
import { createArchiveCatalog } from './lib/archives.mjs';
import { createGIFExporter } from './lib/gif.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 40 * 1024 * 1024;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_INVENTORY_BYTES = 24 * 1024 * 1024;
const MAX_SOURCES = 24;
const FORMAT = 'offcut-project';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new RequestError(message, status); };
const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function sendJSON(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readJSON(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) fail('Send this request as application/json.', 415);
  if (Number(request.headers['content-length']) > MAX_BODY_BYTES) fail('This project is too large (40 MB maximum).', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) fail('This project is too large (40 MB maximum).', 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('The request contains invalid JSON.'); }
}

function decodeRaster(dataUrl) {
  if (typeof dataUrl !== 'string') fail('Supply an image as a base64 data URL.');
  const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) fail('Use a PNG, JPEG, WebP, or GIF image. SVG and remote URLs are not accepted.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > MAX_SOURCE_BYTES) fail('Each source must be an image smaller than 16 MB.');
  return bytes;
}

async function normalizeSource(input, { preserveId = false } = {}) {
  if (!isObject(input)) fail('Invalid source material.');
  const bytes = decodeRaster(input.dataUrl);
  let result;
  try {
    result = await getSharp()(bytes, { limitInputPixels: 20_000_000, failOn: 'error', animated: false })
      .rotate().png({ compressionLevel: 8 }).toBuffer({ resolveWithObject: true });
  } catch (error) {
    if (error.message.includes('Image support needs sharp')) throw error;
    fail('This image could not be opened. Use a valid image with no more than 20 million pixels.');
  }
  const { width, height } = result.info;
  if (width < 16 || height < 16 || width > 8192 || height > 8192) fail('Source images must be at least 16 pixels on each side and no more than 8192.');
  if (result.data.length > MAX_SOURCE_BYTES) fail('The decoded image is too large. Use an image with smaller dimensions.');
  const id = preserveId ? input.id : `source-${randomUUID().slice(0, 12)}`;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) fail('Invalid source identifier.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 160) fail('Give the source a name of 1–160 characters.');
  const source = { id, name: input.name.trim(), width, height, dataUrl: `data:image/png;base64,${result.data.toString('base64')}`, ...(typeof input.credit === 'string' ? { credit: input.credit.slice(0, 1000) } : {}) };
  if (typeof input.url === 'string' && input.url.length <= 2000) {
    try { const url = new URL(input.url); if (['http:', 'https:'].includes(url.protocol)) source.url = url.href; } catch {}
  }
  if (typeof input.license === 'string') source.license = input.license.slice(0, 300);
  return source;
}

function validateInventory(sources) {
  if (sources.length > MAX_SOURCES) fail(`A worktable can hold at most ${MAX_SOURCES} source images.`);
  if (new Set(sources.map(source => source.id)).size !== sources.length) fail('Every source must have a unique identifier.');
  if (sources.reduce((sum, source) => sum + Buffer.byteLength(source.dataUrl, 'ascii') * 0.75, 0) > MAX_INVENTORY_BYTES) fail('The combined source images are too large (24 MB maximum).');
}

async function loadDefaultSources(publicDir) {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(publicDir, 'sources', 'manifest.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const entries = Array.isArray(manifest) ? manifest : manifest.sources;
  if (!Array.isArray(entries)) throw new Error('The source pack manifest must list its images.');
  const sources = [];
  for (const entry of entries) {
    const base = resolve(publicDir, 'sources');
    const path = resolve(base, entry.file);
    if (!path.startsWith(base + sep)) throw new Error('Invalid source pack file path.');
    const buffer = await readFile(path);
    const mime = MIME[extname(path).toLowerCase()];
    sources.push(await normalizeSource({ ...entry, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` }, { preserveId: true }));
  }
  validateInventory(sources);
  return sources;
}

function makeProject(sources, { rules, canvas, id } = {}) {
  const initial = createState({ sources, rules, canvas, id: id ?? randomUUID() });
  if (!Number.isInteger(initial.canvas.width) || !Number.isInteger(initial.canvas.height) || initial.canvas.width < 64 || initial.canvas.height < 64 || initial.canvas.width > 4096 || initial.canvas.height > 4096) fail('Canvas dimensions must be whole numbers from 64 to 4096.');
  if (initial.rules.maxActions > 240 || initial.rules.maxPieces > 64 || initial.rules.maxVertices > 32 || initial.rules.maxScale > 10 || initial.rules.minScale < 0.01 || initial.rules.minArea < 1) fail('These project rules exceed the worktable limits (240 actions, 64 pieces, 32 vertices, scale 0.01–10, and minimum area 1).');
  return { format: FORMAT, version: 1, id: initial.id, createdAt: now(), updatedAt: now(), sources: clone(initial.sources), rules: clone(initial.rules), canvas: clone(initial.canvas), actions: [], cursor: 0 };
}

function reconstruct(project) {
  const initial = createState({ sources: project.sources, rules: project.rules, canvas: project.canvas, id: project.id });
  const states = [initial];
  for (const record of project.actions) states.push(applyAction(states.at(-1), record.action));
  return states;
}

async function validateProject(input) {
  if (!isObject(input) || input.format !== FORMAT || input.version !== 1) fail('This is not a supported Offcut project. Export a project from the worktable first.');
  if (!Array.isArray(input.sources) || input.sources.length > MAX_SOURCES) fail('The project has an invalid source inventory.');
  const sources = [];
  for (const source of input.sources) sources.push(await normalizeSource(source, { preserveId: true }));
  validateInventory(sources);
  if (!Array.isArray(input.actions) || input.actions.length > 240) fail('The project has an invalid action history.');
  if (!Number.isInteger(input.cursor) || input.cursor < 0 || input.cursor > input.actions.length) fail('The project has an invalid replay position.');
  const project = makeProject(sources, { rules: input.rules, canvas: input.canvas, id: typeof input.id === 'string' ? input.id.slice(0, 100) : undefined });
  project.createdAt = typeof input.createdAt === 'string' ? input.createdAt.slice(0, 40) : now();
  project.actions = input.actions.map(record => {
    if (!isObject(record) || !isObject(record.action)) fail('The project has an invalid action.');
    return { action: clone(record.action), at: typeof record.at === 'string' ? record.at.slice(0, 40) : now() };
  });
  project.cursor = input.cursor;
  return { project, states: reconstruct(project) };
}

export const API_HELP = {
  name: 'Offcut — a constrained collage worktable',
  description: 'Invent a work using only existing source pixels. Every fragment is a polygon cut from supplied material. Cuts may not overlap on a source; removed pieces still consume material. Inspect your work with /api/render.png, then revise it.',
  coordinates: 'Cuts use original source-image pixels. Placement x/y is the center of the cropped fragment on the canvas; rotation is degrees clockwise. Scale is uniform. Piece order is back to front.',
  routes: {
    'GET /api/state': 'Current state, history, cursor, and undo/redo availability. Add ?step=N to inspect the state after N actions (0 is an empty canvas). Reading a past step does not move the live cursor.',
    'GET /api/status': 'Lightweight polling endpoint: {revision,cursor,updatedAt}. Fetch /api/state only when its revision changes.',
    'GET /api/sources/:id': 'Read an original source image.',
    'POST /api/actions': 'Submit one action object or {actions:[action,...]}. A batch is atomic: if any action fails, none are saved.',
    'GET /api/render.png': 'Rendered composition. Add ?step=N for a replay image.',
    'GET /api/render.svg': 'Self-contained SVG with original image fragments. Add ?step=N for replay.',
    'POST /api/sources': 'Add source material with {name,dataUrl,credit?}. PNG, JPEG, WebP, GIF; images are normalized to PNG. Source inventory is available at every replay step.',
    'POST /api/undo': 'Undo one action.',
    'POST /api/redo': 'Redo one action.',
    'POST /api/reset': 'Clear the artwork and action history; keep sources by default. Use {keepSources:false} for a completely empty worktable.',
    'GET /api/project': 'Download the full portable project, including sources and action history.',
    'POST /api/project': 'Import a previously exported project. Every action is replayed and checked before the current worktable is replaced.',
    'GET /api/providers': 'List available provider connections without exposing API keys.',
    'POST /api/runs': 'Start an isolated blank experiment using a frozen copy of the current source inventory. Supply provider, model, prompt, and optional bounded run limits.',
    'GET /api/runs': 'List saved experiments and their progress.',
    'GET /api/runs/:id/events': 'Read observations, requests, returned model output, batch results and termination events.',
    'GET /api/runs/:id/export': 'Download the complete run bundle with deduplicated observation images and replayable project.',
    'GET /api/runs/:id/render.gif': 'Download playback from blank canvas through the saved cursor after a run ends. No query options. Also available for /api/archives/:id/render.gif.',
    'POST /api/runs/:id/stop': 'Cancel an experiment and retain its committed history.',
  },
  actions: [
    { type: 'cut', sourceId: 'source-id', polygon: [[20, 20], [200, 20], [200, 180], [20, 180]], pieceId: 'my-fragment' },
    { type: 'place', pieceId: 'my-fragment', x: 500, y: 600, rotation: 0, scale: 1 },
    { type: 'transform', pieceId: 'my-fragment', x: 520, y: 600, rotation: 30, scale: 0.8 },
    { type: 'reorder', pieceId: 'my-fragment', index: 0 },
    { type: 'remove', pieceId: 'my-fragment' },
    { type: 'describe', title: 'An original work', statement: 'What I found in these materials.' },
  ],
  restrictions: ['No generated pixels, color filters, text overlays, arbitrary image URLs, or non-uniform stretching.', 'No material reuse: two cuts from one source cannot overlap.', 'Use pieceId on cuts for predictable subsequent references; the response state also includes all piece IDs.'],
};

/** Construct the local app without binding a port (also used by integration tests). */
export async function createApp({ publicDir = join(ROOT, 'public'), dataDir = join(ROOT, '.data'), initialSources, persist = true, logger = console, providerRegistry = createProviderRegistry() } = {}) {
  const sessionPath = join(dataDir, 'session.json');
  let project;
  let states;
  if (persist) {
    try {
      const saved = JSON.parse(await readFile(sessionPath, 'utf8'));
      ({ project, states } = await validateProject(saved));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const backup = join(dataDir, `session-recovery-${Date.now()}.json`);
        await copyFile(sessionPath, backup).catch(() => {});
        logger.warn?.(`Saved work could not be opened. A recovery copy was kept at ${backup}. ${error.message}`);
      }
    }
  }
  if (!project) {
    const sources = initialSources || await loadDefaultSources(publicDir);
    project = makeProject(sources);
    states = reconstruct(project);
  }
  const runs = await createRunManager({ dataDir: join(dataDir, 'runs'), providerFactory: id => providerRegistry.capture(id) });
  const archives = createArchiveCatalog();
  const gifs = createGIFExporter();
  async function sendGIF(response, url, catalog, id) {
    if (url.searchParams.size) fail('GIF export uses the saved playback and does not accept query options.');
    const record = await catalog.get(id);
    if (record.status === 'running') fail('GIF export is available once this work ends.', 409);
    const controller = new AbortController();
    const abort = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', abort);
    try {
      const saved = await catalog.project(id);
      if (response.destroyed) controller.abort();
      const bytes = await gifs.render(saved, { signal: controller.signal });
      response.writeHead(200, {
        'Content-Type': 'image/gif', 'Content-Length': bytes.length, 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="offcut-${id}-playback.gif"`,
      });
      response.end(bytes);
    } finally { response.removeListener('close', abort); }
  }
  let mutationTail = Promise.resolve();
  let revision = randomUUID();
  const serialized = operation => {
    const next = mutationTail.then(operation);
    mutationTail = next.catch(() => {});
    return next;
  };
  async function commit(nextProject, nextStates) {
    nextProject.updatedAt = now();
    if (persist) {
      await mkdir(dataDir, { recursive: true });
      const temporary = join(dataDir, `.session-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(nextProject), { mode: 0o600 });
      await rename(temporary, sessionPath);
    }
    project = nextProject;
    states = nextStates;
    revision = randomUUID();
  }
  function envelope(step = project.cursor) {
    return { state: states[step], history: project.actions.map((record, index) => ({ index: index + 1, action: record.action, at: record.at })), cursor: step, liveCursor: project.cursor, canUndo: project.cursor > 0, canRedo: project.cursor < project.actions.length, revision };
  }
  function replayStep(url) {
    if (!url.searchParams.has('step')) return project.cursor;
    const raw = url.searchParams.get('step');
    if (!/^\d+$/.test(raw)) fail('Replay step must be a non-negative integer.');
    const step = Number(raw);
    if (step > project.actions.length) fail('That replay step does not exist.', 404);
    return step;
  }
  function checkOrigin(request, server) {
    const port = server.address()?.port;
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    if (!hosts.has(request.headers.host)) fail('This worktable only accepts local requests.', 403);
    if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) fail('Requests must come from this worktable.', 403);
    if (request.headers['sec-fetch-site'] === 'cross-site') fail('Requests must come from this worktable.', 403);
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      checkOrigin(request, server);
      const url = new URL(request.url, 'http://127.0.0.1');
      const path = url.pathname;
      if (request.method === 'GET' && path === '/api/providers') return sendJSON(response, 200, providerRegistry.list());
      const providerRoute = /^\/api\/providers\/(openai)(\/test)?$/.exec(path);
      if (providerRoute) {
        const id = providerRoute[1];
        if (request.method === 'DELETE' && !providerRoute[2]) return sendJSON(response, 200, providerRegistry.forget(id));
        if (request.method === 'POST') {
          const body = await readJSON(request);
          return sendJSON(response, 200, providerRoute[2] ? await providerRegistry.test(id) : providerRegistry.set(id, body));
        }
        fail('Method not allowed.', 405);
      }
      if (path === '/api/runs') {
        if (request.method === 'GET') return sendJSON(response, 200, { runs: await runs.list() });
        if (request.method === 'POST') {
          const spec = await readJSON(request);
          const run = await serialized(() => runs.start({ spec, sources: clone(project.sources) }));
          return sendJSON(response, 202, { run });
        }
        fail('Method not allowed.', 405);
      }
      if (path === '/api/archives') {
        if (request.method !== 'GET') fail('Method not allowed.', 405);
        return sendJSON(response, 200, { runs: await archives.list() });
      }
      if (path.startsWith('/api/archives/')) {
        const archiveRoute = /^\/api\/archives\/([a-zA-Z0-9_-]+)(?:\/(project|render\.png|render\.svg|render\.gif))?$/.exec(path);
        if (!archiveRoute) fail('Archived work not found.', 404);
        if (request.method !== 'GET') fail('Archived works are read-only.', 405);
        const [, id, resource] = archiveRoute;
        if (resource === 'render.gif') return await sendGIF(response, url, archives, id);
        let step;
        if (url.searchParams.has('step')) {
          const raw = url.searchParams.get('step');
          if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) fail('Replay step must be a non-negative integer.');
          step = Number(raw);
        }
        if (!resource) return sendJSON(response, 200, { run: await archives.get(id) });
        if (resource === 'project') {
          const value = await archives.project(id, { step });
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="offcut-${id}-project.json"`, 'Cache-Control': 'no-store' });
          return response.end(JSON.stringify(value, null, 2));
        }
        const state = await archives.state(id, { step });
        const png = resource === 'render.png';
        const rendered = png ? await renderPNG(state) : renderSVG(state);
        response.writeHead(200, { 'Content-Type': png ? 'image/png' : 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
        return response.end(rendered);
      }
      const runRoute = /^\/api\/runs\/([a-zA-Z0-9_-]+)(?:\/(events|project|export|render\.png|render\.svg|render\.gif|stop))?$/.exec(path);
      if (runRoute) {
        const [, id, resource] = runRoute;
        if (request.method === 'POST' && resource === 'stop') {
          await readJSON(request);
          return sendJSON(response, 200, { run: await runs.stop(id) });
        }
        if (request.method !== 'GET') fail('Method not allowed.', 405);
        if (resource === 'render.gif') return await sendGIF(response, url, runs, id);
        if (!resource) return sendJSON(response, 200, { run: await runs.get(id) });
        if (resource === 'events') return sendJSON(response, 200, { events: await runs.events(id) });
        let step;
        if (url.searchParams.has('step')) {
          const raw = url.searchParams.get('step');
          if (!/^\d+$/.test(raw)) fail('Replay step must be a non-negative integer.');
          step = Number(raw);
        }
        if (resource === 'project' || resource === 'export') {
          const value = resource === 'project' ? await runs.project(id, { step }) : await runs.bundle(id);
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="offcut-${id}-${resource}.json"`, 'Cache-Control': 'no-store' });
          return response.end(JSON.stringify(value, null, 2));
        }
        if (resource === 'render.png' || resource === 'render.svg') {
          const state = await runs.state(id, { step });
          const png = resource.endsWith('.png');
          const rendered = png ? await renderPNG(state) : renderSVG(state);
          response.writeHead(200, { 'Content-Type': png ? 'image/png' : 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
          return response.end(rendered);
        }
        fail('API endpoint not found.', 404);
      }
      if (request.method === 'GET' && (path === '/api/help' || path === '/api')) return sendJSON(response, 200, API_HELP);
      if (request.method === 'GET' && path === '/api/status') return sendJSON(response, 200, { revision, cursor: project.cursor, updatedAt: project.updatedAt });
      if (request.method === 'GET' && (path === '/api/state' || path === '/api/replay')) return sendJSON(response, 200, envelope(replayStep(url)));
      if (request.method === 'GET' && (path === '/api/render.svg' || path === '/api/render.png')) {
        const state = states[replayStep(url)];
        const png = path.endsWith('.png');
        const rendered = png ? await renderPNG(state) : renderSVG(state);
        response.writeHead(200, { 'Content-Type': png ? 'image/png' : 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
        return response.end(rendered);
      }
      if (request.method === 'GET' && path.startsWith('/api/sources/')) {
        const source = project.sources.find(source => source.id === decodeURIComponent(path.slice('/api/sources/'.length)));
        if (!source) fail('Source not found.', 404);
        const bytes = decodeRaster(source.dataUrl);
        response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        return response.end(bytes);
      }
      if (request.method === 'GET' && path === '/api/project') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="offcut-project.json"', 'Cache-Control': 'no-store' });
        return response.end(JSON.stringify(project, null, 2));
      }
      if (request.method === 'POST' && path.startsWith('/api/')) {
        const body = await readJSON(request);
        const result = await serialized(async () => {
          if (path === '/api/actions') {
            const actions = isObject(body) && Array.isArray(body.actions) ? body.actions : [body];
            if (actions.length < 1 || actions.length > 120) fail('Submit between 1 and 120 actions at a time.');
            const nextProject = clone(project);
            const nextStates = states.slice(0, project.cursor + 1);
            nextProject.actions = project.actions.slice(0, project.cursor);
            for (const action of actions) {
              if (!isObject(action)) fail('Each action must be an object.');
              nextStates.push(applyAction(nextStates.at(-1), action));
              nextProject.actions.push({ action: clone(action), at: now() });
            }
            nextProject.cursor = nextProject.actions.length;
            await commit(nextProject, nextStates);
          } else if (path === '/api/undo' || path === '/api/redo') {
            const delta = path.endsWith('/undo') ? -1 : 1;
            const cursor = project.cursor + delta;
            if (cursor < 0 || cursor > project.actions.length) fail(delta < 0 ? 'There is nothing to undo.' : 'There is nothing to redo.');
            await commit({ ...project, cursor }, states);
          } else if (path === '/api/sources') {
            if (project.sources.length >= MAX_SOURCES) fail(`A worktable can hold at most ${MAX_SOURCES} source images.`);
            const source = await normalizeSource(body);
            const sources = [...project.sources, source];
            validateInventory(sources);
            const nextProject = { ...project, sources };
            await commit(nextProject, reconstruct(nextProject));
          } else if (path === '/api/reset') {
            if (!isObject(body) || (body.keepSources !== undefined && typeof body.keepSources !== 'boolean')) fail('keepSources must be true or false.');
            const nextProject = makeProject(body.keepSources === false ? [] : project.sources, { rules: project.rules, canvas: project.canvas });
            await commit(nextProject, reconstruct(nextProject));
          } else if (path === '/api/project') {
            const validated = await validateProject(body);
            await commit(validated.project, validated.states);
          } else fail('API endpoint not found.', 404);
          return envelope();
        });
        return sendJSON(response, 200, result);
      }
      if (path.startsWith('/api/')) fail('API endpoint not found.', 404);
      if (!['GET', 'HEAD'].includes(request.method)) fail('Method not allowed.', 405);
      if (path === '/engine.mjs') {
        const bytes = await readFile(join(ROOT, 'lib', 'engine.mjs'));
        response.writeHead(200, { 'Content-Type': MIME['.mjs'], 'Content-Length': bytes.length, 'Cache-Control': 'no-cache' });
        return response.end(request.method === 'HEAD' ? undefined : bytes);
      }
      let decoded;
      try { decoded = decodeURIComponent(path); } catch { fail('Invalid URL.'); }
      if (decoded.split('/').some(part => part.startsWith('.')) || decoded.includes('\0')) fail('File not found.', 404);
      const base = await realpath(publicDir);
      const requested = resolve(base, `.${decoded === '/' ? '/index.html' : decoded}`);
      if (!requested.startsWith(base + sep)) fail('File not found.', 404);
      let file;
      try {
        file = await realpath(requested);
        if (!file.startsWith(base + sep) || !(await stat(file)).isFile()) fail('File not found.', 404);
      } catch (error) { if (error.status) throw error; fail('File not found.', 404); }
      const type = MIME[extname(file).toLowerCase()];
      if (!type) fail('File not found.', 404);
      const bytes = await readFile(file);
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'no-cache' });
      return response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) { response.end(); return; }
      const validationCodes = new Set(['ACTION_LIMIT', 'INVALID_ACTION', 'INVALID_POLYGON', 'INVALID_RULES', 'INVALID_SOURCE', 'MATERIAL_OVERLAP', 'PIECE_LIMIT']);
      const status = error.status || (validationCodes.has(error.code) ? 400 : 500);
      // Domain validation errors are safe, useful feedback for both humans and agents.
      if (status >= 500) logger.error?.(error);
      sendJSON(response, status, { error: status === 504 ? 'GIF export took too long. Try again.' : status >= 500 ? 'The worktable could not complete this request. Check the local server for details.' : error.message || 'The request could not be completed.' });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  let closing;
  return { server, getProject: () => clone(project), getState: () => clone(states[project.cursor]), close: () => {
    closing ??= (async () => {
      await runs.close();
      await gifs.close();
      if (server.listening) await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    })();
    return closing;
  } };
}

export async function startServer(options = {}) {
  const port = options.port ?? Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a valid port number.');
  const app = await createApp(options);
  await new Promise((resolveListen, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, '127.0.0.1', resolveListen);
  });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().then(app => {
    console.log(`Offcut is ready at http://127.0.0.1:${app.server.address().port}`);
    const shutdown = () => app.close().then(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
