import { createState, applyAction, polygonBounds, polygonArea, pieceRings, usablePieceCount } from '/engine.mjs';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
let live = null;
let shown = null;
let frames = [];
let selectedId = null;
let replayStep = null;
let playTimer = null;
let sourceId = null;
let cutTool = 'rectangle';
let cutPoints = [];
let cutStart = null;
let polygonComplete = false;
let drag = null;
let busy = false;
let revision = null;
let toastTimer;
let pendingDescription = null;
let infoReturnFocus = null;
let cutReturnFocus = null;

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => $('toast').hidden = true, error ? 6500 : 3300);
}

async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The studio could not complete that action.');
  return result;
}

function accept(envelope) {
  const inventoryChanged = !live || live.state.id !== envelope.state.id || live.state.sources.length !== envelope.state.sources.length || live.state.sources.some((source, index) => ['id','name','dataUrl','credit','license','url','width','height'].some(key => source[key] !== envelope.state.sources[index]?.[key]));
  live = envelope;
  revision = envelope.revision;
  if (inventoryChanged) $('sources').dataset.signature = '';
  let frame = createState({sources:live.state.sources, rules:live.state.rules, canvas:live.state.canvas, id:live.state.id});
  frames = [frame];
  for (const record of live.history) { frame = applyAction(frame, record.action); frames.push(frame); }
  if (replayStep !== null) replayStep = Math.min(replayStep, live.history.length);
  shown = replayStep === null ? live.state : frames[replayStep];
  render();
}

async function mutate(path, body) {
  if (busy) return false;
  if (replayStep !== null && path === '/api/actions') { toast('Return to the live worktable to make changes.'); return false; }
  busy = true;
  try {
    const envelope = await request(path, body);
    accept(envelope);
    $('save-status').textContent = 'Saved locally';
    return true;
  } catch (error) {
    toast(error.message, true);
    render();
    return false;
  } finally {
    busy = false;
    if (pendingDescription) {
      const description = pendingDescription;
      pendingDescription = null;
      if (description.title !== live.state.title || description.statement !== live.state.statement) await act({type:'describe',...description});
    }
  }
}
const act = action => mutate('/api/actions', Array.isArray(action) ? {actions:action} : action);

function transformed(piece) {
  return `translate(${piece.x} ${piece.y}) rotate(${piece.rotation}) scale(${piece.scale}) translate(${-piece.bounds.width/2} ${-piece.bounds.height/2})`;
}

function pieceShape(piece, attributes='', offset={x:0,y:0}) {
  const points = ring => ring.map(([x,y]) => `${x-offset.x},${y-offset.y}`);
  if (piece.holes?.length) return `<path d="${pieceRings(piece).map(ring=>`M${points(ring).join('L')}Z`).join('')}" fill-rule="evenodd" clip-rule="evenodd" ${attributes}/>`;
  return `<polygon points="${points(piece.polygon).join(' ')}" ${attributes}/>`;
}

function pieceSVG(piece, state, prefix, interactive = false) {
  const source = state.sources.find(s => s.id === piece.sourceId);
  if (!source) return '';
  const b = piece.bounds;
  const clip = `${prefix}-${state.pieces.indexOf(piece)}`;
  return `<g ${interactive ? `data-fragment="${escape(piece.id)}" transform="${transformed(piece)}"` : ''}><defs><clipPath id="${escape(clip)}">${pieceShape(piece,'',b)}</clipPath></defs><g clip-path="url(#${escape(clip)})" pointer-events="none"><image x="${-b.x}" y="${-b.y}" width="${source.width}" height="${source.height}" href="${source.dataUrl}"/></g>${interactive ? pieceShape(piece,`class="piece-hit" data-piece="${escape(piece.id)}" tabindex="0" role="button" aria-label="Select fragment from ${escape(source.name)}" fill="transparent"`,b) : ''}</g>`;
}

function miniature(piece, prefix='mini') {
  return `<svg viewBox="0 0 ${piece.bounds.width} ${piece.bounds.height}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${pieceSVG(piece, shown, prefix)}</svg>`;
}

function sourceMetadata(source) {
  const rows = [['Size', `${source.width} × ${source.height} px`], ['Credit', source.credit], ['License', source.license]];
  const url = /^https?:\/\//i.test(source.url || '') ? source.url : null;
  return `<dl class="metadata-list">${rows.filter(([, value]) => value).map(([label, value]) => `<dt>${label}</dt><dd>${escape(value)}</dd>`).join('')}${url ? `<dt>Original</dt><dd><a href="${escape(url)}" target="_blank" rel="noopener noreferrer">View source ↗</a></dd>` : ''}</dl>`;
}

