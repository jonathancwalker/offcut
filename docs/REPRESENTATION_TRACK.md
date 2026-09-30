# Measuring recombination

Accepted research track, September 28, 2026. This track is planned research; the first runner does not compute embeddings or creativity scores.

Study whether knowing how existing visual material was recombined improves quantitative descriptions of a collage. Keep visual ideas, construction, and process as complementary representations. Learn similarity separately from audience preference or quality.

## First measurements

| Measurement | Operational definition | Interpretation |
| --- | --- | --- |
| Material breadth | Entropy of the proportion of visible artwork area attributable to each source | How widely a composition draws on its materials; consumed area and visible area differ |
| Construction relationships | Normalized positions, scale, rotation, visibility, overlap and adjacency of fragments, linked to source coordinates | How the supplied material was arranged |
| Reference novelty | Mean distance to the k nearest works in a frozen, balanced reference set using the same pack and protocol | Unusualness relative to a declared collection |
| Repeated-run diversity | Pairwise distances and a similarity-based effective diversity measure within each pack and condition | Whether repeated runs explore different outcomes |
| Arrangement contribution | Blinded comparisons against controlled rearrangements of the same selected fragments | The contribution of placement and layering beyond material selection |
| Revision behavior | Changes in geometry and representation across observed construction states | How the observable work develops, without claiming access to internal reasoning |

Use a frozen image encoder as a baseline: [CLIP](https://arxiv.org/abs/2103.00020) and [DINOv2](https://arxiv.org/abs/2304.07193) provide existing representations to evaluate. Compare those with interpretable geometry descriptors and, later, a learned combination. A fragment graph can represent source correspondence and spatial relationships. Semantic roles such as “leaf used as wing” need inference and validation; they are not engine ground truth.

[Vendi Score](https://arxiv.org/abs/2210.02410) supplies a similarity-based effective diversity measure. Its interpretation depends on the chosen positive semidefinite similarity kernel. Fix the encoder, kernel, parameters and sample size policy before comparing models. Compare identical packs first; [Conditional Vendi](https://proceedings.mlr.press/v300/jalali26a.html) is relevant to distinguishing input-induced variation from model-induced variation across conditions.

Random arrangements can be unusual. Report validity, novelty/diversity and audience quality separately. Numerical semantic distance has empirical support for verbal tasks in [SemDis](https://link.springer.com/article/10.3758/s13428-020-01453-w); its validity does not automatically transfer to visual collage.

## Validation and a possible learned space

Collect separate human judgments about similarity of visual ideas, similarity of composition, reinterpretation of fragments, and quality. Triplet comparisons can train a small projection so related uses of material are close. Preference supervision alone does not define a space of ideas or originality. The initial pilot is for evaluating frozen features and collecting judgments, not training a general creativity encoder.

The decisive test: does adding source correspondence and construction relationships improve held-out human similarity predictions over ordinary image embeddings? Evaluate on source packs and model authors excluded from training, with a reference collection balanced across models. Never feed model identity into the similarity representation being used to compare those models.

Test invariance to fragment IDs, file encoding, and exact subdivision of a fragment that leaves the visible image unchanged. Keep semantically significant changes such as rotation separate from harmless augmentations. Include literal reconstruction, repeated templates, and random rearrangement controls. Match rearrangement controls on selected material, scale and coverage where possible and disclose unmatched properties. Judge original-versus-control pairs blind to which is original.

Use original-space distances for analysis. A two-dimensional map is a visualization and can distort distances. Report pack-level results, audience disagreement and uncertainty; account for dependent ratings and repeated runs.

## Delivery stages

1. **Preserve inputs:** frozen sources, polygons, transforms, accepted and rejected commands, image observations, provider identity and stopping conditions in run bundles.
2. **Measure baseline behavior:** deterministic construction descriptors, frozen image embeddings, within-pack comparisons, controls and blinded judgments.
3. **Validate additional information:** compare image-only, construction-only and combined representations on held-out judgments. Process similarity is a separate target.
4. **Learn a projection if justified:** expand labeled data, use learning curves, hold out entire packs/models, and demonstrate improvement before presenting the space as a measurement tool.
5. **Publish an inspectable map:** link every point and trajectory to its materials and run. Report narrow numerical findings alongside examples, including null results.
