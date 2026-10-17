import { createState, applyAction, polygonBounds, pieceRings, pieceArea, usablePieceCount } from '/engine.mjs';
import { createPieceHighlight, outlineForAction } from '/work-highlight.mjs';
import { actionSummary, traceSelection } from '/run-trace-view.mjs';

const $ = id => document.getElementById(id);
const pieceHighlight = createPieceHighlight($('work-stage'), $('work-change-outline'));
const SVG = 'http://www.w3.org/2000/svg';
const runId = new URL(location.href).searchParams.get('run');
const isArchive = Boolean(runId?.startsWith('archive-'));
const identity = runId ? `Work · ${isArchive ? `A${runId.slice('archive-'.length)}` : runId.replace(/^run-/, '').slice(0, 8)}` : 'Work';
const base = runId ? `/api/${isArchive ? 'archives' : 'runs'}/${encodeURIComponent(runId)}` : '';
const playbackRates = [0.5, 1, 2, 4, 8];
const playbackRateKey = 'offcut.playbackRate';
function savedPlaybackRate() {
  try { const rate = Number(localStorage.getItem(playbackRateKey)); if (playbackRates.includes(rate)) return rate; } catch { /* Playback also works when storage is unavailable. */ }
  return 2;
}
const state = { run:null, project:null, frames:[], fragments:[], trace:null, traceLoaded:false, traceLoading:false, step:0, playing:false, playbackRate:savedPlaybackRate(), playbackTimer:null, playbackVersion:0, pollTimer:null, refreshing:false, stopping:false, imageVersion:0, imageReady:Promise.resolve(), clipId:0, notesLoaded:false, notesLoading:false, dialogOpener:null };
const statusNames = { running:'Working', completed:'Completed', archived:'Archived', stopped:'Stopped', failed:'Failed', interrupted:'Interrupted', limit_reached:'Limit reached' };
const terminationMessages = {
  time_limit:'Time limit reached. The saved work and its playback are shown here.',
  action_limit:'Action limit reached. The saved work and its playback are shown here.',
  turn_limit:'Turn limit reached. The saved work and its playback are shown here.',
  context_limit:'Conversation limit reached. The saved work and its playback are shown here.',
  user_stopped:'Stopped before completion. The saved work and its playback are shown here.',
  server_restarted:'Interrupted by a server restart. The saved work and its playback are shown here.',
  server_closed:'Interrupted when the server closed. The saved work and its playback are shown here.',
  provider_or_runner_error:'The model run ended with an error. Any saved work is shown here.',
  persistence_error:'The model run stopped because its record could not be saved.',
};
const number = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—';
const date = value => { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString(undefined,{ month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' }); };
function node(tag, className, text) { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = String(text); return item; }
function svgNode(tag, attributes={}) { const item = document.createElementNS(SVG,tag); for (const [key,value] of Object.entries(attributes)) item.setAttribute(key,String(value)); return item; }
function fact(list,label,value) { if (value === undefined || value === null || value === '') return; const dd = node('dd'); dd.append(value instanceof Node ? value : String(value)); list.append(node('dt','',label),dd); }
function sourceName(id) { return state.project?.sources.find(source => source.id === id)?.name || 'Source image'; }
function fragmentName(id) { const fragment = state.fragments.find(item => item.piece.id === id); return fragment ? `Fragment ${String(fragment.ordinal).padStart(2,'0')}` : 'Fragment'; }
function childIds(piece) { return piece?.childPieceIds || (piece?.supersededBy ? [piece.supersededBy] : []); }
function fragmentOrigin(piece,compact=false) {
  if (!piece.parentPieceId) return sourceName(piece.sourceId);
  const parent = fragmentName(piece.parentPieceId);
  return piece.trimRole === 'offcut' ? compact ? `Offcut · ${parent.replace(/^Fragment /,'')}` : `Offcut from ${parent}` : `From ${parent}`;
}
function safeSourceLink(value) { try { const url = new URL(value); if (!['https:','http:'].includes(url.protocol)) return null; const link = node('a','',url.hostname); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link; } catch { return null; } }
async function request(path,{method='GET',body}={}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(),30000);
  try {
    const response = await fetch(path,{method,signal:controller.signal,cache:'no-store',...(body === undefined ? {} : {headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'This work could not be loaded.');
    return value;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The request timed out. Try again.');
    if (error instanceof TypeError) throw new Error('The local server is unavailable.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function showError(message) { $('error-message').textContent = message || ''; $('work-error').hidden = !message; }
function providerName(run) { const raw = run.provider?.name || run.provider?.id || run.spec?.provider || ''; return raw === 'openai' ? 'OpenAI' : raw; }
function renderSummary() {
  const run = state.run;
  $('work-identity').textContent = identity;
  document.title = `${identity} · Offcut`;
  $('work-provenance').textContent = [run.spec?.model || 'Model not recorded',providerName(run),date(run.createdAt)].filter(Boolean).join(' · ');
  $('work-status').textContent = statusNames[run.status] || 'Unavailable';
  $('work-status').dataset.status = run.status;
  $('work-status').hidden = false;
  if (run.status === 'running') {
    $('pending-work').hidden = false;
    $('pending-work').classList.remove('is-unavailable');
    $('pending-title').textContent = 'Working';
    $('pending-message').textContent = 'Return when it’s ready to see the work and its playback.';
    $('stop-work').hidden = false;
    $('stop-work').disabled = state.stopping;
    $('stop-work').textContent = state.stopping ? 'Stopping…' : 'Stop work';
    $('finished-work').hidden = true;
    $('download-menu').hidden = true;
  }
}
function makeFrames(project) {
  const cursor = Number.isInteger(project.cursor) ? project.cursor : project.actions.length;
  const frames = [createState({id:project.id,sources:project.sources,rules:project.rules,canvas:project.canvas})];
  const fragments = [];
  for (const [index,record] of project.actions.slice(0,cursor).entries()) {
    const previous = frames.at(-1);
    const next = applyAction(previous,record.action);
    // Images are immutable; every replay state can share the saved source inventory.
    next.sources = frames[0].sources;
    frames.push(next);
    if (['cut','trim'].includes(record.action.type)) {
      const existingIds = new Set(previous.pieces.map(piece => piece.id));
      for (const piece of next.pieces.filter(item => !existingIds.has(item.id))) {
        fragments.push({piece,cutStep:index + 1,ordinal:fragments.length + 1});
      }
    }
  }
  state.frames = frames;
  state.fragments = fragments;
}
function fragmentSVG(piece, source, {trace=false}={}) {
  const bounds = polygonBounds(piece.polygon);
  const clipId = `work-cut-${++state.clipId}`;
  const root = svgNode('svg',{viewBox:trace ? `0 0 ${source.width} ${source.height}` : `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`,preserveAspectRatio:'xMidYMid meet','aria-hidden':'true',focusable:'false'});
  const defs = svgNode('defs');
  const clip = svgNode('clipPath',{id:clipId,clipPathUnits:'userSpaceOnUse'});
  const points = piece.polygon.map(point => point.join(',')).join(' ');
  const geometry = piece.holes?.length ? {tag:'path',attributes:{d:pieceRings(piece).map(ring => `M${ring.map(point => point.join(',')).join('L')}Z`).join(''),'fill-rule':'evenodd','clip-rule':'evenodd'}} : {tag:'polygon',attributes:{points}};
  clip.append(svgNode(geometry.tag,geometry.attributes)); defs.append(clip); root.append(defs);
  if (trace) root.append(svgNode('image',{href:source.dataUrl,width:source.width,height:source.height,opacity:'.32'}));
  root.append(svgNode('image',{href:source.dataUrl,width:source.width,height:source.height,'clip-path':`url(#${clipId})`}));
  if (trace) root.append(svgNode(geometry.tag,{...geometry.attributes,fill:'none',stroke:'#d34d32','stroke-width':2,'vector-effect':'non-scaling-stroke'}));
  return root;
}
function fragmentStatus(fragment,frame=state.frames[state.step]) {
  const piece = frame.pieces.find(item => item.id === fragment.piece.id);
  if (!piece) return 'Not cut yet';
  if (piece.supersededBy) return childIds(piece).length > 1 ? `Cut into ${childIds(piece).length} fragments` : `Recut as ${fragmentName(piece.supersededBy)}`;
  if (piece.visible) return 'Placed';
  const lastPlacement = state.project.actions.slice(0,state.step).findLast(record => record.action.pieceId === piece.id && ['place','remove'].includes(record.action.type));
  return lastPlacement?.action.type === 'remove' ? 'Removed from canvas' : 'Unplaced';
}
function renderMaterials() {
  const fragmentGrid = document.createDocumentFragment();
  for (const fragment of state.fragments) {
    const source = state.project.sources.find(item => item.id === fragment.piece.sourceId);
    const button = node('button','fragment-card'); button.type = 'button'; button.dataset.fragmentId = fragment.piece.id;
    const preview = node('span','fragment-preview'); preview.append(fragmentSVG(fragment.piece,source));
    button.append(preview,node('span','fragment-label',fragmentName(fragment.piece.id)),node('span','fragment-source',source.name));
    button.addEventListener('click',() => openMaterial(source,fragment,button));
    fragmentGrid.append(button);
  }
  $('fragment-grid').replaceChildren(fragmentGrid);
  $('fragment-count').textContent = number(state.fragments.length);
  $('empty-fragments').hidden = state.fragments.length > 0;
  const sourceGrid = document.createDocumentFragment();
  for (const source of state.project.sources) {
    const button = node('button','original-card'); button.type = 'button';
    const image = node('img'); image.src = source.dataUrl; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
    const count = state.fragments.filter(fragment => fragment.piece.sourceId === source.id).length;
    button.setAttribute('aria-label',`${source.name}, ${count} ${count === 1 ? 'fragment' : 'fragments'}`);
    const label = node('span','original-label',source.name); label.title = source.name;
    button.append(image,label,node('span','original-usage',count ? `${number(count)} ${count === 1 ? 'fragment' : 'fragments'}` : 'Unused'));
    button.addEventListener('click',() => openMaterial(source,null,button));
    sourceGrid.append(button);
  }
  $('original-grid').replaceChildren(sourceGrid);
  $('source-count').textContent = number(state.project.sources.length);
  $('empty-sources').hidden = state.project.sources.length > 0;
}
function updateFragmentStates() {
  for (const card of $('fragment-grid').children) {
    const fragment = state.fragments.find(item => item.piece.id === card.dataset.fragmentId);
    const piece = state.frames[state.step].pieces.find(item => item.id === fragment.piece.id);
    const status = fragmentStatus(fragment);
    card.classList.toggle('is-future',status === 'Not cut yet');
    card.classList.toggle('is-retired',Boolean(piece?.supersededBy));
    card.classList.toggle('is-unplaced',status !== 'Not cut yet' && status !== 'Placed' && !piece?.supersededBy);
    card.querySelector('.fragment-source').textContent = piece?.supersededBy ? status : fragmentOrigin(fragment.piece,true);
    card.title = [fragmentName(fragment.piece.id),fragment.piece.parentPieceId ? fragmentOrigin(fragment.piece) : '',status].filter(Boolean).join(' · ');
    card.setAttribute('aria-label',[fragmentName(fragment.piece.id),sourceName(fragment.piece.sourceId),fragment.piece.parentPieceId ? fragmentOrigin(fragment.piece) : '',status].filter(Boolean).join(', '));
  }
}
function writingField(label,text,className) { const field = node('div','model-field'); field.append(node('span','model-field-label',label),node('p',className,text)); return field; }
function renderModelWriting() {
  const actions = state.project.actions.slice(state.run.startingActions || 0,state.project.cursor).map(record => record.action);
  const lastTitle = actions.findLast(action => action.type === 'describe' && Object.hasOwn(action,'title'));
  const lastStatement = actions.findLast(action => action.type === 'describe' && Object.hasOwn(action,'statement'));
  const content = document.createDocumentFragment();
  if (lastTitle) content.append(writingField('Title',lastTitle.title,'model-title'));
  if (lastStatement?.statement) content.append(writingField('Final artist statement',lastStatement.statement,'model-statement'));
  if (!lastTitle && !lastStatement?.statement) content.append(node('p','model-empty','No title or statement supplied.'));
  $('model-writing').replaceChildren(content);
}
function renderFacts() {
  const run = state.run;
  const facts = document.createDocumentFragment();
  const budget = (used,maximum) => maximum ? `${number(used)} / ${number(maximum)}` : number(used);
  fact(facts,'Model',run.spec?.model || 'Not recorded');
  fact(facts,'Provider',providerName(run));
  fact(facts,'Started',new Date(run.createdAt).toLocaleString());
  fact(facts,'Actions',budget(state.frames.length - 1,run.spec?.maxActions));
  fact(facts,'Usable fragments',budget(usablePieceCount(state.frames.at(-1)),run.spec?.maxPieces));
  if (run.turns !== undefined && run.turns !== null) fact(facts,'Turns',budget(run.turns,run.spec?.maxTurns));
  if (Number.isFinite(run.spec?.maxMinutes)) fact(facts,'Time limit',`${number(run.spec.maxMinutes)} min`);
  if (Number.isFinite(run.spec?.maxOutputTokens)) fact(facts,'Output limit / turn',`${number(run.spec.maxOutputTokens)} tokens`);
  if (run.usage) {
    const totalTokens = run.usage.totalTokens ?? (run.usage.inputTokens || 0) + (run.usage.outputTokens || 0);
    fact(facts,'Tokens',`${number(totalTokens)}${run.usageIncomplete || run.usage.incomplete ? ' · incomplete' : ''}`);
  }
  if (typeof run.provenance === 'string') fact(facts,'Record',run.provenance);
  if (run.startingActions) fact(facts,'Seed actions',number(run.startingActions));
  if (Number.isFinite(run.costUSD)) fact(facts,'Cost',`$${run.costUSD.toFixed(4)}`);
  $('work-facts').replaceChildren(facts);
  $('work-brief').replaceChildren();
  if (run.spec?.prompt) $('work-brief').append(node('span','model-field-label','Task'),node('p','',run.spec.prompt));
}
function renderTerminal() {
  $('pending-work').hidden = true;
  $('finished-work').hidden = false;
  $('download-menu').hidden = false;
  $('download-image').href = `${base}/render.png`;
  $('download-project').href = `${base}/project`;
  $('download-record').href = `${base}/export`;
  $('download-record').hidden = isArchive;
  $('decision-notes').hidden = isArchive;
  $('trace-tab').hidden = isArchive;
  const partial = !['completed','archived'].includes(state.run.status);
  $('work-notice').textContent = partial ? terminationMessages[state.run.terminationReason] || 'This run ended before completion. Any saved work is shown here.' : '';
  $('work-notice').hidden = !partial;
  $('canvas-size').textContent = `${number(state.project.canvas.width)} × ${number(state.project.canvas.height)}`;
  renderMaterials(); renderModelWriting(); renderFacts();
  setStep(state.frames.length - 1);
}
function actionCaption(step) {
  if (step === 0) return 'Blank canvas';
  const action = state.project.actions[step - 1].action;
  const seed = step <= (state.run.startingActions || 0) ? 'Seed · ' : '';
  if (action.type === 'cut') { const fragment = state.fragments.find(item => item.cutStep === step); return `${seed}Cut · ${fragmentName(fragment?.piece.id)} · ${sourceName(action.sourceId)}`; }
  if (action.type === 'trim') {
    const results = state.fragments.filter(item => item.cutStep === step);
    const offcuts = results.filter(item => item.piece.trimRole === 'offcut').length;
    const retained = results.length - offcuts;
    return `${seed}Recut · ${fragmentName(action.pieceId)} → ${retained > 1 ? `${retained} fragments` : fragmentName(action.newPieceId)}${offcuts ? ` + ${offcuts} ${offcuts === 1 ? 'offcut' : 'offcuts'}` : ''}`;
  }
  if (action.type === 'describe') return seed ? 'Seed text updated' : 'Model-authored text updated';
  return `${seed}${{place:'Place',transform:'Move / transform',reorder:'Change layer',remove:'Remove'}[action.type] || 'Action'} · ${fragmentName(action.pieceId)}`;
}
function renderPlayback() {
  const maximum = state.frames.length - 1;
  $('work-timeline').max = maximum;
  $('work-timeline').value = state.step;
  $('work-timeline').disabled = maximum === 0;
  $('work-timeline').setAttribute('aria-valuetext',`Action ${state.step} of ${maximum}: ${actionCaption(state.step)}`);
  $('play-work').disabled = maximum === 0;
  $('play-work').textContent = state.playing ? 'Ⅱ Pause' : '▶ Play';
  $('play-work').setAttribute('aria-label',state.playing ? 'Pause playback' : 'Play the making of this work');
  $('playback-speed').value = String(state.playbackRate);
  $('playback-speed').disabled = maximum === 0;
  $('previous-step').disabled = state.step === 0;
  $('next-step').disabled = state.step === maximum;
  $('final-step').disabled = state.step === maximum;
  $('playback-position').textContent = `${number(state.step)} / ${number(maximum)}`;
  $('action-caption').textContent = actionCaption(state.step);
  updateFragmentStates();
}
function setStep(value) {
  state.step = Math.max(0,Math.min(state.frames.length - 1,Number(value) || 0));
  const step = state.step;
  const final = step === state.frames.length - 1;
  if (final) pieceHighlight.clear();
  renderPlayback();
  const version = ++state.imageVersion;
  const url = `${base}/render.png?step=${state.step}&revision=${encodeURIComponent(state.run.revision || state.run.updatedAt || '')}`;
  $('work-stage').classList.add('is-loading');
  $('work-stage').classList.remove('has-error');
  $('work-stage').setAttribute('aria-busy','true');
  $('canvas-message').hidden = true;
  const image = new Image();
  state.imageReady = new Promise(resolve => {
    image.onload = async () => {
      try { await image.decode(); }
      catch { return image.onerror(); }
      if (version !== state.imageVersion) return resolve(false);
      image.id = 'work-canvas'; image.className = 'work-canvas'; image.draggable = false;
      image.alt = `${identity}, ${step === 0 ? 'blank canvas' : `after action ${step}`}`;
      // Keep the current frame visible until its replacement is ready to paint.
      $('work-canvas').replaceWith(image);
      // This destination action's outline is committed with the decoded frame,
      // including backward seeks. Removal, text, and plain final stay unmarked.
      const frame = state.frames[step];
      pieceHighlight.show(final ? null : outlineForAction(state.frames[step - 1], frame, state.project.actions[step - 1]?.action), frame.canvas, step);
      $('work-stage').classList.remove('is-loading');
      $('work-stage').setAttribute('aria-busy','false');
      resolve(true);
    };
    image.onerror = () => {
      if (version !== state.imageVersion) return resolve(false);
      stopPlayback();
      pieceHighlight.clear();
      $('work-stage').classList.remove('is-loading');
      $('work-stage').classList.add('has-error');
      $('work-stage').setAttribute('aria-busy','false');
      const retry = node('button','text-button','Try again'); retry.type = 'button';
      retry.addEventListener('click',() => setStep(state.step));
      $('canvas-message').replaceChildren(node('span','','Image unavailable. '),retry);
      $('canvas-message').hidden = false;
      resolve(false);
    };
    image.src = url;
  });
}
function stopPlayback() { clearTimeout(state.playbackTimer); state.playing = false; state.playbackVersion++; if (state.project) renderPlayback(); }
async function advancePlayback(version) {
  const rendered = await state.imageReady;
  if (!state.playing || !rendered || version !== state.playbackVersion) return;
  state.playbackTimer = setTimeout(() => {
    if (!state.playing || version !== state.playbackVersion) return;
    if (state.step >= state.frames.length - 1) return stopPlayback();
    setStep(state.step + 1);
    advancePlayback(version);
  },650 / state.playbackRate);
}
function openMaterial(source,fragment,opener) {
  stopPlayback();
  state.dialogOpener = opener;
  $('material-kicker').textContent = fragment ? fragment.piece.parentPieceId ? `${fragment.piece.trimRole === 'offcut' ? 'Offcut' : 'Recut'} from ${fragmentName(fragment.piece.parentPieceId)}` : 'Cut from the saved original' : 'Saved original';
  $('material-title').textContent = fragment ? fragmentName(fragment.piece.id) : source.name;
  $('material-origin').replaceChildren();
  $('material-fragment').replaceChildren();
  $('material-fragment').hidden = !fragment;
  const facts = document.createDocumentFragment();
  if (fragment) {
    const trace = fragmentSVG(fragment.piece,source,{trace:true}); trace.removeAttribute('aria-hidden'); trace.setAttribute('role','img'); trace.setAttribute('aria-label',`${source.name}, with the cut boundary highlighted`);
    $('material-origin').append(trace);
    $('material-fragment').append(fragmentSVG(fragment.piece,source));
    fact(facts,'Source',source.name);
    const relativeLink = (id,label) => {
      const relative = state.fragments.find(item => item.piece.id === id);
      const button = node('button','text-button material-lineage',label); button.type = 'button';
      button.addEventListener('click',() => openMaterial(source,relative,opener));
      return button;
    };
    if (fragment.piece.parentPieceId) fact(facts,'Cut from',relativeLink(fragment.piece.parentPieceId,fragmentName(fragment.piece.parentPieceId)));
    fact(facts,'Cut at',`Action ${fragment.cutStep}${fragment.cutStep <= (state.run.startingActions || 0) ? ' · Seed' : ''}`);
    const piece = state.frames[state.step].pieces.find(item => item.id === fragment.piece.id);
    const status = fragmentStatus(fragment);
    fact(facts,'Status',status);
    if (piece?.supersededBy) {
      const children = node('span','material-descendants');
      for (const id of childIds(piece)) {
        const child = state.fragments.find(item => item.piece.id === id);
        children.append(relativeLink(id,`${fragmentName(id)}${child?.piece.trimRole === 'offcut' ? ' · Offcut' : ''}`));
      }
      fact(facts,'Cut into',children);
    }
    const bounds = polygonBounds(fragment.piece.polygon);
    fact(facts,'Cut size',`${number(Math.round(bounds.width))} × ${number(Math.round(bounds.height))} px`);
    fact(facts,'Area',`${number(Math.round(pieceArea(fragment.piece)))} px²`);
  } else {
    const image = node('img'); image.src = source.dataUrl; image.alt = source.name; $('material-origin').append(image);
    fact(facts,'Size',`${number(source.width)} × ${number(source.height)} px`);
    fact(facts,'Fragments',state.fragments.filter(item => item.piece.sourceId === source.id).length);
  }
  fact(facts,'Credit',source.credit);
  fact(facts,'License',source.license);
  if (source.url) fact(facts,'Original',safeSourceLink(source.url));
  $('material-facts').replaceChildren(facts);
  if (!$('material-dialog').open) $('material-dialog').showModal();
  $('close-material').focus({preventScroll:true});
}
function setTab(selected) {
  if (selected === 'trace' && isArchive) selected = 'fragments';
  for (const name of ['fragments','sources','trace']) {
    const active = name === selected;
    $(`${name}-tab`).setAttribute('aria-selected',String(active));
    $(`${name}-tab`).tabIndex = active ? 0 : -1;
    $(`${name}-panel`).hidden = !active;
  }
  if (selected === 'trace') loadTrace();
}
function traceImage(sha256,alt) {
  if (!sha256) return node('p','trace-missing','Not recorded');
  const image = node('img'); image.src = `${base}/assets/${sha256}`; image.alt = alt; image.loading = 'lazy'; image.decoding = 'async';
  return image;
}
function selectTraceTurn(index,buttons) {
  const selected = traceSelection(state.trace,index);
  if (!selected) return;
  for (const [buttonIndex,button] of buttons.entries()) button.setAttribute('aria-pressed',String(buttonIndex === index));
  const detail = node('section','trace-detail');
  detail.append(node('h3','',`Turn ${number(selected.turn.turn)}`),node('p','trace-evidence',`Events ${Object.values(selected.turn.evidence).filter(Number.isInteger).join(', ') || 'not recorded'}`));
  const frames = node('div','trace-frames');
  const observed = node('figure','trace-frame'); observed.append(traceImage(selected.observed?.sha256,`Canvas supplied to the model on turn ${selected.turn.turn}`),node('figcaption','','Observed · exact supplied canvas'));
  const result = node('figure','trace-frame');
  if (Number.isInteger(selected.resultStep)) {
    const image = node('img'); image.src = `${base}/render.png?step=${selected.resultStep}`; image.alt = selected.rejected ? `Canvas unchanged after rejected turn ${selected.turn.turn}` : `Accepted replay state after turn ${selected.turn.turn}`; result.append(image);
  } else result.append(node('p','trace-missing','Not recorded'));
  result.append(node('figcaption','',selected.rejected ? 'Result · rejected, canvas unchanged' : 'Result · accepted replay state'));
  frames.append(observed,result);
  if (selected.nextObserved) {
    const next = node('figure','trace-frame'); next.append(traceImage(selected.nextObserved.sha256,'Canvas supplied on the next requested turn'),node('figcaption','','Next observation · exact supplied canvas')); frames.append(next);
  }
  const attempt = node('div','trace-attempt'); attempt.append(node('span','model-field-label','Attempted'),node('p','',actionSummary(selected.turn.proposedActions)));
  if (selected.turn.decisionNote !== null) attempt.append(node('blockquote','trace-note',selected.turn.decisionNote || 'Empty note'));
  if (selected.rejected) attempt.append(node('p','trace-rejection',[selected.turn.validation.code,selected.turn.validation.error].filter(Boolean).join(' · ') || 'Rejected'));
  if (Number.isInteger(selected.resultStep)) {
    const seek = node('button','text-button',`Show result at action ${selected.resultStep} ↗`); seek.type = 'button'; seek.addEventListener('click',() => { stopPlayback(); setStep(selected.resultStep); $('work-stage').scrollIntoView({block:'nearest',behavior:'smooth'}); }); attempt.append(seek);
  }
  detail.append(frames,attempt,node('p','trace-caveat','Playback may show action-by-action replay frames between recorded observations. The model did not necessarily receive those intermediate frames.'));
  $('trace-content').querySelector('.trace-detail')?.remove();
  $('trace-content').append(detail);
}
function renderTrace() {
  const content = document.createDocumentFragment(), buttons = [];
  const list = node('div','trace-turns');
  for (const [index,turn] of state.trace.turns.entries()) {
    const button = node('button','trace-turn'); button.type = 'button'; button.setAttribute('aria-pressed','false');
    button.append(node('span','trace-turn-number',`Turn ${number(turn.turn)}`),node('span','trace-turn-flow',`Observed → ${turn.parseStatus === 'parsed' ? 'Attempted' : 'Unparsed'} → ${turn.validation.status === 'accepted' ? 'Accepted' : turn.validation.status === 'rejected' ? 'Rejected' : 'No result'}`));
    button.addEventListener('click',() => selectTraceTurn(index,buttons)); buttons.push(button); list.append(button);
  }
  content.append(list);
  if (!buttons.length) content.append(node('p','material-empty','No requested model turns were recorded.'));
  $('trace-content').replaceChildren(content);
  $('trace-count').textContent = buttons.length ? number(buttons.length) : '';
  if (buttons.length) selectTraceTurn(0,buttons);
}
async function loadTrace() {
  if (state.traceLoaded || state.traceLoading || !state.project || state.run.status === 'running' || isArchive) return;
  state.traceLoading = true;
  $('trace-content').replaceChildren(node('p','material-empty','Loading trace…'));
  try { state.trace = (await request(`${base}/trace`)).trace; renderTrace(); state.traceLoaded = true; }
  catch (error) {
    const retry = node('button','text-button','Try again'); retry.type = 'button'; retry.addEventListener('click',loadTrace);
    $('trace-content').replaceChildren(node('p','material-empty',error.message),retry);
  } finally { state.traceLoading = false; }
}
async function loadNotes() {
  if (state.notesLoaded || state.notesLoading || !state.project || state.run.status === 'running') return;
  state.notesLoading = true;
  $('model-notes-content').replaceChildren(node('p','model-empty','Loading notes…'));
  try {
    const result = await request(`${base}/events`);
    const events = (result.events || []).filter(event => event.type === 'batch_result' && event.accepted && typeof event.decision_note === 'string' && event.decision_note.trim());
    const content = document.createDocumentFragment();
    for (const event of events) {
      const article = node('article','model-note');
      const heading = node('div','model-note-heading');
      heading.append(node('span','',`Model note · Turn ${number(event.turn)}`));
      if (Number.isInteger(event.step) && event.step <= state.frames.length - 1) {
        const button = node('button','text-button',`Action ${number(event.step)} ↗`); button.type = 'button';
        button.addEventListener('click',() => { stopPlayback(); setStep(event.step); $('work-stage').scrollIntoView({block:'nearest',behavior:'smooth'}); });
        heading.append(button);
      }
      article.append(heading,node('p','',event.decision_note));
      content.append(article);
    }
    if (!events.length) content.append(node('p','model-empty','No model notes recorded.'));
    $('model-notes-content').replaceChildren(content);
    $('note-count').textContent = events.length ? number(events.length) : '';
    state.notesLoaded = true;
  } catch (error) {
    const retry = node('button','text-button','Try again'); retry.type = 'button'; retry.addEventListener('click',loadNotes);
    $('model-notes-content').replaceChildren(node('p','model-empty',error.message),retry);
  } finally { state.notesLoading = false; }
}
async function refresh() {
  if (state.refreshing || !runId) return;
  state.refreshing = true;
  $('retry-work').disabled = true;
  clearTimeout(state.pollTimer);
  try {
    const result = await request(base);
    if (!result.run) throw new Error('This work is unavailable.');
    state.run = result.run;
    renderSummary();
    showError('');
    if (state.run.status !== 'running' && !state.project) {
      $('pending-title').textContent = 'Loading saved work';
      $('pending-message').textContent = '';
      $('stop-work').hidden = true;
      const project = await request(`${base}/project`);
      makeFrames(project);
      state.project = project;
      renderTerminal();
      if ($('decision-notes').open) loadNotes();
    }
  } catch (error) {
    showError(error.message);
    if (!state.project && state.run?.status !== 'running') {
      $('pending-work').classList.add('is-unavailable');
      $('pending-title').textContent = 'Work unavailable';
      $('pending-message').textContent = 'Return to the library or try again.';
      $('stop-work').hidden = true;
    }
  } finally {
    state.refreshing = false;
    $('retry-work').disabled = false;
    if (state.run?.status === 'running') state.pollTimer = setTimeout(() => { if (!document.hidden) refresh(); },3000);
  }
}
$('play-work').addEventListener('click',() => {
  if (state.playing) return stopPlayback();
  state.playing = true;
  if (state.step >= state.frames.length - 1) setStep(0); else renderPlayback();
  advancePlayback(++state.playbackVersion);
});
$('playback-speed').addEventListener('change',event => {
  const rate = Number(event.target.value);
  if (!playbackRates.includes(rate)) return;
  state.playbackRate = rate;
  try { localStorage.setItem(playbackRateKey,String(rate)); } catch { /* Remembering the preference is optional. */ }
  if (state.playing) {
    clearTimeout(state.playbackTimer);
    advancePlayback(++state.playbackVersion);
  }
});
$('work-timeline').addEventListener('input',event => { const step = event.target.value; stopPlayback(); setStep(step); });
$('previous-step').addEventListener('click',() => { stopPlayback(); setStep(state.step - 1); });
$('next-step').addEventListener('click',() => { stopPlayback(); setStep(state.step + 1); });
$('final-step').addEventListener('click',() => { stopPlayback(); setStep(state.frames.length - 1); });
$('retry-work').addEventListener('click',refresh);
$('stop-work').addEventListener('click',async () => {
  if (state.stopping || state.run?.status !== 'running') return;
  state.stopping = true; renderSummary();
  try { await request(`${base}/stop`,{method:'POST',body:{}}); await refresh(); }
  catch (error) { showError(error.message); }
  finally { state.stopping = false; if (state.run?.status === 'running') renderSummary(); }
});
for (const name of ['fragments','sources','trace']) {
  $(`${name}-tab`).addEventListener('click',() => setTab(name));
  $(`${name}-tab`).addEventListener('keydown',event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const names = isArchive ? ['fragments','sources'] : ['fragments','sources','trace'];
    const index = names.indexOf(name);
    const selected = event.key === 'Home' ? names[0] : event.key === 'End' ? names.at(-1) : names[(index + (event.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length];
    setTab(selected); $(`${selected}-tab`).focus();
  });
}
$('close-material').addEventListener('click',() => $('material-dialog').close());
$('material-dialog').addEventListener('close',() => state.dialogOpener?.focus({preventScroll:true}));
$('decision-notes').addEventListener('toggle',() => { if ($('decision-notes').open) loadNotes(); });
$('download-menu').addEventListener('click',event => { if (event.target.closest('a')) $('download-menu').open = false; });
document.addEventListener('click',event => { if (!$('download-menu').contains(event.target)) $('download-menu').open = false; });
document.addEventListener('keydown',event => { if (event.key === 'Escape') $('download-menu').open = false; });
document.addEventListener('visibilitychange',() => { if (document.hidden) { stopPlayback(); pieceHighlight.clear(); } else if (!state.project) refresh(); });
window.addEventListener('pagehide',() => { clearTimeout(state.pollTimer); stopPlayback(); state.imageVersion++; pieceHighlight.clear(); });
// Back/forward cache can suspend a seek before its decoded frame is committed.
// Restore the selected action instead of keeping that invalidated load pending.
window.addEventListener('pageshow',event => { if (event.persisted && state.project) setStep(state.step); });
if (runId) refresh();
else {
  $('pending-work').classList.add('is-unavailable');
  $('pending-title').textContent = 'Choose a work from the library';
  $('pending-message').replaceChildren(Object.assign(node('a','','Open library'),{href:'/'}));
}
