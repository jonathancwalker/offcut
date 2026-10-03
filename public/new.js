import {MATERIAL_SELECTION_VERSION, MATERIAL_SELECTION_ALGORITHM, normalizeMaterialSelection, drawMaterialIds} from '/material-selection.mjs';
import {planBatch, BATCH_LIMITS} from '/batch-plan.mjs';

const $ = id => document.getElementById(id);
const TASK = 'Create an original collage from the provided source images. Choose your own subject and composition. There is no target image. Give the finished work a title and a short statement.';
const PRESETS = {
  small: {maxPieces:12, maxActions:60, maxTurns:6, maxMinutes:5, maxOutputTokens:4096},
  standard: {maxPieces:24, maxActions:120, maxTurns:12, maxMinutes:10, maxOutputTokens:4096},
  extended: {maxPieces:48, maxActions:240, maxTurns:24, maxMinutes:20, maxOutputTokens:4096},
};
const LIMIT_KEYS = Object.keys(PRESETS.standard);
const DRAFT_KEY = 'offcut.new-run.draft.v2';
const LEGACY_DRAFT_KEY = 'offcut.new-run.draft.v1';
const PENDING_KEY = 'offcut.new-run.pending.v1';
const BATCH_PENDING_KEY = 'offcut.new-batch.pending.v1';
const PAGE_SIZE = 12;
const readStored = key => { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } };
const draft = readStored(DRAFT_KEY) || readStored(LEGACY_DRAFT_KEY);
// A pending request is a receipt, not a recipe to recompute after a reload.
function restorePending(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.sourceIds) || !value.sourceHashes || typeof value.clientRequestId !== 'string') return null;
  const keys = ['provider', 'model', 'prompt', ...LIMIT_KEYS, 'sourceIds', 'sourceHashes', 'materialSelection', 'clientRequestId'];
  if (Object.keys(value).some(key => !keys.includes(key))) return null;
  return value;
}
function restorePendingBatch(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.groups) || !Array.isArray(value.sourceIds) || !value.sourceHashes || !value.spec || typeof value.clientRequestId !== 'string') return null;
  const keys=['clientRequestId','spec','groups','mode','materials','materialSelection','sourceIds','sourceHashes'];
  if (Object.keys(value).some(key=>!keys.includes(key))) return null;
  return value;
}
const state = {
  sources: [], selected: new Map(), tiles: new Map(), maxSources:24, maxSourceBytes:24*1024*1024, uploadSlots:0,
  snapshot:'', pins:[], randomCount:6, seed:null, recipe:null, reviewedRecipe:null, drawError:'', needsReview:false,
  provider:null, verified:false, runs:[], batches:[], ready:false, loading:false, uploading:false,
  credentialBusy:false, launching:false, pending:restorePending(readStored(PENDING_KEY)), pendingBatch:restorePendingBatch(readStored(BATCH_PENDING_KEY)),
  batchMode:'explore', materialsChoice:null, batchPlan:null, batchPlanKey:'', batchPlanError:'', reviewBody:null, reviewPlan:null,
  query:'', collection:'', pool:'all', page:0, previewId:null, previewReturn:null, selectionInitialized:false, timer:null,
};
const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
const sourceById = id => state.sources.find(source => source.id === id);
const uniqueIds = value => Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id)))] : [];
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
async function request(path, {method='GET', body, timeout=30000}={}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {method, signal:controller.signal, cache:'no-store', ...(body === undefined ? {} : {headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)})});
    let result;
    try { result = await response.json(); } catch { throw new Error('The server returned an unreadable response.'); }
    if (!response.ok) { const error = new Error(result.error || `Request failed (${response.status}).`); error.status = response.status; throw error; }
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The local server took too long to respond.');
    if (error instanceof TypeError) throw new Error('The local server is unavailable.');
    throw error;
  } finally { clearTimeout(timer); }
}
function message(id, text, error=false) { $(id).textContent=text; $(id).classList.toggle('error', error); }
function pageError(text='') { $('page-error-message').textContent=text; $('page-error').hidden=!text; }
function launchError(text='') { $('launch-error').textContent=text; $('launch-error').hidden=!text; }
function limits() { return Object.fromEntries(LIMIT_KEYS.map(key => [key, Number($(key).value)])); }
function saveDraft() {
  if (!state.selectionInitialized) return;
  const value = {
    version:2, materialSelection:state.recipe, reviewRequired:state.needsReview,
    sources:[...state.selected].map(([id, sha256]) => ({id, sha256})),
    filters:{query:state.query, collection:state.collection, pool:state.pool},
    model:$('model').value, limits:limits(), batch:{groups:modelGroups(),mode:state.batchMode,materials:state.materialsChoice},
  };
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(value)); } catch { /* The in-page draft remains usable. */ }
}
function currentPending() { return state.pendingBatch || state.pending; }
function storePending(value, kind='run') {
  if (value) {
    sessionStorage.setItem(kind==='batch'?BATCH_PENDING_KEY:PENDING_KEY,JSON.stringify(value));
    if (kind==='batch') state.pendingBatch=value; else state.pending=value;
  } else {
    for (const key of [PENDING_KEY,BATCH_PENDING_KEY]) { try { sessionStorage.removeItem(key); } catch {} }
    state.pending=null; state.pendingBatch=null;
  }
}
function locked() { return state.loading || state.uploading || state.launching || !!currentPending(); }
function modelGroups() {
  return [...$('model-groups').children].map(row=>({model:row.querySelector('.group-model').value.trim(),count:row.querySelector('.group-count').value===''?NaN:Number(row.querySelector('.group-count').value)}));
}
function materialsMode() { return state.materialsChoice || (state.randomCount===0?'same':state.pins.length?'pinned-random':'random'); }
function batchSettings() {
  const groups=modelGroups();
  const isBatch=groups.length>1 || groups[0]?.count!==1;
  const total=groups.reduce((sum,group)=>sum+(Number.isSafeInteger(group.count)?group.count:0),0);
  if (!isBatch) return {isBatch,total:1,plan:null,error:''};
  if (!state.reviewedRecipe || state.needsReview || state.drawError) return {isBatch,total,plan:null,error:''};
  const input={groups,mode:state.batchMode,materials:materialsMode(),materialSelection:state.reviewedRecipe};
  const key=JSON.stringify(input);
  if (key!==state.batchPlanKey) {
    state.batchPlanKey=key; state.batchPlan=null; state.batchPlanError='';
    try {
      const plan=planBatch(input);
      for (const entry of plan.entries) {
        const sizes=entry.sourceIds.map(id=>sourceById(id)?.byteLength);
        if (sizes.some(size=>!Number.isSafeInteger(size)||size<=0)) throw new Error('An image in a later draw is unavailable. Refresh the collection.');
        if (sizes.reduce((sum,size)=>sum+size,0)>state.maxSourceBytes) throw new Error(`Run ${entry.index+1} exceeds the ${state.maxSourceBytes/1024/1024} MiB image limit. Choose fewer images or a smaller pool.`);
      }
      state.batchPlan=plan;
    } catch(error) { state.batchPlanError=error.message; }
  }
  return {isBatch,total,plan:state.batchPlan,error:state.batchPlanError};
}
function addModelGroup(model='',count=1) {
  const index=$('model-groups').children.length;
  if (index>=BATCH_LIMITS.maxGroups) return;
  const row=element('div','model-group'); row.dataset.groupIndex=index;
  const input=$('model').cloneNode(); input.id=`group-model-${index}`; input.value=model; input.setAttribute('aria-label',`Model ${index+1}`);
  const runs=$('run-count').cloneNode(); runs.id=`group-count-${index}`; runs.value=count; runs.setAttribute('aria-label',`Number of runs for model ${index+1}`);
  const remove=element('button','remove-model','×'); remove.type='button'; remove.setAttribute('aria-label',`Remove model ${index+1}`);
  remove.addEventListener('click',()=>{if(locked())return;row.remove();renumberModelGroups();updateControls();saveDraft();});
  row.append(input,runs,remove); $('model-groups').append(row);
}
function renumberModelGroups() {
  [...$('model-groups').children].forEach((row,index)=>{
    row.dataset.groupIndex=index;
    if (index===0) return;
    const input=row.querySelector('.group-model'),runs=row.querySelector('.group-count'),remove=row.querySelector('.remove-model');
    input.id=`group-model-${index}`;input.setAttribute('aria-label',`Model ${index+1}`);
    runs.id=`group-count-${index}`;runs.setAttribute('aria-label',`Number of runs for model ${index+1}`);
    remove.setAttribute('aria-label',`Remove model ${index+1}`);
  });
}
function materialLocked() { return locked() || !state.ready || state.needsReview; }
function updateControls() {
  const lock = locked();
  const materialLock = materialLocked();
  const active = state.runs.find(run => run.status === 'running');
  const activeBatch=state.batches.find(batch=>batch.status==='running');
  const batch=batchSettings();
  const invalidGroups=modelGroups().some(group=>!Number.isInteger(group.count)||group.count<1||group.count>BATCH_LIMITS.maxRunsPerGroup||!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(group.model));
  for (const tile of state.tiles.values()) tile.querySelector('.material-pick').disabled=materialLock;
  for (const tray of ['pinned-tray','random-tray']) for (const button of $(tray).querySelectorAll('button')) button.disabled=materialLock;
  for (const control of $('model-groups').querySelectorAll('input,button')) control.disabled=lock || !state.ready;
  $('add-model').disabled=lock || !state.ready || $('model-groups').children.length>=BATCH_LIMITS.maxGroups;
  $('batch-settings').hidden=!batch.isBatch; $('per-run-label').hidden=!batch.isBatch;
  $('batch-mode').disabled=lock || !state.ready; $('batch-materials').disabled=lock || !state.ready;
  $('batch-materials').value=materialsMode();
  for (const radio of document.querySelectorAll('[name=batch-mode]')) radio.checked=radio.value===state.batchMode;
  $('batch-total').textContent=`${batch.total} runs`;
  $('batch-error').textContent=batch.error; $('batch-error').hidden=!batch.error;
  $('batch-material-help').textContent=materialsMode()==='same'?'Every run receives the exact images on this table.':state.batchMode==='compare'?'Run 1 gets the same table across models, then run 2, and so on. Extra runs keep drawing.':materialsMode()==='pinned-random'?'Your pins stay in every run. Extras are drawn independently for each model.':'A fresh draw for every run, independent across models.';
  $('budget-presets').disabled=lock || !state.ready;
  $('custom-limits').disabled=lock || !state.ready;
  const invalidLimits = LIMIT_KEYS.some(key => !$(key).validity.valid);
  $('clear-pins').disabled=materialLock || !state.pins.length;
  $('random-count').disabled=materialLock;
  $('fewer-random').disabled=materialLock || !(state.randomCount > 0);
  $('more-random').disabled=materialLock || state.randomCount >= state.maxSources;
  $('random-pool').disabled=materialLock;
  $('reshuffle').disabled=materialLock || !(state.randomCount > 0) || state.pins.length+state.randomCount>state.maxSources || candidateSources().filter(source=>!state.pins.includes(source.id)).length<state.randomCount;
  $('source-search').disabled=lock || !state.ready;
  $('collection-filter').disabled=lock || !state.ready;
  const filtered=filteredSources();
  $('previous-page').disabled=lock || !state.ready || state.page===0;
  $('next-page').disabled=lock || !state.ready || (state.page+1)*PAGE_SIZE >= filtered.length;
  $('add-images').disabled=materialLock || state.uploadSlots<=0;
  $('add-images').firstElementChild.textContent=state.uploading?'…':'+';
  $('empty-add').disabled=$('add-images').disabled;
  $('refresh-materials').disabled=lock;
  $('review-materials').hidden=!state.needsReview || !!currentPending();
  $('review-materials').disabled=lock || !state.ready;
  $('api-key').disabled=lock || state.credentialBusy || !state.ready;
  $('save-key').disabled=$('api-key').disabled;
  $('test-connection').disabled=lock || state.credentialBusy || !state.provider?.configured;
  $('forget-key').disabled=lock || state.credentialBusy;
  $('retry-start').disabled=state.launching || state.loading;
  $('retry-start').textContent=state.launching?'Checking start…':'Retry start';
  $('pending-notice').hidden=!currentPending() || state.launching;
  $('pending-message').textContent=state.pendingBatch?'The response was interrupted. Retrying this request won’t start a second batch.':'The response was interrupted. Retrying this request won’t start a second run.';
  $('active-notice').hidden=(!active && !activeBatch) || !!currentPending();
  $('active-message').textContent=activeBatch?'A batch is already working.':'A model is already working.';
  if (activeBatch) { $('active-link').href=`/batch.html?batch=${encodeURIComponent(activeBatch.id)}`; $('active-link').textContent='View batch ↗'; }
  else if (active) { $('active-link').href=`/work.html?run=${encodeURIComponent(active.id)}`; $('active-link').textContent='View work ↗'; }
  $('launch-run').disabled=lock || state.credentialBusy || !state.ready || !state.provider?.configured || !state.reviewedRecipe || !!state.drawError || state.needsReview || !state.selected.size || !!active || !!activeBatch || invalidGroups || !!batch.error || (batch.isBatch&&!batch.plan) || invalidLimits;
  $('launch-run').firstElementChild.textContent=state.launching?'Starting…':batch.isBatch?`Review ${batch.total} runs`:'Start run';
  $('launch-run').setAttribute('aria-busy', String(state.launching));
  $('launch-help').textContent=state.launching?'Starting your run…':currentPending()?'Retry the original start above.':state.loading?'Loading setup…':!state.ready?'Reload setup to continue.':state.uploading?'Adding your images…':activeBatch?'This batch is still working.':active?'One run at a time. This one is still working.':state.needsReview?'Review the updated materials before starting.':state.drawError?'Adjust the materials above.':!state.provider?.configured?'Add an API key in Connection.':!$('model').value.trim()?'Choose a model to begin.':invalidGroups?'Check each model and its run count.':batch.error?'Adjust the batch above.':invalidLimits?'Check the limits above.':'Come back for the finished work and its playback.';
  $('run-summary').textContent=batch.isBatch?`${batch.total} runs · up to ${batch.total*Number($('maxTurns').value)||'—'} model turns total`:`${state.selected.size} ${state.selected.size===1?'image':'images'} · ${$('maxPieces').value || '—'} fragments max`;
  $('upload-capacity').textContent=state.uploadSlots>0?`PNG, JPEG or WebP · ${state.uploadSlots} upload ${state.uploadSlots===1?'slot':'slots'} available`:'Upload slots full. You can still choose from the collection.';
  if (state.previewId) $('toggle-preview-source').disabled=materialLock;
}
function renderProvider() {
  const configured = !!state.provider?.configured;
  $('connection-settings').dataset.configured=String(configured);
  $('connection-settings').dataset.verified=String(state.verified);
  $('provider-status').textContent=state.verified?'Access checked':configured?'Key available':'No key yet';
  $('forget-key').hidden=state.provider?.keySource !== 'session';
  $('key-help').textContent=state.provider?.keySource==='environment'?'Using the server key. A session key overrides it.':'Kept in server memory. Never saved to browser storage.';
  updateControls();
}
function renderBudget() {
  const values=limits();
  const preset=Object.keys(PRESETS).find(name => LIMIT_KEYS.every(key => PRESETS[name][key]===values[key]));
  for (const radio of document.querySelectorAll('[name=budget]')) radio.checked=radio.value===preset;
  $('budget-name').textContent=preset ? preset[0].toUpperCase()+preset.slice(1) : 'Custom';
  $('secondary-limits').textContent=`${$('maxTurns').value || '—'} turns · ${$('maxMinutes').value || '—'} min max`;
  updateControls();
}
function previewURL(source, full=false) {
  const path=(full && source.imageUrl) || source.previewUrl || source.imageUrl;
  if (!path) return '';
  return `${path}${path.includes('?')?'&':'?'}v=${encodeURIComponent(source.sha256 || '')}`;
}
function sourceImage(source, className='') {
  const image=element('img',className); image.src=previewURL(source); image.alt=''; image.loading='lazy'; image.decoding='async';
  image.addEventListener('error',()=>{image.hidden=true;image.parentElement?.classList.add('preview-unavailable');},{once:true});
  return image;
}
function createTile(source) {
  const tile=element('article','material-tile'); tile.dataset.sourceId=source.id;
  const pick=element('button','material-pick'); pick.type='button'; pick.title=source.name;
  const frame=element('span','material-image'); frame.append(sourceImage(source),element('span','material-state','Pin'));
  pick.append(frame,element('span','material-caption',source.name));
  pick.addEventListener('click',()=>togglePin(source.id));
  const details=element('button','material-details'); details.type='button'; details.setAttribute('aria-label',`View ${source.name}`);
  details.innerHTML='<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4M7 7h6v6H7z"/></svg>';
  details.addEventListener('click',()=>openPreview(source.id,details));
  tile.append(pick,details); return tile;
}
function filteredSources() {
  const query=state.query.trim().toLocaleLowerCase();
  return state.sources.filter(source => (!state.collection || source.collection===state.collection) &&
    (!query || [source.name,source.credit,source.collection,...(Array.isArray(source.tags)?source.tags:[])].join(' ').toLocaleLowerCase().includes(query)));
}
function candidateSources() { return state.pool==='filtered' ? filteredSources() : state.sources; }
function filterSources() {
  const filtered=filteredSources();
  state.page=Math.min(Math.max(0,state.page),Math.max(0,Math.ceil(filtered.length/PAGE_SIZE)-1));
  const visible=filtered.slice(state.page*PAGE_SIZE,(state.page+1)*PAGE_SIZE);
  const fragment=document.createDocumentFragment(); state.tiles.clear();
  for (const source of visible) { const tile=createTile(source); state.tiles.set(source.id,tile); fragment.append(tile); }
  $('source-grid').replaceChildren(fragment); $('source-grid').setAttribute('aria-busy','false');
  $('source-empty').hidden=state.sources.length>0;
  $('search-empty').hidden=!state.sources.length || filtered.length>0;
  $('source-grid').hidden=!filtered.length;
  $('page-count').textContent=filtered.length?`${state.page*PAGE_SIZE+1}–${Math.min((state.page+1)*PAGE_SIZE,filtered.length)} of ${filtered.length} images`:'0 images';
  renderTileSelection(); updateControls();
}
function renderTileSelection() {
  for (const [id,tile] of state.tiles) {
    const pinned=state.pins.includes(id), drawn=state.selected.has(id) && !pinned;
    const pick=tile.querySelector('.material-pick');
    pick.setAttribute('aria-pressed',String(pinned)); pick.setAttribute('aria-label',`${pinned?'Unpin':'Pin'} ${sourceById(id).name}`);
    tile.dataset.drawn=String(drawn); tile.querySelector('.material-state').textContent=pinned?'Pinned':drawn?'Drawn':'Pin';
  }
}
function createTrayItem(id, pinned) {
  const source=sourceById(id);
  const button=element('button','tray-source'); button.type='button'; button.dataset.sourceId=id;
  button.setAttribute('aria-label',`${pinned?'Unpin':'Pin'} ${source?.name || id}`);
  button.title=`${pinned?'Unpin':'Pin'} ${source?.name || id}`;
  const frame=element('span','tray-image');
  if (source) frame.append(sourceImage(source));
  else frame.append(element('span','image-fallback','Unavailable'));
  frame.append(element('span','tray-action',pinned?'×':'+'));
  button.append(frame,element('span','tray-name',source?.name || id));
  button.addEventListener('click',()=>{
    togglePin(id);
    const target=[...$('pinned-tray').children].find(node=>node.dataset.sourceId===id);
    (target || $('random-count')).focus({preventScroll:true});
  });
  return button;
}
function renderSelection() {
  renderTileSelection();
  $('pin-count').textContent=state.pins.length;
  $('random-count').value=Number.isFinite(state.randomCount)?state.randomCount:'';
  $('random-pool').value=state.pool;
  const randomIds=[...state.selected.keys()].filter(id=>!state.pins.includes(id));
  for (const [trayId,ids,pinned] of [['pinned-tray',state.pins,true],['random-tray',randomIds,false]]) {
    const fragment=document.createDocumentFragment();
    for (const id of ids) fragment.append(createTrayItem(id,pinned));
    if (!ids.length) fragment.append(element('p','tray-empty',pinned?'A place for your must-haves.':state.randomCount===0?'Just your pins.':state.drawError?'Adjust the draw below.':'No extras yet.'));
    $(trayId).replaceChildren(fragment); $(trayId).dataset.many=String(ids.length>6);
  }
  const eligible=candidateSources().filter(source=>!state.pins.includes(source.id)).length;
  $('eligible-count').textContent=`${eligible} available`;
  $('pool-description').textContent=state.pool==='filtered' ? `From ${state.collection || 'all collections'}${state.query.trim()?` matching “${state.query.trim()}”`:''}. Pins are kept.` : 'Search to find pins. Extras come from the whole collection.';
  $('selection-count').textContent=`${state.selected.size} ${state.selected.size===1?'image':'images'}`;
  $('selection-equation').textContent=`${state.pins.length} pinned + ${Number.isFinite(state.randomCount)?state.randomCount:'—'} random`;
  const error=state.needsReview?'The collection changed. Update the table and review it before starting.':state.drawError;
  $('selection-error').textContent=error; $('selection-error').hidden=!error;
  if (state.previewId) $('toggle-preview-source').textContent=state.pins.includes(state.previewId)?'Unpin image':'Pin image';
  updateControls();
}
function currentRecipe() {
  return {version:MATERIAL_SELECTION_VERSION, algorithm:MATERIAL_SELECTION_ALGORITHM, seed:state.seed,
    catalogSnapshot:state.snapshot, pinnedIds:[...state.pins], candidateIds:candidateSources().map(source=>source.id).sort(), randomCount:state.randomCount};
}
function drawSelection() {
  state.recipe=currentRecipe(); state.reviewedRecipe=null; state.drawError='';
  state.selected=new Map(state.pins.map(id=>[id,sourceById(id)?.sha256]));
  try {
    state.recipe=normalizeMaterialSelection(state.recipe);
    const ids=drawMaterialIds(state.recipe);
    if (ids.some(id=>!sourceById(id)?.sha256)) throw new Error('An image is no longer available. Update the collection before starting.');
    state.selected=new Map(ids.map(id=>[id,sourceById(id).sha256]));
    state.reviewedRecipe=structuredClone(state.recipe);
    const sizes=ids.map(id=>sourceById(id).byteLength);
    const bytes=sizes.reduce((sum,size)=>sum+size,0);
    if (sizes.some(size=>!Number.isSafeInteger(size) || size<=0)) throw new Error('Image sizes are unavailable. Reload setup before starting.');
    if (bytes>state.maxSourceBytes) throw new Error(`These images use ${(bytes/1024/1024).toFixed(1)} MiB. Choose smaller images or fewer extras to stay within ${state.maxSourceBytes/1024/1024} MiB.`);
  } catch(error) {
    state.drawError=state.pins.length+state.randomCount===0?'Pin an image or add a random extra.':error.message;
  }
  renderSelection();
}
function togglePin(id) {
  if (materialLocked()) return;
  if (state.pins.includes(id)) state.pins=state.pins.filter(pin=>pin!==id);
  else { if (!sourceById(id)) return; state.pins.push(id); }
  drawSelection(); saveDraft();
}
function restoreSelection() {
  const receipt=currentPending();
  const previous=receipt ? receipt.sourceIds.map(id=>({id,sha256:receipt.sourceHashes[id]})) : Array.isArray(draft?.sources) ? draft.sources : null;
  const recipe=receipt?.materialSelection || draft?.materialSelection;
  if (recipe && Number.isInteger(recipe.seed) && recipe.seed>=0 && recipe.seed<=0xffffffff && Array.isArray(recipe.pinnedIds) && Array.isArray(recipe.candidateIds)) {
    state.pins=uniqueIds(recipe.pinnedIds); state.randomCount=typeof recipe.randomCount==='number'?recipe.randomCount:NaN;
    state.seed=recipe.seed; state.recipe=structuredClone(recipe);
  } else {
    state.pins=uniqueIds(previous?.map(source=>source.id)); state.randomCount=previous?0:Math.min(6,state.sources.length); state.seed=newSeed();
  }
  if (draft?.filters) {
    state.query=typeof draft.filters.query==='string'?draft.filters.query:'';
    state.collection=typeof draft.filters.collection==='string'?draft.filters.collection:'';
    state.pool=draft.filters.pool==='filtered'?'filtered':'all';
  }
  $('source-search').value=state.query;
  state.selected=new Map((previous || []).map(source=>[source.id,source.sha256]));
  state.selectionInitialized=true;
  if (receipt) {
    state.recipe=receipt.materialSelection || null;
    state.reviewedRecipe=receipt.materialSelection || null;
    return;
  }
  const changed=previous?.some(source=>sourceById(source.id)?.sha256!==source.sha256);
  const snapshotChanged=recipe?.catalogSnapshot && recipe.catalogSnapshot!==state.snapshot;
  if (changed || snapshotChanged || draft?.reviewRequired) { state.needsReview=true; return; }
  drawSelection();
}
async function loadCatalog(catalog) {
  const result=catalog || await request('/api/source-catalog');
  state.sources=result.sources || []; state.snapshot=result.snapshot;
  state.maxSources=result.limits?.maxSources || 24; state.maxSourceBytes=result.limits?.maxSourceBytes || 24*1024*1024;
  state.uploadSlots=Math.max(0,Number(result.limits?.uploadSlots) || 0);
  if (!state.selectionInitialized) restoreSelection();
  else if (!currentPending() && (state.recipe?.catalogSnapshot!==state.snapshot || [...state.selected].some(([id,hash])=>sourceById(id)?.sha256!==hash))) state.needsReview=true;
  const options=document.createDocumentFragment();
  const all=element('option','','All collections'); all.value=''; options.append(all);
  for (const collection of [...new Set(state.sources.map(source=>source.collection).filter(Boolean))].sort()) {
    const option=element('option','',collection); option.value=collection; options.append(option);
  }
  // Keep a vanished filter visible until the user chooses a different pool.
  if (state.collection && !state.sources.some(source=>source.collection===state.collection)) {
    const option=element('option','',`${state.collection} (unavailable)`); option.value=state.collection; options.append(option);
  }
  $('collection-filter').replaceChildren(options); $('collection-filter').value=state.collection;
  $('catalog-count').textContent=state.sources.length;
  filterSources(); renderSelection();
}
function reviewMaterials() {
  if (locked() || !state.ready) return;
  const missing=state.pins.filter(id=>!sourceById(id));
  state.pins=state.pins.filter(id=>sourceById(id)); state.needsReview=false;
  drawSelection(); saveDraft();
  message('material-message',missing.length?`${missing.length} unavailable ${missing.length===1?'pin was':'pins were'} removed. Review the updated table.`:'Table updated. Review the images before starting.');
  $('refresh-materials').hidden=true; launchError();
}
async function loadProvider() {
  const result=await request('/api/providers');
  const previous=state.provider;
  state.provider=result.providers?.find(item=>item.id==='openai')||null;
  if (!state.provider?.configured || previous?.keySource!==state.provider.keySource) state.verified=false;
  if (!$('model').value && result.defaultModel) $('model').value=result.defaultModel;
  renderProvider();
}
async function loadRuns() { state.runs=(await request('/api/runs')).runs||[]; updateControls(); }
async function loadBatches() { state.batches=(await request('/api/batches')).batches||[]; updateControls(); }
function recoveredRun() {
  if (state.pendingBatch) return state.batches.find(batch=>batch.launch?.clientRequestId===state.pendingBatch.clientRequestId);
  return state.pending && state.runs.find(run=>run.launch?.clientRequestId===state.pending.clientRequestId);
}
function acceptRun(run) {
  const isBatch=!!state.pendingBatch;
  storePending(null); saveDraft();
  window.location.assign(isBatch?`/batch.html?batch=${encodeURIComponent(run.id)}`:`/?started=${encodeURIComponent(run.id)}`);
}

