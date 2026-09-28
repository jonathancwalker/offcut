const $ = id => document.getElementById(id);
const state = {
  provider: null, sources: [], runs: [], selectedId: null, selected: null,
  events: [], selectedRevision: null, listSignature: '', timelineStep: null,
  playing: false, timer: null, playTimer: null, refreshing: false, launching: false,
  credentialBusy: false, stoppingId: null, selectionVersion: 0, initialized: false, canvasURL: '',
};
const statusNames = {
  running: 'Running', completed: 'Completed', stopped: 'Stopped', failed: 'Failed',
  interrupted: 'Interrupted', limit_reached: 'Limit reached',
};
const terminationMessages = {
  time_limit:'The run reached its time limit.', action_limit:'The run reached its action limit.',
  turn_limit:'The run reached its model turn limit.', context_limit:'The run reached its conversation size limit.',
  model_finished:'The model marked its composition as finished.', user_stopped:'You stopped this run.',
  server_restarted:'The server restarted before this run finished.', server_closed:'The server closed before this run finished.',
  provider_or_runner_error:'The run ended after a provider or runner error. See its activity record for details.',
  persistence_error:'The run stopped because its record could not be saved.',
};
const number = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—';
const date = value => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString(undefined, {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
};
const runPath = id => `/api/runs/${encodeURIComponent(id)}`;
const isActive = run => run?.status === 'running';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

async function request(path, {method = 'GET', body, timeout = 30000} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {
      method, signal: controller.signal, cache: 'no-store',
      ...(body === undefined ? {} : {headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),
    });
    let result;
    try { result = await response.json(); }
    catch { throw new Error('The studio returned an unreadable response. Refresh to try again.'); }
    if (!response.ok) throw new Error(result.error || `The request could not be completed (${response.status}).`);
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The request timed out. Check the run list before trying again.');
    if (error instanceof TypeError) throw new Error('The local studio is unavailable. Keep the server running, then try again.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function pageError(message) {
  $('page-error-message').textContent = message || '';
  $('page-error').hidden = !message;
}

function connectionMessage(message, error = false) {
  $('connection-message').textContent = message;
  $('connection-message').classList.toggle('error', error);
}

function updateLaunch() {
  const active = state.runs.find(isActive);
  $('launch-run').disabled = state.launching || !state.provider?.configured || !state.sources.length || Boolean(active) || !$('model').value.trim();
  $('launch-run').setAttribute('aria-busy', String(state.launching));
  $('launch-run').firstChild.textContent = state.launching ? 'Starting experiment… ' : 'Start an experiment ';
  $('launch-help').textContent = state.launching ? 'Preparing a saved copy of the materials…'
    : active ? 'One experiment at a time. Wait for the current run or stop it first.'
    : !state.provider?.configured ? 'Connect your API account to begin.'
    : !state.sources.length ? 'Add source images in the studio to begin.'
    : !$('model').value.trim() ? 'Enter the model ID you want to try.'
    : 'A new canvas. Your studio composition stays as it is.';
}

function renderProvider() {
  const configured = Boolean(state.provider?.configured);
  $('provider-status').textContent = configured ? 'Key ready' : 'Not connected';
  $('provider-status').classList.toggle('connected', configured);
  $('test-connection').disabled = !configured || state.credentialBusy;
  $('forget-key').hidden = state.provider?.keySource !== 'session';
  $('forget-key').disabled = state.credentialBusy;
  $('save-key').disabled = state.credentialBusy;
  $('api-key').disabled = state.credentialBusy;
  if (state.provider?.keySource === 'environment') $('key-help').textContent = 'Using the server’s environment key. A key entered here overrides it for this session only.';
  else $('key-help').textContent = 'Kept in server memory for this session. Never saved in a project or in browser storage.';
  updateLaunch();
}

async function loadProvider({initial = false} = {}) {
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
    const figure = element('figure', 'experiment-source');
    const image = element('img');
    image.alt = source.name || source.id;
    image.src = `/api/sources/${encodeURIComponent(source.id)}`;
    image.loading = 'lazy';
    image.addEventListener('error', () => image.replaceWith(element('span', 'experiment-source-error', 'Preview unavailable')), {once:true});
    figure.append(image, element('figcaption', '', source.name || source.id));
    fragment.append(figure);
  }
  if (!state.sources.length) fragment.append(element('p', 'field-help', 'Your materials are waiting. Add a few images in the studio, then return here.'));
  $('experiment-sources').replaceChildren(fragment);
  $('materials-summary').textContent = state.sources.length
    ? `${state.sources.length} source${state.sources.length === 1 ? '' : 's'}. Each run starts with a blank canvas and a saved copy of these materials.`
    : 'Any composition in the studio is kept separate from your experiments.';
  updateLaunch();
}

function statusBadge(run) {
  const badge = element('span', 'run-status', statusNames[run.status] || run.status || 'Unknown');
  badge.dataset.status = run.status;
  return badge;
}

function renderRunList() {
  $('run-count').textContent = state.runs.length;
  const signature = JSON.stringify(state.runs.map(run => [run.id,run.status,run.title,run.turns,run.acceptedActions,run.spec?.model,state.selectedId === run.id]));
  if (signature === state.listSignature) return;
  state.listSignature = signature;
  const focused = document.activeElement?.dataset?.runId;
  const fragment = document.createDocumentFragment();
  for (const run of state.runs) {
    const button = element('button', 'run-card');
    button.type = 'button';
    button.dataset.runId = run.id;
    button.setAttribute('aria-pressed', String(run.id === state.selectedId));
    const top = element('span', 'run-card-top');
    top.append(element('span', '', date(run.createdAt)), statusBadge(run));
    button.append(top, element('strong', '', run.title || 'Untitled experiment'), element('small', '', `${run.spec?.model || 'Model unavailable'} · ${number(run.acceptedActions ?? 0)} actions`));
    button.addEventListener('click', () => selectRun(run.id).catch(error => pageError(error.message)));
    fragment.append(button);
  }
  $('run-list').replaceChildren(fragment);
  if (focused) [...$('run-list').children].find(node => node.dataset.runId === focused)?.focus({preventScroll:true});
  $('empty-experiments').hidden = state.runs.length > 0;
  if (!state.runs.length) $('selected-run').hidden = true;
}

async function loadRuns() {
  const result = await request('/api/runs');
  state.runs = [...(result.runs || [])].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!state.selectedId && state.runs.length) {
    const requested = new URL(location.href).searchParams.get('run');
    state.selectedId = state.runs.some(run => run.id === requested) ? requested : state.runs[0].id;
  }
  renderRunList();
  updateLaunch();
  if (state.selectedId) await loadSelected();
}

