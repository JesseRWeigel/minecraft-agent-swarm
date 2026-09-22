# Oak action interruption

On 22 September 2026, an isolated fixed-client oak trial was disconnected after
the supervisor sent begin and before any action-completion message was received.
The runner rejected it with no terminal sample and no score. Fresh collection and
no-action controls passed on the same captured sources; one earlier no-action
control failed during bridge finalization and remains preserved.

| Attempt | Case | Endpoint | Runner verdict |
| --- | --- | --- | --- |
| 001 | Disconnect during action window | unavailable | rejected; no completion |
| 002 | Ordinary collection | acquired | qualified |
| 003 | No action; bridge shutdown failed | not acquired | rejected lifecycle |
| 004 | Unchanged no-action repeat | not acquired | qualified negative control |

[All four attempts and evidence pins](oak-interruption-results-2026-09-22.json)
are retained. There are two passing controls, one deliberate fault and one
unexpected lifecycle failure; the repeat does not erase the failure.

## What was observed

The supervisor waited 200 ms after sending begin, then took a protected `during`
observation. The server reported an intact oak log, empty inventory, survival
mode, health 20, and the expected actor/roster. The fixed kick helper was requested
286.9 ms after begin. Its receipt records the sole command
`kick PilotProbe Oak qualification disconnect`; the saved server log contains
the disconnect reason. No `action_finished` message was received. The participant
exited 1 without forced cleanup, Java exited 0 normally, and scope/storage cleanup
were confirmed. The terminal observer's failed partial record is preserved.

This proves interruption within the begun action window before protocol completion.
It does not prove the precise mining-start instant, or absence of mutations in the
interval between the pre-kick sample and the kick. The implementation preserves a
raced completion if one arrives; such an attempt must be reported as inconclusive
for mid-action timing, never as a confirmed interruption. The internal stage label
alone is insufficient evidence.

`sampleOakTask` now supports `during` observations, but the endpoint scorer still
requires `before` and `terminal`: supplying a `during` sample as terminal input
is rejected. The host captures the during receipt and its hash. This
report's export additionally checks its zero exit/no-error, payload equality with
the worker result, and ordering relative to the kick receipt and terminal observer.
All fault runs remain categorically excluded from qualified trials.

## Unexpected bridge failure

Attempt 003 reached valid terminal observation and reported action completion,
but the participant bridge exited 1 during finalization. Its bounded diagnostic
was `participant bridge failed`; the outer bridge also recorded `failed`. Java
stopped normally, and storage/resource cleanup completed. The endpoint remained
an observed no-acquisition result, but the overall trial was correctly rejected.

The unchanged repeat passed. This does not resolve the cause. Preserve the failed
runtime image and add bounded relay error/stage diagnostics before model trials;
do not weaken the requirement for normal completion to make the failure disappear.

## Reproduction and next step

Use the [oak launcher recipe](oak-game-qualification.md) with `control_mode="forward"`
and `failure_case="mid_action_disconnect"` in a fresh workspace. Require the
specific receipts and absent completion to establish an interruption; a generic
failed status is not enough. Repeat `forward`/`stationary` with `failure_case="none"`.
All four source manifests match, and source/archive/runtime-image hashes and saved
observer/result/world records were checked after unmount. The source world was
unchanged. Closed images were sparsified only after verified cleanup, with unchanged
logical contents and SHA-256 hashes; no disk reserve was lowered.

Next is the [bounded model action interface](model-action-adapter-plan.md), preceded
by better bridge diagnostics and followed by scripted game qualification. No model
or GPU calls, live-world changes or live-swarm restarts occurred. This is a fixed
client result, not model learning, cost savings, or robotics transfer.

Validation: 131 pilot JavaScript tests and 374 Python tests passed locally,
including four explicit real namespace checks.
