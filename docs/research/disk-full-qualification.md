# Disk exhaustion while the game server is running

On 22 September 2026, the protected fixed-client path rejected a real disk-full
attempt after its action completed. Its earlier observation and a separate fault
receipt survived; its terminal observation record was unavailable and its score
remained null. This is an infrastructure result, not a model benchmark.

## Mechanism

Use the existing explicit protected launch with `failure_case="disk_full"`, a
fresh workspace, pinned inputs, and the [bounded storage prerequisites](bounded-storage.md).
Normal swarm startup never invokes this path.

The trusted worker requires a running server after `action_finished`. It fills
only the disposable image, first with 1 MiB writes, then 4096-byte writes, then
one-byte appends. Only an actual `ENOSPC` on the smallest write counts as an
injected fault. Filling has a 4 GiB write ceiling and a 30-second deadline,
within the existing whole-trial process deadline. The filler is retained.
The worker verifies the runtime is on a bounded FUSE ext4 filesystem before
writing. Open, flush and other I/O failures remain failed injections.

Before launch, the host creates a private 4096-byte receipt outside the image and
binds only that file into the trusted outer namespace. It is absent from the
participant namespace. Requested/final records overwrite the existing bytes
without truncating or growing the file. The reader checks size, ownership,
schema, duplicate keys, numeric types and timing. This narrow trusted-code write
is not an arbitrary-code host filesystem quota.

The host reads that receipt independently of the game's result file and retains
available before/terminal records with hashes. Missing or invalid records remain
explicit. The evaluator always excludes deliberately faulted attempts and still
checks observation validity and process cleanup.

## Preserved attempts

[Complete derived evidence and source pins](disk-full-results-2026-09-22.json):

| Attempt | Case | Outcome |
| --- | --- | --- |
| 001 | Earlier large-write-only injector | Large allocation hit ENOSPC, but small evidence writes survived; rejected as a faulted trial |
| 002 | Final injector through one-byte ENOSPC | Terminal record unavailable, null score, rejected; earlier observation and receipt preserved |
| 003 | Same-source forward control | Qualified, 4.313427 blocks |
| 004 | Same-source stationary control | Qualified negative control, zero movement |

Attempt 001 is retained because large allocation failure alone did not establish
small-write exhaustion. Attempt 002 wrote 1,301,426,177 filler bytes before the
final failure, taking about 7.13 seconds. Its participant required forced cleanup
(exit -9); Java accepted the stop command and exited 0. The scope and image mount
cleaned up. The later result file survived shutdown, but the unavailable terminal
record was not reconstructed or treated as a successful negative control.

As a separate evaluator check, changing that failed result's status to qualified
and removing its fault label still produces rejection. Its missing observation,
error and forced participant cleanup are independently disqualifying.

All four image hashes were verified after unmounting. Read-only extraction
recovered the retained result, world metadata and available observer records
with their captured hashes. The original source archive was rehashed unchanged.
No live swarm mode, world, process or model workload was modified.

## Limits and next gates

This fault is after the action, while the server is running, rather than during
the movement itself. It covers one timing and Linux/FUSE/Paper configuration.
It does not establish detection of every transient disk error, sustained full-disk
behavior, or semantic consistency of all world regions after failed saves.
Private images and logs remain preserved, not publicly redistributed.

Actor identity, remaining mid-action failures and RCON stalls, a redistributable
fixture, and prespecified model comparisons remain open. The full
[benchmark release checklist](benchmark-release-checklist.md) is not complete.
