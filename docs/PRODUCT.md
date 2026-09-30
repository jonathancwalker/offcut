# Offcut: observing model-made work

Product scope, September 30, 2026.

The user starts a bounded task, then inspects what the model made and how it assembled it. The product has two pages: **Library** and **Work**.

## Components and responsibilities

| Component | Surfaces | Behavior |
| --- | --- | --- |
| Library card | Finished image, app-owned work ID, requested model, provider, date, outcome | Opens a saved work. Model-authored titles do not name cards. |
| Library browsing | Search, model and outcome filters, 24-item pages | Keeps records comparable as the collection grows. Working records sit in a separate status row without live previews. |
| Run setup | Model connection and ID, current source set, fixed task and limits | Starts once and returns to Library. Task text and constraints are inspectable, not editable in this product flow. |
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

The product uses the current source inventory at launch, then the runner saves an immutable snapshot. Setup shows that current set; source selection/version pinning is a later component. The initial product task is fixed at 24 fragments, 120 actions, 12 turns, 10 minutes, and 4,096 output tokens per turn. Dollar caps remain unimplemented and are disclosed before launch.

The developer studio is retained at `/studio.html` outside primary navigation for environment development. The action engine and research tracks remain separate from this observer interface.

Next additions should fit these components: versioned source packs, additional model adapters, and public sharing of a work with its provenance and playback. A live editing workspace, social features, and scoring do not belong in this first observer slice.