function renderSources() {
  const query = $('source-search').value.trim().toLocaleLowerCase();
  const filter = $('source-filter').value;
  const sort = $('source-sort').value;
  const usage = new Map();
  for (const piece of shown.pieces) usage.set(piece.sourceId, (usage.get(piece.sourceId) || 0) + 1);
  const signature = JSON.stringify([shown.sources.map(s => [s.id, usage.get(s.id) || 0]), replayStep !== null, query, filter, sort]);
  const list = $('sources');
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  const scrollTop = list.scrollTop;
  const focused = list.contains(document.activeElement) ? {id:document.activeElement.dataset.source || document.activeElement.dataset.info, info:!!document.activeElement.dataset.info} : null;
  let sources = shown.sources.filter(source => (!query || `${source.name} ${source.credit || ''}`.toLocaleLowerCase().includes(query)) && (filter === 'all' || (filter === 'used' ? usage.has(source.id) : !usage.has(source.id))));
  if (sort === 'name') sources = [...sources].sort((a,b) => a.name.localeCompare(b.name));
  $('source-count').textContent = sources.length === shown.sources.length ? shown.sources.length : `${sources.length} / ${shown.sources.length}`;
  list.innerHTML = sources.length ? sources.map(source => {
    const count = usage.get(source.id) || 0;
    return `<article class="source-tile"><button class="source-card" data-source="${escape(source.id)}" title="${escape(source.name)}" aria-label="Cut from ${escape(source.name)}" ${replayStep !== null ? 'disabled' : ''}><div class="source-preview"><img src="${source.dataUrl}" alt="" loading="lazy">${count ? `<span class="source-usage">${count} cut${count===1?'':'s'}</span>` : ''}</div><div class="source-name">${escape(source.name)}</div></button><button class="source-info" data-info="${escape(source.id)}" aria-label="Details for ${escape(source.name)}" title="Image details">ⓘ</button></article>`;
  }).join('') : `<p class="empty-materials">${shown.sources.length ? 'No matching materials' : 'Add images to begin'}</p>`;
  list.querySelectorAll('[data-source]').forEach(button => button.addEventListener('click', () => openSource(button.dataset.source)));
  list.querySelectorAll('[data-info]').forEach(button => button.addEventListener('click', () => {
    const source = shown.sources.find(s => s.id === button.dataset.info);
    info(source.name, `<img class="metadata-preview" src="${source.dataUrl}" alt="${escape(source.name)}">${sourceMetadata(source)}`);
  }));
  list.scrollTop = scrollTop;
  if (focused) [...list.querySelectorAll(focused.info ? '[data-info]' : '[data-source]')].find(button => (button.dataset.info || button.dataset.source) === focused.id)?.focus({preventScroll:true});
}

function fitCanvas() {
  if (!shown) return;
  const table = $('worktable');
  const style = getComputedStyle(table);
  const width = table.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = table.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  $('canvas-shell').style.width = `${Math.max(0, Math.min(width, height * shown.canvas.width / shown.canvas.height))}px`;
}
new ResizeObserver(fitCanvas).observe($('worktable'));

function renderCanvas() {
  const canvas = $('composition');
  canvas.setAttribute('viewBox', `0 0 ${shown.canvas.width} ${shown.canvas.height}`);
  $('canvas-shell').style.aspectRatio = `${shown.canvas.width}/${shown.canvas.height}`;
  $('canvas-shell').style.background = shown.canvas.background;
  fitCanvas();
  $('canvas-size').textContent = `${shown.canvas.width} × ${shown.canvas.height}`;
  canvas.innerHTML = `<title>${escape(shown.title)}</title><rect width="${shown.canvas.width}" height="${shown.canvas.height}" fill="${shown.canvas.background}"/>${shown.pieces.filter(p => p.visible).map(p => pieceSVG(p,shown,'main',true)).join('')}`;
  const piece = shown.pieces.find(p => p.id === selectedId && p.visible);
  if (piece && replayStep === null) {
    const b = piece.bounds;
    canvas.insertAdjacentHTML('beforeend', `<g class="selection-outline" transform="${transformed(piece)}">${piece.holes?.length ? pieceShape(piece,'stroke-dasharray="6 4"',b) : `<rect x="0" y="0" width="${b.width}" height="${b.height}" stroke-dasharray="6 4"/>`}</g>`);
  }
  $('empty-canvas').hidden = shown.pieces.some(p => p.visible);
  $('canvas-help').textContent = replayStep !== null ? 'Replay · editing paused' : piece ? 'Drag to move' : shown.pieces.some(p=>p.visible) ? 'Select a fragment' : 'Choose a material';
  $('deselect-button').hidden = !piece;
}

