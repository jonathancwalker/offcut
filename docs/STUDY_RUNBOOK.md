# Offline study exports

An Offcut study export is a self-contained, read-only exhibit for sharing an evaluation without sharing the live data root or a provider credential. It contains the frozen study manifest and state, every matrix cell, original source bytes, attempted run records, replay projects, event traces, final PNGs, and a checksum inventory. Optional analysis and annotation directories can be included when they were created separately.

## Create an export

Stop the Offcut server first, then choose an output directory outside the data root. The exporter refuses a running or unsettled study and refuses to overwrite an existing directory.

```sh
npm run studies:export -- \
  --data /absolute/path/to/.data \
  --study study-00000000-0000-0000-0000-000000000000 \
  --out /absolute/path/to/share/study-export
```

The command does not initialize a model provider or make a network request. It externalizes embedded source images into deduplicated files under `assets/`, writes the static exhibit, and creates `checksums.json` last. An export directory is immutable by convention: create a new directory for a new export.

Optional report inputs may be supplied when supported by the CLI:

```sh
--analysis /absolute/path/to/analysis --annotations /absolute/path/to/annotations
```

These directories are copied as JSON, Markdown, CSV, and PNG files. Credentials, local data-root paths, and symlinks are rejected.

## Verify before sharing

Verification checks every copied file, the frozen manifest hash, the recorded implementation hashes, source and run assets, and the final PNG by replaying each saved project with the local engine. It does not need a provider key.

```sh
npm run studies:verify -- --export /absolute/path/to/share/study-export
```

Run verification again after copying the directory to another machine. A checksum failure means the artifact changed or was truncated. A code mismatch means the current checkout no longer matches the implementation recorded by the study; verify from the original revision or preserve the already verified export.

## View the exhibit

The exhibit is static. Open `index.html` from a local static file server so browsers can fetch its adjacent JSON files:

```sh
cd /absolute/path/to/share/study-export
python3 -m http.server 8000
```

Then visit <http://127.0.0.1:8000/>. The page does not call Offcut APIs, contact a model provider, or modify the export. It shows every cell, including failed and not-run cells; selecting a completed cell shows its final PNG, model request/response fields, source thumbnails, and an event trace. Optional analysis and annotations are displayed when included.

## What to publish

Publish the verified export directory as a static artifact only after checking source rights and credits in `sources.json`. The export contains the requested model ID, returned model ID when the runner recorded one, provenance, cost metadata, and timestamps. Missing fields are displayed as “not recorded”; they should not be reconstructed from memory after the run.

Do not place `.data`, provider keys, local run directories, or unverified partial exports in the public artifact. Keep the original export and its verification output as the archival copy.
