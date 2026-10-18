import http from 'node:http';
import { readFile, writeFile, rename, mkdir, realpath, stat, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createState, applyAction, DEFAULT_RULES } from './lib/engine.mjs';
import { getSharp, renderSVG, renderPNG } from './lib/render.mjs';
import { createProviderRegistry } from './lib/providers.mjs';
import { createRunManager } from './lib/runs.mjs';
import { createBatchManager } from './lib/batches.mjs';
import { createArchiveCatalog } from './lib/archives.mjs';
import { createGIFExporter } from './lib/gif.mjs';
import { createMaterialCatalog } from './lib/material-catalog.mjs';
import { acquireDataRoot, resolveDataRoot } from './lib/data-root.mjs';
import { normalizeMaterialSelection, drawMaterialIds } from './public/material-selection.mjs';
import { createCampaignManager } from './lib/study-budget.mjs';
import { createStudyStore } from './lib/study-store.mjs';
import { createStudyManager } from './lib/studies.mjs';
import { createStudyAnnotationStore } from './lib/study-annotations.mjs';
import { listRateBooks, listRateSnapshots } from './lib/model-rates.mjs';
import { buildQualificationReport } from './lib/provider-qualification.mjs';

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
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const canonicalJSON = value => JSON.stringify(value, (_, item) => isObject(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
  : item);

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
  if (initial.rules.maxActions > 240 || initial.rules.maxPieces > 64 || initial.rules.maxVertices > DEFAULT_RULES.maxVertices || initial.rules.maxScale > 10 || initial.rules.minScale < 0.01 || initial.rules.minArea < 1) fail(`These project rules exceed the worktable limits (240 actions, 64 pieces, ${DEFAULT_RULES.maxVertices} vertices, scale 0.01–10, and minimum area 1).`);
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
  description: 'Invent a work using only existing source pixels. Source cuts may not overlap; removed and retired pieces still reserve source material. Trim a fragment like physical paper: selected material stays in place and every offcut remains usable in the tray. Inspect your work with /api/render.png, then revise it.',
  coordinates: 'Cuts and trims use original source-image pixels. Placement x/y is the center of the cropped fragment on the canvas; rotation is degrees clockwise. Scale is uniform. Piece order is back to front, including hidden and retired pieces. Trim preserves retained pixels in place by adjusting the bounding-box center, which may then fall outside the canvas.',
  routes: {
    'GET /api/state': 'Current state, history, cursor, and undo/redo availability. Add ?step=N to inspect the state after N actions (0 is an empty canvas). Reading a past step does not move the live cursor.',
    'GET /api/status': 'Lightweight polling endpoint: {revision,cursor,updatedAt}. Fetch /api/state only when its revision changes.',
    'GET /api/sources/:id': 'Read an original source image.',
    'GET /api/source-catalog': 'Browse compact metadata from the studio and the larger collected library, with a snapshot hash, exact source-byte hashes, thumbnail/full-image URLs and per-run limits. Image bytes are not embedded.',
    'GET /api/materials/:id': 'Read one full image from the combined catalog. Add /thumbnail for a small preview. Catalog images do not consume studio inventory slots.',
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
    'GET /api/study-rates': 'List reviewed server-owned model-rate and request-estimator snapshots. Browser requests cannot override these rules.',
    'GET /api/study-qualifications': 'Build a credential-free route compatibility report from completed calibration runs and settled usage. No provider call is made.',
    'POST /api/campaigns': 'Create an immutable shared Study allowance with {clientRequestId,limitMicros,rateBookId}. Amounts are integer USD microdollars.',
    'GET /api/campaigns': 'List safe Study allowance summaries with accounted, reserved, uncertain, and available amounts.',
    'GET /api/campaigns/:id': 'Inspect one Study allowance and its reviewed provider rate book.',
    'POST /api/campaigns/:id/reconcile': 'Resolve one uncertain dispatched reservation after checking billing, using {clientRequestId,reservationId,chargeMicros,evidenceNote}.',
    'POST /api/studies/preview': 'Validate and expand a Study draft without freezing sources, creating records, connecting a provider, or spending money.',
    'POST /api/studies': 'Freeze a reviewed Study plan and its exact source bytes with {clientRequestId,draft,campaignId}. This does not start inference.',
    'GET /api/studies': 'List frozen Study records and their safe progress summaries.',
    'GET /api/studies/:id': 'Inspect one immutable Study manifest and current state.',
    'GET /api/studies/:id/annotations': 'Read the blinded, opaque annotation slots and saved annotation versions for a Study.',
    'POST /api/studies/:id/annotations': 'Append one stage-separated researcher annotation. Supply displayId and expectedRevision; stale revisions return 409.',
    'GET /api/studies/:id/review': 'List opaque review cards without cell, model, source, run, or status identity fields.',
    'GET /api/studies/:id/review/:displayId': 'Read one stage-gated review card. Identity and status fields appear only after the corresponding reveal stage is saved.',
    'GET /api/studies/:id/review/:displayId/image': 'Read a final image through an opaque display ID.',
    'GET /api/studies/:id/review/:displayId/sources/:index': 'Read a frozen source through an opaque display ID after sources are revealed.',
    'GET /api/studies/:id/review/:displayId/trace': 'Read requested/returned model and cell status through an opaque display ID after trace is revealed.',
    'GET /api/studies/:id/sources/:sourceId': 'Read source bytes frozen into one Study manifest.',
    'POST /api/studies/:id/start': 'Start a ready frozen Study with {clientRequestId,manifestHash} after admission checks.',
    'POST /api/studies/:id/pause': 'Finish the current cell, then pause before launching another.',
    'POST /api/studies/:id/resume': 'Explicitly resume a paused Study with {clientRequestId,manifestHash}. Restart never auto-resumes.',
    'POST /api/studies/:id/stop': 'Cancel the active child immediately and mark unstarted cells not_run.',
    'POST /api/studies/:id/close': 'Close a paused Study and retain all cells, marking queued cells not_run.',
    'POST /api/runs': 'Start an isolated blank run. Supply provider, model, prompt and bounded limits. sourceIds chooses 1–24 images from the combined catalog in exact order, with matching sourceHashes. Optional materialSelection records pinned IDs, a deterministic random count/seed, candidate IDs, algorithm and reviewed catalog snapshot; it must reproduce the submitted sourceIds. Omitted sourceIds uses the studio inventory. UUID clientRequestId durably deduplicates identical launches, including after restart or catalog changes; changed settings with that identifier return 409.',
    'GET /api/runs': 'List saved experiments and their progress.',
    'GET /api/runs/:id/events': 'Read observations, requests, returned model output, batch results and termination events.',
    'GET /api/runs/:id/export': 'Download the complete run bundle with deduplicated observation images and replayable project.',
    'GET /api/runs/:id/render.gif': 'Download playback from blank canvas through the saved cursor after a run ends. No query options. Also available for /api/archives/:id/render.gif.',
    'POST /api/runs/:id/stop': 'Cancel an experiment and retain its committed history.',
    'POST /api/batches': 'Start a reviewed sequential batch: clientRequestId, shared spec, model/count groups, explore or compare mode, same/random/pinned-random materials, and the reviewed materialSelection/sourceIds/sourceHashes. Up to 8 model groups and 50 total runs. Compare shares draws by run number across groups; Explore draws independently. All planned images are frozen before the first call.',
    'GET /api/batches': 'List saved batch summaries and launch receipts.',
    'GET /api/batches/:id': 'Inspect the frozen plan, groups, per-run draws and outcomes.',
    'GET /api/batches/:id/sources/:sourceId': 'Read a frozen source from the batch, even after the discovery catalog changes.',
    'POST /api/batches/:id/stop': 'Stop the active child and leave remaining entries unstarted. Batches never resume model calls automatically after restart.',
  },
  actions: [
    { type: 'cut', sourceId: 'source-id', polygon: [[20, 20], [200, 20], [200, 180], [20, 180]], pieceId: 'my-fragment' },
    { type: 'place', pieceId: 'my-fragment', x: 500, y: 600, rotation: 0, scale: 1 },
    { type: 'transform', pieceId: 'my-fragment', x: 520, y: 600, rotation: 30, scale: 0.8 },
    { type: 'reorder', pieceId: 'my-fragment', index: 0 },
    { type: 'remove', pieceId: 'my-fragment' },
    { type: 'trim', pieceId: 'my-fragment', newPieceId: 'smaller-fragment', polygon: [[30, 30], [190, 30], [190, 160], [30, 160]] },
    { type: 'describe', title: 'An original work', statement: 'What I found in these materials.' },
  ],
  restrictions: ['No generated pixels, color filters, text overlays, arbitrary image URLs, or non-uniform stretching.', 'No material reuse: two source cuts cannot overlap, including hidden and retired fragments.', 'Trim intersects its polygon mask with the actual parent material. It must keep and separate some material; extending the mask beyond the parent or across holes cannot add pixels. The mask follows the source polygon rules.', 'Every connected retained region and offcut becomes a separate usable child, including small scraps. Retained children inherit visibility, placement, and layer; offcuts start hidden in the tray. Each piece has an outer polygon and optional holes in original source coordinates.', 'Trim costs one action. Every usable child counts toward maxPieces; retired parents remain in history but do not count. Removing a piece does not free a slot. If all children cannot fit the piece limit, or exceed the 8192 generated-vertex safety limit, the entire action is rejected.', 'Parents record supersededBy and childPieceIds and cannot be used again. Children record parentPieceId and trimRole (retained or offcut).', 'Use pieceId on cuts and a required unique newPieceId on trims. That ID identifies the first retained component; other children get deterministic piece-N IDs listed in the response state.'],
};

