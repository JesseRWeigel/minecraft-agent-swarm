# Oak acquisition negative controls

Four fresh isolated Paper runs on 22 September 2026 used one source manifest,
world archive, server JAR and dependency snapshot. All four qualified under their
declared control conditions. Only mine-and-collect acquired the item.
This is deterministic fixed-client qualification, not model performance.

| Attempt | Mode | Action seconds | Target at terminal | Inventory | Acquired |
| --- | --- | ---: | --- | --- | --- |
| attempt-001 | `mine_only` | 3.0936 | `minecraft:air` | empty | false |
| attempt-002 | `blocked` | 1.0129 | `minecraft:oak_log` | empty | false |
| attempt-003 | `forward` | 3.5510 | `minecraft:air` | one oak log | true |
| attempt-004 | `stationary` | 0.0007 | `minecraft:oak_log` | empty | false |

[Derived evidence and exact pins](oak-negative-results-2026-09-22.json) include
all four attempts. Each had normal participant and Java exits, confirmed scope
cleanup and storage unmount. The export rehashed the captured sources, source
manifest, closed runtime image and saved world metadata. It recovered fixture,
before and terminal observer records from the unmounted image and compared their
payloads with the worker result. The current host launcher independently captures
before/terminal records; fixture-record comparison is an additional export audit,
not yet a separate host-launch acceptance gate.

## What the controls establish

`mine_only` uses the same ordinary survival mining path as `forward`, then skips
collection. The server observed target air, unchanged actor position and an empty
inventory. Breaking the block alone therefore did not satisfy acquisition.

`blocked` adds bedrock on the five non-floor faces adjacent to the target; the
existing floor is bedrock. Setup verifies all six faces through exact server
block checks and retains the parent fixture receipts. The client verifies a
cursor-visible undiggable bedrock block, walks forward for one second and stops.
The server observes forward approach, an intact log and empty inventory.
This is a barrier-approach negative control: it never attempts to dig the enclosed
log and does not establish impossibility against arbitrary agent strategies.

`forward` repeats ordinary mining and collection with the final control sources;
`stationary` does nothing. These action durations differ and must not be used as
matched model-comparison budgets. A qualified negative control means a complete,
valid observation of no acquisition. Missing observations are not negative results.

## Reproduction and next gates

Use the pinned-input Python recipe in [oak gameplay qualification](oak-game-qualification.md).
Set `control_mode` to `mine_only`, `blocked`, `forward` or `stationary`, with a
fresh workspace for each. All use `failure_case="none"`; the control determines
its predeclared expected outcome. Setup commands run before the action and are
not agent-earned progress. No model calls, GPU inference, live-world changes or
live swarm restarts were made.

Next: bind raw fixture observer records directly in host acceptance, reject
injected-item false positives, qualify interrupted actions and missing observations
for this oak task, then build the bounded model-facing action adapter. Full arena
volume verification and independent-host reproduction remain open. Do not report
model learning, cost savings or robotics transfer from these controls.

Validation: 125 pilot JavaScript tests and 369 Python tests passed, including four
explicit real namespace tests (ordinary discovery skips those four).
