import { pieceArea } from './engine.mjs';
import { getSharp, renderPieceLayerSVG } from './render.mjs';
import { union } from './vendor/polyclip.mjs';

export const COLLAGE_METRICS_VERSION = 1;
export const ALPHA_PIXEL_TOLERANCE = 1 / 255;
const ACTION_TYPES = Object.freeze(['cut', 'trim', 'place', 'transform', 'reorder', 'remove', 'describe']);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}

function ringArea(ring) {
  let twice = 0;
  for (let index = 0; index < ring.length; index++) {
    const next = ring[(index + 1) % ring.length];
    twice += ring[index][0] * next[1] - next[0] * ring[index][1];
  }
  return Math.abs(twice) / 2;
}

function multiPolygonArea(multiPolygon) {
  return multiPolygon.reduce((total, polygon) => total + ringArea(polygon[0]) - polygon.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0), 0);
}

function consumedArea(state, sources) {
  const rootsBySource = new Map(sources.map(source => [source.id, []]));
  for (const piece of state.pieces) {
    if (piece.parentPieceId) continue;
    if (!rootsBySource.has(piece.sourceId)) throw new Error(`Piece refers to unknown source ${String(piece.sourceId)}.`);
    rootsBySource.get(piece.sourceId).push([piece.polygon]);
  }
  return Object.fromEntries(sources.map(source => {
    const roots = rootsBySource.get(source.id);
    let area = 0;
    if (roots.length === 1) area = pieceArea({ polygon: roots[0][0] });
    else if (roots.length > 1) {
      try { area = multiPolygonArea(union(roots[0], ...roots.slice(1))); }
      catch { throw new Error(`Consumed cut geometry for source ${source.id} could not be united.`); }
    }
    return [source.id, area / (source.width * source.height)];
  }));
}

export function measureActionMix(acceptedActions = []) {
  if (!Array.isArray(acceptedActions)) throw new Error('Accepted actions must be an array.');
  const counts = Object.fromEntries(ACTION_TYPES.map(type => [type, 0]));
  for (const action of acceptedActions) {
    if (!object(action) || !ACTION_TYPES.includes(action.type)) throw new Error('Accepted actions contain an unknown action type.');
    counts[action.type]++;
  }
  const acceptedActionDenominator = acceptedActions.length;
  const geometricActionDenominator = acceptedActionDenominator - counts.describe;
  return {
    counts,
    acceptedActionDenominator,
    proportions: Object.fromEntries(ACTION_TYPES.map(type => [type, acceptedActionDenominator ? counts[type] / acceptedActionDenominator : null])),
    geometricActionDenominator,
    geometricProportions: Object.fromEntries(ACTION_TYPES.filter(type => type !== 'describe').map(type => [type, geometricActionDenominator ? counts[type] / geometricActionDenominator : null])),
  };
}

async function alphaMask(state, piece) {
  const svg = Buffer.from(renderPieceLayerSVG(state, piece));
  const { data, info } = await getSharp()(svg, { limitInputPixels: 8192 * 8192 })
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== state.canvas.width || info.height !== state.canvas.height || info.channels !== 1) {
    throw new Error('Fragment mask dimensions differ from the native canvas.');
  }
  return data;
}

function validateState(state) {
  if (!object(state) || !object(state.canvas) || !Array.isArray(state.sources) || !Array.isArray(state.pieces)) throw new Error('Expected a final collage state.');
  const { width, height } = state.canvas;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error('Invalid canvas dimensions.');
  const ids = new Set();
  for (const source of state.sources) {
    if (!object(source) || typeof source.id !== 'string' || !source.id || ids.has(source.id)
      || !Number.isInteger(source.width) || source.width < 1 || !Number.isInteger(source.height) || source.height < 1) throw new Error('Invalid source inventory.');
    ids.add(source.id);
  }
  for (const piece of state.pieces) {
    if (!object(piece) || typeof piece.id !== 'string' || !ids.has(piece.sourceId) || !Array.isArray(piece.polygon)) throw new Error('Invalid piece record.');
  }
}

/**
 * Measure one immutable final state. Masks are rasterized and discarded one at
 * a time, so memory is bounded by one alpha plane plus one transmittance plane.
 */
