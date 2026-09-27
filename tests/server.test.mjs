import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';
import { getSharp } from '../lib/render.mjs';

async function source() {
  const bytes = await getSharp()({ create: { width: 80, height: 80, channels: 3, background: '#ff0000' } }).png().toBuffer();
  return { id: 'paper', name: 'Test paper', width: 80, height: 80, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scraps-test-'));
  const app = await startServer({ port: 0, persist: false, dataDir: directory, initialSources: [await source()], ...options });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function request(path, body, headers = {}) {
    const response = await fetch(base + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const type = response.headers.get('content-type');
    const data = type?.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, data, response };
  }
  return { app, base, request, directory };
}
const cut = { type: 'cut', sourceId: 'paper', pieceId: 'fragment', polygon: [[0, 0], [30, 0], [30, 30], [0, 30]] };
const place = { type: 'place', pieceId: 'fragment', x: 500, y: 500, scale: 1, rotation: 0 };

test('actions are atomic; undo, redo, and replay preserve the complete composition', async t => {
  const { request } = await fixture(t);
  let result = await request('/api/actions', { actions: [cut, { ...place, pieceId: 'missing' }] });
  assert.equal(result.status, 400);
  assert.equal((await request('/api/state')).data.cursor, 0);
  result = await request('/api/actions', { actions: [cut, place] });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.cursor, 2);
  assert.equal(result.data.state.pieces[0].visible, true);
  assert.equal((await request('/api/state?step=1')).data.state.pieces[0].visible, false);
  assert.equal((await request('/api/state')).data.cursor, 2);
  assert.equal((await request('/api/undo', {})).data.cursor, 1);
  assert.equal((await request('/api/redo', {})).data.cursor, 2);
  await request('/api/undo', {});
  result = await request('/api/actions', { ...place, x: 300 });
  assert.equal(result.data.state.pieces[0].x, 300);
  assert.equal(result.data.canRedo, false);
  assert.equal(result.data.history.length, 2);
  assert.equal((await request('/api/state?step=-1')).status, 400);
  assert.equal((await request('/api/state?step=3')).status, 404);
});

test('source uploads preserve history and invalid project imports cannot replace a work', async t => {
  const { request } = await fixture(t);
  await request('/api/actions', { actions: [cut, place] });
  const image = await source();
  let result = await request('/api/sources', { name: 'Another sheet', dataUrl: image.dataUrl });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.state.sources.length, 2);
  assert.equal(result.data.cursor, 2);
  assert.equal((await request('/api/state?step=0')).data.state.sources.length, 2);
  const exported = (await request('/api/project')).data;
  const malformedId = await request('/api/project', { ...exported, id: '   ' });
  assert.equal(malformedId.status, 400);
  assert.equal((await request('/api/state')).data.cursor, 2);
  exported.actions.push({ action: { ...cut, pieceId: 'overlap' }, at: new Date().toISOString() });
  exported.cursor++;
  result = await request('/api/project', exported);
  assert.equal(result.status, 400);
  assert.equal((await request('/api/state')).data.cursor, 2);
  exported.actions.pop(); exported.cursor--;
  await request('/api/reset', {});
  assert.equal((await request('/api/state')).data.state.pieces.length, 0);
  result = await request('/api/project', exported);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.state.pieces[0].visible, true);
  assert.equal(result.data.cursor, 2);
});

test('the image API exports original pixels and handles invalid image input', async t => {
  const { request, base } = await fixture(t);
  await request('/api/actions', { actions: [cut, place] });
  const response = await fetch(base + '/api/render.png');
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  const { data, info } = await getSharp()(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1000); assert.equal(info.height, 1200);
  assert.deepEqual([...data.subarray((500 * 1000 + 500) * 3, (500 * 1000 + 500) * 3 + 3)], [255, 0, 0]);
  const svg = (await request('/api/render.svg?step=0')).data;
  assert.ok(!svg.includes('<image'));
  assert.equal((await request('/api/sources', { name: 'Bad', dataUrl: 'https://example.com/image.png' })).status, 400);
  assert.equal((await request('/api/sources', { name: 'Bad', dataUrl: 'data:image/png;base64,YWJj' })).status, 400);
});

test('mutations require local same-origin JSON and concurrent actions are serialized', async t => {
  const { request, base } = await fixture(t);
  assert.equal((await request('/api/reset', {}, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await request('/api/reset', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(base + '/%2e%2e/server.mjs')).status, 404);
  const secondCut = { ...cut, pieceId: 'second', polygon: [[40, 0], [70, 0], [70, 30], [40, 30]] };
  const results = await Promise.all([request('/api/actions', cut), request('/api/actions', secondCut)]);
  assert.ok(results.every(result => result.status === 200), JSON.stringify(results));
  assert.equal((await request('/api/state')).data.state.pieces.length, 2);
});

test('saved sessions restore source inventory, undone cursor, and redo actions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'scraps-persistence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await startServer({ port: 0, persist: true, dataDir: directory, initialSources: [await source()] });
  const base = `http://127.0.0.1:${first.server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await post('/api/actions', { actions: [cut, place] });
  await post('/api/undo', {});
  await first.close();
  const second = await startServer({ port: 0, persist: true, dataDir: directory, initialSources: [] });
  t.after(() => second.close());
  assert.equal(second.getProject().cursor, 1);
  assert.equal(second.getProject().actions.length, 2);
  assert.equal(second.getState().pieces[0].visible, false);
  const response = await fetch(`http://127.0.0.1:${second.server.address().port}/api/redo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await response.json()).state.pieces[0].visible, true);
});