function stopPlayback() {
  clearTimeout(state.playTimer);
  state.playing = false;
  $('play-run').textContent = '▶ Replay';
}

async function selectRun(id) {
  if (id === state.selectedId && state.selected) return;
  state.selectionVersion += 1;
  stopPlayback();
  state.selectedId = id;
  state.selected = null;
  state.events = [];
  state.selectedRevision = null;
  state.timelineStep = null;
  state.canvasURL = '';
  $('selected-run').hidden = true;
  const url = new URL(location.href);
  url.searchParams.set('run', id);
  history.replaceState(null, '', url);
  renderRunList();
  await loadSelected();
}

async function loadSelected() {
  const id = state.selectedId;
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
  $('selected-run').hidden = false;
  $('empty-experiments').hidden = true;
  $('selected-model').textContent = `${run.spec?.provider || 'OpenAI'} / ${run.spec?.model || 'Model unavailable'}`;
  $('selected-title').textContent = run.title || 'Untitled experiment';
  $('selected-status').textContent = statusNames[run.status] || run.status;
  $('selected-status').dataset.status = run.status;
  $('selected-date').textContent = `Started ${date(run.createdAt)} · ${(run.sourceManifest || []).length} saved sources`;
  $('stop-run').hidden = !isActive(run);
  $('stop-run').disabled = state.stoppingId === run.id;
  $('stop-run').textContent = state.stoppingId === run.id ? 'Stopping…' : 'Stop run';
  $('stat-turns').textContent = `${number(run.turns ?? 0)} / ${number(run.spec?.maxTurns)}`;
  $('stat-actions').textContent = `${number(run.acceptedActions ?? 0)} / ${number(run.spec?.maxActions)}`;
  $('stat-tokens').textContent = number(run.usage?.totalTokens ?? ((run.usage?.inputTokens || 0) + (run.usage?.outputTokens || 0)));
  $('stat-cost').textContent = run.costUSD === null || run.costUSD === undefined ? 'Not available' : `$${Number(run.costUSD).toFixed(4)}`;
  const notices = [];
  if (run.terminationReason && !isActive(run) && run.terminationReason !== 'model_finished') notices.push(terminationMessages[run.terminationReason] || String(run.terminationReason).replaceAll('_',' '));
  if (run.usageIncomplete || run.usage?.incomplete) notices.push('Usage may be incomplete. The provider may have billed requests without returning usage.');
  $('run-notice').textContent = notices.join(' ');
  $('run-notice').hidden = !notices.length;
  $('run-spec-text').textContent = JSON.stringify({spec:run.spec,sources:run.sourceManifest,terminationReason:run.terminationReason,rejectedBatches:run.rejectedBatches},null,2);
  $('download-artwork').href = `${runPath(run.id)}/render.png`;
  $('download-project').href = `${runPath(run.id)}/project`;
  $('download-bundle').href = `${runPath(run.id)}/export`;
  renderTimeline();
}

