# Offline coordination benchmark pilot

This package is a deterministic benchmark foundation for frozen mock and replay observations. It does not connect to Minecraft, reset a world, invoke RCON, call a model provider, start a server, or establish that coordination or coaching improves live behavior.

The committed mock-pilot fixture exercises the reporting pipeline. Its completion rates and paired intervals are synthetic test outputs, not empirical Minecraft results.

## Run the fixture

From the repository root:

~~~bash
python3 -m unittest discover -s tools/benchmark -p 'test_*.py'
python3 -m tools.benchmark.runner validate \
  --manifest tools/benchmark/fixtures/mock-pilot/experiment.json
python3 -m tools.benchmark.runner run \
  --manifest tools/benchmark/fixtures/mock-pilot/experiment.json \
  --output /tmp/mock-benchmark-report.json
~~~

The run command refuses to overwrite an existing output. Both commands read JSON only. The runner has no live adapter and contains no server, RCON, provider, world-reset, or shell execution path.

## Frozen experiment bundle

experiment.json uses schema version 1 and pins every input by a relative path and SHA-256:

- scenario_manifest defines task IDs and objective state predicates.
- reset_manifest identifies the world snapshot and server version. The offline runner validates this manifest's bytes; it does not restore or independently verify a world archive.
- model_manifest identifies provider, model, and version. The mock fixture records that no inference billing occurred.
- observation_manifest contains the complete frozen run matrix.
- case_study_manifest links one matched baseline failure to one simulated change and successful post-state.
- Each condition pins its own config. The config repeats its condition ID and kind so a coordination config cannot be silently labeled as the baseline.
- code, collection_context, seeds, and budgets are required. Git commit and world IDs must agree across the relevant fields.

References must stay within the bundle, must be regular files rather than symlinks, and must match their declared hash. A changed reset, condition, model, scenario, case-study, or observation file invalidates the experiment. The manifest accepts only mock and replay; live is rejected.

The fixture covers baseline, coordination, and coaching with the same four seeds. The runner requires exactly one observation for every scenario-condition-seed tuple and rejects missing, duplicate, or extra runs.

## Independent completion predicates

The evaluator ignores model_self_report when assigning status. The report retains that field so contradictory claims remain inspectable.

Three bounded predicates operate only on observed initial and final state:

- navigate_to_region requires a named actor to start outside and finish inside a closed XYZ region in the declared Minecraft dimension. Missing or wrong dimension cannot satisfy the goal.
- acquire_item treats count as the target final inventory. The actor must start below that count, finish at or above it, and have a positive observed gain.
- shared_resource_handoff requires distinct donor and recipient actors, matching inventory movement for the named item, and an independently observed transfer event bound to donor, recipient, item, observer, and count. Duplicate transfer event IDs are invalid. Coincidental inventory changes or moving a different item cannot satisfy the goal.

An initially fulfilled goal becomes invalid_initial; it never receives completion credit. Missing predicate observations become missing_telemetry. The fixture includes a foreign-item handoff, an initially met goal, and prose claiming success despite a failed position predicate.

Run status is one of:

- completed
- failed
- timed_out
- interrupted
- missing_telemetry
- invalid_initial

Missing telemetry, unavailable enforced-budget measurements, terminal execution state, and budget violations remain explicit. A completed action report cannot override those states or the independent predicate.

## Budgets and measurements

Every experiment records positive limits for steps, wall time, provider requests, input tokens, and output tokens. A reported overrun cannot count as completion. Steps are validated for every terminal state. Missing wall-time, request, input-token, or output-token measurements make the trial budget unverifiable and therefore missing_telemetry.

Other unknown quantities remain JSON null; the runner does not replace them with zero or estimate them. Measurements stay in three groups:

- inference: provider requests, input tokens, output tokens, and estimated API-equivalent cost
- runtime_resources: trial wall time, CPU time, peak resident memory, and energy
- engineering: human labor time and infrastructure cost

Trial wall time is not engineering labor. Each aggregate reports known and missing counts. A mean is null when every value is missing. The mock fixture deliberately leaves cost, energy, labor, and infrastructure cost unavailable. Subscription cost and energy cannot be derived from token fields.

## Summaries and uncertainty

The report includes condition totals and condition-by-seed totals. Each completion rate has a descriptive Wilson 95% interval over all recorded trials, including failures, timeouts, interruptions, missing telemetry, and invalid initial states in the denominator.

Condition differences use matched scenario_id plus seed pairs. They report wins, losses, ties, mean paired completion delta, and a deterministic paired bootstrap percentile interval. They do not calculate a difference from two independent-binomial standard errors. These intervals describe fixture variability; the mock report labels itself synthetic_mock and says it does not claim live Minecraft outcomes.

A real pilot needs enough prespecified seeds for useful uncertainty. Four synthetic seeds verify the machinery and are not a power analysis.

## Failure-to-fix case-study template

case-study.json must identify:

~~~json
{
  "schema_version": 1,
  "evidence_class": "synthetic_mock",
  "scenario_id": "navigate",
  "seed": 11,
  "before_run_id": "navigate-baseline-11",
  "after_run_id": "navigate-coordination-11",
  "diagnosed_failure": "Observed failure stated without model prose.",
  "simulated_change": "The isolated change represented by the second condition.",
  "claim_limit": "Why this pair does not establish a live or causal result."
}
~~~

The runner verifies that both run IDs exist, share a scenario and seed, use baseline before and a non-baseline condition after, and link a non-completion to an independently verified completion. The committed example is a simulator wiring demonstration only.

## Requirements for a future live adapter

No live adapter is implemented here. Before one can produce benchmark evidence, it must add and independently test all of the following:

1. Restore a reviewed immutable world snapshot before every trial and verify the archive and post-reset manifest hashes.
2. Record exact Minecraft server, bot config, source commit, dirty diff, provider, model, and model-version provenance before execution.
3. Refuse trials with absent provenance. It must not infer collection context from the runner's checkout. The supplied current-data audit found 2,155 events and 644 collection-context records with null Git or mode fields; those records do not satisfy this contract.
4. Enforce wall-time, action, request, and token budgets while counting failed and interrupted work.
5. Capture pre-state, post-state, dimensions, and transfer events from an evaluator boundary unavailable to model self-report, with observer identity and observation time.
6. Require healthy complete telemetry for the whole scenario, including cancellation and process interruption reconciliation.
7. Run the same frozen tasks and seeds for every condition without carrying memory, inventory, bulletin state, or coaching data between trials.
8. Measure API-equivalent inference cost from pinned pricing only when usage exists, and measure runtime resources, engineering effort, and energy with separate instrumentation.
9. Record exact operator commands and reset evidence without placing credentials or private chat in a report.
10. Prespecify exclusions, seed count, paired comparison method, and negative controls before inspecting condition outcomes.

Historical replay input can exercise evaluation on an immutable observation export, but the offline runner still sets claims_live_minecraft_outcomes to false. Promoting replay or live results to evidence requires a separate provenance and study-protocol review.
