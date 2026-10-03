# Batch runs

New run supports one work or a series grouped by model. Each model row has its own run count. The task and limits are shared across the batch; each work starts with a blank canvas and fresh material. The current adapter is OpenAI, and entered model IDs must support the existing image-input/action-output contract.

## Choosing materials

| Choice | Behavior |
| --- | --- |
| Same table every time | Every run receives the exact reviewed images, including any pins. |
| Fresh random images | Each run draws the requested number from the chosen pool. Requires no pins. |
| Keep pins, draw fresh extras | Pins appear in every supplied set; the requested extras are redrawn. Requires at least one pin and one extra. |

Pins guarantee that an image is supplied, not that the artist uses it. Within a set, images never repeat. Separate draws may reuse images or occasionally produce the same set.

**Explore** uses an independent draw for each planned run, including across model groups. **Compare models** reuses the same draw by run number: model A's run 1 and model B's run 1 receive the same images, then both run 2 entries receive the next set. Groups may have different counts; unmatched extra entries retain their own draw. With Same table, every entry receives the same images in either mode.

One group with a count of 1 keeps the ordinary single-run launch. Multiple runs open a review dialog: inspect each model/run's exact source images, then start the displayed number of runs. The dialog also shows the total maximum model-turn allowance. The draw is fixed before execution rather than being sampled as workers begin.

## Execution and limits

- Up to 8 model groups and 50 runs total; each group needs at least one run.
- One work executes at a time, in model-group order. Other launches are blocked while a batch is active.
- Existing per-run limits apply independently, including 1–24 source images and 24 MiB of source bytes. The batch may freeze at most 128 MiB of distinct source bytes.
- Completed works and works that reach their configured limits let the queue continue. A failed, stopped or interrupted child ends the batch; remaining entries are marked **Not run**.
- **Stop batch** records cancellation before stopping the active work. Closing the server records interruption. Restart reconstructs child outcomes without starting any more model calls.
- An uncertain launch retries the same full request and UUID. If accepted previously, it returns that batch, even after catalog changes or loss of the current API connection. Reusing the UUID with changed settings returns 409.

Model-turn, action, fragment, token and time allowances are ceilings. They are not dollar limits. Aggregate usage includes an explicit incomplete flag when a child has incomplete usage; costs remain unavailable. Provider requests are not automatically retried. Each child captures the current server connection when it starts, as ordinary runs do; changing or forgetting the connection affects later children. Stop the batch to cancel the queued work.

## Observing results

The batch page groups entries by model and retains the frozen material set for every planned work, including entries that never ran. Completed and partial work links open the existing read-only Work viewer with action playback and export. Running entries show status without exposing a live canvas. Library retains both active batches and batch history, plus a filter for a batch's finished works.

Matching images control one part of the task. Matching seeds do not make model outputs deterministic, and a batch alone is not a validated creativity measurement or controlled study.

## API and storage

`POST /api/batches` accepts:

```json
{
  "clientRequestId": "a UUID for this launch",
  "spec": {
    "prompt": "the shared task",
    "maxTurns": 12,
    "maxActions": 120,
    "maxPieces": 24,
    "maxOutputTokens": 4096,
    "maxMinutes": 10
  },
  "groups": [{"model": "model-a", "count": 3}, {"model": "model-b", "count": 3}],
  "mode": "explore",
  "materials": "pinned-random",
  "materialSelection": {"version": 1, "algorithm": "offcut-fisher-yates-v1", "seed": 313, "catalogSnapshot": "reviewed catalog SHA-256", "pinnedIds": ["one-image"], "candidateIds": ["another-image", "one-image"], "randomCount": 1},
  "sourceIds": ["one-image", "another-image"],
  "sourceHashes": {"one-image": "SHA-256", "another-image": "SHA-256"}
}
```

The placeholder UUID and hashes above must be replaced by real values. Source IDs/hashes describe the reviewed base draw. `mode` is `explore` or `compare`; `materials` is `same`, `random` or `pinned-random`. The browser and server share `public/batch-plan.mjs`. Seed derivation has its own version, `offcut-batch-seeds-v1`: the first draw preserves the reviewed seed; subsequent slots add an odd increment modulo 2³². Explore uses the global entry index; Compare uses the within-group run index; Same always uses slot 0. This produces distinct seeds for distinct slots, with no promise of distinct image sets.

Before any model call, the server validates the complete plan and every selected asset, then stores `.data/batches/<batch-id>/batch.json` and deduplicated, hash-addressed source files under `assets/`. The record includes the shared specification, model groups, mode, source/candidate manifests, seed policy, each entry's seed and ordered image IDs, and immutable child launch identities. Collected-image provenance remains attached. Credentials are not stored. Source changes require review before a new batch is accepted; accepted batches use frozen bytes even if the discovery library is removed.

Each created child remains a normal `.data/runs/<run-id>/` record, with `{id,groupIndex,runIndex}` batch provenance in its summary and authoritative `run_started` event. Indices are zero-based in the API. Recovery uses the precommitted child launch token to handle a crash between child creation and saving its ID on the batch. It never automatically resumes the queue.

| Route | Result |
| --- | --- |
| `GET /api/batches` | Compact batch summaries and launch receipts |
| `GET /api/batches/:id` | Frozen plan, per-entry outcomes and source manifests |
| `GET /api/batches/:id/sources/:sourceId` | Integrity-checked frozen image bytes |
| `POST /api/batches/:id/stop` with `{}` | Stop the batch and retain its complete plan/history |

`finishedRuns` counts actual terminal children; it excludes queued and Not run entries. `completedRuns` counts successful completion only. A batch can finish its queue while some children reached limits, so inspect child outcomes when analyzing results. Resume, parallel workers, per-group budgets, batch archives and additional providers remain later extensions.
