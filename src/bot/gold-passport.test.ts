import { test } from "node:test";
import assert from "node:assert/strict";
import { keepsPiglinPassport, isGoldPiece } from "./gold-passport.js";

const NETHER = "minecraft:the_nether";

test("gold passport: the only gold piece stays on in the Nether", () => {
  assert.strictEqual(keepsPiglinPassport(NETHER, "golden_boots", false), true);
  assert.strictEqual(keepsPiglinPassport(NETHER, "golden_helmet", false), true);
});

test("gold passport: a second gold piece is free to upgrade", () => {
  // Piglins check for one piece anywhere on the body, so the spare can go.
  assert.strictEqual(keepsPiglinPassport(NETHER, "golden_boots", true), false);
});

test("gold passport: in the overworld gold is just poor armour", () => {
  assert.strictEqual(keepsPiglinPassport("minecraft:overworld", "golden_boots", false), false);
  assert.strictEqual(keepsPiglinPassport("", "golden_boots", false), false);
});

test("gold passport: non-gold pieces are never protected", () => {
  assert.strictEqual(keepsPiglinPassport(NETHER, "iron_boots", false), false);
  assert.strictEqual(keepsPiglinPassport(NETHER, undefined, false), false);
});

test("gold passport: a golden apple is not armour", () => {
  assert.strictEqual(isGoldPiece("golden_apple"), false);
  assert.strictEqual(isGoldPiece("golden_chestplate"), true);
});
