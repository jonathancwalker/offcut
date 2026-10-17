export function canvasReference(turn) {
  return turn?.suppliedImages?.find(image => image.id === 'canvas') ?? null;
}

export function traceSelection(trace, index) {
  const turn = trace?.turns?.[index];
  if (!turn) return null;
  const next = trace.turns[index + 1] ?? null;
  const accepted = turn.validation?.status === 'accepted';
  return {
    turn,
    observed: canvasReference(turn),
    resultStep: accepted ? turn.committedCursor?.to ?? turn.observedCursor : turn.observedCursor,
    nextObserved: canvasReference(next),
    rejected: turn.validation?.status === 'rejected',
  };
}

export function actionSummary(actions) {
  if (actions === null) return 'Could not parse proposed actions';
  if (!actions?.length) return 'No actions proposed';
  const counts = new Map();
  for (const action of actions) counts.set(action?.type ?? 'unknown', (counts.get(action?.type ?? 'unknown') ?? 0) + 1);
  return [...counts].map(([type, count]) => `${count} ${type}`).join(' · ');
}
