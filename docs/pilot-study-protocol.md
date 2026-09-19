# Proposed first Minecraft learning study

Status: design for review; no model experiment has been started or registered.
The deterministic qualification is an infrastructure test and is excluded from
all learning-effect estimates. The months-long achievement swarm remains an
observational development archive, not a randomized experiment.

## Questions and comparisons

The primary question is whether a bounded amount of frontier-model coaching
reduces total resources required by a fixed local model to complete new tasks.
Local-only means one local agent with the same tools, task information, action
budget, and starting state as the other conditions. A second condition uses a
local-agent team without frontier coaching. A third uses the same team plus a
fixed coaching budget. The team-only condition distinguishes the effect of
coordination from the effect of coaching.

Specify the hardware, local model and quantization, inference settings, team
size, roles, context policy, tool permissions, and coaching delivery mechanism
before collection. A model label alone is insufficient provenance. Different
team sizes can spend different amounts of inference compute even with the same
wall-clock deadline; record both and treat that difference as part of the
intervention rather than free work.

The primary endpoint is independently verified completion within the fixed
budget on held-out task instances. Report completion and resource consumption
jointly. Cost per success alone hides failed work and becomes undefined when
there are no successes. Include resources spent on every failed attempt and on
the coach. Keep measured local energy, wall time, GPU time, and paid API cost
separate; a hypothetical API-equivalent price is not an electricity bill.

## Distinguish assistance from learning

An improvement while the frontier coach is present establishes assisted
performance only. Add a later retention evaluation with the coach disabled to
test whether frozen memories or skills improve the local system on new task
instances. State what can change during training: prompt, memory, retrieved
examples, generated skills, or model weights. If weights do not change, describe
the result as memory/skill adaptation rather than weight training.

Split task families and world instances into development, adaptation, and
held-out evaluation before inspecting outcomes. Freeze adapted artifacts and
hash them before the held-out phase. Do not let Fable, Codex, the coach, or a
human repair code in the middle of an evaluation block. Necessary safety fixes
end that block and are logged as interventions; they do not silently replace a
failed result. Reset memories, bulletin boards, inventories, caches, and worlds
between matched conditions unless a specific retained artifact is the declared
intervention. Never reuse held-out failures as coaching examples.

## Small staged pilot

1. **Infrastructure qualification:** fresh archive restore, isolated server,
   deterministic client, server-derived before/after state, bounded shutdown,
   and negative controls. No language model. A fixed walking command can fail
   because of terrain; retain that failure rather than teleporting the bot to
   manufacture a success.
2. **Development calibration:** choose reproducible task instances that are
   neither already solved nor impossible for the available tools. Navigation,
   obtaining a specified item, resource handoff, and recovery are candidates;
   each needs its own independent predicate and telemetry. Development data
   does not enter the final comparison.
3. **Frozen feasibility pilot:** prespecify a balanced condition-by-instance
   matrix and a modest fixed sample count. Randomize condition order within
   matched instances, record the randomization seed, and restore the exact same
   snapshot for each condition. Choose the final count from the affordable
   resource budget before running; do not stop early because a chart looks
   favorable. This pilot estimates feasibility and variability, not a definitive
   broad claim about model superiority.
4. **Retention/transfer:** evaluate frozen adaptations with no coach on new
   instances. Expand sample size only through a new prespecified study after
   reviewing the pilot. Report pilot and subsequent study separately.

The current offline benchmark accepts mock/replay inputs only. Do not label
qualification output as a live benchmark or force it into mock fixtures. A live
collector needs a reviewed schema, enforced budgets, independently observed
outcomes, exact source/model provenance, and full interruption accounting first.

## Required evidence and controls

- Pin archive, server JAR/bootstrap cache, tool dependencies, controller, model,
  prompts, role configs, and adapted artifacts. Record the actual loaded-world
  identity, not only the operator-supplied snapshot name.
- Collect server-side observations separately from agent explanations. In a
  model-facing trial, place the evaluator and its credentials outside the
  agent's write/read capabilities. The present deterministic client may query
  RCON itself; that is a server-source cross-check, not observer-process or
  credential isolation from a model-controlled participant.
- Preserve before, after, and interruption evidence with monotonic elapsed time
  and UTC source timestamps. Missing observations remain missing. Restarts do
  not erase attempts or turn them into fresh successes.
- Include an intentionally stationary client and a deliberately unreachable
  target to prove the completion check rejects failure. Check initially solved
  tasks are invalid rather than counted as successes. Test wrong dimension,
  mismatched action/run identity, and missing terminal observation.
- Bound wall time, actions, provider requests, input/output tokens, and local
  inference work. Failed/retried requests consume budgets. A late response must
  not bypass a deadline or mutate the next trial.
- Report matched completion differences with uncertainty, and individual trial
  outcomes including invalid starts and missing telemetry. Prespecify exclusion
  rules and show excluded counts and reasons. Do not drop difficult seeds after
  seeing results.

## Dataset and robotics claim boundaries

A useful release can include trajectories, actions, before/after observations,
failures, interventions, and verifiable task outcomes with explicit provenance
and licensing/privacy review. Separate historical partially observed data from
prospective instrumented trials. Preserve raw evidence privately and publish
only reviewed derivatives.

Minecraft can test planning, coordination, recovery, and memory under a
particular simulator's rules. It does not by itself demonstrate physical robot
control, sensor robustness, safety, or real-world transfer. A robotics claim
requires a separate evaluation in a relevant embodied environment; document the
abstraction gap rather than inferring transfer from achievement counts.

## Operator division

Fable continues live operations. Codex prepares isolated infrastructure and
reviewable experiment bundles. Starting a GPU-consuming model phase requires a
scheduled research window, a frozen plan, and verified operational separation.
A live-mode hourly restart cannot be treated as an innocuous part of a frozen
trial. No such phase is started by this document.
