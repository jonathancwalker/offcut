function shapePath(piece) {
  const path = new Path2D();
  for (const ring of [piece.polygon,...(piece.holes || [])]) {
    ring.forEach(([x,y],i) => i ? path.lineTo(x,y) : path.moveTo(x,y));
    path.closePath();
  }
  return path;
}

function place(ctx,piece) {
  ctx.translate(piece.x,piece.y);
  ctx.rotate(piece.rotation * Math.PI / 180);
  ctx.scale(piece.scale,piece.scale);
  ctx.translate(-piece.bounds.x - piece.bounds.width / 2,-piece.bounds.y - piece.bounds.height / 2);
}

/** One synchronous paint from decoded source images; no frame replacement or flashing.
 * Painting the outline alongside its piece lets later pieces occlude it naturally. */
export function drawFrame(canvas, frame, images, action, {outline = false} = {}) {
  if (canvas.width !== frame.canvas.width) canvas.width = frame.canvas.width;
  if (canvas.height !== frame.canvas.height) canvas.height = frame.canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = frame.canvas.background;
  ctx.fillRect(0,0,canvas.width,canvas.height);
  const sources = new Map(frame.sources.map(source => [source.id,source]));
  const changed = action?.type === 'trim' ? action.newPieceId : action?.pieceId;
  for (const piece of frame.pieces) {
    if (!piece.visible) continue;
    const source = sources.get(piece.sourceId), image = images.get(piece.sourceId), path = shapePath(piece);
    ctx.save();place(ctx,piece);ctx.clip(path,'evenodd');
    ctx.drawImage(image,0,0,source.width,source.height);ctx.restore();
    if (outline && piece.id === changed && ['place','transform','trim','reorder'].includes(action?.type)) {
      ctx.save();place(ctx,piece);ctx.strokeStyle='#bf5f39';ctx.lineWidth=2.5/piece.scale;ctx.stroke(path);ctx.restore();
    }
  }
}
