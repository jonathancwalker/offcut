import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyAction, createState } from '../lib/engine.mjs';
import { getSharp, renderPNG } from '../lib/render.mjs';
import { imageContentRect, outlineForAction, placedPolygon, placedRings } from '../public/work-highlight.mjs';

const rectangle = (x, y, width, height) => [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
const piece = (id = 'target', overrides = {}) => ({
  id, sourceId: 'source', polygon: rectangle(20, 30, 20, 10),
  bounds: { x: 20, y: 30, width: 20, height: 10 },
  x: 50, y: 60, rotation: 0, scale: 1, visible: true, ...overrides,
});
const frame = (...pieces) => ({ pieces });

function close(actual, expected, label = 'coordinate') {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${label}: expected ${expected}, received ${actual}`);
}

function polygonClose(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(actual[i].length, 2);
    close(actual[i][0], expected[i][0], `vertex ${i} x`);
    close(actual[i][1], expected[i][1], `vertex ${i} y`);
  }
}

function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child);
  return Object.freeze(value);
}

let archiveFrames;
async function a003() {
  archiveFrames ??= (async () => {
    const project = JSON.parse(await readFile(new URL('../experiments/003/final-project.json', import.meta.url), 'utf8'));
    // The real archive's geometry and actions are sufficient here; replay need
    // not clone several megabytes of immutable source-image bytes at each step.
    const sources = project.sources.map(({ id, name, width, height }) => ({ id, name, width, height, dataUrl: 'fixture-image' }));
    const frames = [createState({ id: project.id, canvas: project.canvas, rules: project.rules, sources })];
    for (const { action } of project.actions.slice(0, 30)) frames.push(applyAction(frames.at(-1), action));
    return { frames, actions: project.actions.map(record => record.action) };
  })();
  return archiveFrames;
}

test('placedPolygon uses the crop bounds center, then scale, rotation, and canvas translation', () => {
  const fragment = piece('triangle', {
    polygon: [[20, 30], [60, 30], [30, 50]],
    bounds: { x: 20, y: 30, width: 40, height: 20 },
    x: 150, y: 70, rotation: 90, scale: 2,
  });
  polygonClose(placedPolygon(fragment), [[170, 30], [170, 110], [130, 50]]);
  polygonClose(placedPolygon({ ...fragment, rotation: -90 }), [[130, 110], [130, 30], [170, 90]]);
});

test('placedPolygon agrees with rendered pixels for a non-origin irregular cut at a fractional angle', async () => {
  const sharp = getSharp();
  const bytes = await sharp({ create: { width: 80, height: 80, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const fragment = piece('irregular', {
    polygon: [[18, 21], [62, 21], [50, 39], [63, 57], [23, 54]],
    bounds: { x: 18, y: 21, width: 45, height: 36 },
    x: 100.5, y: 90.25, rotation: 31.5, scale: 2.1,
  });
  const state = {
    canvas: { width: 200, height: 180, background: '#ffffff' },
    sources: [{ id: 'source', width: 80, height: 80, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }],
    pieces: [fragment],
  };
  const { data: rendered } = await sharp(await renderPNG(state)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const points = placedPolygon(fragment).map(point => point.join(',')).join(' ');
  const silhouette = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="180"><rect width="200" height="180" fill="white"/><polygon points="${points}" fill="red"/></svg>`);
  const { data: outlined } = await sharp(silhouette).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let interior = 0;
  for (let pixel = 0; pixel < 200 * 180; pixel++) {
    const green = rendered[pixel * 3 + 1];
    // Ignore antialiasing at the boundary; every fully covered or empty pixel
    // must agree, including the concave notch and the non-square crop origin.
    if (green < 8) {
      interior++;
      assert.ok(outlined[pixel * 3 + 1] < 16, `missing rendered material at pixel ${pixel}`);
    } else if (green > 247) {
      assert.ok(outlined[pixel * 3 + 1] > 239, `outline extends beyond rendered material at pixel ${pixel}`);
    }
  }
  assert.ok(interior > 4000, 'the comparison exercises a substantial visible fragment');
});

test('place highlights a newly visible piece and transform uses the resulting placement', () => {
  const before = frame(piece('target', { visible: false }));
  const placed = frame(piece());
  assert.deepEqual(outlineForAction(before, placed, { type: 'place', pieceId: 'target', x: 50, y: 60 }), {
    pieceId: 'target', polygon: [[40, 55], [60, 55], [60, 65], [40, 65]], occluders: [],
  });
  const transformed = frame(piece('target', { x: 75, rotation: 90, scale: 2 }));
  const result = outlineForAction(placed, transformed, { type: 'transform', pieceId: 'target', x: 75, rotation: 90, scale: 2 });
  assert.equal(result.pieceId, 'target');
  polygonClose(result.polygon, [[85, 40], [85, 80], [65, 80], [65, 40]]);
});

