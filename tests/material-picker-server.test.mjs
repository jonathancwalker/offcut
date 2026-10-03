import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { startServer } from '../server.mjs';
import { createProviderRegistry } from '../lib/providers.mjs';
import { getSharp } from '../lib/render.mjs';
import { drawMaterialIds, normalizeMaterialSelection } from '../public/material-selection.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const spec = { provider: 'openai', model: 'fixture-vision', prompt: 'Make a work.', maxTurns: 2, maxActions: 10, maxPieces: 4, maxOutputTokens: 512, maxMinutes: 1 };
const completed = () => Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ decision_note: 'Finished.', actions: [], done: true }) }] }] });

async function fixture(t, count = 32) {
  const directory = await mkdtemp(join(tmpdir(), 'offcut-picker-api-'));
  const library = join(directory, 'source-library');
  await mkdir(join(library, 'assets'), { recursive: true });
  const records = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const width = 384 + index, height = 256;
    const bytes = await getSharp()({ create: { width, height, channels: 3, background: { r: (index * 53) % 256, g: (index * 97) % 256, b: (index * 131) % 256 } } }).jpeg({ quality: 88 }).toBuffer();
    const sha256 = hash(bytes);
    const record = {
      provider: 'cleveland', recordId: String(index + 1), title: `Collected image ${index + 1}`, creator: 'Fixture artist',
      credit: 'Fixture collection', license: 'CC0 1.0', url: `https://example.org/art/${index + 1}`,
      rightsEvidence: { share_license_status: 'CC0', policyUrl: 'https://example.org/policy' },
      width, height, bytes: bytes.length, sha256, originalSha256: sha256,
      file: `assets/${sha256}.jpg`, tags: [index % 2 ? 'Print' : 'Photograph'],
      normalization: { format: 'jpeg', quality: 88, maxEdge: 1000, fullImage: true },
      privatePath: '/private/collector/secret', jobId: 'private-job',
    };
    await writeFile(join(library, record.file), bytes);
    return record;
  }));
  const saveCatalog = () => writeFile(join(library, 'catalog.json'), JSON.stringify({ version: 1, sources: records, records: {} }));
  await saveCatalog();
  const png = await getSharp()({ create: { width: 80, height: 80, channels: 3, background: '#f0e9dc' } }).png().toBuffer();
  const sources = [{ id: 'studio', name: 'Studio paper', width: 80, height: 80, dataUrl: `data:image/png;base64,${png.toString('base64')}` }];
  const requests = [];
  const launch = () => startServer({ port: 0, dataDir: directory, initialSources: sources, persist: false, providerRegistry: createProviderRegistry({ environmentKey: '', fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return completed(); } }) });
  let app = await launch();
  const base = () => `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, body) => {
    const response = await fetch(base() + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const restart = async () => { await app.close(); app = await launch(); };
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, library, records, saveCatalog, base, request, restart, requests };
}

function payload(catalog, overrides = {}) {
  const materialSelection = normalizeMaterialSelection({ version: 1, algorithm: 'offcut-fisher-yates-v1', seed: 419, catalogSnapshot: catalog.snapshot,
    pinnedIds: ['studio'], candidateIds: catalog.sources.filter(source => source.id !== 'studio').map(source => source.id), randomCount: 5, ...overrides });
  const sourceIds = drawMaterialIds(materialSelection);
  return { ...spec, clientRequestId: randomUUID(), materialSelection, sourceIds,
    sourceHashes: Object.fromEntries(sourceIds.map(id => [id, catalog.sources.find(source => source.id === id).sha256])) };
}

async function finished(request, id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const run = (await request(`/api/runs/${id}`)).data.run;
    if (run.status !== 'running') return run;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Fixture did not finish.');
}

test('a large library feeds only the reviewed draw, with exact bytes, recipe and provenance in the durable bundle', async t => {
  const { request, requests, directory, library, records, base } = await fixture(t);
  const before = (await request('/api/project')).data;
  const catalog = (await request('/api/source-catalog')).data;
  assert.equal(catalog.sources.length, 33);
  assert.equal(catalog.limits.maxSources, 24);
  assert.equal(catalog.limits.uploadSlots, 23);
  assert.ok(!JSON.stringify(catalog).includes('base64'));
  const chosen = payload(catalog);
  const preview = catalog.sources.find(source => source.id === chosen.sourceIds[1]);
  const thumb = await getSharp()(Buffer.from(await (await fetch(base() + preview.previewUrl)).arrayBuffer())).metadata();
  assert.ok(thumb.width <= 360 && thumb.height <= 360);
  assert.equal(hash(Buffer.from(await (await fetch(base() + preview.imageUrl)).arrayBuffer())), preview.sha256);
  await request('/api/providers/openai', { apiKey: 'local-fixture-key' });
  const started = await request('/api/runs', chosen);
  assert.equal(started.status, 202, JSON.stringify(started.data));
  const run = await finished(request, started.data.run.id);
  assert.equal(run.status, 'completed');
  const bundle = (await request(`/api/runs/${run.id}/export`)).data;
  const project = (await request(`/api/runs/${run.id}/project`)).data;
  assert.deepEqual(project.sources.map(source => source.id), chosen.sourceIds);
  assert.deepEqual(run.sourceManifest.map(source => source.sha256), chosen.sourceIds.map(id => chosen.sourceHashes[id]));
  assert.deepEqual((await request('/api/project')).data, before);
  assert.equal(requests.length, 1);
  const images = requests[0].input.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'input_image') : []);
  assert.equal(images.length, 7, 'six selected images and one canvas, not all 33 library images');
  for (const source of project.sources.slice(1)) {
    const record = records.find(record => `library-${record.sha256}` === source.id);
    assert.deepEqual(Buffer.from(source.dataUrl.split(',')[1], 'base64'), await readFile(join(library, record.file)));
  }
  const expectedSelection = { ...chosen.materialSelection, candidateManifest: chosen.materialSelection.candidateIds.map(id => ({ id, sha256: catalog.sources.find(source => source.id === id).sha256 })) };
  assert.deepEqual(run.materialSelection, expectedSelection);
  assert.deepEqual(bundle.events.find(event => event.type === 'run_started').materialSelection, expectedSelection);
  const saved = JSON.parse(await readFile(join(directory, 'runs', run.id, 'run.json'), 'utf8'));
  assert.deepEqual(saved.materialSelection, expectedSelection);
  for (const source of run.sourceManifest.slice(1)) {
    assert.equal(source.collection, 'Cleveland Museum of Art');
    assert.equal(source.provenance.rightsEvidence.share_license_status, 'CC0');
    assert.equal(source.provenance.creator, 'Fixture artist');
  }
  for (const forbidden of ['local-fixture-key', '/private/collector/secret', 'private-job']) assert.ok(!JSON.stringify(bundle).includes(forbidden));
});

test('an accepted draw survives library deletion and restart without resampling or another model call', async t => {
  const { request, restart, requests, library } = await fixture(t, 6);
  const chosen = payload((await request('/api/source-catalog')).data);
  await request('/api/providers/openai', { apiKey: 'local-fixture-key' });
  const started = await request('/api/runs', chosen);
  assert.equal(started.status, 202, JSON.stringify(started.data));
  const original = await finished(request, started.data.run.id);
  await rm(library, { recursive: true });
  const retry = await request('/api/runs', chosen);
  assert.equal(retry.data.run.id, original.id);
  await restart();
  assert.equal((await request('/api/providers')).data.providers[0].configured, false);
  const restored = await request('/api/runs', chosen);
  assert.equal(restored.status, 202, JSON.stringify(restored.data));
  assert.equal(restored.data.run.id, original.id);
  assert.deepEqual(restored.data.run.materialSelection, original.materialSelection);
  assert.deepEqual(restored.data.run.sourceManifest, original.sourceManifest);
  assert.equal(requests.length, 1);
  assert.equal((await request('/api/runs', { ...chosen, materialSelection: { ...chosen.materialSelection, seed: 0 } })).status, 409);
});

test('stale, mismatched and exhausted draws fail before a provider request or a run record is created', async t => {
  const { request, requests, records, saveCatalog, library } = await fixture(t, 6);
  await request('/api/providers/openai', { apiKey: 'local-fixture-key' });
  const catalog = (await request('/api/source-catalog')).data;
  const valid = payload(catalog);
  for (const [patch, status] of [
    [{ sourceIds: [...valid.sourceIds].reverse() }, 400],
    [{ materialSelection: { ...valid.materialSelection, randomCount: 7 } }, 400],
    [{ materialSelection: { ...valid.materialSelection, catalogSnapshot: '0'.repeat(64) } }, 409],
    [{ materialSelection: { ...valid.materialSelection, candidateManifest: [] } }, 400],
    [{ sourceHashes: { ...valid.sourceHashes, studio: '0'.repeat(64) } }, 409],
  ]) {
    const result = await request('/api/runs', { ...valid, ...patch });
    assert.equal(result.status, status, JSON.stringify(result.data));
  }
  records[0].title = 'Changed collection metadata';
  await saveCatalog();
  assert.equal((await request('/api/runs', valid)).status, 409);
  const changed = payload((await request('/api/source-catalog')).data);
  const record = records.find(item => `library-${item.sha256}` === changed.sourceIds[1]);
  await writeFile(join(library, record.file), 'changed bytes');
  const badImage = await request('/api/runs', changed);
  assert.equal(badImage.status, 409, JSON.stringify(badImage.data));
  assert.equal(requests.length, 0);
  assert.equal((await request('/api/runs')).data.runs.length, 0);
});

test('damaged catalog responses explain how to recover without exposing raw file paths', async t => {
  const { request, library, requests } = await fixture(t, 1);
  await writeFile(join(library, 'catalog.json'), '{broken');
  const result = await request('/api/source-catalog');
  assert.equal(result.status, 500);
  assert.match(result.data.error, /Repair catalog.json/);
  assert.ok(!result.data.error.includes(library));
  assert.equal(requests.length, 0);
});
