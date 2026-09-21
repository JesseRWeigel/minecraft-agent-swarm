import { test } from "node:test";
import assert from "node:assert/strict";
import {
  keepsPiglinPassport,
  isGoldPiece,
  markPiglinPassport,
  hasPiglinPassport,
  clearPiglinPassport,
  PASSPORT_TTL_MS,
} from "./gold-passport.js";

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

test("gold passport: the mark protects the gold before the crossing", () => {
  // Run 758's order: the preflight dresses the bot in the overworld, and the
  // armour pass runs twenty seconds later, still in the overworld.
  clearPiglinPassport("Mason");
  assert.strictEqual(keepsPiglinPassport("minecraft:overworld", "golden_boots", false, "Mason"), false);
  markPiglinPassport("Mason");
  assert.strictEqual(keepsPiglinPassport("minecraft:overworld", "golden_boots", false, "Mason"), true);
});

test("gold passport: the mark expires so the bot is not stuck in bad boots", () => {
  const t0 = 1_000_000;
  markPiglinPassport("Blade", t0);
  assert.strictEqual(hasPiglinPassport("Blade", t0 + PASSPORT_TTL_MS - 1), true);
  assert.strictEqual(hasPiglinPassport("Blade", t0 + PASSPORT_TTL_MS + 1), false);
  assert.strictEqual(
    keepsPiglinPassport("minecraft:overworld", "golden_boots", false, "Blade", t0 + PASSPORT_TTL_MS + 1),
    false,
  );
});

test("gold passport: one bot's mark does not dress another", () => {
  clearPiglinPassport("Flora");
  markPiglinPassport("Mason");
  assert.strictEqual(hasPiglinPassport("Flora"), false);
});
