# Protected observer boundary: next implementation design

Status: proposed architecture and synthetic containment qualification. This is
not an implemented model-trial runner. The existing deterministic qualification
still queries RCON in its participant process.

## Required separation

Keep the outer trial supervisor, Paper server, observer process, RCON credential,
and authoritative evidence in one private network/PID namespace. Launch the
participant inside a nested mount/PID/user namespace that inherits only that
private network. Give it read-only pinned code/dependencies, a bounded private
scratch area, a fresh process environment, and a separate `/proc`. Do not mount
the world, server properties, observer code/configuration, or evidence directory
inside the participant.

The participant must receive no RCON password through files, argv, environment,
stdin, or inherited file descriptors. The observer receives the credential and
executes only fixed, read-only state queries for prespecified actor identities.
It writes evidence through supervisor-owned descriptors outside the participant
mount namespace. Closing participant descriptors and clearing its environment
are required even if the filesystem test passes.

A nested sandbox must never be launched directly on the host under the claim
that it is network-isolated: its networking is intentionally inherited. The
production launch path must establish the outer isolated network first. The
current proposed builder/test is not a standalone security wrapper.

## Phase protocol

1. Validate pinned sources, snapshot, actor fixture, budgets, and model identity.
2. Restore a new world and start the server under the outer namespace.
3. Start the participant with a fixed Minecraft identity and protocol version.
   Confirm normal login/readiness, including the 1.21.4 client-loaded handshake.
4. Capture the observer's before-state. Participant messages may indicate
   readiness, but cannot supply or replace authoritative observations.
5. Release a bounded action budget. Track disconnects, respawns, joins, deaths,
   model calls, and interventions with trial/action identities.
6. Capture terminal state through the observer with a fixed convergence deadline.
   No goal-success claim from the participant overrides a failed predicate.
7. Stop the participant and Java, verify cleanup, finalize hashes, and preserve
   success, failure, interrupted, and incomplete attempts alike.

Use narrow bounded pipe messages for supervisor/participant coordination. Do not
use a participant-writable JSON file as authoritative evidence. Enforce output
byte limits and reject malformed, duplicate, late, or out-of-phase messages.
The observer must remain alive long enough to record participant death and
missing terminal state; a crash is not a valid negative control.

## Synthetic qualification before Minecraft integration

The first test should use disposable Python processes, without Minecraft,
models, credentials from the host, or GPU access. In a real outer Bubblewrap
namespace, a nested client must reach a private loopback echo server while:

- an outer credential canary and evidence file are invisible;
- an outer environment secret is absent;
- the outer observer process is absent from the child's process view;
- pinned tools cannot be overwritten;
- writes land only in the participant's private scratch;
- outbound and host-service networking remain unavailable through the outer
  network boundary;
- timeout/exit leave no owned process group or captured pipe behind.

A test that only builds argv strings is insufficient. Record real namespace and
mount behavior, and mark the test explicitly opt-in on unsupported hosts. Do not
claim the production controller has this boundary until it actually uses the
qualified launch path and an independent adversarial test verifies it.

## Additional gates that containment does not solve

- **Fixed starting state:** the real qualification showed different random
  new-player spawn positions after identical world restores. Freeze each actor's
  identity, position, orientation, inventory, health, dimension, memory, and
  permissions in a reviewed task fixture before matched comparisons.
- **Identity and cheating:** offline login plus a shared game network does not
  by itself prevent impersonating another actor. A frozen server needs an exact
  roster/permission policy; unexpected joins or reconnects invalidate an attempt.
  Keep model-facing tools behind a trusted fixed-identity protocol wrapper.
- **Resources:** PID/mount/network isolation is not a CPU, memory, disk, process,
  or inference quota. Enforce each budget separately. Bounded logs alone do not
  bound scratch or world growth. A writable host directory without a quota is
  not adequate for arbitrary participant code.
- **Model provenance:** run-level requested tags and available on-disk model
  hashes must be linked to the actual loaded daemon/model/configuration. An
  offline model-store verification does not establish the running model.
- **Observer validity:** RCON samples are sequential, not an atomic world
  snapshot. Record timestamps and phase identity, and use task predicates that
  tolerate only explicitly defined observation skew.
- **Study validity:** a protected observer does not establish learning or
  causality. Preserve the prespecified condition matrix, reset policy, held-out
  split, all failed work, and uncertainty analysis from the study protocol.

## Qualified synthetic boundary (19 September 2026)

`tools/pilot/test_nested_participant_namespace.py` now exercises the proposed
nested namespace on an actual protected Bubblewrap executable. The trusted
outer result resides in an observer-only writable mount, never in participant
scratch. Both the outer process and host verify observer/tool canaries after
the participant exits. The participant reaches an outer private loopback echo
service while observer files, environment secret, outer process view, and
PID 1's observer-root path remain absent. Tools remain read-only.