test('occluders are exactly the visible pieces above the target in the resulting frame', () => {
  const underneath = piece('underneath');
  const hidden = piece('hidden', { visible: false });
  const near = piece('near', { x: 75 });
  const distant = piece('distant', { x: 900 });
  const before = frame(underneath, piece(), near, hidden, distant);
  const after = frame(underneath, piece('target', { x: 60 }), near, hidden, distant);
  const result = outlineForAction(before, after, { type: 'transform', pieceId: 'target', x: 60 });
  assert.deepEqual(result.occluders, [
    { pieceId: 'near', polygon: [[65, 55], [85, 55], [85, 65], [65, 65]] },
    { pieceId: 'distant', polygon: [[890, 55], [910, 55], [910, 65], [890, 65]] },
  ]);
});

test('trim outlines the retained child, with the retired parent absent from its mask', () => {
  const parent = piece('parent', { rotation: 90, scale: 2 });
  const cover = piece('cover');
  const child = piece('child', {
    parentPieceId: 'parent', polygon: rectangle(20, 30, 10, 10),
    bounds: { x: 20, y: 30, width: 10, height: 10 },
    x: 50, y: 50, rotation: 90, scale: 2,
  });
  const previous = frame(parent, cover);
  const current = frame({ ...parent, visible: false, supersededBy: 'child' }, child, cover);
  const action = { type: 'trim', pieceId: 'parent', newPieceId: 'child', polygon: child.polygon };
  const outline = outlineForAction(previous, current, action);
  assert.equal(outline.pieceId, 'child');
  polygonClose(outline.polygon, [[60, 40], [60, 60], [40, 60], [40, 40]]);
  assert.deepEqual(outline.occluders.map(item => item.pieceId), ['cover']);
  assert.equal(outlineForAction(previous, current, { ...action, newPieceId: 'missing' }), null);
  assert.equal(outlineForAction(previous, frame(current.pieces[0], { ...child, visible: false }, cover), action), null,
    'a trim made in the tray has no canvas outline');
});

test('hole boundaries use the same placement as the outer ring and stay holes in occluders', () => {
  const ring = piece('ring', { holes:[rectangle(25,32,10,6)], rotation:90, scale:2 });
  const rings = placedRings(ring);
  assert.equal(rings.length,2);
  polygonClose(rings[0],[[60,40],[60,80],[40,80],[40,40]]);
  polygonClose(rings[1],[[56,50],[56,70],[44,70],[44,50]]);
  const before = deepFreeze(frame(piece('target',{visible:false}),ring));
  const after = deepFreeze(frame(piece('target'),ring));
  const result = outlineForAction(before,after,{type:'place',pieceId:'target'});
  assert.equal(result.occluders.length,1);
  polygonClose(result.occluders[0].holes[0],rings[1]);
  result.occluders[0].holes[0][0][0] = -999;
  assert.equal(ring.holes[0][0][0],25,'transformed holes do not alias saved source geometry');
  const outline = outlineForAction(frame({...ring,visible:false}),frame(ring),{type:'place',pieceId:'ring'});
  polygonClose(outline.holes[0],rings[1]);
});

test('a trim marks every visible retained component and excludes unplaced offcuts', () => {
  const parent = piece('parent');
  const primary = piece('primary',{parentPieceId:'parent',trimRole:'retained'});
  const secondary = piece('secondary',{parentPieceId:'parent',trimRole:'retained',x:90});
  const offcut = piece('offcut',{parentPieceId:'parent',trimRole:'offcut',visible:false});
  const cover = piece('cover',{holes:[rectangle(25,32,10,6)]});
  const previous = frame(parent,cover);
  const current = frame({...parent,visible:false,supersededBy:'primary',childPieceIds:['primary','secondary','offcut']},primary,secondary,offcut,cover);
  const result = outlineForAction(previous,current,{type:'trim',pieceId:'parent',newPieceId:'primary'});
  assert.equal(result.pieceId,'primary');
  assert.deepEqual(result.additional.map(item=>item.pieceId),['secondary']);
  assert.deepEqual(result.additional[0].occluders.map(item=>item.pieceId),['cover']);
  assert.equal(result.additional[0].occluders[0].holes.length,1);
});

test('missing targets, hidden fragments, and nonvisual actions do not produce an outline', () => {
  const visible = frame(piece());
  const hidden = frame(piece('target', { visible: false, x: 80 }));
  for (const type of ['cut', 'describe', 'remove', 'unknown']) {
    assert.equal(outlineForAction(hidden, visible, { type, pieceId: 'target' }), null, type);
  }
  for (const type of ['place', 'transform', 'reorder']) {
    assert.equal(outlineForAction(visible, hidden, { type, pieceId: 'target' }), null, `hidden ${type}`);
    assert.equal(outlineForAction(visible, visible, { type, pieceId: 'missing' }), null, `missing ${type}`);
  }
  assert.equal(outlineForAction(null, visible, { type: 'place', pieceId: 'target' }), null);
  assert.equal(outlineForAction(visible, null, { type: 'place', pieceId: 'target' }), null);
  assert.equal(outlineForAction(visible, visible, undefined), null);
});

