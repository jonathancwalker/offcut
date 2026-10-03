# Offcut backlog

**Current status — October 2, 2026, after PR #9:** the Library, fixed-task New run flow and read-only Work pages are implemented. The OpenAI runner supports isolated saved runs, frozen sources, native image observations, append-only events, limits, stop, export and recovery. Work pages have accepted-action playback, speed controls, GIF export, brief fragment outlines, source/fragment inspection and explicitly attributed model writing. Physical trimming preserves retained pieces, usable offcuts, holes and lineage. Three early works are included as truthful archives. See [the component map](docs/PRODUCT.md).

The [product roadmap](ROADMAP.md) prioritizes library curation after the material-picker foundation, with a static public gallery preview in parallel; additional providers, comparison queues and trajectory research follow. The public gallery has not been deployed. This is an implementation proposal, not authorization for a paid run campaign. The detailed [research plan](docs/RESEARCH_PLAN.md) and [representation track](docs/REPRESENTATION_TRACK.md) remain longer-term proposals. Earlier live-canvas, prompt-editing and human-intervention ideas do not expand the next observer UI milestone.

## Materials and run setup

Status: first picker implemented on this branch. It combines the 21 bundled starter images and 12 locally collected Cleveland images as of October 2. **120–200 varied images is the initial curation target**, not the current collection size. The collector already provides provenance, duplicate detection, download budgets, preview and resume checkpoints; see [collection commands](docs/SOURCE_COLLECTION.md).

- [x] Connect the disk-backed catalog with paginated thumbnails, search, collection filters and an explicit full/filtered random pool. Keep catalog capacity separate from the studio inventory and per-run limit of 24 images/24 MiB; load only chosen source bytes into a run.
- [x] Combine pins with an additional random count, including manual-only and random-only choices. Require at least one image overall. Inclusion does not require the artist to use an image.
- [x] Exclude pins from the draw, prevent duplicates, surface insufficient-pool/count/byte-limit errors, and preserve pins through reshuffles.
- [x] Review pinned/random trays and attribution; freeze exact ordered IDs, bytes and hashes. Preserve the reviewed draw through launch retries and draft restoration.
- [x] Record the versioned recipe, seed, catalog digest and candidate ID/hash manifest. Frozen selected bytes remain authoritative for replay.
- [ ] Curate toward 120–200 images across photography, illustration, printed pages, maps, diagrams, textiles, objects and dense scenes.
- [ ] Add individual pool exclusions, reusable named material sets and pack management as follow-on controls.

In parallel, publish a small static gallery from deliberately selected archived/recorded bundles. Additional provider routes and repeat/comparison queues, then trajectory research and a scoped pilot, follow the materials milestone. HF/self-hosted routes, community publication and learned embeddings remain later work.

## Agreed first comparison

Decision: September 27, 2026. Use multimodal models with image input and text/JSON action output. Give each model the same source materials, initial canvas, observation policy, command vocabulary, and experiment budget. The environment renders the artwork; models do not need image generation or desktop control. Text-only assisted experiments are deferred. The first runner is in place; additional providers and controlled multi-model comparisons follow.

## Agent trajectory playback

Status: accepted-action playback, action stepping/scrubbing, speed controls, fragment outlines, GIF export, source/fragment inspection, attributed model activity, errors and complete run exports are implemented. Synchronized observation images, before/after detail, model-turn stepping and side-by-side trajectory comparison remain.

Extend the existing canvas replay into a view of an agent's observable choices. The current scrubber and play/pause controls already reconstruct each accepted action, including individual actions submitted together in a batch.

Retained trajectory-viewer criteria, including shipped foundations and future extensions:

- An append-only run log records each observation, model request and returned output, explicitly emitted short decision note, action attempt, validation response, and resulting state reference.
- A viewer synchronizes the canvas with the exact source images and canvas snapshots made available to the agent at that point.
- Each step can show its before/after canvas, affected fragment, original source polygon, action arguments, result or error, and remaining budget.
- User and agent events have distinct labels. Batch boundaries and multiple actions per model turn remain visible.
- Failed attempts, undo/redo, and abandoned continuations remain in the run log even if the editable project's retained history changes.
- Play, pause, scrub, step backward/forward, and speed controls work without changing the live composition. Offer both action steps and model-turn steps.
- Store provider, model identifier, supplied configuration, prompt/protocol version, source hashes, rules, timestamps, and usage/cost information when the provider supplies it. Mark unavailable fields explicitly.
- Export a portable run bundle containing deduplicated source images, observation images, events, and final artwork. Exclude credentials from all run artifacts.
- Decision notes are deliberate, short explanations emitted for the record. Do not infer hidden reasoning from placement events or label a reconstruction as a captured thought process.

