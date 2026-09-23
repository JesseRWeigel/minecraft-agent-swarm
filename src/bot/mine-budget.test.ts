import { test } from "node:test";
import assert from "node:assert/strict";

import {
  travelBudgetMs,
  MIN_TRAVEL_MS,
  MAX_TRAVEL_MS,
  DEEP_TRAVEL_MS,
  MAX_TRAVEL_LEGS,
  LOOKAT_RETRY_MS,
  legWorthContinuing,
} from "./mine-budget.js";

// mineBlock searches for ore up to 64 blocks away and used safeGoto's 15 second
// default while tunnelling through stone. One 1h48m session: 39 "Navigation
// timed out", 28 "dig timeout", 8 iron mined.
test("a distant vein gets far more than the old 15 second default", () => {
  assert.ok(travelBudgetMs(64) > 15_000, "64 blocks of digging cannot happen in 15s");
  assert.ok(travelBudgetMs(40) > 15_000);
});

test("a nearby block still fails fast", () => {
  // Otherwise one unreachable block underfoot burns a minute of the action budget.
  assert.equal(travelBudgetMs(2), MIN_TRAVEL_MS);
  assert.equal(travelBudgetMs(0), MIN_TRAVEL_MS);
});

test("budget never exceeds the cap", () => {
  // A single mine_block must not be able to eat the 150s action watchdog.
  assert.equal(travelBudgetMs(500), MAX_TRAVEL_MS);
  assert.ok(MAX_TRAVEL_MS < 150_000, "must stay well inside the action watchdog");
});

test("budget grows with distance", () => {
  assert.ok(travelBudgetMs(50) > travelBudgetMs(20));
  assert.ok(travelBudgetMs(20) > travelBudgetMs(12));
});

test("nonsense distances fall back to the floor, never NaN", () => {
  // A NaN here would become a NaN timeout and hang the action until the watchdog.
  assert.equal(travelBudgetMs(Number.NaN), MIN_TRAVEL_MS);
  assert.equal(travelBudgetMs(-5), MIN_TRAVEL_MS);
  assert.equal(travelBudgetMs(Infinity), MIN_TRAVEL_MS);
});

test("deep ore walks get several legs but stay inside the action watchdog", () => {
  // Runs 788 and 789: gold ore 50 to 70 blocks down, every walk "stopped N
  // blocks short" or timed out after one sixty second leg.
  assert.ok(DEEP_TRAVEL_MS > MAX_TRAVEL_MS, "the deep budget is more than one leg");
  assert.ok(MAX_TRAVEL_LEGS >= 2);
  assert.ok(
    DEEP_TRAVEL_MS + LOOKAT_RETRY_MS + 12_000 < 150_000,
    "legs, the look-at retry and the dig fit the watchdog",
  );
});

test("a leg earns another only when it closed the gap", () => {
  assert.equal(legWorthContinuing(90, 60), true);
  assert.equal(legWorthContinuing(90, 87), false, "three blocks is drift, not progress");
  assert.equal(legWorthContinuing(60, 60), false);
  assert.equal(legWorthContinuing(60, 70), false, "walking away is not progress");
  assert.equal(legWorthContinuing(Number.NaN, 10), false);
});
