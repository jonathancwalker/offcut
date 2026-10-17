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

The home page is the **Library**. It includes recorded model runs and three archived works. Cards show an app-owned work ID, model, provider, date, and outcome. Search by work ID/model/provider, filter by model or outcome, and browse in pages of 24.

1. Open **New run** at `/new.html` from Library. Browse the materials, pin any images you want included, and choose how many additional images to draw at random. Draw from the whole collection or the current search/collection filters. **Reshuffle** changes only the random portion. Review the pinned and drawn images before starting; the model receives exactly this selection, with fresh material for the run.
2. Connect an OpenAI API key and choose an image-capable model that supports the Responses API. A key entered here stays in server memory until forgotten or the server restarts; keys are not saved to browser storage, projects, or records. An `OPENAI_API_KEY` environment variable is also supported. **Check access & load models** lists accessible model IDs; listing alone does not verify image support.
3. Choose **Small**, **Standard**, or **Extended**, or customize the limits. Inspect the fixed task and start the run. The model gets a separate blank canvas and an immutable snapshot of the selected images.
4. Return to Library. Working records show status; their work and playback become available once the run ends. A working record also offers Stop. If a start request has an uncertain outcome, retry that same request rather than starting again: the server returns its existing work when one was already created.
5. Open a finished work to replay accepted actions. Switch between **Fragments** and **Sources**. Select a fragment to inspect exactly where it came from. Model-authored titles/statements are explicitly labeled inside the viewer and never become system record names.

The task stays open: create an original collage from the supplied material, choose its subject and composition, and supply a title and short statement. There is no target image or editable creative prompt. The user chooses the model, source material, and limits; the model makes the work.

For a series, set a run count beside the model or **Add another model** with its own count. Choose **Explore** for independent draws or **Compare models** for matching image sets by run number. Keep the same table throughout, draw fresh images, or hold pins fixed while drawing fresh extras. **Review runs** shows each planned set and the total turn allowance before launch. Batches run sequentially; their own page keeps model groups, frozen materials, outcomes and links to playback. Library includes batch history and filtering. [Batch behavior and API](docs/BATCHES.md) covers limits, cancellation and recovery.

| Budget | Fragments | Accepted actions | Model turns | Time limit | Output tokens per turn |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small | 12 | 60 | 6 | 5 min | 4,096 |
| Standard | 24 | 120 | 12 | 10 min | 4,096 |
| Extended | 48 | 240 | 24 | 20 min | 4,096 |

These are ceilings, not promised duration, fragment count, or quality. Custom limits allow 1–64 usable fragments, 1–240 accepted actions, 1–40 turns, 1–60 minutes, and 256–16,384 output tokens per turn. Each turn permits up to 12 actions; rejected batches still consume a turn. Cutting and placing a fragment require separate actions. Trimming costs one action and divides a piece into retained fragments and usable offcuts in the tray. Every resulting fragment counts toward capacity; its retired parent remains in history without taking a slot. A trim that would exceed capacity is rejected in full.

The material browser combines studio images and the disk-backed collected library, with paginated thumbnails, search, collection filters and full-image attribution. The library can grow beyond 24 images; each run remains bounded to 1–24 images and 24 MiB of source data. Pinning guarantees that material is supplied, but does not require the artist to use it. Zero pins gives a random-only draw; zero random images gives a manual selection. The random pool excludes pins and never repeats an image.

**Add images** uploads to the shared studio inventory, which still holds at most 24 images and 24 MiB of normalized PNG data. Library images do not consume those upload slots. Full source removal/replacement is deferred. Changed or missing material must be reviewed before launch. Drafts preserve the current draw; an uncertain launch retries the original request and never silently reshuffles.

Artwork is read-only; playback never changes the record. Failed/stopped/limited runs retain their saved output and honest outcome labels. The folded work record includes the task and limits actually used, omitting information that was not recorded for older archives.

The Work viewer plays at 2× by default. Choose 0.5×, 1×, 2×, 4×, or 8× beside the playback controls; changes apply while playing and the browser remembers your preference. Each frame finishes loading before playback advances, so image-rendering time can limit the fastest rates.

When a visible fragment is placed, trimmed, transformed, or reordered, a thin warm outline briefly marks its actual boundary after the frame is ready. Later pieces mask the outline. Seeking in either direction marks the destination action shown in the caption; source cuts, text-only changes, removals, hidden fragments, and the final view remain unmarked. Reduced motion uses a static outline for the same 750 ms instead of a fade. This is temporary viewer chrome and never appears in saved projects or PNG, SVG, or GIF exports. Trimmed parents remain available to inspect in the fragment history, alongside their retained children and offcuts.

