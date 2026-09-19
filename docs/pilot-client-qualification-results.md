# Actual deterministic client qualification — 2026-09-19

A deterministic Mineflayer client and a Paper 1.21.4 server ran inside the same
private network/PID namespace, using fresh copies of the preserved world
archive. No model, paid inference, or GPU experiment was started. The live
swarm's operation mode and original world were not changed.

| Attempt | Result | What the evidence established |
| --- | --- | --- |
| 001 | Failed; client deadline | Server started, but automatic protocol discovery depended on a disabled status query. Java stopped normally. |
| 002 | Failed movement check | Explicit 1.21.4 login succeeded. Client predicted about 3.4 blocks of movement, but server position remained unchanged. The evaluator rejected it. |
| 003 | Passed walking qualification | Server observed 3.9006102877 blocks of horizontal movement; final client/server distance was zero. Health remained positive and dimension unchanged. |
| 004 | Expected movement failure; stationary control observed | Server observed zero displacement, matching the client. The movement predicate rejected completion while telemetry and shutdown remained healthy. |

All four attempts and their private evidence were retained. The last two used
the same controller commit `b5f348bcd3899936eeff7861dd00853b0a6d60f5` and client
tool snapshot manifest SHA-256
`2532b8848ce4ad3815e5227451feba8b1410d28577d014201ea90340aa5d5f03`.
The snapshot has 47,415 files and 1,069,449,892 bytes. It includes the Node binary,
dependencies, and fixed client; npm executable-link directories are excluded and
recorded. Older development snapshots are preserved separately.

## Diagnosis and fixes

The client now pins Minecraft protocol 1.21.4 instead of relying on a status
ping. Inspection of the exact local Paper server bytecode found that
`handleMovePlayer` checks `hasClientLoaded`. A new player starts with that flag
false; `player_loaded` sets it, and a 60-tick fallback also eventually sets it.
The installed Mineflayer/protocol code did not send this packet. The one-second
attempt ended before the fallback. The saved player NBT also retained the
unchanged server position, corroborating the RCON observation.

The qualification client now waits for a bounded physics tick, sends the normal
`player_loaded` client packet, checks initial position agreement, performs its
fixed action, and polls bounded terminal observations for agreement. It rejects
transport errors, missing evidence, vertical falling without horizontal movement,
and malformed server responses. It neither teleports nor changes game mode or
permissions to obtain success. These changes address the qualification client;
they do not establish the cause of any historical multi-minute swarm stall.

The outer controller rechecks numeric predicates, schema/protocol identity,
handshake and settlement evidence, and the structured Java lifecycle. A passing
client cannot conceal a crash, forced shutdown, truncated logs, or uncertain
cleanup. The stationary attempt remains `status: failed` because it did not
complete movement; `negative_control_observed: true` records its expected,
fully observed rejection. Missing telemetry or a crashed client cannot satisfy
that control flag.

## Preservation and limits

Both final runs stopped Java with `stop`, exited Java with code zero, and needed
neither TERM nor KILL. Their outer process durations were 13.726 and 14.018
seconds, respectively. Capture was not truncated and owned-group/pipe cleanup
was verified. Namespace containment is a separate configured boundary, also
covered by real opt-in tests in CI.

The source archive still hashed to
`d0262b9fd731db810aa437bb0c3c87a0517ddc881bdbc9eba3cd7e5ff538035c`
after all attempts. Each fresh restore produced the same pre-profile runtime
manifest hash. The private qualification profile enables offline login and RCON
only inside the isolated copy, retaining its own configuration hash. Its private
server.properties contains the disposable RCON credential and must not be
published. Raw logs, worlds, and credentials remain private.

This establishes deterministic client login, ordinary movement observed by the
server, a stationary negative control, and orderly shutdown. It does **not**
establish learning, model performance, robotics transfer, or a controlled live
benchmark. RCON queries still run in the client process; there is no protected
observer boundary against model-controlled code yet. The unreachable-target
negative control has not run. New-player spawn locations differed between fresh
restores, so these are infrastructure qualifications, not matched-condition
experimental trials. A frozen study must pin actor starting states as well as
the world archive.

Next priorities are a separately protected observer, fixed actor/task fixtures,
and resolved run-level model/team provenance before any model-consuming trial.
See [the proposed study protocol](pilot-study-protocol.md).