export async function analyzeCollage({ state, acceptedActions = [] }) {
  validateState(state);
  const sources = state.sources;
  const sourceById = new Map(sources.map(source => [source.id, source]));
  const usable = state.pieces.filter(piece => !piece.supersededBy);
  const placed = usable.filter(piece => piece.visible === true);
  const canvasArea = state.canvas.width * state.canvas.height;
  const remaining = new Float64Array(canvasArea);
  remaining.fill(1);
  const contributionById = new Map(usable.map(piece => [piece.id, 0]));

  // State order is back-to-front; attribution must start at the front.
  for (let index = placed.length - 1; index >= 0; index--) {
    const piece = placed[index];
    const mask = await alphaMask(state, piece);
    let contribution = 0;
    for (let pixel = 0; pixel < mask.length; pixel++) {
      const alpha = mask[pixel] / 255;
      const visible = alpha * remaining[pixel];
      contribution += visible;
      remaining[pixel] *= 1 - alpha;
    }
    contributionById.set(piece.id, contribution);
  }

  const sourceContribution = new Map(sources.map(source => [source.id, 0]));
  for (const piece of placed) sourceContribution.set(piece.sourceId, sourceContribution.get(piece.sourceId) + contributionById.get(piece.id));
  const totalContribution = [...contributionById.values()].reduce((sum, value) => sum + value, 0);
  const sourceShare = Object.fromEntries(sources.map(source => [source.id, totalContribution ? sourceContribution.get(source.id) / totalContribution : null]));
  let materialBreadth = null;
  let materialBreadthNormalized = null;
  if (totalContribution) {
    materialBreadth = -Object.values(sourceShare).reduce((sum, share) => share > 0 ? sum + share * Math.log(share) : sum, 0);
    materialBreadthNormalized = sources.length > 1 ? materialBreadth / Math.log(sources.length) : 0;
  }
  const placements = placed.map((piece, layer) => {
    const source = sourceById.get(piece.sourceId);
    const rotation = ((finite(piece.rotation, 'Piece rotation') % 360) + 360) % 360;
    return {
      sourceId: piece.sourceId,
      sourceAreaFraction: pieceArea(piece) / (source.width * source.height),
      centerX: finite(piece.x, 'Piece x') / state.canvas.width,
      centerY: finite(piece.y, 'Piece y') / state.canvas.height,
      scale: finite(piece.scale, 'Piece scale'),
      rotation,
      layer,
      contribution: contributionById.get(piece.id),
    };
  });
  const pieceContributions = usable.map(piece => ({
    sourceId: piece.sourceId,
    visible: piece.visible === true,
    contribution: contributionById.get(piece.id),
  }));
  const contributing = placed.filter(piece => contributionById.get(piece.id) >= 1);

  return {
    format: 'offcut-collage-metrics',
    version: COLLAGE_METRICS_VERSION,
    rasterization: { resolution: 'native-canvas', alphaLevels: 255, equivalentPixelThreshold: 1, toleranceEquivalentPixels: ALPHA_PIXEL_TOLERANCE },
    canvasArea,
    usablePieces: usable.length,
    placedPieces: placed.length,
    contributingPieces: contributing.length,
    pieceContributions,
    contributingSourceIds: [...new Set(contributing.map(piece => piece.sourceId))].sort(),
    consumedAreaBySource: consumedArea(state, sources),
    coverageArea: totalContribution,
    coverage: totalContribution / canvasArea,
    sourceContribution: Object.fromEntries(sources.map(source => [source.id, sourceContribution.get(source.id)])),
    sourceShare,
    materialBreadth,
    materialBreadthNormalized,
    placements,
    actionMix: measureActionMix(acceptedActions),
  };
}

export function materialReuseJaccard(first, second) {
  const a = new Set(first?.contributingSourceIds ?? []);
  const b = new Set(second?.contributingSourceIds ?? []);
  if (!a.size && !b.size) return null;
  let intersection = 0;
  for (const id of a) if (b.has(id)) intersection++;
  return intersection / new Set([...a, ...b]).size;
}
