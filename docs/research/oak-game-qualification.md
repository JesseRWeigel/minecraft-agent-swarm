# First oak-log gameplay qualification

A fixed ordinary survival client now mines and collects the fixture's oak log
through the protected runner. Its no-action control leaves the target intact
and inventory empty. This is fixed-client infrastructure qualification, not
language-model performance, swarm progress or evidence of learned behavior.

## Observed on 22 September 2026

| Preserved attempt | Control | Host-observed action time | Outcome |
| --- | --- | ---: | --- |
| 001 | Mine and collect | 3.5405 s | Failed qualification: scorer rejected saved JSON field ordering |
| 002 | Mine and collect, corrected scorer | 3.5942 s | Qualified: target air, exactly one oak log in slot 0 |
| 003 | No action, same final sources | 0.0008 s | Qualified negative control: log intact, inventory empty |

[Derived evidence and pins](oak-game-results-2026-09-22.json) preserve all three
attempts. The initial client completed the gameplay endpoint, but its attempt
remains failed: the scorer used order-sensitive JSON serialization to compare
inventory objects, while the host saves sorted keys. A regression reproduces
that failure; structural equality fixes it. The final two attempts use matching
source manifests and the same generated world archive. The source archive was
rehashed unchanged. Result/observer/world files were recovered and verified from
the unmounted runtime images.

The successful pair had normal participant and Java exits, no forced cleanup,
confirmed resource scope cleanup and verified storage unmount. Paper's actual
ordinary oak inventory text and `execute if block` replies worked with the strict
sampler. This does not establish compatibility with other item components,
Minecraft versions, localizations or server plugins.

## How the integrated path works

`run_oak_qualification` in `tools/pilot/oak_qualification.py` captures/pins task
sources, generated package files, dependency-link targets and the host namespace
guard. It restores a fresh archive into bounded storage and invokes
`oak_worker.py` in the private outer namespace. The participant retains the
separate private network, one-use game-only bridge and fixed actor admission.
Observer code, credentials and evidence stay outside its mounts.

The trusted pre-action fixture reuses player normalization, then builds a
bedrock floor, walls and roof and places one oak log at `(0, 200, 3)`. Setup
commands and sampled boundary-block readbacks are preserved. The actor starts at
`(0.5, 200, 0.5)`, survival mode, health/food 20 and empty inventory. These setup
commands are interventions, not earned gameplay. Boundary readbacks currently
sample points rather than verify every block in the arena volume.

A protected observer child receives its RCON credential through stdin and records
before/terminal actor, inventory and target-block evidence. The fixed client
looks at and digs the log, then moves toward the drop for at most three seconds.
It issues no item grants, game commands or RCON calls. Mining/collection has a
15-second participant action timeout; the host rejects action completion later
than 20 seconds. Existing process and whole-trial deadlines remain in force.
A late completed mining call cannot resume movement after timeout/teardown.

The host recomputes the endpoint from preserved observer files and binds those
files to the worker's recorded samples. It additionally checks task IDs, fixture
pin/readbacks, action completion/timing, player admission, normal process exits,
whole-trial resource checks and storage cleanup. The pure endpoint function still
returns `gameplayQualified: false`, correctly indicating that it cannot certify
those outer conditions itself. The integrated launcher's `status` carries the
qualification verdict after all applicable outer checks.

## Reproduce with pinned local inputs

Use the [fresh-world recipe](fresh-fixture.md), [clean-checkout setup](clean-checkout-reproduction.md)
and [bounded-storage prerequisites](bounded-storage.md). Importing this API
starts nothing; `launch=True` and a new private workspace are required.

```python
from pathlib import Path
from tools.pilot.oak_qualification import run_oak_qualification

result = run_oak_qualification(
    launch=True,
    workspace=new_attempt,
    restore_kwargs={
        "archive": generated_archive,
        "archive_sha256": archive_pin,
        "jar": paper_jar,
        "jar_sha256": jar_pin,
        "bootstrap": mojang_jar,
        "eula": already_accepted_eula,
    },
    tool_snapshot=client_snapshot,
    tool_manifest_sha256=client_manifest_pin,
    control_mode="forward",  # fixed mine-and-collect client; "stationary" does nothing
    storage_tool_root=helper_root,
    bwrap_path=bwrap,
)
assert result["status"] == "qualified"
```

Path variables are operator-supplied absolute `Path` instances; pins are SHA-256
strings. Only `failure_case="none"` is supported by this task launcher. Every
run needs a new workspace. Raw runtime images remain private and contain the
per-attempt server configuration/credential; publish only reviewed derivatives.

## Remaining gates

One positive and one no-action control do not complete the survival-task failure
matrix. Add actual inaccessible-target, broken-but-uncollected, injected-item,
interrupted-action and observation-failure cases. Strengthen full arena-volume
verification and qualify any model-facing action adapter before collecting model
results. The no-action client finishes immediately; its duration is not a matched
model-comparison budget. No GPU workload, model inference, live-world reset or
swarm supervision change occurred.

Local regression verification: 119 pilot JavaScript tests and 368 Python tests,
including four explicit real namespace checks. CI runs the oak tests on Node 20
and 22. See the [task design](first-survival-task.md) for the research constraints.
