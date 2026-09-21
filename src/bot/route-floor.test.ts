import { test } from "node:test";
import assert from "node:assert/strict";
import { belowRouteCost, routeFloor, ROUTE_FLOOR_SLACK, MAX_BELOW_ROUTE_COST } from "./route-floor.js";

test("route floor: sits a fixed slack under the target", () => {
  assert.strictEqual(routeFloor(51), 51 - ROUTE_FLOOR_SLACK);
});

test("route floor: walking at or above the floor is free", () => {
  const floor = routeFloor(51);
  assert.strictEqual(belowRouteCost(floor, 51), 0);
  assert.strictEqual(belowRouteCost(floor, floor), 0);
  assert.strictEqual(belowRouteCost(floor, floor + 20), 0);
});

test("route floor: deeper costs more, so climbing back is the cheap direction", () => {
  const floor = routeFloor(51);
  const shallow = belowRouteCost(floor, floor - 1);
  const deep = belowRouteCost(floor, floor - 5);
  assert.ok(shallow > 0, "one block under the floor should already cost something");
  assert.ok(deep > shallow, "five blocks under must cost more than one, or there is no gradient out");
});

test("route floor: the price is capped, so a dip stays possible", () => {
  // Mason's run-749 grave: bricks at y=51, dead at y=31 in the lava basin.
  const cost = belowRouteCost(routeFloor(51), 31);
  assert.strictEqual(cost, MAX_BELOW_ROUTE_COST);
  assert.ok(Number.isFinite(cost), "a wall would strand a bot that is already below the floor");
});
