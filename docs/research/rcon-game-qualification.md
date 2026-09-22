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
| 004 | Same-source stationary control after sparse archival | Qualified, zero movement; normal exits |

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

## Storage recovery and completed control

Attempt 003 was blocked with about 40.7 GiB free: a new 2 GiB image would breach
the existing 40 GiB host reserve. Its failed preparation record remains preserved.

After confirming attempts 001 and 002 were unmounted and not open by a process,
zero-filled regions in those completed images were converted into sparse regions
with `fallocate --dig-holes`. Each retained its exact 2,147,483,648-byte logical
size and original SHA-256 hash. Each released 986,243,072 allocated bytes, a total
of 1,972,486,144 bytes (about 1.84 GiB). The allocation ledger is included in the
derived evidence. No world, log or image content was removed.

This allowed attempt 004 to run with the same captured sources and full 2 GiB
runtime reservation. It recorded zero movement in survival, exited normally and
cleaned up its scope and mount. The post-action fault/forward/stationary set is
now complete; the earlier blocked attempt remains in the denominator of attempts.

Sparse archival is only for completed evidence images. Original run manifests
retain the allocated-byte counts measured at shutdown; the separate archive
ledger records the later allocation change. Hash verification establishes byte
identity, not current disk reservation. A sparse archive must never be treated
as a fully reserved writable trial image. Active runtime allocation checks and
the 40 GiB reserve were not changed. Host headroom remains limited, so further
trials need additional archival or storage capacity.

## Scope

This is a post-action withheld RCON response with a real game server, not an
internal Paper deadlock, authentication failure or mid-action outage. Unit tests
also cover frame limits, cancellation and the fixed endpoint selection. The
[transport-level regression](rcon-stall-qualification.md) continues in CI.

Next: qualify remaining mid-action faults and prepare redistributable reproduction
inputs. The live swarm, mode, world and GPU/model workload were untouched. No
model performance, learning, cost advantage or robotics transfer was measured.
