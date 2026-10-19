import { createState, applyAction } from './engine.mjs';
import { filteredWorks, readRoute, routeURL, actionLabel, noteAtStep, replayFrames } from './model.mjs';
import { drawFrame } from './viewer.mjs';

const $ = id => document.getElementById(id);
const contentURL = value => new URL(`./content/${value}`,import.meta.url).href;
const assetURL = value => {
  if (!/^assets\/[a-f0-9]{64}\.webp$/.test(value)) throw new Error('Invalid image path.');
  return contentURL(value);
};
const node = (tag,className,text) => {
  const item=document.createElement(tag);
  if (className) item.className=className;
  if (text !== undefined) item.textContent=text;
  return item;
};
const button = (label,className,click) => {
  const item=node('button',className,label);item.type='button';item.addEventListener('click',click);return item;
};
async function json(url) {
  const response=await fetch(url);
  if (!response.ok) throw new Error(`Could not load this work (${response.status}).`);
  return response.json();
}
let index, route, selected, frames=[], images=new Map(), step=0, playing=false, timer, version=0;
const cache=new Map();
const imageCache=new Map();
const modelFor = id => index.models.find(item => item.id === id);
const questionFor = id => index.questions.find(item => item.id === id);
const materialName = id => {
  const label=index.packs.find(item => item.id === id)?.label || 'Materials';
  return /figurative/i.test(label) ? 'Figurative' : /structural/i.test(label) ? 'Structural' : label.replace(/ materials$/i,'');
};
const plainClick = event => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

function navigate(next, {fromGallery=false} = {}) {
  if (!route.run) history.replaceState({...history.state,scrollY:scrollY},'',location.href);
  history.pushState({fromGallery},'',routeURL(next));
  renderRoute();
}

function renderGallery() {
  $('question').value=route.question;
  for (const item of $('models').children) item.setAttribute('aria-pressed',String(item.dataset.model === route.model));
  const works=filteredWorks(index,route);
  $('count').textContent=`${works.length} ${works.length === 1 ? 'work' : 'works'}`;
  $('empty').hidden=Boolean(works.length);
  const groups=document.createDocumentFragment();
  for (const [i,question] of index.questions.entries()) {
    const matches=works.filter(work => work.promptId === question.id);
    if (!matches.length) continue;
    const section=node('section','question-group');
    const heading=node('div','question-heading');
    const number=node('span','question-number',String(i+1).padStart(2,'0'));
    const title=node('h2','',question.text);title.id=`question-${question.id}`;
    heading.append(number,title);section.setAttribute('aria-labelledby',title.id);
    const grid=node('div','work-grid');
    for (const work of matches) {
      const model=modelFor(work.modelId);
      const card=node('a','work-card');card.href=routeURL({...route,run:work.id});card.dataset.run=work.id;
      card.setAttribute('aria-label',`${model.label}: ${work.title}. ${materialName(work.packId)} materials, run ${work.repetition}.`);
      const picture=node('div','work-image'), image=node('img');
      image.src=assetURL(work.preview);image.alt=work.title;image.width=work.width;image.height=work.height;image.loading='lazy';image.decoding='async';picture.append(image);
      const meta=node('div','card-meta');meta.append(node('span','',model.label),node('span','card-material',`${materialName(work.packId)} · ${work.repetition}`));
      card.append(picture,meta,node('h3','card-title',`“${work.title}”`));
      if (work.status !== 'completed') card.append(node('span','outcome',work.status.replaceAll('_',' ')));
      card.addEventListener('click',event => {
        if (!plainClick(event)) return;
        event.preventDefault();history.replaceState({...history.state,focusRun:work.id},'',location.href);
        navigate({...route,run:work.id},{fromGallery:true});
      });
      grid.append(card);
    }
    section.append(heading,grid);groups.append(section);
  }
  $('works').replaceChildren(groups);
}

function loadImage(source) {
  if (!imageCache.has(source.image)) {
    const pending=new Promise((resolve,reject) => {
      const image=new Image();image.onload=() => resolve(image);image.onerror=() => reject(new Error('A source image could not load. Please try again.'));image.src=assetURL(source.image);
    }).catch(error => {imageCache.delete(source.image);throw error;});
    imageCache.set(source.image,pending);
  }
  return imageCache.get(source.image);
}

function setTab(name) {
  for (const key of ['trace','materials']) {
    const active=key === name, tab=$(`${key}-tab`);
    tab.setAttribute('aria-selected',String(active));tab.tabIndex=active ? 0 : -1;$(`${key}-panel`).hidden=!active;
  }
}

