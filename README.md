# Offcut

A local environment for observing what an AI agent invents from existing images. Start a bounded task, then inspect the finished collage, its fragments, original sources, and recorded construction.

The product centers on **Library**, **New run**, and **Work**. [The component map](docs/PRODUCT.md) defines their scope. The [roadmap](ROADMAP.md), [research plan](docs/RESEARCH_PLAN.md), and [representation track](docs/REPRESENTATION_TRACK.md) cover further development.

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

1. Open **New run** at `/new.html` from Library. Select 1–24 source images, or upload images to the local inventory and select them. The model will receive only the selected images, with a fresh copy of their material for this run.
2. Connect an OpenAI API key and choose an image-capable model that supports the Responses API. A key entered here stays in server memory until forgotten or the server restarts; keys are not saved to browser storage, projects, or records. An `OPENAI_API_KEY` environment variable is also supported. **Check access & load models** lists accessible model IDs; listing alone does not verify image support.
3. Choose **Small**, **Standard**, or **Extended**, or customize the limits. Inspect the fixed task and start the run. The model gets a separate blank canvas and an immutable snapshot of the selected images.
4. Return to Library. Working records show status; their work and playback become available once the run ends. A working record also offers Stop. If a start request has an uncertain outcome, retry that same request rather than starting again: the server returns its existing work when one was already created.
5. Open a finished work to replay accepted actions. Switch between **Fragments** and **Sources**. Select a fragment to inspect exactly where it came from. Model-authored titles/statements are explicitly labeled inside the viewer and never become system record names.

The task stays open: create an original collage from the supplied material, choose its subject and composition, and supply a title and short statement. There is no target image or editable creative prompt. The user chooses the model, source material, and limits; the model makes the work.

| Budget | Fragments | Accepted actions | Model turns | Time limit | Output tokens per turn |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small | 12 | 60 | 6 | 5 min | 4,096 |
| Standard | 24 | 120 | 12 | 10 min | 4,096 |
| Extended | 48 | 240 | 24 | 20 min | 4,096 |

These are ceilings, not promised duration, fragment count, or quality. Custom limits allow 1–64 fragments, 1–240 accepted actions, 1–40 turns, 1–60 minutes, and 256–16,384 output tokens per turn. Each turn permits up to 12 actions; rejected batches still consume a turn. Cutting and placing a fragment require separate actions.

The local source inventory currently holds at most 24 images and 24 MB of normalized image data. Uploads add to this shared inventory without changing earlier runs. Full source management, including removal and replacement, is deferred. Selection is frozen at launch, and changed or missing selected material must be reviewed before proceeding.

Artwork is read-only; playback never changes the record. Failed/stopped/limited runs retain their saved output and honest outcome labels. The folded work record includes the task and limits actually used, omitting information that was not recorded for older archives.

The two archived works are read from `experiments/001/final-project.json` and `experiments/002/final-project.json`. Exact model identifiers were not captured. A001 includes five human seed actions; A002 began with a blank canvas and fresh agent context. Archive playback preserves those distinctions. Legacy `/experiments.html?run=…` links redirect to the new viewer.

Runs save under `.data/runs/`. Each has frozen sources and their hashes, a specification, append-only events, image observations, model outputs, and replayable accepted actions. Past source/canvas observations are stored by hash; a full run export includes their bytes. Model calls use native image inputs with images resized to at most 1536 pixels on their longest edge. Cut coordinates remain in original source pixels. Prior textual context is retained; past image attachments are not resent.

Limits cover model turns, accepted actions, fragments, output tokens per request and elapsed time, plus a fixed textual-context ceiling. Usage is recorded when returned. **Dollar estimates and spending caps are not implemented yet**; a cancelled or failed request may still be billed, and incomplete usage is labeled. Provider network failures stop the run without automatic retries. Retrying an uncertain launch uses the same request identity to avoid creating a second run; it does not repeat model calls within an existing run. Malformed or invalid action batches remain recorded and can be corrected within the remaining turn budget. Restarting the server marks unfinished runs interrupted; it does not automatically resume paid requests.

The first adapter supports OpenAI. Additional providers, repeat queues, richer observation playback, public publishing and measurement computation remain on the roadmap. Tests use simulated providers; a live paid inference run is a separate validation step.

## Bundled source collection

The app now includes **21 source images**: the original three plus 18 natural-history plates, archival photographs, a portrait, a still life, maps, lettering, textile designs, and mechanical diagrams. New installations load them automatically. New run still starts with just the original three selected, so additional material is an explicit choice.

