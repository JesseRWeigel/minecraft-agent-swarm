# Protected movement qualification

This is an experimental fixed-client infrastructure check. It is not normal
swarm gameplay, a model benchmark, or a source of earned advancements.

## Scope

Every invocation restores a new private copy of a pinned world archive. The
trusted setup process deliberately builds a small platform, places `PilotProbe`
at `(0.5, 200, 0.5)` facing +Z, and normalizes its inventory, game mode, health,
food and effects. Those commands are recorded fixture interventions before the
measured action. They must never be reported as bot-earned gameplay progress.
The live world and swarm processes are not part of this path.

`run_protected_qualification` requires explicit `launch=True`, new workspace,
pinned archive/server inputs and a verified Node/dependency snapshot. It never
connects to a host game server. Its outer Bubblewrap namespace has private
networking, a copied world, Java, the trusted supervisor and observer code.

The participant runs in a nested mount/PID/user namespace with only pinned
participant code, read-only dependencies, fresh environment/proc, and bounded
temporary mounts. It inherits the outer private network so it can reach the
game server. It cannot see the observer source, credential, world, or evidence
mounts. The observer receives its credential only through a trusted stdin pipe;
it writes samples through the outer supervisor, not a participant-writable file.

## Evidence sequence

1. Capture source hashes and restore/verify fresh inputs.
2. Start the isolated server and fixed participant; validate `ready`.
3. Apply the declared fixture. Check rotation, inventory, survival mode, food and
   effects through server readbacks; verify server position/dimension/health.
4. Capture a separate before observation, then send `begin` to the participant.
5. Execute one second of forward movement or stationary control. Keep the client
   connected, allow 300 ms of settlement, and capture a separate terminal sample.
6. Send `finalize`, validate protocol EOF and exit, then stop Java normally.
7. Recompute the movement predicate on the host from server observations. Require
   matching identities, validated fixture, positive health, correct starting
   position, preserved dimension and normal lifecycle. Retain failure artifacts.

The forward predicate requires 0.5–10 blocks of +Z progress with little lateral
or vertical deviation. The stationary control requires less than 0.05 blocks
of horizontal change. Missing observations, death or failed setup are invalid
qualification attempts, not successful negative controls.

## Measured results: 21 September 2026

| Preserved attempt | Mode | Server-observed horizontal change | Outcome |
| --- | --- | ---: | --- |
| 001 | Forward | Not measured | Fixture setup failed before action |
| 002 | Forward | 3.797923 blocks | Qualified |
| 003 | Stationary | 0 blocks | Negative control observed |
| 004 | Forward repeat | 4.013782 blocks | Qualified |
| 005 | Stationary repeat | 0 blocks | Negative control observed |

The first attempt exposed a legitimate empty response when requesting survival
mode for an actor already in survival. The fixture now permits that response only
for this command, still requiring an independent survival-mode readback. Failed
setup remains invalid and its artifacts are retained.

All four successful checks began at `(0.5, 200, 0.5)` with health 20, ended with
health 20, and had normal participant and Java exits without forced cleanup.
The two final repeats used the same captured source manifest
`ef4de27780ce57d9b7efab393f0626f287ab20abd04e7e50631eb70d3ecaaf58`,
which was checked against the current executed sources. Earlier attempts retain
their own source hashes. A one-second wall-clock action spans variable server tick
counts; the two forward distances are not identical trajectories.

The original archive was rehashed unchanged after all five attempts. No live
swarm mode, process or world was changed, and no model was loaded or called.
[Derived evidence for all attempts](protected-movement-results-2026-09-21.json)
includes server samples, fixture records, source/input hashes, and lifecycle
outcomes. Private raw logs, server credentials and the world archive are excluded;
this is not an independently reproduced or public raw-data release.

Real nested-namespace checks exercise the production participant argument builder.
Unit/process tests cover invalid observations, forged scores, timeout/output
bounds and cleanup. The post-action failure cases below now have real game evidence; they do not
cover every failure timing, network stall or generated participant behavior.

## Post-action failure checks: 21 September follow-up

The host API accepts `failure_case="none"` (default), `"death"`, `"disconnect"`
or `"observer_timeout"` alongside the existing explicit launch and pinned inputs.
Unknown cases are rejected before creating a workspace. There is no arbitrary
command argument. All fault runs are excluded from successful qualification,
even if their serialized samples or score would otherwise pass.

Each case starts a fresh disposable world and verified actor baseline, completes
the fixed movement action, then injects a trusted fault before terminal sampling:

| Case | Observed evidence | Evaluator and cleanup |
| --- | --- | --- |
| Death | Server terminal health 0, despite approximately 3.79 blocks of movement | Invalid observation for scoring; participant and Java exit normally |
| Disconnect | Server confirms the fixed kick reason; terminal observer returns failed/invalid response | No valid terminal sample; participant forcibly cleaned up, Java stops normally |
| Observer timeout | Real terminal helper is suspended; parent records `observer_deadline` after approximately 2 seconds and reaps it with return code -9 | No terminal sample; participant forcibly cleaned up, Java stops normally |
| Fresh forward control | 3.794800 blocks, health 20 | Qualified; normal participant and Java exit |
| Fresh stationary control | 0 blocks, health 20 | Negative control observed; normal participant and Java exit |

[All five attempts and evidence pins](protected-failure-results-2026-09-21.json)
use the same captured current sources. The original archive was rehashed unchanged.
Raw private evidence remains preserved. The timeout is a **suspended-process
supervisor deadline check**, using a shortened two-second test deadline; it does
not exercise the observer's internal RCON timeout or simulate a network stall.
The console command being sent is not itself proof of death or disconnection:
those conclusions use the retained server observation or server confirmation.

These faults occur after `action_finished`. Mid-action death/disconnect, malformed
participant traffic in a real game, a stalled participant, and RCON stalls are
not covered by these five attempts. Unit/process tests cover several such failure
mechanisms, but must not be described as that complete game matrix. A missing
terminal observation is an invalid attempt, never a valid negative control.

## Limits

- Only the fixed immutable client is qualified here; no arbitrary generated code
  or model-driven agent is allowed by this experiment's contract.
- Node heap limits and temporary mount sizes are not comprehensive native-memory,
  CPU, process, world-growth or disk quotas. Model trials still need resource gates.
- The participant shares the outer network, including reachability of the RCON
  port. Its fixed code receives no credential. Before arbitrary participant code,
  enforce a game-port-only network boundary as well as aggregate resource limits.
- RCON field samples are sequential, not atomic; sample and supervisor timings
  are preserved. Process-separation claims are tied to captured source and the
  qualified namespace launch path, not remote attestation.
- The fixture freezes a reviewed arena setup and measured actor state, not every
  entity or tick in the copied world. It does not establish survival-task fairness,
  memory retention, learning, inference cost savings or robotics transfer.

See [release gates](benchmark-release-checklist.md) for the larger model study.