/** Construct the local app without binding a port (also used by integration tests). */
export async function createApp({ publicDir = join(ROOT, 'public'), dataDir, initialSources, persist = true, logger = console, providerRegistry = createProviderRegistry() } = {}) {
  dataDir = resolveDataRoot({ dataDir, fallback: join(ROOT, '.data') });
  const dataRoot = await acquireDataRoot(dataDir);
  let runs;
  let batches;
  let gifs;
  let campaigns;
  let studyStore;
  let annotationStore;
  let studies;
  try {
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
  campaigns = await createCampaignManager({ dataDir: join(dataDir, 'campaigns') });
  runs = await createRunManager({ dataDir: join(dataDir, 'runs'), providerFactory: id => providerRegistry.capture(id) });
  const materials = createMaterialCatalog({ directory: join(dataDir, 'source-library') });
  studyStore = await createStudyStore({ dataDir: join(dataDir, 'studies'), materials, getInventory: () => clone(project.sources), campaigns, providerProtocols: ids => providerRegistry.protocols(ids) });
  annotationStore = await createStudyAnnotationStore({ dataDir: join(dataDir, 'annotations'), studyStore, runs });
  batches = await createBatchManager({ dataDir: join(dataDir, 'batches'), runs, materials, getInventory: () => clone(project.sources), providerFactory: id => providerRegistry.capture(id) });
  studies = await createStudyManager({
    store: studyStore, runs, campaigns,
    admission: { review() {
      if (batches.hasActive() || runs.list().some(run => run.status === 'running')) fail('Another launch is active. Wait for it to finish or stop it before starting a Study.', 409);
    } },
  });
  const archives = createArchiveCatalog();
  gifs = createGIFExporter();
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
      if (request.method === 'GET' && path === '/api/study-rates') return sendJSON(response, 200, { defaultLimitMicros: 50_000_000, rateBooks: listRateBooks(), rateSnapshots: listRateSnapshots() });
      if (request.method === 'GET' && path === '/api/study-qualifications') return sendJSON(response, 200, { qualifications: buildQualificationReport({ studies: studyStore, runs, campaigns, rateSnapshots: listRateSnapshots() }) });
      if (path === '/api/campaigns') {
        if (request.method === 'GET') return sendJSON(response, 200, { campaigns: campaigns.list() });
        if (request.method === 'POST') {
          const result = await campaigns.create(await readJSON(request));
          return sendJSON(response, result.created ? 201 : 200, { campaign: result.campaign });
        }
        fail('Method not allowed.', 405);
      }
      if (path.startsWith('/api/campaigns/')) {
        const campaignRoute = /^\/api\/campaigns\/(campaign-[a-f0-9-]{36})(?:\/(reconcile))?$/.exec(path);
        if (!campaignRoute) fail('Campaign not found.', 404);
        const [, id, action] = campaignRoute;
        if (action === 'reconcile') {
          if (request.method !== 'POST') fail('Method not allowed.', 405);
          return sendJSON(response, 200, { campaign: await campaigns.reconcile(id, await readJSON(request)) });
        }
        if (request.method !== 'GET') fail('Method not allowed.', 405);
        return sendJSON(response, 200, { campaign: campaigns.get(id) });
      }
      if (path === '/api/studies/preview') {
        if (request.method !== 'POST') fail('Method not allowed.', 405);
        const body = await readJSON(request);
        if (!isObject(body) || Reflect.ownKeys(body).length !== 1 || !Object.hasOwn(body, 'draft')) fail('Study preview requires only a draft.');
        return sendJSON(response, 200, { preview: await studyStore.preview(body.draft) });
      }
      if (path === '/api/studies') {
        if (request.method === 'GET') return sendJSON(response, 200, { studies: studyStore.list() });
        if (request.method === 'POST') {
          const result = await studyStore.create(await readJSON(request));
          studies.register(result.study.id);
          return sendJSON(response, result.created ? 201 : 200, { study: result.study });
        }
        fail('Method not allowed.', 405);
      }
      const annotationRoute = /^\/api\/studies\/(study-[a-f0-9-]{36})\/annotations$/.exec(path);
      if (annotationRoute) {
        const [, id] = annotationRoute;
        if (request.method === 'GET') return sendJSON(response, 200, { annotations: await annotationStore.get(id) });
        if (request.method === 'POST') {
          const body = await readJSON(request);
          const annotation = await serialized(() => annotationStore.annotate(id, body));
          return sendJSON(response, 201, annotation);
        }
        fail('Method not allowed.', 405);
      }
      const reviewListRoute = /^\/api\/studies\/(study-[a-f0-9-]{36})\/review$/.exec(path);
      if (reviewListRoute) {
        if (request.method !== 'GET') fail('Method not allowed.', 405);
        return sendJSON(response, 200, { review: await annotationStore.reviewList(reviewListRoute[1]) });
      }
      const reviewRoute = /^\/api\/studies\/(study-[a-f0-9-]{36})\/review\/(view-[a-z0-9-]{20,80})(?:(\/image)|(\/trace)|(\/sources\/(\d+)))?$/.exec(path);
      if (reviewRoute) {
        if (request.method !== 'GET') fail('Method not allowed.', 405);
        const [, id, displayId, image, trace, sourcePath, sourceIndex] = reviewRoute;
        if (image) {
          const rendered = await renderPNG(await annotationStore.reviewImage(id, displayId));
          response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
          return response.end(rendered);
        }
        if (sourcePath) {
          const { bytes, mime } = await annotationStore.reviewSource(id, displayId, Number(sourceIndex), Number(url.searchParams.get('stage')));
          response.writeHead(200, { 'Content-Type': mime, 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
          return response.end(bytes);
        }
        const requestedStage = url.searchParams.has('stage') ? Number(url.searchParams.get('stage')) : undefined;
        const result = await annotationStore.review(id, displayId, requestedStage);
        if (trace && !result.trace) fail('Trace is unavailable until trace is revealed.', 409, 'REVIEW_STAGE_CONFLICT');
        return sendJSON(response, 200, trace ? { trace: result.trace } : { review: result });
      }
      if (path.startsWith('/api/studies/')) {
        const studyRoute = /^\/api\/studies\/(study-[a-f0-9-]{36})(?:(?:\/sources\/([a-zA-Z0-9_-]{1,100}))|\/(start|pause|resume|stop|close))?$/.exec(path);
        if (!studyRoute) fail('Study not found.', 404);
        const [, id, sourceId, action] = studyRoute;
        if (action) {
          if (request.method !== 'POST') fail('Method not allowed.', 405);
          const body = await readJSON(request);
          const state = await serialized(() => studies[action](id, body));
          return sendJSON(response, 200, { study: { ...studyStore.get(id), state } });
        }
        if (request.method !== 'GET') fail('Method not allowed.', 405);
        if (sourceId) {
          const { bytes, mime } = await studyStore.asset(id, sourceId);
          response.writeHead(200, { 'Content-Type': mime, 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
          return response.end(bytes);
        }
        return sendJSON(response, 200, { study: studyStore.get(id) });
      }
      if (request.method === 'GET' && path === '/api/providers') return sendJSON(response, 200, providerRegistry.list());
      if (request.method === 'GET' && path === '/api/source-catalog') {
        const catalog = await materials.list(project.sources);
        return sendJSON(response, 200, { ...catalog, limits: { maxSources: MAX_SOURCES, maxSourceBytes: MAX_INVENTORY_BYTES, uploadSlots: MAX_SOURCES - project.sources.length } });
      }
      const materialRoute = /^\/api\/materials\/([a-zA-Z0-9_-]{1,100})(\/thumbnail)?$/.exec(path);
      if (materialRoute) {
        if (request.method !== 'GET') fail('Method not allowed.', 405);
        const { bytes, mime } = await materials.image(project.sources, materialRoute[1], { thumbnail: Boolean(materialRoute[2]) });
        response.writeHead(200, { 'Content-Type': mime, 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
        return response.end(bytes);
      }
      const providerRoute = /^\/api\/providers\/([a-z][a-z0-9-]{0,39})(\/test)?$/.exec(path);
      if (providerRoute) {
        const id = providerRoute[1];
        if (request.method === 'DELETE' && !providerRoute[2]) return sendJSON(response, 200, providerRegistry.forget(id));
        if (request.method === 'POST') {
          const body = await readJSON(request);
          return sendJSON(response, 200, providerRoute[2] ? await providerRegistry.test(id) : providerRegistry.set(id, body));
        }
        fail('Method not allowed.', 405);
      }
      if (path === '/api/batches') {
        if (request.method === 'GET') return sendJSON(response, 200, { batches: await batches.list() });
        if (request.method === 'POST') {
          const body = await readJSON(request);
          const batch = await serialized(() => {
            if (studies.hasActive()) fail('A Study is active. Pause, stop, or finish it before starting a batch.', 409);
            return batches.start(body);
          });
          return sendJSON(response, 202, { batch });
        }
        fail('Method not allowed.', 405);
      }
      if (path.startsWith('/api/batches/')) {
        const batchRoute = /^\/api\/batches\/([a-zA-Z0-9_-]+)(?:\/(stop)|\/sources\/([a-zA-Z0-9_-]{1,100}))?$/.exec(path);
        if (!batchRoute) fail('Batch not found.', 404);
        const [, id, stop, sourceId] = batchRoute;
        if (stop) {
          if (request.method !== 'POST') fail('Method not allowed.', 405);
          await readJSON(request);
          return sendJSON(response, 200, { batch: await batches.stop(id) });
        }
        if (request.method !== 'GET') fail('Method not allowed.', 405);
        if (sourceId) {
          const { bytes, mime } = await batches.asset(id, sourceId);
          response.writeHead(200, { 'Content-Type': mime, 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
          return response.end(bytes);
        }
        return sendJSON(response, 200, { batch: await batches.get(id) });
      }
      if (path === '/api/runs') {
        if (request.method === 'GET') return sendJSON(response, 200, { runs: await runs.list() });
        if (request.method === 'POST') {
          const body = await readJSON(request);
          if (!isObject(body)) fail('A run spec is required.');
          const { sourceIds, sourceHashes, clientRequestId, materialSelection, study, ...spec } = body;
          if (study !== undefined) fail('Study provenance cannot be supplied through the run API.');
          if (clientRequestId !== undefined && (typeof clientRequestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(clientRequestId))) fail('clientRequestId must be a UUID.');
          const requestFingerprint = clientRequestId === undefined ? null : sha256(canonicalJSON(body));
          const run = await serialized(async () => {
            if (clientRequestId !== undefined) {
              const existing = (await runs.list()).find(run => run.launch?.clientRequestId === clientRequestId);
              if (existing) {
                if (existing.launch.requestFingerprint !== requestFingerprint) fail('This launch identifier was already used with different settings. Start a new run to change them.', 409);
                return existing;
              }
            }
            if (batches.hasActive()) fail('A batch is running. Stop it or wait for it to finish before starting another run.', 409);
            if (studies.hasActive()) fail('A Study is active. Pause, stop, or finish it before starting another run.', 409);
            let recordedSelection;
            if (materialSelection !== undefined) {
              const recipe = normalizeMaterialSelection(materialSelection);
              if (JSON.stringify(drawMaterialIds(recipe)) !== JSON.stringify(sourceIds)) fail('The images do not match the reviewed draw. Review your materials before starting.');
              const catalog = await materials.list(project.sources);
              if (recipe.catalogSnapshot !== catalog.snapshot) fail('The collection changed. Refresh the materials and review your selection.', 409);
              const available = new Map(catalog.sources.map(source => [source.id, source]));
              if ([...recipe.candidateIds, ...recipe.pinnedIds].some(id => !available.has(id))) fail('An image in the selection pool is no longer available. Refresh your materials.', 409);
              recordedSelection = { ...recipe, candidateManifest: recipe.candidateIds.map(id => ({ id, sha256: available.get(id).sha256 })) };
            }
            if (sourceIds === undefined && sourceHashes !== undefined) fail('Choose source images before supplying their hashes.');
            const sources = sourceIds === undefined ? clone(project.sources) : await materials.resolve(project.sources, sourceIds, sourceHashes, { snapshot: recordedSelection?.catalogSnapshot });
            const launch = clientRequestId === undefined ? undefined : { clientRequestId, requestFingerprint };
            return runs.start({ spec, sources, launch, ...(recordedSelection ? { materialSelection: recordedSelection } : {}) });
          });
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
      if (path === '/engine.mjs' || path === '/vendor/polyclip.mjs') {
        const bytes = await readFile(join(ROOT, 'lib', path === '/engine.mjs' ? 'engine.mjs' : 'vendor/polyclip.mjs'));
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
      const validationCodes = new Set(['ACTION_LIMIT', 'INVALID_ACTION', 'INVALID_POLYGON', 'INVALID_RULES', 'INVALID_SOURCE', 'MATERIAL_OVERLAP', 'MATERIAL_EXPANSION', 'PIECE_LIMIT', 'PIECE_RETIRED', 'GEOMETRY_LIMIT']);
      const status = error.status || (validationCodes.has(error.code) ? 400 : 500);
      // Domain validation errors are safe, useful feedback for both humans and agents.
      if (status >= 500) logger.error?.(error);
      sendJSON(response, status, { error: status === 504 ? 'GIF export took too long. Try again.' : status >= 500 && error.code !== 'MATERIAL_CATALOG_INVALID' ? 'The worktable could not complete this request. Check the local server for details.' : error.message || 'The request could not be completed.', ...(typeof error.code === 'string' ? { code: error.code } : {}) });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  let closing;
  return { server, dataDir, getProject: () => clone(project), getState: () => clone(states[project.cursor]), close: () => {
    closing ??= (async () => {
      let failure;
      for (const operation of [
        () => studies.closeAll(),
        () => batches.close(),
        () => runs.close(),
        () => gifs.close(),
        () => server.listening ? new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())) : undefined,
      ]) {
        try { await operation(); } catch (error) { failure ??= error; }
      }
      try { await dataRoot.release(); } catch (error) { failure ??= error; }
      if (failure) throw failure;
    })();
    return closing;
  } };
  } catch (error) {
    await studies?.closeAll().catch(() => {});
    await batches?.close().catch(() => {});
    await runs?.close().catch(() => {});
    await gifs?.close().catch(() => {});
    await dataRoot.release().catch(releaseError => { error.releaseError = releaseError; });
    throw error;
  }
}

export async function startServer(options = {}) {
  const port = options.port ?? Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a valid port number.');
  const dataDir = resolveDataRoot({ dataDir: options.dataDir, environmentDataDir: process.env.OFFCUT_DATA_DIR, fallback: join(ROOT, '.data') });
  const app = await createApp({ ...options, dataDir });
  try {
    await new Promise((resolveListen, reject) => {
      app.server.once('error', reject);
      app.server.listen(port, '127.0.0.1', resolveListen);
    });
    return app;
  } catch (error) {
    await app.close().catch(closeError => { error.closeError = closeError; });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().then(app => {
    console.log(`Offcut data: ${app.dataDir}`);
    console.log(`Offcut is ready at http://127.0.0.1:${app.server.address().port}`);
    const shutdown = () => app.close().then(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
