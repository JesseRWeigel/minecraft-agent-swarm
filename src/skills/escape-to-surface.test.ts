import { test } from "node:test";
import assert from "node:assert/strict";
import { digBudgetMs } from "./escape-to-surface.js";

test("dig budget covers bare-hand deepslate (15s) with margin", () => {
  // The old fixed 12s timeout aborted every deepslate dig at y<0 — the block
  // never broke, so the staircase read "all four sides blocked" forever.
  assert.equal(digBudgetMs(15_000), 19_000);
  assert.equal(digBudgetMs(22_500), 26_500); // deepslate iron ore
});

test("dig budget keeps a floor for fast blocks", () => {
  assert.equal(digBudgetMs(800), 5_000); // dirt
});

test("dig budget skips blocks that are hopeless by hand", () => {
  assert.equal(digBudgetMs(250_000), null); // obsidian
  assert.equal(digBudgetMs(Infinity), null); // bedrock
});

import { isBuried, BURIED_CEILING_SCAN } from "./escape-to-surface.js";

const column = (solidAt: Set<number>) => (_x: number, y: number, _z: number) =>
  solidAt.has(y) ? { boundingBox: "block" } : { boundingBox: "empty" };

test("a tall pocket with rock far overhead still counts as buried", () => {
  // Flora at y=-45: air at +2..+4, deepslate higher up. The old check looked
  // only at +2 and read this as open sky, so the escape reflex never fired.
  assert.equal(isBuried(column(new Set([-45 + 9])), 331, -45, -349), true);
});

test("the pillar fallback clearing +2..+4 does not un-bury the bot", () => {
  assert.equal(isBuried(column(new Set([-41 + 5, -41 + 6])), 331, -41, -349), true);
});

test("open sky above a deep bot is not buried", () => {
  assert.equal(isBuried(column(new Set()), 0, 20, 0), false);
});

test("a bot in the surface band is never buried", () => {
  assert.equal(isBuried(column(new Set([70])), 0, 60, 0), false);
});

test("rock beyond the scan range does not count", () => {
  assert.equal(isBuried(column(new Set([10 + BURIED_CEILING_SCAN + 1])), 0, 10, 0), false);
});
