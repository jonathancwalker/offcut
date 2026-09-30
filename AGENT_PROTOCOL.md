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

State includes canvas dimensions, source IDs and dimensions, source credits, current pieces, rule limits, title, statement, and action count. Read the actual rules rather than assuming the defaults. New canvases allow up to 64 vertices per cut; existing projects retain their saved limits.

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

### Change a piece

```json
{"type":"transform","pieceId":"first-fragment","x":420,"y":580,"rotation":-15,"scale":1.2}
```

Supply only the properties you want to change. All coordinates must be finite and within the rules.

### Layer and remove

```json
{"type":"reorder","pieceId":"first-fragment","index":0}
```

The piece array is ordered back to front, including pieces in the tray; index 0 is the back. Use `state.pieces.length - 1` for the front.

```json
{"type":"remove","pieceId":"first-fragment"}
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