The three archived works are read from `experiments/001/final-project.json`, `experiments/002/final-project.json`, and `experiments/003/final-project.json`. Exact model identifiers were not captured. A001 includes five human seed actions; A002 began with a blank canvas and fresh agent context. A003 used another fresh Codex subagent and six images drawn uniformly at random without replacement from the 21-image collection, with limits of 24 fragments and 120 accepted actions. Its client allowed at most 12 attempted batches of 12 actions; these were not model turns, and no time or output-token cap was enforced. Archive playback preserves those distinctions. Legacy `/experiments.html?run=…` links redirect to the new viewer.

In Work, choose **Download → Playback GIF** to share the recorded making of an archived or finished run, including partial saved work. The GIF loops from a blank canvas through every action up to the saved cursor, including seed actions, with 650 ms per step and a 2.5-second final hold. It exports the saved sequence regardless of the current playback position. GIF uses a reduced color palette; **Final image** keeps the full-resolution PNG.

GIF export runs locally using the existing renderer and Sharp, without model calls, API keys, uploads, or changes to projects, source images, or action records. The longest edge is at most 640 pixels, reduced further for long histories to keep the RGB timeline within 64 MiB; aspect ratio is retained to whole pixels. Source images used in the saved sequence may total up to 32 megapixels decoded (20 megapixels per image). Source decoding and encoding need additional memory beyond the timeline. One export runs at a time in a separate process, with a two-minute deadline. Use **Cancel GIF export** in the download menu to stop it, or retry from the same menu after an error. The GET endpoints `/api/archives/:id/render.gif` and `/api/runs/:id/render.gif` accept no query options and return an attachment; running works return 409.

Runs save under `.data/runs/`. Each has frozen sources and their hashes, a specification, append-only events, image observations, model outputs, and replayable accepted actions. New picker launches also record pins, random count, seed, versioned sampling algorithm, reviewed catalog digest, and candidate IDs/hashes. Selected library sources retain their collection and bounded provenance in the run manifest. Earlier runs keep their original records. Past source/canvas observations are stored by hash; a full run export includes their bytes. Model calls use native image inputs with images resized to at most 1536 pixels on their longest edge. Cut coordinates remain in original source pixels. Prior textual context is retained; past image attachments are not resent.

Limits cover model turns, accepted actions, fragments, output tokens per request and elapsed time, plus a fixed textual-context ceiling. Usage is recorded when returned. **Dollar estimates and spending caps are not implemented yet**; a cancelled or failed request may still be billed, and incomplete usage is labeled. Provider network failures stop the run without automatic retries. Retrying an uncertain launch uses the same request identity to avoid creating a second run; it does not repeat model calls within an existing run. Malformed or invalid action batches remain recorded and can be corrected within the remaining turn budget. Restarting the server marks unfinished runs interrupted; it does not automatically resume paid requests.

The first adapter supports OpenAI. Sequential batches and model-group comparisons are implemented; additional providers, richer observation playback, public publishing and measurement computation remain on the roadmap. Tests use simulated providers; a live paid inference run is a separate validation step.

## Analyze saved runs

```sh
npm run runs:analyze
```

This reads terminal API runs from `.data/runs/` and writes `summary.md` and `report.json` into a new timestamped `.data/analysis/` folder. It runs offline, leaves saved works untouched, skips active records, and reports unreadable records separately. Use `-- --runs DIRECTORY --out NEW_DIRECTORY` to choose other locations; existing output folders are never overwritten. Exit code 2 means unreadable records or detected record-consistency issues.

The report separates proposed and accepted actions, rejected batches, decision notes, observations, completion reviews, and usage completeness. It checks recorded event relationships and referenced asset hashes, and flags differing material packs or protocols before comparison. These are observable behavior and record checks, not creativity scores or verification of a model's explanations.

## Bundled source collection

The app includes **21 bundled source images**: the original three plus 18 natural-history plates, archival photographs, a portrait, a still life, maps, lettering, textile designs, and mechanical diagrams. New installations load them automatically. A fresh New run draft draws six images from the available collection, or all available images when fewer than six exist. Existing saved selections become pinned images when first opened in the new picker.

For an existing installation, start Offcut and run `npm run sources:import`. This adds missing bundled images through the source API without clearing artwork or history. It compares image hashes, so it can be run again after interruption without re-adding confirmed images. The current collection limit remains 24 images / 24 MB; the bundled collection uses about 20 MB after PNG normalization.

Every added image has a collection link, credit, and recorded reuse status. [Source credits](public/sources/CREDITS.md) and the [curated catalog](public/sources/curated/catalog.json) include the original downloads and exact image hashes. Added copies preserve the full image at up to 900 pixels on their longest edge; there are no generated assets, filters, or crops. Rights labels remain specific: public domain, CC0, or the Library of Congress’s “no known restrictions” advisory.

