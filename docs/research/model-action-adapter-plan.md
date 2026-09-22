# First model-facing action adapter

Status: the strict parser, [bounded action session and dedicated pipe channel](model-action-session.md)
are implemented and tested offline, including the participant lifecycle, real
subprocess pipes and production namespace descriptor forwarding. The outer supervisor now coordinates
[qualified scripted collection and stationary controls](scripted-oak-qualification.md).
Interrupted scripted-game qualification and model experiments remain planned. The deterministic
[oak controls](oak-game-qualification.md), [fault checks](oak-fault-qualification.md)
and [interruption check](oak-interruption-qualification.md) establish the current
starting point. Do not keep adding unrelated fault cases before building this
bounded interface; qualify the new interface with a scripted action sequence first.

## Smallest useful interface

A broker in the existing participant namespace owns Mineflayer. A separate trusted
coordinator sends strict JSON actions over bounded pipes. Model output is data:
no generated JavaScript, shell commands, filesystem paths, RCON, chat commands,
pathfinding or item manipulation. Keep model traffic separate from the supervisor's
ready/begin/action-finished/finalize protocol; model text cannot advance those phases.

Requests carry schema version, fixed trial/action IDs, a monotonically increasing
sequence and exactly one action. Reject duplicate keys, extra fields, wrong IDs,
non-finite numbers, oversized messages, overlapping actions and replayed sequences.

| Action | Inputs and initial caps | Behavior |
| --- | --- | --- |
| `observe` | No arguments | Capped local bot state and at most one cursor-visible block |
| `look` | Finite yaw/pitch in declared radian ranges | Change orientation only |
| `move` | One enum direction; integer 1-20 ticks | Hold one control, then clear it, at most one second nominal duration |
| `dig` | Explicit integer block coordinate, within 4.5 blocks | Verify actual reach, visibility and diggability; dig only that current block |
| `finish` | No arguments | End action session; supervisor obtains independent terminal evidence |

Do not expose a `collect_oak_log` action that solves the task on the model's behalf.
The model should select the block, mine it, and move to collect its drop. Inventory
and block observations sent to the model are labeled `source: participant_bot` and
are advisory. Only protected server-RCON observations determine the final score.

Use a separate six-second dig deadline: the measured barehanded oak action takes
roughly three seconds, so a universal two-second timeout would make it impossible.
Use shorter bounds for look/observe and movement. A provisional adapter replay cap
is 25 actions within the existing 20-second fixed-client action window; reject
instead of silently extending it. Model inference budgets are a separate decision:
freeze and qualify a revised session/transport/whole-trial budget before real model
calls, including input/output token caps and treatment of latency/timeouts.

Bounded bridge shutdown diagnostics are now implemented. Before model trials, investigate
the preserved intermittent finalization failure from the interruption control set.
A passing repeat is not a root-cause fix. Broker unit work can proceed in parallel.

## Two implementation milestones

1. Offline milestone implemented and tested: the broker, strict schemas, bounded observation serialization and
   cleanup, with fake-bot/real-pipe tests without models or GPU use. A timeout,
   disconnect or malformed request clears controls and closes the bot. Late dig
   resolution cannot start subsequent movement. Partial transcripts are preserved.
2. Replay explicit observe/look/dig/move/finish actions through the isolated game
   runner, with positive/no-action controls, bad-action rejection and interruption.
   Capture source hashes and per-action request/start/end/failure records. Only then
   wire a model coordinator and prespecify the first small model comparison.

## Acceptance checks

- Invalid or oversized requests are rejected before invoking Mineflayer; no data
  path reaches RCON, chat, arbitrary code execution or host files.
- Dig requires the explicit currently visible reachable block; stale, out-of-range,
  undiggable and occluded targets fail with bounded diagnostics.
- Sequence, byte, action-count and elapsed-time limits hold across the whole session.
- Timeouts and disconnects stop controls; late asynchronous completions cannot resume
  the action or emit a valid session completion.
- A modified model transcript or claimed success cannot change the independent
  server score. Missing terminal evidence remains invalid.
- A scripted multi-action collection succeeds under the same broker the model will
  use, with all source/input pins and clean lifecycle checks.

## Later research gates

Before evaluating models, freeze local-only, frontier-assisted and retained-memory
conditions, record the actual loaded model/runtime/prompt hashes, count retries and
coaching costs, and declare development versus held-out tasks. One visible oak log
is a small adapter smoke test, not a sufficient learning benchmark. Broader arena
verification, task variants and independent-machine reproduction remain useful;
richer perception and transcript hash chains can follow the first useful adapter.
