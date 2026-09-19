# Pilot client tool snapshots

`tools.pilot.client_tools` copies the local Node runtime, installed client
dependencies, and qualification client into a private, immutable-by-convention
directory. The snapshot is content-addressed by a separate SHA-256 pin for its
`manifest.json`.

## API usage

```python
from pathlib import Path

from tools.pilot.client_tools import snapshot_tools, verify_tools

result = snapshot_tools(
    node_binary=Path("/pinned/node/bin/node"),
    node_modules=Path("/checkout/node_modules"),
    client_script=Path("/checkout/tools/pilot/qualification-client.mjs"),
    output=Path("/private/run/client-tools"),  # must not already exist
)

manifest_pin = result["manifest_sha256"]
manifest = verify_tools(Path("/private/run/client-tools"), manifest_pin)
```

The default free-space reserve is 40 GiB. Tests and callers operating on an
already reserved filesystem may pass `reserve_bytes=0` explicitly. The helper
has no standalone CLI; pilot command wrappers should call this API and persist
the returned manifest pin with the run inputs. Verification must occur before
launching the copied `bin/node` and `qualification-client.mjs`.

Snapshot directories are mode `0700`. The Node executable is mode `0700`, and
all other files are mode `0600`. Verification rejects changed content,
permissions, missing paths, and unlisted files or directories. The copier
allows at most 100,000 files, 2 GiB total, and 256 MiB per file. It skips only
`.bin` directories immediately below a `node_modules` directory, records every
such exclusion in the manifest, and rejects other symlinks and special files.

## Claim limits

The manifest proves that verification observed exactly the bytes and private
layout named by a pinned manifest. It does not establish who produced those
bytes, audit dependency behavior, execute a qualification, contact a provider,
or prove Minecraft server behavior. Excluding `.bin` means dependency-provided
command shims are unavailable; the qualification client must load libraries
through Node module resolution. Sources must remain stable while snapshotting;
the copier detects observed metadata changes and aborts rather than claiming a
mixed snapshot.
