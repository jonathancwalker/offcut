import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchiveCatalog } from '../lib/archives.mjs';
import { getSharp, renderPNG } from '../lib/render.mjs';
import { startServer } from '../server.mjs';

const archiveFile = number => new URL(`../experiments/${number}/final-project.json`, import.meta.url);
const readProject = async number => JSON.parse(await readFile(archiveFile(number), 'utf8'));

test('archive summaries preserve honest provenance and never invent model metadata', async () => {
  const archives = createArchiveCatalog();
  const summaries = await archives.list();
  assert.deepEqual(summaries.map(record => record.id), ['archive-003', 'archive-002', 'archive-001']);
  for (const summary of summaries) {
    assert.equal(summary.recordType, 'archive');
    assert.equal(summary.status, 'archived');
    assert.equal(summary.spec.model, null);
    assert.equal(summary.spec.provider, null);
    for (const field of ['maxTurns', 'maxMinutes', 'maxOutputTokens']) assert.ok(!Object.hasOwn(summary.spec, field));
    assert.match(summary.provenance, /exact model identifier was not recorded/i);
    assert.ok(summary.sourceManifest.every(source => !Object.hasOwn(source, 'dataUrl')));
    assert.ok(!Object.hasOwn(summary, 'usage'));
    assert.ok(!Object.hasOwn(summary, 'turns'));
  }
  const first = summaries.find(record => record.id === 'archive-001');
  const second = summaries.find(record => record.id === 'archive-002');
  const third = summaries.find(record => record.id === 'archive-003');
  assert.deepEqual(first.spec, { model: null, provider: null });
  assert.deepEqual(second.spec, { model: null, provider: null });
  assert.equal(first.acceptedActions, 53);
  assert.equal(first.startingActions, 5);
  assert.match(first.provenance, /5 human actions followed by 48 agent actions/);
  assert.equal(second.acceptedActions, 32);
  assert.equal(second.startingActions, 0);
  assert.match(second.provenance, /blank canvas without prior conversation context/);
  assert.equal(third.startingActions, 0);
  assert.equal(third.sourceManifest.length, 6);
  assert.deepEqual(third.spec, { model: null, provider: null, maxPieces: 24, maxActions: 120 });
  assert.match(third.provenance, /fresh Codex subagent.*without prior conversation context/);
  assert.match(third.provenance, /uniformly at random without replacement/);
  assert.match(third.provenance, /batches were not model turns/);
  first.spec.model = 'not-actually-recorded';
  first.sourceManifest[0].name = 'Changed by caller';
  const reread = await archives.get('archive-001');
  assert.equal(reread.spec.model, null);
  assert.notEqual(reread.sourceManifest[0].name, 'Changed by caller');
  assert.ok(reread.state.sources.every(source => !Object.hasOwn(source, 'dataUrl')));
  const independentCatalog = createArchiveCatalog();
  assert.equal((await independentCatalog.get('archive-001')).revision, reread.revision);
});

test('archived project and replay reproduce the preserved work without changing it', async () => {
  const archives = createArchiveCatalog();
  for (const [number, image] of [['001', 'the-migratory-city.png'], ['002', 'artwork.png']]) {
    const id = `archive-${number}`;
    const originalBytes = await readFile(archiveFile(number));
    const original = JSON.parse(originalBytes);
    assert.deepEqual(await archives.project(id), original);
    assert.equal((await archives.get(id)).createdAt, original.createdAt);
    assert.equal((await archives.state(id, { step: 0 })).pieces.length, 0);
    assert.equal((await archives.state(id, { step: 1 })).pieces[0].visible, false);
    assert.equal((await archives.state(id, { step: 2 })).pieces[0].visible, true);
    const state = await archives.state(id);
    const preservedPNG = await readFile(new URL(`../experiments/${number}/${image}`, import.meta.url));
    assert.deepEqual(await renderPNG(state), preservedPNG);
    const early = await archives.project(id, { step: 1 });
    assert.equal(early.cursor, 1);
    assert.deepEqual(early.actions, original.actions);
    early.actions[0].action.type = 'not-an-action';
    assert.deepEqual(await archives.project(id), original);
    assert.deepEqual(await readFile(archiveFile(number)), originalBytes);
  }
});

test('random-six archive preserves its selected sources and reproduces the saved image exactly', async () => {
  const archives = createArchiveCatalog();
  const initial = JSON.parse(await readFile(new URL('../experiments/003/initial-project.json', import.meta.url), 'utf8'));
  const originalBytes = await readFile(archiveFile('003'));
  const original = JSON.parse(originalBytes);
  assert.equal(initial.cursor, 0);
  assert.equal(initial.actions.length, 0);
  assert.equal(initial.sources.length, 6);
  assert.equal(new Set(initial.sources.map(source => source.id)).size, 6);
  assert.deepEqual(original.sources, initial.sources);
  assert.deepEqual(original.rules, initial.rules);
  assert.deepEqual(original.canvas, initial.canvas);
  assert.deepEqual(await archives.project('archive-003'), original);

  const blank = await archives.state('archive-003', { step: 0 });
  const final = await archives.state('archive-003');
  assert.equal(blank.pieces.length, 0);
  assert.deepEqual(final.sources, blank.sources);
  assert.deepEqual(final.sources, initial.sources);
  assert.equal(final.rules.maxPieces, 24);
  assert.equal(final.rules.maxActions, 120);
  assert.ok(final.pieces.length <= 24);
  assert.ok(original.cursor <= 120);
  const preservedPNG = await readFile(new URL('../experiments/003/artwork.png', import.meta.url));
  assert.deepEqual(await renderPNG(final), preservedPNG);
  assert.deepEqual(await readFile(archiveFile('003')), originalBytes);
});

