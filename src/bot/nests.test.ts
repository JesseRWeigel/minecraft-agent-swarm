import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeNests, STATIC_NESTS, nearestNest } from "./nests.js";

test("mergeNests dedupes by exact coordinate and keeps order", () => {
  const m = mergeNests(
    [{ x: 1, y: 2, z: 3 }],
    [
      { x: 1, y: 2, z: 3 },
      { x: 4, y: 5, z: 6 },
    ],
  );
  assert.deepEqual(m, [
    { x: 1, y: 2, z: 3 },
    { x: 4, y: 5, z: 6 },
  ]);
});

test("the static list carries all three nests found so far", () => {
  assert.ok(STATIC_NESTS.some((n) => n.x === 474 && n.z === -323));
  assert.ok(STATIC_NESTS.some((n) => n.x === 452 && n.z === -361));
  assert.ok(STATIC_NESTS.some((n) => n.x === 472 && n.z === -445));
});

test("nearestNest picks by XZ distance", () => {
  assert.equal(nearestNest(472, -445).z, -445);
  assert.equal(nearestNest(474, -323).z, -323);
});
