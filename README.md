# Offcut

A local collage studio for exploring what an AI agent can invent from a fixed set of existing images. There is no target image and no prescribed theme. A person or agent chooses the subject, cuts fragments, and builds a composition through a small, enforced action vocabulary.

## Run

Requires Node.js 22 or newer and the `sharp` image library.

```sh
npm install
npm start
```

Open **http://127.0.0.1:4317**. Inside this Codex workspace, the server can use the bundled `sharp` installation without installing dependencies. Elsewhere, run `npm install` first. Use `PORT=4318 npm start` if the default port is occupied.

The app listens on this computer only. It needs no model API key, account, remote database, or network connection after setup. Starter images and fonts are bundled locally.

## The studio

- Start with the three archival sources, or add PNG, JPEG, or WebP images.
- Click a source and draw a rectangle or polygon. Polygon corners are added by clicking; close at the first corner, or choose **Cut & place**. Numeric rectangle coordinates provide a keyboard alternative.
- Drag a fragment on the canvas. Select it to change its position, rotation, scale, or layer. Arrow keys nudge by one canvas pixel; Shift + arrow moves ten. Delete returns the selected piece to the tray.
- **Find this piece in its source** highlights the exact cut boundary in the original image. Shaded source regions have been consumed.
- Undo/redo with the toolbar or Command/Ctrl + Z and Command/Ctrl + Shift + Z.
- Scrub or play **The making** to review earlier states. Replay never changes the live composition; return to live before editing.
- Export a PNG, a self-contained SVG, or a portable project with its complete retained action history and source images. A saved project can be reopened through **Open a saved project**.

Work saves automatically to `.data/session.json` after every accepted mutation. Imported projects are reconstructed and validated before replacing the current work. If a saved session is corrupt, the server keeps a recovery copy in `.data/`.

## Rules

The default canvas is 1000 × 1200 pixels with a plain paper-colored background. Every artwork fragment refers to an original raster image plus a polygon in that image's coordinates. The renderer clips and transforms that source; it does not generate artwork pixels, paint, recolor, blend, add typography, or stretch non-uniformly. Rotation and resizing use normal image resampling, so this is provenance-preserving composition rather than a promise of identical output RGB values after resampling.

- Up to **24 cut fragments** and **120 successful actions**.
- Cuts are simple polygons with 3–16 corners, at least 100 square source pixels, fully inside a source image.
- Polygon boundaries may touch, but their interiors cannot overlap on the same source.
- Cutting consumes material even while the fragment is in the tray. Removing a piece does not make the original source region available again.
- Uniform scale: 15–300%. Piece centers stay on the canvas, but edges may extend beyond it and are clipped by the final canvas.
- Each successful cut, placement, transform, reorder, removal, or description counts as one action. A rejected action changes nothing. A submitted batch either succeeds completely or changes nothing.

This version is an **exploration environment**, not a validated creativity leaderboard. Undo restores the earlier action budget; editing after undo replaces the abandoned continuation. Sources may be added during a studio session, and imports may specify bounded alternate rules. A rigorous benchmark should freeze the source inventory and rules, count total attempted actions independently of undo, retain abandoned branches and invalid attempts, record model/configuration/cost metadata, and judge multiple independent runs blindly. The current replay captures retained observable actions, not a model's internal reasoning.

## Agent access

Choose **Connect an agent** in the app for a copyable prompt. This does not start a model automatically. An agent must have image-reading and local HTTP access on this computer. A cloud-only agent cannot reach a loopback address directly.

Read [AGENT_PROTOCOL.md](./AGENT_PROTOCOL.md) for the action contract, or open `GET /api/help` for the machine-readable reference. Both manual and agent edits use the same authoritative engine. External agent edits appear in the browser automatically.

The action interface itself is model-neutral JSON. The starter workflow assumes image input; a text-only model would need descriptions and spatial annotations of the source material. [Observation and action interfaces](docs/MODEL_INTERFACE.md) documents the first experiment and the proposed provider adapters. [BACKLOG.md](BACKLOG.md) tracks the experiment runner, richer agent trajectory playback, and model comparisons.

## Validation

```sh
npm test
```

Tests cover polygon validity and overlap, finite material, immutable state, limits, source metadata, renderer fidelity, layering, atomic action batches, undo/redo and replay, persistence, image input validation, portable imports, and local-request protection. Integration tests bind temporary loopback ports and therefore need permission in a sandbox that blocks local servers.

The browser workflow was also exercised for rectangle and polygon cutting, direct dragging, transforms, provenance inspection, undo/redo, and replay.

## Project structure

```text
public/             Browser studio, local fonts, source pack
lib/engine.mjs      Pure state transitions and geometry validation
lib/render.mjs      Source-preserving SVG and PNG rendering
server.mjs          Local HTTP API and persistent action history
tests/              Engine, renderer, and API integration checks
docs/               Interface design and experiment architecture
experiments/001/    First artwork, source-bearing projects, actions and audit
```

Experiment checkpoint state copies and per-stage portable projects are kept locally but ignored by Git because they repeat embedded images. The original and final portable projects, stage commands, API log, PNG checkpoints, final SVG, and readable trajectory are versioned.

Starter image credits and rights records are in [public/sources/CREDITS.md](./public/sources/CREDITS.md). Bundled font licenses are in `public/fonts/`. Imported sources retain the attribution supplied with them.
