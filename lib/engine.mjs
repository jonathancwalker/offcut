/**
 * The material rules for the collage worktable. All geometry is expressed in
 * original source pixels; rendering a piece never changes its source polygon.
 */
export const DEFAULT_RULES = Object.freeze({
  maxPieces: 24,
  maxActions: 120,
  minArea: 100,
  maxVertices: 16,
  minScale: 0.15,
  maxScale: 3,
});

const EPSILON = 1e-8;
const DEFAULT_CANVAS = Object.freeze({ width: 1000, height: 1200, background: '#f6f1e7' });
const ACTION_FIELDS = {
  cut: ['type', 'sourceId', 'polygon', 'pieceId'],
  place: ['type', 'pieceId', 'x', 'y', 'rotation', 'scale'],
  transform: ['type', 'pieceId', 'x', 'y', 'rotation', 'scale'],
  reorder: ['type', 'pieceId', 'index'],
  remove: ['type', 'pieceId'],
  describe: ['type', 'title', 'statement'],
};

function fail(message, code = 'INVALID_ACTION') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite number.`);
  return value;
}

function text(value, label, maxLength = 256, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maxLength) {
    fail(`${label} must be ${allowEmpty ? 'a' : 'a nonempty'} string of at most ${maxLength} characters.`);
  }
  return value;
}

const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const samePoint = (a, b) => Math.abs(a[0] - b[0]) <= EPSILON && Math.abs(a[1] - b[1]) <= EPSILON;

function signedArea(polygon) {
  // Translating to the first vertex avoids cancellation for small crops far
  // from a source's origin.
  const origin = polygon[0];
  let area = 0;
  for (let i = 1; i < polygon.length - 1; i++) area += cross(origin, polygon[i], polygon[i + 1]);
  return area / 2;
}

export function polygonArea(polygon) {
  return Math.abs(signedArea(polygon));
}

export function polygonBounds(polygon) {
  const xs = polygon.map(point => point[0]);
  const ys = polygon.map(point => point[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function pointOnSegment(point, a, b) {
  return Math.abs(cross(a, b, point)) <= EPSILON &&
    point[0] >= Math.min(a[0], b[0]) - EPSILON && point[0] <= Math.max(a[0], b[0]) + EPSILON &&
    point[1] >= Math.min(a[1], b[1]) - EPSILON && point[1] <= Math.max(a[1], b[1]) + EPSILON;
}

function segmentsMeet(a, b, c, d) {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON)) &&
      ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))) return true;
  return pointOnSegment(c, a, b) || pointOnSegment(d, a, b) ||
    pointOnSegment(a, c, d) || pointOnSegment(b, c, d);
}

/** Validate and copy a simple, optionally concave source-space polygon. */
export function validatePolygon(polygon, source, rules = DEFAULT_RULES) {
  const settings = { ...DEFAULT_RULES, ...rules };
  if (!Array.isArray(polygon) || polygon.length < 3 || polygon.length > settings.maxVertices) {
    fail(`A cut needs 3–${settings.maxVertices} vertices.`, 'INVALID_POLYGON');
  }
  if (!source || !Number.isFinite(source.width) || !Number.isFinite(source.height) || source.width <= 0 || source.height <= 0) {
    fail('A cut needs a source with valid dimensions.', 'INVALID_POLYGON');
  }
  const points = polygon.map((point, index) => {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(value => typeof value === 'number' && Number.isFinite(value))) {
      fail(`Vertex ${index + 1} must contain two finite coordinates.`, 'INVALID_POLYGON');
    }
    const [x, y] = point;
    if (x < 0 || x > source.width || y < 0 || y > source.height) {
      fail(`Vertex ${index + 1} falls outside the source image.`, 'INVALID_POLYGON');
    }
    return [x, y];
  });

  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (samePoint(points[i], points[j])) fail('A cut cannot repeat a vertex or contain a zero-length edge.', 'INVALID_POLYGON');
    }
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const c = points[(i + 2) % points.length];
    if (Math.abs(cross(a, b, c)) <= EPSILON &&
        (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0) {
      fail('A cut boundary cannot double back along itself.', 'INVALID_POLYGON');
    }
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      if (segmentsMeet(a, b, points[j], points[(j + 1) % points.length])) {
        fail('A cut boundary cannot cross or touch itself.', 'INVALID_POLYGON');
      }
    }
  }
  const area = polygonArea(points);
  if (!Number.isFinite(area) || area <= EPSILON || area + EPSILON < settings.minArea) {
    fail(`Each cut must contain at least ${settings.minArea} square source pixels.`, 'INVALID_POLYGON');
  }
  return points;
}

function pointInTriangle(point, a, b, c) {
  return cross(a, b, point) >= -EPSILON && cross(b, c, point) >= -EPSILON && cross(c, a, point) >= -EPSILON;
}

function triangulate(polygon) {
  const points = polygon.map(point => [...point]);
  if (signedArea(points) < 0) points.reverse();
  // Straight vertices carry no area but can block ear clipping. Keep the
  // original polygon in state and omit them only for this calculation.
  let changed = true;
  while (changed && points.length > 3) {
    changed = false;
    for (let i = 0; i < points.length; i++) {
      if (Math.abs(cross(points[(i + points.length - 1) % points.length], points[i], points[(i + 1) % points.length])) <= EPSILON) {
        points.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  const triangles = [];
  while (points.length > 3) {
    let foundEar = false;
    for (let i = 0; i < points.length; i++) {
      const previous = (i + points.length - 1) % points.length;
      const next = (i + 1) % points.length;
      const a = points[previous], b = points[i], c = points[next];
      if (cross(a, b, c) <= EPSILON) continue;
      if (points.some((point, j) => j !== previous && j !== i && j !== next && pointInTriangle(point, a, b, c))) continue;
      triangles.push([a, b, c]);
      points.splice(i, 1);
      foundEar = true;
      break;
    }
    if (!foundEar) fail('The cut has numerically ambiguous geometry; simplify its boundary.', 'INVALID_POLYGON');
  }
  if (points.length === 3) triangles.push(points);
  return triangles;
}

function clipTriangle(subject, triangle) {
  let output = subject;
  for (let i = 0; i < 3 && output.length; i++) {
    const a = triangle[i], b = triangle[(i + 1) % 3];
    const input = output;
    output = [];
    let previous = input[input.length - 1];
    let previousDistance = cross(a, b, previous);
    for (const current of input) {
      const currentDistance = cross(a, b, current);
      const previousInside = previousDistance >= 0;
      const currentInside = currentDistance >= 0;
      if (previousInside !== currentInside) {
        const t = previousDistance / (previousDistance - currentDistance);
        output.push([
          previous[0] + t * (current[0] - previous[0]),
          previous[1] + t * (current[1] - previous[1]),
        ]);
      }
      if (currentInside) output.push(current);
      previous = current;
      previousDistance = currentDistance;
    }
  }
  return output;
}

/**
 * Positive-area intersection of two already validated simple polygons.
 * Triangulation handles concavities, identical boundaries, and containment;
 * touching edges and corners alone do not consume the same material twice.
 */
export function polygonsOverlap(first, second) {
  const a = polygonBounds(first), b = polygonBounds(second);
  if (Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) <= EPSILON ||
      Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) <= EPSILON) return false;
  const firstTriangles = triangulate(first);
  const secondTriangles = triangulate(second);
  for (const triangleA of firstTriangles) {
    for (const triangleB of secondTriangles) {
      const intersection = clipTriangle(triangleA, triangleB);
      if (intersection.length >= 3 && polygonArea(intersection) > EPSILON) return true;
    }
  }
  return false;
}

function normalizeRules(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Rules must be an object.', 'INVALID_RULES');
  for (const key of Object.keys(input)) if (!owns(DEFAULT_RULES, key)) fail(`Unknown rule: ${key}.`, 'INVALID_RULES');
  const rules = { ...DEFAULT_RULES, ...input };
  for (const key of ['maxPieces', 'maxActions', 'maxVertices']) {
    if (!Number.isSafeInteger(rules[key]) || rules[key] < (key === 'maxVertices' ? 3 : 1)) {
      fail(`${key} must be a positive integer${key === 'maxVertices' ? ' of at least 3' : ''}.`, 'INVALID_RULES');
    }
  }
  for (const key of ['minArea', 'minScale', 'maxScale']) {
    if (typeof rules[key] !== 'number' || !Number.isFinite(rules[key]) || rules[key] <= 0) {
      fail(`${key} must be a positive finite number.`, 'INVALID_RULES');
    }
  }
  if (rules.minScale > rules.maxScale) fail('minScale cannot exceed maxScale.', 'INVALID_RULES');
  return rules;
}

export function createState({ sources = [], rules = {}, canvas = {}, id = 'composition' } = {}) {
  if (!Array.isArray(sources)) fail('Sources must be an array.', 'INVALID_SOURCE');
  if (!canvas || typeof canvas !== 'object' || Array.isArray(canvas)) fail('Canvas must be an object.');
  for (const key of Object.keys(canvas)) if (!owns(DEFAULT_CANVAS, key)) fail(`Unknown canvas setting: ${key}.`);
  const normalizedCanvas = { ...DEFAULT_CANVAS, ...canvas };
  for (const key of ['width', 'height']) {
    if (finite(normalizedCanvas[key], `Canvas ${key}`) <= 0) fail(`Canvas ${key} must be positive.`);
  }
  if (typeof normalizedCanvas.background !== 'string' || !/^#[0-9a-f]{6}$/i.test(normalizedCanvas.background)) {
    fail('Canvas background must be a six-digit hexadecimal color.');
  }
  const sourceIds = new Set();
  const normalizedSources = sources.map(source => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) fail('Each source must be an object.', 'INVALID_SOURCE');
    const sourceId = text(source.id, 'Source ID', 128);
    if (sourceIds.has(sourceId)) fail(`Source ID ${sourceId} is duplicated.`, 'INVALID_SOURCE');
    sourceIds.add(sourceId);
    const width = finite(source.width, 'Source width');
    const height = finite(source.height, 'Source height');
    if (width <= 0 || height <= 0) fail('Source dimensions must be positive.', 'INVALID_SOURCE');
    if (typeof source.dataUrl !== 'string') fail('Source dataUrl must be a string.', 'INVALID_SOURCE');
    const normalized = { id: sourceId, name: text(source.name ?? sourceId, 'Source name'), width, height, dataUrl: source.dataUrl };
    if (source.credit !== undefined) normalized.credit = text(source.credit, 'Source credit', 2000, true);
    if (source.url !== undefined) {
      const urlText = text(source.url, 'Source URL', 2000);
      let url;
      try { url = new URL(urlText); } catch { fail('Source URL must be an absolute HTTP or HTTPS URL.', 'INVALID_SOURCE'); }
      if (!['http:', 'https:'].includes(url.protocol)) fail('Source URL must use HTTP or HTTPS.', 'INVALID_SOURCE');
      normalized.url = url.href;
    }
    if (source.license !== undefined) normalized.license = text(source.license, 'Source license', 300, true);
    return normalized;
  });
  return {
    version: 1,
    id: text(id, 'Composition ID', 128),
    canvas: normalizedCanvas,
    sources: normalizedSources,
    pieces: [],
    title: 'Untitled composition',
    statement: '',
    rules: normalizeRules(rules),
    actionCount: 0,
  };
}

export function publicState(state) {
  return structuredClone(state);
}

function updatePlacement(piece, action, canvas, rules) {
  for (const key of ['x', 'y']) {
    if (!owns(action, key)) continue;
    const value = finite(action[key], `Piece ${key}`);
    if (value < 0 || value > canvas[key === 'x' ? 'width' : 'height']) fail(`Piece ${key} must be within the canvas.`);
    piece[key] = value;
  }
  if (owns(action, 'rotation')) {
    const rotation = finite(action.rotation, 'Rotation');
    piece.rotation = ((rotation % 360) + 360) % 360;
  }
  if (owns(action, 'scale')) {
    const scale = finite(action.scale, 'Scale');
    if (scale < rules.minScale || scale > rules.maxScale) fail(`Scale must be between ${rules.minScale} and ${rules.maxScale}.`);
    piece.scale = scale;
  }
}

/** Apply one authorized material operation without mutating prior state. */
export function applyAction(state, action) {
  if (!state || state.version !== 1 || !Array.isArray(state.pieces) || !Array.isArray(state.sources)) fail('Invalid composition state.');
  if (!action || typeof action !== 'object' || Array.isArray(action) || !owns(ACTION_FIELDS, action.type)) fail('Unknown or missing action type.');
  for (const key of Object.keys(action)) {
    if (!ACTION_FIELDS[action.type].includes(key)) fail(`The ${action.type} action does not support ${key}.`);
  }
  if (state.actionCount >= state.rules.maxActions) fail(`The ${state.rules.maxActions}-action budget has been used.`, 'ACTION_LIMIT');
  const next = publicState(state);
  if (action.type === 'cut') {
    if (next.pieces.length >= next.rules.maxPieces) fail(`The ${next.rules.maxPieces}-piece limit has been reached.`, 'PIECE_LIMIT');
    const source = next.sources.find(item => item.id === action.sourceId);
    if (!source) fail(`Unknown source: ${String(action.sourceId)}.`, 'INVALID_SOURCE');
    const polygon = validatePolygon(action.polygon, source, next.rules);
    // Make numerical validity independent of whether prior cuts exist.
    triangulate(polygon);
    for (const piece of next.pieces) {
      if (piece.sourceId === source.id && polygonsOverlap(polygon, piece.polygon)) {
        fail(`This cut overlaps material already used by ${piece.id}.`, 'MATERIAL_OVERLAP');
      }
    }
    let pieceId = action.pieceId;
    if (pieceId !== undefined) {
      text(pieceId, 'Piece ID', 128);
      if (next.pieces.some(piece => piece.id === pieceId)) fail(`Piece ID ${pieceId} is already in use.`);
    } else {
      let number = 1;
      while (next.pieces.some(piece => piece.id === `piece-${number}`)) number++;
      pieceId = `piece-${number}`;
    }
    next.pieces.push({
      id: pieceId,
      sourceId: source.id,
      polygon,
      bounds: polygonBounds(polygon),
      x: next.canvas.width / 2,
      y: next.canvas.height / 2,
      rotation: 0,
      scale: Math.max(next.rules.minScale, Math.min(1, next.rules.maxScale)),
      visible: false,
    });
  } else if (action.type === 'describe') {
    if (!owns(action, 'title') && !owns(action, 'statement')) fail('Describe needs a title or statement.');
    if (owns(action, 'title')) next.title = text(action.title, 'Title', 160);
    if (owns(action, 'statement')) next.statement = text(action.statement, 'Statement', 4000, true);
  } else {
    const index = next.pieces.findIndex(piece => piece.id === action.pieceId);
    if (index < 0) fail(`Unknown piece: ${String(action.pieceId)}.`);
    const piece = next.pieces[index];
    if (action.type === 'place') {
      if (!owns(action, 'x') || !owns(action, 'y')) fail('Place needs both x and y canvas coordinates.');
      updatePlacement(piece, action, next.canvas, next.rules);
      piece.visible = true;
    } else if (action.type === 'transform') {
      if (!['x', 'y', 'rotation', 'scale'].some(key => owns(action, key))) fail('Transform needs a position, rotation, or scale.');
      updatePlacement(piece, action, next.canvas, next.rules);
    } else if (action.type === 'remove') {
      piece.visible = false;
    } else if (action.type === 'reorder') {
      if (!Number.isInteger(action.index) || action.index < 0 || action.index >= next.pieces.length) {
        fail(`Layer index must be an integer from 0 to ${next.pieces.length - 1}.`);
      }
      next.pieces.splice(index, 1);
      next.pieces.splice(action.index, 0, piece);
    }
  }
  next.actionCount++;
  return next;
}