For an existing installation, start Offcut and run `npm run sources:import`. This adds missing bundled images through the source API without clearing artwork or history. It compares image hashes, so it can be run again after interruption without re-adding confirmed images. The current collection limit remains 24 images / 24 MB; the bundled collection uses about 20 MB after PNG normalization.

Every added image has a collection link, credit, and recorded reuse status. [Source credits](public/sources/CREDITS.md) and the [curated catalog](public/sources/curated/catalog.json) include the original downloads and exact image hashes. Added copies preserve the full image at up to 900 pixels on their longest edge; there are no generated assets, filters, or crops. Rights labels remain specific: public domain, CC0, or the Library of Congress’s “no known restrictions” advisory.

To collect more images into a separate local library, run `npm run sources:collect -- --limit 100 --topics "birds,botanical,textile,architecture"`. The first collector uses Cleveland Museum of Art's image-level CC0 records, preserves provenance, skips duplicates, and checkpoints interrupted jobs. Preview the result at `.data/source-library/index.html`; continue a paused job with `npm run sources:collect -- --resume`. This larger library is not yet connected to the 24-image New run picker. See [collection commands and limits](docs/SOURCE_COLLECTION.md).

## Development studio

The original manual environment remains at **http://127.0.0.1:4317/studio.html**, outside the product navigation. It is useful for developing the action environment and managing the current source inventory. Existing artwork is preserved.

- Start with 21 bundled sources, or add PNG, JPEG, or WebP images.
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

- Standard runs and the developer studio default to **24 cut fragments** and **120 successful actions**. Other model runs use their selected budget.
- Cuts are simple polygons with 3–16 corners, at least 100 square source pixels, fully inside a source image.
- Polygon boundaries may touch, but their interiors cannot overlap on the same source.
- Cutting consumes material even while the fragment is in the tray. Removing a piece does not make the original source region available again.
- Uniform scale: 15–300%. Piece centers stay on the canvas, but edges may extend beyond it and are clipped by the final canvas.
- Each successful cut, placement, transform, reorder, removal, or description counts as one action. A rejected action changes nothing. A submitted batch either succeeds completely or changes nothing.

This version is an **exploration environment**, not a validated creativity leaderboard. In the manual studio, undo restores the earlier action budget; editing after undo replaces the abandoned continuation. Sources may be added during a studio session, and imports may specify bounded alternate rules. Recorded model runs instead freeze their materials and rules, keep rejected attempts, and have no undo command. A comparative study still needs repeated runs, a frozen evaluation protocol and blind judgments. Observable actions and explicit decision notes do not reveal private internal reasoning.

## Agent access

For the external-agent workflow, choose **Project menu → Agent access** in the studio for a copyable prompt. This button does not start a model automatically. That external agent needs image-reading and local HTTP access on this computer. The integrated **New run** flow instead calls OpenAI from the local server and applies commands locally; the remote model does not access localhost or the desktop.

Read [AGENT_PROTOCOL.md](./AGENT_PROTOCOL.md) for the action contract, or open `GET /api/help` for the machine-readable reference. Both manual and agent edits use the same authoritative engine. External agent edits appear in the browser automatically.

The action interface itself is model-neutral JSON. The starter workflow assumes image input; a text-only model would need descriptions and spatial annotations of the source material. [Observation and action interfaces](docs/MODEL_INTERFACE.md) documents the first experiment and current runner. [BACKLOG.md](BACKLOG.md) tracks additional providers, richer trajectory playback, and model comparisons.

## Validation

```sh
npm test
```

Tests cover polygon validity and overlap, finite material, immutable state, limits, source metadata, renderer fidelity, layering, atomic action batches, undo/redo and replay, persistence, image input validation, portable imports, and local-request protection. Runner checks cover native image delivery, credential handling, isolation, invalid batches, cancellation, time/context limits, recovery and exact exported replay. Integration tests use simulated providers and bind temporary loopback ports, which need permission in a sandbox that blocks local servers.

The browser workflow was also exercised for cutting, dragging, transforms, provenance, undo/redo, replay, mobile controls, and keyboard focus. Collection checks cover model/outcome filters, 50 simulated run summaries, pending/finished separation, and uncertain-network handling. Viewer checks cover exact fragment/source tracing, attributed text, archived seeds, partial output, and summary-only polling while working. Archive tests reproduce both original PNGs exactly.

## Project structure

```text
public/             Library, run setup, observer viewer, developer studio, local assets
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
