# Disconnect during a confirmed running action

The fixed-client supervisor now supports `failure_case="mid_action_disconnect"`.
After sending `begin`, it waits 200 ms, obtains a separate server observation
labelled `during`, then asks the private console to disconnect `PilotProbe`.
It records whether an action-completion message subsequently arrives and tries
to obtain terminal evidence. The fault trial always remains excluded from
benchmark success. If completion races ahead, the run must be retained as a
raced test, not silently counted as an established mid-action failure.

The observer accepts the explicit `during` phase without changing the scoring
contract: only correctly labelled before/terminal samples can score. An in-flight
position is evidence of progress, not task completion.

## Actual trials, 22 September 2026

[Derived records, timing and source/evidence pins](midaction-results-2026-09-22.json)
preserve all three attempts from fresh disposable copies with identical sources.

| Attempt | Case | Result |
| --- | --- | --- |
| 001 | Disconnect during action | Server-confirmed 0.550091-block progress; kick requested 243.509 ms after begin; no completion message; trial rejected |
| 002 | Forward control | Qualified movement in survival |
| 003 | Stationary control | Qualified zero movement in survival |

The fault's progress already exceeded the 0.5-block movement threshold. It still
received no score: only the ready message's 91 bytes arrived, the participant
exited 1, and the terminal observation failed because the actor was no longer
available. Paper's saved log records the deliberate kick. The retained `during`
sample cannot replace terminal evidence even if status and score are forged.

This verifies the failure timing using server-observed movement, supervisor
monotonic timing within the fixed one-second action, a server disconnect receipt,
participant protocol diagnostics and absent completion. It does not derive a
success claim from the child. The extra observation adds measurement overhead;
this is a qualification test, not a latency benchmark.

Java stopped normally in every case. The fault participant exited nonzero on its
own; no forced participant cleanup was required. All scopes and mounts cleaned
up, with effective limits verified and no memory/task limit violation. Result,
world metadata, terminal record, diagnostics and logs were checked after unmount,
and the source archive was rehashed unchanged. The failed trial's aggregate
scope validity is false because its worker correctly returns nonzero.

## Evidence-preserving storage recovery

Before these runs, eight completed images from the permission and game-mode
checks were verified unmounted and unused, then their zero-filled regions were
made sparse. This reclaimed 7,889,944,576 allocated bytes while preserving each
image's exact logical size and SHA-256 hash. Separate allocation ledgers are
included in the derived results; original run manifests remain historical.
Active trial reservation checks and the 40 GiB host reserve were unchanged.
Sparse archives are never treated as reserved writable runtime images.

## Remaining scope

This establishes one disconnect timing for a fixed deterministic client. It does
not cover all failure timings, death during action, a server crash, authentication
stalls or malicious clients. Keep mid-action samples distinct in future dataset
exports, and preserve interrupted trials rather than counting them as observed
negative controls. The live swarm, world, mode and GPU/model workload were not
changed. No learning, cost-saving or robotics-transfer result is claimed.
