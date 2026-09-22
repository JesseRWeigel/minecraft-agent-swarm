# First benchmark release: acceptance checklist

Updated 22 September 2026. This is a release gate, not a list of achieved results.
The first release should be a small audited experiment, not a claim that every
Minecraft advancement is a comparable benchmark task.

Current checkpoint: the [complete fixed-client path](protected-movement-qualification.md)
has passed two real forward checks and two stationary controls from a checked
actor baseline. A failed setup attempt is preserved too. Component/namespace
checks are green, but the remaining combined gates below are deliberately open:
remaining game failure timings/RCON stalls, arbitrary-code resource/network boundaries, actor
permissions, redistributable reproduction inputs, and model comparison design.

The [post-action failure checks](protected-movement-qualification.md#post-action-failure-checks-21-september-follow-up)
now cover death, disconnect and a suspended-observer parent timeout in real
isolated game runs. All were rejected; no missing sample became a negative
control. A [real TCP RCON stall test](rcon-stall-qualification.md) now retains
partial timeout evidence. A [Paper reply-withholding follow-up](rcon-game-qualification.md)
now rejects the fault and passes both forward and stationary controls. The
initially storage-blocked stationary attempt remains preserved; a repeat passed
after lossless sparse archival. A [mid-action disconnect](midaction-qualification.md)
now has server-observed progress, absent completion and both controls. Other
mid-action failure types and timings remain open.

[Kernel resource probes](resource-enforcement.md) verify scoped memory, PID and
CPU enforcement on WSL. [Whole-trial integration](scoped-trials.md) now has
fixed-client controls and an OOM rejection case. [Bounded persistent storage](bounded-storage.md)
now caps the runtime image. [Post-action disk exhaustion](disk-full-qualification.md)
now rejects missing terminal evidence with preserved partial records.
[Fixed actor admission](actor-identity.md) now checks the login UUID and server
roster. Permissions and other failure timings remain pending; the combined box stays open.

## 1. Finish the deterministic path

- [ ] Complete resource/network gates around the connected protected participant,
  bounded pipes, observer process and outer worker. Fixed-client namespaces hide
  credentials/world/evidence and bound pipes, lifetime and scratch; aggregate
  memory/PID/CPU limits cover the launched fixed-client tree and a fixed-capacity
  image bounds runtime writes. Post-action disk exhaustion is qualified at one
  timing; broader storage failures and actor permissions remain. The current
  [game-only network bridge](game-only-network.md) has its own qualification; it
  now admits only the fixed actor, but does not constrain later game-protocol actions.
- [x] Capture and pin the current no-respawn client and executed qualification sources.
  Never overwrite the snapshots used for the historical movement case study.
- [ ] Run forward movement and stationary controls through the complete path,
  plus death, disconnect, malformed-message, stalled-process, and observer-timeout
  cases. Preserve partial evidence and every failed attempt.
- [ ] Verify actor roster, identity, permissions, and joins/reconnects. An offline
  login username alone is not an identity boundary against arbitrary code. Fixed
  login name/UUID admission, one-use transport and server UUID/roster snapshots
  are qualified. [Survival-mode scoring](game-mode-qualification.md) rejects a
  trusted post-action creative-mode injection. [Two player-command probes](permission-qualification.md)
  now have server receipts and an operator-authorized positive control. Broader
  permission escalation and adversarial game behavior remain open.
- [ ] Demonstrate that participant-written success claims cannot affect scoring,
  and that an observer failure cannot count as an observed negative control.

## 2. Make the task repeatable

- [ ] Freeze the actor's initial position, orientation, health, inventory,
  dimension, memory, skills, and task goal, along with the server/world pins.
  World-archive equality alone did not give equal fresh-player spawn positions
  in the historical qualification.
- [ ] Choose a small survival task with a server-checkable predicate and a
  bounded time budget. Include an impossible/no-action control. The
  [oak-log acquisition design](first-survival-task.md) specifies the next task;
  its [integrated fixed client](oak-game-qualification.md) now passes collection
  and no-action controls. [Follow-up controls](oak-negative-controls.md) now cover
  breaking without collection and approaching a bedrock-enclosed target. The
  [fault checks](oak-fault-qualification.md) now reject injected progress and one
  missing terminal observer. Mid-action interruptions and the remaining failure
  matrix stay open, so this gate is not complete.
- [x] Supply a minimal redistributable fixture or precise fixture-generation
  recipe and expected starting-state hash. The [fresh-world recipe](fresh-fixture.md)
  has one generated archive and both controls qualified without private-world input.
  Published hashes identify that instance; regenerated UUIDs/timestamps may differ.
  Independent clean-host reproduction remains the next unchecked gate.
- [ ] Publish setup, versions, commands, expected failures, and hardware needs;
  verify them from a clean checkout without access to private logs or secrets.
  [Same-host clean-checkout reproduction](clean-checkout-reproduction.md) now passes
  generation and both controls with fresh dependencies. Host prerequisite setup
  and independent-machine portability remain unverified, so this gate stays open.

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
