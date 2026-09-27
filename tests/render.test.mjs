import test from 'node:test';
import assert from 'node:assert/strict';
import { getSharp, renderSVG, renderPNG } from '../lib/render.mjs';

async function fixture() {
  const pixels = Buffer.alloc(32 * 16 * 3);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 32; x++) pixels[(y * 32 + x) * 3 + (x < 16 ? 0 : 2)] = 255;
  const bytes = await getSharp()(pixels, { raw: { width: 32, height: 16, channels: 3 } }).png().toBuffer();
  return {
    canvas: { width: 100, height: 100, background: '#ffffff' },
    title: '<work & title>', statement: 'A "quoted" story.',
    sources: [{ id: 'source', width: 32, height: 16, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }],
    pieces: [{ id: 'red', sourceId: 'source', polygon: [[0, 0], [16, 0], [0, 16]], bounds: { x: 0, y: 0, width: 16, height: 16 }, x: 50, y: 50, rotation: 0, scale: 2, visible: true }],
  };
}

async function imagePixels(state) {
  const { data, info } = await getSharp()(await renderPNG(state)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return (x, y) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
}

test('render clips original pixels into source-space polygons', async () => {
  const state = await fixture();
  const pixel = await imagePixels(state);
  assert.deepEqual(pixel(40, 40), [255, 0, 0]);
  assert.deepEqual(pixel(60, 60), [255, 255, 255]);
  assert.deepEqual(pixel(20, 20), [255, 255, 255]);
  assert.match(renderSVG(state), /&lt;work &amp; title&gt;/);
  assert.match(renderSVG(state), /A &quot;quoted&quot; story/);
});

test('render uses crop origin, rotation, visibility, and back-to-front order', async () => {
  const state = await fixture();
  state.pieces.push({ id: 'blue', sourceId: 'source', polygon: [[16, 0], [32, 0], [32, 16], [16, 16]], bounds: { x: 16, y: 0, width: 16, height: 16 }, x: 40, y: 40, rotation: 90, scale: 1, visible: true });
  assert.deepEqual((await imagePixels(state))(40, 40), [0, 0, 255]);
  state.pieces[1].visible = false;
  assert.deepEqual((await imagePixels(state))(40, 40), [255, 0, 0]);
  state.pieces[1].visible = true;
  state.pieces.reverse();
  assert.deepEqual((await imagePixels(state))(40, 40), [255, 0, 0]);
});

test('render refuses remote or executable image sources', async () => {
  const state = await fixture();
  state.sources[0].dataUrl = 'https://example.com/image.png';
  assert.throws(() => renderSVG(state), /embedded raster source/);
  state.sources[0].dataUrl = 'data:image/svg+xml;base64,PHN2Zy8+';
  assert.throws(() => renderSVG(state), /embedded raster source/);
});
