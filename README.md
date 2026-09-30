# Offcut

A local environment for observing what an AI agent invents from existing images. Start a bounded task, then inspect the finished collage, its fragments, original sources, and recorded construction.

The product has two pages: **Library** and **Work**. [The component map](docs/PRODUCT.md) defines their scope. The [roadmap](ROADMAP.md), [research plan](docs/RESEARCH_PLAN.md), and [representation track](docs/REPRESENTATION_TRACK.md) cover further development.

## Run

Requires Node.js 22 or newer and the `sharp` image library.

```sh
npm install
npm start
```

Open **http://127.0.0.1:4317**. Inside this Codex workspace, the server can use the bundled `sharp` installation without installing dependencies. Elsewhere, run `npm install` first. Use `PORT=4318 npm start` if the default port is occupied.

The app listens on this computer only. The manual studio works offline without an account or model API key. Starter images and fonts are bundled locally. Model experiments require an OpenAI API connection and are billed to that account.

## Observe a model's work

The home page is the **Library**. It includes recorded model runs and the two early archived works. Cards show an app-owned work ID, model, provider, date, and outcome. Search by work ID/model/provider, filter by model or outcome, and browse in pages of 24.

1. Choose **Run a model** and connect an OpenAI API key. A key entered here stays in server memory until forgotten or the server restarts; keys are not saved to browser storage, projects, or records. An `OPENAI_API_KEY` environment variable is also supported.
2. Choose an image-capable model that supports the Responses API. Test connection lists accessible model IDs; listing alone does not verify image support.
3. Inspect the current sources and fixed task/limits, then choose **Start**. The model gets a separate blank canvas and an immutable source snapshot. Setup currently uses all images in the local source inventory.
4. Return to Library. Working records show status; their work and playback become available once the run ends. A working record also offers Stop.
5. Open a finished work to replay accepted actions. Switch between **Fragments** and **Sources**. Select a fragment to inspect exactly where it came from. Model-authored titles/statements are explicitly labeled inside the viewer and never become system record names.

The task and limits are fixed in this initial product flow: 24 fragments, 120 accepted actions, 12 model turns, 10 minutes, and 4,096 output tokens per turn. Artwork is read-only; playback never changes the record. Failed/stopped/limited runs retain their saved output and honest outcome labels.

The Work viewer plays at 2× by default. Choose 0.5×, 1×, 2×, 4×, or 8× beside the playback controls; changes apply while playing and the browser remembers your preference. Each frame finishes loading before playback advances, so image-rendering time can limit the fastest rates.

The two archived works are read from `experiments/001/final-project.json` and `experiments/002/final-project.json`. Exact model identifiers were not captured. A001 includes five human seed actions; A002 began with a blank canvas and fresh agent context. Archive playback preserves those distinctions. Legacy `/experiments.html?run=…` links redirect to the new viewer.

Runs save under `.data/runs/`. Each has frozen sources and their hashes, a specification, append-only events, image observations, model outputs, and replayable accepted actions. Past source/canvas observations are stored by hash; a full run export includes their bytes. Model calls use native image inputs with images resized to at most 1536 pixels on their longest edge. Cut coordinates remain in original source pixels. Prior textual context is retained; past image attachments are not resent.

Limits cover model turns, accepted actions, fragments, output tokens per request and elapsed time, plus a fixed textual-context ceiling. Usage is recorded when returned. **Dollar estimates and spending caps are not implemented yet**; a cancelled or failed request may still be billed, and incomplete usage is labeled. Network failures are not retried automatically. Malformed or invalid action batches remain recorded and can be corrected within the remaining turn budget. Restarting the server marks unfinished runs interrupted; it does not automatically resume paid requests.

The first adapter supports OpenAI. Additional providers, repeat queues, richer observation playback, public publishing and measurement computation remain on the roadmap. Tests use simulated providers; a live paid inference run is a separate validation step.

## Development studio

The original manual environment remains at **http://127.0.0.1:4317/studio.html**, outside the product navigation. It is useful for developing the action environment and managing the current source inventory. Existing artwork is preserved.

- Start with the three archival sources, or add PNG, JPEG, or WebP images.
- Browse materials by name, filter used or unused images, and sort by name or added order. Thumbnails preserve the image’s framing and color; the info button shows dimensions and available credits, license, and source link.
- Click a source and draw a rectangle or polygon. Polygon corners are added by clicking; close at the first corner, or choose **Cut & place**. Numeric rectangle coordinates provide a keyboard alternative.
- Drag a fragment on the canvas. Select it to change its position, rotation, scale, or layer. Arrow keys nudge by one canvas pixel; Shift + arrow moves ten. Delete returns the selected piece to the tray.
- **View source** highlights the exact cut boundary in the original image. Shaded source regions have been consumed.
- Edit the statement in the sidebar, or use **Project menu → Canvas details** on any screen size.
- Undo/redo with the toolbar or Command/Ctrl + Z and Command/Ctrl + Shift + Z.
- Scrub or play **Timeline** to review earlier states. Replay never changes the live composition; return to live before editing.
- Export a PNG, a self-contained SVG, or a portable project with its complete retained action history and source images. A saved project can be reopened through **Project menu → Open project**.

