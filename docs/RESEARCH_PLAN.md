# Offcut research plan

Planning draft, September 27, 2026. No study or budget in this document has been executed or approved for spending.

The [representation research track](REPRESENTATION_TRACK.md), accepted September 28, specifies numerical measurements and a path toward a validated embedding of visual recombination. It proceeds alongside product development.

## Scope of the claim

Study how multimodal agents compose with fixed visual materials and a small action vocabulary. Report task validity, process, audience judgments and diversity separately. Aesthetic preference, operation count, embedding distance, and an artist statement are each incomplete descriptions of creativity.

Experiments 001 and 002 are exploratory demonstrations. They used the same source pixels, but one began with a human fragment and prior conversational context while the other began blank in a fresh subagent context. Neither was a pinned multi-provider API study. Their similar black fields and city/plant motifs motivate a hypothesis; they do not establish a context effect, a model fingerprint, or a model ranking.

## First question: convergence under fixed materials

Question: when several models receive the same source packs, how much do repeated compositions converge, and how does that variation relate to audience judgments?

1. Run a small technical check: two models × two packs × two repeats = eight works. Check image delivery, coordinates, action validation, stopping, logs and costs. Label these development runs and use packs separate from the comparative pilot to avoid tuning the interface to its particular materials.
2. Freeze a versioned study specification before comparative data collection. A proposed pilot is three models × six packs × four independent repeats = 72 works. Determine the affordable scale from the development check. This allocation is exploratory and is not a statistical power claim.
3. Select packs with varied visual affordances: isolated illustration, dense photographs, maps/diagrams, typography, textures, and mixtures. Keep source count, supplied resolution policy and basic budgets consistent. Source packs are units of variation, not interchangeable background decoration.
4. Make each model run independent with the same initial canvas and instructions. Randomize or balance execution order where practical. Distinguish provider outages from model/command failures and retain both in the manifest.
5. Publish a full manifest and contact sheets covering every attempted run, including failures and incomplete outputs. Curated examples may accompany this complete record.

## Freeze and record

- Exact source files, pack IDs/versions/hashes, supplied image dimensions and preprocessing.
- Canvas, rules, action schema, renderer and runner versions, and instruction template.
- Initial state, conversation/context policy, and any human intervention.
- Source-image and canvas observation policy, image sizing, coordinate overlays, and batch limits. The supplied image bytes can be controlled; a provider's internal image processing may not be exposed.
- Model/provider identifiers and serving route, immutable snapshot or weights revision when available, supplied inference settings, and provider-specific compute controls.
- Raw returned outputs, explicit decision notes, attempted actions, validation results, observations, snapshots, timing, reported usage/cost, and stopping reason.
- A fixed policy for transport retries and malformed commands. A retry must remain visible and must not secretly increase one model's available attempts.

Use operation, observation and turn limits as explicit resource constraints, and report time and cost separately. Equal token counts or identically named settings across providers do not establish equal computation. A provider seed is recorded when supported; it is not a promise that future generations will be identical. Recorded action replay is a different reproducibility guarantee from rerunning inference.

## Outcomes

| Outcome family | Proposed measurement | Limit |
| --- | --- | --- |
| Validity | Completion, source and geometry checks, budget compliance, exact replay | A valid collage may still be uninteresting. |
| Process | Attempted/accepted/rejected actions, observations, revisions, removals, fragment count, source-area use, time and cost | These describe behavior and efficiency; they are not creativity rewards. Cut area and area visible after layering are different quantities. |
| Visual response | Anchored ratings of visual coherence/appeal; optional overall preference | Ratings describe this audience, task and viewing setup. |
| Reinterpretation | Ratings after viewing an identical source sheet: how much fragments gain a different role or relationship | Depends on source familiarity and viewer interpretation; keep distinct from visual quality. |
| Surprise | Perceived unexpectedness, rated separately | Surprising work can be poor, and unfamiliarity is not proof of historical originality. |
| Diversity | Motif/composition coding, repeated source-region choices, within-model versus between-model variation | Diversity is a property of a set of runs, not an individual image score. |

