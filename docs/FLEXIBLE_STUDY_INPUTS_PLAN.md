# Flexible Study Materials and Model Support

Status: implementation plan only  
Branch: `codex/flexible-study-materials-models-plan`

## Outcome

Allow a researcher to build a Study with one to eight named primary material packs and one to eight model routes. Preserve Offcut's reproducibility rules: every pack is ordered and frozen, every requested and returned model route is recorded, every provider call is attributable, and no unattended call can run without a reviewed cost rule.

This work has two distinct scopes:

1. Make the existing multi-pack and multi-model Study schema usable from the setup screen.
2. Expand model support first within OpenAI, then through a provider-neutral adapter contract that can safely support another multimodal provider.

Do not combine those scopes into one large pull request.

## Current behavior

The Study schema already accepts:

- 1–8 packs
- 1–8 model routes
- 1–24 ordered images per pack
- at most 100 resolved cells

The setup screen is narrower:

- `public/study-new.js` initializes exactly two primary packs and one calibration pack.
- `packsFor("primary")` slices the first two packs, so a third primary pack cannot reach the preview API.
- Each pack is fixed to exactly six selected images by the screen even though the schema accepts 1–24.
- Models can be added with **+ Add model route**, but every row is forced to provider `openai`.
- `lib/model-rates.mjs` permits unattended launch only for the exact routes in its immutable reviewed rate snapshot.
- `public/run-spec.mjs`, `lib/providers.mjs`, `server.mjs`, and the frozen protocol snapshot hardcode OpenAI.

Consequently, adding a third pack is primarily a UI/state task. Adding more reviewed OpenAI routes is a route and accounting task. Adding another provider is an adapter, accounting, persistence, and UI task.

## Product behavior

### Material packs

The Materials section should show a compact horizontal pack rail with:

- one tab per primary pack
- **Add pack** after the final primary pack
- rename on the active pack
- duplicate pack
- remove pack, disabled when only one primary pack remains
- a separate, visually marked Calibration pack that is excluded from the primary matrix

New primary packs start empty. Do not silently fill them with the next catalog images. The first visit may seed the first two packs from the catalog to preserve today's quick-start behavior, but any pack created by the user must require deliberate selection.

Each tab should show its selected count and validation state. The active pack retains ordered thumbnails in the tray. Changing tabs must not change selection order, silently reshuffle, or invalidate other packs.

For the first implementation, retain the six-images-per-pack research default and requirement in the UI. Expose 1–24 images per pack only as a later protocol option because varying source count changes the experimental condition and cost. The underlying schema remains unchanged.

The Review section must continuously display the matrix calculation:

`models × prompts × primary packs × repetitions × profiles = cells`

If the result exceeds the existing 100-cell limit, disable Review plan and show which factor must be reduced. For example, 3 models × 3 prompts × 5 packs × 2 repetitions is 90 cells; six packs would be 108 and must be rejected before an API request.

Calibration continues to use one dedicated six-image pack. It must remain visibly separate from primary packs, and selected calibration images must be disjoint from primary material by source hash. Server validation, rather than UI state alone, must protect that invariant where the primary/calibration relationship is known.

### Models

The model section should distinguish three facts that are currently easy to conflate:

- **Accessible:** the connected credential returned the route in a provider model listing.
- **Priced:** Offcut has a reviewed immutable accounting rule for the exact route.
- **Calibrated:** this protocol successfully completed a calibration run for the exact provider and requested route.

A listed route is not automatically image-capable or safe for unattended execution. Draft and preview may contain an unpriced route, but Freeze/Start must explain that it cannot launch until a reviewed accounting rule exists. Primary collection remains blocked until calibration succeeds.

For OpenAI, replace free-form-only entry with a searchable route picker populated from the connected account. Keep a manual exact-ID option because model listings and aliases can vary. The display label remains researcher-owned and separate from the requested API route.

Do not infer a capability rank from Luna, Terra, Sol, Astra, or another product label. Store the exact requested route, the returned route on every response, provider, adapter version, and rate snapshot.

### Additional providers

Provider support must remain explicit. Do not implement an "OpenAI-compatible" text box that sends credentials and images to an arbitrary URL. Each provider adapter must define and test:

- credential fields and environment-variable support
- model listing behavior
- native image-input translation
- response text extraction
- requested and returned model identity
- usage normalization without discarding the provider-native usage record
- refusal, incomplete output, cancellation, timeout, and rate-limit mapping
- credential redaction
- an immutable rate/estimator rule for every route allowed in unattended runs

The first non-OpenAI provider should be selected in a separate decision after checking current API access, native multimodal support, usage reporting, and pricing documentation. The architecture should not assume which provider wins that decision.

## Implementation sequence

### PR 1 — Dynamic primary pack editor

Scope only the Study setup UI and browser tests.

1. Replace the parallel `selectedPacks` and `packNames` arrays with pack objects:

   ```js
   { clientId, label, sourceIds, role: "primary" | "calibration" }
   ```

2. Keep calibration outside the primary pack array so index assumptions cannot send it into a primary matrix.
3. Add, duplicate, remove, rename, select, and keyboard-navigation actions.
4. Generate stable draft IDs from `clientId`, not from a mutable label. Labels may change without changing another pack's ID.
5. Make `packsFor("primary")` serialize every primary pack in display order.
6. Make validation name the incomplete pack rather than reporting only "each pack".
7. Show live factor counts and the 100-cell ceiling before preview.
8. Preserve the reviewed-draft invalidation rule after any edit.