function renderTimeline() {
  const run = state.selected;
  if (!run) return;
  const count = run.acceptedActions || 0;
  if (state.timelineStep !== null) state.timelineStep = Math.min(state.timelineStep, count);
  const step = state.timelineStep ?? count;
  $('run-timeline').max = count;
  $('run-timeline').value = step;
  $('run-timeline').disabled = count === 0;
  $('play-run').disabled = count === 0;
  $('replay-count').textContent = `${number(count)} actions`;
  $('replay-caption').textContent = step === 0 ? 'Blank canvas' : `After action ${number(step)} of ${number(count)}`;
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
    run_started:'Experiment started', run_created:'Experiment created', observation:'Observation prepared',
    model_request:'Model turn started', model_response:'Model response', model_turn:'Model turn',
    actions_accepted:'Actions accepted', action_accepted:'Action accepted', actions_rejected:'Action batch rejected',
    action_rejected:'Action rejected', run_completed:'Experiment completed', run_stopped:'Experiment stopped',
    run_failed:'Experiment failed', run_finished:'Experiment ended', stop_requested:'Stop requested',
    error:'Error', decision:'Decision note', request:'Model turn started',
    model_output:'Model response', batch_result:event.accepted ? 'Actions accepted' : 'Action batch rejected',
    termination:'Experiment ended',
  };
  const label = names[kind] || kind.replaceAll('_',' ').replace(/^./,letter => letter.toUpperCase());
  return event.turn === undefined ? label : `Turn ${event.turn} · ${label}`;
}

function eventNote(event) {
  if (event.type === 'termination' && terminationMessages[event.reason]) return terminationMessages[event.reason];
  const candidates = [event.decision_note,event.decisionNote,event.note,event.message,event.error?.message,event.error,event.reason,event.output?.decision_note,event.response?.decision_note,event.data?.decision_note];
  const note = candidates.find(value => typeof value === 'string' && value.trim());
  if (note) return note.slice(0,1800);
  if (event.type === 'observation') return `Prepared ${(event.images || []).length} image input${event.images?.length === 1 ? '' : 's'}, including the canvas after ${event.step ?? 0} actions.`;
  if (event.type === 'model_output' && event.usage) return `${number(event.usage.inputTokens)} input tokens · ${number(event.usage.outputTokens)} output tokens`;
  return '';
}