async function loadSetup() {
  if (state.loading) return;
  state.loading=true; state.ready=false; pageError(); updateControls();
  const results=await Promise.allSettled([loadCatalog(),loadProvider(),loadRuns(),loadBatches()]);
  state.ready=results.every(result=>result.status==='fulfilled'); state.loading=false;
  const failure=results.find(result=>result.status==='rejected');
  if (failure) pageError(failure.reason.message);
  if (!state.provider?.configured) $('connection-settings').open=true;
  const recovered=recoveredRun(); if (recovered) { acceptRun(recovered); return; }
  renderProvider();
  if (state.ready && LIMIT_KEYS.some(key=>!$(key).validity.valid)) $('customize-budget').open=true;
  if (state.ready) saveDraft();
  clearTimeout(state.timer); state.timer=setTimeout(pollStatus,10000);
}
async function pollStatus() {
  if (document.hidden) return;
  if (!state.launching && !state.loading) {
    await Promise.allSettled([loadRuns(),loadBatches()]);
    const recovered=recoveredRun(); if (recovered) { acceptRun(recovered); return; }
  }
  state.timer=setTimeout(pollStatus,state.runs.some(run=>run.status==='running')||state.batches.some(batch=>batch.status==='running')?3000:10000);
}
function metadataRow(list,label,value) {
  list.append(element('dt','',label),element('dd','',value));
}
function openPreview(id,opener) {
  const source=state.sources.find(item=>item.id===id); if (!source) return;
  state.previewId=id; state.previewReturn=opener;
  $('source-title').textContent=source.name; $('source-full').src=previewURL(source,true); $('source-full').alt=source.name;
  const list=$('source-metadata'); list.replaceChildren();
  metadataRow(list,'Size',`${source.width.toLocaleString()} × ${source.height.toLocaleString()} px`);
  if (source.credit) metadataRow(list,'Credit',source.credit);
  if (source.license) metadataRow(list,'License',source.license);
  if (source.url) { try { const url=new URL(source.url); if (['https:','http:'].includes(url.protocol)) { const link=element('a','','Original source ↗'); link.href=url.href; link.target='_blank'; link.rel='noopener noreferrer'; const dd=element('dd'); dd.append(link); list.append(element('dt','','Source'),dd); } } catch {} }
  $('toggle-preview-source').textContent=state.pins.includes(id)?'Unpin image':'Pin image';
  updateControls(); $('source-dialog').showModal(); $('close-source').focus();
}
async function checkAccess() {
  state.credentialBusy=true; renderProvider(); message('connection-message','Checking account access…');
  try {
    const result=await request('/api/providers/openai/test',{method:'POST',body:{},timeout:55000});
    const fragment=document.createDocumentFragment();
    for (const model of result.models||[]) { const option=element('option'); option.value=typeof model==='string'?model:model.id; if (option.value) fragment.append(option); }
    $('available-models').replaceChildren(fragment); state.verified=true;
    message('connection-message',`Access checked. ${result.models?.length||0} model IDs loaded; image support isn’t verified.`);
  } catch { state.verified=false; message('connection-message','Could not verify access. Check your key, account access and connection.',true); }
  finally { state.credentialBusy=false; renderProvider(); }
}
async function uploadFiles(files) {
  if (materialLocked() || !files.length) return;
  state.uploading=true; updateControls(); const uploads=[]; const failures=[]; let duplicates=0; const addedIds=[];
  const previousHashes=new Map(state.selected);
  const readFile=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not read this image.'));reader.readAsDataURL(file);});
  try {
    for (const file of files) {
      if (uploads.length>=state.uploadSlots) { failures.push('No upload slots remain.'); break; }
      if (!['image/png','image/jpeg','image/webp'].includes(file.type)) { failures.push(`${file.name}: choose PNG, JPEG or WebP.`); continue; }
      if (file.size>16*1024*1024) { failures.push(`${file.name}: images must be under 16 MB.`); continue; }
      message('material-message',`Adding ${file.name}…`);
      try {
        const result=await request('/api/sources',{method:'POST',body:{name:file.name.replace(/\.[^.]+$/,''),dataUrl:await readFile(file)}});
        const source=result.state?.sources?.at(-1);
        if (!source?.id) throw new Error('The server did not confirm the added image.');
        uploads.push(source);
      } catch(error) { failures.push(`${file.name}: ${error.message}`); }
    }
    await loadCatalog();
    for (const upload of uploads) {
      let source=sourceById(upload.id);
      if (!source) {
        // Catalog deduplication can keep an older ID for the exact same paper.
        let hash=upload.sha256;
        if (!hash && typeof upload.dataUrl==='string') {
          const encoded=upload.dataUrl.split(',')[1];
          const bytes=Uint8Array.from(atob(encoded),character=>character.charCodeAt(0));
          hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
        }
        source=state.sources.find(item=>item.sha256===hash);
        if (source) duplicates++;
      }
      if (source) { addedIds.push(source.id); state.selected.set(source.id,source.sha256); }
      else failures.push(`${upload.name || 'Uploaded image'} is already in the collection or unavailable. Choose it from the contact sheet.`);
    }
    state.pins=[...new Set([...state.pins,...addedIds])];
    state.needsReview=[...previousHashes].some(([id,hash])=>sourceById(id)?.sha256!==hash);
    if (!state.needsReview) drawSelection();
    else state.recipe={...state.recipe,pinnedIds:[...state.pins]};
    const added=addedIds.length-duplicates;
    message('material-message',[added?`${added} ${added===1?'image added':'images added'} and pinned.`:'',duplicates?`${duplicates===1?'An identical image is':`${duplicates} identical images are`} already in the collection; pinned the existing ${duplicates===1?'image':'images'}.`:'',...failures].filter(Boolean).join(' '),failures.length>0);
  } catch(error) { message('material-message',`${error.message} Reload setup to check which images were added.`,true); state.ready=false; pageError('Could not refresh your collection after upload.'); }
  finally { state.uploading=false; $('image-files').value=''; renderSelection(); saveDraft(); }
}
async function submitLaunch(body) {
  if (state.launching) return;
  state.launching=true; launchError(); $('refresh-materials').hidden=true; updateControls();
  try {
    const isBatch=!!state.pendingBatch;
    const result=await request(isBatch?'/api/batches':'/api/runs',{method:'POST',body});
    const work=isBatch?result.batch:result.run;
    if (!work?.id) throw new Error('The server did not confirm the work ID.');
    acceptRun(work);
  } catch(error) {
    await Promise.allSettled([loadRuns(),loadBatches()]);
    const recovered=recoveredRun();
    if (recovered) { acceptRun(recovered); return; }
    // A server rejection is definite. Network/5xx responses keep the exact request for a safe manual retry.
    if (error.status>=400 && error.status<500) {
      storePending(null);
      if (error.status===409) { state.needsReview=true; $('refresh-materials').hidden=false; renderSelection(); saveDraft(); }
    }
    launchError(error.message);
  } finally { state.launching=false; updateControls(); }
}

