# Offcut backlog

**Current product direction — September 30, 2026:** an observer interface with Library and read-only Work pages. Model setup uses a fixed task and constraints; completed output has playback, fragment/source trays, and explicitly attributed model writing. The two early works are included as truthful archives. See [the component map](docs/PRODUCT.md). Earlier proposals below remain research/expansion ideas, not additions to the current minimal interface.

The studio, two exploratory demonstrations and the first OpenAI experiment runner are implemented. Status notes below distinguish completed foundations from further work.

Experiment 002 adds an independent fresh-context demonstration with its prompt, observations, action events and audit. The [product roadmap](ROADMAP.md) sets the delivery sequence: experiments first, a small public preview in parallel, then a published pilot and broader community features. [The research plan](docs/RESEARCH_PLAN.md) defines proposed studies, with an accepted [numerical representation track](docs/REPRESENTATION_TRACK.md). The public gallery has not been deployed.

## Agreed first comparison

Decision: September 27, 2026. Use multimodal models with image input and text/JSON action output. Give each model the same source materials, initial canvas, observation policy, command vocabulary, and experiment budget. The environment renders the artwork; models do not need image generation or desktop control. Text-only assisted experiments are deferred. The first runner is in place; additional providers and controlled multi-model comparisons follow.

## Agent trajectory playback

Status: first slice implemented September 28, 2026: accepted-action playback, model activity, errors and complete run exports. Synchronized observation images, before/after detail, speed controls and turn stepping remain.

Extend the existing canvas replay into a view of an agent's observable choices. The current scrubber and play/pause controls already reconstruct each accepted action, including individual actions submitted together in a batch.

Acceptance criteria:

- An append-only run log records each observation, model request and returned output, explicitly emitted short decision note, action attempt, validation response, and resulting state reference.
- A viewer synchronizes the canvas with the exact source images and canvas snapshots made available to the agent at that point.
- Each step can show its before/after canvas, affected fragment, original source polygon, action arguments, result or error, and remaining budget.
- User and agent events have distinct labels. Batch boundaries and multiple actions per model turn remain visible.
- Failed attempts, undo/redo, and abandoned continuations remain in the run log even if the editable project's retained history changes.
- Play, pause, scrub, step backward/forward, and speed controls work without changing the live composition. Offer both action steps and model-turn steps.
- Store provider, model identifier, supplied configuration, prompt/protocol version, source hashes, rules, timestamps, and usage/cost information when the provider supplies it. Mark unavailable fields explicitly.
- Export a portable run bundle containing deduplicated source images, observation images, events, and final artwork. Exclude credentials from all run artifacts.
- Decision notes are deliberate, short explanations emitted for the record. Do not infer hidden reasoning from placement events or label a reconstruction as a captured thought process.

Depends on the experiment runner and event schema below. Basic artifact playback can be prototyped before integrating multiple providers.

## Model-neutral experiment runner

Status: first OpenAI adapter and local runner implemented September 28, 2026, with setup/key connection, isolated runs, frozen sources, native image observations, append-only events, limits, stop, export and interrupted-run recovery. Live paid inference validation remains separate from automated fixture tests. Additional adapters, run queues, resume, observation aids and dollar spending controls remain.

Include the provider/key connection screen, a simple materials/models/rules setup form, isolated runs, and budget/stop controls described in the roadmap.

- Separate the observation format from the action vocabulary; reuse the existing authoritative engine.
- Add a compact observation endpoint or runner projection that omits embedded image data URLs from textual state. Attach actual images through the provider's native image-input mechanism when supported.
- Use provider adapters for request formatting and response parsing. Support ordinary JSON output as well as structured tool calls; do not require a model to write or execute code.
- Keep the runner on the same machine as the studio. It calls model providers and applies returned commands locally; the remote model does not need direct access to localhost or the desktop.
- Freeze source inventory, initial project, rule limits, prompt, action/batch limits, and observation policy for each recorded experiment.
- Record all attempts, errors, retries, observations, and returned outputs. Charge effort independently of undo and retained canvas history.
- Add optional coordinate grids, consumed-area overlays, and fragment IDs to observation images only. Keep them out of the artwork and record which aids each run received.
- Implement the agreed visual observation track first. Defer a text-only assisted track; if introduced later, use fixed descriptions and spatial annotations and version and log any captioning or segmentation assistance.

See [the interface design](docs/MODEL_INTERFACE.md) for the current implementation and proposed contract.

## Multiple works and model comparison

Status: research backlog.

- Keep separate saved runs rather than reusing one mutable worktable as the run database.
- Run multiple independent attempts per model and material set, with shared starting conditions.
- Support different source packs and optionally the same pack with varied prompts or constraints.
- Compare native vision and text-assisted conditions separately unless the same assistance is supplied to both.
- Gather blind human comparisons with separate questions for visual coherence, reinterpretation of material, surprise, and relationship between artwork and stated intention.
- Publish uncertainty and examples before presenting an aggregate leaderboard as a validated measure of creativity.

## Source library and public gallery

Status: a 21-image credited starter pack and an on-demand Cleveland Museum of Art CC0 collector are implemented. The collector builds a separate local catalog with provenance, duplicate detection, download budgets, a preview gallery and resume checkpoints. See [collection commands](docs/SOURCE_COLLECTION.md). Connecting this larger catalog to the run picker and publishing the gallery remain.

- Build a searchable, attributed discovery catalog and separate immutable experimental packs with exact source hashes.
- Replace the shared 24-image inventory as the picker's source with the disk-backed discovery catalog; freeze only the selected material into each run.
- Begin with curated eligible museum/archive images; expand bulk ingestion and semantic search after the run and publication formats work.
- Publish an early browsable gallery from deliberately selected demo/run bundles, with source sheets and existing action replay.
- Add filters for model/provider, pack, condition, authoring mode, date, constraints and status; add blind browse, comparisons and exact-step links.
- Support HF-hosted vision-language models and compatible self-hosted endpoints through the same adapter contract, validating actual image support.
- Add community accounts, private drafts, validated uploads, publication previews, collections, attribution and reporting/removal controls after the first public showcase.
- Keep public-gallery engagement separate from controlled research ratings, and distinguish imported artifacts from platform-recorded runs.

## Quantitative representation research

Status: accepted parallel research track, September 28, 2026; measurement computation is not implemented. See [the track specification](docs/REPRESENTATION_TRACK.md) for frozen visual embeddings, construction descriptors, within-pack novelty/diversity, arrangement controls and held-out human validation before learning a new space.
