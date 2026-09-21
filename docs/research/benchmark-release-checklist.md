# First benchmark release: acceptance checklist

Updated 21 September 2026. This is a release gate, not a list of achieved results.
The first release should be a small audited experiment, not a claim that every
Minecraft advancement is a comparable benchmark task.

## 1. Finish the deterministic path

- [ ] Connect the protected participant, bounded pipes, observer process, and
  outer namespace worker. Keep credentials/world/evidence inaccessible to the
  participant. Bound logs, process lifetime, scratch, and server resources.
- [ ] Rebuild and pin the current no-respawn client and all executed sources.
  Never overwrite the snapshots used for the historical movement case study.
- [ ] Run forward movement and stationary controls through the complete path,
  plus death, disconnect, malformed-message, stalled-process, and observer-timeout
  cases. Preserve partial evidence and every failed attempt.
- [ ] Verify actor roster, identity, permissions, and joins/reconnects. An offline
  login username alone is not an identity boundary against arbitrary code.
- [ ] Demonstrate that participant-written success claims cannot affect scoring,
  and that an observer failure cannot count as an observed negative control.

## 2. Make the task repeatable

- [ ] Freeze the actor's initial position, orientation, health, inventory,
  dimension, memory, skills, and task goal, along with the server/world pins.
  World-archive equality alone did not give equal fresh-player spawn positions
  in the historical qualification.
- [ ] Choose a small survival task with a server-checkable predicate and a
  bounded time budget. Include an impossible/no-action control.
- [ ] Supply a minimal redistributable fixture or precise fixture-generation
  recipe and expected starting-state hash. The private long-running world is
  not a public reproduction dependency to silently assume readers possess.
- [ ] Publish setup, versions, commands, expected failures, and hardware needs;
  verify them from a clean checkout without access to private logs or secrets.

## 3. Prespecify the model comparison

- [ ] Freeze local-only, frontier-assisted, and retained-improvement-without-
  frontier conditions before running them. Equalize starting state and declare
  exactly what memory/skills may persist between training and held-out tasks.
- [ ] Link each requested model name to its actual loaded immutable model,
  runtime settings, prompt/skill hashes, and available hardware.
- [ ] Set a finite pilot budget, trial count, ordering/seed policy, failure and
  exclusion rules, and uncertainty reporting before examining model outcomes.
- [ ] Count coaching, retries, failed attempts, evaluation calls, maintenance,
  and human/AI interventions. Report API spend and local compute time separately;
  any local dollar conversion must disclose its assumptions.
- [ ] Record held-out success after coaching is removed. Improved performance
  while a stronger model is present does not establish retained learning.

## 4. Release evidence readers can inspect

- [ ] Export a versioned, privacy-reviewed dataset with action/observation links,
  task and condition IDs, provenance, costs, interrupted/censored attempts, and
  explicit missing-data flags. Explain splits and permissible uses.
- [ ] Include an evaluator that recomputes results from the released evidence,
  checks hashes/schema, and rejects a supplied false-success example.
- [ ] Show trial counts, successes, failures, exclusions, and uncertainty together.
  A clip illustrates a run; it is not the denominator of a success rate.
- [ ] Update the README with the exact release tag, evidence links, reproducible
  commands, measured outcomes, and remaining limitations. Keep the live
  advancement scoreboard distinct from controlled experiment results.

The existing [movement case study](../pilot-client-qualification-results.md)
provides a concrete engineering result while these gates remain open. The
[study protocol](../pilot-study-protocol.md) describes the larger research
questions. No gate here authorizes a reset or restart of the live swarm.