function renderReviewTable() {
  if (!state.reviewPlan) return;
  const index=Number($('review-table').value),entry=state.reviewPlan.entries[index];
  if (!entry) return;
  const fragment=document.createDocumentFragment();
  for (const id of entry.sourceIds) {
    const source=sourceById(id),figure=element('figure','review-source');figure.dataset.sourceId=id;
    const frame=element('div','review-source-frame'); if(source)frame.append(sourceImage(source));
    if (state.reviewPlan.materialSelection.pinnedIds.includes(id)) frame.append(element('span','material-state','Pinned'));
    figure.append(frame,element('figcaption','',source?.name||id));fragment.append(figure);
  }
  $('review-table-images').replaceChildren(fragment);
  const matching=state.reviewPlan.groups.filter((group,groupIndex)=>groupIndex!==entry.groupIndex&&group.count>entry.runIndex).length;
  const comparison=state.reviewPlan.mode==='compare'&&state.reviewPlan.materials!=='same'?(matching?' · Matches this run number in the other models':' · An extra run for this model'):'';
  $('review-table-detail').textContent=`Table ${index+1} of ${state.reviewPlan.totalRuns} · ${entry.sourceIds.length} images${comparison}`;
  $('previous-table').disabled=index===0; $('next-table').disabled=index===state.reviewPlan.entries.length-1;
}
function openBatchReview(plan) {
  if (!plan) return;
  state.reviewPlan=structuredClone(plan);
  state.reviewBody={clientRequestId:crypto.randomUUID(),spec:{prompt:TASK,...limits()},groups:structuredClone(plan.groups),mode:plan.mode,materials:plan.materials,materialSelection:structuredClone(plan.materialSelection),sourceIds:[...state.selected.keys()],sourceHashes:Object.fromEntries(state.selected)};
  const options=document.createDocumentFragment();
  for (const entry of plan.entries) { const option=element('option','',`${entry.model} · Run ${entry.runIndex+1}`);option.value=entry.index;options.append(option); }
  $('review-table').replaceChildren(options);$('review-table').value='0';
  $('batch-review-summary').textContent=`${plan.totalRuns} runs across ${plan.groups.length} ${plan.groups.length===1?'model':'models'} · up to ${plan.totalRuns*Number($('maxTurns').value)} model turns total. ${plan.materials==='same'?'One fixed table throughout.':plan.mode==='compare'?'Matching tables across models.':'Independent draws throughout.'}`;
  $('confirm-batch').firstElementChild.textContent=`Start ${plan.totalRuns} runs`;
  renderReviewTable();$('batch-review').showModal();$('close-batch-review').focus();
}
$('review-table').addEventListener('change',renderReviewTable);
for (const [id,delta] of [['previous-table',-1],['next-table',1]]) $(id).addEventListener('click',()=>{$('review-table').value=String(Number($('review-table').value)+delta);renderReviewTable();});
$('close-batch-review').addEventListener('click',()=>$('batch-review').close());
$('batch-review').addEventListener('close',()=>{$('launch-run').focus({preventScroll:true});});
$('confirm-batch').addEventListener('click',()=>{
  if (!state.reviewBody||locked())return;
  const body=structuredClone(state.reviewBody);
  try { storePending(body,'batch'); } catch { $('batch-review').close();launchError('Browser session storage is unavailable. Enable it so an interrupted start can be recovered.');return; }
  $('batch-review').close();saveDraft();submitLaunch(body);
});