function renderNotes() {
  const list=document.createDocumentFragment();
  for (const [i,note] of selected.notes.entries()) {
    const item=node('li','trace-turn');item.dataset.note=i;
    const seek=button('','turn-link',() => {pause();showStep(note.step,{noteIndex:i});});
    const range=note.step === note.fromStep+1 ? `Step ${note.step}` : `Steps ${note.fromStep+1}–${note.step}`;
    seek.append(node('span','',`Turn ${note.turn}`),node('span','',note.accepted ? note.fromStep === note.step ? note.done ? 'Final look' : 'Review' : range : 'Rejected · no changes'));
    seek.setAttribute('aria-label',`View turn ${note.turn}${note.accepted ? '' : ', rejected batch'}`);
    item.append(seek);
    if (note.note) item.append(node('p','turn-note',note.note));
    if (note.error) item.append(node('p','trace-error',note.error));
    if (note.actions.length) {
      const details=node('details','actions');details.append(node('summary','',`${note.actions.length} ${note.actions.length === 1 ? 'action' : 'actions'}`));
      const actions=node('ol','action-list');
      for (const [j,action] of note.actions.entries()) {
        const li=node('li');
        if (note.accepted) li.append(button(`${note.fromStep+j+1}. ${actionLabel(action)}`,'',() => {pause();showStep(note.fromStep+j+1,{noteIndex:i});}));
        else li.append(node('span','',actionLabel(action)));
        actions.append(li);
      }
      details.append(actions);item.append(details);
    }
    list.append(item);
  }
  if (!selected.notes.length) list.append(node('li','turn-note','No decision notes were recorded.'));
  $('trace').replaceChildren(list);
}

function renderSources() {
  const list=document.createDocumentFragment();
  for (const source of selected.sources) {
    const item=node('article','source'), image=node('img');
    image.src=assetURL(source.image);image.alt=source.name;image.loading='lazy';
    item.append(image,node('h3','',source.name));
    if (source.credit) item.append(node('p','',source.credit));
    if (source.license) item.append(node('p','',source.license));
    if (source.url && /^https?:\/\//i.test(source.url)) {
      const link=node('a','','Original');link.href=source.url;link.target='_blank';link.rel='noopener noreferrer';item.append(link);
    }
    list.append(item);
  }
  $('source-list').replaceChildren(list);
}

function showStep(value,{noteIndex} = {}) {
  if (!selected || !frames.length) return;
  step=Math.max(0,Math.min(selected.actions.length,Number(value)));
  const action=selected.actions[step-1];
  drawFrame($('canvas'),frames[step],images,action,{outline:step > 0 && step < selected.actions.length});
  $('canvas').setAttribute('aria-label',`${selected.title}, step ${step} of ${selected.actions.length}`);
  $('scrub').value=step;$('scrub').setAttribute('aria-valuetext',`${step} of ${selected.actions.length}: ${actionLabel(action)}`);
  $('position').textContent=`${step} / ${selected.actions.length}`;
  $('step-action').textContent=step === selected.actions.length ? selected.status === 'completed' ? 'Finished work' : 'Saved work' : actionLabel(action);
  $('previous').disabled=step === 0;$('next').disabled=step === selected.actions.length;
  const active=noteIndex ?? noteAtStep(selected.notes,step,selected.actions.length);
  for (const [i,item] of [...$('trace').children].entries()) {
    item.classList.toggle('active',i === active);
    const link=item.querySelector('.turn-link');
    if (link) {if (i === active) link.setAttribute('aria-current','step');else link.removeAttribute('aria-current');}
  }
  $('play').textContent=playing ? 'Pause' : step === selected.actions.length ? 'Replay' : 'Play';
  $('play').setAttribute('aria-label',playing ? 'Pause playback' : 'Play the build');
}

function pause() {
  playing=false;clearTimeout(timer);
  if (selected) {$('play').textContent=step === selected.actions.length ? 'Replay' : 'Play';$('play').setAttribute('aria-label','Play the build');}
}
function tick() {
  clearTimeout(timer);
  if (!playing) return;
  timer=setTimeout(() => {
    if (!playing || !selected) return;
    showStep(step+1);
    if (step === selected.actions.length) pause(); else tick();
  },500 / Number($('speed').value));
}

