import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createState, polygonArea, polygonsOverlap, validatePolygon } from '../lib/engine.mjs';

const source = { id: 'page', name: 'Page', width: 100, height: 100, dataUrl: 'source-bytes', credit: 'A supplied page' };
const rectangle = (x, y, width, height) => [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
const makeState = options => createState({ sources: [source], ...options });
const cut = (state, polygon, other = {}) => applyAction(state, { type: 'cut', sourceId: 'page', polygon, ...other });
const throwsCode = (fn, code) => assert.throws(fn, error => error.code === code);

test('cuts retain original coordinates, isolated input data, and immutable histories', () => {
  const input = structuredClone(source);
  const initial = createState({ sources: [input] });
  input.width = 1;
  const polygon = rectangle(5, 7, 20, 30);
  const state = cut(initial, polygon);
  polygon[0][0] = 99;
  assert.deepEqual(state.pieces[0].bounds, { x: 5, y: 7, width: 20, height: 30 });
  assert.deepEqual(state.pieces[0].polygon[0], [5, 7]);
  assert.equal(state.pieces[0].visible, false);
  assert.equal(state.sources[0].width, 100);
  assert.equal(state.sources[0].credit, source.credit);
  assert.deepEqual(initial.pieces, []);
  assert.equal(initial.actionCount, 0);
  assert.equal(state.actionCount, 1);
  state.sources[0].name = 'Changed copy';
  assert.equal(initial.sources[0].name, 'Page');
});

test('finite material rejects overlap even for unused tray pieces and removed pieces', () => {
  const first = cut(makeState(), rectangle(0, 0, 40, 40));
  throwsCode(() => cut(first, rectangle(20, 20, 40, 40)), 'MATERIAL_OVERLAP');
  const placed = applyAction(first, { type: 'place', pieceId: 'piece-1', x: 0, y: 1200 });
  const removed = applyAction(placed, { type: 'remove', pieceId: 'piece-1' });
  throwsCode(() => cut(removed, rectangle(0, 0, 40, 40)), 'MATERIAL_OVERLAP');
  assert.equal(removed.pieces[0].visible, false);
  assert.equal(removed.pieces.length, 1);
  assert.equal(removed.actionCount, 3);
});

test('source boundary edges and corners may be shared without duplicating material', () => {
  let state = cut(makeState(), rectangle(0, 0, 40, 40));
  state = cut(state, rectangle(40, 0, 40, 40));
  state = cut(state, rectangle(40, 40, 40, 40));
  assert.equal(state.pieces.length, 3);
  assert.equal(polygonsOverlap([[0, 0], [40, 0], [40, 40]], [[0, 0], [40, 40], [0, 40]]), false);
});

test('coincident boundaries cannot hide duplicate crops, regardless of winding or added straight vertices', () => {
  const square = rectangle(10, 10, 40, 40);
  const reversed = [...square].reverse();
  const subdivided = [[10, 10], [30, 10], [50, 10], [50, 50], [10, 50]];
  assert.equal(polygonsOverlap(square, reversed), true);
  assert.equal(polygonsOverlap(square, subdivided), true);
  const state = cut(makeState(), square);
  throwsCode(() => cut(state, reversed), 'MATERIAL_OVERLAP');
  throwsCode(() => cut(state, subdivided), 'MATERIAL_OVERLAP');
});

test('concave cuts leave their notches available and reject true intersections', () => {
  const lShape = [[0, 0], [70, 0], [70, 20], [20, 20], [20, 70], [0, 70]];
  const notch = rectangle(20, 20, 50, 50);
  assert.equal(polygonArea(lShape), 2400);
  assert.equal(polygonsOverlap(lShape, notch), false);
  let state = cut(makeState(), lShape);
  state = cut(state, notch);
  assert.equal(state.pieces.length, 2);
  assert.equal(polygonsOverlap(lShape, rectangle(15, 15, 20, 20)), true);
  assert.equal(polygonsOverlap([...lShape].reverse(), notch), false);
});

test('overlap detects crossing strips without interior vertices and either direction of containment', () => {
  const horizontal = rectangle(0, 40, 100, 20);
  const vertical = rectangle(40, 0, 20, 100);
  assert.equal(polygonsOverlap(horizontal, vertical), true);
  const outer = rectangle(0, 0, 100, 100);
  const inner = rectangle(30, 30, 20, 20);
  assert.equal(polygonsOverlap(outer, inner), true);
  assert.equal(polygonsOverlap(inner, outer), true);
  assert.equal(polygonsOverlap(outer, rectangle(99.999, 0, 10, 10)), true);
});

test('self intersections, boundary kisses, retraced edges, and zero-length edges are invalid', () => {
  const malformed = [
    [[0, 0], [80, 80], [0, 80], [80, 0]],
    [[0, 0], [80, 0], [80, 80], [40, 0], [0, 80]],
    [[0, 0], [80, 0], [40, 0], [40, 80], [0, 80]],
    [[0, 0], [80, 0], [80, 80], [0, 80], [0, 0]],
    [[0, 0], [80, 0], [80, 0], [0, 80]],
  ];
  for (const polygon of malformed) throwsCode(() => validatePolygon(polygon, source), 'INVALID_POLYGON');
});

test('geometry rejects out-of-range, non-finite, malformed, tiny, and excessive cuts', () => {
  for (const polygon of [
    rectangle(-1, 0, 20, 20), rectangle(90, 0, 20, 20), rectangle(0, 0, 9, 10),
    [[0, 0], [20, Infinity], [0, 20]], [[0, 0], [20, NaN], [0, 20]],
    [[0, 0], ['20', 0], [0, 20]], [[0, 0, 2], [20, 0], [0, 20]], [[0, 0], [20, 20]],
  ]) throwsCode(() => validatePolygon(polygon, source), 'INVALID_POLYGON');
  throwsCode(() => validatePolygon(rectangle(0, 0, 20, 20), source, { maxVertices: 3 }), 'INVALID_POLYGON');
  assert.equal(polygonArea(validatePolygon(rectangle(0, 0, 10, 10), source)), 100);
});

test('each source has its own finite inventory', () => {
  const state = createState({ sources: [source, { ...source, id: 'second' }] });
  const first = cut(state, rectangle(0, 0, 20, 20));
  const second = applyAction(first, { type: 'cut', sourceId: 'second', polygon: rectangle(0, 0, 20, 20) });
  assert.equal(second.pieces.length, 2);
});

test('action budgets and piece budgets include hidden pieces and count only successful operations', () => {
  const limited = cut(makeState({ rules: { maxPieces: 1, maxActions: 2 } }), rectangle(0, 0, 20, 20));
  throwsCode(() => cut(limited, rectangle(40, 40, 20, 20)), 'PIECE_LIMIT');
  assert.equal(limited.actionCount, 1);
  const full = applyAction(limited, { type: 'describe', title: 'Two actions' });
  throwsCode(() => applyAction(full, { type: 'remove', pieceId: 'piece-1' }), 'ACTION_LIMIT');
  assert.equal(full.actionCount, 2);
});

test('placement preserves crop geometry, accepts clipped edges, and rejects unsupported operations', () => {
  const initial = cut(makeState(), rectangle(0, 0, 20, 20));
  const placed = applyAction(initial, { type: 'place', pieceId: 'piece-1', x: 0, y: 0, rotation: -90, scale: 0.15 });
  assert.equal(placed.pieces[0].rotation, 270);
  assert.equal(placed.pieces[0].visible, true);
  assert.deepEqual(placed.pieces[0].polygon, initial.pieces[0].polygon);
  const transformed = applyAction(placed, { type: 'transform', pieceId: 'piece-1', x: 1000, y: 1200, rotation: 720, scale: 3 });
  assert.equal(transformed.pieces[0].rotation, 0);
  for (const fields of [{ x: -1 }, { y: 1201 }, { scale: 3.01 }, { scale: 0 }, { rotation: Infinity }, { x: '3' }, { tint: '#ffffff' }]) {
    throwsCode(() => applyAction(placed, { type: 'transform', pieceId: 'piece-1', ...fields }), 'INVALID_ACTION');
  }
  throwsCode(() => applyAction(placed, { type: 'place', pieceId: 'piece-1', x: 3 }), 'INVALID_ACTION');
  throwsCode(() => applyAction(placed, { type: 'transform', pieceId: 'piece-1' }), 'INVALID_ACTION');
  throwsCode(() => applyAction(placed, { type: 'generate', prompt: 'A new face' }), 'INVALID_ACTION');
});

test('reordering uses final back-to-front indices and IDs remain stable', () => {
  let state = cut(makeState(), rectangle(0, 0, 20, 20), { pieceId: 'piece-2' });
  state = cut(state, rectangle(20, 0, 20, 20));
  state = cut(state, rectangle(40, 0, 20, 20));
  assert.deepEqual(state.pieces.map(piece => piece.id), ['piece-2', 'piece-1', 'piece-3']);
  const moved = applyAction(state, { type: 'reorder', pieceId: 'piece-2', index: 2 });
  assert.deepEqual(moved.pieces.map(piece => piece.id), ['piece-1', 'piece-3', 'piece-2']);
  throwsCode(() => applyAction(state, { type: 'reorder', pieceId: 'piece-1', index: 3 }), 'INVALID_ACTION');
  throwsCode(() => cut(state, rectangle(60, 0, 20, 20), { pieceId: 'piece-2' }), 'INVALID_ACTION');
});

test('source and rule validation closes invalid states before any action', () => {
  assert.throws(() => createState({ sources: [source, source] }), /duplicated/);
  for (const patch of [{ width: 0 }, { height: NaN }, { id: '' }, { dataUrl: 2 }]) {
    assert.throws(() => createState({ sources: [{ ...source, ...patch }] }));
  }
  for (const rules of [{ minScale: 4, maxScale: 3 }, { maxPieces: 1.5 }, { maxVertices: 2 }, { minArea: Infinity }, { duplicate: true }]) {
    throwsCode(() => makeState({ rules }), 'INVALID_RULES');
  }
});

test('source provenance survives state construction and every edit with safe link schemes', () => {
  const attribution = { ...source, url: 'https://example.org/collections/page', license: 'CC0 1.0' };
  const initial = createState({ sources: [attribution] });
  const next = cut(initial, rectangle(0, 0, 20, 20));
  assert.equal(next.sources[0].url, attribution.url);
  assert.equal(next.sources[0].license, attribution.license);
  assert.equal(next.sources[0].credit, attribution.credit);
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', '/relative/path']) {
    throwsCode(() => createState({ sources: [{ ...attribution, url }] }), 'INVALID_SOURCE');
  }
});