function renderActivity() {
  const container = $('activity-list');
  const oldScroll = container.scrollTop;
  const atEnd = oldScroll + container.clientHeight >= container.scrollHeight - 35;
  const fragment = document.createDocumentFragment();
  let actionCount = 0;
  for (const event of state.events) {
    const item = element('div', 'activity-event');
    item.append(element('h4', '', eventTitle(event)));
    const note = eventNote(event);
    if (note) item.append(element('p','',note));
    const kind = event.type || event.kind || '';
    const accepted = event.type === 'batch_result' ? event.accepted === true : /accept|applied/.test(kind) && !/reject/.test(kind);
    if (accepted) {
      const actions = event.actions || event.data?.actions || (event.action ? [event.action] : []);
      actionCount += actions.length || event.count || 1;
      const step = event.acceptedActions ?? event.actionCount ?? event.step ?? actionCount;
      if (Number.isInteger(step) && step >= 0) {
        const button = element('button','text-button',`View after action ${step} ↗`);
        button.addEventListener('click', () => {
          stopPlayback();
          state.timelineStep = step;
          renderTimeline();
        });
        item.append(button);
      }
    }
    const timestamp = event.timestamp || event.at || event.createdAt;
    if (timestamp) item.append(element('p','activity-time',date(timestamp)));
    const details = element('details');
    details.append(element('summary','','Recorded data'),element('pre','',JSON.stringify(event,null,2).slice(0,30000)));
    item.append(details);
    fragment.append(item);
  }
  if (!state.events.length) fragment.append(element('p','field-help','Waiting for the first model turn…'));
  container.replaceChildren(fragment);
  $('activity-count').textContent = `${state.events.length} events`;
  container.scrollTop = atEnd ? container.scrollHeight : oldScroll;
}

async function refresh({all = false} = {}) {
  if (state.refreshing) return;
  state.refreshing = true;
  $('refresh-runs').disabled = true;
  try {
    const operations = [loadRuns()];
    if (all || !state.initialized) operations.push(loadProvider({initial:!state.initialized}),loadSources());
    const results = await Promise.allSettled(operations);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) pageError(failures[0].reason.message);
    else { pageError(''); state.initialized = true; }
  } finally {
    state.refreshing = false;
    $('refresh-runs').disabled = false;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { if (!document.hidden) refresh(); }, state.runs.some(isActive) ? 2500 : 8000);
  }
}

$('key-form').addEventListener('submit', async event => {
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
    connectionMessage('Session key ready. Test the connection to verify access and list your available models.');
  } catch {
    connectionMessage('The key could not be connected. Check the server and your key, then try again.',true);
  } finally {
    apiKey = '';
    state.credentialBusy = false;
    renderProvider();
  }
});

$('test-connection').addEventListener('click', async () => {
  if (state.credentialBusy) return;
  state.credentialBusy = true;
  renderProvider();
  connectionMessage('Checking access and listing models. No inference is being requested…');
  try {
    const result = await request('/api/providers/openai/test',{method:'POST',body:{},timeout:65000});
    const fragment = document.createDocumentFragment();
    for (const model of result.models || []) {
      const option = element('option');
      option.value = typeof model === 'string' ? model : model.id;
      if (option.value) fragment.append(option);
    }
    $('available-models').replaceChildren(fragment);
    connectionMessage(`Connection works. ${result.models?.length || 0} models listed; choose one with image input support. No inference was run.`);
  } catch {
    connectionMessage('Connection test failed. Check the API key, account access and network connection.',true);
  } finally {
    state.credentialBusy = false;
    renderProvider();
  }
});

