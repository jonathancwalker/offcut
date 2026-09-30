# Offcut: observing model-made work

Product scope, September 30, 2026.

The user chooses source material, a model, and a bounded budget, then inspects what the model made and how it assembled it. The product centers on three pages: **Library**, **New run**, and **Work**.

## Components and responsibilities

| Component | Surfaces | Behavior |
| --- | --- | --- |
| Library card | Finished image, app-owned work ID, requested model, provider, date, outcome | Opens a saved work. Model-authored titles do not name cards. |
| Library browsing | Search, model and outcome filters, 24-item pages | Keeps records comparable as the collection grows. Working records sit in a separate status row without live previews. |
| Run setup | Dedicated `/new.html` page with source selection and uploads, model connection and ID, budget presets and custom limits | Starts once and returns to Library. The open composition task stays fixed. Selected sources and exact limits are saved with the run. |
| Source picker | Image, name, selected state; available attribution and dimensions in details | Selects 1–24 images from the local inventory. Uploads join the inventory and can be selected for this run. Every run starts with fresh, uncut material. |
| Model connection | OpenAI key state, model ID, optional access check | Entered keys stay in server memory for the session. Authentication and model listing do not establish that a model supports image input. |
| Working record | Model, start time, Working status, Stop | Polls status only. Loads artwork and playback when the run ends. |
| Work viewer | Stable app-owned ID, model/date/outcome, saved canvas | Read-only. Completed, limited, failed, stopped, and archived works remain distinguishable. |
| Playback | Play/pause, previous/next action, scrubber, final frame | Replays accepted actions without changing the saved project. Human seed actions are labeled. |
| Fragment tray | Exact clipped source pixels, stable cut-order labels | Shows all saved cuts, including pieces not on the final canvas. At earlier steps, future cuts are dimmed. A fragment opens its original image with the exact cut highlighted. |
| Source tray | Frozen original images and cut counts | Includes unused source images. Details expose available dimensions, credits, license, and source link. |
| Model-authored panel | Model-supplied title and statement, explicitly attributed | Bounded text inside the viewer. Never becomes the page name, navigation, browser title, or system work ID. Default engine text is not attributed to the model. |
| Work record | Task, limits, provenance, usage when available, downloads | Secondary details are folded. Model notes are explicitly attributed and loaded on demand. |

## Identity and provenance

Run IDs are system-owned. The display label uses eight UUID hex characters; archived records use A001/A002. Full IDs remain in URLs and records. The run's requested model ID is surfaced; no missing model version is inferred.

The two early works are read-only archives, separate from runner records. A001 began with five human actions; A002 began with an empty canvas and a fresh agent context. Their exact model identifiers were not recorded. Their full source/project bytes and accepted history remain intact.

## Current boundaries

New run explicitly selects 1–24 source images. The launch request pins that selection, and the runner saves an immutable snapshot. Changed or missing selected material requires review rather than silently substituting other images. Uploads add to the shared local inventory, currently limited to 24 images and 24 MB of normalized image data. Full inventory management, including removal and replacement, remains deferred; earlier runs retain their saved sources.

The fixed task asks for an original collage with a model-chosen subject, composition, title, and short statement. There is no target image, editable creative prompt, or human canvas manipulation in this product flow. The source selection, requested model, and budget are explicit run variables.

| Budget | Fragments | Accepted actions | Turns | Time limit | Output tokens per turn |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small | 12 | 60 | 6 | 5 min | 4,096 |
| Standard | 24 | 120 | 12 | 10 min | 4,096 |
| Extended | 48 | 240 | 24 | 20 min | 4,096 |

Budget presets are maximum allowances. They do not promise a duration or quality level. Custom limits allow 1–64 fragments, 1–240 accepted actions, 1–40 turns, 1–60 minutes, and 256–16,384 output tokens per turn. A turn allows at most 12 actions, and rejected batches consume a turn. The folded work record shows the actual limits; absent archive metadata is not inferred.

Keys entered in setup remain in server memory until forgotten or the server restarts, with an optional server environment key as a fallback. Keys never enter browser storage, projects, or run exports. Dollar caps remain unimplemented and are disclosed before launch.

Starting a run uses a stable request identity. If the launch response is lost, retrying the same request returns the saved work when it already exists rather than starting another. A pending launch keeps its material and settings fixed until its outcome is resolved. This recovery does not retry failed model calls inside a run.

The developer studio is retained at `/studio.html` outside primary navigation for environment development. The action engine and research tracks remain separate from this observer interface.

Next additions should fit these components: versioned source packs, additional model adapters, and public sharing of a work with its provenance and playback. A live editing workspace, social features, and scoring do not belong in this first observer slice.
