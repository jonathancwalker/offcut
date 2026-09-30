# Collecting source images

Offcut has an on-demand collector for building a larger local image library. The first provider is the [Cleveland Museum of Art open-access API](https://openaccess-api.clevelandart.org/). It accepts records only when the museum marks the **image** as CC0; open metadata alone is not sufficient.

From the project directory, run:

```sh
npm run sources:collect -- --limit 100 --topics "birds,botanical,textile,architecture"
```

This asks for up to 100 new, unique images. Topics are visited in rotation, so a single topic does not fill the entire batch before the others are searched. Results follow the museum's search ordering; this is not random or representative sampling of its collection. Some topics may have few eligible results.

The command runs independently of the app server and does not need an account, provider key, or model call. It is a manual job, with no recurring schedule.

## Limits and resuming

```sh
npm run sources:collect -- --limit 100 --max-mb 250 --max-edge 1000 --topics "birds,textile,portrait,architecture"
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--limit` | 50 | Maximum new images saved by this job; 1–1,000. |
| `--topics` | birds, botanical, architecture, textile, portrait, poster, map, mechanical | Comma-separated searches; 1–16 unique topics. |
| `--max-mb` | 250 | Image download budget in MiB; 1–2,048. Counts duplicate and rejected image downloads too. Metadata is separate. |
| `--max-edge` | 1,000 | Longest saved image edge in pixels; 256–2,048. Preserves the full image without upscaling. |
| `--directory` | `.data/source-library` | Destination library; repeated jobs add to its catalog. |
| `--resume` | — | Continue the most recently interrupted job with its original settings. |

Press **Ctrl+C** to stop after saving progress, then continue with:

```sh
npm run sources:collect -- --resume
```

For a custom destination, pass the same `--directory` when resuming. Do not pass new limit, topic, or size settings with `--resume`.

The collector saves its search positions and queued results as it works. A resumed job counts images already committed to its catalog toward the original limit. Before each image request, it durably reserves up to 16 MiB (or the remaining budget), then replaces that reservation with measured bytes when the attempt ends. After a hard crash, an unsettled reservation counts in full against the budget because the exact transfer cannot be recovered. Job records separate measured `bytesDownloaded`, total `budgetBytesUsed`, and `uncertainDownloadBytes`. Graceful Ctrl+C settles the measured transfer. It also recovers the lock left by a process that has exited. Only one collector can write to a particular library at a time.

A job finishes when it reaches its image limit, consumes its download budget, or finishes its bounded search. Each topic is limited to ten pages of fifty records per job. A finished or budget-limited job is not resumable: start another command with a new budget to extend the same library. Existing records are skipped. A `search_complete` result describes these bounded searches, not the entire museum collection.

Requests run one at a time, at least 1.1 seconds apart. Temporary connection failures and selected HTTP failures retry up to three attempts. Longer server-requested retry windows pause the job for later resumption. API JSON responses are capped at 5 MiB. Each image download is capped at 16 MiB; images must decode within 20 million pixels, contain a single frame, and have an original short edge of at least 256 pixels. Streaming responses are stopped when a byte budget is crossed; a received chunk can cross the threshold.

## Saved files

```text
.data/source-library/
  index.html          Local thumbnail gallery with source links
  catalog.json        Images, credits, reuse evidence and hashes
  assets/             Full-frame, resized JPEG copies
  jobs/               Collection settings, checkpoints and outcomes
```

Open `index.html` in a browser to inspect the collection. It is a local preview, not a public gallery. The default `.data` directory is excluded from Git.

Each image retains the museum record ID and link, creator and date when available, credit, CC0 evidence, original download URL, discovery topic, job ID, normalization settings, dimensions, and checksums. The collector stores a JPEG at quality 88; the original downloaded bytes are hashed but are not retained. When the API supplies a larger image URL, that URL is retained for future use.

Duplicates are detected by provider record ID, identical original bytes, or identical normalized PNG bytes. Alternate records are attached to the existing source as provenance. This does not detect every visually similar image or different photograph of the same object. Skipped records and their reasons are retained too.

## Using the collection in runs

The collected library is currently **separate from the New run picker**. The picker still uses the studio's shared inventory, which is limited to 24 images and 24 MiB of normalized PNG data. Collection jobs do not change this inventory, existing artwork, or previous runs.

For now, selected JPEGs can be uploaded through New run while there is room in the shared inventory. The next product step is to let the picker browse the disk-backed catalog and freeze only the chosen images into each run. That separates the size of the discovery library from each model's material allowance.

`npm run sources:import` is a different command: it adds the 21 bundled source images to an existing studio through its API. It does not import this collected library.

Additional providers such as the Art Institute of Chicago and the Library of Congress remain future adapters, each with its own image eligibility and provenance rules.
