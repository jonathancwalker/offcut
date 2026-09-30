const $ = id => document.getElementById(id);
const PAGE_SIZE = 24;
const state = {runs:[],archives:[],cards:new Map(),query:'',model:'',status:'all',visibleLimit:PAGE_SIZE,loaded:false,refreshing:false,timer:null};
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
  $('collection-pagination').hidden=!results.length;$('visible-count').textContent=`${visible.length} of ${results.length}`;$('show-more-runs').hidden=visible.length>=results.length;
}
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
$('run-search').addEventListener('input',event=>{state.query=event.target.value.trim().toLocaleLowerCase();state.visibleLimit=PAGE_SIZE;renderLibrary();});
$('model-filter').addEventListener('change',event=>{state.model=event.target.value;state.visibleLimit=PAGE_SIZE;renderLibrary();});
$('status-filter').addEventListener('change',event=>{state.status=event.target.value;state.visibleLimit=PAGE_SIZE;renderLibrary();});
$('clear-filters').addEventListener('click',()=>{state.query='';state.model='';state.status='all';state.visibleLimit=PAGE_SIZE;$('run-search').value='';$('model-filter').value='';$('status-filter').value='all';renderLibrary();$('run-search').focus();});
$('show-more-runs').addEventListener('click',()=>{const previous=state.visibleLimit;state.visibleLimit+=PAGE_SIZE;renderLibrary();$('run-list').children[previous]?.focus({preventScroll:true});});
function retry(){for(const card of state.cards.values()){const image=card.querySelector('img');if(image.hidden)image.removeAttribute('src');}refresh();}
$('refresh-runs').addEventListener('click',retry);$('retry-load').addEventListener('click',retry);
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(state.timer);else refresh();});
window.addEventListener('pagehide',()=>clearTimeout(state.timer));
refresh();

const started=new URLSearchParams(location.search).get('started');
if(started){$('launch-confirmation').textContent='Run started. Return to the library for the finished work and playback.';history.replaceState(null,'','/');}