Build on the existing experiment runner and event schema. Public artifact playback can ship before integrating multiple providers.

## Model-neutral experiment runner

Status: OpenAI is the one implemented provider, with setup/key connection, isolated runs, frozen sources, compact textual state plus native image observations, append-only events, limits, stop, export, interrupted-run recovery and launch-retry protection. Physical trimming is available under the current protocol. Additional adapters, run queues, continuation/resume, optional observation aids and dollar spending controls remain. Existing exploratory paid runs are evidence of operation, not a controlled comparison.

Include the provider/key connection screen, a simple materials/models/rules setup form, isolated runs, and budget/stop controls described in the roadmap.

- Separate the observation format from the action vocabulary; reuse the existing authoritative engine.
- Preserve the existing compact runner projection that omits embedded image data URLs from textual state, with images attached through the provider's native image-input mechanism.
- Use provider adapters for request formatting and response parsing. Support ordinary JSON output as well as structured tool calls; do not require a model to write or execute code.
- Keep the runner on the same machine as the studio. It calls model providers and applies returned commands locally; the remote model does not need direct access to localhost or the desktop.
- Freeze source inventory, initial project, rule limits, prompt, action/batch limits, and observation policy for each recorded experiment.
- Record all attempts, errors, retries, observations, and returned outputs. Charge effort independently of undo and retained canvas history.
- Add optional coordinate grids, consumed-area overlays, and fragment IDs to observation images only. Keep them out of the artwork and record which aids each run received.
- Implement the agreed visual observation track first. Defer a text-only assisted track; if introduced later, use fixed descriptions and spatial annotations and version and log any captioning or segmentation assistance.

See [the interface design](docs/MODEL_INTERFACE.md) for the current implementation and proposed contract.

## Multiple works and model comparison

Status: isolated saved runs are implemented; repeat/comparison queues and controlled studies remain proposed work after materials and run setup.

- Build queues on the existing separate saved runs and frozen specifications.
- Run multiple independent attempts per model and material set, with shared starting conditions.
- Support different source packs and optionally the same pack with varied prompts or constraints.
- Compare native vision and text-assisted conditions separately unless the same assistance is supplied to both.
- Gather blind human comparisons with separate questions for visual coherence, reinterpretation of material, surprise, and relationship between artwork and stated intention.
- Publish uncertainty and examples before presenting an aggregate leaderboard as a validated measure of creativity.

## Source library and public gallery

Status: the starter pack, on-demand Cleveland Museum of Art CC0 collector and catalog-to-picker integration are implemented. A larger varied collection is next; the static public preview is a parallel priority. Public publishing and comparison flows remain unimplemented.

- Extend the searchable, attributed catalog into reusable experimental packs with exact source hashes.
- Begin with curated eligible museum/archive images; expand bulk ingestion and semantic search after the run and publication formats work.
- Publish an early browsable gallery from deliberately selected demo/run bundles, with source sheets and existing action replay.
- Add filters for model/provider, pack, condition, authoring mode, date, constraints and status; add blind browse, comparisons and exact-step links.
- Support HF-hosted vision-language models and compatible self-hosted endpoints through the same adapter contract, validating actual image support.
- Add community accounts, private drafts, validated uploads, publication previews, collections, attribution and reporting/removal controls after the first public showcase.
- Keep public-gallery engagement separate from controlled research ratings, and distinguish imported artifacts from platform-recorded runs.

## Quantitative representation research

Status: accepted research track, September 28, 2026; measurement computation is not implemented. Trajectory analysis can build on recorded observations, stated intentions, action attempts and visible outcomes after the materials/setup milestone. These records support hypotheses about agent behavior; transfer beyond collage needs a separate cross-domain test. See [the track specification](docs/REPRESENTATION_TRACK.md) for frozen visual embeddings, construction descriptors, within-pack novelty/diversity, arrangement controls and held-out human validation. Learning a new representation remains later work.
