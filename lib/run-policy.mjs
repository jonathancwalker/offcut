import { createHash } from 'node:crypto';

const clone = value => structuredClone(value);

const BASE_POLICY = Object.freeze({
  initialCanvas: 'blank',
  maxBatchActions: 12,
  maxContextTextCharacters: 250000,
  observation: {
    version: 1,
    sourceImages: 'all-every-turn',
    canvas: 'every-turn',
    priorImages: 'omitted-text-history-retained',
    maxEdge: 1536,
    format: 'png',
    resize: 'inside-without-enlargement',
  },
  retries: 'none',
  costUSD: null,
});

function instructionText(rules, requiresDescription) {
  const descriptionRequirement = requiresDescription
    ? ' Before setting done true, accepted describe actions must have explicitly supplied both a title and an artist statement, and both must still be nonblank after trimming whitespace. Engine defaults do not count. You may supply them in separate earlier describe actions. A missing title or statement defers finishing; a review-only turn cannot add either one.'
    : '';
  return `You are making a collage in Offcut using ONLY the supplied source material. Follow the user's artistic brief, and inspect the images attached to each turn before deciding what to do.
Return one JSON object, without commentary outside it: {"decision_note":"a brief description of the next decision, not private reasoning","actions":[...],"done":false}. decision_note is at most 2000 characters. Submit at most 12 actions per turn. Set done true only after inspecting the latest canvas and deciding it is finished.${descriptionRequirement} Leave a turn in your budget to look at the result of your last visual edits. If done true accompanies edits that change the visible composition, the edits are accepted but finishing waits for another observation and your confirmation. On that next turn you may revise, or finish with no visual changes (describe is allowed). Otherwise submit at least one action. If reviewOnly is true, the action budget is exhausted: inspect the canvas, submit an empty actions array, and set done true if satisfied or false to end unfinished. Review turns count toward the same turn, time, and output-token limits. A batch is atomic: if any action is invalid, the entire batch is rejected. You can correct it on your next turn while budgets remain.
Available actions and exact fields:
{"type":"cut","sourceId":"id","pieceId":"chosen-id","polygon":[[x,y],[x,y],[x,y]]}
{"type":"trim","pieceId":"existing-id","newPieceId":"new-unique-id","polygon":[[x,y],[x,y],[x,y]]}
{"type":"place","pieceId":"id","x":500,"y":600,"rotation":0,"scale":1}
{"type":"transform","pieceId":"id","x":500,"y":600,"rotation":30,"scale":1}
{"type":"reorder","pieceId":"id","index":0}
{"type":"remove","pieceId":"id"}
{"type":"describe","title":"Title","statement":"Artist statement"}
Cuts and trim masks use ORIGINAL source-image pixel coordinates, even when the attached observation has been resized. Input polygons need 3–${rules.maxVertices} vertices, no crossing edges, at least ${rules.minArea} square source pixels, and must stay inside that source. Cuts from the same source cannot overlap already consumed material, including material held by hidden or retired pieces. Each cut creates an initially hidden piece. Place makes it visible.
Trim physically divides one usable piece. Its polygon is a mask: only existing parent material inside that mask is retained, so the mask may extend outside the parent or across its holes without adding any material. A trim must retain some material and separate some offcut; empty or unchanged results are rejected. Every connected retained component becomes a child, preserving retained pixels in their exact canvas position and layer and inheriting visibility, rotation, and scale. Every connected offcut also becomes a usable child, initially hidden in the tray. You can place, transform, reorder, remove, or trim those offcuts. The first retained child uses the required unique newPieceId; additional retained children and all offcuts receive generated piece-N IDs. Inspect the returned state before referring to generated IDs. Each child records parentPieceId and trimRole (retained or offcut). A piece's polygon is its outer boundary; optional holes are arrays of source-coordinate polygons representing absent material. Holes cannot be filled by a later trim. Supply only the polygon mask in a trim action; the engine derives any holes.
The parent becomes permanently hidden and unusable, with supersededBy naming the first retained child and childPieceIds listing all children. Use child IDs afterward. The same source material cannot be cut again, but the offcuts remain available through their child IDs. Each trim costs one action. The ${rules.maxPieces}-piece limit counts usable pieces, including hidden offcuts; retired parents do not count. The trim is rejected atomically if all its children would exceed that limit. Generated child boundaries and small scraps are preserved even below the input minimum area or above the input vertex limit; a trim whose complete output exceeds 8192 boundary vertices is rejected. Removal hides a usable piece without freeing material or capacity.
Placement x/y is the center of the piece's outer bounding box on the canvas, rotation is clockwise degrees, and scale is uniform from ${rules.minScale} to ${rules.maxScale}. Piece order is back to front, including hidden and retired pieces; index 0 is the back. Transform does not unhide a piece. Explicit placement centers must lie inside the canvas; edges may extend off-canvas. Trim automatically adjusts child centers to preserve source-pixel positions, even if a derived center falls outside the canvas. No generated pixels, filters, added type, new image sources, code execution, or other tools are available. The state lists all pieces, including hidden and retired ones, and remaining turn/action budgets are provided. Describe counts as an action. Use explicit pieceId values for stable references.${requiresDescription ? '' : ' Finish with a title and statement if the budget permits.'}`;
}

/** Return the exact immutable protocol used for a new run. */
export function effectiveRunPolicy({ rules, study = false } = {}) {
  if (!rules || typeof rules !== 'object') throw new Error('Normalized engine rules are required.');
  const instructions = instructionText(rules, study);
  return {
    ...clone(BASE_POLICY),
    version: study ? 4 : 3,
    protocol: study ? 'offcut-actions-v4' : 'offcut-actions-v3',
    completion: {
      requiresObservedCanvas: true,
      ...(study ? {
        requiresAcceptedDescription: true,
        requiredDescriptionFields: ['title', 'statement'],
        descriptionFieldsMustBeNonblank: true,
      } : {}),
      reviewWithinTurnBudget: true,
      actionLimitReviewTurns: 1,
    },
    instructions,
    instructionsSha256: createHash('sha256').update(instructions).digest('hex'),
  };
}
