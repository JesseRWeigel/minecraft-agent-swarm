# Scripted actions through the model-facing interface

On 22 September 2026, an explicit primitive script mined and collected an oak log
through the bounded action interface in an isolated Paper world. A stationary
control collected nothing. Both used identical captured source, world snapshot,
server JAR and client-tool hashes. No model or GPU inference was used.

[Machine-readable evidence and action traces](scripted-oak-results-2026-09-22.json)
include the initial failed startup attempt, the two qualified controls, source and
input pins, server observations, lifecycle outcomes, and hashes of records checked
again from the closed storage images.

| Trial | Requests | Action exchange duration | Independent server outcome | Lifecycle and reply EOF |
| --- | ---: | ---: | --- | --- |
| Collection | 7 | 4.047 seconds | One oak log collected; target removed | Verified |
| Stationary | 2 | 0.002 seconds | Empty inventory; target intact; position unchanged | Verified |

Durations exclude server startup and terminal observation. They describe a fixed
script with no inference latency, not model speed or a statistical success rate.
There is one qualified example of each control on one WSL host.

## What ran

The supervisor sends ordinary JSON requests over dedicated pipes: observe, look
down toward the target, dig the explicit block at `(0, 200, 3)`, look forward,
move forward for 20 nominal ticks, observe again, and finish. The participant
executes the same strict schema/session that a future model coordinator will use.
There is no composite action that automatically solves collection. The stationary
control sends only observe and finish.

The script starts only after the independently verified fixture and baseline.
The coordinator sends one request at a time, bounds requests/replies/count/time,
rejects malformed or duplicate-key replies, and closes request input after sending
finish. It retains bounded request/reply records and monotonic timings. Following
trusted lifecycle finalization and child exit, a separate EOF check rejects any
trailing reply bytes.

Qualification requires all of the following: the exact declared script and ordered
responses, clean action EOF, participant lifecycle completion, clean process and
resource cleanup, matching immutable action/observer records, and the independently
recomputed server endpoint. An item claim in an advisory bot observation cannot
supply a score. A failed script cannot be promoted by an apparently successful
terminal inventory. The host hashes `action-script.json` and requires it to match
the worker's receipt before accepting the trial.

## Startup failure and correction

The first attempt failed before a bot connected and was preserved without a score.
A separate no-server namespace reproduction showed that asynchronous import exposed
an incomplete Mineflayer CommonJS API while action streams were open. Loading the
CommonJS entry directly with `createRequire` returned the required API and allowed
both subsequent game controls to complete. The low-level import interaction is not
claimed to be fully explained.

A regression now loads the real dependency with action pipes inside a private
network namespace, checks that startup reaches the participant rather than failing
to load dependencies, and expects connection refusal because no server is running.
CI runs this check on Node 20 and 22. Startup errors expose only a bounded stage and
error code, never raw exception text or model requests.

## Reproduction and next gate

Use the pinned inputs and environment from the
[clean-checkout reproduction](clean-checkout-reproduction.md) and the existing
[oak qualification recipe](oak-game-qualification.md). Call
`run_oak_qualification(..., launch=True, action_driver="scripted", control_mode="forward")`
in a fresh attempt directory, then repeat with `control_mode="stationary"` in a
second fresh directory. The scripted driver accepts only these two controls and
`failure_case="none"` for ordinary controls. The forward scripted driver also
accepts the explicit `scripted_deadline` fault described below. Existing fixed-client
mode remains the default. Storage
reserve, resource containment and world-copy requirements still apply.

The [deadline-limited interruption check](scripted-deadline-qualification.md) now
rejects an incomplete scripted dig and includes fresh same-source controls.
Investigate the historical intermittent bridge shutdown failure before
comparative model trials. Then freeze inference/time/token budgets and study
conditions before connecting models. These results establish a working interface
and auditable scripted trajectory, not learning, cost savings or robotics transfer.