Work saves automatically to `.data/session.json` after every accepted mutation. Imported projects are reconstructed and validated before replacing the current work. If a saved session is corrupt, the server keeps a recovery copy in `.data/`.

## Rules

The default canvas is 1000 × 1200 pixels with a plain paper-colored background. Every artwork fragment refers to an original raster image plus a polygon in that image's coordinates. The renderer clips and transforms that source; it does not generate artwork pixels, paint, recolor, blend, add typography, or stretch non-uniformly. Rotation and resizing use normal image resampling, so this is provenance-preserving composition rather than a promise of identical output RGB values after resampling.

- Up to **24 cut fragments** and **120 successful actions**.
- Cuts are simple polygons with 3–16 corners, at least 100 square source pixels, fully inside a source image.
- Polygon boundaries may touch, but their interiors cannot overlap on the same source.
- Cutting consumes material even while the fragment is in the tray. Removing a piece does not make the original source region available again.
- Uniform scale: 15–300%. Piece centers stay on the canvas, but edges may extend beyond it and are clipped by the final canvas.
- Each successful cut, placement, transform, reorder, removal, or description counts as one action. A rejected action changes nothing. A submitted batch either succeeds completely or changes nothing.

This version is an **exploration environment**, not a validated creativity leaderboard. In the manual studio, undo restores the earlier action budget; editing after undo replaces the abandoned continuation. Sources may be added during a studio session, and imports may specify bounded alternate rules. Recorded model runs instead freeze their materials and rules, keep rejected attempts, and have no undo command. A comparative study still needs repeated runs, a frozen evaluation protocol and blind judgments. Observable actions and explicit decision notes do not reveal private internal reasoning.

## Agent access

For the external-agent workflow, choose **Project menu → Agent access** in the studio for a copyable prompt. This button does not start a model automatically. That external agent needs image-reading and local HTTP access on this computer. The integrated **Run a model** flow instead calls OpenAI from the local server and applies commands locally; the remote model does not access localhost or the desktop.

Read [AGENT_PROTOCOL.md](./AGENT_PROTOCOL.md) for the action contract, or open `GET /api/help` for the machine-readable reference. Both manual and agent edits use the same authoritative engine. External agent edits appear in the browser automatically.

The action interface itself is model-neutral JSON. The starter workflow assumes image input; a text-only model would need descriptions and spatial annotations of the source material. [Observation and action interfaces](docs/MODEL_INTERFACE.md) documents the first experiment and current runner. [BACKLOG.md](BACKLOG.md) tracks additional providers, richer trajectory playback, and model comparisons.

## Validation

```sh
npm test
```

Tests cover polygon validity and overlap, finite material, immutable state, limits, source metadata, renderer fidelity, layering, atomic action batches, undo/redo and replay, persistence, image input validation, portable imports, and local-request protection. Runner checks cover native image delivery, credential handling, isolation, invalid batches, cancellation, time/context limits, recovery and exact exported replay. Integration tests use simulated providers and bind temporary loopback ports, which need permission in a sandbox that blocks local servers.

The browser workflow was also exercised for cutting, dragging, transforms, provenance, undo/redo, replay, mobile controls, and keyboard focus. Collection checks cover model/outcome filters, 50 simulated run summaries, pending/finished separation, fixed setup, and uncertain-network handling. Viewer checks cover exact fragment/source tracing, attributed text, archived seeds, partial output, and summary-only polling while working. Archive tests reproduce both original PNGs exactly.

## Project structure

```text
public/             Library, observer viewer, developer studio, local assets
lib/engine.mjs      Pure state transitions and geometry validation
lib/render.mjs      Source-preserving SVG and PNG rendering
lib/runs.mjs        Isolated model loop, observations, durable events and recovery
lib/archives.mjs    Read-only replay of the two early saved works
lib/providers.mjs   Private provider connections and OpenAI Responses adapter
server.mjs          Local HTTP API and persistent action history
tests/              Engine, renderer, and API integration checks
docs/               Interface design and experiment architecture
experiments/        Saved artworks, source projects, prompts, actions and audits
```

Experiment checkpoint state copies and per-stage portable projects are kept locally but ignored by Git because they repeat embedded images. The original and final portable projects, stage commands, API log, PNG checkpoints, final SVG, and readable trajectory are versioned.

Starter image credits and rights records are in [public/sources/CREDITS.md](./public/sources/CREDITS.md). Bundled font licenses are in `public/fonts/`. Imported sources retain the attribution supplied with them.
