# Study implementation

Offcut Studies are frozen matrices. The planner resolves the reviewed draft into immutable cells, source IDs, source hashes, prompts, model routes, repetitions and a deterministic execution order. The scheduler reads that manifest and its durable state entries; it does not reconsult the live catalog while running.

## Offline analysis

Study analysis is a read-only operation over a completed or partially completed study directory and its linked run records. It does not import the server, initialize providers, make model calls, or write to `.data` unless the caller explicitly selects an output directory there.

```sh
npm run studies:analyze -- \
  --data-root /path/to/.data \
  --study study-00000000-0000-4000-8000-000000000000 \
  --out /path/to/report
```

The output directory must be new and outside the input data root. It contains `report.json` (cell statuses, evidence and issues), `measurements.json` (machine-readable composition measurements), `runs.csv` (one row per planned cell), `recoveries.csv` (rejected batch recovery evidence), and `summary.md` (human-readable report). Missing, unsettled, skipped and invalid cells remain in the planned-cell denominator; they are never silently dropped.

The CLI reads `studies/<study-id>/manifest.json`, `state.json`, frozen source assets, and linked `runs/<run-id>/run.json`, `events.jsonl`, and `project.json`. It verifies hashes, accepted action replay, frozen source identity, run links, event ordering and terminal status. A changed record during analysis causes the operation to fail so the report cannot mix snapshots.

## Measurements

Final composition is rasterized at the native canvas resolution. Alpha-weighted visible pixels are attributed front-to-back, so canvas clipping, transparent pixels, holes and occlusion affect coverage and source contribution. The report records usable and placed pieces, contributing pieces, source shares, normalized Shannon material breadth, consumed source area, placement values, and accepted action mix. A piece contributes when its visible area is at least one equivalent pixel.

Material reuse is the Jaccard overlap of contributing source IDs between two cells in the same frozen source pack. It is a dependent within-pack summary and does not increase the number of independent observations.

## Evidence and interpretation

Decision notes are counted only when present in a recorded model output or accepted batch result. Returned model IDs, requested and returned turns, rejected turns, termination reasons and recorded cost completeness are reported separately from composition measurements. The report describes recorded material use and composition; it does not score artistic merit or infer hidden reasoning.

The run-trace viewer uses the same persisted event and project records and links each displayed action to its evidence. It is a review surface for saved runs and does not alter run data.
