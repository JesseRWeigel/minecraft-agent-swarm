# Resource-scoped fixed-client trials

Status, 22 September 2026 UTC: `run_protected_qualification` now requires a
verified transient systemd user scope around the complete launched game process
tree. It fails closed if the manager/controllers are unavailable. This covers
the server, nested participant, game bridge and trusted observers, not the live
swarm. Input restore and source capture occur before scope launch and are outside
this budget. The current launcher also requires [bounded persistent storage](bounded-storage.md);
the historical scope attempts below predate that integration.

## Policy and evidence

The default `resource_profile="game"` sets aggregate memory to 4 GiB, disables
swap, caps tasks at 256 and CPU at 200% of one core. The existing host deadline
is 180 seconds; the scope also has a configured 210-second runtime limit.
`OOMPolicy=stop` terminates the trial tree on OOM. Unlike the earlier synthetic
probe, the production path does not keep running to rescue its recorder.

The host captures the scope worker and exact launch configuration outside all
game mounts. Before spawning Bubblewrap, the worker confirms its cgroup identity
and reads effective memory/swap/PID/CPU limits. Its start report binds both source
and configuration SHA-256 values. The host recomputes those checks, requires a
matching end report, normal exit, no memory/PID-limit events, and confirmed scope
cleanup. CPU throttling is expected under the quota and is recorded, not treated
as a violation. Missing or malformed reports cannot qualify a trial.

The wrapper validates its own systemd and Python executables. Neither the cgroup
filesystem nor user-manager socket is mounted into the participant. Existing
network, process, mount and credential separation remains in force. This is an
aggregate trial budget, not a per-agent allocation or game identity boundary.

The explicit `resource_profile="memory_failure"` is a qualification-only 128 MiB
profile and can never yield a successful trial. It retains other profile limits.
No arbitrary budget/command override is exposed by the protected game API.

## Actual game qualification

[All six attempts](scoped-trial-results-2026-09-22.json) are retained:

| Attempt | Case | Outcome |
| --- | --- | --- |
| 001 | Forward, 4 GiB | Movement succeeded, but participant exit 1 caused rejection; cause unresolved |
| 002 | Forward, 4 GiB | Qualified, 3.797923 blocks |
| 003 | Forward, final sources | Qualified, 3.582064 blocks |
| 004 | Stationary, final sources | Valid negative control, zero movement |
| 005 | 128 MiB game launch, final sources | Rejected; systemd `oom-kill`, no end/game result, cleanup confirmed |
| 006 | Forward repeat, final sources | Qualified, 4.153332 blocks |

The four successful trials have matching effective limits before/after, no
memory/PID-limit violations, normal participant and Java exits, and scope cleanup.
All six have confirmed scope cleanup. The OOM case was terminated, not a normal
Java shutdown, and its missing completion records remain missing.

Attempt 001 predates bounded participant shutdown diagnostics and configuration
hash binding. Its failure is not diagnosed or declared fixed. Later successes
are not proof of a repair. Diagnostic writes are guarded so their failure cannot
skip cleanup. Wall-clock movement spans variable server tick counts, particularly
under CPU contention; these distances are infrastructure checks, not comparative
model scores.

No live swarm state/process was changed, no model ran, and the original world
archive was rehashed unchanged. Published JSON is derived from preserved private
evidence, not a public world/raw-log release or independent reproduction.

## Reproduction and remaining work

Use the existing explicit launch API with fresh workspace and pinned local
inputs from [movement qualification](protected-movement-qualification.md). A
working systemd user manager and cgroup v2 controllers are now required. Ordinary
unit tests do not launch scopes or games:

```sh
python3 -m unittest tools.pilot.test_scoped_trial tools.pilot.test_protected_worker
```

The [synthetic resource probe](resource-enforcement.md) separately verifies local
controller support. Game-sized budgets, controller events and all failures must
remain part of any benchmark condition. The current storage dependency and fresh fixed-capacity image are described in
[bounded storage](bounded-storage.md). Complete actor identity and remaining fault
cases before arbitrary model-generated code.
GPU memory, inference-token budgets and per-agent fairness are not established
by this cgroup scope. Investigate any recurring participant shutdown failure using
the retained diagnostics before a model comparison.
