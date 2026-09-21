# Typed decision models: proposed optional comparison

Research snapshot: 21 September 2026. This is a source review and experiment
proposal. No candidate has been downloaded, loaded, or evaluated on the swarm.

## Fit and scope

TypeSafe's [official Jev documentation](https://docs.typesafe.ai/introduction)
describes typed Choice, Score and Noul questions over application state. Local
Jev-inspired models are independent projects; SDK compatibility does not make
them TypeSafe's weights or establish equivalent accuracy, calibration, or speed.

For the swarm, the useful question is whether a small decision model can choose
among a code-owned shortlist of valid skills or classify failures for review.
The existing brain, action validation, skill registry, and telemetry provide
those boundaries. Rules still handle safety, permissions, resource arithmetic,
and execution. Server observations determine outcomes. A model never grades its
own success.

The first comparison should be offline and CPU-oriented, outside the normal
swarm dependency tree. It must not change live bot actions or use the shared GPU
without a separately planned research window.

## Candidates worth screening

| Candidate | Actual artifact and local requirements | Key limitation for this project |
| --- | --- | --- |
| [VEJI-V2](https://huggingface.co/loaiabdalslam/VEJI-V2) | Independent small learned decision head plus an external frozen MiniLM encoder; the small head download is not the full runtime footprint. | Its model card reports a failed production gate and weak ranking, temporal, and numeric families. Treat it as a cheap exploratory CPU candidate, not a capable controller by default. |
| [Laya typed-decisions](https://huggingface.co/convaiinnovations/laya) | Apache-2.0 encoder models; typed-decisions is a 421M-parameter checkpoint with CPU support. Load one reviewed checkpoint rather than preloading the family. | Its typed-decisions checkpoint was trained on that benchmark's training split. Published scores do not establish Minecraft accuracy; local calibration and held-out evaluation are required. |
| [Open-Jev-2B](https://github.com/Zefan-Cai/Open-Jev) | Independent LoRA adapter, scalar head, and temperature; requires pinned Qwen base weights and a custom loader. Published inference workflow uses a GPU. | Synthetic decision evaluations and provider comparisons are not closed-loop game results. Defer until a GPU experiment is scheduled and the simpler pilot justifies it. |
| [LocalJev](https://github.com/githubnext/localjev) | Wrapper translating typed requests to an OpenAI-compatible local generative backend. | Useful as an interface baseline, but it is not independently trained Jev weights. Runtime cost depends on the selected backing model. |

These are source-reported capabilities. We have not reproduced their quality or
performance figures. License and loader review, exact artifact hashes, complete
download size, and measured CPU/RAM use are prerequisites to running any model.

## Frozen shadow comparison before adoption

1. Select one narrow question, such as skill choice from a 3–8 item shortlist or
   retry/replan/escalate classification. Freeze wording and candidate IDs.
2. Export only archived cases with reconstructable pre-decision state and exact
   source/skill identity. Keep future observations and reference labels out of
   model inputs. Mark incomplete or ambiguous cases as exclusions with reasons.
3. Label independently of candidate models. Use deterministic policy labels
   where applicable and blinded human review for ambiguous judgments. Observed
   success of one historical action does not prove it was the best available one.
4. Split by episode/time and hold out a situation family. Keep near-duplicate
   states together and reserve a final untouched set.
5. Compare deterministic rules and the existing model's recorded choices against
   the candidate on identical cases. Rotate candidate order. Track every failure,
   invalid probability, exclusion, abstention, and timeout.
6. Report accuracy, probability quality, selective accuracy/coverage, cold/warm
   latency, and peak memory by situation family. A typed answer or confident
   prediction is not evidence that it is correct.
7. Only consider a live shadow run after useful held-out results. Shadow output
   must have no path to action execution. Closed-loop gameplay improvement is a
   separate experiment after that.

## Public communication

A useful eventual article is **"Can tiny typed-decision models route a Minecraft
agent swarm?"** It should show shared inputs, candidate choices, abstentions,
resource costs, and failures. An honest negative result is useful too. Until the
comparison has run, describe it as planned. Do not present this project as a Jev
integration, a Jev clone, or a demonstrated learning benchmark, and do not assume
that topical attention will produce sustained adoption.

See the [main research track](README.md) and [release gates](benchmark-release-checklist.md).