function renderInspector() {
  const focusedField = document.activeElement?.id?.startsWith('piece-') ? document.activeElement.id : null;
  const piece = shown.pieces.find(p => p.id === selectedId);
  const area = $('piece-inspector');
  document.body.classList.toggle('has-selection', !!piece);
  $('inspector-dismiss').hidden = !piece;
  if (!piece) {
    $('inspector-title').textContent = 'Properties';
    area.innerHTML = '<div class="inspector-empty"><p>Select a fragment</p></div>';
    return;
  }
  const source = shown.sources.find(s=>s.id===piece.sourceId);
  const disabled = replayStep !== null || piece.supersededBy ? 'disabled' : '';
  const relatedName = id => `Fragment ${String(shown.pieces.findIndex(item=>item.id===id)+1).padStart(2,'0')}`;
  const lineage = piece.supersededBy ? piece.childPieceIds?.length > 1 ? `Cut into ${piece.childPieceIds.length} fragments` : `Recut as ${relatedName(piece.supersededBy)}` : piece.parentPieceId ? `${piece.trimRole === 'offcut' ? 'Offcut' : 'Cut'} from ${relatedName(piece.parentPieceId)}` : '';
  $('inspector-title').textContent = `Fragment ${String(shown.pieces.indexOf(piece)+1).padStart(2,'0')}`;
  area.innerHTML = `<div class="piece-preview">${miniature(piece,'inspector')}</div><div class="piece-origin"><span class="origin-name" title="${escape(source.name)}">${escape(source.name)}</span>${lineage ? `<span class="origin-name">${lineage}</span>` : ''}<button id="trace-source" class="text-button">View source ↗</button></div><div class="transform-fields"><label>X<input id="piece-x" type="number" min="0" max="${shown.canvas.width}" value="${Math.round(piece.x)}" ${disabled}></label><label>Y<input id="piece-y" type="number" min="0" max="${shown.canvas.height}" value="${Math.round(piece.y)}" ${disabled}></label><label>Rotation °<input id="piece-rotation" type="number" step="5" value="${Math.round(piece.rotation)}" ${disabled}></label><label>Scale %<input id="piece-scale" type="number" min="${shown.rules.minScale*100}" max="${shown.rules.maxScale*100}" step="5" value="${Math.round(piece.scale*100)}" ${disabled}></label></div><div class="piece-actions"><button id="send-back" class="secondary-button" ${disabled}>Back ↓</button><button id="bring-front" class="secondary-button" ${disabled}>Front ↑</button></div><button id="remove-piece" class="text-button remove-button" ${disabled}>${piece.supersededBy ? 'Recut' : piece.visible ? 'Move to tray' : 'Place on canvas'}</button>`;
  $('trace-source').addEventListener('click',()=>openSource(piece.sourceId,piece));
  ['x','y','rotation','scale'].forEach(field => $(`piece-${field}`).addEventListener('blur',e => {
    if (piece.supersededBy || replayStep !== null) return;
    const value = Number(e.target.value) / (field==='scale' ? 100 : 1);
    if (!e.target.value.trim() || !Number.isFinite(value)) {renderInspector();return;}
    if (value !== piece[field]) act({type:'transform',pieceId:piece.id,[field]:value});
  }));
  $('send-back').addEventListener('click',()=>act({type:'reorder',pieceId:piece.id,index:0}));
  $('bring-front').addEventListener('click',()=>act({type:'reorder',pieceId:piece.id,index:shown.pieces.length-1}));
  $('remove-piece').addEventListener('click',()=>act(piece.visible ? {type:'remove',pieceId:piece.id} : {type:'place',pieceId:piece.id,x:shown.canvas.width/2,y:shown.canvas.height/2}));
  if (focusedField) $(focusedField)?.focus({preventScroll:true});
}

function actionCaption(record) {
  if (!record) return 'Before the first cut';
  const a = record.action;
  const source = shown.sources.find(s=>s.id===a.sourceId);
  const verbs = {cut:`Cut · ${source?.name || 'Source'}`,trim:'Recut fragment',place:'Place fragment',transform:'Transform fragment',reorder:'Reorder layers',remove:'Move to tray',describe:'Update title or statement'};
  return `${String(record.index).padStart(2,'0')} / ${verbs[a.type] || a.type}`;
}

