# Bounded model-action session: offline qualification

Status: implemented and tested with bot doubles; not yet wired into the protected
Minecraft participant or a model coordinator. No game or model-performance result
is claimed for this interface.

`createModelActionSession({bot})` in `tools/pilot/model-action-session.mjs` owns an
already connected bot. It parses each request with the strict schema, executes
one action at a time, and returns a bounded response. Construct the session only
after the trusted supervisor begins the action window: its timer starts at creation.
The caller still owns process isolation, independent scoring and final trial
cleanup. The dedicated action channel below supplies bounded pipe framing.

## Enforced behavior

- Requests must use consecutive sequence numbers starting at one. Overlapping,
  malformed or out-of-order requests permanently fail the session.
- At most 25 requests are allowed, including `finish`. If request 25 is not
  `finish`, it fails before invoking a bot action.
- Session lifetime is at most 20 seconds, with a six-second dig limit and a
  two-second limit for other operations. Shorter session limits are permitted;
  limits cannot be enlarged. A monotonic deadline check also rejects operations
  that overrun while the event loop is busy.
- Move holds one whitelisted control for `ticks * 50` milliseconds, then clears
  controls. This is nominal tick duration measured in wall time, not a guarantee
  that the server advanced that many ticks under lag.
- Dig requires the explicit target coordinate to match both the current block
  lookup and cursor raycast, be within 4.5 blocks of the assumed standing eye
  position, and be currently diggable. It neither chooses a target nor moves
  toward one. The 1.62-block eye-height assumption is limited to the fixed
  standing survival actor; other poses need qualification.
- Timeout, disconnect, kick, death, action failure and overlapping requests clear
  controls, stop digging and close the bot. Pending requests reject. Late promise
  resolution cannot execute another model action or restart movement.
- `finish` clears controls and ends the action session while leaving the bot
  connected for the trusted terminal observer. The supervisor must then call
  `close()`; it must not treat a returned finish message alone as trial success.

The session keeps at most 25 action/timing receipts and returns copies of the
transcript. Invalid raw input is not echoed. A failed timestamp is explicitly null
if the monotonic clock itself cannot be sampled. Owned-bot event listeners remain
installed to absorb late shutdown errors; do not reuse this bot for another session.

## Advisory observation projection

`snapshotModelObservation(bot)` copies position, yaw/pitch, health, occupied slots
from an inventory array of at most 46 slots, and at most one cursor-visible block.
Names, counts and coordinates are validated. It never serializes raw bot, item,
NBT or metadata objects and does not call an unbounded inventory enumeration.
The JSON result is limited to 16 KiB and marked `source: participant_bot`.

These observations are model inputs, not scoring evidence. The independent
server-RCON observer remains authoritative. Inventory/block name fields require
actual strings; values with string coercion or custom JSON serialization are
rejected rather than copied into the response.

## Cancellation is not rollback

An already-issued dig can affect the server before cancellation reaches the bot.
Every failed, timed-out or cancelled session must make the overall trial invalid,
even if a later terminal inventory looks successful. Retain terminal state as
diagnostic evidence when available. JavaScript deadlines also cannot preempt a
synchronously blocked event loop; the existing outer process/resource deadline
must remain in place when this is integrated.

## Dedicated action channel

`runModelActionChannel({input, output, session, timeoutMs})` accepts dedicated
binary readable/writable streams and a trusted `createModelActionSession` instance.
Never attach these to the participant lifecycle streams carrying
`ready/begin/action_finished/finalize`. The channel is implemented independently;
extra file descriptors and the protected runner are not connected yet.

Each request is one UTF-8 JSON object followed by LF, with at most 4,096 bytes
before the LF. Fragmented reads are supported. The caller must wait for each
reply before sending the next request; pipelined frames and input during an
executing action invalidate the channel. One next frame may wait while the
previous reply's write callback is pending, because the peer can receive a reply
before that local callback fires. It never executes concurrently.

Replies are JSON lines capped at 20 KiB each. Only the session response envelope
is accepted; observations must be marked `participant_bot`. The channel relies on
the trusted session's bounded observation projection, rather than sanitizing an
arbitrary replacement session. At most 25 requests and 25 reply budgets are
accepted. The default 20-second overall deadline includes idle reads, action
execution, output backpressure and final EOF; it may be shortened but not enlarged.
The session retains its own action and lifetime deadlines.

Success requires a written `finished` reply followed by clean input EOF. Trailing
bytes, partial EOF, stream errors, invalid responses or deadline expiration close
the session and reject the channel. Late completions cannot emit a reply or start
queued work. Diagnostics contain only stage, request count and byte counts; raw
requests and exception messages are not echoed. Output byte counts include bytes
submitted to the writable, not an acknowledgement from the peer. Streams are
owned for one channel lifetime; error listeners remain to absorb late errors.
The host must invalidate any channel failure, and must retain its outer deadline
because JavaScript cannot preempt a synchronously blocked event loop.

## Qualification and remaining integration

The complete pilot JavaScript suite passes 159 tests, including session tests for
ordered primitives, invalid sequence, invisible/stale/distant/undiggable targets,
concurrent cancellation, late completions, death, disconnect, action/session caps,
finish and transcript timing. Observation tests cover metadata exclusion, invalid
slots/coordinates and coercible names. These tests run on Node 20 and 22 in CI.

Channel tests also cover fragmented/pipelined/oversized requests, write callback
races, stalled output, trailing data after finish and suppression of late replies.
A real Node subprocess exchanges observe/look/dig/move/finish over OS pipes with
the actual session and a bot double; a lifecycle message on that channel is
rejected with no action reply. This establishes transport behavior, not gameplay.

Next wire dedicated action descriptors while preserving trusted lifecycle
messages. Capture these sources in the participant manifest, pass every session
failure into host acceptance, and replay an explicit observe/look/dig/move/finish
sequence in an isolated game. Require positive/no-action controls and a cancelled
session whose endpoint cannot be promoted to success. Only then connect a model,
freeze inference budgets and begin comparative trials. The historical intermittent
bridge shutdown failure also remains unresolved.
