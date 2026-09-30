const $ = id => document.getElementById(id);
const PAGE_SIZE = 24;
const state = {
  provider:null, sources:[], runs:[], selectedId:new URL(location.href).searchParams.get('run'), selected:null,
  events:[], selectedRevision:null, timelineStep:null, playing:false, timer:null, playTimer:null,
  refreshing:false, launching:false, credentialBusy:false, stoppingId:null, selectionVersion:0,
  initialized:false, canvasURL:'', query:'', status:'all', visibleLimit:PAGE_SIZE, loadedRuns:false,
  cards:new Map(), setupReturn:null, restoreSetupFocus:true, focusSelected:false, collectionScroll:0,
  pendingLaunch:null, checkingLaunch:false,
};
const statusNames = {running:'Running',completed:'Completed',stopped:'Stopped',failed:'Failed',interrupted:'Interrupted',limit_reached:'Limit reached'};
const terminationMessages = {
  time_limit:'Time limit reached.', action_limit:'Action limit reached.', turn_limit:'Turn limit reached.',
  context_limit:'Conversation size limit reached.', model_finished:'The model finished its composition.',
  user_stopped:'Run stopped.', server_restarted:'The server restarted before this run finished.',
  server_closed:'The server closed before this run finished.', provider_or_runner_error:'The run ended after an error. Details are in the activity record.',
  persistence_error:'The run stopped because its record could not be saved.',
};
const number = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—';
const date = value => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
};
const runPath = id => `/api/runs/${encodeURIComponent(id)}`;
const isActive = run => run?.status === 'running';
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
async function request(path,{method='GET',body,timeout=30000}={}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(),timeout);
  try {
    const response = await fetch(path,{method,signal:controller.signal,cache:'no-store',...(body === undefined ? {} : {headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    let result;
    try { result = await response.json(); }
    catch { throw new Error('The studio returned an unreadable response. Try refreshing.'); }
    if (!response.ok) {
      const error = new Error(result.error || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Request timed out. Check the collection before trying again.');
    if (error instanceof TypeError) throw new Error('The local studio is unavailable. Check the server and try again.');
    throw error;
  } finally { clearTimeout(timer); }
}
function pageError(message) {
  $('page-error-message').textContent = message || '';
  $('page-error').hidden = !message;
}
function connectionMessage(message,error=false) {
  $('connection-message').textContent = message;
  $('connection-message').classList.toggle('error',error);
}
function updateLaunch() {
  const active = state.runs.find(isActive);
  $('launch-run').disabled = state.launching || Boolean(state.pendingLaunch) || !state.provider?.configured || !state.sources.length || Boolean(active) || !$('model').value.trim();
  $('launch-run').setAttribute('aria-busy',String(state.launching));
  $('launch-run').textContent = state.launching ? 'Starting…' : 'Start experiment';
  $('close-setup').disabled = state.launching;
  $('launch-help').textContent = state.launching ? 'Saving materials…'
    : state.pendingLaunch ? 'Check whether the previous attempt started.'
    : active ? 'Another experiment is running.'
    : !state.provider?.configured ? 'Connect an API key to start.'
    : !state.sources.length ? 'Add materials in the studio.'
    : !$('model').value.trim() ? 'Enter a model ID.' : '';
  $('check-launch').hidden = !state.pendingLaunch;
  $('check-launch').disabled = state.checkingLaunch;
  $('check-launch').textContent = state.checkingLaunch ? 'Checking…' : 'Check for a started run';
}
function renderProvider() {
  const configured = Boolean(state.provider?.configured);
  $('provider-status').textContent = configured ? 'Key ready' : 'Not connected';
  $('provider-status').classList.toggle('connected',configured);
  $('test-connection').disabled = !configured || state.credentialBusy;
  $('forget-key').hidden = state.provider?.keySource !== 'session';
  $('forget-key').disabled = state.credentialBusy;
  $('save-key').disabled = state.credentialBusy;
  $('api-key').disabled = state.credentialBusy;
  $('key-help').textContent = state.provider?.keySource === 'environment'
    ? 'Using the server key. A key entered here overrides it for this session.'
    : 'Kept in server memory for this session. Never saved to browser storage or exports.';
  updateLaunch();
}
async function loadProvider({initial=false}={}) {
  const result = await request('/api/providers');
  state.provider = result.providers?.find(provider => provider.id === 'openai') || null;
  if (initial) $('connection-settings').open = !state.provider?.configured;
  if (initial && result.defaultModel && !$('model').value) $('model').value = result.defaultModel;
  renderProvider();
}
async function loadSources() {
  const result = await request('/api/state');
  state.sources = result.state?.sources || [];
  const fragment = document.createDocumentFragment();
  for (const source of state.sources) {
    const figure = element('figure','experiment-source');
    const image = element('img');
    image.alt = source.name || source.id;
    image.src = `/api/sources/${encodeURIComponent(source.id)}`;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error',() => image.replaceWith(element('span','experiment-source-error','Preview unavailable')),{once:true});
    const caption = element('figcaption','',source.name || source.id);
    caption.title = source.name || source.id;
    figure.append(image,caption);
    fragment.append(figure);
  }
  if (!state.sources.length) fragment.append(element('p','field-help','No materials. Add images in the studio.'));
  $('experiment-sources').replaceChildren(fragment);
  $('materials-count').textContent = number(state.sources.length);
  $('materials-summary').textContent = state.sources.length ? 'Saved with a new, blank canvas.' : '';
  updateLaunch();
}
function createRunCard(run) {
  const card = element('button','run-card');
  card.type = 'button';
  card.dataset.runId = run.id;
  const preview = element('span','run-card-image');
  const image = element('img');
  image.loading = 'lazy';
  image.decoding = 'async';
  const unavailable = element('span','thumbnail-unavailable','Preview unavailable');
  unavailable.hidden = true;
  image.addEventListener('error',() => { image.hidden = true; unavailable.hidden = false; });
  image.addEventListener('load',() => { image.hidden = false; unavailable.hidden = true; });
  preview.append(image,unavailable);
  const label = element('span','run-card-label');
  label.append(element('strong'),element('span','run-status'));
  card.append(preview,label,element('small'));
  card.addEventListener('click',() => selectRun(run.id).catch(error => pageError(error.message)));
  return card;
}
function updateRunCard(card,run) {
  const title = run.title || 'Untitled experiment';
  const model = run.spec?.model || 'Model unavailable';
  const status = statusNames[run.status] || run.status || 'Unknown';
  card.setAttribute('aria-label',`${title}, ${model}, ${status}`);
  const strong = card.querySelector('strong');
  strong.textContent = title;
  strong.title = title;
  const badge = card.querySelector('.run-status');
  badge.textContent = status;
  badge.dataset.status = run.status;
  card.querySelector('small').textContent = model;
  card.querySelector('small').title = model;
  const image = card.querySelector('img');
  const src = `${runPath(run.id)}/render.png?revision=${encodeURIComponent(run.revision ?? run.updatedAt ?? run.acceptedActions ?? 0)}`;
  image.alt = '';
  if (image.getAttribute('src') !== src) image.src = src;
}
function filteredRuns() {
  const query = state.query.toLocaleLowerCase();
  return state.runs.filter(run => (state.status === 'all' || run.status === state.status) && (!query || `${run.title || 'Untitled experiment'} ${run.spec?.model || ''}`.toLocaleLowerCase().includes(query)));
}
function renderRunList() {
  $('run-count').textContent = number(state.runs.length);
  const results = filteredRuns();
  const visible = results.slice(0,state.visibleLimit);
  const focused = document.activeElement?.dataset?.runId;
  const fragment = document.createDocumentFragment();
  for (const run of visible) {
    const card = state.cards.get(run.id) || createRunCard(run);
    state.cards.set(run.id,card);
    updateRunCard(card,run);
    fragment.append(card);
  }
  for (const id of state.cards.keys()) if (!state.runs.some(run => run.id === id)) state.cards.delete(id);
  $('run-list').replaceChildren(fragment);
  if (focused) state.cards.get(focused)?.focus({preventScroll:true});
  $('empty-experiments').hidden = !state.loadedRuns || state.runs.length > 0;
  $('no-matches').hidden = !state.loadedRuns || state.runs.length === 0 || results.length > 0;
  $('collection-pagination').hidden = !results.length;
  $('visible-count').textContent = `${number(visible.length)} of ${number(results.length)}`;
  $('show-more-runs').hidden = visible.length >= results.length;
}
async function loadRuns() {
  const result = await request('/api/runs');
  state.runs = [...(result.runs || [])].sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.id).localeCompare(String(b.id)));
  state.loadedRuns = true;
  renderRunList();
  updateLaunch();
  if (state.selectedId) await loadSelected();
}
function stopPlayback() {
  clearTimeout(state.playTimer);
  state.playing = false;
  $('play-run').textContent = 'Play';
}
function setView() {
  $('collection-view').hidden = Boolean(state.selectedId);
  $('selected-run').hidden = !state.selectedId;
}
async function selectRun(id,{historyMode='push',focus=true}={}) {
  if (id === state.selectedId && state.selected) return;
  if (!state.selectedId) state.collectionScroll = window.scrollY;
  state.selectionVersion += 1;
  stopPlayback();
  state.selectedId = id;
  state.selected = null;
  state.events = [];
  state.selectedRevision = null;
  state.timelineStep = null;
  state.canvasURL = '';
  state.focusSelected = focus;
  $('run-detail').hidden = true;
  $('run-loading').hidden = false;
  $('run-loading').textContent = 'Loading experiment…';
  if (historyMode !== 'none') {
    const url = new URL(location.href);
    url.searchParams.set('run',id);
    history[historyMode === 'replace' ? 'replaceState' : 'pushState'](null,'',url);
  }
  pageError('');
  setView();
  window.scrollTo({top:0,behavior:'auto'});
  try { await loadSelected(); }
  catch (error) { $('run-loading').textContent = 'Experiment unavailable.'; throw error; }
}
function showCollection({historyMode='push',focus=true}={}) {
  const previousId = state.selectedId;
  state.selectionVersion += 1;
  stopPlayback();
  state.selectedId = null;
  state.selected = null;
  state.selectedRevision = null;
  if (historyMode !== 'none') {
    const url = new URL(location.href);
    url.searchParams.delete('run');
    history.pushState(null,'',url);
  }
  pageError('');
  setView();
  renderRunList();
  window.scrollTo({top:state.collectionScroll,behavior:'auto'});
  if (focus) {
    const card = state.cards.get(previousId);
    if (card?.isConnected) card.focus({preventScroll:true});
    else $('run-search').focus({preventScroll:true});
  }
}
async function loadSelected() {
  const id = state.selectedId;
  if (!id) return;
  const version = state.selectionVersion;
  const result = await request(runPath(id));
  if (state.selectedId !== id || version !== state.selectionVersion) return;
  const run = result.run;
  if (!run) throw new Error('The saved experiment could not be read.');
  const revision = JSON.stringify([run.revision,run.updatedAt,run.status,run.turns,run.acceptedActions]);
  const changed = state.selectedRevision !== revision;
  state.selected = run;
  if (changed) {
    const eventResult = await request(`${runPath(id)}/events`);
    if (state.selectedId !== id || version !== state.selectionVersion) return;
    state.events = eventResult.events || [];
    state.selectedRevision = revision;
    renderActivity();
  }
  renderSelected();
}
function renderSelected() {
  const run = state.selected;
  if (!run) return;
  setView();
  $('run-loading').hidden = true;
  $('run-detail').hidden = false;
  $('selected-model').textContent = run.spec?.model || 'Model unavailable';
  $('selected-title').textContent = run.title || 'Untitled experiment';
  $('selected-status').textContent = statusNames[run.status] || run.status;
  $('selected-status').dataset.status = run.status;
  $('selected-date').textContent = date(run.createdAt);
  $('stop-run').hidden = !isActive(run);
  $('stop-run').disabled = state.stoppingId === run.id;
  $('stop-run').textContent = state.stoppingId === run.id ? 'Stopping…' : 'Stop run';
  $('stat-turns').textContent = `${number(run.turns ?? 0)} / ${number(run.spec?.maxTurns)}`;
  $('stat-actions').textContent = `${number(run.acceptedActions ?? 0)} / ${number(run.spec?.maxActions)}`;
  $('stat-tokens').textContent = number(run.usage?.totalTokens ?? ((run.usage?.inputTokens || 0) + (run.usage?.outputTokens || 0)));
  $('stat-cost').textContent = run.costUSD === null || run.costUSD === undefined ? 'Not available' : `$${Number(run.costUSD).toFixed(4)}`;
  const notices = [];
  if (run.terminationReason && !isActive(run) && run.terminationReason !== 'model_finished') notices.push(terminationMessages[run.terminationReason] || String(run.terminationReason).replaceAll('_',' '));
  if (run.usageIncomplete || run.usage?.incomplete) notices.push('Usage may be incomplete; some billed requests may not have returned usage.');
  $('run-notice').textContent = notices.join(' ');
  $('run-notice').hidden = !notices.length;
  $('run-spec-text').textContent = JSON.stringify({spec:run.spec,sources:run.sourceManifest,terminationReason:run.terminationReason,rejectedBatches:run.rejectedBatches},null,2);
  $('download-artwork').href = `${runPath(run.id)}/render.png`;
  $('download-project').href = `${runPath(run.id)}/project`;
  $('download-bundle').href = `${runPath(run.id)}/export`;
  renderTimeline();
  if (state.focusSelected) {
    state.focusSelected = false;
    $('selected-title').focus({preventScroll:true});
  }
}
function renderTimeline() {
  const run = state.selected;
  if (!run) return;
  const count = run.acceptedActions || 0;
  if (state.timelineStep !== null) state.timelineStep = Math.min(state.timelineStep,count);
  const step = state.timelineStep ?? count;
  $('run-timeline').max = count;
  $('run-timeline').value = step;
  $('run-timeline').disabled = count === 0;
  $('play-run').disabled = count === 0;
  $('replay-count').textContent = `${number(count)} actions`;
  $('replay-caption').textContent = step === 0 ? 'Blank canvas' : `Action ${number(step)} of ${number(count)}`;
  $('show-latest').hidden = state.timelineStep === null;
  $('run-canvas').alt = `${run.title || 'Untitled experiment'}, ${step === 0 ? 'blank canvas' : `after ${step} accepted actions`}`;
  const url = `${runPath(run.id)}/render.png?step=${step}&revision=${encodeURIComponent(run.revision ?? run.updatedAt ?? count)}`;
  if (url !== state.canvasURL) {
    state.canvasURL = url;
    $('canvas-error').hidden = true;
    $('run-canvas').src = url;
  }
}
function eventTitle(event) {
  const kind = String(event.type || event.kind || 'event');
  const names = {
    run_started:'Started',run_created:'Created',observation:'Canvas observed',model_request:'Model requested',
    model_response:'Model response',model_turn:'Model turn',actions_accepted:'Actions accepted',action_accepted:'Action accepted',
    actions_rejected:'Actions rejected',action_rejected:'Action rejected',run_completed:'Completed',run_stopped:'Stopped',
    run_failed:'Failed',run_finished:'Ended',stop_requested:'Stop requested',error:'Error',decision:'Decision',request:'Model requested',
    model_output:'Model response',batch_result:event.accepted ? `${number(event.actions?.length || 0)} action${event.actions?.length === 1 ? '' : 's'}` : 'Actions rejected',termination:'Ended',
  };
  const label = names[kind] || kind.replaceAll('_',' ').replace(/^./,letter => letter.toUpperCase());
  return event.turn === undefined ? label : `Turn ${event.turn} · ${label}`;
}
function eventNote(event) {
  if (event.type === 'termination' && terminationMessages[event.reason]) return terminationMessages[event.reason];
  const candidates = [event.decision_note,event.decisionNote,event.note,event.message,event.error?.message,event.error,event.reason,event.output?.decision_note,event.response?.decision_note,event.data?.decision_note];
  const note = candidates.find(value => typeof value === 'string' && value.trim());
  return note ? note.slice(0,2000) : '';
}
function renderActivity() {
  const container = $('activity-list');
  const oldScroll = container.scrollTop;
  const atEnd = oldScroll + container.clientHeight >= container.scrollHeight - 35;
  const fragment = document.createDocumentFragment();
  const technical = document.createDocumentFragment();
  const openEvents = new Set([...$('raw-event-list').querySelectorAll('details[open]')].map(node => node.dataset.eventKey));
  let actionCount = 0;
  const visibleEvents = state.events.filter(event => !['observation','request','model_request','model_output','model_response'].includes(event.type || event.kind));
  for (const event of visibleEvents) {
    const item = element('div','activity-event');
    item.append(element('h3','',eventTitle(event)));
    const note = eventNote(event);
    if (note) item.append(element('p','',note));
    const kind = event.type || event.kind || '';
    const accepted = event.type === 'batch_result' ? event.accepted === true : /accept|applied/.test(kind) && !/reject/.test(kind);
    if (accepted) {
      const actions = event.actions || event.data?.actions || (event.action ? [event.action] : []);
      actionCount += actions.length || event.count || 0;
      const step = event.acceptedActions ?? event.actionCount ?? event.step ?? actionCount;
      if (Number.isInteger(step) && step >= 0) {
        const button = element('button','text-button',`View action ${step}`);
        button.type = 'button';
        button.addEventListener('click',() => { stopPlayback(); state.timelineStep = step; renderTimeline(); });
        item.append(button);
      }
    }
    const timestamp = event.timestamp || event.at || event.createdAt;
    if (timestamp) item.append(element('p','activity-time',date(timestamp)));
    fragment.append(item);
  }
  for (const [index,event] of state.events.entries()) {
    const details = element('details','technical-event');
    details.dataset.eventKey = String(event.sequence ?? index);
    details.append(element('summary','',eventTitle(event)));
    const populate = () => { if (details.open && !details.querySelector('pre')) details.append(element('pre','',JSON.stringify(event,null,2).slice(0,30000))); };
    details.addEventListener('toggle',populate);
    if (openEvents.has(details.dataset.eventKey)) { details.open = true; populate(); }
    technical.append(details);
  }
  if (!visibleEvents.length) fragment.append(element('p','field-help',isActive(state.selected) ? 'Waiting for the first turn…' : 'No activity recorded.'));
  container.replaceChildren(fragment);
  $('raw-event-list').replaceChildren(technical);
  $('activity-count').textContent = state.selected?.turns ? `${number(state.selected.turns)} turns` : '';
  $('raw-event-count').textContent = number(state.events.length);
  container.scrollTop = atEnd ? container.scrollHeight : oldScroll;
}
function openSetup(opener) {
  state.setupReturn = opener;
  state.restoreSetupFocus = true;
  if (!$('setup-dialog').open) $('setup-dialog').showModal();
  $('setup-title').focus({preventScroll:true});
  refresh({all:true});
}
function closeSetup({restoreFocus=true}={}) {
  state.restoreSetupFocus = restoreFocus;
  $('setup-dialog').close();
}
function pendingRun() {
  const pending = state.pendingLaunch;
  if (!pending) return null;
  return state.runs.find(run => !pending.ids.has(run.id) && Object.entries(pending.spec).every(([key,value]) => run.spec?.[key] === value));
}
async function acceptStartedRun(id) {
  state.pendingLaunch = null;
  $('launch-error').hidden = true;
  closeSetup({restoreFocus:false});
  try { await selectRun(id); }
  catch (error) { pageError(error.message); }
}
async function refresh({all=false}={}) {
  if (state.refreshing) return;
  state.refreshing = true;
  $('refresh-runs').disabled = true;
  try {
    const operations = [loadRuns()];
    if (all || !state.initialized) operations.push(loadProvider({initial:!state.initialized}),loadSources());
    const results = await Promise.allSettled(operations);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) {
      pageError(failures[0].reason.message);
      if (state.selectedId && $('run-detail').hidden) $('run-loading').textContent = 'Experiment unavailable.';
    }
    else { pageError(''); state.initialized = true; }
  } finally {
    state.refreshing = false;
    $('refresh-runs').disabled = false;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { if (!document.hidden) refresh(); },state.runs.some(isActive) ? 2500 : 8000);
  }
}
for (const button of document.querySelectorAll('[data-open-setup]')) button.addEventListener('click',() => openSetup(button));
$('close-setup').addEventListener('click',() => { if (!state.launching) closeSetup(); });
$('setup-dialog').addEventListener('cancel',event => { if (state.launching) event.preventDefault(); });
$('setup-dialog').addEventListener('close',() => {
  $('api-key').value = '';
  if (state.restoreSetupFocus && state.setupReturn?.isConnected) state.setupReturn.focus({preventScroll:true});
});
$('back-to-collection').addEventListener('click',() => showCollection());
$('run-search').addEventListener('input',event => { state.query = event.target.value.trim(); state.visibleLimit = PAGE_SIZE; renderRunList(); });
$('status-filter').addEventListener('change',event => { state.status = event.target.value; state.visibleLimit = PAGE_SIZE; renderRunList(); });
$('clear-filters').addEventListener('click',() => {
  state.query = ''; state.status = 'all'; state.visibleLimit = PAGE_SIZE;
  $('run-search').value = ''; $('status-filter').value = 'all'; renderRunList(); $('run-search').focus();
});
$('show-more-runs').addEventListener('click',() => {
  const previous = state.visibleLimit;
  state.visibleLimit += PAGE_SIZE;
  renderRunList();
  const firstNew = $('run-list').children[previous];
  if (firstNew) firstNew.focus({preventScroll:true});
});
$('key-form').addEventListener('submit',async event => {
  event.preventDefault();
  let apiKey = $('api-key').value.trim();
  if (!apiKey || state.credentialBusy) return;
  state.credentialBusy = true;
  $('api-key').value = '';
  renderProvider();
  connectionMessage('Connecting…');
  try {
    await request('/api/providers/openai',{method:'POST',body:{apiKey}});
    apiKey = '';
    await loadProvider();
    connectionMessage('Key saved for this session. Test connection to verify access.');
  } catch { connectionMessage('Could not connect. Check the server and API key.',true); }
  finally { apiKey = ''; state.credentialBusy = false; renderProvider(); }
});
$('test-connection').addEventListener('click',async () => {
  if (state.credentialBusy) return;
  state.credentialBusy = true;
  renderProvider();
  connectionMessage('Checking access…');
  try {
    const result = await request('/api/providers/openai/test',{method:'POST',body:{},timeout:65000});
    const fragment = document.createDocumentFragment();
    for (const model of result.models || []) {
      const option = element('option'); option.value = typeof model === 'string' ? model : model.id;
      if (option.value) fragment.append(option);
    }
    $('available-models').replaceChildren(fragment);
    connectionMessage(`Connected. ${number(result.models?.length || 0)} models listed. No inference requested.`);
  } catch { connectionMessage('Connection test failed. Check your key, account access and network.',true); }
  finally { state.credentialBusy = false; renderProvider(); }
});
$('forget-key').addEventListener('click',async () => {
  if (state.credentialBusy) return;
  state.credentialBusy = true; renderProvider();
  try {
    await request('/api/providers/openai',{method:'DELETE'});
    await loadProvider();
    $('available-models').replaceChildren();
    connectionMessage(state.provider?.configured ? 'Session key removed. Using the server key.' : 'Session key removed.');
  } catch { connectionMessage('Could not remove the key. Check the server and try again.',true); }
  finally { state.credentialBusy = false; renderProvider(); }
});
$('model').addEventListener('input',updateLaunch);
$('run-form').addEventListener('invalid',event => {
  const details = event.target.closest('details');
  if (details) details.open = true;
},true);
$('run-form').addEventListener('submit',async event => {
  event.preventDefault();
  if (state.launching || $('launch-run').disabled || !$('run-form').reportValidity()) return;
  state.launching = true;
  $('launch-error').hidden = true;
  const form = new FormData(event.currentTarget);
  const spec = {provider:'openai',model:String(form.get('model')).trim(),prompt:String(form.get('prompt')).trim()};
  for (const name of ['maxTurns','maxActions','maxPieces','maxOutputTokens','maxMinutes']) spec[name] = Number(form.get(name));
  state.pendingLaunch = {spec,ids:new Set(state.runs.map(run => run.id))};
  updateLaunch();
  try {
    const result = await request('/api/runs',{method:'POST',body:spec});
    if (!result.run?.id) throw new Error('The server did not return a run ID. Check for a started run.');
    await acceptStartedRun(result.run.id);
    await loadRuns().catch(error => pageError(error.message));
  } catch (error) {
    if (error.status >= 400 && error.status < 500) state.pendingLaunch = null;
    $('launch-error').textContent = error.message;
    $('launch-error').hidden = false;
    await loadRuns().catch(() => {});
    const recovered = pendingRun();
    if (recovered) await acceptStartedRun(recovered.id);
  } finally {
    state.launching = false;
    updateLaunch();
    clearTimeout(state.timer);
    state.timer = setTimeout(() => refresh(),1500);
  }
});
$('check-launch').addEventListener('click',async () => {
  if (state.checkingLaunch) return;
  state.checkingLaunch = true;
  updateLaunch();
  try {
    await loadRuns();
    const recovered = pendingRun();
    if (recovered) await acceptStartedRun(recovered.id);
    else {
      state.pendingLaunch = null;
      $('launch-error').textContent = 'No new run found. You can start another attempt.';
      $('launch-error').hidden = false;
    }
  } catch (error) { $('launch-error').textContent = error.message; $('launch-error').hidden = false; }
  finally { state.checkingLaunch = false; updateLaunch(); }
});
$('stop-run').addEventListener('click',async () => {
  if (!state.selected || !isActive(state.selected) || state.stoppingId) return;
  const id = state.selectedId;
  state.stoppingId = id;
  renderSelected();
  try { await request(`${runPath(id)}/stop`,{method:'POST',body:{}}); await loadRuns(); }
  catch (error) { pageError(error.message); }
  finally { state.stoppingId = null; renderSelected(); }
});
$('run-timeline').addEventListener('input',event => { stopPlayback(); state.timelineStep = Number(event.target.value); renderTimeline(); });
$('show-latest').addEventListener('click',() => { stopPlayback(); state.timelineStep = null; renderTimeline(); });
$('play-run').addEventListener('click',() => {
  if (state.playing) { stopPlayback(); return; }
  if (!state.selected?.acceptedActions) return;
  state.playing = true;
  $('play-run').textContent = 'Pause';
  state.timelineStep = state.timelineStep === null || state.timelineStep >= state.selected.acceptedActions ? 0 : state.timelineStep;
  renderTimeline();
  const next = () => {
    if (!state.playing || !state.selected) return;
    if (state.timelineStep >= state.selected.acceptedActions) { stopPlayback(); return; }
    state.timelineStep += 1; renderTimeline(); state.playTimer = setTimeout(next,850);
  };
  state.playTimer = setTimeout(next,850);
});
$('run-canvas').addEventListener('error',() => { $('canvas-error').hidden = false; });
$('run-canvas').addEventListener('load',() => { $('canvas-error').hidden = true; });
function resetFailedPreviews() {
  state.canvasURL = '';
  for (const card of state.cards.values()) {
    const image = card.querySelector('img');
    if (image.hidden) image.removeAttribute('src');
  }
}
$('refresh-runs').addEventListener('click',() => { resetFailedPreviews(); refresh({all:true}); });
$('retry-load').addEventListener('click',() => { resetFailedPreviews(); refresh({all:true}); });
window.addEventListener('popstate',() => {
  const id = new URL(location.href).searchParams.get('run');
  if (id) selectRun(id,{historyMode:'none'}).catch(error => pageError(error.message));
  else showCollection({historyMode:'none'});
});
document.addEventListener('visibilitychange',() => {
  if (document.hidden) { clearTimeout(state.timer); stopPlayback(); }
  else refresh({all:true});
});
window.addEventListener('pagehide',() => { clearTimeout(state.timer); stopPlayback(); $('api-key').value = ''; });
setView();
refresh({all:true});
