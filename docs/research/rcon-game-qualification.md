# RCON reply stall during an isolated Paper trial

A trusted fault proxy now permits testing a stalled observer reply while the
actual Paper server and participant run in the disposable trial. It binds only
127.0.0.1:25596 inside the outer private network and forwards only authentication
and the fixed position/dimension queries to the private RCON endpoint. It passes
the position reply and deliberately withholds the dimension reply. Frame sizes,
connection count, I/O and lifetime are bounded. Neither raw authentication data
nor reply bodies enter its receipt.

Only the trusted terminal fault phase selects this fixed endpoint; normal
observations still use 25595. The participant remains in its separate game-only
network. The fault is selected with `failure_case="rcon_stall"` in the explicit
protected launcher and can never be a successful benchmark trial.

## Evidence on 22 September 2026

[All attempts and source/evidence hashes](rcon-game-results-2026-09-22.json):

| Attempt | Case | Result |
| --- | --- | --- |
| 001 | Post-action RCON reply stall | Authenticated; both queries reached Paper; a 77-byte dimension reply was withheld; observer timed out at about 5 seconds, retaining position |
| 002 | Same-source ordinary forward control | Qualified, 3.797923 blocks |
| 003 | Same-source stationary control | Blocked before game launch by storage reserve; no gameplay result |

The failed terminal record is preserved separately as `observer-terminal.json`.
It contains a completed position and a timed-out dimension query, with nonzero
observer exit, rather than a complete terminal sample. The worker's terminal and
score fields stay null. A forged success label, clean lifecycle claim and success
score cannot make the partial sample pass host validation.

The derived fault assessment requires the proxy receipt to show authentication,
exactly the two fixed queries, `reply_withheld`, an actual captured reply length,
observer disconnect and confirmed proxy cleanup. Failure status alone is not
proof that the intended fault happened. These conditions were checked against
the retained result and post-unmount observer record.

In the fault trial, the waiting participant required forced cleanup; Java stopped
normally. The forward control exited normally. Both launched trials cleaned up
their scopes and mounts, with effective limits verified and no memory/task-limit
violation. The fault's aggregate scope validity is false because the worker
correctly exits nonzero. Persisted results, partial observations, world metadata
and images were rehashed; the source archive was unchanged.

## Incomplete control and storage limit

The host had about 40.7 GiB available when the final control was attempted. A
new 2 GiB image would breach the existing 40 GiB free-space reserve. Preparation
stopped before creating an image or launching Minecraft. The failed attempt's
manifest/summary remain preserved; no evidence was deleted and the reserve was
not lowered. The new-source stationary control is still required. Older controls
retain their own source pins and are not substitutes for this missing control.

## Scope

This is a post-action withheld RCON response with a real game server, not an
internal Paper deadlock, authentication failure or mid-action outage. Unit tests
also cover frame limits, cancellation and the fixed endpoint selection. The
[transport-level regression](rcon-stall-qualification.md) continues in CI.

Next: restore adequate storage headroom, repeat the stationary control, then
qualify remaining mid-action faults and prepare redistributable reproduction
inputs. The live swarm, mode, world and GPU/model workload were untouched. No
model performance, learning, cost advantage or robotics transfer was measured.