function render() {
  if (!shown) return;
  if (!shown.pieces.some(p=>p.id===selectedId)) selectedId = null;
  document.body.classList.toggle('replaying',replayStep!==null);
  if (!pendingDescription && document.activeElement !== $('composition-title')) $('composition-title').value = shown.title;
  if (!pendingDescription && document.activeElement !== $('statement')) $('statement').value = shown.statement;
  $('composition-title').disabled = replayStep !== null;
  $('statement').disabled = replayStep !== null;
  $('upload-button').disabled = $('upload-more').disabled = replayStep !== null;
  $('first-cut').disabled = replayStep !== null;
  $('undo-button').disabled = !live.canUndo || replayStep !== null;
  $('redo-button').disabled = !live.canRedo || replayStep !== null;
  $('timeline').max = live.history.length;
  $('timeline').value = replayStep ?? live.cursor;
  $('timeline').disabled = !live.history.length;
  $('step-label').textContent = replayStep === null ? `${live.cursor} action${live.cursor===1?'':'s'}` : `Step ${replayStep} of ${live.history.length}`;
  $('live-button').hidden = replayStep === null;
  $('replay-button').disabled = !live.history.length;
  $('action-caption').textContent = live.history.length ? actionCaption(live.history[(replayStep??live.cursor)-1]) : 'No actions yet';
  $('piece-budget').textContent = `${usablePieceCount(shown)} / ${shown.rules.maxPieces}`;
  $('action-budget').textContent = `${shown.actionCount} / ${shown.rules.maxActions}`;
  $('piece-progress').style.width = `${usablePieceCount(shown)/shown.rules.maxPieces*100}%`;
  renderSources(); renderCanvas(); renderInspector();
  const tray = shown.pieces.filter(p=>!p.visible&&!p.supersededBy);
  $('tray-count').textContent = tray.length;
  $('tray').innerHTML = tray.length ? tray.map(p=>`<button class="tray-piece" data-tray="${escape(p.id)}" aria-label="Select ${p.trimRole === 'offcut' ? 'offcut' : 'fragment'} ${escape(p.id)} in tray">${miniature(p,'tray')}</button>`).join('') : '<p class="subtle">No unplaced fragments</p>';
  $('tray').querySelectorAll('[data-tray]').forEach(button => button.addEventListener('click',()=>{selectedId=button.dataset.tray;renderCanvas();renderInspector();}));
}

function svgPoint(svg,event) {
  const point = new DOMPoint(event.clientX,event.clientY).matrixTransform(svg.getScreenCTM().inverse());
  return [point.x,point.y];
}

