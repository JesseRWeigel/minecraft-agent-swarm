# Clean-checkout reproduction, 22 September 2026

The [fresh fixture recipe](fresh-fixture.md) passed from a new GitHub clone of
`89985b3ac7ff223bd11e9f51439f1e2a1d6a2c62`, with dependencies newly installed from
its lockfile, a newly captured client snapshot, re-extracted storage helpers,
and a newly generated world. The tested checkout remained clean.

This is reproduction on the same WSL host by the same operator. It does not
establish portability to another machine, independent operator reproduction,
or a fresh operating-system setup. Java, Python, Node, Bubblewrap, systemd/cgroup
configuration and FUSE kernel support were reused as host prerequisites.

## Observed results

| Step | Result |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | 417 packages installed |
| New client snapshot + full verification | 1,023,164,130 input bytes |
| New fixed-seed generation | Clean save/stop; 10,639,360-byte archive |
| Protected forward control | 4.310304 blocks; qualified |
| Protected stationary control | 0 blocks; negative control observed |
| Generation and both controls | Normal lifecycle, valid resource scope and storage cleanup |
| Fresh-fixture/client-snapshot unit tests | 14 passed |

[Derived evidence](clean-checkout-results-2026-09-22.json) includes archive,
initial level, client snapshot, package lock, helper package, source and runtime
image hashes. Result/world files were recovered after unmount and checked against
the recorded hashes. Both controls used the same newly generated archive.

The new archive hash is
`fc652947f614a3fe38c757a4d461def6dc6bed0ba8d2868d2174a6a8d11e37ed`.
The client manifest hash is
`37f38ff1b4fb39bc210b8772b609dfaaf7cc11522d04562a637ef2034a0fde26`.
These identify this reproduction. A new snapshot manifest includes the current
storage preflight, so its hash may differ even with identical dependency files.

## Preparation that was exercised

Use a new private parent directory on the supported Linux filesystem. Keep paths
absolute. Obtain the explicit host prerequisites in the [fixture recipe](fresh-fixture.md)
and [bounded-storage guide](bounded-storage.md). No private logs, memories, skills,
world backup or existing client snapshot are inputs to this procedure.

```sh
mkdir -m 700 "$REPRO_PARENT"
git clone --depth 1 https://github.com/JesseRWeigel/minecraft-agent-swarm.git "$REPRO_PARENT/checkout"
cd "$REPRO_PARENT/checkout"
# Pin the revision being reproduced. Fetch it if main has since advanced.
git fetch origin 89985b3ac7ff223bd11e9f51439f1e2a1d6a2c62
git checkout --detach 89985b3ac7ff223bd11e9f51439f1e2a1d6a2c62
# Ensure Node 22 and its npm are on PATH; tested Node was v22.22.0.
npm ci --ignore-scripts --no-audit --no-fund
```

`--ignore-scripts` is qualified here only for this fixed Mineflayer/RCON path.
It avoids unrelated native-addon installation. It is not a claim that the full
swarm, canvas rendering or every dependency works without installation scripts.
No audit pass was performed by this npm command.

Place these operator-provided files in a separate `inputs` directory: the pinned
Paper JAR, its cached Mojang JAR, and the existing accepted EULA. Copy only those
files from any existing server installation. Do not copy the server directory.
Pins are in the [recipe](fresh-fixture.md). Do not print or publish EULA/server
configuration contents as part of a public report.

Re-extract the two declared helper packages into a new helper root:

```sh
mkdir -m 700 "$REPRO_PARENT/storage-tools"
dpkg-deb -x "$FUSE2FS_DEB" "$REPRO_PARENT/storage-tools/root"
dpkg-deb -x "$LIBFUSE_DEB" "$REPRO_PARENT/storage-tools/root"
```

The exact package filenames and binary pins are in the bounded-storage guide;
package hashes for this run are in the derived evidence. This test used locally
available package files, not a new package download or system installation.
The launcher verifies the extracted executable/library hashes before use.

Capture the fresh dependencies using the existing API, from the new checkout:

```python
from pathlib import Path
import json
from tools.pilot.client_tools import snapshot_tools, verify_tools

# Supply absolute Paths for the private parent and installed Node executable.
checkout = repro_parent / "checkout"
result = snapshot_tools(
    node_binary=node_binary,
    node_modules=checkout / "node_modules",
    client_script=checkout / "tools/pilot/qualification-client.mjs",
    output=repro_parent / "client-tools",
)
pin = result["manifest_sha256"]
verify_tools(repro_parent / "client-tools", pin)
(repro_parent / "client-pin.json").write_text(json.dumps({"manifest_sha256": pin}) + "\n")
```

Now run the generation command and both control calls from the fresh-fixture
guide, using only the new inputs/helper/client directories. Each generation and
control workspace must be new. Check every returned status and preserve failed
attempts instead of silently retrying into an old directory. Allow enough disk
space for the dependency install, its snapshot, three fully allocated 2 GiB
images, the generated archive and the unchanged 40 GiB host reserve.

## Remaining gates

The setup now has same-host evidence without a private-world dependency. Another
machine/operator still needs to reproduce it, and host prerequisite installation
is not automated. This is fixed-client movement infrastructure, not a survival
benchmark or model result. Next is the [first survival-task design](first-survival-task.md):
acquire one oak log, with an independently observed block and inventory outcome.
The live swarm, production world and GPU workload were unchanged.
