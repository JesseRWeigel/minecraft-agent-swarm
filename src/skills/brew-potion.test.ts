import { test } from "node:test";
import assert from "node:assert/strict";
import { brewShortfall, openToSky, type BrewStock } from "./brew-potion.js";

const base: BrewStock = {
  rods: 2,
  powder: 0,
  standPlaced: false,
  standHeld: false,
  sugar: 0,
  sugarCane: 1,
  emptyBottles: 3,
  filledBottles: 0,
};

test("two rods, cane and bottles are enough to start", () => {
  assert.deepEqual(brewShortfall(base), []);
});

test("run 818: one banked rod covers the stand and leaves the fuel short", () => {
  assert.deepEqual(brewShortfall({ ...base, rods: 1 }), ["blaze_rod x1"]);
});

test("a placed stand needs only the fuel rod", () => {
  assert.deepEqual(brewShortfall({ ...base, rods: 1, standPlaced: true }), []);
});

test("powder in hand means the one rod goes to the stand", () => {
  assert.deepEqual(brewShortfall({ ...base, rods: 1, powder: 1 }), []);
});

test("no sugar and no bottles are both named", () => {
  assert.deepEqual(brewShortfall({ ...base, sugarCane: 0, emptyBottles: 0 }), ["sugar", "glass_bottle"]);
});

test("run 847: water under stone cannot fill a bottle; open water can", () => {
  assert.equal(openToSky("stone"), false);
  assert.equal(openToSky("water"), false);
  assert.equal(openToSky(undefined), false);
  assert.equal(openToSky("air"), true);
  assert.equal(openToSky("cave_air"), true);
});