$('composition').addEventListener('pointerdown',event=>{
  if (replayStep !== null || busy || event.button!==0) return;
  const group = event.target.closest('[data-piece]');
  selectedId = group?.dataset.piece || null;
  renderCanvas();renderInspector();
  if (!selectedId) return;
  const piece = shown.pieces.find(p=>p.id===selectedId);
  drag = {id:piece.id,start:svgPoint($('composition'),event),original:{...piece},moved:false,pointerId:event.pointerId};
  $('composition').setPointerCapture(event.pointerId);
  event.preventDefault();
});
$('composition').addEventListener('pointermove',event=>{
  if (!drag) return;
  const point = svgPoint($('composition'),event);
  const x = clamp(drag.original.x+point[0]-drag.start[0],0,shown.canvas.width);
  const y = clamp(drag.original.y+point[1]-drag.start[1],0,shown.canvas.height);
  drag.preview = {...drag.original,x,y};
  drag.moved = drag.moved || Math.abs(x-drag.original.x)+Math.abs(y-drag.original.y)>2;
  const group = [...$('composition').querySelectorAll('[data-fragment]')].find(g=>g.dataset.fragment===drag.id);
  group?.setAttribute('transform',transformed(drag.preview));
  $('composition').querySelector('.selection-outline')?.setAttribute('transform',transformed(drag.preview));
});
$('composition').addEventListener('pointerup',()=>{
  if (!drag) return;
  const previous = drag;drag=null;
  if (previous.moved) act({type:'transform',pieceId:previous.id,x:Math.round(previous.preview.x),y:Math.round(previous.preview.y)});
});
$('composition').addEventListener('pointercancel',()=>{drag=null;renderCanvas();});
$('composition').addEventListener('keydown',event=>{
  if (['Enter',' '].includes(event.key) && event.target.dataset.piece) {event.preventDefault();selectedId=event.target.dataset.piece;renderCanvas();renderInspector();}
});
$('deselect-button').addEventListener('click',()=>{selectedId=null;renderCanvas();renderInspector();});
$('inspector-dismiss').addEventListener('click',()=>{const previous=selectedId;selectedId=null;renderCanvas();renderInspector();([...$('composition').querySelectorAll('[data-piece]')].find(piece=>piece.dataset.piece===previous)||$('composition')).focus({preventScroll:true});});
$('source-search').addEventListener('input',renderSources);
['source-filter','source-sort'].forEach(id=>$(id).addEventListener('change',renderSources));
$('mobile-materials').addEventListener('click',()=>$('materials-panel').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'}));

function openSource(id, tracePiece) {
  cutReturnFocus = document.activeElement;
  sourceId=id;cutStart=null;cutPoints=[];polygonComplete=false;
  const source = shown.sources.find(s=>s.id===id);
  if (!source) return;
  $('cut-title').textContent=source.name;
  $('cut-credit').innerHTML=sourceMetadata(source);
  $('cut-dialog').querySelectorAll('details').forEach(details=>details.open=false);
  $('cut-x').max=source.width;$('cut-y').max=source.height;
  $('cut-width').value=Math.min(200,source.width);$('cut-height').value=Math.min(200,source.height);
  $('cut-x').value=0;$('cut-y').value=0;
  if (tracePiece) {cutPoints=tracePiece.polygon.map(p=>[...p]);polygonComplete=true;}
  $('cut-dialog').dataset.trace=tracePiece ? tracePiece.id : '';
  $('source-canvas').setAttribute('viewBox',`0 0 ${source.width} ${source.height}`);
  // Explicit aspect ratio keeps source coordinates stable in any dialog size.
  $('source-canvas').style.aspectRatio=`${source.width}/${source.height}`;
  $('source-canvas').style.maxWidth=`${48*source.width/source.height}vh`;
  renderCut();
  $('cut-dialog').showModal();
}

function renderCut() {
  const source=shown.sources.find(s=>s.id===sourceId);if(!source)return;
  const svg=$('source-canvas');
  const used=shown.pieces.filter(p=>p.sourceId===sourceId&&!p.parentPieceId);
  const line=Math.max(source.width,source.height)/350;
  svg.innerHTML=`<image href="${source.dataUrl}" width="${source.width}" height="${source.height}"/><defs><pattern id="used-material" width="20" height="20" patternUnits="userSpaceOnUse"><rect width="20" height="20" fill="#faf9f6" fill-opacity=".82"/><path d="M-5 5L5-5M0 20L20 0M15 25L25 15" stroke="#a7aaa2" stroke-width="1.5"/></pattern></defs>${used.map(p=>`<polygon points="${p.polygon.map(v=>v.join(',')).join(' ')}" fill="url(#used-material)" stroke="#8c9187" stroke-width="${line}"/>`).join('')}`;
  const tracedPiece=shown.pieces.find(piece=>piece.id===$('cut-dialog').dataset.trace);
  if(tracedPiece?.holes?.length){
    svg.insertAdjacentHTML('beforeend',pieceShape(tracedPiece,`data-trace-piece="${escape(tracedPiece.id)}" fill="#d34d3226" stroke="#d34d32" stroke-width="${line*1.5}" stroke-dasharray="${line*3} ${line*2}"`));
  } else if(cutPoints.length){
    const closed=cutTool==='rectangle'||polygonComplete;
    svg.insertAdjacentHTML('beforeend',`<${closed?'polygon':'polyline'} points="${cutPoints.map(p=>p.join(',')).join(' ')}" fill="${closed?'#d34d3226':'none'}" stroke="#d34d32" stroke-width="${line*1.5}" stroke-dasharray="${line*3} ${line*2}"/>${cutTool==='polygon'?cutPoints.map((p,i)=>`<circle cx="${p[0]}" cy="${p[1]}" r="${line*(i===0?3:2)}" fill="${i===0?'#faf9f6':'#d34d32'}" stroke="#d34d32" stroke-width="${line}"/>`).join(''):''}`);
  }
  const area=cutPoints.length>=3?polygonArea(cutPoints):0;
  const trace=!!$('cut-dialog').dataset.trace;
  $('commit-cut').disabled=trace||replayStep!==null||cutPoints.length<3||area<shown.rules.minArea;
  $('cut-instruction').textContent=trace?'Source fragment':cutTool==='rectangle'?'Drag to select':'Click corners. Click the first to close.';
  if(trace) $('cut-measurement').textContent='Material used by this fragment';
  else if(area){const b=polygonBounds(cutPoints);$('cut-measurement').textContent=`${Math.round(b.width)} × ${Math.round(b.height)} px · ${cutPoints.length} points`;}
  else $('cut-measurement').textContent='Hatched areas are used';
  $('rectangle-tool').classList.toggle('active',cutTool==='rectangle');$('polygon-tool').classList.toggle('active',cutTool==='polygon');
  $('rectangle-tool').setAttribute('aria-pressed',cutTool==='rectangle');$('polygon-tool').setAttribute('aria-pressed',cutTool==='polygon');
}
function clearCut(){cutPoints=[];cutStart=null;polygonComplete=false;$('cut-dialog').dataset.trace='';renderCut();}
['rectangle','polygon'].forEach(tool=>$(`${tool}-tool`).addEventListener('click',()=>{cutTool=tool;clearCut();}));
$('clear-cut').addEventListener('click',clearCut);
$('source-canvas').addEventListener('pointerdown',event=>{
  if(event.button!==0||replayStep!==null)return;
  const source=shown.sources.find(s=>s.id===sourceId);
  const point=svgPoint($('source-canvas'),event).map((n,i)=>clamp(Math.round(n),0,i?source.height:source.width));
  $('cut-dialog').dataset.trace='';
  if(cutTool==='rectangle'){cutStart=point;cutPoints=[];$('source-canvas').setPointerCapture(event.pointerId);}
  else {
    if(polygonComplete){cutPoints=[];polygonComplete=false;}
    const first=cutPoints[0];
    if(cutPoints.length>=3&&Math.hypot(point[0]-first[0],point[1]-first[1])<Math.max(source.width,source.height)/35)polygonComplete=true;
    else if(cutPoints.length<shown.rules.maxVertices)cutPoints.push(point);
    else toast(`Use at most ${shown.rules.maxVertices} corners in one cut.`,true);
  }
  renderCut();event.preventDefault();
});
$('source-canvas').addEventListener('pointermove',event=>{
  if(!cutStart)return;
  const source=shown.sources.find(s=>s.id===sourceId);
  const p=svgPoint($('source-canvas'),event).map((n,i)=>clamp(Math.round(n),0,i?source.height:source.width));
  const x=Math.min(cutStart[0],p[0]),y=Math.min(cutStart[1],p[1]);
  const w=Math.abs(cutStart[0]-p[0]),h=Math.abs(cutStart[1]-p[1]);
  cutPoints=[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
  $('cut-x').value=x;$('cut-y').value=y;$('cut-width').value=w;$('cut-height').value=h;
  renderCut();
});
$('source-canvas').addEventListener('pointerup',()=>{cutStart=null;});
$('source-canvas').addEventListener('pointercancel',()=>{cutStart=null;});
$('set-cut').addEventListener('click',()=>{
  const [x,y,w,h]=['x','y','width','height'].map(key=>Number($(`cut-${key}`).value));
  cutTool='rectangle';$('cut-dialog').dataset.trace='';cutPoints=[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];renderCut();
});
$('commit-cut').addEventListener('click',async()=>{
  if($('commit-cut').disabled||busy)return;
  const b=polygonBounds(cutPoints);const id=`piece-${crypto.randomUUID().slice(0,8)}`;
  const scale=clamp(Math.min(1,shown.canvas.width*.65/b.width,shown.canvas.height*.65/b.height),shown.rules.minScale,shown.rules.maxScale);
  const success=await act([{type:'cut',pieceId:id,sourceId,polygon:cutPoints},{type:'place',pieceId:id,x:shown.canvas.width/2,y:shown.canvas.height/2,scale,rotation:0}]);
  if(success){selectedId=id;$('cut-dialog').close();render();toast('Fragment added');}
});
$('first-cut').addEventListener('click',()=>shown.sources.length?openSource(shown.sources[0].id):$('source-input').click());

function stopReplay(){clearInterval(playTimer);playTimer=null;$('replay-button').textContent='▶ Play';}
function showStep(step){replayStep=step;shown=frames[step];selectedId=null;render();}
$('timeline').addEventListener('input',event=>{stopReplay();showStep(Number(event.target.value));});
$('live-button').addEventListener('click',()=>{stopReplay();replayStep=null;shown=live.state;render();});
$('replay-button').addEventListener('click',()=>{
  if(playTimer){stopReplay();return;}
  showStep(0);$('replay-button').textContent='Ⅱ Pause';
  playTimer=setInterval(()=>{if(replayStep>=live.history.length){stopReplay();return;}showStep(replayStep+1);},850);
});
$('undo-button').addEventListener('click',()=>mutate('/api/undo',{}));
$('redo-button').addEventListener('click',()=>mutate('/api/redo',{}));

async function saveDescription(){
  if(!live||replayStep!==null)return;
  const title=$('composition-title').value.trim()||'Untitled composition';
  const statement=$('statement').value;
  if(busy){pendingDescription={title,statement};return;}
  if(title!==live.state.title||statement!==live.state.statement)await act({type:'describe',title,statement});
}
$('composition-title').maxLength=160;
$('composition-title').addEventListener('blur',saveDescription);
$('statement').addEventListener('blur',saveDescription);

document.addEventListener('keydown',event=>{
  if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)||document.querySelector('dialog[open]'))return;
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'){
    event.preventDefault();if(replayStep===null)mutate(event.shiftKey?'/api/redo':'/api/undo',{});return;
  }
  const piece=shown?.pieces.find(p=>p.id===selectedId);
  if(!piece||replayStep!==null||busy)return;
  if(event.key==='Escape'){selectedId=null;renderCanvas();renderInspector();return;}
  if(piece.supersededBy)return;
  const offsets={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
  if(offsets[event.key]){event.preventDefault();const [dx,dy]=offsets[event.key];const n=event.shiftKey?10:1;act({type:'transform',pieceId:piece.id,x:clamp(piece.x+dx*n,0,shown.canvas.width),y:clamp(piece.y+dy*n,0,shown.canvas.height)});}
  if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();act({type:'remove',pieceId:piece.id});}
});

