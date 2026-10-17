# Flexible Study Materials and Model Support

Status: implementation plan only  
Branch: `codex/flexible-study-materials-models-plan`

## Outcome

Allow a researcher to build a Study with one to eight named primary material packs and one to eight model routes spanning OpenAI, Google Gemini, Anthropic Claude, Alibaba Model Studio/Qwen, xAI Grok, and capability-qualified open models such as Qwen or DeepSeek served through Hugging Face Inference Providers. Preserve Offcut's reproducibility rules: every pack is ordered and frozen, every requested and returned model route is recorded, every serving provider is explicit, every provider call is attributable, and no unattended call can run without a reviewed cost rule.

This work has two distinct scopes:

1. Make the existing multi-pack and multi-model Study schema usable from the setup screen.
2. Expand model support within OpenAI and then through provider-neutral adapters for Google, Anthropic, Alibaba, xAI, and Hugging Face-hosted open vision models. Keep a direct DeepSeek adapter capability-gated until its official API documents native image input for an eligible route.

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

### Target provider and model matrix

Provider names and model families must not be collapsed into one field. A Qwen model served by Alibaba and the same named weights served by a Hugging Face inference partner are different experimental routes. Freeze the serving provider, endpoint family, requested model ID, returned model/version/fingerprint when supplied, region or processing tier when relevant, adapter version, and rate snapshot.

| Integration | Intended role | Visual eligibility evidence | Initial priority |
| --- | --- | --- | --- |
| OpenAI Responses | Existing baseline and additional reviewed OpenAI routes | Native `input_image` in Responses | Existing / first |
| Google Gemini API | First new provider; strong audit metadata | Inline/file image input; response includes usage metadata, model version, and response ID | Second |
| Anthropic Messages | Independent commercial model family | Messages accept text and image content and return model, stop reason, and billed usage | Third |
| Alibaba Cloud Model Studio | Direct hosted Qwen vision models | Qwen-VL and current multimodal routes accept URL or base64 image content and return usage | Fourth |
| xAI Responses | Grok vision comparison | Responses image-understanding endpoint accepts base64/URL image input; language-model metadata exposes modalities and fingerprint | Fifth |
| Hugging Face Inference Providers | Pinned open VLMs, including eligible Qwen and DeepSeek-family checkpoints | Chat completion supports VLM routes, but the underlying inference provider must also be frozen | Sixth |
| DeepSeek direct API | Direct DeepSeek route only if it becomes natively visual | Current reviewed public API material documents token-priced chat/reasoning routes but does not establish image-input support | Blocked pending evidence |

Official references to re-check when each adapter is implemented:

- OpenAI image inputs: https://developers.openai.com/api/docs/guides/images-vision
- Gemini image inputs and response usage: https://ai.google.dev/gemini-api/docs/image-understanding and https://ai.google.dev/api/generate-content
- Anthropic Messages: https://platform.claude.com/docs/en/api/http/messages
- Alibaba Qwen multimodal API: https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions
- xAI image understanding and model metadata: https://docs.x.ai/developers/model-capabilities/images/understanding and https://docs.x.ai/developers/rest-api-reference/inference/models
- Hugging Face VLM chat completion: https://huggingface.co/docs/inference-providers/en/tasks/chat-completion
- DeepSeek models and pricing: https://api-docs.deepseek.com/quick_start/pricing/

These links are evidence inputs, not permanent configuration. Model availability, modality support, endpoints, aliases, regional behavior, and prices must be checked again and captured in a dated immutable snapshot before enabling a live route.

### Additional-provider contract

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

Adapters must be implemented independently even when a provider advertises OpenAI wire compatibility. Shared request-shape helpers are acceptable, but authentication, supported parameters, image preprocessing, response parsing, error mapping, usage settlement, and route identity stay provider-owned.

