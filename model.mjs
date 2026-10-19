export function filteredWorks(index, {question = '', model = ''} = {}) {
  const order = values => new Map(values.map((value,i) => [value.id,i]));
  const packs = order(index.packs), models = order(index.models);
  return index.works.filter(work => (!question || work.promptId === question) && (!model || work.modelId === model))
    .sort((a,b) => packs.get(a.packId) - packs.get(b.packId) || a.repetition - b.repetition || models.get(a.modelId) - models.get(b.modelId));
}

export function readRoute(search, index) {
  const params = new URLSearchParams(search);
  const question = index.questions.some(item => item.id === params.get('question')) ? params.get('question') : '';
  const model = index.models.some(item => item.id === params.get('model')) ? params.get('model') : '';
  return {question,model,run:params.get('run') || ''};
}

export function routeURL(route) {
  const params = new URLSearchParams();
  for (const key of ['question','model','run']) if (route[key]) params.set(key,route[key]);
  return `./${params.size ? `?${params}` : ''}`;
}

export function actionLabel(action) {
  if (!action) return 'Blank canvas';
  const verbs = {cut:'Cut',place:'Place',transform:'Move',trim:'Trim',reorder:'Reorder',remove:'Remove',describe:'Title & statement'};
  return `${verbs[action.type] || action.type}${action.pieceId ? ` · ${action.pieceId}` : ''}`;
}

export function noteAtStep(notes, step, maximum) {
  if (step === maximum) {
    const review = notes.findLastIndex(note => note.fromStep === maximum);
    if (review >= 0) return review;
  }
  const current = notes.findIndex(note => note.accepted && step > note.fromStep && step <= note.step);
  return current >= 0 ? current : notes.findIndex(note => note.fromStep === step);
}

export function replayFrames(project, createState, applyAction) {
  const sources = project.sources.map(source => ({...source,dataUrl:''}));
  const frames = [createState({id:project.id,canvas:project.canvas,rules:project.rules,sources})];
  for (const action of project.actions) frames.push(applyAction(frames.at(-1),action));
  return frames;
}