const fileData=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('This file could not be read.'));reader.readAsDataURL(file);});
['upload-button','upload-more'].forEach(id=>$(id).addEventListener('click',()=>$('source-input').click()));
$('source-input').addEventListener('change',async event=>{
  const files=[...event.target.files];
  for(const file of files){
    try {
      if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('Choose a PNG, JPEG, or WebP image.');
      if(file.size>16*1024*1024)throw new Error('Use an image smaller than 16 MB.');
      const success=await mutate('/api/sources',{name:file.name.replace(/\.[^.]+$/,'').slice(0,160),dataUrl:await fileData(file),credit:'Imported by you'});
      if(success)toast(`${file.name} added to your materials.`);
    }catch(error){toast(error.message,true);}
  }
  event.target.value='';
});
$('import-button').addEventListener('click',()=>$('project-input').click());
$('project-menu').addEventListener('click',event=>{if(event.target.closest('button'))$('project-menu').open=false;});
document.addEventListener('click',event=>{if(!$('project-menu').contains(event.target))$('project-menu').open=false;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&$('project-menu').open){$('project-menu').open=false;$('project-menu').querySelector('summary').focus();}});
$('project-input').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file)return;
  try{
    if(file.size>40*1024*1024)throw new Error('This project is too large (40 MB maximum).');
    const project=JSON.parse(await file.text());
    if(live.cursor>0&&!confirm('Open this project and replace the current worktable? Export your current project first if you want to keep it.'))return;
    stopReplay();replayStep=null;
    if(await mutate('/api/project',project))toast('Project opened');
  }catch(error){toast(error.message,true);}finally{event.target.value='';}
});

