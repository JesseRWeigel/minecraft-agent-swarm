import { test } from "node:test";
import assert from "node:assert/strict";
import { honeyLevel, campfireSeatY, FULL_HONEY } from "./wax-copper.js";

test("honey level reads numeric or string block state", () => {
  assert.equal(honeyLevel({ honey_level: 0 }), 0);
  assert.equal(honeyLevel({ honey_level: "5" }), FULL_HONEY);
  assert.equal(honeyLevel({}), null);
  assert.equal(honeyLevel(undefined), null);
});

const world = (solid: Record<number, string>) => (_x: number, y: number, _z: number) =>
  solid[y] ? { name: solid[y], boundingBox: "block" } : { name: "air", boundingBox: "empty" };

test("campfire seats on the first solid block under the hive with clear air between", () => {
  // the live hive: nest at 71, air 70..68, grass at 67
  assert.equal(campfireSeatY(world({ 67: "grass_block", 66: "dirt" }), 472, 71, -445), 67);
});

test("no seat when the hive hangs over open air beyond 5 blocks", () => {
  assert.equal(campfireSeatY(world({ 60: "grass_block" }), 0, 71, 0), null);
});

test("leaves right under the hive become the seat, keeping air between fire and nest", () => {
  assert.equal(campfireSeatY(world({ 69: "oak_leaves", 67: "grass_block" }), 0, 71, 0), 69);
});
