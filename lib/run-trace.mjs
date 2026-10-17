import { createState, applyAction } from './engine.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseProposal(text) {
  if (typeof text !== 'string') return { status: 'missing', value: null };
  try {
    const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (!object(value) || !Array.isArray(value.actions)) return { status: 'invalid_structure', value: object(value) ? value : null };
    return { status: 'parsed', value };
  } catch { return { status: 'invalid_json', value: null }; }
}

function simplePolygon(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3 || polygon.some(point => !Array.isArray(point) || point.length !== 2 || point.some(value => !Number.isFinite(value)))) return false;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const between = (a, b, value) => value >= Math.min(a, b) && value <= Math.max(a, b);
  const intersects = (a, b, c, d) => {
    const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
    if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
    return (abC === 0 && between(a[0], b[0], c[0]) && between(a[1], b[1], c[1])) ||
      (abD === 0 && between(a[0], b[0], d[0]) && between(a[1], b[1], d[1])) ||
      (cdA === 0 && between(c[0], d[0], a[0]) && between(c[1], d[1], a[1])) ||
      (cdB === 0 && between(c[0], d[0], b[0]) && between(c[1], d[1], b[1]));
  };
  for (let first = 0; first < polygon.length; first++) for (let second = first + 1; second < polygon.length; second++) {
    if (first === second || (first + 1) % polygon.length === second || (second + 1) % polygon.length === first) continue;
    if (intersects(polygon[first], polygon[(first + 1) % polygon.length], polygon[second], polygon[(second + 1) % polygon.length])) return false;
  }
  return true;
}

