import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createState, pieceArea, pieceRings, polygonArea, polygonsOverlap, usablePieceCount, validatePolygon } from '../lib/engine.mjs';
import { intersection, union, xor } from '../lib/vendor/polyclip.mjs';

const source = { id: 'page', name: 'Page', width: 100, height: 100, dataUrl: 'source-bytes', credit: 'A supplied page' };
const rectangle = (x, y, width, height) => [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
const contour = vertices => Array.from({ length: vertices }, (_, index) => {
  const angle = index * Math.PI * 2 / vertices;
  const radius = index % 2 ? 25 : 40;
  return [50 + radius * Math.cos(angle), 50 + radius * Math.sin(angle)];
});
const makeState = options => createState({ sources: [source], ...options });
const cut = (state, polygon, other = {}) => applyAction(state, { type: 'cut', sourceId: 'page', polygon, ...other });
const trim = (state, pieceId, newPieceId, polygon) => applyAction(state, { type: 'trim', pieceId, newPieceId, polygon });
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

test('detailed concave cuts preserve narrow notches and finite material', () => {
  const comb = [[5, 5], [95, 5], [95, 85], [85, 85], [85, 25], [75, 25], [75, 85], [65, 85], [65, 25], [55, 25], [55, 85], [45, 85], [45, 25], [35, 25], [35, 85], [25, 85], [25, 25], [15, 25], [15, 85], [5, 85]];
  const first = cut(makeState(), comb);
  assert.deepEqual(first.pieces[0].polygon, comb);
  const notch = rectangle(75, 25, 10, 60);
  assert.equal(polygonsOverlap(comb, notch), false);
  assert.equal(cut(first, notch).pieces.length, 2);
  throwsCode(() => cut(first, rectangle(70, 40, 10, 10)), 'MATERIAL_OVERLAP');
  throwsCode(() => cut(first, [...comb].reverse()), 'MATERIAL_OVERLAP');
});

test('new cuts accept 64 vertices, reject 65, and retain geometry checks', () => {
  const polygon = contour(64);
  const state = cut(makeState(), polygon);
  assert.equal(state.rules.maxVertices, 64);
  assert.deepEqual(state.pieces[0].polygon, polygon);
  assert.throws(() => cut(makeState(), contour(65)), error => error.code === 'INVALID_POLYGON' && /3–64 vertices/.test(error.message));
  throwsCode(() => cut(state, polygon), 'MATERIAL_OVERLAP');

  const circle = Array.from({ length: 25 }, (_, index) => {
    const angle = index * Math.PI * 2 / 25;
    return [50 + 40 * Math.cos(angle), 50 + 40 * Math.sin(angle)];
  });
  const crossed = circle.map((_, index) => circle[(index * 2) % circle.length]);
  assert.throws(() => cut(makeState(), crossed), error => error.code === 'INVALID_POLYGON' && /cross or touch itself/.test(error.message));
});

test('explicit legacy vertex rules remain in force', () => {
  const initial = makeState({ rules: { maxVertices: 16 } });
  const state = cut(initial, contour(16));
  assert.equal(state.rules.maxVertices, 16);
  assert.equal(state.pieces[0].polygon.length, 16);
  assert.throws(() => cut(initial, contour(17)), error => error.code === 'INVALID_POLYGON' && /3–16 vertices/.test(error.message));
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

const childrenOf = (state, parentId) => state.pieces.find(piece => piece.id === parentId).childPieceIds.map(id => state.pieces.find(piece => piece.id === id));
const regionArea = polygons => polygons.reduce((sum, rings) => sum + polygonArea(rings[0]) - rings.slice(1).reduce((holes, ring) => holes + polygonArea(ring), 0), 0);
const assertPartition = (parent, children) => {
  assert.ok(Math.abs(children.reduce((sum, piece) => sum + pieceArea(piece), 0) - pieceArea(parent)) < 1e-7, 'Child areas conserve the parent material');
  // Intersection coordinates round-trip through JS numbers; a repeated cut
  // can leave sub-pixel collinearity residuals around 1e-13 square pixels.
  assert.ok(regionArea(xor(pieceRings(parent), union(...children.map(pieceRings)))) < 1e-8, 'Children cover their parent, including holes');
  for (let first = 0; first < children.length; first++) for (let second = first + 1; second < children.length; second++) {
    assert.ok(regionArea(intersection(pieceRings(children[first]), pieceRings(children[second]))) < 1e-8, 'Siblings cannot duplicate material');
  }
};

test('trimming replaces a parent with a retained piece and independently usable offcut', () => {
  let before = cut(makeState(), rectangle(0, 0, 20, 80), { pieceId: 'under' });
  before = cut(before, rectangle(20, 0, 60, 80), { pieceId: 'parent' });
  before = cut(before, rectangle(80, 0, 20, 80), { pieceId: 'over' });
  for (const pieceId of ['under', 'parent', 'over']) before = applyAction(before, { type: 'place', pieceId, x: 200, y: 300 });
  const input = rectangle(30, 10, 40, 50);
  const after = trim(before, 'parent', 'child', input);
  input[0][0] = 99;
  assert.deepEqual(after.pieces.map(piece => piece.id), ['under', 'parent', 'child', 'piece-1', 'over']);
  assert.deepEqual(after.pieces.filter(piece => piece.visible).map(piece => piece.id), ['under', 'child', 'over']);
  const parent = after.pieces[1], [child, offcut] = childrenOf(after, 'parent');
  assert.equal(parent.supersededBy, 'child');
  assert.deepEqual(parent.childPieceIds, ['child', 'piece-1']);
  assert.deepEqual(parent.polygon, before.pieces[1].polygon);
  assert.equal(child.parentPieceId, 'parent');
  assert.equal(child.trimRole, 'retained');
  assert.equal(child.sourceId, 'page');
  assert.equal(child.supersededBy, undefined);
  assert.deepEqual(child.polygon, rectangle(30, 10, 40, 50));
  assert.deepEqual(child.bounds, { x: 30, y: 10, width: 40, height: 50 });
  assert.equal(offcut.parentPieceId, 'parent');
  assert.equal(offcut.trimRole, 'offcut');
  assert.equal(offcut.visible, false);
  assert.equal(offcut.holes.length, 1);
  assertPartition(before.pieces[1], [child, offcut]);
  assert.equal(after.actionCount, before.actionCount + 1);
  assert.equal(usablePieceCount(after), 4);
  assert.equal(before.pieces[1].visible, true);
  assert.equal(before.pieces[1].supersededBy, undefined);
  assert.equal(before.pieces.length, 3);
  assert.equal(applyAction(after, { type: 'place', pieceId: offcut.id, x: 700, y: 800 }).pieces.find(piece => piece.id === offcut.id).visible, true);

  for (const action of [
    { type: 'place', x: 0, y: 0 }, { type: 'transform', rotation: 10 },
    { type: 'remove' }, { type: 'reorder', index: 0 },
    { type: 'trim', newPieceId: 'resurrected', polygon: rectangle(20, 0, 20, 20) },
  ]) throwsCode(() => applyAction(after, { ...action, pieceId: 'parent' }), 'PIECE_RETIRED');
});

test('every child preserves source alignment under rotation, scale, and non-origin crops', () => {
  const toCanvas = (piece, [x, y]) => {
    const dx = (x - piece.bounds.x - piece.bounds.width / 2) * piece.scale;
    const dy = (y - piece.bounds.y - piece.bounds.height / 2) * piece.scale;
    const radians = piece.rotation * Math.PI / 180;
    return [piece.x + dx * Math.cos(radians) - dy * Math.sin(radians), piece.y + dx * Math.sin(radians) + dy * Math.cos(radians)];
  };
  for (const rotation of [0, 37, 90, 180, 270]) {
    for (const scale of [0.15, 1, 2.7]) {
      const unplaced = cut(makeState(), rectangle(10, 20, 80, 70), { pieceId: 'parent' });
      const placed = applyAction(unplaced, { type: 'place', pieceId: 'parent', x: 300, y: 500, rotation, scale });
      const after = trim(placed, 'parent', 'child', [[10, 30], [50, 35], [60, 65], [30, 80]]);
      for (const child of childrenOf(after, 'parent')) {
        assert.equal(child.rotation, rotation);
        assert.equal(child.scale, scale);
        for (const point of pieceRings(child).flat()) {
          const expected = toCanvas(placed.pieces[0], point);
          const actual = toCanvas(child, point);
          assert.ok(actual.every((value, axis) => Math.abs(value - expected[axis]) < 1e-10));
        }
      }
    }
  }
});

test('a derived trim center can leave the canvas without moving retained material', () => {
  let state = cut(makeState(), rectangle(0, 0, 100, 100), { pieceId: 'parent' });
  state = applyAction(state, { type: 'place', pieceId: 'parent', x: 0, y: 0, rotation: 90, scale: 2 });
  const trimmed = trim(state, 'parent', 'child', rectangle(0, 60, 20, 20));
  const child = trimmed.pieces[1];
  assert.ok(Math.abs(child.x + 40) < 1e-10);
  assert.ok(Math.abs(child.y + 80) < 1e-10);
  assert.equal(child.visible, true);
  assert.doesNotThrow(() => applyAction(trimmed, { type: 'transform', pieceId: 'child', rotation: 30 }));
  throwsCode(() => applyAction(trimmed, { type: 'transform', pieceId: 'child', x: child.x }), 'INVALID_ACTION');
  const moved = applyAction(trimmed, { type: 'place', pieceId: 'child', x: 20, y: 30 });
  assert.equal(moved.pieces[1].x, 20);
  assert.equal(moved.pieces[1].y, 30);
});

test('trimming unplaced and removed pieces keeps every resulting piece in the tray', () => {
  const unplaced = cut(makeState(), rectangle(0, 0, 80, 80), { pieceId: 'parent' });
  assert.ok(childrenOf(trim(unplaced, 'parent', 'child', rectangle(10, 10, 20, 20)), 'parent').every(piece => !piece.visible));
  const placed = applyAction(unplaced, { type: 'place', pieceId: 'parent', x: 300, y: 400 });
  const removed = applyAction(placed, { type: 'remove', pieceId: 'parent' });
  assert.ok(childrenOf(trim(removed, 'parent', 'child', rectangle(10, 10, 20, 20)), 'parent').every(piece => !piece.visible));
});

test('all disconnected remnants become independently usable scraps', () => {
  const parent = cut(makeState(), rectangle(0, 0, 80, 80), { pieceId: 'root' });
  const state = trim(parent, 'root', 'middle', rectangle(30, 0, 20, 80));
  const children = childrenOf(state, 'root');
  assert.deepEqual(children.map(piece => piece.trimRole), ['retained', 'offcut', 'offcut']);
  assert.deepEqual(children.map(piece => piece.bounds), [
    { x: 30, y: 0, width: 20, height: 80 },
    { x: 0, y: 0, width: 30, height: 80 },
    { x: 50, y: 0, width: 30, height: 80 },
  ]);
  assertPartition(parent.pieces[0], children);
  let placed = state;
  for (const [index, piece] of children.entries()) placed = applyAction(placed, { type: 'place', pieceId: piece.id, x: 100 + index * 100, y: 200 });
  assert.equal(placed.pieces.filter(piece => piece.visible).length, 3);
});

test('repeat trims preserve holes and never restore missing material', () => {
  const original = cut(makeState(), rectangle(0, 0, 80, 80), { pieceId: 'root' });
  const first = trim(original, 'root', 'center', rectangle(20, 20, 40, 40));
  const ring = childrenOf(first, 'root').find(piece => piece.trimRole === 'offcut');
  assert.equal(pieceArea(ring), 4800);
  assert.equal(pieceRings(ring).length, 2);
  const second = trim(first, ring.id, 'smaller-ring', rectangle(10, 10, 60, 60));
  const [retained, offcut] = childrenOf(second, ring.id);
  assert.equal(retained.holes.length, 1);
  assert.equal(pieceArea(retained), 2000);
  assert.equal(pieceArea(offcut), 2800);
  assert.deepEqual(intersection(pieceRings(retained), [rectangle(20, 20, 40, 40)]), []);
  assertPartition(ring, [retained, offcut]);
  throwsCode(() => trim(second, 'smaller-ring', 'hole-only', rectangle(30, 30, 20, 20)), 'INVALID_POLYGON');
  throwsCode(() => cut(second, rectangle(0, 0, 20, 20)), 'MATERIAL_OVERLAP');
  throwsCode(() => cut(second, rectangle(20, 20, 10, 10)), 'MATERIAL_OVERLAP');
  assert.equal(cut(second, rectangle(80, 0, 20, 20)).pieces.length, second.pieces.length + 1);
  throwsCode(() => applyAction(second, { type: 'place', pieceId: ring.id, x: 200, y: 300 }), 'PIECE_RETIRED');
});

test('one mask can create several retained components and several scraps without bridging a hole', () => {
  let state = cut(makeState(), rectangle(0, 0, 80, 80), { pieceId: 'root' });
  state = trim(state, 'root', 'center', rectangle(20, 20, 40, 40));
  const ringId = childrenOf(state, 'root').find(piece => piece.trimRole === 'offcut').id;
  state = applyAction(state, { type: 'place', pieceId: ringId, x: 200, y: 300, rotation: 25, scale: 1.5 });
  const ring = state.pieces.find(piece => piece.id === ringId);
  const after = trim(state, ringId, 'left-band', rectangle(0, 30, 80, 20));
  const children = childrenOf(after, ringId);
  assert.deepEqual(children.map(piece => piece.trimRole), ['retained', 'retained', 'offcut', 'offcut']);
  assert.equal(children[0].id, 'left-band');
  assert.equal(children[0].bounds.x, 0);
  assert.equal(children[1].bounds.x, 60);
  assert.deepEqual(children.map(piece => piece.visible), [true, true, false, false]);
  assert.deepEqual(children.map(pieceArea), [400, 400, 2000, 2000]);
  assertPartition(ring, children);
});

test('masks crossing concave notches keep only parent material instead of filling the gap', () => {
  const lShape = [[0, 0], [80, 0], [80, 20], [20, 20], [20, 80], [0, 80]];
  const first = cut(makeState(), lShape, { pieceId: 'parent' });
  const clipped = trim(first, 'parent', 'clipped', [[10, 10], [70, 10], [10, 70]]);
  assertPartition(first.pieces[0], childrenOf(clipped, 'parent'));
  assert.deepEqual(intersection(pieceRings(clipped.pieces[1]), [rectangle(20, 20, 50, 50)]), []);
  const notch = [[0, 0], [100, 0], [100, 50], [60, 50], [60, 40], [40, 40], [40, 50], [0, 50]];
  const second = cut(makeState(), notch, { pieceId: 'parent' });
  const after = trim(second, 'parent', 'notch-preserved', rectangle(30, 30, 40, 20));
  assertPartition(second.pieces[0], childrenOf(after, 'parent'));
  assert.equal(pieceArea(after.pieces[1]), 600);
});

test('component geometry and generated IDs are deterministic across input winding and starting vertex', () => {
  const parent = [[0, 0], [80, 0], [80, 20], [20, 20], [20, 80], [0, 80]];
  const mask = [[0, 0], [30, 0], [60, 0], [60, 20], [20, 20], [20, 60], [0, 60]];
  let reference;
  for (const parentPolygon of [parent, [...parent].reverse(), [...parent.slice(2), ...parent.slice(0, 2)]]) {
    for (const maskPolygon of [mask, [...mask].reverse(), [...mask.slice(3), ...mask.slice(0, 3)]]) {
      const state = trim(cut(makeState(), parentPolygon), 'piece-1', 'child', maskPolygon);
      const children = childrenOf(state, 'piece-1');
      if (reference) assert.deepEqual(children, reference);
      reference = children;
      assertPartition(state.pieces[0], children);
    }
  }
});

test('trim needs both retained material and an offcut, rejecting no-op and empty intersections atomically', () => {
  const state = cut(makeState(), rectangle(10, 10, 50, 50));
  const snapshot = structuredClone(state);
  for (const mask of [rectangle(10, 10, 50, 50), rectangle(0, 0, 100, 100), rectangle(60, 10, 20, 20), rectangle(70, 70, 20, 20)]) {
    throwsCode(() => trim(state, 'piece-1', 'child', mask), 'INVALID_POLYGON');
    assert.deepEqual(state, snapshot);
  }
  // A mask may extend outside the parent: it cannot bring absent pixels with it.
  const clipped = trim(state, 'piece-1', 'child', rectangle(0, 20, 40, 20));
  assert.equal(pieceArea(clipped.pieces[1]), 600);
  assert.deepEqual(clipped.pieces[1].bounds, { x: 10, y: 20, width: 30, height: 20 });
  assertPartition(state.pieces[0], childrenOf(clipped, 'piece-1'));
});

test('generated retained fragments and offcuts below minArea remain usable paper', () => {
  const parent = cut(makeState(), rectangle(0, 0, 80, 80), { pieceId: 'parent' });
  for (const width of [0.01, 1e-8]) {
    const state = trim(parent, 'parent', 'large', rectangle(0, 0, 80 - width, 80));
    const offcut = childrenOf(state, 'parent').find(piece => piece.trimRole === 'offcut');
    assert.ok(pieceArea(offcut) > 0 && pieceArea(offcut) < state.rules.minArea);
    assert.ok(Math.abs(pieceArea(offcut) - width * 80) < 1e-10);
    assert.equal(applyAction(state, { type: 'place', pieceId: offcut.id, x: 300, y: 400 }).pieces.find(piece => piece.id === offcut.id).visible, true);
    assertPartition(parent.pieces[0], childrenOf(state, 'parent'));
  }
  const tiny = trim(parent, 'parent', 'tiny-retained', rectangle(79.9, 0, 20, 20));
  assert.ok(Math.abs(pieceArea(tiny.pieces[1]) - 2) < 1e-10);
  assertPartition(parent.pieces[0], childrenOf(tiny, 'parent'));
});

test('authored masks retain geometry limits while generated boundaries may exceed 64 vertices', () => {
  const full = cut(makeState({ rules: { maxPieces: 64 } }), rectangle(0, 0, 100, 100));
  const detailed = trim(full, 'piece-1', 'detailed', contour(64));
  assert.equal(detailed.pieces[1].polygon.length, 64);
  const offcut = childrenOf(detailed, 'piece-1').find(piece => piece.trimRole === 'offcut');
  assert.equal(pieceRings(offcut).reduce((count, ring) => count + ring.length, 0), 68);
  const clipped = trim(detailed, 'detailed', 'complex-retained', rectangle(20, 20, 60, 60));
  const child = clipped.pieces.find(piece => piece.id === 'complex-retained');
  assert.ok(child.polygon.length > 64, `Expected an automatically generated detailed boundary, got ${child.polygon.length}`);
  const again = trim(clipped, child.id, 'recut-detailed', rectangle(25, 25, 50, 50));
  assertPartition(child, childrenOf(again, child.id));
  throwsCode(() => trim(full, 'piece-1', 'too-many', contour(65)), 'INVALID_POLYGON');
  const legacy = cut(makeState({ rules: { maxVertices: 16 } }), rectangle(0, 0, 100, 100));
  throwsCode(() => trim(legacy, 'piece-1', 'legacy', contour(17)), 'INVALID_POLYGON');
  for (const mask of [rectangle(0, 0, 9, 10), rectangle(-1, 0, 20, 20), [[0, 0], [80, 80], [0, 80], [80, 0]]]) {
    throwsCode(() => trim(full, 'piece-1', 'invalid', mask), 'INVALID_POLYGON');
  }
});

test('trim budgets count every usable result but exclude retired parents', () => {
  const start = cut(makeState({ rules: { maxPieces: 3, maxActions: 4 } }), rectangle(0, 0, 80, 80));
  const trimmed = trim(start, 'piece-1', 'child', rectangle(20, 20, 40, 40));
  assert.equal(trimmed.actionCount, 2);
  assert.equal(trimmed.pieces.length, 3);
  assert.equal(usablePieceCount(trimmed), 2);
  const filled = cut(trimmed, rectangle(80, 0, 20, 20));
  assert.equal(usablePieceCount(filled), 3);
  assert.equal(filled.pieces.length, 4);
  const before = structuredClone(filled);
  throwsCode(() => trim(filled, 'child', 'grandchild', rectangle(30, 30, 20, 20)), 'PIECE_LIMIT');
  throwsCode(() => cut(filled, rectangle(80, 20, 20, 20)), 'PIECE_LIMIT');
  assert.deepEqual(filled, before);
  const finished = applyAction(filled, { type: 'describe', title: 'Four actions' });
  throwsCode(() => trim(finished, 'child', 'grandchild', rectangle(30, 30, 20, 20)), 'ACTION_LIMIT');
  assert.equal(start.actionCount, 1);
  assert.equal(start.pieces[0].supersededBy, undefined);
});

test('a many-component cut fails atomically when all resulting scraps do not fit', () => {
  const state = cut(makeState({ rules: { maxPieces: 2 } }), rectangle(0, 0, 80, 80));
  const before = structuredClone(state);
  throwsCode(() => trim(state, 'piece-1', 'middle', rectangle(30, 0, 20, 80)), 'PIECE_LIMIT');
  assert.deepEqual(state, before);
  const fits = trim(state, 'piece-1', 'half', rectangle(0, 0, 40, 80));
  assert.equal(usablePieceCount(fits), 2);
});

test('generated IDs avoid all existing and reserved IDs and stay bounded', () => {
  let state = cut(makeState(), rectangle(0, 0, 80, 80), { pieceId: 'piece-2' });
  state = cut(state, rectangle(80, 0, 20, 20), { pieceId: 'piece-4' });
  const after = trim(state, 'piece-2', 'piece-1', rectangle(30, 0, 20, 80));
  assert.deepEqual(after.pieces.find(piece => piece.id === 'piece-2').childPieceIds, ['piece-1', 'piece-3', 'piece-5']);
  const longId = 'x'.repeat(128);
  const long = trim(cut(makeState(), rectangle(0, 0, 80, 80), { pieceId: 'root' }), 'root', longId, rectangle(30, 0, 20, 80));
  assert.deepEqual(long.pieces[0].childPieceIds, [longId, 'piece-1', 'piece-2']);
  assert.ok(long.pieces.every(piece => piece.id.length <= 128));
  assert.equal(new Set(long.pieces.map(piece => piece.id)).size, long.pieces.length);
});

test('generated geometry has a separate atomic 8192-vertex guard', () => {
  // Generated-fragment fixture: its boundary is intentionally more detailed
  // than an authored mask, exercising the independent output-complexity cap.
  const state = cut(makeState(), rectangle(0, 0, 100, 100));
  state.pieces[0].polygon = Array.from({ length: 8192 }, (_, index) => {
    const angle = index * 2 * Math.PI / 8192;
    return [50 + 40 * Math.cos(angle), 50 + 40 * Math.sin(angle)];
  });
  state.pieces[0].bounds = { x: 10, y: 10, width: 80, height: 80 };
  const before = structuredClone(state);
  throwsCode(() => trim(state, 'piece-1', 'half', rectangle(0, 0, 50, 100)), 'GEOMETRY_LIMIT');
  assert.deepEqual(state, before);
});

test('trim needs a unique new ID and rejects unsupported fields without modifying state', () => {
  const state = cut(makeState(), rectangle(0, 0, 80, 80));
  const before = structuredClone(state);
  for (const newPieceId of [undefined, null, '', ' ', 'a'.repeat(129), 'piece-1']) {
    throwsCode(() => trim(state, 'piece-1', newPieceId, rectangle(0, 0, 20, 20)), 'INVALID_ACTION');
  }
  for (const fields of [{ sourceId: 'page' }, { x: 20 }, { scale: 0.5 }, { parentPieceId: 'other' }, { holes: [] }]) {
    throwsCode(() => applyAction(state, { type: 'trim', pieceId: 'piece-1', newPieceId: 'child', polygon: rectangle(0, 0, 20, 20), ...fields }), 'INVALID_ACTION');
  }
  throwsCode(() => trim(state, 'missing', 'child', rectangle(0, 0, 20, 20)), 'INVALID_ACTION');
  assert.deepEqual(state, before);
});
