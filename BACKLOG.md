# Offcut backlog

The studio and Experiment 001 are implemented. Items below are proposed work; they are not model-launcher or benchmark features that already exist.

## Agent trajectory playback

Status: backlog. Requested September 27, 2026.

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

Status: proposed next foundation.

- Separate the observation format from the action vocabulary; reuse the existing authoritative engine.
- Add a compact observation endpoint or runner projection that omits embedded image data URLs from textual state. Attach actual images through the provider's native image-input mechanism when supported.
- Use provider adapters for request formatting and response parsing. Support ordinary JSON output as well as structured tool calls; do not require a model to write or execute code.
- Keep the runner on the same machine as the studio. It calls model providers and applies returned commands locally; the remote model does not need direct access to localhost or the desktop.
- Freeze source inventory, initial project, rule limits, prompt, action/batch limits, and observation policy for each recorded experiment.
- Record all attempts, errors, retries, observations, and returned outputs. Charge effort independently of undo and retained canvas history.
- Add optional coordinate grids, consumed-area overlays, and fragment IDs to observation images only. Keep them out of the artwork and record which aids each run received.
- Start with the visual observation track. Add an explicitly labeled text-only assisted track using fixed descriptions and spatial annotations; version and log any captioning or segmentation assistance.

See [the interface design](docs/MODEL_INTERFACE.md) for the current implementation and proposed contract.

## Multiple works and model comparison

Status: research backlog.

- Keep separate saved runs rather than reusing one mutable worktable as the run database.
- Run multiple independent attempts per model and material set, with shared starting conditions.
- Support different source packs and optionally the same pack with varied prompts or constraints.
- Compare native vision and text-assisted conditions separately unless the same assistance is supplied to both.
- Gather blind human comparisons with separate questions for visual coherence, reinterpretation of material, surprise, and relationship between artwork and stated intention.
- Publish uncertainty and examples before presenting an aggregate leaderboard as a validated measure of creativity.
