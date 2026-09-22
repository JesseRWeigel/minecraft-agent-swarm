# Fixed actor admission and server identity checks

The fixed-client qualification now checks identity before opening the upstream
game connection, and checks the server's UUID and online roster when observing
the actor. This is attribution inside a disposable offline server, not account
authentication or qualification of arbitrary model-generated clients.

## Admission contract

The trusted bridge reads exactly the handshake and login-start frames, with a
five-second deadline, cancellation checks and a 1,024-byte cap per frame. It
requires canonical lengths, strict UTF-8, protocol 769 (Java 1.21.4), literal
127.0.0.1:25585, login state, username `PilotProbe`, and offline UUID
`f14b12b9-4db5-3b00-ab8c-cdacc19f233d`. It rejects trailing fields and malformed
frames. Only then does it connect upstream and forward the admitted bytes
unchanged. Later bytes remain for the existing bounded relay. The listener
accepts one connection; a rejection does not enable another attempt.

The frame layout follows the [PrismarineJS 1.21.4 protocol schema](https://github.com/PrismarineJS/minecraft-data/blob/master/data/pc/1.21.4/protocol.json).
The executed client dependencies and trusted sources are pinned in each trial.
This deliberately narrow parser will need explicit review for another version,
actor or authentication mode.

The protected observer queries the actor's UUID and the server's online list,
alongside position, dimension and health. Both baseline and terminal samples
must identify the admitted UUID and contain only `PilotProbe` in the roster.
Missing or mismatched identity cannot produce a score. The host also requires
the bridge admission receipt. Queries are sequential snapshots, not atomic or
continuous roster monitoring.

## Qualification on 22 September 2026

Two actual Paper trials used fresh restored copies and the same captured sources:

| Control | Server-observed displacement | Identity and cleanup |
| --- | ---: | --- |
| Forward | 3.797922578814884 blocks | Expected UUID and one-player roster at both observations; normal exits |
| Stationary | 0 blocks | Expected UUID and one-player roster at both observations; normal exits |

[Derived records and source/evidence hashes](identity-results-2026-09-22.json)
include both attempts. Persisted result and world-metadata hashes were checked
after unmount; both full image hashes were stable during read-only extraction.
Both scopes and storage mounts cleaned up. The original archive was rehashed
unchanged. The live swarm, operational mode, world and model workload were not
changed. Raw worlds remain private.

Socket tests reject wrong usernames and UUIDs before any upstream connection,
and cover fragmented/coalesced frames, malformed inputs, deadlines, cancellation
and a second connection. Observer/validator tests reject missing or mismatched
UUIDs and rosters. The real nested-namespace test traverses admission and retains
its RCON, other-port, filesystem and capability canaries. These negative checks
are socket/unit/namespace tests, not malicious-client trials against Paper.

```sh
python3 -m unittest tools.pilot.test_login_identity tools.pilot.test_game_bridge tools.pilot.test_protected_worker
node --test tools/pilot/protected-observer.test.mjs tools/pilot/protected-observer-cli.test.mjs
PILOT_TEST_BWRAP=/absolute/path/to/protected/bwrap python3 -m unittest tools.pilot.test_protected_namespace
```

## Remaining boundary

The offline UUID is public and reproducible; it does not authenticate a person.
Once admitted, game packets still reach Paper. Permission escalation, malicious
commands, server vulnerabilities and broader game-protocol behavior need their
own qualification. The combined identity/permissions release gate remains open.
Multi-agent joins, reconnects and continuous roster history are unsupported.
Older evidence retains its original sources and is not backfilled with this
policy. These checks establish neither model performance nor retained learning,
cost savings or robotics transfer.
