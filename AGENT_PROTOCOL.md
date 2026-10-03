# Offcut agent protocol

Default address: `http://127.0.0.1:4317`.

The assignment is open-ended: inspect the available materials, choose what the work should become, and make it using the permitted actions. There is no reference composition to reconstruct. Use the supplied source inventory; do not import new sources or reset the worktable during an experiment unless the experiment owner asks you to do so.

## Observe

- `GET /api/help`: action reference and restrictions.
- `GET /api/state`: `{state, history, cursor, liveCursor, canUndo, canRedo, revision}`.
- `GET /api/status`: lightweight `{revision, cursor, updatedAt}` for polling.
- `GET /api/sources/:id`: original source raster for image inspection.
- `GET /api/render.png`: current rendered canvas for image inspection.
- `GET /api/render.svg`: portable vector container with embedded source images.
- `GET /api/state?step=N` and `GET /api/render.png?step=N`: inspect after N actions without changing the live state. Step 0 is empty.

State includes canvas dimensions, source IDs and dimensions, source credits, current pieces, rule limits, title, statement, and action count. Read the actual rules rather than assuming the defaults. New canvases allow up to 64 vertices per source cut or trim mask; existing projects retain their saved limits. A piece has an outer `polygon` and may have `holes`, an array of source-coordinate polygons where material is absent. Generated trim results can have more vertices or less area than an input polygon permits.

## Act

Send JSON to `POST /api/actions`, with header `Content-Type: application/json`. Submit a single action or an atomic `{ "actions": [ ... ] }` batch. The response is the full updated state envelope; errors have `{ "error": "reason" }` and a non-success HTTP status.

### Cut and place

```json
{
  "actions": [
    {
      "type": "cut",
      "sourceId": "botanical",
      "pieceId": "first-fragment",
      "polygon": [[340,5],[600,5],[600,210],[340,210]]
    },
    {
      "type": "place",
      "pieceId": "first-fragment",
      "x": 500,
      "y": 600,
      "rotation": 0,
      "scale": 1
    }
  ]
}
```

These coordinates are an API example, not a suggested composition. Inspect the actual source before deciding on a cut. Cuts use source-image pixels. Placement x/y is the **center of the cut's bounding box** in canvas pixels. Rotation is clockwise in degrees; scale is uniform. A cut alone creates a piece in the tray. `place` makes it visible.

### Recut a fragment

```json
{"type":"trim","pieceId":"first-fragment","newPieceId":"refined-fragment","polygon":[[350,15],[580,15],[570,190],[350,190]]}
```

The polygon is a mask in **original source-image pixels**, not canvas coordinates or coordinates relative to the fragment. It must be a valid simple polygon within the source image and meet the same vertex and minimum-area rules as a source cut. It may extend beyond the parent or across existing holes: the engine retains only the intersection with the parent's actual material. A successful trim must retain some material and separate some offcut; an empty or unchanged result is rejected. `newPieceId` is required and must be unique.

Every connected retained component becomes a separate child, retaining the parent's visibility, scale, rotation, and position among visible layers. Every connected offcut becomes a separate **usable fragment in the tray**, initially hidden. Offcuts can be placed, transformed, reordered, removed, or trimmed again. The engine adjusts each child's bounding-box center so its source pixels retain their canvas position. A derived center can fall outside the canvas when trimming a piece that extends beyond it; explicit placement coordinates must still stay inside the canvas.

The first retained child receives `newPieceId`. Other retained children and all offcuts receive generated `piece-N` IDs. Read the returned state for those IDs; do not guess them. Every child records `parentPieceId` and `trimRole`, either `"retained"` or `"offcut"`. The parent records `childPieceIds` for all children and `supersededBy` for the first retained child. It stays permanently hidden and cannot be placed, transformed, reordered, removed, or trimmed again.

Pieces may now have holes. For example, retaining a square from the middle of a larger square creates a retained square and one offcut with a square hole. A later mask crossing that hole does not fill it. Do not supply `holes` in the action: the engine derives the output boundaries. Source material remains consumed, so reuse an offcut through its child ID rather than cutting that area from the original source again.

Each trim costs **one action**. The fragment limit counts **usable pieces**: all retained children and offcuts count, including hidden ones; retired parents do not. Capacity after a trim is the previous usable count minus one parent plus the number of children. Removing a child does not free capacity. If the complete result would exceed the limit, the whole trim is rejected.

Generated children preserve small scraps and complex boundaries even when they are below the input minimum area or above the input vertex limit. A separate limit of **8192 total output vertices**, summed across every child outer boundary and hole, rejects the whole trim if exceeded. No offcuts are silently discarded.

### Change a piece

```json
{"type":"transform","pieceId":"refined-fragment","x":420,"y":580,"rotation":-15,"scale":1.2}
```

Supply only the properties you want to change. All coordinates must be finite and within the rules.

### Layer and remove

```json
{"type":"reorder","pieceId":"refined-fragment","index":0}
```

The piece array is ordered back to front, including hidden and retired pieces; index 0 is the back. Use `state.pieces.length - 1` for the front. This array length includes historical parents and is not the usable-fragment count.

```json
{"type":"remove","pieceId":"refined-fragment"}
```

Removal puts a fragment in the tray. It still consumes its original material. Use `place` to return it to the canvas. There is no clone operation.

### Describe

```json
{"type":"describe","title":"Your title","statement":"A short artist statement about the finished work."}
```

Title: 160 characters maximum. Statement: 4000 maximum. The description is metadata and is not painted onto the canvas. A statement describes the work; it is not evidence of the model's internal reasoning.

## Review and finish

Inspect `/api/render.png` during the process. Revise through the same actions and stay within the budget. When finished, add a title and short statement, then save `GET /api/project` and `GET /api/render.png` to preserve the source inventory, artwork, and replay.

The studio also exposes `POST /api/undo` and `POST /api/redo` with `{}`. These restore editing state and its action budget; they are intended for exploration. A benchmark runner should independently track total effort and freeze the experiment configuration.

## Project administration

These endpoints belong to the person or runner setting up the experiment:

- `POST /api/sources` with `{name,dataUrl,credit?,url?,license?}` adds a local image. Sources are validated and normalized to PNG. Remote image URLs and SVG input are rejected.
- `POST /api/reset` with `{keepSources:true}` clears the composition and history while retaining materials. `{keepSources:false}` clears the inventory too.
- `GET /api/project` downloads a portable `offcut-project` JSON file.
- `POST /api/project` imports an exported project, validating its source files and replaying every action before replacement.

The server binds only to loopback, rejects cross-origin browser mutations, accepts JSON bodies only, and serves no workspace files outside its public directory and the explicitly exposed engine module. No model credentials are stored by the studio.