async function renderRoute() {
  const token=++version;pause();selected=null;frames=[];images=new Map();
  route=readRoute(location.search,index);
  $('loading').hidden=true;$('gallery').hidden=Boolean(route.run);$('work').hidden=!route.run;
  if (!route.run) {
    document.title='Offcut';renderGallery();
    requestAnimationFrame(() => {
      if (token !== version) return;
      const focus=history.state?.focusRun;
      if (focus) [...document.querySelectorAll('.work-card')].find(card => card.dataset.run === focus)?.focus({preventScroll:true});
      scrollTo(0,history.state?.scrollY || 0);
    });
    return;
  }
  $('work-content').hidden=true;$('work-loading').hidden=false;$('work-loading').replaceChildren(document.createTextNode('Loading work…'));
  $('back').href=routeURL({...route,run:''});
  const summary=index.works.find(work => work.id === route.run);
  scrollTo(0,0);
  if (!summary) {
    $('work-model').textContent='';$('work-question').textContent='This work isn’t here.';$('work-loading').textContent='Use All works to return to the gallery.';return;
  }
  const model=modelFor(summary.modelId);
  $('work-question').textContent=questionFor(summary.promptId).text;
  $('work-model').textContent=`${model.label} · ${model.model}`;
  $('work-question').focus({preventScroll:true});
  document.title=`${summary.title} — Offcut`;
  try {
    let data=cache.get(summary.id);
    if (!data) {data=await json(contentURL(`works/${summary.id}.json`));cache.set(summary.id,data);}
    if (data.id !== summary.id) throw new Error('This work could not be loaded.');
    const decoded=await Promise.all(data.sources.map(async source => [source.id,await loadImage(source)]));
    if (token !== version) return;
    selected=data;images=new Map(decoded);frames=replayFrames(data,createState,applyAction);
    $('work-title').textContent=`“${data.title}”`;$('statement').textContent=data.statement;
    $('work-materials').textContent=`${materialName(data.packId)} materials · Run ${data.repetition}${data.status === 'completed' ? '' : ` · ${data.status.replaceAll('_',' ')}`}`;
    $('brief').textContent=data.brief;$('scrub').max=data.actions.length;
    $('play').disabled=!data.actions.length;$('scrub').disabled=!data.actions.length;
    renderNotes();renderSources();setTab('trace');showStep(data.actions.length);
    $('work-loading').hidden=true;$('work-content').hidden=false;
  } catch (error) {
    if (token !== version) return;
    selected=null;frames=[];cache.delete(summary.id);
    $('work-loading').replaceChildren(document.createTextNode('Couldn’t load this work. '),button('Try again','text-button',renderRoute));
    console.error(error);
  }
}

$('question').addEventListener('change',event => navigate({...route,question:event.target.value,run:''}));
$('reset').addEventListener('click',() => navigate({question:'',model:'',run:''}));
$('back').addEventListener('click',event => {
  if (!plainClick(event)) return;event.preventDefault();
  if (history.state?.fromGallery) history.back();else navigate({...route,run:''});
});
$('play').addEventListener('click',() => {
  if (!selected) return;if (playing) {pause();return;}
  if (step === selected.actions.length) showStep(0);
  playing=true;showStep(step);tick();
});
$('previous').addEventListener('click',() => {pause();showStep(step-1);});
$('next').addEventListener('click',() => {pause();showStep(step+1);});
$('scrub').addEventListener('input',event => {pause();showStep(event.target.value);});
$('speed').addEventListener('change',() => {if (playing) tick();});
for (const name of ['trace','materials']) {
  $(`${name}-tab`).addEventListener('click',() => setTab(name));
  $(`${name}-tab`).addEventListener('keydown',event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();const other=event.key === 'Home' ? 'trace' : event.key === 'End' ? 'materials' : name === 'trace' ? 'materials' : 'trace';setTab(other);$(`${other}-tab`).focus();
  });
}
document.addEventListener('visibilitychange',() => {if (document.hidden) pause();});
addEventListener('pagehide',pause);
addEventListener('popstate',() => {if (index) renderRoute();});
document.querySelectorAll('.about-toggle').forEach(item => item.addEventListener('click',() => {pause();$('about').showModal();}));
document.querySelector('.wordmark').addEventListener('click',event => {if (plainClick(event) && index) {event.preventDefault();navigate({question:'',model:'',run:''});}});

try {
  index=await json(contentURL('gallery.json'));
  if (index.format !== 'offcut-public-gallery' || index.version !== 1) throw new Error('Invalid gallery.');
  for (const question of index.questions) {
    const option=node('option','',question.label);option.value=question.id;$('question').append(option);
  }
  for (const model of [{id:'',label:'All'},...index.models]) {
    const item=button(model.label,'',() => navigate({...route,model:model.id,run:''}));item.dataset.model=model.id;item.setAttribute('aria-pressed','false');$('models').append(item);
  }
  const repeats=new Set(index.works.map(work => work.repetition)).size;
  $('study-design').textContent=`${index.works.length} works. ${index.questions.length} questions, ${index.models.length} models, ${index.packs.length} material sets, ${repeats} runs of each combination.`;
  await renderRoute();
} catch {
  $('loading').hidden=false;$('loading').replaceChildren(document.createTextNode('Couldn’t load the gallery. '),button('Try again','text-button',() => location.reload()));
}