test('identical placements, transforms, and unchanged visible layer order are no-ops', () => {
  const before = frame(piece('bottom'), piece(), piece('hidden', { visible: false }));
  for (const action of [
    { type: 'place', pieceId: 'target', x: 50, y: 60 },
    { type: 'transform', pieceId: 'target', x: 50, y: 60, rotation: 0, scale: 1 },
    { type: 'reorder', pieceId: 'target', index: 1 },
  ]) assert.equal(outlineForAction(before, structuredClone(before), action), null, action.type);
  const acrossHidden = frame(before.pieces[0], before.pieces[2], before.pieces[1]);
  assert.equal(outlineForAction(before, acrossHidden, { type: 'reorder', pieceId: 'target', index: 2 }), null);

  let state = createState({ sources: [{ id: 'source', width: 80, height: 80, dataUrl: 'fixture-image' }] });
  state = applyAction(state, { type: 'cut', sourceId: 'source', pieceId: 'target', polygon: rectangle(20, 30, 20, 10) });
  state = applyAction(state, { type: 'place', pieceId: 'target', x: 50, y: 60 });
  const fullTurn = { type: 'transform', pieceId: 'target', rotation: 360 };
  assert.equal(outlineForAction(state, applyAction(state, fullTurn), fullTurn), null);
});

test('A003 step 24 traces the transformed canopy at its actual source polygon', async () => {
  const { frames, actions } = await a003();
  assert.deepEqual(actions[23], { type: 'transform', pieceId: 'lace-observatory', x: 470, y: 733, scale: 1.15, rotation: 0 });
  const result = outlineForAction(frames[23], frames[24], actions[23]);
  assert.equal(result.pieceId, 'lace-observatory');
  assert.equal(result.polygon.length, 16);
  polygonClose([result.polygon[0], result.polygon[8], result.polygon[11], result.polygon[15]], [
    [461.95, 516.225], [659.75, 909.525], [280.25, 921.025], [405.6, 587.525],
  ]);
  assert.deepEqual(result.occluders.map(item => item.pieceId), [
    'observatory-column', 'red-mullet-body', 'mullet-front-sail', 'mullet-back-sail', 'mullet-front-fin', 'mullet-back-fin',
  ]);
});

test('A003 step 30 masks the reordered bridge deck beneath its new foreground layers', async () => {
  const { frames, actions } = await a003();
  assert.deepEqual(actions[29], { type: 'reorder', pieceId: 'bridge-deck', index: 2 });
  const before = frames[29].pieces.find(item => item.id === 'bridge-deck');
  const after = frames[30].pieces.find(item => item.id === 'bridge-deck');
  assert.deepEqual(after, before, 'only layer order changes');
  const result = outlineForAction(frames[29], frames[30], actions[29]);
  assert.equal(result.pieceId, 'bridge-deck');
  polygonClose(result.polygon, [[269.1, 924.55], [696.9, 915.35], [696.9, 1000.45], [584.2, 1002.75], [469.2, 1025.75], [269.1, 1032.65]]);
  assert.deepEqual(result.occluders.map(item => item.pieceId), [
    'bridge-pier-east', 'bridge-pier-west', 'lace-observatory', 'observatory-column',
    'red-mullet-body', 'mullet-front-sail', 'mullet-back-sail', 'mullet-front-fin', 'mullet-back-fin',
  ]);
  polygonClose([result.occluders[0].polygon[0]], [[644.38, 579.61]]);
  assert.equal(outlineForAction(frames[28], frames[29], actions[28]).occluders.length, 0, 'the deck was previously on top');
});

test('highlight geometry leaves previous frames, current frames, and actions unchanged', () => {
  const previous = deepFreeze(frame(piece('target', { x: 40 }), piece('cover')));
  const current = deepFreeze(frame(piece(), piece('cover')));
  const action = deepFreeze({ type: 'transform', pieceId: 'target', x: 50 });
  const original = structuredClone({ previous, current, action });
  const result = outlineForAction(previous, current, action);
  placedPolygon(current.pieces[0]);
  result.polygon[0][0] = -100;
  result.occluders[0].polygon[0][0] = -200;
  assert.deepEqual({ previous, current, action }, original);
});

test('imageContentRect centers contained artwork within landscape and portrait image boxes', () => {
  assert.deepEqual(imageContentRect({ x: 10, y: 20, width: 300, height: 200 }, 2000, 1000), { x: 10, y: 45, width: 300, height: 150 });
  const portrait = imageContentRect({ x: 10, y: 20, width: 300, height: 200 }, 1000, 1200);
  close(portrait.x, 76.66666666666667);
  close(portrait.y, 20);
  close(portrait.width, 166.66666666666666);
  close(portrait.height, 200);
  assert.deepEqual(imageContentRect({ x: 8, y: 12, width: 400, height: 480 }, 1000, 1200), { x: 8, y: 12, width: 400, height: 480 });
  assert.deepEqual(imageContentRect({ x: 0, y: 0, width: 100, height: 100 }, 20, 10), { x: 0, y: 25, width: 100, height: 50 });
});
