const $ = id => document.getElementById(id);
const PAGE_SIZE = 24;
const state = {runs:[],archives:[],batches:[],cards:new Map(),query:'',model:'',status:'all',batch:new URLSearchParams(location.search).get('batch') || '',batchLimit:8,visibleLimit:PAGE_SIZE,loaded:false,refreshing:false,timer:null};
const statusNames = {running:'Working',completed:'Completed',archived:'Archived',stopped:'Stopped',failed:'Failed',interrupted:'Interrupted',limit_reached:'Limit reached'};
const isActive = run => run.status === 'running';
const batchLabel = id => `Batch · ${String(id).replace(/^batch-/,'').slice(0,8)}`;
const batchMode = batch => batch.mode==='compare'?'Compare':'Explore';
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
function allWorks(){return [...state.runs,...state.archives].filter(run=>!isActive(run)).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))||a.id.localeCompare(b.id));}
function filteredWorks(){return allWorks().filter(run=>(state.status==='all'||run.status===state.status)&&(!state.model||(run.spec?.model||'__unrecorded__')===state.model)&&(!state.batch||(state.batch==='__individual__'?!run.batch?.id:run.batch?.id===state.batch))&&(!state.query||`${workLabel(run.id)} ${run.id} ${modelName(run)} ${providerName(run)} ${run.batch?.id || ''}`.toLocaleLowerCase().includes(state.query)));}
function createCard(run){
  const card=element('a','work-card');card.href=`/work.html?run=${encodeURIComponent(run.id)}`;card.dataset.workId=run.id;
  const preview=element('div','work-preview');const image=element('img');image.alt='';image.loading='lazy';image.decoding='async';const fallback=element('span','preview-fallback','Preview unavailable');fallback.hidden=true;
  image.addEventListener('error',()=>{image.hidden=true;fallback.hidden=false;});image.addEventListener('load',()=>{image.hidden=false;fallback.hidden=true;});preview.append(image,fallback);
  const heading=element('div','card-heading');heading.append(element('h2'),element('span','work-status'));
  const origin=element('div','card-origin');origin.append(element('span'),element('span','card-batch'),element('time'));
  card.append(preview,heading,element('p','card-model'),origin);return card;
}
function updateCard(card,run){
  const label=workLabel(run.id);const model=modelName(run);const status=statusNames[run.status]||run.status;
  card.setAttribute('aria-label',`${label}, ${model}, ${status}`);card.querySelector('h2').textContent=label;
  const badge=card.querySelector('.work-status');badge.textContent=status;badge.dataset.status=run.status;
  const modelNode=card.querySelector('.card-model');modelNode.textContent=model;modelNode.title=model;
  card.querySelector('.card-origin>span').textContent=providerName(run);const time=card.querySelector('time');time.textContent=dateLabel(run.createdAt);if(run.createdAt)time.dateTime=run.createdAt;
  const batch=card.querySelector('.card-batch');batch.hidden=!run.batch?.id;batch.textContent=run.batch?.id?batchLabel(run.batch.id):'';
  const image=card.querySelector('img');const src=`${workPath(run)}/render.png?revision=${encodeURIComponent(run.revision??run.updatedAt??run.acceptedActions??0)}`;
  if(image.getAttribute('src')!==src)image.src=src;
}
function renderPending(){
  const active=state.runs.filter(run=>isActive(run)&&!state.batches.some(batch=>isActive(batch)&&batch.id===run.batch?.id));$('pending-section').hidden=!active.length;
  const focused=document.activeElement?.dataset?.pendingId;
  const fragment=document.createDocumentFragment();
  for(const run of active){const link=element('a','pending-work');link.href=`/work.html?run=${encodeURIComponent(run.id)}`;link.dataset.pendingId=run.id;const status=element('span','work-status','Working');status.dataset.status='running';link.append(element('span','',workLabel(run.id)),element('strong','',modelName(run)),status,element('span','pending-arrow','↗'));fragment.append(link);}
  $('pending-list').replaceChildren(fragment);
  if(focused)[...$('pending-list').children].find(node=>node.dataset.pendingId===focused)?.focus({preventScroll:true});
}
function batchLink(batch,active=false){
  const link=element('a',active?'active-batch-link':'batch-history-link');link.href=`/batch.html?batch=${encodeURIComponent(batch.id)}`;link.dataset.batchId=batch.id;
  const identity=element('span','batch-list-identity',batchLabel(batch.id));
  const plan=element('span','batch-list-plan',`${batchMode(batch)} · ${batch.groups?.length || 0} ${(batch.groups?.length || 0)===1?'model':'models'}`);
  const progress=element('span','batch-list-progress',`${batch.finishedRuns || 0} of ${batch.totalRuns || 0} finished`);
  const status=element('span','work-status',statusNames[batch.status] || batch.status);status.dataset.status=batch.status;
  if(active)link.append(identity,plan,progress,status,element('span','batch-list-arrow','↗'));
  else {const date=element('time','batch-list-date',dateLabel(batch.createdAt));if(batch.createdAt)date.dateTime=batch.createdAt;link.append(identity,plan,progress,status,date);}
  return link;
}
function renderBatches(){
  const active=state.batches.filter(isActive);$('active-batches').hidden=!active.length;
  $('active-batches-heading').textContent=active.length===1?'Batch in progress':'Batches in progress';
  const focused=document.activeElement?.dataset?.batchId;
  $('active-batch-list').replaceChildren(...active.map(batch=>batchLink(batch,true)));
  const previous=state.batches.filter(batch=>!isActive(batch)).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
  $('batch-history').hidden=!previous.length;$('batch-history-count').textContent=previous.length;
  $('batch-history-list').replaceChildren(...previous.slice(0,state.batchLimit).map(batch=>batchLink(batch)));
  $('show-more-batches').hidden=previous.length<=state.batchLimit;
  if(focused)[...document.querySelectorAll('[data-batch-id]')].find(node=>node.dataset.batchId===focused)?.focus({preventScroll:true});
  const ids=[...new Set([...state.batches.map(batch=>batch.id),...allWorks().map(run=>run.batch?.id).filter(Boolean),...(state.batch&&state.batch!=='__individual__'?[state.batch]:[])])];
  $('batch-filter').hidden=!ids.length;
  const signature=JSON.stringify(ids);if($('batch-filter').dataset.signature===signature)return;
  $('batch-filter').dataset.signature=signature;
  const all=element('option','','All works');all.value='';const individual=element('option','','Individual runs');individual.value='__individual__';
  const options=ids.map(id=>{const option=element('option','',batchLabel(id));option.value=id;return option;});
  $('batch-filter').replaceChildren(all,individual,...options);$('batch-filter').value=state.batch;
}
function renderFilters(){
  const values=[...new Set(allWorks().map(run=>run.spec?.model||'__unrecorded__'))].sort();
  const signature=JSON.stringify(values);if($('model-filter').dataset.signature===signature)return;$('model-filter').dataset.signature=signature;
  const fragment=document.createDocumentFragment();const all=element('option','','All models');all.value='';fragment.append(all);
  for(const value of values){const option=element('option','',value==='__unrecorded__'?'Model not recorded':value);option.value=value;fragment.append(option);}
  $('model-filter').replaceChildren(fragment);if(!values.includes(state.model))state.model='';$('model-filter').value=state.model;
}
function renderLibrary(){
  renderBatches();renderPending();renderFilters();
  const works=allWorks();const results=filteredWorks();const visible=results.slice(0,state.visibleLimit);const focused=document.activeElement?.dataset?.workId;
  const fragment=document.createDocumentFragment();for(const run of visible){const card=state.cards.get(run.id)||createCard(run);state.cards.set(run.id,card);updateCard(card,run);fragment.append(card);}
  for(const id of state.cards.keys())if(!works.some(run=>run.id===id))state.cards.delete(id);
  $('run-list').replaceChildren(fragment);if(focused&&state.cards.get(focused)?.isConnected)state.cards.get(focused).focus({preventScroll:true});
  $('run-count').textContent=works.length;$('empty-library').hidden=!state.loaded||works.length>0;$('no-matches').hidden=!state.loaded||!works.length||results.length>0;
  $('collection-pagination').hidden=!results.length;$('visible-count').textContent=`${visible.length} of ${results.length}`;$('show-more-runs').hidden=visible.length>=results.length;
}
async function refresh(){
  if(state.refreshing)return;state.refreshing=true;$('refresh-runs').disabled=true;
  try{
    const results=await Promise.allSettled([request('/api/runs'),request('/api/archives'),request('/api/batches')]);
    if(results[0].status==='fulfilled')state.runs=results[0].value.runs||[];
    if(results[1].status==='fulfilled')state.archives=results[1].value.runs||[];
    if(results[2].status==='fulfilled')state.batches=results[2].value.batches||[];
    const failures=results.filter(r=>r.status==='rejected');state.loaded=results.slice(0,2).some(r=>r.status==='fulfilled');
    pageError(failures.length?failures[0].reason.message:'');renderLibrary();
  }finally{state.refreshing=false;$('refresh-runs').disabled=false;clearTimeout(state.timer);state.timer=setTimeout(()=>{if(!document.hidden)refresh();},state.runs.some(isActive)||state.batches.some(isActive)?3000:15000);}
}
$('run-search').addEventListener('input',event=>{state.query=event.target.value.trim().toLocaleLowerCase();state.visibleLimit=PAGE_SIZE;renderLibrary();});
$('model-filter').addEventListener('change',event=>{state.model=event.target.value;state.visibleLimit=PAGE_SIZE;renderLibrary();});
$('status-filter').addEventListener('change',event=>{state.status=event.target.value;state.visibleLimit=PAGE_SIZE;renderLibrary();});
$('batch-filter').addEventListener('change',event=>{state.batch=event.target.value;state.visibleLimit=PAGE_SIZE;renderLibrary();});
$('clear-filters').addEventListener('click',()=>{state.query='';state.model='';state.status='all';state.batch='';state.visibleLimit=PAGE_SIZE;$('run-search').value='';$('model-filter').value='';$('status-filter').value='all';$('batch-filter').value='';renderLibrary();$('run-search').focus();});
$('show-more-batches').addEventListener('click',()=>{const previous=state.batchLimit;state.batchLimit+=8;renderBatches();$('batch-history-list').children[previous]?.focus({preventScroll:true});});
$('show-more-runs').addEventListener('click',()=>{const previous=state.visibleLimit;state.visibleLimit+=PAGE_SIZE;renderLibrary();$('run-list').children[previous]?.focus({preventScroll:true});});
function retry(){for(const card of state.cards.values()){const image=card.querySelector('img');if(image.hidden){image.hidden=false;card.querySelector('.preview-fallback').hidden=true;image.removeAttribute('src');}}refresh();}
$('refresh-runs').addEventListener('click',retry);$('retry-load').addEventListener('click',retry);
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(state.timer);else refresh();});
window.addEventListener('pagehide',()=>clearTimeout(state.timer));
refresh();

const started=new URLSearchParams(location.search).get('started');
if(started){$('launch-confirmation').textContent='Run started. Return to the library for the finished work and playback.';history.replaceState(null,'','/');}
