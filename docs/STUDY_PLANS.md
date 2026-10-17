# Study-plan contract

`public/study-plan.mjs` is the browser-safe, deterministic planner for version 1 studies. It does not read files, contact providers, inspect time, or use ambient randomness. A browser preview is advisory; a future study-storage API must call the same planner again on the server before freezing inputs.

`normalizeStudyDraft(draft)` is synchronous. It rejects unknown or missing fields and returns a detached normalized draft. The top-level schema is exactly:

```text
{version,label,kind,seed,commonBrief,prompts,models,packs,repetitions,profiles,notePolicy}
```

- `version` is `1`; `kind` is `calibration` or `primary`; `seed` is an unsigned 32-bit integer; `notePolicy` is `short-v1`.
- `prompts` contains 1–6 exact `{id,label,text}` records. A cell prompt is exactly the trimmed `commonBrief`, two newline characters, and the trimmed prompt `text`.
- `models` contains 1–8 exact `{id,label,provider,model}` records. `provider` is `openai`; routes must be explicit and unique. The module deliberately supplies no default model route.
- `packs` contains 1–8 exact `{id,label,catalogSnapshot,sourceIds,sourceHashes}` records. Each pack has 1–24 source IDs in model-visible order and an exact ID-to-SHA-256 map. Repeated source bytes within one pack are rejected.
- `repetitions` is 1–10. `profiles` contains exactly one v1 `{id,label,maxTurns,maxActions,maxPieces,maxOutputTokens,maxMinutes}` record. Resource bounds come from `public/run-spec.mjs`, shared with the runner.
- Definition IDs are unique lowercase slugs. Labels are display text and never supply prompt text or identity.

The exported defaults contain the three proposed subject prompts, two repetitions, six sources per reviewed pack, and the `standard` profile: 12 turns, 120 accepted actions, 24 usable pieces, 4,096 output tokens per request, and 10 minutes. Callers still have to construct every draft field and choose explicit provider routes and reviewed packs.

`planStudy(draft)` is asynchronous because it uses native Web Crypto SHA-256. It returns `{version,orderAlgorithm,normalizedDraft,dimensions,counts,packIdentities,cells,executionOrder}`. `cells` are sorted by stable cell ID. Each cell contains its factor tuple, resolved runner `spec`, ordered source selection, and two distinct pack digests:

- `sourcePackHash` commits the pack-hash algorithm, catalog snapshot, ordered source IDs, and their byte hashes.
- `contentOnlyPackHash` commits the content-hash algorithm and ordered byte hashes without source IDs or catalog identity.

A cell ID is `cell-` plus the full SHA-256 of canonical JSON for `{modelId,promptId,packId,repetition,profileId,notePolicy}`. It intentionally excludes labels, execution position, and resolved contents; its meaning is scoped to the eventual study manifest. Canonical objects use code-point-compatible key order for the ASCII schema, and arrays preserve order.

`executionOrder` lists every cell ID once. `offcut-study-order-v1` starts from cell IDs in code-point order and applies descending Fisher–Yates using the project’s uint32 Mulberry32 generator and rejection-sampled bounded indices. Changing that algorithm requires a new order identifier. Pack source order is never shuffled.

The committed [fixture](../tests/fixtures/study-draft-v1.json) uses only `fixture.invalid/...` routes. It cannot name a live model accidentally. To inspect its 36-row matrix without a server, credential, filesystem write, or provider call:

```sh
node --input-type=module -e "import {readFile} from 'node:fs/promises'; import {planStudy} from './public/study-plan.mjs'; const draft=JSON.parse(await readFile('./tests/fixtures/study-draft-v1.json','utf8')); const plan=await planStudy(draft); console.table(plan.executionOrder.map((cellId,index)=>{const cell=plan.cells.find(item=>item.cellId===cellId); return {index:index+1,cellId,...Object.fromEntries(['modelId','packId','promptId','repetition','profileId'].map(key=>[key,cell[key]]))};}));"
```
