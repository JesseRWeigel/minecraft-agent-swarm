# Bridge diagnostics and first model-action component

Updated 22 September 2026. The intermittent bridge shutdown failure from the
[oak interruption batch](oak-interruption-qualification.md) remains unresolved.
This change improves the evidence available on the next failure; it does not turn
resets, incomplete drains or timeouts into successful shutdowns.

## Relay evidence

The relay preserves the original exception while attaching bounded metadata:
failed operation (`read`, `write`, `half_close`, `select`, `setup`, or `deadline`),
left/right side, exception class, numeric errno, EOF flags, pending-buffer byte
counts and successfully transferred byte counts. It never includes packet bytes,
exception messages, credential values or arbitrary paths.

The outer bridge records the phase (accept/login/connect/login-forward/relay) and
these diagnostics. Both inner bridge launchers now emit their bounded relay state
when the relay fails while the Node child is still running. Previously that branch
emitted only the generic `participant bridge failed`, losing the socket error.
Normal completion still requires EOF and fully drained buffers, normal child exit,
and the existing observer/resource/storage checks.

Socket tests establish that a real TCP reset remains a `ConnectionResetError` with
read direction and `ECONNRESET`, a broken write retains the pending-byte count, and
an idle deadline remains a timeout. These tests identify diagnostic behavior; they
do not identify which error caused the historical game failure.

One new [isolated no-action game](bridge-diagnostics-results-2026-09-22.json) passed
with normal exits, completed bridge, empty participant stderr and verified cleanup.
Sources, all observer records, result/world files and the unmounted image were
rehashed. The intermittent failure did not reproduce in that run. No historical
failed attempt was changed, no failure gate weakened, and no live swarm changed.

## Offline action-request parser

`tools/pilot/model-action-schema.mjs` exports `parseModelActionRequest(raw)`.
It accepts UTF-8 bytes or a string, up to 4096 encoded bytes, and returns validated
plain JSON data. Binary length is checked before copying. Errors are generic and
never echo model input. Duplicate keys, including escaped duplicate spellings,
extra fields, wrong fixed IDs, invalid sequences, unknown actions, coercion and
out-of-range values are rejected.

```json
{"schema_version":1,"trial_id":"collect-oak-log-v1","action_id":"collect-01","sequence":1,"action":{"kind":"move","direction":"forward","ticks":10}}
```

Supported action shapes are observe/finish, look with bounded yaw/pitch, move with
one of forward/back/left/right and 1-20 ticks, and dig with integer world coordinates.
Sequence must be 1-25. This stateless parser does not enforce cross-request ordering,
actual reach/visibility, cumulative action/time budgets or cancellation. It executes
nothing and is not yet mounted into a game participant or connected to a model.
Duplicate-key rejection is conservative across the whole request; the current
root/action schemas have disjoint field names. Revisit this if future schemas
allow repeated field names in different nested objects.

The next implementation is the stateful broker from the
[model-action plan](model-action-adapter-plan.md): one action at a time, exact next
sequence, bounded observations, reach/diggability checks, and cancellation that
prevents late actions from resuming movement. Qualify a scripted sequence through
that broker before model inference. Keep investigating bridge shutdown failures
using the added diagnostics before collecting model comparison results.

Validation: 136 pilot JavaScript tests (including five parser tests) and 376 Python
tests passed locally, including four explicit real namespace checks. Parser tests
are also configured in the Node 20/22 CI matrix. No model/GPU calls were made.
