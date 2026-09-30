import test from 'node:test';
import assert from 'node:assert/strict';
import { getSharp, renderSVG, renderPNG } from '../lib/render.mjs';
import { applyAction, createState } from '../lib/engine.mjs';

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

test('trim renders the retained pixels in place under rotation and scale, without the retired parent', async () => {
  const pixels = Buffer.alloc(100 * 100 * 3);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
    const index = (y * 100 + x) * 3;
    pixels[index] = x * 2;
    pixels[index + 1] = y * 2;
    pixels[index + 2] = (Math.floor(x / 10) + Math.floor(y / 10)) % 2 ? 80 : 180;
  }
  const bytes = await getSharp()(pixels, { raw: { width: 100, height: 100, channels: 3 } }).png().toBuffer();
  const source = { id: 'page', width: 100, height: 100, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
  for (const placement of [
    { x: 100, y: 100, rotation: 90, scale: 2 },
    { x: 100, y: 100, rotation: 37, scale: 1.7 },
    { x: 5, y: 60, rotation: 90, scale: 2 },
  ]) {
    let before = createState({ sources: [source], canvas: { width: 200, height: 200, background: '#ffffff' } });
    before = applyAction(before, { type: 'cut', sourceId: 'page', pieceId: 'parent', polygon: [[10, 15], [90, 15], [90, 90], [10, 90]] });
    before = applyAction(before, { type: 'place', pieceId: 'parent', ...placement });
    const polygon = [[25, 40], [80, 45], [65, 85], [30, 65]];
    const after = applyAction(before, { type: 'trim', pieceId: 'parent', newPieceId: 'child', polygon });

    // The reference keeps the old anchor and narrows only its clipping mask.
    // A trim with recomputed bounds must produce the same image.
    const expected = structuredClone(before);
    expected.pieces[0].polygon = polygon;
    const decode = async state => getSharp()(await renderPNG(state)).removeAlpha().raw().toBuffer();
    const [originalPixels, expectedPixels, actualPixels] = await Promise.all([decode(before), decode(expected), decode(after)]);
    let removedChannels = 0;
    let retainedChannels = 0;
    for (let i = 0; i < actualPixels.length; i++) {
      assert.ok(Math.abs(actualPixels[i] - expectedPixels[i]) <= 1, `Retained pixel shifted at channel ${i}, rotation ${placement.rotation}`);
      if (actualPixels[i] === 255 && originalPixels[i] < 240) removedChannels++;
      if (actualPixels[i] < 240) retainedChannels++;
    }
    assert.ok(removedChannels > 100, 'Some material should disappear');
    assert.ok(retainedChannels > 100, 'Retained material should remain visible');
    assert.doesNotMatch(renderSVG(after), /data-piece-id="parent"/);
    assert.match(renderSVG(after), /data-piece-id="child"/);
    if (placement.x === 5) assert.ok(after.pieces[1].x < 0, 'The derived off-canvas anchor should remain intact');
  }
});
