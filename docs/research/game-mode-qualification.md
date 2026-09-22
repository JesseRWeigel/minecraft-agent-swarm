# Survival-mode integrity check

The movement fixture already configured and verified survival mode at startup,
but terminal scoring did not check that the actor remained in that mode. A
regression test demonstrated that an otherwise valid movement result could be
accepted without terminal game-mode evidence.

The observer now records `playerGameType` through the protected RCON channel at
both observations. The fixed Paper 1.21.4 contract accepts the four integer modes
0 through 3, preserving non-survival modes as evidence. The independent scorer
requires an integer `gameMode: 0` at both observations. Missing, malformed,
boolean, string, floating-point or non-survival values cannot score as movement
success or as a stationary negative control. Serialized success claims remain
untrusted.

## Real-game qualification, 22 September 2026

Each attempt used a fresh restored private world, identical captured sources,
the fixed admitted actor, whole-trial resource limits and bounded persistent
storage. [Derived evidence and pins](game-mode-results-2026-09-22.json) preserve
all three attempts.

| Attempt | Case | Result |
| --- | --- | --- |
| 001 | Trusted console switches the actor to creative after action completion | Server records mode 1; both scoring predicates false |
| 002 | Ordinary forward control | Survival at both observations; 3.797923 blocks; qualified |
| 003 | Stationary control | Survival at both observations; zero movement; qualified |

The creative-mode sample is complete and retained. Replacing the fault label
with `none`, changing status to `qualified`, and supplying a forged success score
still cannot make that result pass host validation. Rejection therefore depends
on the observed mode, not only the declared fault label.

All clients and Java servers stopped normally. All scopes and mounts cleaned up;
no memory or task-limit violation occurred. The deliberately failed worker exits
1, so its scope's overall `valid` field is false even though its effective limits
and cleanup were verified. This is an expected rejected experiment, not a
successful movement run. Post-unmount result/world-metadata hashes were checked,
and the original archive was rehashed unchanged.

Reproduce with the existing pinned qualification setup, setting
`failure_case="creative_mode"` for the injected case and `failure_case="none"`
for each control. Choose a fresh workspace each time. See the
[protected movement setup](protected-movement-qualification.md) and
[bounded storage requirements](bounded-storage.md). Private archives are still
required; this is not yet a redistributable benchmark fixture.

## Scope and next gate

This is **detection of an invalid game mode**, established by trusted console
injection. It does not demonstrate denial of a participant-issued privileged
command or prevention of escalation. Before/terminal snapshots also cannot rule
out a temporary mode change between samples. Survival mode alone does not audit
operator status, abilities, inventory, permissions or world integrity.

Next, exercise a fixed set of privileged commands over the participant's normal
game connection and independently check their effects, with an authorized
positive control proving the commands were delivered correctly. The participant
must retain no RCON, console or observer access. Broader adversarial protocol
coverage remains open.

The live swarm, its mode and world, and GPU/model workload were unchanged. No
learning, model performance, cost savings or robotics transfer was measured.
Historical observations remain pinned to their earlier schemas and sources.

[Player-issued command follow-up](permission-qualification.md): self-op and
creative-mode attempts now have ordinary-player and operator-authorized controls.
