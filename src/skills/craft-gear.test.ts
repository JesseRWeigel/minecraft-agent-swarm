import { test } from "node:test";
import assert from "node:assert/strict";

import { affordableArmourPiece, ARMOUR_COST } from "./craft-gear.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// craft_gear attempted only the chestplate, which costs 8 ingots. The swarm
// mines about 4 iron an hour and bots were dying 13 times an hour, dropping
// everything. Measured in one session: 15 of 21 deaths with NO armour, 14 of
// them to zombies, and "No iron_ingot in the stash" 56 times.
test("a bot with 4 ingots gets boots instead of nothing", () => {
  // The old behaviour attempted an 8-ingot chestplate and this bot wore nothing.
  assert.equal(affordableArmourPiece(4), "iron_boots");
});

test("still prefers the chestplate once it is actually affordable", () => {
  assert.equal(affordableArmourPiece(8), "iron_chestplate");
  assert.equal(affordableArmourPiece(24), "iron_chestplate");
});

test("picks the most protective piece that fits the iron on hand", () => {
  assert.equal(affordableArmourPiece(7), "iron_leggings", "5 points beats helmet's 2");
  assert.equal(affordableArmourPiece(5), "iron_boots", "helmet and boots both give 2, boots cost less");
  assert.equal(affordableArmourPiece(6), "iron_boots");
});

test("never re-crafts a piece the bot already has", () => {
  // Order is chestplate, leggings, boots, helmet. Boots come before the helmet
  // because both give 2 points and boots cost 4 ingots against the helmet's 5.
  assert.equal(affordableArmourPiece(24, ["iron_chestplate"]), "iron_leggings");
  assert.equal(affordableArmourPiece(24, ["iron_chestplate", "iron_leggings"]), "iron_boots");
  assert.equal(affordableArmourPiece(24, ["iron_chestplate", "iron_leggings", "iron_boots"]), "iron_helmet");
});

test("a full set asks for nothing more", () => {
  const full = Object.keys(ARMOUR_COST);
  assert.equal(affordableArmourPiece(64, full), null);
});

test("too little iron returns null so the bot spends it on tools", () => {
  // Below the cheapest piece, waiting is strictly worse than making a pickaxe.
  assert.equal(affordableArmourPiece(3), null);
  assert.equal(affordableArmourPiece(0), null);
});

test("craft gear: raw iron is smelted before the armour step gives up", () => {
  // Run 764: Forge died twelve times in two hours wearing nothing, while the
  // stash held two ingots and nine raw iron and this step reported "nothing
  // affordable (cheapest piece costs 4)". Guard the chain by shape: the raw
  // iron withdrawal and the smelt have to sit above the armour budget.
  const source = fs.readFileSync(path.join(__dirname, "craft-gear.ts"), "utf8");
  const raw = source.indexOf('withdrawStash(bot, stashPos, "raw_iron"');
  const smelt = source.indexOf("smeltOresSkill.execute");
  const budget = source.indexOf("const armourBudget =");
  assert.notStrictEqual(raw, -1, "raw iron must be withdrawn from the stash");
  assert.notStrictEqual(smelt, -1, "the smelter must be invoked");
  assert.ok(raw < smelt, "withdraw the raw iron before smelting it");
  assert.ok(smelt < budget, "smelt before the armour budget is computed, or the ingots arrive too late");
  assert.match(
    source.slice(smelt, smelt + 120),
    /\{ stashPos \}/,
    "smelt_ores skips its stash phase unless it is given the stash position",
  );
});

test("craft gear: the raw-iron withdrawal reports itself either way", () => {
  // Run 771: the smelt step logged nothing for an hour while the armour step
  // repeated "0 ingots (budget 0)" and the ledger held six raw iron. A branch
  // that only speaks on success cannot tell an empty stash from a failed walk.
  const source = fs.readFileSync(path.join(__dirname, "craft-gear.ts"), "utf8");
  const ask = source.indexOf("asked the stash for raw iron");
  const smelt = source.indexOf("smelting before the forge");
  assert.notStrictEqual(ask, -1, "the withdrawal result must be logged");
  assert.ok(ask < smelt, "log the withdrawal before the success-only smelt line");
  const block = source.slice(ask - 600, ask);
  assert.match(block, /withdraw threw/, "a thrown withdrawal must be reported, not swallowed");
});
