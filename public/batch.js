const $ = id => document.getElementById(id);
const batchId = new URLSearchParams(location.search).get('batch');
const state = {batch:null,groups:new Map(),entries:new Map(),refreshing:false,stopping:false,stopRequested:false,timer:null};
const statusNames = {running:'Working',completed:'Completed',failed:'Failed',stopped:'Stopped',interrupted:'Interrupted',limit_reached:'Limit reached',queued:'Queued',not_run:'Not run'};
const materialNames = {same:'Same materials',random:'Random materials','pinned-random':'Pins + random extras'};
const terminal = status => ['completed','failed','stopped','interrupted','limit_reached'].includes(status);
const shortId = id => String(id).replace(/^batch-/,'').slice(0,8);
const workLabel = id => `Work · ${String(id).replace(/^run-/,'').slice(0,8)}`;
const batchPath = `/api/batches/${encodeURIComponent(batchId || '')}`;
const element = (tag,className,text) => {const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node;};
function reconcile(parent,nodes) {
  for (let index=0;index<nodes.length;index++) if (parent.children[index]!==nodes[index]) parent.insertBefore(nodes[index],parent.children[index] || null);
  while (parent.children.length>nodes.length) parent.lastElementChild.remove();
}
async function request(path,{method='GET',body,timeout=30000}={}) {
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeout);
  try {
    const response=await fetch(path,{method,signal:controller.signal,cache:'no-store',...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    let result;try{result=await response.json();}catch{throw new Error('The server returned an unreadable response.');}
    if(!response.ok)throw new Error(result.error || `Request failed (${response.status}).`);
    return result;
  } catch(error) {
    if(error.name==='AbortError')throw new Error('The server took too long to respond. Refresh to check the batch.');
    if(error instanceof TypeError)throw new Error('The local server is unavailable.');
    throw error;
  } finally {clearTimeout(timer);}
}
function pageError(message='') {$('batch-error-message').textContent=message;$('batch-error').hidden=!message;}
function updateControls() {
  $('stop-batch').hidden=state.batch?.status!=='running';
  $('stop-batch').disabled=state.refreshing || state.stopping || state.stopRequested;
  $('stop-batch').textContent=state.stopping || state.stopRequested?'Stopping…':'Stop batch';
  $('stop-batch').setAttribute('aria-busy',String(state.stopping || state.stopRequested));
  $('refresh-batch').disabled=state.refreshing || state.stopping;
  $('retry-batch').disabled=state.refreshing || state.stopping;
}
function reasonLabel(reason) {
  const labels={turn_limit:'Turn limit reached',action_limit:'Action limit reached',context_limit:'Context limit reached',time_limit:'Time limit reached',user_stopped:'Stopped by request',server_restarted:'Interrupted when the server restarted',server_closed:'Interrupted when the server closed',provider_or_runner_error:'The run could not continue'};
  return labels[reason] || '';
}
function sourceLink(id) {
  const source=state.batch.sourceManifest?.find(item=>item.id===id);
  const link=element('a','batch-source');link.href=`${batchPath}/sources/${encodeURIComponent(id)}`;link.target='_blank';link.rel='noopener noreferrer';
  const name=source?.name || id;link.setAttribute('aria-label',`Open original ${name} in a new tab`);link.title=[name,source?.credit,source?.license].filter(Boolean).join(' · ');
  const frame=element('span','batch-source-frame');const image=element('img');image.src=link.href;image.alt='';image.loading='lazy';image.decoding='async';
  const fallback=element('span','source-fallback','Image unavailable');fallback.hidden=true;
  image.addEventListener('error',()=>{image.hidden=true;fallback.hidden=false;});image.addEventListener('load',()=>{image.hidden=false;fallback.hidden=true;});frame.append(image,fallback);
  link.append(frame,element('span','batch-source-name',name));return link;
}
function showMaterials(card,entry) {
  const tray=card.querySelector('.entry-source-grid');const ids=entry.sourceIds || [];
  const signature=JSON.stringify(ids);if(tray.dataset.signature===signature)return;
  tray.dataset.signature=signature;tray.replaceChildren(...ids.map(sourceLink));
}
function createEntry(entry) {
  const card=element('article','batch-entry');card.dataset.entryIndex=entry.index;
  const heading=element('div','entry-heading');heading.append(element('h3'),element('span','entry-status'));
  const result=element('a','entry-art');const preview=element('div','entry-preview');const image=element('img');image.alt='';image.loading='lazy';image.decoding='async';
  const fallback=element('span','entry-fallback','Preview unavailable');fallback.hidden=true;preview.append(image,fallback);
  image.addEventListener('error',()=>{image.hidden=true;fallback.hidden=false;});image.addEventListener('load',()=>{image.hidden=false;fallback.hidden=true;});
  const caption=element('div','entry-art-caption');caption.append(element('span'),element('span','','View work ↗'));result.append(preview,caption);
  const waiting=element('div','entry-waiting');const mark=element('span','entry-waiting-mark');mark.setAttribute('aria-hidden','true');for(let index=0;index<4;index++)mark.append(element('i'));
  waiting.append(mark,element('p'),element('a','entry-working-link','View work ↗'));
  const reason=element('p','entry-reason');
  const materials=element('details','entry-materials');const summary=element('summary');materials.append(summary,element('div','entry-source-grid'));
  materials.addEventListener('toggle',()=>{if(materials.open){const current=state.batch?.entries?.find(item=>item.index===entry.index);if(current)showMaterials(card,current);}});
  card.append(heading,result,waiting,reason,materials);return card;
}
function updateEntry(card,entry) {
  card.dataset.status=entry.status;
  card.querySelector('h3').textContent=`Run ${entry.runIndex+1}`;
  const status=card.querySelector('.entry-status');status.textContent=statusNames[entry.status] || entry.status;status.dataset.status=entry.status;
  const finished=terminal(entry.status) && !!entry.runId;
  const result=card.querySelector('.entry-art');result.hidden=!finished;
  const waiting=card.querySelector('.entry-waiting');waiting.hidden=finished;
  if(finished) {
    result.href=`/work.html?run=${encodeURIComponent(entry.runId)}`;result.setAttribute('aria-label',`Open ${workLabel(entry.runId)}, ${entry.model}, run ${entry.runIndex+1}`);
    result.querySelector('.entry-art-caption>span').textContent=workLabel(entry.runId);
    const image=result.querySelector('img');const src=`/api/runs/${encodeURIComponent(entry.runId)}/render.png`;
    if(image.getAttribute('src')!==src)image.src=src;
  } else {
    waiting.querySelector('p').textContent=entry.status==='running'?'At work':entry.status==='queued'?'Waiting its turn':entry.status==='not_run'?'Not run':'No work was saved';
    const link=waiting.querySelector('a');link.hidden=!entry.runId;if(entry.runId)link.href=`/work.html?run=${encodeURIComponent(entry.runId)}`;
  }
  const reason=card.querySelector('.entry-reason');reason.textContent=reasonLabel(entry.terminationReason);reason.hidden=!reason.textContent;
  card.querySelector('.entry-materials>summary').textContent=`Materials · ${entry.sourceIds?.length || 0}`;
  if(card.querySelector('.entry-materials').open)showMaterials(card,entry);
}
function createGroup(index) {
  const group=element('section','batch-group');group.dataset.groupIndex=index;group.setAttribute('aria-labelledby',`group-${index}-model`);
  const heading=element('header','batch-group-heading');const model=element('h2');model.id=`group-${index}-model`;heading.append(model,element('p'));
  group.append(heading,element('div','batch-entries'));return group;
}
function render() {
  const batch=state.batch;if(!batch)return;
  const identity=`Batch · ${shortId(batch.id)}`;$('batch-identity').textContent=identity;document.title=`${identity} — Offcut`;
  const date=new Date(batch.createdAt);$('batch-date').textContent=Number.isNaN(date.getTime())?'':date.toLocaleDateString(undefined,{month:'long',day:'numeric',year:'numeric'});
  $('batch-status').hidden=false;$('batch-status').textContent=statusNames[batch.status] || batch.status;$('batch-status').dataset.status=batch.status;
  $('batch-mode').textContent=batch.mode==='compare'?'Compare':'Explore';$('batch-materials').textContent=materialNames[batch.materials] || batch.materials;
  $('batch-pairing').hidden=batch.mode!=='compare' || batch.materials==='same';
  const entries=batch.entries || [];const finished=batch.finishedRuns ?? entries.filter(entry=>terminal(entry.status)).length;
  $('batch-progress-text').textContent=`${finished} of ${batch.totalRuns} finished`;
  const unstarted=entries.filter(entry=>entry.status==='not_run').length;
  $('batch-remaining').textContent=unstarted?`${unstarted} not run`:batch.status==='running'?`${entries.filter(entry=>entry.status==='queued').length} queued`:'';
  $('batch-progress').max=Math.max(1,batch.totalRuns || 0);$('batch-progress').value=finished;
  $('batch-progress').setAttribute('aria-valuetext',`${finished} of ${batch.totalRuns} runs finished${unstarted?`, ${unstarted} not run`:''}`);
  const notices={failed:batch.terminationReason==='child_failed'?'The batch ended after a run failed. The remaining runs were not started.':'The batch could not continue. Finished work and the remaining plan are saved.',stopped:'The batch was stopped. Finished work and the original plan are saved.',interrupted:'The batch was interrupted. Finished work is saved; unstarted runs stay in the plan.'};
  $('batch-notice').textContent=notices[batch.status] || '';$('batch-notice').hidden=!$('batch-notice').textContent;
  const groups=(batch.groups || []).map((spec,index)=> {
    const group=state.groups.get(index) || createGroup(index);state.groups.set(index,group);
    group.querySelector('h2').textContent=spec.model;
    const planned=entries.filter(entry=>entry.groupIndex===index).sort((a,b)=>a.runIndex-b.runIndex);
    group.querySelector('.batch-group-heading p').textContent=`${planned.filter(entry=>terminal(entry.status)).length} / ${spec.count} finished`;
    const cards=planned.map(entry=>{const card=state.entries.get(entry.index) || createEntry(entry);state.entries.set(entry.index,card);updateEntry(card,entry);return card;});
    reconcile(group.querySelector('.batch-entries'),cards);return group;
  });
  $('batch-groups').dataset.mode=batch.mode;$('batch-groups').dataset.groupCount=groups.length;
  $('batch-groups').style.setProperty('--batch-row-count',String(Math.max(1,...(batch.groups || []).map(group=>group.count))+1));
  reconcile($('batch-groups'),groups);
  $('batch-library').href=`/?batch=${encodeURIComponent(batch.id)}`;
  $('batch-loading').hidden=true;$('batch-content').hidden=false;updateControls();
}
function schedule() {clearTimeout(state.timer);if(state.batch?.status==='running' && !document.hidden)state.timer=setTimeout(refresh,3000);}
async function refresh() {
  if(state.refreshing || state.stopping)return;state.refreshing=true;updateControls();
  try {
    const result=await request(batchPath);if(!result.batch?.id)throw new Error('This batch could not be opened.');
    state.batch=result.batch;pageError();render();
  } catch(error) {pageError(error.message);$('batch-loading').hidden=true;}
  finally {state.refreshing=false;updateControls();schedule();}
}
$('stop-batch').addEventListener('click',async()=> {
  if(state.refreshing || state.stopping || state.stopRequested || state.batch?.status!=='running')return;
  state.stopping=true;clearTimeout(state.timer);pageError();updateControls();
  try {
    const result=await request(`${batchPath}/stop`,{method:'POST',body:{}});if(!result.batch?.id)throw new Error('The server did not confirm the stop. Refresh to check the batch.');
    state.stopRequested=result.batch.status==='running';state.batch={...state.batch,...result.batch};render();
  } catch(error) {pageError(error.message);}
  finally {state.stopping=false;updateControls();schedule();}
});
function retry() {
  for(const image of document.querySelectorAll('.entry-preview img,.entry-source-grid img')) {
    const src=image.getAttribute('src');if(!image.hidden || !src)continue;
    image.hidden=false;if(image.nextElementSibling)image.nextElementSibling.hidden=true;
    image.removeAttribute('src');image.src=src;
  }
  refresh();
}
$('retry-batch').addEventListener('click',retry);$('refresh-batch').addEventListener('click',retry);
document.addEventListener('visibilitychange',()=>{clearTimeout(state.timer);if(!document.hidden && batchId && /^[a-zA-Z0-9_-]{1,128}$/.test(batchId))refresh();});
window.addEventListener('pagehide',()=>clearTimeout(state.timer));
if(!batchId || !/^[a-zA-Z0-9_-]{1,128}$/.test(batchId)) {$('batch-loading').hidden=true;$('retry-batch').hidden=true;pageError('Choose a batch from the library to see its runs.');}
else refresh();
