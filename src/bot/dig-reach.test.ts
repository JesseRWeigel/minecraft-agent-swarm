import { test } from "node:test";
import assert from "node:assert/strict";
import { withinDigReach, distanceToBlock, DIG_REACH_BLOCKS } from "./dig-reach.js";

test("dig reach: a block underfoot is reachable", () => {
  assert.strictEqual(withinDigReach({ x: 10.5, y: 64, z: 10.5 }, { x: 10, y: 63, z: 10 }), true);
});

test("dig reach: a block across the room is not", () => {
  // The run-763 case: the walk resolved as a phantom arrival and the bot dug
  // at a block thirty blocks away, which hangs until the timeout fires.
  assert.strictEqual(withinDigReach({ x: 10.5, y: 64, z: 10.5 }, { x: 40, y: 63, z: 10 }), false);
});

test("dig reach: the boundary is the survival reach", () => {
  const from = { x: 0.5, y: 0, z: 0.5 };
  const near = { x: 0, y: 0, z: 3 };
  const far = { x: 0, y: 0, z: 8 };
  assert.ok(distanceToBlock(from, near) < DIG_REACH_BLOCKS);
  assert.ok(distanceToBlock(from, far) > DIG_REACH_BLOCKS);
});

test("dig reach: eye height counts against a block overhead", () => {
  // Standing at y=64 and reaching for y=69 is 3.4 blocks from the eyes, not 5.
  const d = distanceToBlock({ x: 0.5, y: 64, z: 0.5 }, { x: 0, y: 69, z: 0 });
  assert.ok(d < 4, `expected the eye height to be counted, got ${d}`);
});
