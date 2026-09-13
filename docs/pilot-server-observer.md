# Read-only pilot server observer

`tools/pilot/server-observer.mjs` is a separate process for collecting server replies, independent of the agent's client-state snapshot and executor prose. It never starts a server, restores a world, loads a model, or evaluates task success.

## Capture against an already prepared isolated server

```sh
node tools/pilot/server-observer.mjs --observe \
  --host 127.0.0.1 --port 25585 \
  --trial pilot-1 --action action-1 --bot Atlas --phase before \
  --snapshot YOUR_64_CHARACTER_LOWERCASE_SHA256 --version paper-1.21.4 \
  --output /private/pilot/observation-before.json
```

Supply the isolated server password through `PILOT_RCON_PASSWORD`. The tool never reads production server properties or credentials. It refuses the project's current production RCON port, 25575, and accepts only an explicitly specified loopback endpoint. Other ports are not automatically proven isolated; the operator must verify the server process and endpoint before use. No connection is made without `--observe`. Output must be new, uses private file permissions, and refuses symlinked parent paths. No arbitrary command argument is supported.

The four fixed commands read the named entity's Pos, Dimension, Health and Inventory. Each reply has a hash and request start/end times. The navigation projection recognizes only the exact English server response grammar, finite coordinates and the three standard dimensions. Unsupported replies, errors or dimensions remain unavailable. Inventory remains raw SNBT; it is not yet a parsed acquisition or handoff predicate.

Captures are sequential, not atomic world snapshots. Before and after calls need the same caller-supplied trial/action identity, but the observer does not verify that the caller actually ran the action. World snapshot and server version are recorded as assertions, explicitly unverified. A separate harness must verify resets, source/config/model identity, budgets, interruption and objective task predicates. A position reply alone is not a completed benchmark trial.

Per-query waits are bounded; a transport failure, timeout or response exceeding 64 KiB stops capture with explicit incomplete evidence. The CLI closes its own socket. Error strings from the connection are not written, to avoid echoing credentials. Raw replies can still contain private player/world data and should remain private.

Exit zero means raw replies were captured and a navigation state could be parsed. Exit two means incomplete/unparseable evidence; exit one means invalid invocation or connection/capture failure. A partial output can remain after failure or interruption and must never be treated as a completed observation.

## Offline verification

```sh
node --test tools/pilot/server-observer.test.mjs
```

Tests use injected fake transports: read-only command allowlisting, source/phase joins, malformed/nonfinite state, fluent success-claim rejection, identifier/endpoint validation, response caps, timeouts and secret-free failure reporting. They do not contact Minecraft. The preparation tool and this observer are foundations; no live evaluation runner is enabled by them.