function info(title,html){infoReturnFocus=$('project-menu').contains(document.activeElement)?$('project-menu').querySelector('summary'):document.activeElement;$('project-menu').open=false;$('info-title').textContent=title;$('info-content').innerHTML=html;$('info-dialog').showModal();}
$('info-dialog').addEventListener('close',()=>{if(infoReturnFocus?.isConnected)infoReturnFocus.focus({preventScroll:true});});
$('cut-dialog').addEventListener('close',()=>{if(cutReturnFocus?.isConnected)cutReturnFocus.focus({preventScroll:true});else [...$('sources').querySelectorAll('[data-source]')].find(button=>button.dataset.source===sourceId)?.focus({preventScroll:true});});
document.querySelectorAll('.close-dialog').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}}));

function canvasDetails(){
  info('Canvas details',`<dl class="metadata-list"><dt>Size</dt><dd>${shown.canvas.width} × ${shown.canvas.height}</dd><dt>Usable fragments</dt><dd>${usablePieceCount(shown)} / ${shown.rules.maxPieces}</dd><dt>Actions</dt><dd>${shown.actionCount} / ${shown.rules.maxActions}</dd></dl><label class="statement-label" for="dialog-statement">Statement</label><textarea id="dialog-statement" class="statement-editor" rows="5" maxlength="4000" placeholder="Add a statement" ${replayStep!==null?'disabled':''}>${escape(shown.statement)}</textarea>`);
  $('dialog-statement').addEventListener('change',event=>{if(replayStep===null){$('statement').value=event.target.value;saveDescription();}});
}
$('canvas-details-button').addEventListener('click',canvasDetails);
$('canvas-size').addEventListener('click',canvasDetails);

