# Experimental evaluation track

This track evaluates Minecraft Agent Swarm. The playable swarm remains the main
project; none of the tools here runs in the normal bot startup path. Research
commands use disposable copies and require explicit launch configuration.

The questions are whether frontier guidance can help a smaller local agent team
complete tasks at lower total cost, whether improvements persist without the
coach, and what simulation traces can establish. Robotics transfer is a separate
unproven question.


**We are building a reproducible benchmark; we have not published a model leaderboard or demonstrated learning or cost savings yet.** The live advancement ledger tracks gameplay progress in an evolving, supervised system. Changes by human and AI maintainers are interventions, and are recorded separately from bot-earned achievements.

### Current checkpoint: protected fixed-client qualification

On 21 September, the full nested participant / separate observer path passed two
forward checks (**3.80 and 4.01 blocks**) and two stationary controls (**0 blocks**),
all from the same measured actor baseline. Each used a fresh restored copy and
stopped normally. One earlier fixture-setup failure is also preserved. These are
infrastructure results from a deterministic client; no model was involved.

See the [qualification and limitations](protected-movement-qualification.md) and
[all five attempts with source pins and observations](protected-movement-results-2026-09-21.json).
The actor baseline is fixed; whole-world state and tick timing are not claimed
identical. A [post-action failure follow-up](protected-movement-qualification.md#post-action-failure-checks-21-september-follow-up)
now also rejects death, disconnect and a suspended terminal observer, with fresh
positive/stationary controls. Mid-action/RCON failure cases and model-trial
resource/identity gates remain. The current participant uses a
[separate network with a game-only bridge](game-only-network.md); historical runs
retain their original shared-network provenance.

### Historical case: predicted movement is not completed movement

On 19 September 2026, a deterministic client on an isolated copy of a Paper 1.21.4 world reported movement that the server had not accepted:

| Preserved attempt | Client-predicted horizontal movement | Server-observed horizontal movement | Evaluator outcome |
| --- | ---: | ---: | --- |
| Before readiness fix | 3.373 blocks | 0 blocks | Movement rejected |
| After readiness and observation fixes | 3.901 blocks | 3.901 blocks | Movement accepted |
| Stationary negative control | 0 blocks | 0 blocks | Movement rejected, as expected |

The diagnosis identified the server's client-loaded readiness gate. The corrected client sends the normal readiness packet and checks position agreement before and after its action. All four development attempts, including an earlier login timeout, were preserved. This case shows why an agent's own report needs verification against the environment.

These were infrastructure checks with no model involved. Spawn positions differed and several fixes were introduced together. The historical client queried the server itself; the protected follow-up above now uses separate observer processes. See the [complete case study and limitations](../pilot-client-qualification-results.md), [machine-readable summary](movement-case-study-2026-09-19.json), and [qualification setup](../pilot-client-qualification.md). The JSON is a derived summary of private evidence, not a public raw-data release or an independently reproduced result.

**Earlier requalification (21 September, before the fixed fixture):** the current no-respawn client moved only **0.20 blocks** in a fresh forward attempt and correctly failed the movement threshold; its stationary control again recorded zero. Positions agreed in both runs and shutdown was clean. These retained results reinforce the need for fixed actor starting states before repeatable comparisons. [Both follow-up attempts and pins](client-requalification-2026-09-21.json).

### What exists and what comes next

- **Available:** preserved world/log archives, run and action provenance, before/terminal observation links, an intervention ledger, offline dataset tooling, and isolated deterministic client qualification.
- **Qualified for the fixed client:** complete protected participant/observer path, bounded communication, declared arena setup, forward checks and stationary controls. This does not qualify arbitrary model-driven code.
- **Next experimental milestone:** publish an audited pilot with fixed actor/task/world conditions, positive and negative controls, and all failed or interrupted attempts accounted for.
- **Research comparison:** local-only agents, frontier-assisted agents, and agents retaining improvements with frontier help removed. Measure server-confirmed success, elapsed time, inference use/cost, and interventions, with held-out tasks for retention/generalization.

The long-running swarm archive is useful material for failure analysis, but it is not automatically a training-ready dataset. Simulation performance alone does not establish transfer to robotics. See the [first-release checklist](benchmark-release-checklist.md), [study protocol](../pilot-study-protocol.md), and [protected observer design and remaining gates](../plans/2026-09-19-protected-observer.md).

### Resource-limit feasibility

[Actual WSL cgroup probes](resource-enforcement.md) now verify memory, PID and CPU
enforcement, including a child that calls `setsid()`. The
[game launcher now applies a verified whole-trial scope](scoped-trials.md), with
normal game controls and an OOM rejection case preserved.
[Bounded persistent trial storage](bounded-storage.md) adds a fixed-capacity image
for the copied world and evidence. A [real post-action disk-full check](disk-full-qualification.md)
now rejects a missing terminal record while retaining earlier evidence and a
bounded external receipt. [Fixed actor admission and server identity checks](actor-identity.md)
now bind the connection to the expected UUID and one-player roster, with fresh
forward/stationary game controls. A [survival-mode integrity check](game-mode-qualification.md)
now rejects a deliberate post-action creative-mode change, with both controls
repeated. [Player-command probes](permission-qualification.md) now verify that
ordinary-player self-op and creative-mode attempts have no observed effect,
while the same client changes mode in an operator-authorized control. Broader
permissions/protocol behavior, remaining combined fault cases
and an earlier unresolved shutdown failure remain open.

### Repository boundary

Keep the swarm and this experimental track together while the evaluator directly
measures this agent implementation. The main README and normal startup should
remain about using the swarm. Research commands, evidence, dependencies and
claims belong here and under `tools/pilot`, outside normal startup.

Consider extracting an evaluator when another agent implementation uses it,
external users need independent releases, or evaluation dependencies materially
complicate swarm installation. Preserve versioned agent/evaluator interfaces and
source provenance if that happens. A separate dataset release can have its own
version and license without moving the application code now.

Typed decision models such as Jev and independent local alternatives are an
[optional offline comparison](typed-decision-models.md), not a new project goal
or required runtime dependency.

### Contribute to the benchmark

The highest-value contributions now are small survival tasks with explicit starting conditions and server-checkable success criteria, negative controls that catch false success, and independent reproduction of the qualification. Please include expected evidence, failure conditions, and reset requirements in an issue. Start with [the benchmark tracking issue](https://github.com/JesseRWeigel/minecraft-agent-swarm/issues/32).

You can run the dependency-free Python pilot checks without starting Minecraft or loading a model:

```sh
python3 -m unittest discover -s tools/pilot
```

Real namespace checks require a supported Linux host and an explicitly configured Bubblewrap executable; they are skipped by ordinary discovery. See the [explicit qualification commands](../plans/2026-09-19-protected-observer.md#qualified-synthetic-boundary-19-september-2026). Game qualification uses disposable copies and requires its own pinned local assets; the private world, raw logs, credentials, and model files are not bundled.


### RCON timeout evidence

A [real TCP query-stall regression](rcon-stall-qualification.md) exposed and fixed
a timeout race that discarded partial observations. The sampler now retains its
completed position before reporting the stalled query. This uses a synthetic
RCON endpoint; combined Paper/game fault qualification remains open.

The [isolated Paper follow-up](rcon-game-qualification.md) now retains partial
evidence for a deliberately withheld RCON reply and passes its forward control.
The initially blocked stationary control now also passes after lossless sparse
archival reclaimed space from completed images. Their exact hashes and logical
sizes are unchanged; the host reserve remains intact.
