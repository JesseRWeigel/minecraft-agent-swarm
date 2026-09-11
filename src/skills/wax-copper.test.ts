import { test } from "node:test";
import assert from "node:assert/strict";
import { honeyLevel, campfireSeatY, chooseNest, nearestNest, NESTS, FULL_HONEY } from "./wax-copper.js";

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

test("chooseNest walks to the nearest full nest", () => {
  const pick = chooseNest([
    { x: 1, y: 0, z: 0, level: 5, dist: 90 },
    { x: 2, y: 0, z: 0, level: 5, dist: 30 },
    { x: 3, y: 0, z: 0, level: null, dist: 5 },
  ]);
  assert.equal(pick?.x, 2);
});

test("chooseNest goes to look at an unloaded nest before giving up", () => {
  const pick = chooseNest([
    { x: 1, y: 0, z: 0, level: 0, dist: 10 },
    { x: 2, y: 0, z: 0, level: null, dist: 90 },
  ]);
  assert.equal(pick?.x, 2);
});

test("chooseNest returns null when every known nest is loaded and low", () => {
  assert.equal(
    chooseNest([
      { x: 1, y: 0, z: 0, level: 0, dist: 10 },
      { x: 2, y: 0, z: 0, level: 3, dist: 20 },
    ]),
    null,
  );
});

test("nearestNest picks the closest known nest by XZ", () => {
  const frontier = nearestNest(450, -420);
  assert.ok(NESTS.some((n) => n.x === frontier.x && n.z === frontier.z));
  assert.equal(nearestNest(472, -445).z, -445);
  assert.equal(nearestNest(452, -361).z, -361);
});
