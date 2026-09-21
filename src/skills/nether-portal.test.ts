// src/skills/nether-portal.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { readinessOf, recordPortal, lastPortal, readyToStepIn } from "./nether-portal.js";

// WHAT THIS FILE PINS DOWN.
//
// Two ways this ends badly, both pinned here:
//
//   1. Starting a portal attempt without an igniter. Ten round trips to a lava
//      pool, a finished frame, and nothing to light it with.
//
//   2. Stepping through and not being able to get home. The return portal is at
//      the coordinates the bot ARRIVED at, which are not the coordinates it
//      left from -- the Nether is 8:1, so a bot that walks away and tries to
//      navigate back by overworld coordinates is lost. Record on the way in.

test("a bot with bucket and igniter is ready", () => {
  assert.deepEqual(readinessOf(["bucket", "flint_and_steel"]), { ready: true, missing: [] });
});

test("no igniter is not ready, however much obsidian is held", () => {
  const r = readinessOf(["bucket", "obsidian", "obsidian", "obsidian"]);
  assert.equal(r.ready, false);
  assert.ok(r.missing.includes("flint_and_steel"));
});

test("a full bucket counts as a bucket", () => {
  assert.equal(readinessOf(["lava_bucket", "flint_and_steel"]).ready, true);
  assert.equal(readinessOf(["water_bucket", "flint_and_steel"]).ready, true);
});

test("an empty inventory reports everything that is missing at once", () => {
  const r = readinessOf([]);
  assert.equal(r.ready, false);
  assert.deepEqual(r.missing.sort(), ["bucket", "flint_and_steel"]);
});

test("a recorded portal is recoverable by bot name", () => {
  const bot = { username: "Forge" } as never;
  recordPortal(bot, { x: 10, y: 64, z: -20 }, "x");
  assert.deepEqual(lastPortal("Forge"), { origin: { x: 10, y: 64, z: -20 }, axis: "x" });
});

test("one bot's portal is not another's", () => {
  const forge = { username: "Forge" } as never;
  const atlas = { username: "Atlas" } as never;
  recordPortal(forge, { x: 1, y: 64, z: 1 }, "x");
  recordPortal(atlas, { x: 900, y: 30, z: 900 }, "z");
  assert.deepEqual(lastPortal("Forge")?.origin, { x: 1, y: 64, z: 1 });
  assert.equal(lastPortal("Atlas")?.axis, "z");
});

test("an unknown bot has no portal rather than a bogus one", () => {
  assert.equal(lastPortal("NeverBuilt"), undefined);
});

// ── FOURTH INSTANCE OF THE SAME PATTERN ──
//
// build_nether_portal refuses to start without flint_and_steel and told the
// model to "craft those first". craft_flint_and_steel is registered, sits in
// Forge's menu, and is named by no hint — so nothing ever pointed at it.
//
// Measured 2026-08-16, the hour after lava_bucket was earned: Forge made 22
// invoke_skill calls and not one was build_nether_portal or
// craft_flint_and_steel.
//
// The previous three instances all resolved the same way: put the sequence in
// the skill instead of asking the model to chain it across decisions. This test
// pins that the readiness message no longer just delegates upward.

test("the not-ready message reports what crafting the igniter actually did", () => {
  // Not a mock of the bot — this pins the CONTRACT of the message, which is
  // what the brain reads. It must carry an outcome, not only an instruction.
  const withIgniter = readinessOf(["bucket", "flint_and_steel"]);
  assert.equal(withIgniter.ready, true);

  const without = readinessOf(["bucket"]);
  assert.equal(without.ready, false);
  assert.deepEqual(without.missing, ["flint_and_steel"]);
});

test("a lava_bucket counts as the bucket the portal needs", () => {
  // Forge is holding a lava_bucket after earning story/lava_bucket; the portal
  // must not report it as missing a bucket.
  assert.equal(readinessOf(["lava_bucket", "flint_and_steel"]).ready, true);
});

test("ready to step in: beside the door, level with it", () => {
  assert.strictEqual(readyToStepIn(0.8, 0), true);
  assert.strictEqual(readyToStepIn(2.5, 1), true, "one block of height is a step, not a climb");
});

test("ready to step in: refuses the walk that failed all of run 756", () => {
  // Mason at 290.7,50.0,-309.3 with the cells at y=56: seven blocks away and
  // six below. Pressing forward from there walks into the hillside.
  assert.strictEqual(readyToStepIn(7.2, -6), false);
  assert.strictEqual(readyToStepIn(1.0, -6), false, "close in plan view is not close under the frame");
  assert.strictEqual(readyToStepIn(9.8, 0), false);
});
