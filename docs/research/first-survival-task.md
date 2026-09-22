# First survival task: collect one oak log

Status: [observer and predicate components](oak-evaluator-components.md) are
implemented and tested synthetically; the complete task is not running or
game-qualified. This is not a registered experiment or model result. The fresh-world movement qualification is the preceding gate.

## Why this task

`collect-oak-log-v1` adds world interaction, item collection and a server-checked
inventory outcome to the protected movement pipeline. A bare-handed player can
obtain an oak log; cobblestone would require a pickaxe and is unsuitable for an
empty-inventory fixture. This was checked against the clean checkout's installed
Minecraft 1.21.4 `minecraft-data`: oak log is diggable, has no required harvest-tool map and drops item 134 (`oak_log`). Cobblestone declares required harvest
tools. Treat these data as design evidence; qualify actual Paper behavior next.

The task is deliberately small. If all candidate systems solve it immediately,
use it as a collector/evaluator check and move on to a separately versioned
crafting task. Do not spend a model comparison budget on a ceiling-effect task.
One oak log can later yield four oak planks, but crafting changes the terminal
predicate and must have its own task version and controls.

## Declared setup and readbacks

Use one generated archive for matched conditions. Trusted fixture setup runs
before the measured action and is recorded as an intervention, not bot progress.
Use the existing fixed actor UUID/one-player admission and private game bridge.

- Build an enclosed bedrock arena in the overworld, with an air interior. Keep
  the player and target away from walls and isolate the area from natural terrain.
- Start `PilotProbe` at `(0.5, 200, 0.5)`, yaw/pitch zero, in survival mode with
  health and food 20, no effects, empty inventory and no dropped item entities.
- Place exactly one oak log at `(0, 200, 3)` for the first development instance.
  Record its block type and position, arena recipe hash and world archive hash.
- Check inventory, orientation, mode, food, effects, UUID, roster, dimension,
  position and target block from the trusted server before `begin`. Any failed
  setup/readback is an invalid attempt. No repair after the action starts.
- No other logs, item sources, containers or extra players inside the enclosure.
  Inventory must be empty, not merely missing the target item.

The target is within a small navigable space; collecting its dropped item still
requires actual survival interaction. An initial deterministic control should
look at the target, mine it bare-handed, collect the drop and remain connected
for the terminal sample. It must use ordinary game actions only.

## Authoritative success predicate

Extend the protected observer with bounded, allowlisted queries for inventory
and the declared target block. Never interpolate arbitrary participant-supplied
commands or coordinates. Parse the pinned version's inventory format strictly;
reject malformed, duplicate-slot, negative-count, oversized or unknown shapes.
Keep raw bounded replies and field timing windows beside the parsed values.

Require all of the following on the host, independently of participant claims:

1. A valid initial state: log exists, inventory empty, matching actor and task.
2. A complete terminal sample from the same task/action/actor; overworld,
   singleton roster, correct UUID, survival mode and positive health.
3. The declared log block is now air, and the inventory contains exactly one
   ordinary `minecraft:oak_log`. Items elsewhere in the world do not count.
4. Finished action protocol, deadline and resource compliance, normal participant
   and server lifecycle, verified scope cleanup and verified storage unmount.

A valid terminal sample without the item is an observed task failure. Missing
or unparseable evidence is an invalid/censored attempt with a reason; it must
not become a successful negative control. Report both categories and keep their
costs and artifacts. Sequential server queries are not an atomic snapshot;
record their intervals and settle before terminal sampling, as in movement.

## Required controls before model work

| Case | Expected result |
| --- | --- |
| Ordinary survival client mines and collects the log | Qualified success |
| No-action client | Valid observed failure, unchanged target, empty inventory |
| Target behind an unbreakable bedrock barrier | No success within budget |
| Target already absent or inventory initially nonempty | Invalid setup |
| Target broken but item not collected | No success |
| Item present but target unchanged | No success |
| Forged participant success message | Cannot affect host result |
| Wrong actor/UUID, roster, dimension or game mode | Invalid |
| Death, disconnect, malformed reply, missing terminal, deadline/resource fault | Invalid/censored; partial evidence retained |

Keep exact deterministic timing budgets in a versioned task manifest before
qualification. Calibrate them with model-free controls. Pin final values before
model runs; do not infer model/token/coach budgets from an arbitrary suggestion.

## Implementation boundary

Reuse the protected supervisor, admission bridge, resource scope and bounded
storage. Add a separate task fixture and host predicate rather than changing
historical movement semantics. Extend observation fields through a versioned
schema so historical evidence cannot accidentally satisfy the new predicate.
Tests must recompute results from observations and include the false-success
cases above. Capture/pin any new sampler, fixture, participant and scorer sources.

The fixed-client pipeline is not yet qualified for arbitrary agent code. For
model work, expose bounded look/movement/mining actions through a trusted
adapter; the model does not receive chat/slash commands, raw packet APIs, RCON,
filesystem, process or network tools. That interface still needs implementation
and qualification. An allowlist in a design document does not enforce it.

## Calibration and later comparison

Use distinct development and held-out layout IDs with frozen recipe hashes.
Any layouts shown here are development examples and cannot later be presented
as unseen. Freeze held-out positions, ordering, budgets, exclusion rules and
adaptation artifacts before outcomes are examined. Match archive, task and
starting state across compared conditions and reset transient memory each time.

Start by testing feasibility with one fixed actor. Do not infer a swarm/team
advantage from a task that admits only one player. A later team experiment must
define whether several models advise one actor or multiple actors act in-world;
the latter requires a separately qualified admission/roster policy. Include
local-only and team-without-coach baselines before attributing changes to coaching.

For retained-learning claims, turn the coach off during held-out evaluation and
freeze the learned memory/skills first. Count development, coaching, failed
attempts and evaluation costs separately. No GPU/model phase begins through this
document. See the [study protocol](../pilot-study-protocol.md).
