# Bounded model-action session: offline qualification

Status: implemented and tested with bot doubles; not yet wired into the protected
Minecraft participant or a model coordinator. No game or model-performance result
is claimed for this interface.

`createModelActionSession({bot})` in `tools/pilot/model-action-session.mjs` owns an
already connected bot. It parses each request with the strict schema, executes
one action at a time, and returns a bounded response. Construct the session only
after the trusted supervisor begins the action window: its timer starts at creation.
The caller still owns process isolation, pipe framing, independent scoring and
final trial cleanup.

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

## Qualification and remaining integration

The complete pilot JavaScript suite passes 150 tests, including session tests for
ordered primitives, invalid sequence, invisible/stale/distant/undiggable targets,
concurrent cancellation, late completions, death, disconnect, action/session caps,
finish and transcript timing. Observation tests cover metadata exclusion, invalid
slots/coordinates and coercible names. These tests run on Node 20 and 22 in CI.

Next implement the bounded pipe bridge, preserving separate trusted lifecycle
messages. Capture these sources in the participant manifest, pass every session
failure into host acceptance, and replay an explicit observe/look/dig/move/finish
sequence in an isolated game. Require positive/no-action controls and a cancelled
session whose endpoint cannot be promoted to success. Only then connect a model,
freeze inference budgets and begin comparative trials. The historical intermittent
bridge shutdown failure also remains unresolved.
