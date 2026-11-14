# Reactive eat with no food aboard

`BotBrain.handleReactive` could recommend and execute `eat` with nothing to eat:

- The `low_health` prompt said "Eat food or flee to safety." whatever the inventory held, and `took_damage` gave no food state at all.
- The reactive menu kept `eat` even when `hasEdibleAboard()` was false. When every action had recently failed, the fallback was the full role list, so `eat` came back.
- `queryReactive` does not check the reply against the menu, so an `eat` the menu never offered still ran.

## Change

All of it is in `src/bot/brain.ts`, inside `handleReactive`.

- Food availability is read with `hasEdibleAboard()`, which uses the eat action's own `FOOD_PRIORITY` list. The `low_health` and `took_damage` prompts now carry `Food available: yes` or `Food available: NONE (eat is impossible)`. With no food, `low_health` says "No food to eat: flee to safety or idle." and the no-hostile hint no longer says "eat if you can".
- With no food, `eat` is taken off the role menu before the recent-failure filter. The fallbacks only ever narrow that list: recent-failure filtered, then the eat-free role list, then `["idle"]`. The menu is never empty, because `buildReactivePrompt` shows its full default menu, `eat` included, for an empty list.
- After the query, the handler returns without acting if the brain is `stopped` or `paused`, or if `drownRescueActive` (the real navigation claim) says a drown rescue owns the keys. The same check runs again after the 300 ms wait that follows a skill abort.
- `hasEdibleAboard()` is checked again after the query. If the reply is `eat` and there is no food now, it becomes `flee {}` only when a hostile is within 16 blocks right now and the role's `allowedActions` includes `flee`. Otherwise it becomes `idle {}`. A real eat with food still aboard is unchanged.
- The skill-abort gate uses a live `hostileWithin(16)` taken after the query, not the event's `reason`. A `hostile_nearby` event whose mob has gone no longer counts as critical, so it defers instead of aborting the skill.
- Two test seams, `skillRunning` and `skillAborter`, sit next to the existing injectable ones. They default to `isSkillRunning` and `abortActiveSkill`.

Combat policy is unchanged. `attack` is not banned or rewritten. The critical rule (health ≤ 8, a threat, flee or attack) is the same apart from its threat source. The provider-error fallback is still `flee`.

## Tests

`src/bot/reactive-food.test.ts` drives the real `handleReactive` on a brain built with `Object.create(BotBrain.prototype)`. The model is scripted through `setChatClientForTests`, and `executeDecision` is replaced with a recorder.

1. No food, live hostile, role may flee: the system prompt has no `eat` line, the situation says `Food available: NONE`, and a hallucinated `eat` runs as `flee`.
2. No food: no fallback puts `eat` back. This covers the recent-failure fallback and an eat-only role, which gets the idle menu.
3. Food lost while the query is pending: `eat` was offered, and the stale `eat` runs as `idle` because no hostile is near.
4. Food still aboard: `eat` runs as `eat`.
5. No food, no hostile: `idle`, not an unnecessary `flee`.
6. No food, hostile near, role without `flee`: `idle`.
7. A stale `hostile_nearby` event with no live mob, at 4 health with a skill running: the `flee` defers and the skill is not aborted. A live hostile still aborts the skill and flees.
8. Paused or stopped during the query: nothing executes.

9. A real `escapeWaterIfDrowning` claim remains active while the model replies: no action or skill abort occurs, and jump stays held.

Validation: all 1,130 tests and TypeScript passed. Mutation-disabling the post-query food guard caused five focused regressions to fail; exact source was restored.

## Limits

- The `hostile_nearby` prompt still lists food from its own short hardcoded list, not `FOOD_PRIORITY`. The menu and the post-query check use the correct list, so a wrong prompt line cannot lead to an impossible eat.
- Only `eat` is checked for feasibility after the query. Other off-menu replies (such as a role-forbidden action) still go to `executeDecision` as before.
- This has not been validated on a live server. It is a targeted feasibility fix, not evidence of better survival.

## Reproduce the asynchronous emergency boundary

Run `node scripts/test-runner.mjs src/bot/reactive-food.test.ts` with the
repository's Node 22 and installed dependencies. This is a CPU-only synthetic
validation: no model service, Minecraft server, world, or paid API is needed.

The fixture now runs the real drowning-rescue routine at two boundaries:

- Before the model reply: rescue already owns jump, so no skill abort or new
  decision occurs.
- Inside the skill-abort callback: the first guard has already passed, then
  rescue acquires ownership during the handler's actual 300 ms abort wait.
  The second guard must suppress the stale flee decision while jump stays held.

A separate case pauses or stops the brain at that same abort boundary. Both
must suppress execution. The original live-threat case is the positive control:
without an interruption, one abort is followed by one flee decision.

The world, model reply, and final action executor are controlled fixtures. The
handler and rescue ownership logic are production code. These assertions prove
control arbitration, not successful physical escape or improved survival rates.
The fixture releases rescue ownership in a finally block.

Mutation check: removing only the post-abort `halted()` guard caused the two new
boundary tests to fail (9 passed, 2 failed). The production source was restored
byte-for-byte before final checks. No production code changed for this addition.