Tests:

- add a third, fourth, and eighth pack
- remove and duplicate packs without cross-contaminating selected images
- preserve image order while moving among tabs
- keyboard navigation and focus after add/remove
- submit all primary packs in display order
- reject a ninth pack and an over-100-cell matrix locally and on the server
- verify calibration never appears in a primary draft
- desktop and narrow viewport screenshots

No schema migration is required. Existing frozen Studies remain readable.

### PR 2 — OpenAI route catalog and eligibility states

Keep the provider family OpenAI-only in this PR.

1. Return model-list results as route candidates associated with provider `openai`.
2. Add a server endpoint or enrich the Study-rates response with the exact priced route IDs and immutable snapshot ID.
3. Join accessible routes with priced routes in the browser without treating either as proof of image compatibility.
4. Add searchable selection and the Accessible/Priced/Calibration status affordances.
5. Keep manual exact-route entry.
6. Add new OpenAI routes only after reviewing current official pricing, image-input rules, Responses support, usage fields, and returned-route behavior.
7. Create a new immutable rate snapshot when routes or rates change. Never edit a snapshot already referenced by a campaign or Study.

Tests:

- accessible and priced
- accessible but unpriced
- priced but unavailable to the connected key
- manually entered route
- alias/returned-route mismatch requiring reconciliation
- no credential in browser storage, draft, trace metadata, or export

This PR is enough if "different models" means additional OpenAI models.

### PR 3 — Provider registry contract

Refactor without adding a live second provider.

1. Define an adapter descriptor with `id`, display name, credential schema, environment-key detection, `listModels`, `capture`, and versioned metadata.
2. Move OpenAI request translation into its adapter implementation.
3. Make registry methods dispatch by validated provider slug.
4. Generalize `/api/providers/:provider` routing using only registered IDs.
5. Change browser-safe run validation to validate provider syntax; perform supported-provider admission on the server registry.
6. Preserve current OpenAI errors and serialized run records exactly where possible.
7. Add a simulated second adapter in tests to prove routing, isolation, and redaction.

Tests must demonstrate that credentials cannot cross adapters and an unknown provider makes zero transport calls.

### PR 4 — Provider-aware protocol and accounting v2

Mixed-provider Studies cannot safely use the current single OpenAI adapter snapshot and rate snapshot.

1. Add a provider-adapter map to the frozen protocol snapshot, keyed by provider ID and containing adapter version, endpoint family, image policy, and storage policy.
2. Introduce an immutable rate-book object that can reference one reviewed snapshot per provider.
3. Make campaign reservation and settlement dispatch to the exact provider/route rule.
4. Preserve provider-native usage alongside normalized accounting fields.
5. Include all adapter and rate-book hashes in the execution fingerprint and export.
6. Version the frozen manifest/protocol representation. Continue reading, analyzing, reviewing, and exporting existing v1 OpenAI Studies without rewriting them.

Tests:

- mixed-provider matrix with simulated adapters
- exact per-provider reservation and settlement
- missing route rule blocks before transport
- changed adapter/rate hash blocks resume
- v1 frozen Study compatibility
- portable export verification with multiple providers

### PR 5 — First additional live provider

Choose one provider based on current access and documentation, then implement only that adapter.

1. Add its credential connection card and environment variable.
2. Translate Offcut's text and native images into the provider request format.
3. Normalize output while preserving raw safe response evidence and exact returned model identity.
4. Add reviewed route rules to a new immutable provider snapshot.
5. Run a no-cost simulated suite, then one explicitly authorized calibration call per intended route.
6. Document provider-specific limits and any non-equivalent settings.

Do not enable the route for unattended Studies until usage settlement and conservative reservation both pass with recorded fixtures.

### PR 6 — Multi-provider Study setup

1. Render connection cards from the provider registry.
2. Add provider selection to each model row and load that provider's route candidates.
3. Preserve model rows while credentials connect or disconnect.
4. Group Review output by provider and show each route's accessibility, pricing, and calibration state.
5. Allow a mixed-provider Study only when its rate book covers every selected route.
6. Keep model/provider identities hidden in blinded image-only review.

Browser tests cover disconnected providers, partial access, mixed routes, mobile layout, draft invalidation, and zero inference during Freeze.

## Acceptance criteria

Material-pack work is complete when a user can freeze and run a three-or-more-pack primary Study, every pack and ordered source is present in the manifest/export, the matrix count is correct, and existing two-pack Studies are unchanged.

Additional OpenAI model work is complete when the user can select any explicitly reviewed route available to their key, see why another route is blocked, calibrate it, and preserve requested/returned identities and cost evidence.

Multi-provider work is complete when two live provider families pass the same simulated runner contract, provider-specific accounting blocks unpriced calls before transport, a mixed-provider calibration Study completes, and its export verifies offline without credentials.

## Decisions before implementation

The pack UI can be built immediately. Before adding a live provider, the project owner should choose:

1. Whether the immediate need is more OpenAI routes or a genuinely different provider family.
2. Which second provider credentials are available for a minimal calibration call.
3. Whether the primary class Study should remain single-provider for comparability even if Offcut supports multiple providers.

Provider diversity is useful infrastructure, but provider-specific image preprocessing, reasoning controls, safety behavior, and billing make it an experimental factor. A mixed-provider comparison must report those differences rather than presenting provider identity as a pure model-capability comparison.