The outer process deliberately opens an inheritable observer-secret descriptor.
The nested launch explicitly closes descriptors and supplies null stdin; the
child checks regular descriptors for the synthetic secrets, while the outer
process verifies that its own descriptor still works. This is a file-descriptor
canary test, not a proof about every possible IPC channel.

Run the real checks explicitly on a Linux host with namespaces enabled:

```sh
PILOT_TEST_BWRAP=/usr/bin/bwrap python3 -m unittest \
  tools.pilot.test_nested_participant_namespace \
  tools.pilot.test_shared_namespace \
  tools.pilot.test_server.SandboxLauncherTests.test_real_bwrap_hides_host_clears_secret_blocks_outbound_and_writes_runtime
```

CI enables these checks in both Node jobs. Ordinary Python discovery skips the
real tests unless the environment variable is set. The nested test uses fixed
synthetic Python programs and does not establish arbitrary-code resource
containment, Minecraft observer independence, or model-trial readiness.

The production implementation should add a separate protected participant,
observer, and outer worker rather than silently changing the historical
same-process qualification. The participant receives neither an RCON adapter
nor authoritative evidence access. The observer gets credentials through a
supervisor-owned descriptor, executes only fixed read-only queries, and records
sample times because separate queries are not atomic. The supervisor owns
phase deadlines, process handles, cleanup, and result validation. Only that
path, once exercised with adversarial and real-game checks, may claim an
independent observer process.

## Implemented coordination parser prerequisite

`tools/pilot/participant_protocol.py` provides a strict incremental JSON-lines
parser for one participant action. The supervisor fixes the trial/action IDs.
The only participant messages are `ready` and `action_finished`; each carries
exactly `schema_version`, `type`, `trial_id`, and `action_id`. The supervisor
must explicitly call `begin()` between them and `finalize()` afterward.

Lines are bounded at 512 bytes and the entire stream at 4 KiB. Invalid UTF-8,
duplicate JSON keys, non-finite JSON constants, extra fields, ID/schema/type
mismatches, duplicated or out-of-phase messages, missing final newline, and
buffered future-phase bytes fail permanently. Readiness and action deadlines
use a finite, nondecreasing supervisor clock. Accepted participant completion
still supplies no success predicate or authoritative observation.

This module is not yet wired to a process reader. The future worker must keep
draining bounded stdout/stderr, poll deadlines while idle, own overall and
observer deadlines, and check protocol EOF before accepting a completed
lifecycle. Parser byte barriers concern bytes already delivered to `feed()`;
they do not prove when unread kernel-pipe bytes were sent. If phase freshness
must be authenticated, add a supervisor-generated begin challenge to the wire
contract. Never treat a well-formed completion message as proof of action
execution; that must come from the protected observer.

## Implemented read-only sampler prerequisite

The existing `server-observer.mjs` remains the explicit diagnostic CLI: it can
capture a named actor and raw inventory responses, and its snapshot/version
identity is asserted rather than verified. This new sampler has a narrower
fixed-actor contract and an overall monotonic budget; it does not replace or
silently change that CLI or historical artifacts.

`tools/pilot/protected-observer.mjs` exports `sampleActor` for the future trusted
observer process. It accepts a supervisor-owned RCON adapter, `before` or
`terminal` phase, fixed supervisor trial/action IDs, and a maximum 5-second
overall sampling budget. It sends only these commands for `PilotProbe`:

```text
data get entity PilotProbe Pos
data get entity PilotProbe Dimension
data get entity PilotProbe Health
```

Each result includes sample and per-query UTC/monotonic timing, completed
partial observations, and a generic failure code when appropriate. Exact
deadline equality fails. Adapter rejection and timeout retain the failed-query
timing when clocks remain valid. The parser rejects oversized or malformed
responses, unknown dimensions, nonfinite values, coordinates beyond the
qualification's 30-million-unit bound, and health outside 0 through 2048.
These are fixed qualification limits, not support for arbitrary modded servers.

Zero health is retained as valid observed state. `status: sampled` means the
queries completed and parsed; it does not mean the actor is alive or its task
succeeded. Completed observations remain available when a later query fails.
Raw replies and adapter exception messages are omitted to avoid copying
credentials or unbounded diagnostics into the evidence object.

API configuration errors reject before querying. Runtime sampling failures
return structured failed results. Await deadlines cannot cancel the underlying
transport: the future supervisor must close/destroy the RCON connection, bound
its transport buffers, write evidence through its owned descriptor, and enforce
process/resource cleanup. This library neither connects to a server nor starts
a protected process. Tests use fake adapters and clocks; the actual-game
qualification remains on the historical same-process path.

Qualification summaries also now retain the SHA-256 of stable, bounded, private
raw evidence even when its JSON or identity is invalid. Separate
`evidence_valid_for_requested_mode` and
`namespace_lifecycle_valid_for_requested_mode` booleans distinguish a captured
file hash from acceptance. Unsafe or unstable captures remain unhashed. Original
failed evidence is preserved rather than rewritten into a valid-looking form.
