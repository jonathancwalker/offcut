const $ = id => document.getElementById(id);
const PAGE_SIZE = 24;
const TASK = 'Create an original collage from the provided source images. Choose your own subject and composition. There is no target image. Give the finished work a title and a short statement.';
const LIMITS = {maxTurns:12,maxActions:120,maxPieces:24,maxOutputTokens:4096,maxMinutes:10};
const state = {provider:null,sources:[],runs:[],archives:[],cards:new Map(),query:'',model:'',status:'all',visibleLimit:PAGE_SIZE,loaded:false,refreshing:false,setupLoading:false,setupReady:false,setupReturn:null,launching:false,pendingLaunch:null,checkingLaunch:false,credentialBusy:false,timer:null};
const statusNames = {running:'Working',completed:'Completed',archived:'Archived',stopped:'Stopped',failed:'Failed',interrupted:'Interrupted',limit_reached:'Limit reached'};
const isActive = run => run.status === 'running';
const workLabel = id => `Work · ${id.startsWith('archive-') ? 'A'+id.slice(8) : id.replace(/^run-/,'').slice(0,8)}`;
const workPath = run => `/api/${run.recordType === 'archive' ? 'archives' : 'runs'}/${encodeURIComponent(run.id)}`;
const modelName = run => run.spec?.model || 'Model not recorded';
const providerName = run => run.spec?.provider === 'openai' ? 'OpenAI' : run.spec?.provider || 'Saved session';
const dateLabel = value => {const d=new Date(value);return Number.isNaN(d.getTime())?'Date not recorded':d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});};
function element(tag, className, text) {const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node;}
async function request(path,{method='GET',body,timeout=30000}={}) {
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeout);
  try {
    const response=await fetch(path,{method,signal:controller.signal,cache:'no-store',...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    let data;try{data=await response.json();}catch{throw new Error('The local server returned an unreadable response.');}
    if(!response.ok){const error=new Error(data.error||`Request failed (${response.status}).`);error.status=response.status;throw error;}
    return data;
  } catch(error){if(error.name==='AbortError')throw new Error('Request timed out. Check the library before trying again.');if(error instanceof TypeError)throw new Error('The local server is unavailable.');throw error;}
  finally{clearTimeout(timer);}
}
function pageError(message){$('page-error-message').textContent=message||'';$('page-error').hidden=!message;}
function connectionMessage(message,error=false){$('connection-message').textContent=message;$('connection-message').classList.toggle('error',error);}
function updateLaunch(){
  const active=state.runs.some(isActive);
  $('launch-run').disabled=state.launching||state.credentialBusy||!!state.pendingLaunch||!state.setupReady||!state.provider?.configured||!state.sources.length||active||!$('model').value.trim();
  $('launch-run').textContent=state.launching?'Starting…':'Start';$('launch-run').setAttribute('aria-busy',String(state.launching));$('close-setup').disabled=state.launching;
  $('launch-help').textContent=state.launching?'Starting work…':state.pendingLaunch?'Check whether the last attempt started.':state.setupLoading?'Loading setup…':!state.setupReady?'Setup unavailable. Close and retry.':active?'A model is already working.':!state.provider?.configured?'Connect an API key.':!state.sources.length?'No source images available.':!$('model').value.trim()?'Choose a model.':'Return to the library when it’s done.';
  $('check-launch').hidden=!state.pendingLaunch||state.launching;$('check-launch').disabled=state.checkingLaunch||state.launching;$('check-launch').textContent=state.checkingLaunch?'Checking…':'Check for a started work';
}
function renderProvider(){
  const configured=!!state.provider?.configured;
  $('provider-status').textContent=configured?'Connected':'Not connected';$('provider-status').classList.toggle('connected',configured);
  $('test-connection').disabled=!configured||state.credentialBusy;$('forget-key').hidden=state.provider?.keySource!=='session';$('forget-key').disabled=state.credentialBusy;$('save-key').disabled=state.credentialBusy;$('api-key').disabled=state.credentialBusy;
  $('key-help').textContent=state.provider?.keySource==='environment'?'Using the server key. A session key overrides it.':'Kept in server memory. Never saved to browser storage or exports.';updateLaunch();
}
async function loadProvider(){const result=await request('/api/providers');state.provider=result.providers?.find(p=>p.id==='openai')||null;if(!$('model').value&&result.defaultModel)$('model').value=result.defaultModel;renderProvider();}
async function loadSources(){
  const result=await request('/api/state');state.sources=result.state?.sources||[];
  const fragment=document.createDocumentFragment();
  for(const source of state.sources){const figure=element('figure','setup-source');const image=element('img');image.src=source.dataUrl;image.alt='';image.loading='lazy';image.decoding='async';image.addEventListener('error',()=>image.replaceWith(element('span','source-error','Preview unavailable')),{once:true});const caption=element('figcaption','',source.name);caption.title=source.name;figure.append(image,caption);fragment.append(figure);}
  if(!state.sources.length)fragment.append(element('p','field-help','No source images available.'));
  $('setup-sources').replaceChildren(fragment);$('materials-count').textContent=state.sources.length;updateLaunch();
}
function allWorks(){return [...state.runs,...state.archives].filter(run=>!isActive(run)).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))||a.id.localeCompare(b.id));}
function filteredWorks(){return allWorks().filter(run=>(state.status==='all'||run.status===state.status)&&(!state.model||(run.spec?.model||'__unrecorded__')===state.model)&&(!state.query||`${workLabel(run.id)} ${run.id} ${modelName(run)} ${providerName(run)}`.toLocaleLowerCase().includes(state.query)));}
function createCard(run){
  const card=element('a','work-card');card.href=`/work.html?run=${encodeURIComponent(run.id)}`;card.dataset.workId=run.id;
  const preview=element('div','work-preview');const image=element('img');image.alt='';image.loading='lazy';image.decoding='async';const fallback=element('span','preview-fallback','Preview unavailable');fallback.hidden=true;
  image.addEventListener('error',()=>{image.hidden=true;fallback.hidden=false;});image.addEventListener('load',()=>{image.hidden=false;fallback.hidden=true;});preview.append(image,fallback);
  const heading=element('div','card-heading');heading.append(element('h2'),element('span','work-status'));
  const origin=element('div','card-origin');origin.append(element('span'),element('time'));
  card.append(preview,heading,element('p','card-model'),origin);return card;
}
function updateCard(card,run){
  const label=workLabel(run.id);const model=modelName(run);const status=statusNames[run.status]||run.status;
  card.setAttribute('aria-label',`${label}, ${model}, ${status}`);card.querySelector('h2').textContent=label;
  const badge=card.querySelector('.work-status');badge.textContent=status;badge.dataset.status=run.status;
  const modelNode=card.querySelector('.card-model');modelNode.textContent=model;modelNode.title=model;
  card.querySelector('.card-origin>span').textContent=providerName(run);const time=card.querySelector('time');time.textContent=dateLabel(run.createdAt);if(run.createdAt)time.dateTime=run.createdAt;
  const image=card.querySelector('img');const src=`${workPath(run)}/render.png?revision=${encodeURIComponent(run.revision??run.updatedAt??run.acceptedActions??0)}`;
  if(image.getAttribute('src')!==src)image.src=src;
}
function renderPending(){
  const active=state.runs.filter(isActive);$('pending-section').hidden=!active.length;
  const focused=document.activeElement?.dataset?.pendingId;
  const fragment=document.createDocumentFragment();
  for(const run of active){const link=element('a','pending-work');link.href=`/work.html?run=${encodeURIComponent(run.id)}`;link.dataset.pendingId=run.id;const status=element('span','work-status','Working');status.dataset.status='running';link.append(element('span','',workLabel(run.id)),element('strong','',modelName(run)),status,element('span','pending-arrow','↗'));fragment.append(link);}
  $('pending-list').replaceChildren(fragment);
  if(focused)[...$('pending-list').children].find(node=>node.dataset.pendingId===focused)?.focus({preventScroll:true});
}
function renderFilters(){
  const values=[...new Set(allWorks().map(run=>run.spec?.model||'__unrecorded__'))].sort();
  const signature=JSON.stringify(values);if($('model-filter').dataset.signature===signature)return;$('model-filter').dataset.signature=signature;
  const fragment=document.createDocumentFragment();const all=element('option','','All models');all.value='';fragment.append(all);
  for(const value of values){const option=element('option','',value==='__unrecorded__'?'Model not recorded':value);option.value=value;fragment.append(option);}
  $('model-filter').replaceChildren(fragment);if(!values.includes(state.model))state.model='';$('model-filter').value=state.model;
}
function renderLibrary(){
  renderPending();renderFilters();
  const works=allWorks();const results=filteredWorks();const visible=results.slice(0,state.visibleLimit);const focused=document.activeElement?.dataset?.workId;
  const fragment=document.createDocumentFragment();for(const run of visible){const card=state.cards.get(run.id)||createCard(run);state.cards.set(run.id,card);updateCard(card,run);fragment.append(card);}
  for(const id of state.cards.keys())if(!works.some(run=>run.id===id))state.cards.delete(id);
  $('run-list').replaceChildren(fragment);if(focused&&state.cards.get(focused)?.isConnected)state.cards.get(focused).focus({preventScroll:true});
  $('run-count').textContent=works.length;$('empty-library').hidden=!state.loaded||works.length>0;$('no-matches').hidden=!state.loaded||!works.length||results.length>0;
  $('collection-pagination').hidden=!results.length;$('visible-count').textContent=`${visible.length} of ${results.length}`;$('show-more-runs').hidden=visible.length>=results.length;updateLaunch();
}
async function loadRuns(){state.runs=(await request('/api/runs')).runs||[];renderLibrary();}
async function refresh(){
  if(state.refreshing)return;state.refreshing=true;$('refresh-runs').disabled=true;
  try{
    const results=await Promise.allSettled([request('/api/runs'),request('/api/archives')]);
    if(results[0].status==='fulfilled')state.runs=results[0].value.runs||[];
    if(results[1].status==='fulfilled')state.archives=results[1].value.runs||[];
    const failures=results.filter(r=>r.status==='rejected');state.loaded=results.some(r=>r.status==='fulfilled');
    pageError(failures.length?failures[0].reason.message:'');renderLibrary();
  }finally{state.refreshing=false;$('refresh-runs').disabled=false;clearTimeout(state.timer);state.timer=setTimeout(()=>{if(!document.hidden)refresh();},state.runs.some(isActive)?3000:15000);}
}
async function openSetup(opener){
  state.setupReturn=opener;state.setupReady=false;state.setupLoading=true;$('launch-error').hidden=true;updateLaunch();$('setup-dialog').showModal();$('setup-title').focus({preventScroll:true});
  const results=await Promise.allSettled([loadProvider(),loadSources(),loadRuns()]);state.setupReady=results.every(r=>r.status==='fulfilled');state.setupLoading=false;$('connection-settings').open=!state.provider?.configured;
  if(!state.setupReady){$('launch-error').textContent=results.find(r=>r.status==='rejected').reason.message;$('launch-error').hidden=false;}updateLaunch();
}
function pendingRun(){const pending=state.pendingLaunch;return pending&&state.runs.find(run=>!pending.ids.has(run.id)&&Object.entries(pending.spec).every(([key,value])=>run.spec?.[key]===value));}
async function acceptStartedWork(run){
  state.pendingLaunch=null;$('launch-error').hidden=true;state.setupReturn=null;$('setup-dialog').close();
  state.runs=[run,...state.runs.filter(r=>r.id!==run.id)];state.loaded=true;renderLibrary();$('launch-confirmation').textContent=`${workLabel(run.id)} started. Return here for the finished work.`;
  const row=[...$('pending-list').children].find(node=>node.dataset.pendingId===run.id);if(row)row.focus();else state.cards.get(run.id)?.focus();
}
for(const button of document.querySelectorAll('[data-open-setup]'))button.addEventListener('click',()=>openSetup(button));
$('close-setup').addEventListener('click',()=>{if(!state.launching)$('setup-dialog').close();});
$('setup-dialog').addEventListener('cancel',event=>{if(state.launching)event.preventDefault();});
$('setup-dialog').addEventListener('close',()=>{$('api-key').value='';state.setupReturn?.focus({preventScroll:true});});
$('fixed-prompt').textContent=TASK;
$('run-search').addEventListener('input',event=>{state.query=event.target.value.trim().toLocaleLowerCase();state.visibleLimit=PAGE_SIZE;renderLibrary();});
$('model-filter').addEventListener('change',event=>{state.model=event.target.value;state.visibleLimit=PAGE_SIZE;renderLibrary();});
$('status-filter').addEventListener('change',event=>{state.status=event.target.value;state.visibleLimit=PAGE_SIZE;renderLibrary();});
$('clear-filters').addEventListener('click',()=>{state.query='';state.model='';state.status='all';state.visibleLimit=PAGE_SIZE;$('run-search').value='';$('model-filter').value='';$('status-filter').value='all';renderLibrary();$('run-search').focus();});
$('show-more-runs').addEventListener('click',()=>{const previous=state.visibleLimit;state.visibleLimit+=PAGE_SIZE;renderLibrary();$('run-list').children[previous]?.focus({preventScroll:true});});
$('model').addEventListener('input',updateLaunch);
$('key-form').addEventListener('submit',async event=>{
  event.preventDefault();let apiKey=$('api-key').value.trim();if(!apiKey||state.credentialBusy)return;state.credentialBusy=true;$('api-key').value='';renderProvider();connectionMessage('Connecting…');
  try{await request('/api/providers/openai',{method:'POST',body:{apiKey}});apiKey='';await loadProvider();connectionMessage('Key saved for this session. Test connection to verify access.');}
  catch{connectionMessage('Could not connect. Check the server and API key.',true);}finally{apiKey='';state.credentialBusy=false;renderProvider();}
});
$('test-connection').addEventListener('click',async()=>{
  if(state.credentialBusy)return;state.credentialBusy=true;renderProvider();connectionMessage('Checking access…');
  try{const result=await request('/api/providers/openai/test',{method:'POST',body:{},timeout:65000});const fragment=document.createDocumentFragment();for(const model of result.models||[]){const option=element('option');option.value=typeof model==='string'?model:model.id;if(option.value)fragment.append(option);}$('available-models').replaceChildren(fragment);connectionMessage(`Connected. ${result.models?.length||0} models listed.`);}
  catch{connectionMessage('Connection test failed. Check your key, account access, and network.',true);}finally{state.credentialBusy=false;renderProvider();}
});
$('forget-key').addEventListener('click',async()=>{
  if(state.credentialBusy)return;state.credentialBusy=true;renderProvider();
  try{await request('/api/providers/openai',{method:'DELETE'});await loadProvider();$('available-models').replaceChildren();connectionMessage(state.provider?.configured?'Session key removed. Using the server key.':'Session key removed.');}
  catch{connectionMessage('Could not remove the key. Check the server.',true);}finally{state.credentialBusy=false;renderProvider();}
});
$('run-form').addEventListener('submit',async event=>{
  event.preventDefault();if(state.launching||$('launch-run').disabled||!$('run-form').reportValidity())return;
  state.launching=true;$('launch-error').hidden=true;const spec={provider:'openai',model:$('model').value.trim(),prompt:TASK,...LIMITS};state.pendingLaunch={spec,ids:new Set(state.runs.map(run=>run.id))};updateLaunch();
  try{const result=await request('/api/runs',{method:'POST',body:spec});if(!result.run?.id)throw new Error('No work ID returned. Check whether it started.');await acceptStartedWork(result.run);}
  catch(error){if(error.status>=400&&error.status<500)state.pendingLaunch=null;$('launch-error').textContent=error.message;$('launch-error').hidden=false;await loadRuns().catch(()=>{});const recovered=pendingRun();if(recovered)await acceptStartedWork(recovered);}
  finally{state.launching=false;updateLaunch();clearTimeout(state.timer);state.timer=setTimeout(refresh,1500);}
});
$('check-launch').addEventListener('click',async()=>{
  if(state.checkingLaunch)return;state.checkingLaunch=true;updateLaunch();
  try{await loadRuns();const recovered=pendingRun();if(recovered)await acceptStartedWork(recovered);else{$('launch-error').textContent='Not confirmed yet. Check again shortly; the first request may still be processing.';$('launch-error').hidden=false;}}
  catch(error){$('launch-error').textContent=error.message;$('launch-error').hidden=false;}finally{state.checkingLaunch=false;updateLaunch();}
});
function retry(){for(const card of state.cards.values()){const image=card.querySelector('img');if(image.hidden)image.removeAttribute('src');}refresh();}
$('refresh-runs').addEventListener('click',retry);$('retry-load').addEventListener('click',retry);
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(state.timer);else refresh();});
window.addEventListener('pagehide',()=>{clearTimeout(state.timer);$('api-key').value='';});
refresh();
