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
