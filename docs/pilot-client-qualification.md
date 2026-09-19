# Deterministic client qualification

`tools.pilot.qualification.run_qualification` is a development qualification
harness. It creates a **new** private runtime from pinned inputs, starts Paper
and a deterministic Mineflayer client in the same Bubblewrap network/PID
namespace, records server-derived observations, and stops the server. It does
not start a language model, contact a provider, or produce a benchmark result.

The namespace has no host or outbound network access. Gameplay uses loopback
port 25585 and RCON uses 25595. Only this private copy enables RCON and offline
login for `PilotProbe`. A generated credential stays in private runtime state;
it is not passed in command-line arguments. The live server's authentication,
ports, world, and ops mode are not changed.
The client is pinned to the Minecraft 1.21.4 protocol. It passes that version
explicitly to Mineflayer and records `minecraftVersion: "1.21.4"` in evidence.
It does not use the disabled server-status endpoint for protocol autodetection.
Evidence for any other or missing version is rejected.

## Inputs and execution

First create and verify a [client tool snapshot](pilot-client-tools.md). Provide
a SHA-256-pinned world archive and Paper JAR, an existing accepted EULA, and the
pinned JAR's required bootstrap cache. See [restore](pilot-restore.md) and
[server qualification](pilot-server-qualification.md) for the offline bootstrap
contract. The output parent must already exist and the output itself must not.
The archive and source tools are read only.

The Python API is deliberately explicit; importing it does not launch anything:

```python
from pathlib import Path
from tools.pilot.qualification import run_qualification

result = run_qualification(
    workspace=Path('/private/qualification/new-attempt'),
    restore_kwargs={
        'archive': Path('/private/inputs/world.tar.zst'),
        'archive_sha256': 'REVIEWED_ARCHIVE_SHA256',
        'jar': Path('/private/inputs/paper.jar'),
        'jar_sha256': 'REVIEWED_JAR_SHA256',
        'eula': Path('/private/inputs/eula.txt'),
        'bootstrap': Path('/private/inputs/mojang_1.21.4.jar'),
    },
    tool_snapshot=Path('/private/client-tools'),
    tool_manifest_sha256='REVIEWED_TOOL_MANIFEST_SHA256',
    bwrap_path=Path('/usr/bin/bwrap'),
)
```

Bubblewrap, Java, and Python must resolve to protected root-owned executables.
A locally installed Bubblewrap may be supplied explicitly if it meets that
contract. Node and its dependencies are copied and pinned in the tool snapshot,
then mounted read only. The fixed supervisor code is copied and pinned for the
attempt. Production callers must keep executable validation enabled; injected
runners and disabled validation are synthetic-test seams, not launch settings.

## Evidence and limitations

The client checks before/after positions, dimension, and health through fixed
RCON queries. Its movement predicate checks bounded horizontal displacement and
agreement with Mineflayer's final position. It sends no teleport, game-mode,
permission, item-grant, or other administrative mutation commands. Terrain may
block the prescribed movement, and such an outcome remains a failed attempt.

This qualification uses RCON and Mineflayer in the **same client process**.
They provide different observation sources, but not an evaluator security
boundary against a model-controlled agent. The server, client, and evidence also
share one private writable runtime. A future live model trial requires a
separate protected observer and narrower participant capabilities.

The original restore manifest describes bytes before applying the qualification
profile. The qualification summary retains its pin, the applied profile's hash,
and the tool/worker pins; it does not pretend the changed runtime still matches
the original file manifest. Preserve every attempt, including failures and
missing evidence. A passing client alone does not qualify a run with a failed
server shutdown, truncated capture, timeout, or uncertain cleanup.

Raw logs, credentials, and world files are private. Public progress reports
should contain only reviewed summaries. Read the [proposed study
protocol](pilot-study-protocol.md) before treating any future model run as
research evidence.