Image embeddings may support exploratory clustering, but shared source colors and textures can dominate their distances. Check a sample of clusters with human motif coding; define and document the coding scheme and disagreements. Avoid treating the minimum distance from existing gallery works as a general originality score.

## Human review

Use approximately five independent reviewers per work as an initial pilot allocation: 72 works would produce about 360 artwork reviews. Recruit both viewers with visual-art experience and general viewers, record experience, and report those groups separately when sample sizes allow. This is an initial workload proposal, not a guarantee of sufficient statistical power.

For the primary judgments, hide model identities, titles, statements, costs and timelines. Randomize presentation order. Ask about visual quality from the image alone, then show the source sheet for a separate reinterpretation judgment. Keep scales short, anchored and distinct, and retain disagreement rather than forcing consensus.

For later head-to-head comparisons, pair works made from the same pack, randomize left/right position, and allow no preference. Report preference rates and uncertainty before fitting a public overall ranking. Crowd preference methods such as [Chatbot Arena](https://arxiv.org/abs/2403.04132) offer a methodological starting point; their use in conversational evaluation does not validate an artistic creativity score.

Account for repeated ratings by the same people and multiple outputs from each pack. Use an analysis that respects these groups, with per-pack results and uncertainty. Three hundred and sixty reviews are not 360 independent artworks. Use pilot variability and agreement to size a follow-up study; preregister its primary outcomes, hypotheses and exclusions before collecting confirmatory data. A small set of curated packs supports conclusions about those conditions, not broad model superiority.

Keep self-selected gallery votes, likes and voluntary uploads outside the controlled-study estimates. Those are valuable community signals, with different sampling and exposure conditions.

Report completion rates alongside quality ratings. If quality ratings cover only completed works, say so and give the full attempted-run denominator. Define the handling of partial and blank outputs before collection rather than silently dropping inconvenient failures.

## Follow-up experiments and possible reports

| Question | Change or comparison | Honest report format |
| --- | --- | --- |
| Do agents converge on similar motifs? | Repeated fresh runs within and between models, holding packs fixed | Contact sheets, motif families, source-region choices and within/between variation; include null or ambiguous patterns. |
| Does seeing the canvas help? | Randomize intermediate visual feedback while preserving source access, rules and declared budgets | Separate fewer construction failures from changes in audience judgments; disclose changed observation cost. |
| Do tighter constraints help? | Vary fragment limits with other conditions fixed | Preference, reinterpretation, completion and diversity by budget. A benefit, harm or undetected difference are all informative. |
| How much do materials steer ideas? | Compare salient icons and objects with less familiar or more ambiguous packs | Pack effects and repeated motifs; avoid treating a handpicked image set as a representative sample of all visual material. |
| Does the statement change the judgment? | Randomly assign separate viewers to image-only and image-plus-statement conditions | A framing effect on ratings, kept separate from the collage's visual evaluation. |
| How much does selecting the best run matter? | Compare typical performance with a transparent best-of-four selection, using separate selection and evaluation raters | The selection procedure, its cost, and the difference between representative output and a highlight reel. |
| What do people do with the same pieces? | A separately labeled human reference round with the same source and operation rules | Descriptive similarities and differences; record time and interface conditions rather than equating human effort with model tokens. |

A related study by [Doshi and Hauser (2024)](https://pmc.ncbi.nlm.nih.gov/articles/PMC11244532/) distinguishes individual creative evaluations from collective diversity in AI-assisted writing. That motivates measuring both dimensions here. Its results should not be assumed to transfer to autonomous collage.

## First public research artifact

Publish a concise illustrated pilot report with the question, full protocol, all attempted works, replay links, audience-review procedure, distributions and uncertainty, failures, and limitations. Offer the eligible source packs, run manifests and de-identified ratings for independent inspection. Decide rating-data publication with participant consent during collection.

An informative result can be a recurring motif, a source-pack effect, a reliability problem, or no clear difference between models. Do not require a winner before sharing the environment and what the pilot taught us.