Do not call a text-only model a visual condition by generating captions with a different model. If direct DeepSeek remains text-only, it may participate later in an explicitly named caption-mediated ablation, or a DeepSeek-family vision checkpoint may run through a pinned Hugging Face inference route. Neither is equivalent to direct native-image observation.

## Implementation sequence

### Dependency and execution map

Use this merge order:

```text
PR 1 dynamic packs -------------------------------> PR 11 qualification
PR 2 OpenAI routes -------------------------------> PR 11 qualification
PR 3 provider contract -> PR 4 protocol/accounting -> PR 5 Gemini -----\
                                                    -> PR 6 Claude ------|
                                                    -> PR 7 Qwen --------|-> PR 10 setup UI -> PR 11 qualification
                                                    -> PR 8 Grok --------|
                                                    -> PR 9 open VLM ----/
```

PRs 1 and 2 are independent of the provider-platform refactor and may be developed alongside PR 3. PR 4 must follow PR 3. After PR 4 merges, adapter PRs 5–9 may be developed in parallel against the frozen contract. PR 10 can begin with simulated adapters after PR 4, but it should merge after at least one new live adapter proves the contract. PR 11 is the integration gate and must follow all adapters intended for the first comparative pilot.

Every PR receives its own code review and targeted tests before it is marked ready. Adapter PRs use simulated transports in CI; live calls are calibration evidence run separately with explicit credentials and allowance.

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

### PR 5 — Google Gemini adapter

Implement the first live non-OpenAI adapter against Gemini's native API.

1. Support a session key and `GEMINI_API_KEY` without persistence.
2. List exact accessible model IDs and retain model stage/version metadata where returned.
3. Translate Offcut messages and base64 images into Gemini content parts with a frozen media-resolution policy.
4. Parse text, finish/block reasons, `modelVersion`, `responseId`, and complete `usageMetadata`, including modality and thinking-token details.
5. Add conservative image/text request estimation and a dated Gemini rate snapshot for only the reviewed routes.
6. Add simulated error, blocking, cancellation, unknown-usage, returned-version, and credential-redaction fixtures.

### PR 6 — Anthropic Claude adapter

1. Support a session key and `ANTHROPIC_API_KEY` without persistence.
2. List or validate exact Claude routes available to the key.
3. Translate the fixed Offcut instruction into Anthropic's system field and history/images into Messages content blocks.
4. Parse text blocks, exact returned model, message ID, stop reason/details, refusals, and authoritative usage including cache and thinking detail.
5. Add a conservative token-count/reservation path and immutable Anthropic rate snapshot for reviewed routes.
6. Test stateless history reconstruction, max-token stops, refusal evidence, image MIME validation, and redaction.

### PR 7 — Alibaba Model Studio/Qwen adapter

Use Alibaba as the direct Qwen provider; do not label the provider merely `qwen`.

1. Support a session key and documented Model Studio environment key without persistence.
2. Record the regional endpoint and deployment scope because availability and pricing can vary by region.
3. Support exact reviewed Qwen vision routes with URL/base64 image content and freeze visual-resolution controls.
4. Preserve requested and returned model IDs, request ID, finish state, input/output tokens, and image-token detail when returned.
5. Add an immutable regional Qwen rate snapshot and conservative visual-token bound.
6. Reject text-only Qwen routes from this visual Study even if the account model listing includes them.

### PR 8 — xAI Grok adapter

1. Support a session key and `XAI_API_KEY` without persistence.
2. Use xAI's Responses interface for image understanding with server-side storage disabled.
3. Query language-model metadata and require `image` in the advertised input modalities.
4. Freeze requested model, returned model, version/fingerprint, endpoint family, image detail, response ID, and usage.
5. Convert xAI's published model pricing metadata into a reviewed immutable snapshot; do not trust a changing live price during replay or settlement.
6. Test alias-to-version reconciliation, image size/type limits, long reasoning timeouts, rate limits, and redaction.

### PR 9 — Hugging Face open-VLM adapter and DeepSeek gate

