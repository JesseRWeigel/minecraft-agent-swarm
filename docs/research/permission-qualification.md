# Player-command permission qualification

The protected participant can now run a fixed, stationary permission probe over
its normal game connection: `/op PilotProbe`, wait one second, then
`/gamemode creative`, wait one second. It never receives console, RCON or observer
access. The commands are literal code, not user-supplied strings. The host accepts
only the named probe cases and rejects combining them with forward movement.

## Paired experiment, 22 September 2026

The final comparison uses identical captured code, client dependencies and world
archive pins, with fresh disposable worlds. In one case the supervisor grants
operator status through the private server console before issuing `begin`; in
the other it does not. The participant runs identical commands in both.

| Attempt | Configuration | Observed result |
| --- | --- | --- |
| 001 | Ordinary player, earlier supervisor metadata | Both commands logged; survival retained; saved operator list empty |
| 002 | Supervisor-authorized operator, final sources | Both commands logged; creative mode observed; expected actor saved as level-4 operator |
| 003 | Ordinary player, final sources | Both commands logged; survival retained; saved operator list empty |
| 004 | Ordinary forward control, no command probe | Qualified movement in survival |
| 005 | Ordinary stationary control, no command probe | Qualified stationary observation in survival |

See [all attempts and source/evidence pins](permission-results-2026-09-22.json).
Attempt 001 predates a metadata correction: command probes no longer produce a
misleading post-action fault-request marker. Its raw evidence remains preserved;
002/003 are the final comparison. All five use the same participant code.

Delivery was checked against the saved Paper log, requiring exactly one receipt
for each command. Effects were checked against the independent terminal sample
and persisted `ops.json`, extracted read-only after unmount. The operator control
shows that the same participant command path can change game mode when granted
permission; ordinary-player denial is not inferred merely from a silent client.
The first command alone does not independently prove the authorized client can
grant operator status, since the supervisor already granted it for that control.

The supervisor deliberately leaves `command_probe.effect_verified` false: a
request is not proof. The derived audit pairs terminal evidence with the hashed
server log and saved operators. Both probe cases retain overall `failed` status
and are excluded from movement qualification, even when the denied case's
stationary observations are valid. Do not treat this status as a failed command
probe or include these runs in a model-success denominator.

All five clients and servers exited normally; scopes and mounts cleaned up.
Effective resource limits were verified and no memory/task limit violation was
recorded. Probe workers intentionally return nonzero, so their scope's aggregate
`valid` field is false. Source archives, persistent result/world metadata, logs,
operator files and storage images were hashed and retained. The live swarm and
GPU/model workload were untouched.

## Reproduction

Use the existing explicitly launched, pinned protected qualification with fresh
workspaces and `movement_mode="stationary"`:

- `failure_case="command_denied"`: ordinary-player probe.
- `failure_case="command_authorized"`: supervisor grants operator status first.
- `failure_case="none"`: ordinary control; repeat with forward mode as well.

The [protected setup](protected-movement-qualification.md) and
[bounded storage](bounded-storage.md) requirements apply. Keep the private raw
archive and credentials out of public exports. Verify both command receipts,
terminal mode, saved operator list, source equality and cleanup before calling
the pair qualified. A missing receipt, malformed record or missing control is
incomplete evidence, not proof of denial.

## Limits

This tests two ordinary command forms on the pinned Paper runtime. It does not
cover command aliases, plugins, malicious packets, temporary permission changes,
all abilities, inventory mutation or arbitrary code. Before/terminal observations
and persisted operators are not continuous monitoring. The larger permissions
and adversarial-protocol release gate remains open. There is no model benchmark,
learning, cost-saving or robotics-transfer result in these trials.