$('export-button').addEventListener('click',async()=>{
  await saveDescription();
  const step=replayStep===null?'':`?step=${replayStep}`;
  info('Export',`<div class="info-actions"><a class="primary-button" href="/api/render.png${step}" download="offcut.png">PNG</a><a class="secondary-button" href="/api/render.svg${step}" download="offcut.svg">SVG</a><a class="secondary-button" href="/api/project" download="offcut-project.json">Project</a></div><p class="info-content-note">${replayStep===null?'':'Images export this replay step. '}Project includes source images and the complete history.</p>`);
});
$('agent-button').addEventListener('click',()=>{
  const base=location.origin;
  const prompt=`Use the Offcut collage environment at ${base}. Read ${base}/api/help and ${base}/api/state. Inspect the source images at /api/sources/:id. Invent your own concept from the supplied materials; there is no target image or prescribed theme. Create the artwork only through POST /api/actions. Do not add new sources or change the rules. Inspect /api/render.png as you work. Finish with a short title and artist statement using the describe action. Stay within the fragment and action budgets.`;
  info('Agent access',`<p>Give these instructions to an agent with access to this computer, or <a href="/experiments.html">run a model in Experiments</a>.</p><pre id="agent-prompt">${escape(prompt)}</pre><div class="info-actions"><button id="copy-agent" class="primary-button">Copy instructions</button><a class="secondary-button" href="/api/help" target="_blank" rel="noopener">Action reference ↗</a></div><p class="info-content-note">Local access only. Actions appear on the canvas as the agent works.</p>`);
  $('copy-agent').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(prompt);$('copy-agent').textContent='Copied ✓';}catch{toast('Select and copy the instructions above.');}});
});
$('rules-button').addEventListener('click',()=>info('Rules',`<ul><li>Cut rectangles or simple polygons with up to ${shown.rules.maxVertices} corners.</li><li>Each source area can be cut once. A piece in the tray still uses its material.</li><li>Recut a fragment into smaller pieces. Every offcut stays usable in the tray; the parent is retired.</li><li>Move, rotate, uniformly resize, layer, and remove pieces.</li><li>Up to ${shown.rules.maxPieces} fragments and ${shown.rules.maxActions} recorded actions. A cut and placement are two actions. A recut uses one action; every usable result counts toward the fragment limit, replacing its parent.</li><li>Minimum drawn selection: ${shown.rules.minArea} square source pixels. Generated scraps may be smaller. Size range: ${shown.rules.minScale*100}–${shown.rules.maxScale*100}%.</li><li>Source colors stay unchanged. The renderer adds a plain paper background.</li></ul><p class="info-content-note">Undo restores the earlier action budget. Editing after undo replaces the later history.</p><p class="info-content-note">The starter pack’s credits are included in every saved project. <a href="/sources/CREDITS.md" target="_blank">Source records ↗</a></p>`));
$('new-button').addEventListener('click',()=>{
  info('New canvas',`<p>Your source images will stay. The current composition and its action history will be cleared.</p><div class="info-actions"><a href="/api/project" download="offcut-project.json" class="secondary-button">Export project</a><button id="confirm-new" class="primary-button">Clear canvas</button></div>`);
  $('confirm-new').addEventListener('click',async()=>{stopReplay();replayStep=null;if(await mutate('/api/reset',{keepSources:true})){$('info-dialog').close();selectedId=null;render();toast('Canvas cleared');}});
});

async function initialize(){
  try{accept(await request('/api/state'));$('connection').innerHTML='<i></i>Saved locally';}
  catch(error){$('connection').textContent='Offline';toast(`Cannot reach the studio. ${error.message}`,true);}
}
await initialize();
setInterval(async()=>{
  if(busy||drag||document.hidden||$('cut-dialog').open||['INPUT','TEXTAREA'].includes(document.activeElement?.tagName))return;
  try{
    const status=await request('/api/status');
    const next=status.revision??status.updatedAt;
    if(revision!==null&&next!==revision){accept(await request('/api/state'));}
    revision=next;$('connection').innerHTML='<i></i>Saved locally';
  }catch{$('connection').textContent='Reconnecting…';}
},2500);