$('fixed-prompt').textContent=TASK;
if (typeof draft?.model==='string') $('model').value=draft.model.slice(0,160);
for (const key of LIMIT_KEYS) if (Number.isSafeInteger(draft?.limits?.[key])) $(key).value=draft.limits[key];
const restoredBatch=state.pendingBatch || draft?.batch;
if (restoredBatch) {
  state.batchMode=restoredBatch.mode==='compare'?'compare':'explore';
  state.materialsChoice=['same','random','pinned-random'].includes(restoredBatch.materials)?restoredBatch.materials:null;
  if (Array.isArray(restoredBatch.groups) && restoredBatch.groups.length) {
    $('model').value=typeof restoredBatch.groups[0].model==='string'?restoredBatch.groups[0].model:'';
    $('run-count').value=restoredBatch.groups[0].count ?? '';
    for (const group of restoredBatch.groups.slice(1,BATCH_LIMITS.maxGroups)) addModelGroup(typeof group.model==='string'?group.model:'',group.count ?? '');
  }
}
if (currentPending()) {
  const settings=state.pendingBatch?.spec || state.pending;
  if (!state.pendingBatch) $('model').value=settings.model;
  for (const key of LIMIT_KEYS) $(key).value=settings[key];
}
renderBudget();
function changeFilter() {
  if (locked()) return;
  state.query=$('source-search').value; state.collection=$('collection-filter').value; state.page=0;
  filterSources();
  if (state.pool==='filtered' && !state.needsReview) drawSelection(); else renderSelection();
  saveDraft();
}
$('source-search').addEventListener('input',changeFilter);
$('collection-filter').addEventListener('change',changeFilter);
$('clear-search').addEventListener('click',()=>{$('source-search').value='';$('collection-filter').value='';changeFilter();$('source-search').focus();});
for (const [id,delta] of [['previous-page',-1],['next-page',1]]) $(id).addEventListener('click',()=>{state.page+=delta;filterSources();$('source-grid').scrollIntoView({block:'nearest'});});
$('clear-pins').addEventListener('click',()=>{if(materialLocked())return;state.pins=[];drawSelection();saveDraft();});
function changeRandomCount(value) { if(materialLocked())return;state.randomCount=value;drawSelection();saveDraft(); }
$('random-count').addEventListener('input',event=>changeRandomCount(event.target.value===''?NaN:Number(event.target.value)));
$('fewer-random').addEventListener('click',()=>changeRandomCount(Math.max(0,(Number.isInteger(state.randomCount)?state.randomCount:1)-1)));
$('more-random').addEventListener('click',()=>changeRandomCount(Math.min(state.maxSources,(Number.isInteger(state.randomCount)?state.randomCount:0)+1)));
$('random-pool').addEventListener('change',event=>{if(materialLocked())return;state.pool=event.target.value;drawSelection();saveDraft();});
$('reshuffle').addEventListener('click',()=>{if(materialLocked())return;state.seed=newSeed();drawSelection();saveDraft();});
$('review-materials').addEventListener('click',reviewMaterials);
$('add-images').addEventListener('click',()=>$('image-files').click());
$('empty-add').addEventListener('click',()=>$('image-files').click());
$('image-files').addEventListener('change',event=>uploadFiles([...event.target.files]));
$('close-source').addEventListener('click',()=>$('source-dialog').close());
$('source-dialog').addEventListener('close',()=>{state.previewId=null;state.previewReturn?.focus({preventScroll:true});state.previewReturn=null;});
$('toggle-preview-source').addEventListener('click',()=>togglePin(state.previewId));
for (const radio of document.querySelectorAll('[name=budget]')) radio.addEventListener('change',()=>{for(const [key,value]of Object.entries(PRESETS[radio.value]))$(key).value=value;renderBudget();saveDraft();});
for (const key of LIMIT_KEYS) $(key).addEventListener('input',()=>{renderBudget();saveDraft();});
$('model-groups').addEventListener('input',()=>{updateControls();saveDraft();});
$('add-model').addEventListener('click',()=>{if(locked())return;addModelGroup('',1);updateControls();saveDraft();$('model-groups').lastElementChild.querySelector('.group-model').focus();});
for (const radio of document.querySelectorAll('[name=batch-mode]')) radio.addEventListener('change',()=>{state.batchMode=radio.value;updateControls();saveDraft();});
$('batch-materials').addEventListener('change',()=>{state.materialsChoice=$('batch-materials').value;updateControls();saveDraft();});
$('key-form').addEventListener('submit',async event=>{
  event.preventDefault(); if(locked()||state.credentialBusy)return;
  let apiKey=$('api-key').value.trim(); if(!apiKey)return;
  state.credentialBusy=true; state.verified=false; $('api-key').value=''; renderProvider(); message('connection-message','Saving session key…');
  try { await request('/api/providers/openai',{method:'POST',body:{apiKey}}); apiKey=''; await loadProvider(); await checkAccess(); }
  catch { message('connection-message','Could not save this key. Check the key and local server.',true); }
  finally { apiKey=''; state.credentialBusy=false; renderProvider(); }
});
$('test-connection').addEventListener('click',()=>{if(!locked()&&!state.credentialBusy)checkAccess();});
$('forget-key').addEventListener('click',async()=>{
  if(locked()||state.credentialBusy)return;
  state.credentialBusy=true; renderProvider();
  try { await request('/api/providers/openai',{method:'DELETE'}); state.verified=false; await loadProvider(); $('available-models').replaceChildren(); message('connection-message',state.provider?.configured?'Session key removed. Using the server key.':'Session key removed.'); }
  catch { message('connection-message','Could not remove the session key. Check the local server.',true); }
  finally { state.credentialBusy=false; renderProvider(); }
});
$('run-form').addEventListener('submit',event=>{
  event.preventDefault(); if($('launch-run').disabled)return;
  $('customize-budget').open=LIMIT_KEYS.some(key=>!$(key).validity.valid)||$('customize-budget').open;
  if(!$('run-form').reportValidity())return;
  const batch=batchSettings();
  if (batch.isBatch) { openBatchReview(batch.plan); return; }
  const sourceIds=[...state.selected.keys()];
  const body={provider:'openai',model:$('model').value.trim(),prompt:TASK,...limits(),sourceIds,sourceHashes:Object.fromEntries(state.selected),materialSelection:structuredClone(state.reviewedRecipe),clientRequestId:crypto.randomUUID()};
  try { storePending(body); } catch { launchError('Browser session storage is unavailable. Enable it so an interrupted start can be recovered.'); return; }
  saveDraft(); submitLaunch(body);
});
$('retry-start').addEventListener('click',()=>{if(currentPending()&&!state.loading)submitLaunch(currentPending());});
$('refresh-materials').addEventListener('click',async()=>{await loadSetup();if(state.ready)reviewMaterials();});
$('retry-load').addEventListener('click',loadSetup);
document.addEventListener('visibilitychange',()=>{clearTimeout(state.timer);if(!document.hidden)pollStatus();});
window.addEventListener('pagehide',()=>{clearTimeout(state.timer);$('api-key').value='';});
loadSetup();