This PR supplies the open-model path for Qwen and, only when qualified, DeepSeek-family vision checkpoints.

1. Support a Hugging Face token without persistence and use the Inference Providers chat-completion interface.
2. Require an explicit tuple of model repository/revision, inference provider, task, and endpoint mode. A model ID alone is insufficient.
3. Admit only routes whose metadata and a calibration request establish image-to-text/VLM support.
4. Preserve the resolved inference provider and returned model identity; block if routing silently changes.
5. Implement cost rules per resolved inference provider. A generic Hugging Face token does not imply a single price schedule.
6. Add a Qwen open-VLM fixture and the first accessible pinned Qwen route.
7. Add a DeepSeek-family route only if the exact checkpoint is a genuine visual-language model and the serving route returns sufficient usage/accounting evidence.
8. Keep the direct DeepSeek API adapter disabled until official image-input support is documented and tested. If later enabled, give it its own provider ID and PR rather than routing it through Hugging Face invisibly.

### PR 10 — Multi-provider Study setup

1. Render connection cards from the provider registry.
2. Add provider selection to each model row and load that provider's route candidates.
3. Preserve model rows while credentials connect or disconnect.
4. Group Review output by provider and show each route's accessibility, pricing, and calibration state.
5. Allow a mixed-provider Study only when its rate book covers every selected route.
6. Keep model/provider identities hidden in blinded image-only review.

Browser tests cover disconnected providers, partial access, mixed routes, mobile layout, draft invalidation, and zero inference during Freeze.

### PR 11 — Cross-provider qualification and research export

1. Add a provider-qualification harness that sends the same tiny image/action fixture through a simulated adapter and, when explicitly authorized, one live calibration request.
2. Require native-image acceptance, parseable action JSON, returned route identity, complete usage settlement, deterministic replay of accepted actions, and credential-free persistence.
3. Generate a compatibility report showing Accessible, Native image, Priced, Calibrated, and Primary eligible for every route.
4. Run a mixed-provider calibration Study with one route per enabled provider before any primary matrix is frozen.
5. Verify analysis, blinded review, and portable export preserve provider/model provenance without exposing it during image-only coding.
6. Document provider differences in image preprocessing, reasoning controls, safety/refusal fields, regional routing, and stochastic settings.

This final qualification PR does not launch the full class experiment. It establishes which routes are eligible for the separately frozen study.

## Acceptance criteria

Material-pack work is complete when a user can freeze and run a three-or-more-pack primary Study, every pack and ordered source is present in the manifest/export, the matrix count is correct, and existing two-pack Studies are unchanged.

Additional OpenAI model work is complete when the user can select any explicitly reviewed route available to their key, see why another route is blocked, calibrate it, and preserve requested/returned identities and cost evidence.

Multi-provider work is complete when OpenAI, Gemini, Claude, Alibaba/Qwen, Grok, and at least one pinned open VLM route pass the same simulated runner contract; provider-specific accounting blocks unpriced calls before transport; a mixed-provider calibration Study completes; and its export verifies offline without credentials. A direct DeepSeek route is not required until an eligible official native-image API exists.

## Decisions before implementation

The pack UI and simulated provider platform can be built immediately. Live-adapter completion depends on credentials for a minimal calibration call to Google, Anthropic, Alibaba Model Studio, xAI, and Hugging Face. Direct DeepSeek remains conditional on a native visual route or a separately identified visual checkpoint through an explicit host.

Before primary collection, choose whether the class Study compares all qualified providers or uses a smaller balanced subset that fits the allowance and 100-cell limit. Adding five provider families can multiply the matrix beyond both limits quickly; reduce prompts, packs, repetitions, or selected routes explicitly before freezing rather than truncating scheduled cells later.

Provider diversity is useful infrastructure, but provider-specific image preprocessing, reasoning controls, safety behavior, and billing make it an experimental factor. A mixed-provider comparison must report those differences rather than presenting provider identity as a pure model-capability comparison.