test('archived playback respects the saved cursor while the portable project retains full history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offcut-archive-cursor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, '002'));
  const project = await readProject('002');
  project.cursor = 1;
  await writeFile(join(directory, '002', 'final-project.json'), JSON.stringify(project));
  const archives = createArchiveCatalog({ directory });
  const record = await archives.get('archive-002');
  assert.equal(record.acceptedActions, 1);
  assert.equal(record.title, 'Untitled composition');
  assert.equal(record.state.pieces.length, 1);
  assert.equal(record.state.pieces[0].visible, false);
  const exported = await archives.project('archive-002');
  assert.equal(exported.cursor, 1);
  assert.equal(exported.actions.length, 32);
  await assert.rejects(archives.state('archive-002', { step: 2 }), { status: 404 });
  await assert.rejects(archives.project('archive-002', { step: -1 }), { status: 400 });
  await assert.rejects(archives.get('../001'), { status: 404 });
  await assert.rejects(archives.get('toString'), { status: 404 });
});

test('archive API is read-only, allowlisted, and validates replay queries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offcut-archive-api-'));
  const app = await startServer({ port: 0, dataDir: directory, persist: false, initialSources: [] });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const before = app.getProject();
  const summaries = await (await fetch(`${base}/api/archives`)).json();
  assert.equal(summaries.runs.length, 3);
  const detail = await (await fetch(`${base}/api/archives/archive-001`)).json();
  assert.equal(detail.run.acceptedActions, 53);
  assert.equal(detail.run.state.pieces.length, 12);
  const projectResponse = await fetch(`${base}/api/archives/archive-002/project?step=1`);
  assert.equal(projectResponse.status, 200);
  assert.match(projectResponse.headers.get('content-disposition'), /offcut-archive-002-project.json/);
  const project = await projectResponse.json();
  assert.equal(project.cursor, 1);
  assert.equal(project.actions.length, 32);
  const blank = await fetch(`${base}/api/archives/archive-001/render.svg?step=0`);
  assert.equal(blank.status, 200);
  assert.ok(!(await blank.text()).includes('<image'));
  const png = await fetch(`${base}/api/archives/archive-002/render.png?step=2`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await png.arrayBuffer()), await renderPNG(await createArchiveCatalog().state('archive-002', { step: 2 })));
  for (const step of ['-1', '1.5', 'nope', '', '9007199254740993']) {
    const response = await fetch(`${base}/api/archives/archive-001/render.png?step=${step}`);
    assert.equal(response.status, 400, step);
    assert.match((await response.json()).error, /non-negative integer/);
  }
  assert.equal((await fetch(`${base}/api/archives/archive-001/render.png?step=54`)).status, 404);
  for (const path of ['archive-999', 'toString', 'archive-001/events', 'archive-001/stop', '%2e%2e%2f001/project']) {
    assert.equal((await fetch(`${base}/api/archives/${path}`)).status, 404, path);
  }
  for (const path of ['', '/archive-001', '/archive-001/project']) {
    const response = await fetch(`${base}/api/archives${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 405, path);
  }
  for (const query of ['step=0', 'step=-1', 'step=', 'step=1&step=2', 'width=5000', 'speed=2', 'unknown=1']) {
    const response = await fetch(`${base}/api/archives/archive-001/render.gif?${query}`);
    assert.equal(response.status, 400, query);
    assert.match((await response.json()).error, /does not accept query options/);
  }
  assert.equal((await fetch(`${base}/api/archives/archive-999/render.gif`)).status, 404);
  assert.equal((await fetch(`${base}/api/runs/missing/render.gif`)).status, 404);
  assert.equal((await fetch(`${base}/api/archives/archive-001/render.gif`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/runs/missing/render.gif`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/archives/archive-001/render.gif`, { headers: { Origin: 'https://external.invalid' } })).status, 403);
  assert.deepEqual(app.getProject(), before);
});

test('all archived works export every recorded action without changing their saved data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offcut-archive-gif-'));
  const app = await startServer({ port: 0, dataDir: directory, persist: false, initialSources: [] });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const studio = app.getProject();
  for (const number of ['001', '002', '003']) {
    const before = await readFile(archiveFile(number));
    const project = JSON.parse(before);
    const response = await fetch(`${base}/api/archives/archive-${number}/render.gif`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/gif');
    assert.match(response.headers.get('content-disposition'), new RegExp(`offcut-archive-${number}-playback.gif`));
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(Number(response.headers.get('content-length')), bytes.length);
    const metadata = await getSharp()(bytes).metadata();
    assert.equal(metadata.pages, project.cursor + 1);
    assert.equal(metadata.width, 533);
    assert.equal(metadata.height, 640);
    assert.equal(metadata.loop, 0);
    assert.deepEqual(metadata.delay, [...Array(project.cursor).fill(650), 2500]);
    const blank = await getSharp()(bytes, { page: 0 }).removeAlpha().raw().toBuffer();
    assert.ok(blank.every((value, index) => Math.abs(value - blank[index % 3]) <= 1));
    const last = await getSharp()(bytes, { page: project.cursor }).removeAlpha().raw().toBuffer();
    assert.notDeepEqual(last, blank);
    assert.deepEqual(await readFile(archiveFile(number)), before);
    assert.deepEqual(await (await fetch(`${base}/api/archives/archive-${number}/project`)).json(), project);
  }
  assert.deepEqual(app.getProject(), studio);
});
