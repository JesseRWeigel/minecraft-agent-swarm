# strip_mine tunnel step and drowning rescue

`strip_mine` walks each tunnel step with `moveToPosition`, which raced `pathfinder.goto` against an 8 second timer. Two defects let it clobber a drowning rescue:

- The timer was never cleared. After a successful step it still fired 8 seconds later and called `setGoal(null)`, which runs the pathfinder's `resetPath` and clears every control state. That released a rescue's jump, or rejected whatever walk was live by then.
- The rescue takes over by claiming and then resetting the live goal, which rejects the step's goto. The catch then ran the manual fallback (`lookAt`, forward on, wait 8 ticks, forward off), pressing and releasing keys the rescue owned.

## Change

`moveToPosition` is now exported and returns `"arrived" | "fallback" | "rescue"`.

- The timer handle is cleared in `finally`, so a step that ends leaves nothing scheduled.
- `drownRescueActive` gates every new action: at entry (no goto, no timer), inside the timer before its `setGoal(null)`, after the goto settles, after the `lookAt` await (no forward press), and after the `waitForTicks` await (forward is not released; the rescue may be holding it for a shore swim). The error path releases forward only when no rescue is active.
- On `"rescue"` the tunnel loop returns at once with `success: false`, the step number, blocks mined, ores found, and "run strip_mine again to continue". It does not dig on from a cell it never reached.
- Normal behavior is unchanged: same `baseMoves` with `canDig = false`, same 8 second budget, same manual nudge. `"arrived"` and `"fallback"` both continue the tunnel as before. Test-only options: `timeoutMs` and `prepareMovements`. The stub replaces `baseMoves`, which needs a real registry.

## Tests

`src/bot/drown-rescue-ownership.test.ts` gained seven tests. They run the real `moveToPosition` and `escapeWaterIfDrowning` against the existing fake bot, whose `setGoal` clears control states and rejects a live goto:

1. A successful goto leaves no timer: 10 seconds later there is no `setGoal`, a later goto is still pending, and jump and forward are held.
2. A rescue active at entry gets `"rescue"`, with no goto, no reset, and no forward press. Jump survives 10 seconds.
3. A rescue that rejects the goto mid-step gets `"rescue"`, with no manual fallback and only the rescue's own reset, including after the old 8 second mark.
4. A rescue that starts during the fallback's `lookAt` gets no forward press.
5. A rescue that starts during the fallback's tick wait keeps its forward key.
6. With no rescue, a stuck goto still ends at 8 seconds with one path reset and returns `"fallback"`, with forward released.

7. A rescue claimed before the successful goto continuation returns `"rescue"`, so the caller does not continue digging.

Validation: all 1,089 tests and TypeScript passed. Removing the timer cleanup caused the successful-step regression to fail; the exact final source was restored.

## Limits

- The default `baseMoves` setup path is not exercised by these tests (it is stubbed). It is unchanged code.
- Only `moveToPosition` is covered. The other `Promise.race` timers in strip_mine (descent, shift, ore chase, `digSafe`, `raced`) still leak their timers and still call `setGoal(null)` in their catches without a rescue gate. That is out of scope here.
- If a rescue starts while the fallback holds forward, forward stays pressed until the rescue sets or releases its own heading. The rescue's head-dry cleanup releases forward. The step deliberately does not touch it.
- If the timer fires during an active rescue while the goto is somehow still pending, the step does not reset the path. The goto is left to the rescue, which resets any live goal when it takes over.
- This has not been validated on a live server. It is a targeted control-race fix, not evidence of better survival or mining yield.
