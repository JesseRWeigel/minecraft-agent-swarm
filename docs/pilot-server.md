# Isolated pilot server lifecycle

`tools/pilot/server.py` owns one server process group and launches it only inside
a Bubblewrap namespace. This stage does not restore a world, accept the EULA,
call a model provider, observe Minecraft state, or establish that the server is
ready. No Java or Minecraft process is exercised by its test suite.

## Process ownership

`run_owned(argv, cwd, env, timeout_seconds, stop_grace_seconds,
log_limit_bytes)` requires an absolute executable and an explicit environment.
It creates a new POSIX session and drains stdout and stderr with nonblocking
selectors into fixed-size tail buffers before returning an observed result.

At the deadline it writes `stop` to standard input and waits the configured
grace period. It then sends TERM and, if needed, KILL to that process group
only. It never searches global process tables or kills by executable name. Its
direct ownership guarantee is the original process group. A descendant can
escape that group with `setsid`; if an escaped process retains an output pipe,
the result reports `cleanup_uncertain` and returns without blocking. Production
containment relies on Bubblewrap's PID namespace in addition to this process
group cleanup. Interruption runs the same bounded cleanup before propagating.
Output text never sets readiness; `ready` remains false even when logs contain
familiar startup text.

## Verified runtime and sandbox

`run_server` calls `tools.pilot.restore.verify_runtime(runtime_dir,
manifest_sha256)` immediately before launch. The verified manifest must have
kind `isolated_minecraft_runtime`, status `restored_not_started`, and pinned
`server.jar`, `eula.txt`, and `server.properties` files. The restore stage owns
world-tree and configuration validation. An existing `server-lifecycle.json`
is refused, so a runtime cannot be launched twice without a fresh restore.

Before spawning, the launcher writes a private lifecycle marker. Completion or
failure replaces it with bounded observed process data. A marker left by an
interruption still prevents reuse. Timeout is capped at 3,600 seconds, graceful
stop at 60 seconds, and each captured stream at 16 MiB. The private mode-`0600`
lifecycle file contains raw bounded log tails that may still be sensitive; it
must not be published without review.

The generated command uses an explicitly supplied, vetted absolute `bwrap`
binary. It unshares every namespace, explicitly unshares networking, creates a
new session, clears the in-sandbox environment, mounts `/usr`, system library
paths, Java configuration, and alternatives read-only, gives the process a
private `/tmp`, exposes no host home directory, and mounts only the verified
runtime writable. Java receives fixed arguments:

```text
-Xms1G -Xmx2G -Djava.awt.headless=true -jar server.jar --nogui
```

`JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `JDK_JAVA_OPTIONS`, provider credentials,
and the caller's environment are not forwarded. With no host network namespace,
an observer outside the sandbox cannot connect to this server. A later design
must add an equally isolated observation channel before any server execution can
produce evidence. The restored configuration deliberately retains
`online-mode=true`; this startup-only sandbox provides no authentication
connectivity or offline-mode exception. Any future authentication decision is a
separate review. RCON remains disabled and no credential is introduced.

## Explicit launch

The CLI requires the `--launch` gate plus all consequential paths:

```bash
python3 -m tools.pilot.server \
  --launch \
  --runtime /private/pilot/runtime-001 \
  --manifest-sha256 FULL_RUNTIME_MANIFEST_SHA256 \
  --java /usr/bin/java \
  --bwrap /usr/bin/bwrap \
  --timeout 300
```

Java must resolve to an executable named `java` under `/usr/lib/jvm`. Bubblewrap
must resolve to an executable named `bwrap`. Both canonical files and every
canonical parent must be root-owned and not writable by group or others. A
private Bubblewrap copy is allowed only in the opt-in namespace test;
production launch refuses it until a system binary is installed. If an
executable is absent or fails validation, launch fails closed. The CLI prints
process status and `ready: false`; a clean exit is not evidence of readiness or
task completion. It returns nonzero for a nonzero child exit, uncertain cleanup,
or truncated output. A deadline followed by a fully observed graceful zero exit
may return zero while still reporting `timed_out` and `ready: false`.

The opt-in namespace qualification test uses `PILOT_TEST_BWRAP=/absolute/path`.
It runs Python only and verifies that a host canary is hidden, the runtime bind
is writable, a host secret is cleared, and an outbound numeric-IP socket cannot
connect. It bypasses production executable validation for that named test
fixture and does not launch Java or Minecraft. Loopback availability is not
qualified and remains unknown.
