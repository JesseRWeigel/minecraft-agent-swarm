# Resource enforcement qualification

Status, 22 September 2026 UTC: real synthetic kernel enforcement is verified on
the development WSL host. **The subsequent [game launcher integration](scoped-trials.md) now applies verified whole-trial scopes.**
The original synthetic evidence below informed that implementation; it does not qualify arbitrary agents or approve attempts to
run arbitrary model-generated code.

The host supports cgroup v2 and transient systemd user scopes without changing
system settings or requiring root. `tools/pilot/resource_probe.py` creates a new
uniquely named scope for each fixed scenario, verifies effective kernel limits
before any workload, and checks cleanup after stopping only that scope.

## Measured results

Final limits were 128 MiB aggregate memory, zero swap, 16 tasks and 25% of one CPU
core (25,000 microseconds per 100,000-microsecond period), with a 15-second scope
runtime limit. The final four scenarios all passed:

- Baseline: effective controller values matched the requested policy.
- Memory: a child attempting a 256 MiB allocation received SIGKILL and the scoped
  `memory.events` OOM-kill counter increased. The child remained in the same
  cgroup after `setsid()`, which changes process/session membership but does not
  remove cgroup membership.
- PID/task count: 15 children were created alongside the recorder; the next fork
  returned EAGAIN and `pids.events` recorded enforcement.
- CPU: a 1.5-second busy loop triggered 16 throttled periods. This establishes
  quota enforcement, not a performance or cost comparison.

[All twelve retained scenarios](resource-enforcement-results-2026-09-22.json)
include three development batches. In the first memory test, systemd's default
`OOMPolicy=stop` terminated the recorder after the child OOM; manager inspection
reported `Result=oom-kill`. The diagnostic probe now explicitly uses
`OOMPolicy=continue` so its recorder can retain the child's exit and kernel
counters. That policy is specific to the probe. A production trial must fail on
OOM/PID-limit violations and terminate the contained workload.

## Reproduce without launching Minecraft

On a Linux/WSL host with cgroup v2, a working systemd user manager and the relevant
controllers delegated to it:

```sh
python3 -m unittest tools.pilot.test_resource_probe
python3 -m tools.pilot.resource_probe --launch --output /absolute/new/probe-directory
```

The explicit launch performs bounded memory, fork and CPU pressure within the
verified scopes. It never starts a game or model. Output directories must be new;
records and failed attempts are not overwritten. Normal unit-test discovery does
not run kernel pressure probes, and ordinary CI therefore does not establish
host-specific controller support.

## Integration follow-up

The [scoped-trial implementation](scoped-trials.md) now wraps the fixed-client
game path. The original acceptance requirements remain useful:

Wrap the entire isolated trial tree in a verified scope **before** spawning its
server, participant or observers. Preserve effective limits and kernel event
counters alongside source/world pins, fail closed if limits are unavailable or
changed, and require whole-scope cleanup. Choose a game-sized budget and qualify
both normal game completion and limit-triggered failures with that wrapper.

The scope must not expose its controller or user-manager socket to the
participant. Budgeting the whole tree is not a per-bot fairness policy; decide
separate participant/server allocations before model comparisons.

Disk/world growth still needs an independent bounded writable filesystem or
quota. cgroup memory/PID/CPU limits do not cap disk bytes, GPU memory or model
inference tokens. Actor identity and remaining failure timings are also open.
The live swarm, its GPU workload and its operational mode were unchanged.
