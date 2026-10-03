import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSharp } from '../lib/render.mjs';
import { createState, applyAction } from '../lib/engine.mjs';
import { createGIFExporter, gifSettings, renderGIF } from '../lib/gif.mjs';
import { startServer } from '../server.mjs';

const WHITE = [255, 255, 255];
const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const MAX_RAW_BYTES = 64 * 1024 * 1024;

function project(actions = [], options = {}) {
  return {
    format: 'offcut-project', version: 1, id: 'gif-fixture',
    createdAt: '2026-09-30T12:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z',
    canvas: { width: 64, height: 64, background: '#ffffff' },
    sources: [], rules: { maxActions: 240 },
    actions: actions.map(action => ({ action, at: '2026-09-30T12:00:00.000Z' })),
    cursor: actions.length,
    ...options,
  };
}

async function fixture() {
  const pixels = Buffer.alloc(32 * 16 * 3);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 32; x++) {
    pixels[(y * 32 + x) * 3 + (x < 16 ? 0 : 2)] = 255;
  }
  const png = await getSharp()(pixels, { raw: { width: 32, height: 16, channels: 3 } }).png().toBuffer();
  const sources = [{
    id: 'page', name: 'Two colours', width: 32, height: 16,
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    credit: 'Test fixture', url: 'https://example.org/source', license: 'CC0',
  }];
  return project([
    { type: 'cut', sourceId: 'page', pieceId: 'red', polygon: [[0, 0], [16, 0], [16, 16], [0, 16]] },
    { type: 'place', pieceId: 'red', x: 24, y: 24 },
    { type: 'cut', sourceId: 'page', pieceId: 'blue', polygon: [[16, 0], [32, 0], [32, 16], [16, 16]] },
    { type: 'place', pieceId: 'blue', x: 24, y: 24 },
    { type: 'reorder', pieceId: 'red', index: 1 },
    { type: 'transform', pieceId: 'red', x: 48, y: 48, rotation: 90 },
    { type: 'remove', pieceId: 'blue' },
    { type: 'remove', pieceId: 'red' },
    { type: 'describe', title: 'Returned to blank', statement: 'The fragments were placed, rearranged, and removed.' },
  ], { sources });
}

