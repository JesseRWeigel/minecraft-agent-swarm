# Oak-log evaluator components

Status: synthetic component qualification only. The protected game launcher still
runs movement, not this task. No actual oak-log mining, collection or model trial
has been qualified by these modules.

`tools/pilot/oak-task.mjs` adds a separate versioned observation envelope and
pure host predicate for `collect-oak-log-v1`. It reuses the unchanged actor sampler
for UUID, roster, position, dimension, health and survival mode, then reads the
inventory and tests the fixed `(0, 200, 3)` block for oak log and air. Task identity,
query list and rules have a SHA-256 pin. No participant-supplied command, selector
or coordinate is accepted. Existing movement code and evidence semantics remain
unchanged.

`tools/pilot/oak-inventory.mjs` parses a deliberately narrow Minecraft 1.21.4
ordinary-item SNBT subset: compounds containing exactly `Slot`, `id` and `count`.
It accepts empty inventories, all ordinary inventory/armor/offhand slot indices,
count 1 through 64, and namespaced Minecraft item IDs. It rejects duplicate
slots/keys, unknown fields (including item components), malformed types, trailing
data, more than 41 entries and replies larger than 65,536 bytes. This is not a
general SNBT parser or support for every valid Minecraft item. Unknown shapes
fail closed pending explicit schema support.

The observer preserves the actor sample and any completed inventory/block query
when a later field fails. A shared five-second maximum sample budget bounds
query waits; timeout, bad clocks, oversized replies, contradictory block tests
and parsing errors yield a failed observation. Per-query timing and raw bounded
replies are retained for the new fields. As with the existing actor sampler,
a timeout cannot cancel an arbitrary transport: the future supervisor must own
and close the RCON connection and enforce a process deadline.

The host predicate reparses the raw inventory/block replies and checks them
against the stored parsed fields. It requires matching task/trial/action/actor
identity, complete ordered query timing, valid health/mode/dimension/roster,
empty initial inventory and the initial oak log. Acquisition requires the target
now be air and the terminal inventory contain exactly one ordinary oak log and
nothing else. Participant success fields are ignored.

The predicate returns `status: observed` with `acquired: true/false`, or
`status: invalid` with `acquired: null`. It **always** returns
`gameplayQualified: false`. It has no authority to certify fixture completeness,
action budgets, process isolation, runtime source/world identity, or cleanup.
These gates belong to the protected host runner. Trusted observer evidence must
remain outside participant capabilities; this function does not authenticate
arbitrary JSON handed to it. The `acquired` field describes the observed endpoint
only: proving that ordinary gameplay caused that endpoint also requires the
future fixture/isolation/intervention gates. A privileged item grant plus block
removal could otherwise create the same endpoint.

## Verification

```sh
node --test tools/pilot/oak-inventory.test.mjs tools/pilot/oak-task.test.mjs
```

Eighteen tests pass locally and run in Node 20/22 CI. Cases include ordinary
acquisition, no action, broken-but-uncollected target, item with unchanged target,
wrong item/count/extra items, initially solved states, raw/parsed disagreement,
wrong identities/mode/death, incomplete queries, timeout with retained partial
state, invalid clocks and malformed scorer input. The full local pilot JavaScript
suite passes 107 tests with its RCON dependency supplied. Synthetic adapters
supply the replies; these results do not establish Paper reply compatibility.

## Next integration gates

1. Add and pin the bedrock/air arena fixture with independent initial readbacks.
2. Wire this observer through a protected child process with private RCON
   credentials; keep its reports and code inaccessible to the participant.
3. Add a fixed ordinary survival client for mining and collecting, plus no-action
   and inaccessible-target controls. Do not use commands to award the item.
4. Verify actual Paper 1.21.4 inventory text and block-test replies. Preserve any
   unsupported reply or failed setup; update the versioned schema if required.
5. Invoke the host predicate only alongside the existing provenance, fixture,
   action protocol, budget, resource and cleanup gates. Missing evidence remains
   invalid, not an observed negative control.

See the [task design](first-survival-task.md) for the remaining false-success
matrix and study boundaries. No GPU/model workload or live swarm change is part
of this component implementation.