$('forget-key').addEventListener('click', async () => {
  if (state.credentialBusy) return;
  state.credentialBusy = true;
  renderProvider();
  try {
    await request('/api/providers/openai',{method:'DELETE'});
    await loadProvider();
    $('available-models').replaceChildren();
    connectionMessage(state.provider?.configured ? 'Session key forgotten. The server’s environment key is now in use.' : 'Session key forgotten. Add a key when you are ready to run again.');
  } catch {
    connectionMessage('The session key could not be forgotten. Check the local server and try again.',true);
  } finally {
    state.credentialBusy = false;
    renderProvider();
  }
});

$('model').addEventListener('input', updateLaunch);
$('run-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.launching || $('launch-run').disabled || !$('run-form').reportValidity()) return;
  state.launching = true;
  $('launch-error').hidden = true;
  updateLaunch();
  const form = new FormData(event.currentTarget);
  const spec = {provider:'openai',model:String(form.get('model')).trim(),prompt:String(form.get('prompt')).trim()};
  for (const name of ['maxTurns','maxActions','maxPieces','maxOutputTokens','maxMinutes']) spec[name] = Number(form.get(name));
  try {
    const result = await request('/api/runs',{method:'POST',body:spec});
    if (!result.run?.id) throw new Error('The experiment started without a readable run ID. Refresh the list before trying again.');
    await selectRun(result.run.id);
    await loadRuns();
    $('selected-run').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',block:'start'});
  } catch (error) {
    $('launch-error').textContent = error.message;
    $('launch-error').hidden = false;
    await loadRuns().catch(() => {});
  } finally {
    state.launching = false;
    updateLaunch();
    clearTimeout(state.timer);
    state.timer = setTimeout(() => refresh(),1500);
  }
});

$('stop-run').addEventListener('click', async () => {
  if (!state.selected || !isActive(state.selected) || state.stoppingId) return;
  const id = state.selectedId;
  state.stoppingId = id;
  $('stop-run').disabled = true;
  $('stop-run').textContent = 'Stopping…';
  try {
    await request(`${runPath(id)}/stop`,{method:'POST',body:{}});
    await loadRuns();
  } catch (error) {
    pageError(error.message);
  } finally {
    state.stoppingId = null;
    renderSelected();
  }
});

$('run-timeline').addEventListener('input', event => {
  stopPlayback();
  state.timelineStep = Number(event.target.value);
  renderTimeline();
});
$('show-latest').addEventListener('click', () => {
  stopPlayback();
  state.timelineStep = null;
  renderTimeline();
});
$('play-run').addEventListener('click', () => {
  if (state.playing) { stopPlayback(); return; }
  if (!state.selected?.acceptedActions) return;
  state.playing = true;
  $('play-run').textContent = 'Ⅱ Pause';
  state.timelineStep = state.timelineStep === null || state.timelineStep >= state.selected.acceptedActions ? 0 : state.timelineStep;
  renderTimeline();
  const next = () => {
    if (!state.playing || !state.selected) return;
    if (state.timelineStep >= state.selected.acceptedActions) { stopPlayback(); return; }
    state.timelineStep += 1;
    renderTimeline();
    state.playTimer = setTimeout(next,850);
  };
  state.playTimer = setTimeout(next,850);
});
$('run-canvas').addEventListener('error', () => { $('canvas-error').hidden = false; });
$('run-canvas').addEventListener('load', () => { $('canvas-error').hidden = true; });
$('refresh-runs').addEventListener('click', () => { state.canvasURL = ''; refresh({all:true}); });
$('retry-load').addEventListener('click', () => refresh({all:true}));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(state.timer); stopPlayback(); }
  else refresh({all:true});
});
window.addEventListener('pagehide', () => {
  clearTimeout(state.timer);
  stopPlayback();
  $('api-key').value = '';
});
refresh({all:true});