function geometry(action, state, sources) {
  if (!object(action) || !['cut', 'trim'].includes(action.type)) return null;
  const sourceId = action.type === 'cut' ? action.sourceId : state?.pieces?.find(piece => piece.id === action.pieceId)?.sourceId ?? null;
  const source = sources.get(sourceId);
  const polygon = action.polygon;
  const finite = Array.isArray(polygon) && polygon.length > 0 && polygon.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite));
  let bounds = null;
  if (finite) {
    const xs = polygon.map(point => point[0]), ys = polygon.map(point => point[1]);
    bounds = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  const area = simplePolygon(polygon) ? Math.abs(polygon.reduce((sum, point, index) => {
    const next = polygon[(index + 1) % polygon.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0)) / 2 : null;
  return {
    operation: action.type,
    sourceId,
    vertexCount: Array.isArray(polygon) ? polygon.length : null,
    boundingBoxSourceRatio: bounds && source && source.width > 0 && source.height > 0 ? bounds.width * bounds.height / (source.width * source.height) : null,
    polygonArea: area,
  };
}

function proposalActions(parsed, result) {
  if (Array.isArray(result?.submittedActions)) return result.submittedActions;
  if (Array.isArray(result?.proposedActions)) return result.proposedActions;
  if (Array.isArray(result?.actions)) return result.actions;
  return Array.isArray(parsed.value?.actions) ? parsed.value.actions : null;
}

/** Build an evidence-linked trace without inferring hidden reasoning or actions. */
export function buildRunTrace({ summary, events, project }) {
  if (!object(summary) || !Array.isArray(events) || !object(project)) throw new Error('Expected saved run summary, events and project.');
  const byTurn = new Map();
  for (const event of events) if (Number.isSafeInteger(event.turn) && event.turn > 0) {
    if (!byTurn.has(event.turn)) byTurn.set(event.turn, []);
    byTurn.get(event.turn).push(event);
  }
  const sources = new Map((project.sources ?? []).map(source => [source.id, source]));
  let scene;
  try { scene = createState({ id: project.id, sources: project.sources, rules: project.rules, canvas: project.canvas }); } catch { scene = null; }
  let explicitTitle = null, explicitStatement = null;
  const turns = [];
  for (const [turn, records] of [...byTurn].sort(([a], [b]) => a - b)) {
    const one = type => records.find(event => event.type === type);
    const observation = one('observation'), request = one('request'), output = one('model_output'), result = one('batch_result'), review = one('final_review');
    const parsed = parseProposal(output?.text);
    const proposedActions = proposalActions(parsed, result);
    const acceptedActions = result?.accepted === true && Array.isArray(result.actions) ? result.actions : [];
    const sceneBefore = scene;
    if (result?.accepted === true && scene) for (const action of acceptedActions) {
      try { scene = applyAction(scene, action); scene.sources = sceneBefore.sources; } catch { scene = null; break; }
      if (action.type === 'describe') {
        if (Object.hasOwn(action, 'title')) explicitTitle = action.title;
        if (Object.hasOwn(action, 'statement')) explicitStatement = action.statement;
      }
    }
    // The observation owns the complete attachment metadata. The request event
    // keeps matching hashes but intentionally omits image dimensions and kind.
    const suppliedImages = observation?.images ?? request?.request?.messages?.flatMap(message => Array.isArray(message.images) ? message.images : []) ?? [];
    const fromResult = typeof result?.decision_note === 'string';
    const note = fromResult ? result.decision_note : typeof parsed.value?.decision_note === 'string' ? parsed.value.decision_note : null;
    turns.push({
      turn,
      evidence: { observation: observation?.sequence ?? null, request: request?.sequence ?? null, output: output?.sequence ?? null, result: result?.sequence ?? null, finalReview: review?.sequence ?? null },
      observedCursor: observation?.step ?? null,
      suppliedImages: suppliedImages.map(({ id, kind, mime, sha256, width, height }) => ({ id, kind: kind ?? null, mime: mime ?? null, sha256, width: width ?? null, height: height ?? null })),
      parseStatus: parsed.status,
      proposedActions: proposedActions === null ? null : structuredClone(proposedActions),
      decisionNote: note,
      noteOrigin: note === null ? null : fromResult ? 'batch_result' : 'model_output_json',
      validation: {
        status: result?.accepted === true ? 'accepted' : result?.accepted === false ? 'rejected' : 'no_result',
        stage: result?.accepted === false ? result.failureStage ?? null : null,
        failedActionIndex: result?.accepted === false && Number.isSafeInteger(result.failedActionIndex) ? result.failedActionIndex : null,
        code: result?.accepted === false ? result.code ?? 'UNKNOWN' : null,
        error: result?.accepted === false ? result.error ?? null : null,
      },
      committedCursor: result?.accepted === true ? { from: result.fromStep, to: result.step } : result?.accepted === false ? { from: result.step, to: result.step } : null,
      completionRequested: typeof result?.done === 'boolean' ? result.done : typeof parsed.value?.done === 'boolean' ? parsed.value.done : null,
      writingAfter: { title: explicitTitle, statement: explicitStatement },
      _sceneBefore: sceneBefore,
    });
  }
  for (let index = 0; index < turns.length; index++) turns[index].nextTurn = turns[index + 1]?.evidence.request ?? null;
  const recovery = [];
  for (let index = 0; index < turns.length; index++) {
    const rejected = turns[index];
    if (rejected.validation.status !== 'rejected') continue;
    const next = turns[index + 1]?.evidence.request ? turns[index + 1] : null;
    const failedIndex = rejected.validation.failedActionIndex;
    const failedAction = failedIndex === null ? null : rejected.proposedActions?.[failedIndex] ?? null;
    const failedGeometry = geometry(failedAction, rejected._sceneBefore, sources);
    let relatedIndex = null, relatedGeometry = null;
    if (failedGeometry && next?.proposedActions) for (const [candidateIndex, action] of next.proposedActions.entries()) {
      const candidate = geometry(action, rejected._sceneBefore, sources);
      if (candidate?.operation === failedGeometry.operation && candidate.sourceId === failedGeometry.sourceId) {
        relatedIndex = candidateIndex; relatedGeometry = candidate; break;
      }
    }
    recovery.push({
      rejectedTurn: rejected.turn,
      rejectedResultSequence: rejected.evidence.result,
      nextRequestedTurn: next?.turn ?? null,
      nextRequestSequence: next?.evidence.request ?? null,
      primaryRecovery: next ? next.validation.status === 'accepted' : null,
      nextAcceptedGeometricBatch: next ? next.validation.status === 'accepted' && Boolean(next.proposedActions?.some(action => ['cut', 'trim'].includes(action.type))) : null,
      failedActionIndex: failedIndex,
      failedGeometry,
      relatedProposalIndex: relatedIndex,
      relatedGeometry,
      relatedProposalStatus: failedGeometry ? relatedGeometry ? 'matched' : 'no_related_proposal' : 'causal_action_unknown',
      relatedBatchCommitted: relatedGeometry ? next.validation.status === 'accepted' : null,
      deltas: failedGeometry && relatedGeometry ? {
        vertexCount: relatedGeometry.vertexCount === null || failedGeometry.vertexCount === null ? null : relatedGeometry.vertexCount - failedGeometry.vertexCount,
        boundingBoxSourceRatio: relatedGeometry.boundingBoxSourceRatio === null || failedGeometry.boundingBoxSourceRatio === null ? null : relatedGeometry.boundingBoxSourceRatio - failedGeometry.boundingBoxSourceRatio,
        polygonArea: relatedGeometry.polygonArea === null || failedGeometry.polygonArea === null ? null : relatedGeometry.polygonArea - failedGeometry.polygonArea,
      } : { vertexCount: null, boundingBoxSourceRatio: null, polygonArea: null },
    });
  }
  for (const turn of turns) delete turn._sceneBefore;
  return { format: 'offcut-run-trace', version: 1, runId: summary.id, status: summary.status, turns, recovery };
}
