const $ = id => document.getElementById(id);
const TASK = 'Create an original collage from the provided source images. Choose your own subject and composition. There is no target image. Give the finished work a title and a short statement.';
const PRESETS = {
  small: {maxPieces:12, maxActions:60, maxTurns:6, maxMinutes:5, maxOutputTokens:4096},
  standard: {maxPieces:24, maxActions:120, maxTurns:12, maxMinutes:10, maxOutputTokens:4096},
  extended: {maxPieces:48, maxActions:240, maxTurns:24, maxMinutes:20, maxOutputTokens:4096},
};
const LIMIT_KEYS = Object.keys(PRESETS.standard);
const DRAFT_KEY = 'offcut.new-run.draft.v1';
const PENDING_KEY = 'offcut.new-run.pending.v1';
const readStored = key => { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } };
const draft = readStored(DRAFT_KEY);
const savedPending = readStored(PENDING_KEY);
// Only our own non-secret launch fields are ever recovered from browser storage.
function restorePending(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.sourceIds) || !value.sourceHashes || typeof value.clientRequestId !== 'string') return null;
  const keys = ['provider', 'model', 'prompt', ...LIMIT_KEYS, 'sourceIds', 'sourceHashes', 'clientRequestId'];
  if (Object.keys(value).some(key => !keys.includes(key))) return null;
  return value;
}
const state = {
  sources: [], selected: new Map(), tiles: new Map(), maxSources:24,
  provider:null, verified:false, runs:[], ready:false, loading:false, uploading:false,
  credentialBusy:false, launching:false, pending:restorePending(savedPending),
  query:'', previewId:null, previewReturn:null, selectionInitialized:false, timer:null,
};
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
  const value = {sources:[...state.selected].map(([id, sha256]) => ({id, sha256})), model:$('model').value, limits:limits()};
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(value)); } catch { /* The in-page draft remains usable. */ }
}
function storePending(value) {
  if (value) sessionStorage.setItem(PENDING_KEY, JSON.stringify(value));
  else { try { sessionStorage.removeItem(PENDING_KEY); } catch {} }
  state.pending = value;
}
function locked() { return state.loading || state.uploading || state.launching || !!state.pending; }
function updateControls() {
  const lock = locked();
  const active = state.runs.find(run => run.status === 'running');
  for (const tile of state.tiles.values()) tile.querySelector('input').disabled=lock || !state.ready;
  for (const button of $('selected-tray').querySelectorAll('button')) button.disabled=lock || !state.ready;
  $('model').disabled=lock || !state.ready;
  $('budget-presets').disabled=lock || !state.ready;
  $('custom-limits').disabled=lock || !state.ready;
  const invalidLimits = LIMIT_KEYS.some(key => !$(key).validity.valid);
  $('select-all').disabled=lock || !state.ready || state.selected.size === state.sources.length;
  $('clear-selection').disabled=lock || !state.ready || !state.selected.size;
  $('add-images').disabled=lock || !state.ready || state.sources.length >= state.maxSources;
  $('add-images').firstElementChild.textContent=state.uploading?'…':'+';
  $('empty-add').disabled=$('add-images').disabled;
  $('refresh-materials').disabled=lock;
  $('api-key').disabled=lock || state.credentialBusy || !state.ready;
  $('save-key').disabled=$('api-key').disabled;
  $('test-connection').disabled=lock || state.credentialBusy || !state.provider?.configured;
  $('forget-key').disabled=lock || state.credentialBusy;
  $('retry-start').disabled=state.launching || state.loading;
  $('retry-start').textContent=state.launching?'Checking start…':'Retry start';
  $('pending-notice').hidden=!state.pending || state.launching;
  $('active-notice').hidden=!active || !!state.pending;
  if (active) $('active-link').href=`/work.html?run=${encodeURIComponent(active.id)}`;
  $('launch-run').disabled=lock || state.credentialBusy || !state.ready || !state.provider?.configured || !state.selected.size || !!active || !$('model').value.trim() || !$('model').validity.valid || invalidLimits;
  $('launch-run').firstElementChild.textContent=state.launching?'Starting…':'Start run';
  $('launch-run').setAttribute('aria-busy', String(state.launching));
  $('launch-help').textContent=state.launching?'Starting your run…':state.pending?'Retry the original start above.':state.loading?'Loading setup…':!state.ready?'Reload setup to continue.':state.uploading?'Adding your images…':active?'One run at a time. This one is still working.':!state.selected.size?'Choose at least one source image.':!state.provider?.configured?'Add an API key in Connection.':!$('model').value.trim()?'Choose a model to begin.':!$('model').validity.valid?'Enter a valid model ID.':invalidLimits?'Check the limits above.':'Come back for the finished work and its playback.';
  $('run-summary').textContent=`${state.selected.size} ${state.selected.size===1?'image':'images'} · ${$('maxPieces').value || '—'} fragments max`;
  $('upload-capacity').textContent=state.sources.length>=state.maxSources?`Collection full: ${state.maxSources} images. Removing or replacing images isn’t available yet.`:`PNG, JPEG or WebP · ${state.sources.length} of ${state.maxSources} images in your local collection`;
  if (state.previewId) $('toggle-preview-source').disabled=lock || !state.ready;
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
function previewURL(source) { return `${source.previewUrl}?v=${encodeURIComponent(source.sha256)}`; }
function createTile(source) {
  const tile=element('article','material-tile');
  tile.dataset.sourceId=source.id;
  const label=element('label','material-pick');
  const input=element('input'); input.type='checkbox'; input.value=source.id; input.setAttribute('aria-label',`Select ${source.name}`);
  const frame=element('span','material-image');
  const image=element('img'); image.src=previewURL(source); image.alt=''; image.loading='lazy'; image.decoding='async';
  image.addEventListener('error',()=>{image.hidden=true;frame.append(element('span','image-fallback','Preview unavailable'));},{once:true});
  frame.append(image); label.append(input,frame,element('span','material-caption',source.name)); label.title=source.name;
  input.addEventListener('change',()=>setSelected(source.id,input.checked));
  const details=element('button','material-details'); details.type='button'; details.setAttribute('aria-label',`View ${source.name}`);
  details.innerHTML='<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4M7 7h6v6H7z"/></svg>';
  details.addEventListener('click',()=>openPreview(source.id,details));
  tile.append(label,details); return tile;
}
function filterSources() {
  let count=0;
  for (const source of state.sources) {
    const shown=`${source.name} ${source.credit||''}`.toLocaleLowerCase().includes(state.query);
    state.tiles.get(source.id).hidden=!shown;
    if (shown) count++;
  }
  $('source-empty').hidden=state.sources.length>0;
  $('search-empty').hidden=!state.sources.length || count>0;
  $('source-grid').hidden=!count;
}
function renderSelection(focusNextId=null) {
  for (const [id,tile] of state.tiles) tile.querySelector('input').checked=state.selected.has(id);
  $('selection-count').textContent=`${state.selected.size} ${state.selected.size===1?'image':'images'}`;
  const fragment=document.createDocumentFragment();
  for (const id of state.selected.keys()) {
    const source=state.sources.find(item=>item.id===id); if (!source) continue;
    const button=element('button','tray-source'); button.type='button'; button.dataset.sourceId=id;
    button.setAttribute('aria-label',`Remove ${source.name} from selection`); button.title=`Remove ${source.name}`;
    const image=element('img'); image.src=previewURL(source); image.alt=''; button.append(image);
    button.addEventListener('click',()=>{
      const ids=[...state.selected.keys()]; const index=ids.indexOf(id);
      setSelected(id,false,ids[index+1]||ids[index-1]||'clear');
    });
    fragment.append(button);
  }
  if (!state.selected.size) fragment.append(element('p','','Choose at least one image above.'));
  $('selected-tray').replaceChildren(fragment);
  if (state.previewId) $('toggle-preview-source').textContent=state.selected.has(state.previewId)?'Remove from selection':'Select image';
  updateControls();
  if (focusNextId) {
    const next=[...$('selected-tray').children].find(node=>node.dataset.sourceId===focusNextId);
    (next||$('select-all')).focus({preventScroll:true});
  }
}
function setSelected(id, selected, focusNextId) {
  if (locked() || !state.ready) return;
  const source=state.sources.find(item=>item.id===id); if (!source) return;
  if (selected) state.selected.set(id,source.sha256); else state.selected.delete(id);
  renderSelection(focusNextId); saveDraft();
}
async function loadCatalog(catalog) {
  const result=catalog || await request('/api/source-catalog');
  state.sources=result.sources||[]; state.maxSources=result.limits?.maxSources||24;
  let removed=0;
  if (!state.selectionInitialized) {
    const previous=state.pending ? state.pending.sourceIds.map(id=>({id,sha256:state.pending.sourceHashes[id]})) : Array.isArray(draft?.sources) ? draft.sources : null;
    state.selected=new Map((previous||state.sources.slice(0,3)).map(source=>[source.id,source.sha256]));
    state.selectionInitialized=true;
  }
  for (const [id,hash] of state.selected) {
    if (!state.sources.some(source=>source.id===id && source.sha256===hash)) { state.selected.delete(id); removed++; }
  }
  if (removed) message('material-message',`${removed} selected ${removed===1?'image changed or is no longer available':'images changed or are no longer available'}. Review your selection.`,true);
  const fragment=document.createDocumentFragment(); state.tiles.clear();
  for (const source of state.sources) { const tile=createTile(source); state.tiles.set(source.id,tile); fragment.append(tile); }
  $('source-grid').replaceChildren(fragment); $('source-grid').setAttribute('aria-busy','false');
  $('catalog-count').textContent=state.sources.length;
  filterSources(); renderSelection();
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
function recoveredRun() { return state.pending && state.runs.find(run=>run.launch?.clientRequestId===state.pending.clientRequestId); }
function acceptRun(run) {
  storePending(null); saveDraft();
  window.location.assign(`/?started=${encodeURIComponent(run.id)}`);
}
async function loadSetup() {
  if (state.loading) return;
  state.loading=true; state.ready=false; pageError(); updateControls();
  const results=await Promise.allSettled([loadCatalog(),loadProvider(),loadRuns()]);
  state.ready=results.every(result=>result.status==='fulfilled'); state.loading=false;
  const failure=results.find(result=>result.status==='rejected');
  if (failure) pageError(failure.reason.message);
  if (!state.provider?.configured) $('connection-settings').open=true;
  const recovered=recoveredRun(); if (recovered) { acceptRun(recovered); return; }
  renderProvider();
  if (state.ready && LIMIT_KEYS.some(key=>!$(key).validity.valid)) $('customize-budget').open=true;
  clearTimeout(state.timer); state.timer=setTimeout(pollStatus,10000);
}
async function pollStatus() {
  if (document.hidden) return;
  if (!state.launching && !state.loading) {
    await loadRuns().catch(()=>{});
    const recovered=recoveredRun(); if (recovered) { acceptRun(recovered); return; }
  }
  state.timer=setTimeout(pollStatus,state.runs.some(run=>run.status==='running')?3000:10000);
}
function metadataRow(list,label,value) {
  list.append(element('dt','',label),element('dd','',value));
}
function openPreview(id,opener) {
  const source=state.sources.find(item=>item.id===id); if (!source) return;
  state.previewId=id; state.previewReturn=opener;
  $('source-title').textContent=source.name; $('source-full').src=previewURL(source); $('source-full').alt=source.name;
  const list=$('source-metadata'); list.replaceChildren();
  metadataRow(list,'Size',`${source.width.toLocaleString()} × ${source.height.toLocaleString()} px`);
  if (source.credit) metadataRow(list,'Credit',source.credit);
  if (source.license) metadataRow(list,'License',source.license);
  if (source.url) { try { const url=new URL(source.url); if (['https:','http:'].includes(url.protocol)) { const link=element('a','','Original source ↗'); link.href=url.href; link.target='_blank'; link.rel='noopener noreferrer'; const dd=element('dd'); dd.append(link); list.append(element('dt','','Source'),dd); } } catch {} }
  $('toggle-preview-source').textContent=state.selected.has(id)?'Remove from selection':'Select image';
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
  if (locked() || !state.ready || !files.length) return;
  state.uploading=true; updateControls(); let added=0; const failures=[];
  const readFile=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not read this image.'));reader.readAsDataURL(file);});
  try {
    for (const file of files) {
      if (state.sources.length+added>=state.maxSources) { failures.push('The collection has reached 24 images.'); break; }
      if (!['image/png','image/jpeg','image/webp'].includes(file.type)) { failures.push(`${file.name}: choose PNG, JPEG or WebP.`); continue; }
      if (file.size>16*1024*1024) { failures.push(`${file.name}: images must be under 16 MB.`); continue; }
      message('material-message',`Adding ${file.name}…`);
      try {
        const result=await request('/api/sources',{method:'POST',body:{name:file.name.replace(/\.[^.]+$/,''),dataUrl:await readFile(file)}});
        // Source uploads append atomically. Only the last source belongs to this
        // upload; other newly discovered images may have come from another tab.
        const source=result.state?.sources?.at(-1);
        if (!source?.id) throw new Error('The server did not confirm the added image.');
        state.selected.set(source.id,null);
        added++;
      } catch(error) { failures.push(`${file.name}: ${error.message}`); }
    }
    const result=await request('/api/source-catalog');
    for (const source of result.sources||[]) if (state.selected.has(source.id) && state.selected.get(source.id)===null) state.selected.set(source.id,source.sha256);
    await loadCatalog(result);
    message('material-message',[added?`${added} ${added===1?'image added':'images added'}.`:'',...failures].filter(Boolean).join(' '),failures.length>0);
  } catch(error) { message('material-message',`${error.message} Reload setup to check which images were added.`,true); state.ready=false; pageError('Could not refresh your collection after upload.'); }
  finally { state.uploading=false; $('image-files').value=''; renderSelection(); saveDraft(); }
}
async function submitLaunch(body) {
  if (state.launching) return;
  state.launching=true; launchError(); $('refresh-materials').hidden=true; updateControls();
  try {
    const result=await request('/api/runs',{method:'POST',body});
    if (!result.run?.id) throw new Error('The server did not confirm the work ID.');
    acceptRun(result.run);
  } catch(error) {
    await loadRuns().catch(()=>{});
    const recovered=recoveredRun();
    if (recovered) { acceptRun(recovered); return; }
    // A server rejection is definite. Network/5xx responses keep the exact request for a safe manual retry.
    if (error.status>=400 && error.status<500) {
      storePending(null);
      if (error.status===409) $('refresh-materials').hidden=false;
    }
    launchError(error.message);
  } finally { state.launching=false; updateControls(); }
}

$('fixed-prompt').textContent=TASK;
if (typeof draft?.model==='string') $('model').value=draft.model.slice(0,160);
for (const key of LIMIT_KEYS) if (Number.isSafeInteger(draft?.limits?.[key])) $(key).value=draft.limits[key];
if (state.pending) {
  $('model').value=state.pending.model;
  for (const key of LIMIT_KEYS) $(key).value=state.pending[key];
}
renderBudget();
$('source-search').addEventListener('input',event=>{state.query=event.target.value.trim().toLocaleLowerCase();filterSources();});
$('clear-search').addEventListener('click',()=>{$('source-search').value='';state.query='';filterSources();$('source-search').focus();});
$('select-all').addEventListener('click',()=>{if(locked())return;for(const source of state.sources)state.selected.set(source.id,source.sha256);renderSelection();saveDraft();});
$('clear-selection').addEventListener('click',()=>{if(locked())return;state.selected.clear();renderSelection();saveDraft();});
$('add-images').addEventListener('click',()=>$('image-files').click());
$('empty-add').addEventListener('click',()=>$('image-files').click());
$('image-files').addEventListener('change',event=>uploadFiles([...event.target.files]));
$('close-source').addEventListener('click',()=>$('source-dialog').close());
$('source-dialog').addEventListener('close',()=>{state.previewId=null;state.previewReturn?.focus({preventScroll:true});state.previewReturn=null;});
$('toggle-preview-source').addEventListener('click',()=>setSelected(state.previewId,!state.selected.has(state.previewId)));
for (const radio of document.querySelectorAll('[name=budget]')) radio.addEventListener('change',()=>{for(const [key,value]of Object.entries(PRESETS[radio.value]))$(key).value=value;renderBudget();saveDraft();});
for (const key of LIMIT_KEYS) $(key).addEventListener('input',()=>{renderBudget();saveDraft();});
$('model').addEventListener('input',()=>{updateControls();saveDraft();});
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
  const sourceIds=[...state.selected.keys()];
  const body={provider:'openai',model:$('model').value.trim(),prompt:TASK,...limits(),sourceIds,sourceHashes:Object.fromEntries(state.selected),clientRequestId:crypto.randomUUID()};
  try { storePending(body); } catch { launchError('Browser session storage is unavailable. Enable it so an interrupted start can be recovered.'); return; }
  saveDraft(); submitLaunch(body);
});
$('retry-start').addEventListener('click',()=>{if(state.pending&&!state.loading)submitLaunch(state.pending);});
$('refresh-materials').addEventListener('click',async()=>{await loadSetup();if(state.ready){$('refresh-materials').hidden=true;launchError();saveDraft();}});
$('retry-load').addEventListener('click',loadSetup);
document.addEventListener('visibilitychange',()=>{clearTimeout(state.timer);if(!document.hidden)pollStatus();});
window.addEventListener('pagehide',()=>{clearTimeout(state.timer);$('api-key').value='';});
loadSetup();