async function decode(bytes) {
  assert.equal(bytes.subarray(0, 6).toString('ascii'), 'GIF89a');
  const sharp = getSharp();
  const metadata = await sharp(bytes, { animated: true }).metadata();
  const { data, info } = await sharp(bytes, { animated: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const height = metadata.pageHeight || metadata.height;
  assert.equal(info.channels, 3);
  return {
    metadata,
    pixel(frame, x, y) {
      const offset = ((frame * height + y) * info.width + x) * info.channels;
      return [...data.subarray(offset, offset + 3)];
    },
  };
}

test('GIF replays every saved operation, including blank and nonvisual frames, with a final hold', async () => {
  const saved = await fixture();
  const before = structuredClone(saved);
  const { metadata, pixel } = await decode(await renderGIF(saved));
  assert.equal(metadata.width, 64);
  assert.equal(metadata.pageHeight, 64);
  assert.equal(metadata.pages, saved.cursor + 1);
  assert.equal(metadata.loop, 0);
  assert.deepEqual(metadata.delay, [...Array(saved.cursor).fill(650), 2500]);
  const expected = [
    [WHITE, WHITE], // Blank canvas.
    [WHITE, WHITE], // A cut does not place a fragment.
    [RED, WHITE],
    [RED, WHITE], // Cutting a second fragment does not change the canvas.
    [BLUE, WHITE],
    [RED, WHITE], // Red was moved above blue in the layer order.
    [BLUE, RED], // Red moved away, revealing blue underneath.
    [WHITE, RED],
    [WHITE, WHITE],
    [WHITE, WHITE], // Describing the work retains its own frame and final hold.
  ];
  expected.forEach(([first, second], frame) => {
    assert.deepEqual(pixel(frame, 24, 24), first, `action ${frame}, original position`);
    assert.deepEqual(pixel(frame, 48, 48), second, `action ${frame}, moved position`);
  });
  assert.deepEqual(saved, before);
});

test('GIF ends at the saved cursor while the source inventory and redo history stay intact', async () => {
  const saved = await fixture();
  saved.cursor = 4;
  const before = structuredClone(saved);
  const { metadata, pixel } = await decode(await renderGIF(saved));
  assert.equal(metadata.pages, 5);
  assert.deepEqual(metadata.delay, [650, 650, 650, 650, 2500]);
  assert.deepEqual(pixel(4, 24, 24), BLUE);
  assert.deepEqual(pixel(4, 48, 48), WHITE);
  assert.deepEqual(saved, before);
  assert.equal(saved.actions.length, 9);
});

test('GIF playback retains a trimmed fragment in place while its offcut waits in the tray', async () => {
  const original = await fixture();
  const saved = project([
    ...original.actions.slice(0, 2).map(record => record.action),
    { type: 'trim', pieceId: 'red', newPieceId: 'red-refined', polygon: [[8, 0], [16, 0], [16, 16], [8, 16]] },
    { type: 'describe', title: 'Less paper', statement: 'Only the right half remains.' },
  ], { sources: original.sources });
  const before = structuredClone(saved);
  const { metadata, pixel } = await decode(await renderGIF(saved));
  assert.equal(metadata.pages, 5);
  assert.deepEqual(pixel(2, 20, 24), RED);
  assert.deepEqual(pixel(2, 28, 24), RED);
  for (const frame of [3, 4]) {
    assert.deepEqual(pixel(frame, 20, 24), WHITE, 'unplaced offcut is absent from the canvas');
    assert.deepEqual(pixel(frame, 28, 24), RED, 'the retained half stays in place');
  }
  assert.deepEqual(saved, before);
});

test('GIF replay shows a reused offcut with a transparent hole and the result of cutting it again', async () => {
  const original = await fixture();
  const saved = project([], { sources: original.sources });
  let state = createState({ sources: saved.sources, canvas: saved.canvas, rules: saved.rules });
  const act = action => {
    state = applyAction(state, action);
    saved.actions.push({ action, at: saved.createdAt });
    saved.cursor++;
  };
  for (const { action } of original.actions.slice(0, 2)) act(action);
  act({ type: 'trim', pieceId: 'red', newPieceId: 'red-center', polygon: [[2, 2], [14, 2], [14, 14], [2, 14]] });
  const offcut = state.pieces.find(piece => piece.trimRole === 'offcut');
  act({ type: 'remove', pieceId: 'red-center' });
  for (const { action } of original.actions.slice(2, 4)) act(action);
  act({ type: 'place', pieceId: offcut.id, x: 24, y: 24 });
  act({ type: 'reorder', pieceId: offcut.id, index: state.pieces.length - 1 });
  act({ type: 'trim', pieceId: offcut.id, newPieceId: 'thin-ring', polygon: [[1, 1], [15, 1], [15, 15], [1, 15]] });
  const before = structuredClone(saved);
  const { metadata, pixel } = await decode(await renderGIF(saved));
  assert.equal(metadata.pages, saved.cursor + 1);
  assert.deepEqual(pixel(8, 24, 24), BLUE, 'underlying material shows through the reused scrap');
  assert.deepEqual(pixel(8, 16, 24), RED, 'its outer edge retains red pixels');
  assert.deepEqual(pixel(9, 24, 24), BLUE, 'trimming again preserves the old hole');
  assert.deepEqual(pixel(9, 16, 24), BLUE, 'the newly separated border is unplaced');
  assert.deepEqual(pixel(9, 17, 24), RED, 'the thinner retained ring stays in place');
  assert.deepEqual(saved, before);
});

test('an empty saved work exports a valid blank GIF with its final hold', async () => {
  const saved = project([], { canvas: { width: 80, height: 64, background: '#336699' } });
  const { metadata, pixel } = await decode(await renderGIF(saved));
  assert.equal(metadata.width, 80);
  assert.equal(metadata.pageHeight || metadata.height, 64);
  assert.equal(metadata.pages || 1, 1);
  assert.deepEqual(metadata.delay, [2500]);
  const actual = pixel(0, 40, 32);
  [51, 102, 153].forEach((expected, channel) => assert.ok(Math.abs(actual[channel] - expected) <= 2));
});

test('GIF dimensions preserve canvas proportions and bound the complete RGB allocation', () => {
  const small = gifSettings(project());
  assert.equal(small.width, 64);
  assert.equal(small.height, 64);
  assert.equal(small.frames, 1);
  assert.equal(small.frameBytes, 64 * 64 * 3);
  for (const [width, height, count] of [[1000, 1200, 53], [4096, 4096, 240], [4096, 64, 240], [64, 4096, 240]]) {
    const saved = project(Array.from({ length: count }, () => ({ type: 'describe', title: 'A work' })), {
      canvas: { width, height, background: '#ffffff' },
    });
    const settings = gifSettings(saved);
    assert.equal(settings.frames, count + 1);
    assert.ok(Number.isInteger(settings.width) && settings.width > 0);
    assert.ok(Number.isInteger(settings.height) && settings.height > 0);
    assert.ok(settings.width <= 640 && settings.height <= 640);
    assert.ok(settings.width <= width && settings.height <= height);
    assert.equal(settings.frameBytes, settings.width * settings.height * 3);
    assert.ok(settings.frameBytes * settings.frames <= MAX_RAW_BYTES);
    // Integer pixel dimensions can differ from the ideal aspect ratio by a pixel.
    assert.ok(Math.abs(settings.width - settings.height * width / height) <= Math.max(1, width / height));
  }
});

test('GIF validates project identity, history boundaries, and canvas limits before encoding', async () => {
  for (const value of [
    null,
    [],
    project([], { format: 'another-format' }),
    project([], { version: 2 }),
    project([], { actions: null }),
    project([], { cursor: -1 }),
    project([], { cursor: 0.5 }),
    project([], { cursor: 1 }),
    project([], { canvas: { width: 0, height: 64, background: '#ffffff' } }),
    project([], { canvas: { width: 64.5, height: 64, background: '#ffffff' } }),
    project([], { canvas: { width: 1e10, height: 64, background: '#ffffff' } }),
    project([], { canvas: { width: 64, height: 64, background: 'white' } }),
  ]) {
    assert.throws(() => gifSettings(value), { status: 400 });
  }
  const tooMany = project(Array.from({ length: 241 }, () => ({ type: 'describe', title: 'Too many' })));
  assert.throws(() => gifSettings(tooMany), { status: 413 });
  await assert.rejects(renderGIF(project([{ type: 'place', pieceId: 'missing', x: 24, y: 24 }])), { code: 'INVALID_ACTION' });
});

test('GIF refuses executable and remote image sources without modifying the saved project', async () => {
  for (const dataUrl of ['https://example.org/source.png', 'data:image/svg+xml;base64,PHN2Zy8+']) {
    const saved = await fixture();
    saved.cursor = 2;
    saved.sources[0].dataUrl = dataUrl;
    const before = structuredClone(saved);
    await assert.rejects(renderGIF(saved), /embedded raster source/);
    assert.deepEqual(saved, before);
  }
});

test('GIF bounds the source inventory and aggregate embedded image data before preparing a worker', () => {
  const source = { id: 'page', name: 'Page', width: 16, height: 16, dataUrl: 'data:image/png;base64,AA==' };
  assert.throws(() => gifSettings(project([], { sources: null })), { status: 400 });
  const allowed = project([], { sources: Array.from({ length: 24 }, (_, index) => ({ ...source, id: `page-${index}` })) });
  assert.doesNotThrow(() => gifSettings(allowed));
  const overCount = structuredClone(allowed);
  overCount.sources.push({ ...source, id: 'page-24' });
  const before = structuredClone(overCount);
  assert.throws(() => gifSettings(overCount), { status: 413 });
  assert.deepEqual(overCount, before);

  // Length checks do not need to decode these intentionally synthetic image strings.
  const dataUrl = `data:image/png;base64,${'A'.repeat(16 * 1024 * 1024)}`;
  const overBytes = project([], { sources: [{ ...source, dataUrl }, { ...source, id: 'second', dataUrl }] });
  assert.throws(() => gifSettings(overBytes), { status: 413 });
  assert.equal(overBytes.sources[0].dataUrl, dataUrl);
  assert.equal(overBytes.sources[1].dataUrl, dataUrl);
});

test('GIF counts each used source once and limits decoded pixels only through the saved cursor', () => {
  const sources = ['first', 'second', 'later'].map(id => ({
    id, name: id, width: 4000, height: 4000, dataUrl: 'data:image/png;base64,AA==',
  }));
  const cut = sourceId => ({ type: 'cut', sourceId, polygon: [[0, 0], [16, 0], [16, 16], [0, 16]] });
  const saved = project([cut('first'), cut('first'), cut('second'), cut('later')], { sources, cursor: 3 });
  const before = structuredClone(saved);
  assert.doesNotThrow(() => gifSettings(saved), 'Two distinct 16-million-pixel sources meet the budget.');
  assert.deepEqual(saved, before);
  saved.sources[2].width = 16;
  saved.sources[2].height = 16;
  saved.cursor = 4;
  const overBudget = structuredClone(saved);
  assert.throws(() => gifSettings(saved), { status: 413 });
  assert.deepEqual(saved, overBudget);
  saved.cursor = 0;
  assert.doesNotThrow(() => gifSettings(saved), 'Unused and redo-only sources do not consume the decoded budget.');
});

test('GIF verifies actual source dimensions before rasterizing even a hidden cut', async () => {
  for (const dimension of ['width', 'height']) {
    const saved = await fixture();
    saved.cursor = 1;
    saved.sources[0][dimension]++;
    const before = structuredClone(saved);
    await assert.rejects(renderGIF(saved), { status: 400 });
    assert.deepEqual(saved, before);
  }
});

test('GIF rejects animation and unsupported actual image formats in used sources', async () => {
  const sharp = getSharp();
  const singleGIF = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#ff0000' } }).gif().toBuffer();
  const pixels = Buffer.alloc(32 * 16 * 3 * 2);
  for (let index = 0; index < 32 * 16; index++) {
    pixels[index * 3] = 255;
    pixels[32 * 16 * 3 + index * 3 + 2] = 255;
  }
  const animatedWebP = await sharp(pixels, { raw: { width: 32, height: 32, pageHeight: 16, channels: 3 } })
    .webp({ lossless: true, delay: [100, 100], loop: 0 }).toBuffer();
  assert.equal((await sharp(animatedWebP).metadata()).pages, 2);
  for (const [mime, bytes] of [['png', singleGIF], ['webp', animatedWebP]]) {
    const saved = await fixture();
    saved.cursor = 1;
    saved.sources[0].dataUrl = `data:image/${mime};base64,${bytes.toString('base64')}`;
    const before = structuredClone(saved);
    await assert.rejects(renderGIF(saved), { status: 400 });
    assert.deepEqual(saved, before);
  }
});

test('GIF exporter rejects overlapping jobs and recovers after cancellation', async t => {
  const exporter = createGIFExporter();
  t.after(() => exporter.close());
  const controller = new AbortController();
  const pending = exporter.render(project(), { signal: controller.signal });
  const cancellation = assert.rejects(pending, { status: 499 });
  await assert.rejects(exporter.render(project()), { status: 409 });
  controller.abort();
  await cancellation;
  const { metadata } = await decode(await exporter.render(project()));
  assert.equal(metadata.width, 64);
  await exporter.close();
  await assert.rejects(exporter.render(project()), { status: 503 });
});

test('GIF exporter handles an already cancelled request without occupying its worker', async t => {
  const exporter = createGIFExporter();
  t.after(() => exporter.close());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(exporter.render(project(), { signal: controller.signal }), { status: 499 });
  const { metadata } = await decode(await exporter.render(project()));
  assert.equal(metadata.width, 64);
});

test('GIF exporter reports invalid recorded actions and remains usable after a worker failure', async t => {
  const exporter = createGIFExporter();
  t.after(() => exporter.close());
  await assert.rejects(exporter.render(project([{ type: 'place', pieceId: 'missing', x: 24, y: 24 }])), { status: 400 });
  const { metadata } = await decode(await exporter.render(project()));
  assert.equal(metadata.width, 64);
});

test('GIF worker timeouts release the active job so a subsequent request can start', async t => {
  const exporter = createGIFExporter({ timeoutMs: 1 });
  t.after(() => exporter.close());
  await assert.rejects(exporter.render(project()), { status: 504 });
  await assert.rejects(exporter.render(project()), { status: 504 });
});

test('disconnecting an HTTP GIF download cancels the busy worker and permits another download', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offcut-gif-cancel-'));
  const app = await startServer({ port: 0, dataDir: directory, persist: false, initialSources: [] });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  // Load the archive first so the concurrent requests both reach the export service immediately.
  assert.equal((await fetch(`${base}/api/archives/archive-001`)).status, 200);
  const controller = new AbortController();
  const first = fetch(`${base}/api/archives/archive-001/render.gif`, { signal: controller.signal });
  const cancelled = assert.rejects(first, { name: 'AbortError' });
  await new Promise(resolve => setTimeout(resolve, 25));
  const busy = await fetch(`${base}/api/archives/archive-001/render.gif`);
  assert.equal(busy.status, 409);
  assert.match((await busy.json()).error, /Another GIF/);
  controller.abort();
  await cancelled;
  let recovered;
  for (let attempt = 0; attempt < 100; attempt++) {
    recovered = await fetch(`${base}/api/archives/archive-002/render.gif`);
    if (recovered.status !== 409) break;
    await recovered.arrayBuffer();
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(recovered.status, 200);
  assert.equal(recovered.headers.get('content-type'), 'image/gif');
  const metadata = await getSharp()(Buffer.from(await recovered.arrayBuffer())).metadata();
  assert.equal(metadata.pages, 33);
});
