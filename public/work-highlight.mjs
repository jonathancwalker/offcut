// Observer-only geometry. Nothing in this module changes the saved composition
// or adds raster sources to the viewer or any export.
export function placedPolygon(piece) {
  const radians = piece.rotation * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const centerX = piece.bounds.x + piece.bounds.width / 2;
  const centerY = piece.bounds.y + piece.bounds.height / 2;
  return piece.polygon.map(([x, y]) => {
    const localX = (x - centerX) * piece.scale;
    const localY = (y - centerY) * piece.scale;
    return [piece.x + localX * cos - localY * sin, piece.y + localX * sin + localY * cos];
  });
}

export function outlineForAction(previous, frame, action) {
  if (!previous || !frame || !['place', 'transform', 'reorder', 'trim'].includes(action?.type)) return null;
  const index = frame.pieces.findIndex(piece => piece.id === (action.type === 'trim' ? action.newPieceId : action.pieceId));
  const piece = frame.pieces[index];
  if (!piece?.visible) return null;
  const before = previous.pieces.find(item => item.id === piece.id);
  const moved = !before?.visible || ['x', 'y', 'rotation', 'scale'].some(key => before[key] !== piece[key]);
  const visibleIndex = state => state.pieces.filter(item => item.visible).findIndex(item => item.id === piece.id);
  if (!moved && visibleIndex(previous) === visibleIndex(frame)) return null;
  return {
    pieceId: piece.id,
    polygon: placedPolygon(piece),
    occluders: frame.pieces.slice(index + 1).filter(item => item.visible).map(item => ({ pieceId: item.id, polygon: placedPolygon(item) })),
  };
}

// object-fit: contain can letterbox within the image element itself, as well as
// within the surrounding responsive stage.
export function imageContentRect(rect, naturalWidth, naturalHeight) {
  const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
  const width = naturalWidth * scale, height = naturalHeight * scale;
  return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height };
}

const SVG = 'http://www.w3.org/2000/svg';
const points = polygon => polygon.map(point => point.join(',')).join(' ');
function element(tag, attributes = {}) {
  const item = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, String(value));
  return item;
}

export function createPieceHighlight(stage, overlay) {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let timer, animation, generation = 0;
  function clear() {
    generation++;
    clearTimeout(timer);
    animation?.cancel();
    animation = null;
    overlay.setAttribute('hidden', '');
    overlay.replaceChildren();
    delete overlay.dataset.pieceId;
    delete overlay.dataset.step;
  }
  function align() {
    if (overlay.hasAttribute('hidden')) return;
    const image = stage.querySelector('#work-canvas');
    if (!image?.naturalWidth) return;
    const imageRect = imageContentRect(image.getBoundingClientRect(), image.naturalWidth, image.naturalHeight);
    const stageRect = stage.getBoundingClientRect();
    Object.assign(overlay.style, {
      left: `${imageRect.x - stageRect.x - stage.clientLeft}px`,
      top: `${imageRect.y - stageRect.y - stage.clientTop}px`,
      width: `${imageRect.width}px`, height: `${imageRect.height}px`,
    });
  }
  const resize = new ResizeObserver(align);
  resize.observe(stage);
  function motionChanged() {
    // Keep the same short lifetime, but stop an in-flight fade immediately.
    if (reducedMotion.matches) { animation?.cancel(); animation = null; }
  }
  reducedMotion.addEventListener('change', motionChanged);
  return {
    clear,
    show(outline, canvas, step) {
      clear();
      if (!outline || document.hidden) return;
      const token = generation;
      const maskId = `${overlay.id}-visible`;
      overlay.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
      const mask = element('mask', { id: maskId, maskUnits: 'userSpaceOnUse', maskContentUnits: 'userSpaceOnUse', x: 0, y: 0, width: canvas.width, height: canvas.height, 'mask-type': 'luminance' });
      mask.append(element('rect', { width: canvas.width, height: canvas.height, fill: 'white' }));
      for (const cover of outline.occluders) mask.append(element('polygon', { points: points(cover.polygon), fill: 'black', 'data-occluder': cover.pieceId }));
      const definitions = element('defs'); definitions.append(mask);
      const boundary = element('polygon', { points: points(outline.polygon), class: 'changed-piece-boundary', mask: `url(#${maskId})`, 'vector-effect': 'non-scaling-stroke' });
      overlay.replaceChildren(definitions, boundary);
      overlay.dataset.pieceId = outline.pieceId;
      overlay.dataset.step = step;
      overlay.removeAttribute('hidden');
      align();
      if (!reducedMotion.matches) animation = overlay.animate([{ opacity: 1, offset: 0 }, { opacity: 1, offset: .3 }, { opacity: 0, offset: 1 }], { duration: 750, fill: 'forwards' });
      timer = setTimeout(() => { if (token === generation) clear(); }, 750);
    },
    destroy() { clear(); resize.disconnect(); reducedMotion.removeEventListener('change', motionChanged); },
  };
}
