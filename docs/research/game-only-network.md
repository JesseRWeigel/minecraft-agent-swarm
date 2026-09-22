# Game-only participant network

The experimental fixed-client runner now uses separate server and participant
network namespaces. This closes the previous participant-to-RCON network path;
it is not a claim that arbitrary model-generated code is fully contained.

## Boundary

The outer private namespace owns Paper, RCON, the trusted observer, and a
single-use Unix-domain socket listener. After [fixed actor admission](actor-identity.md), that listener forwards bytes
to `127.0.0.1:25585`, the isolated game server. It accepts no destination argument,
proxy negotiation, forwarding command, or second connection.

The nested participant has its own network namespace with a local TCP listener
on `127.0.0.1:25585`. A small launcher relays that connection through the Unix
socket and starts the fixed Node client. The socket directory is the only extra
mount; it is read-only inside the participant. RCON, other outer ports, outer
abstract Unix sockets, credentials, world files and observer code are not exposed.
The participant may disrupt its own relay; doing so must fail or interrupt the
trial, not grant broader access. The trusted listener now validates the fixed
login name and UUID before opening the upstream game connection.

Both relay endpoints support one connection only, with no reconnect. Each
relay buffers at most 64 KiB per direction in userspace and stops on a bounded
deadline or cancellation. This is not a limit on kernel socket buffers, total
process memory, CPU, disk or packet volume. Whole-trial resource bounds are
documented separately below.

The socket is created using a short `/proc/self/fd/...` path to the newly created
private directory. This avoids Linux Unix-socket pathname limits without
changing the worker's current directory. The actual filesystem socket stays in
the private run directory and is mounted into the participant by that directory.
No old socket, source snapshot, world, or failed attempt is overwritten.

## Qualification

The opt-in production namespace test runs active server-side game, IPv4 RCON,
IPv6 RCON, another TCP port, and abstract Unix-socket canaries. The participant
can exchange game bytes but cannot connect to the other listeners, overwrite the
bridge directory, or open a second game/bridge connection. It also verifies
separate network namespace IDs and retains existing filesystem, environment,
file-descriptor and process-isolation checks.

Unit tests exercise large bidirectional transfer, half-close, backpressure
cancellation, an idle deadline, long workspace paths and host rejection of
missing/failed network evidence. Real-game results are recorded separately in
[the bridge qualification evidence](game-bridge-results-2026-09-21.json).

Run the focused checks without starting Minecraft:

```sh
python3 -m unittest tools.pilot.test_game_bridge tools.pilot.test_protected_worker
PILOT_TEST_BWRAP=/absolute/path/to/protected/bwrap python3 -m unittest tools.pilot.test_protected_namespace
```

Real qualification uses `run_protected_qualification` with the same explicit
launch, fresh workspace and pinned inputs documented in the
[movement qualification](protected-movement-qualification.md). The host now
requires `network_policy: game_only_unix_v1` and one normally completed bridge connection
for successful qualification. Older derived results remain historical; they do
not retroactively establish this network boundary.

## Actual game results, 21 September 2026

The final five attempts used the same current captured sources:

| Attempt | Case | Outcome |
| --- | --- | --- |
| 007 | Forward | Qualified: 3.797923 blocks; completed relay and normal client/Java exits |
| 008 | Stationary | Valid negative control: 0 blocks; completed relay and normal exits |
| 009 | Death after action | Rejected: server health 0; relay/client/Java complete normally |
| 010 | Disconnect after action | Rejected: no valid terminal sample; participant forcibly cleaned up; relay completes and Java stops normally |
| 011 | Suspended terminal observer | Rejected: observer deadline, no sample; participant forcibly cleaned up; relay completes and Java stops normally |

All eleven development attempts are retained in the linked derived evidence.
Attempt 001 exposed the long Unix-socket path before participant launch. Attempts
002-006 preceded a review fix: cancellation could count as bridge completion.
The host and inner launcher now require normal relay completion for success,
and a regression test rejects a stopped one-connection relay. The final five
repeated checks use those stricter rules; earlier results retain their own pins.

The original archive was rehashed unchanged. No live swarm process, mode or world
was changed. No model was loaded or called for these experiments. These checks
qualify one fixed-client transport path, not arbitrary agents or learning.

## Remaining gates

The [whole-trial cgroup integration](scoped-trials.md) now bounds aggregate
memory/PID/CPU use for fixed-client launches. [Bounded storage](bounded-storage.md)
caps world growth, and [actor admission](actor-identity.md) checks identity.
Permission escalation, internal RCON stalls and
mid-action failure checks remain before model-controlled experiments. A game
bridge is not a complete game-protocol firewall: after admission, packets still reach Paper, so
server vulnerabilities and malicious game actions are not solved by this boundary.
No learning, cost advantage or robotics-transfer claim follows from these tests.
