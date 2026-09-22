# Oak fault-injection qualification

Five real isolated Paper trials on 22 September 2026 used matching captured
sources and the same pinned fresh-world archive. Three deliberately faulty trials
were rejected; collection and no-action controls passed. One additional launch
was blocked before world restore by the host disk-reserve guard and is preserved.
No model calls, GPU inference or live-swarm/world changes were made.

| Attempt | Case | Endpoint acquisition | Runner verdict |
| --- | --- | --- | --- |
| 001 | Grant one log, leave target intact | false | rejected |
| 002 | Grant one log, remove target via trusted command | true | rejected intervention |
| 003 | Suspend terminal observer after ordinary collection | unavailable | rejected missing evidence |
| 004 | Collection launch blocked before restore | unavailable | preparation failed; no game launched |
| 005 | Ordinary mine and collect | true | qualified |
| 006 | No action | false | qualified negative control |

[Derived evidence](oak-fault-results-2026-09-22.json) contains every attempt,
including command receipt metadata, all three observer process receipts, host
scores, source/input hashes and cleanup records. Failed trials are not omitted
from the denominator. There is one run per case, not a model success-rate estimate.

## The important limit exposed by the injection

A server-observed final state is not proof of how that state was reached. In
attempt 002, the trusted fault helper granted an oak log and removed the target.
The ordinary endpoint predicate returned `acquired: true`, just as it would after
real mining and collection. It still returned `gameplayQualified: false`.
The runner rejected the trial using the independently selected fault mode and
preserved intervention records. This is expected behavior, not a qualified success.

The helper has two fixed command sequences, accepts no arbitrary command or
endpoint, receives the private RCON credential through stdin, and is not mounted
into the participant namespace. The exported audit checks helper exit/error,
completed mode, exact issued commands and their resulting server-observed state.
The host retains and hashes the helper receipt; it does not certify that a command
had an effect from a nonempty reply alone. The terminal observations establish
one granted log with either an intact or removed target.

Host acceptance also rejects a non-null injection payload even if the worker
failure label is removed, and rejects the presence of the separate injection
receipt. None of these controls proves safety against a compromised trusted
supervisor that rewrites all provenance. Participant isolation and trusted
intervention provenance remain part of the claim.

## Missing evidence and receipt binding

The terminal observer in attempt 003 was suspended and killed by the parent's
two-second deadline. Its failed process receipt was preserved; terminal sample
and host score were absent. The participant required forced cleanup, Java stopped
normally, and resource scope/storage cleanup were confirmed. This tests one
post-action observer fault, not every mid-action or server failure.

The host now reads and hashes `observer-fixture.json`, `observer-before.json` and
`observer-terminal.json` directly. Each must have an integer zero exit code, no
capture error, and a payload identical to the worker's copied result. Missing,
altered or failed receipts reject qualification. Regression tests exercise each
phase, malformed receipts and removal of injection labels.

Fault workers intentionally exit nonzero, so their aggregate resource validity
is false. Their recorded resource limits were verified, no limit violations were
observed, and cleanup was confirmed. The two normal controls had normal client
and Java exits and passed all resource/storage gates. Closed-image evidence was
rehashed and recovered after unmount; sparse archival kept logical bytes and
SHA-256 hashes unchanged. The 40-GiB host reserve was not lowered.

## Reproduce and continue

Use the [oak launcher recipe](oak-game-qualification.md) with a fresh workspace:

| `control_mode` | `failure_case` | Expected runner status |
| --- | --- | --- |
| `stationary` | `item_only` | `failed` |
| `stationary` | `item_and_block` | `failed` |
| `forward` | `observer_timeout` | `failed` |
| `forward` | `none` | `qualified` |
| `stationary` | `none` | `qualified` |

Invalid fault/client pairings are rejected before workspace creation. Inspect
receipts and terminal state to establish that a fault actually occurred; a generic
failed status alone is insufficient.

Next are a mid-action oak interruption, stronger arena verification and a bounded
model-facing action adapter. The results do not establish learning, coaching cost
savings, robotics transfer or arbitrary-agent containment.

Validation: 129 pilot JavaScript tests and 374 Python tests passed locally,
including four explicit real namespace checks. CI runs Node 20 and 22.
