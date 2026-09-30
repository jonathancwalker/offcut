import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const require = createRequire(import.meta.url);
let sharpModule;

/** Use the normal project dependency, or Codex's bundled image runtime. */
export function getSharp() {
  if (sharpModule) return sharpModule;
  const candidates = [
    'sharp',
    ...(process.env.WORKSPACE_NODE_MODULES ? [join(process.env.WORKSPACE_NODE_MODULES, 'sharp')] : []),
    ...(process.env.NODE_PATH || '').split(delimiter).filter(Boolean).map(path => join(path, 'sharp')),
    join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp'),
  ];
  for (const candidate of candidates) {
    try { sharpModule = require(candidate); return sharpModule; } catch {}
  }
  throw new Error('Image support needs sharp. Install dependencies with npm install, then restart the worktable.');
}

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
const number = value => {
  if (!Number.isFinite(value)) throw new Error('The composition contains an invalid coordinate.');
  return Number(value.toFixed(6));
};

/** Render original source pixels, clipped into polygons. No image generation or filters. */
export function renderSVG(state, { width: outputWidth = state.canvas.width, height: outputHeight = state.canvas.height } = {}) {
  const { width, height, background } = state.canvas;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) {
    throw new Error('Invalid canvas dimensions.');
  }
  if (!/^#[0-9a-f]{6}$/i.test(background)) throw new Error('Invalid canvas background.');
  if (![outputWidth, outputHeight].every(value => Number.isInteger(value) && value >= 1 && value <= 8192)) {
    throw new Error('Invalid render dimensions.');
  }
  const sourceMap = new Map(state.sources.map(source => [source.id, source]));
  const sourceDefinitions = new Map();
  const fragments = state.pieces.filter(piece => piece.visible).map((piece, index) => {
    const source = sourceMap.get(piece.sourceId);
    if (!source || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(source.dataUrl || '')) {
      throw new Error('Every fragment must refer to an embedded raster source.');
    }
    if (!sourceDefinitions.has(source.id)) {
      sourceDefinitions.set(source.id, { id: `material-${sourceDefinitions.size}`, source });
    }
    const bounds = piece.bounds;
    const points = piece.polygon.map(([x, y]) => `${number(x - bounds.x)},${number(y - bounds.y)}`).join(' ');
    const transform = `translate(${number(piece.x)} ${number(piece.y)}) rotate(${number(piece.rotation)}) scale(${number(piece.scale)}) translate(${number(-bounds.width / 2)} ${number(-bounds.height / 2)})`;
    return `<g data-piece-id="${escape(piece.id)}" transform="${transform}"><defs><clipPath id="fragment-${index}" clipPathUnits="userSpaceOnUse"><polygon points="${points}"/></clipPath></defs><g clip-path="url(#fragment-${index})"><use href="#${sourceDefinitions.get(source.id).id}" x="${number(-bounds.x)}" y="${number(-bounds.y)}"/></g></g>`;
  });
  const definitions = [...sourceDefinitions.values()].map(({ id, source }) => `<image id="${id}" width="${number(source.width)}" height="${number(source.height)}" href="${escape(source.dataUrl)}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${width} ${height}"><title>${escape(state.title || 'Untitled collage')}</title><desc>${escape(state.statement || 'Made entirely from the supplied source material.')}</desc><defs>${definitions}</defs><rect width="${width}" height="${height}" fill="${background}"/>${fragments.join('')}</svg>`;
}

export async function renderPNG(state) {
  return getSharp()(Buffer.from(renderSVG(state)), { limitInputPixels: 8192 * 8192 }).png().toBuffer();
}