To collect more images, run `npm run sources:collect -- --limit 100 --topics "birds,botanical,textile,architecture"`. The first collector uses Cleveland Museum of Art's image-level CC0 records, preserves provenance, skips duplicates, and checkpoints interrupted jobs. Refresh New run to browse committed additions, or preview the collection at `.data/source-library/index.html`; continue a paused job with `npm run sources:collect -- --resume`. The collected catalog is local data, not bundled in Git. See [collection commands and limits](docs/SOURCE_COLLECTION.md).

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

The default canvas is 1000 × 1200 pixels with a plain paper-colored background. Every artwork fragment refers to an original raster image plus an outer polygon and any holes in that image's coordinates. The renderer clips and transforms that source; it does not generate artwork pixels, paint, recolor, blend, add typography, or stretch non-uniformly. Rotation and resizing use normal image resampling, so this is provenance-preserving composition rather than a promise of identical output RGB values after resampling.

- Standard runs and the developer studio default to **24 usable fragments** and **120 successful actions**. Hidden pieces and offcuts count; retired trim parents do not. Other model runs use their selected budget.
- New runs and canvases accept simple source-cut polygons and trim masks with 3–64 corners, at least 100 square source pixels, fully inside a source image. Existing projects, runs, and archives retain their saved vertex limits.
- Source-cut boundaries may touch, but their interiors cannot overlap on the same source.
- Cutting consumes material even while the fragment is in the tray. Removing a piece does not make the original source region available again.
- A trim mask divides an existing piece's actual material. Every connected retained part stays in place with the parent's visibility, and every connected offcut becomes a usable piece in the tray. Masks can cross the parent's boundary or holes without adding material. Each child records its parent and whether it is retained material or an offcut; the old parent becomes unusable.
- Trims can produce holes and multiple children. Generated pieces preserve small scraps and complex boundaries beyond the input area/vertex limits. An 8192-vertex limit across all output boundaries rejects an excessively complex trim as a whole. Nothing is silently discarded, and an offcut can be placed or trimmed again.
- Uniform scale: 15–300%. Explicit piece centers stay on the canvas, but edges may extend beyond it and are clipped by the final canvas. A trim may derive an off-canvas center to preserve the retained pixels' position.
- Each successful cut, trim, placement, transform, reorder, removal, or description counts as one action. A rejected action changes nothing. A submitted batch either succeeds completely or changes nothing.
- A model must receive the latest rendered canvas before confirming completion. Edits submitted with a finish request stay accepted, then the model gets another look and may confirm or revise. This uses its existing turn budget; exhausting that budget leaves partial work. New run records use policy version 3, adding physical trims and usable offcuts to version 2's final-review policy; earlier records preserve their original policy.

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

The browser workflow was also exercised for cutting, dragging, transforms, provenance, undo/redo, replay, mobile controls, and keyboard focus. Collection checks cover model/outcome filters, 50 simulated run summaries, pending/finished separation, and uncertain-network handling. Viewer checks cover exact fragment/source tracing, attributed text, archived seeds, partial output, and summary-only polling while working. Archive tests reproduce the preserved PNGs exactly.

For the playback outline browser regression, start a separate local server with `PORT=4322 npm start`, then run `node tests/work-playback.browser.mjs` with Playwright installed (or the bundled Codex runtime). It checks A003 geometry, decoded-frame races, reduced motion, responsive alignment, pause/seek/retry and persisted-page restoration, plus unchanged image pixels and saved data. Screenshots and results are written to ignored `test-results/`. Set `OFFCUT_TEST_URL` to use another loopback port.

## Project structure

```text
public/             Library, run setup, observer viewer, developer studio, local assets
lib/engine.mjs      Pure state transitions and geometry validation
lib/render.mjs      Source-preserving SVG and PNG rendering
lib/gif.mjs         Bounded playback GIF rendering and cancellable export process
lib/runs.mjs        Isolated model loop, observations, durable events and recovery
lib/archives.mjs    Read-only replay of the three archived works
lib/providers.mjs   Private provider connections and OpenAI Responses adapter
server.mjs          Local HTTP API and persistent action history
tests/              Engine, renderer, and API integration checks
docs/               Interface design and experiment architecture
experiments/        Saved artworks, source projects, prompts, actions and audits
```

Experiment checkpoint state copies and per-stage portable projects are kept locally but ignored by Git because they repeat embedded images. The original and final portable projects, stage commands, API log, PNG checkpoints, final SVG, and readable trajectory are versioned.

Starter image credits and rights records are in [public/sources/CREDITS.md](./public/sources/CREDITS.md). Bundled font licenses are in `public/fonts/`. Imported sources retain the attribution supplied with them.
