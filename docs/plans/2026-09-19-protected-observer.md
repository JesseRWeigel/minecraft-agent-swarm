# Protected observer boundary: next implementation design

Status update, 21 September 2026: the complete fixed-client participant/observer
path now passes real forward and stationary qualification with a declared actor
fixture. See [results, architecture and remaining limits](../research/protected-movement-qualification.md).
This is not a qualified model-trial runner. The historical qualification below
queried RCON in its participant; the new path uses separate trusted observers.
The original design and intermediate checkpoints below are retained as history.

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

The process adapter added on September 21 now wires this parser to pipes (see below). The future worker must keep
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

## Implemented participant prerequisite

`tools/pilot/protected-participant.mjs` exports `runParticipant` with injected
bot and bounded message adapters. The fixed client uses `PilotProbe`, isolated
loopback port 25585, offline authentication, Minecraft 1.21.4, and automatic
respawn disabled. After spawn/physics readiness it sends `player_loaded`, emits
`ready`, waits for the supervisor's `begin`, executes the one-second forward or
stationary action, emits `action_finished`, and waits for `finalize` before
quitting. Keeping the connection alive gives the observer a terminal sampling
window. Zero health remains observable instead of being replaced automatically
by a freshly respawned player.

The participant neither imports RCON nor accepts an evidence writer, and its
outgoing messages contain only the four protocol fields. Incoming supervisor
commands must match the exact schema, phase, and IDs. The Python protocol's
`begin()` and `finalize()` now return those exact command dictionaries for a
future worker to serialize. A completed local handshake is labeled
`protocol_completed`, never task success.

Every asynchronous phase has a maximum 30-second budget inside the 90-second
total budget, with monotonic checks before and after awaiting. An exhausted
budget cannot start bot acquisition. Late acquired bots are disposed; transport
error/end/kick is sticky until finalization; controls and sockets are cleaned
up on failure. Timer races alone do not establish deadline compliance. A
trusted outer process still must enforce hard process/resource limits and
close IPC adapters, since JavaScript cannot preempt a blocking callback or
cancel every underlying asynchronous operation.

The existing isolated qualification client also now sets `respawn: false`.
Inspection of the installed Mineflayer loader and health plugin established
that omission defaults to automatic respawn. New tool snapshots must include
and pin the changed client; the previously retained snapshots and actual
qualification attempts have not been rewritten or rerun.

Participant library tests use fake bots and adapters. The September 21 CLI and
pipe adapters connect this component to a process interface (see below). Actual
protected process launch and model invocation remain unimplemented. The next
implementation is the outer worker, followed by actual namespace and Minecraft
qualification of that complete path.

## Process interface integration (21 September 2026)

`participant_transport.py` now connects an already-launched process's binary
pipes to `ParticipantProtocol`. It polls idle deadlines, bounds stdout and
retained stderr at 4 KiB each, enforces an at-most-90-second overall budget,
writes fixed commands, validates EOF, and requires a zero process exit. Its
`close()` only closes the adapter's pipes; the outer worker must own termination,
descendant cleanup, containment, and deadlines during observer work. It cannot
preempt a caller that blocks between methods.

`participant-pipes.mjs` and `protected-participant-cli.mjs` provide the matching
Node process entry point. The CLI validates its fixed IDs and movement option
before loading Mineflayer, reserves stdout for protocol messages, and emits only
a generic failure diagnostic. The adapter limits command bytes, rejects invalid
UTF-8, duplicate keys and wrong-phase commands, and handles write completion and
stream failures. A direct CLI watchdog bounds asynchronous stalls; JavaScript
cannot preempt a blocked event loop, so an outer process deadline is required.

`test_participant_process_integration.py` now runs the Python transport and the
actual Node CLI harness together through real subprocess pipes in forward and
stationary modes. It uses a fake bot with the actual participant state machine,
checks fixed bot configuration and readiness/control/quit behavior, and verifies
clean protocol output and process exit. It performs no Minecraft connection,
model call, observation, or namespace launch. Node must be available on PATH;
otherwise this test is explicitly skipped.

Run the interface checks without a game server or inference:

```sh
python3 -m unittest tools.pilot.test_participant_protocol \
  tools.pilot.test_participant_transport \
  tools.pilot.test_participant_process_integration
node --test tools/pilot/participant-pipes.test.mjs \
  tools/pilot/protected-participant-cli.test.mjs
```

These checks connect the language/process interfaces, not the complete protected
experiment. The next integration must launch this client inside the qualified
nested namespace, keep observer credentials/evidence in the outer namespace,
perform before/terminal samples through the trusted observer, and enforce all
resource and lifecycle budgets. The fresh game requalification also demonstrated
that fixed actor/task starting conditions must be implemented before a repeatable
positive qualification; see [both September 21 attempts](../research/client-requalification-2026-09-21.json).
