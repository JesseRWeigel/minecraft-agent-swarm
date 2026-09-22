# Fresh-world reproduction fixture

The movement infrastructure can now run without the private long-running world.
`tools.pilot.fresh_fixture` generates a new world from a fixed recipe in an
isolated server, stops it cleanly, and packages only its three dimension trees.
It never reads an existing world. This is a setup fixture, not earned gameplay.

## Qualified on 22 September 2026

One generated archive was restored independently for each protected control:

| Control | Server-observed displacement | Result |
| --- | ---: | --- |
| Forward, one second | 4.310304 blocks | Qualified |
| Stationary | 0 blocks | Negative control observed |

Both began at the declared arena position `(0.5, 200, 0.5)` in survival with
health 20. Participant and Java exits were normal, with no forced cleanup.
Generation and both controls passed cgroup/resource checks and verified storage
unmount. [Derived evidence and hashes](fresh-fixture-results-2026-09-22.json)
were checked against the preserved runtime images after unmount.

- Recipe: `fresh-flat-v1`, seed `20260922`, flat overworld, structures disabled,
  peaceful difficulty, no player connections during generation.
- Recipe SHA-256: `69c6cfafebefab9919773f3addf0966cbd5adfdc9d2a6c9db166a6424d4e622c`.
- Generated archive: 10,629,120 bytes, 52 entries.
- Archive SHA-256: `8615838260ef1a9779b824539f3f16ca1fd872251d5e24f37b491fbba983aff9`.
- Initial `ai-world/level.dat` SHA-256:
  `7cbb7f6448900dae0e19baa0dedd2fe0f219cc879866815d817309eeeb0eb835`.

These last two hashes identify this generated instance. A fresh generation can
have different UUIDs and timestamps. The recipe is fixed; byte-identical world
archives are not promised. Pair comparisons must reuse one generated archive
and its hash, then normalize and verify the actor through the existing fixture.

## Generate locally

Run from the repository root on a supported Linux/WSL host. Prerequisites are
Java 21, Python 3, root-owned Bubblewrap, a working systemd user manager/cgroup v2,
and the verified FUSE helpers described in [bounded storage](bounded-storage.md).
The default scope is 4 GiB memory, no swap, two CPU equivalents and 256 tasks;
runtime storage reserves 2 GiB, and the 40 GiB host free-space reserve still
applies. The generator makes no GPU or model calls.

Provide your own pinned Paper 1.21.4 JAR, its cached Mojang bootstrap dependency,
and an existing EULA file you have already accepted. This command does not
accept the EULA for you or download/distribute Minecraft binaries.
The parent of `WORKSPACE` must exist; `WORKSPACE` itself must be new.

```sh
python3 -m tools.pilot.fresh_fixture --launch \
  --workspace "$WORKSPACE" \
  --jar "$PAPER_JAR" \
  --jar-sha256 8b264f7b7187fe247dfc2ca4eb43ab677e38469e2f2e7de702bf3840512b8c11 \
  --bootstrap "$MOJANG_JAR" \
  --eula "$ACCEPTED_EULA" \
  --storage-tool-root "$STORAGE_TOOL_ROOT" \
  --bwrap-path "$BWRAP"
```

The tested bootstrap SHA-256 is
`1066970b09e9c671844572291c4a871cc1ac2b85838bf7004fa0e778e10f1358`.
The generator reads the required path/hash from the pinned Paper JAR and verifies
it before launch. The network namespace has no external connectivity; generation
uses a loopback-only listener with RCON disabled. Readiness is followed by
`save-all flush` and `stop`, with bounded output and deadlines.

Success produces `fixture.tar` and `fixture-manifest.json`; require manifest
`status` to equal `generated`. An unsuccessful attempt retains its manifest and
storage image; keep it and use a new workspace for any retry. Packaging rejects
symlinks, special files and files under playerdata/advancements/stats. It excludes
server configuration, logs, EULA, binaries and credentials. Tar ownership and
mtime metadata are normalized. The world payload is capped at 512 MiB.

## Use the generated archive

Follow the [protected qualification](protected-movement-qualification.md) setup
for the pinned client snapshot. Pass the generated archive and the manifest's
`archive.sha256` through `restore_kwargs`:

```python
from pathlib import Path
import json
from tools.pilot.protected_qualification import run_protected_qualification

manifest = json.loads((generation_workspace / "fixture-manifest.json").read_text())
assert manifest["status"] == "generated"
for mode in ("forward", "stationary"):
    result = run_protected_qualification(
        launch=True, workspace=trial_parent / mode,
        restore_kwargs={
            "archive": generation_workspace / "fixture.tar",
            "archive_sha256": manifest["archive"]["sha256"],
            "jar": paper_jar, "jar_sha256": manifest["server_jar_sha256"],
            "bootstrap": mojang_jar, "eula": accepted_eula,
        },
        tool_snapshot=client_snapshot,
        tool_manifest_sha256=client_manifest_sha256,
        movement_mode=mode, failure_case="none", resource_profile="game",
        storage_tool_root=storage_tool_root, bwrap_path=bwrap,
    )
    assert result["status"] == "qualified", result.get("error")
```

Path variables above are operator-supplied `Path` instances; each trial workspace
must be new. Client snapshot preparation and helper setup remain explicit
prerequisites, so this is not yet a one-command installation experience.

## Limits and next gates

One recipe instance and one pair of controls establish compatibility, not
independent reproduction. No world archive or server binary is published here.
A clean-checkout reproduction on another machine remains open. The generated
terrain is a minimal movement input; useful survival-task fixtures, arbitrary
agent qualification, and a prespecified model comparison are still needed.
These results do not demonstrate learning, lower inference costs or robotics
transfer. No live swarm state, world, supervisor or GPU workload was changed.

A [subsequent clean-checkout run](clean-checkout-reproduction.md) regenerated the
world and repeated both controls with freshly installed dependencies on this same
WSL host. Independent-host/operator reproduction remains unverified.
