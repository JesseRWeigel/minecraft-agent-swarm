import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRAIN = fs.readFileSync(path.join(__dirname, "brain.ts"), "utf8");

test("gold hunt: fires only while the fortress is unearned and gold is short", () => {
  // Run 774: nine fortress trips, eight ending "No gold to wear", with the
  // preflight reporting three ingots reachable and one nugget. Four buys the
  // boots. The swarm's gold comes from nether gold ore, which sits past the
  // portal the missing gold is stopping him crossing, so the loop closes on
  // itself and overworld ore is the way out of it.
  // Anchor on the override's own comment and read to the mining call, so
  // inserting steps inside it cannot slide the window off the conditions.
  const start = BRAIN.indexOf("THE FORTRESS IS ONE GOLD INGOT SHORT");
  assert.notStrictEqual(start, -1, "the override must exist");
  const block = BRAIN.slice(start, BRAIN.indexOf('blockType: "gold_ore"', start));
  assert.match(block, /fortressStillOpen && ingotsAbout < 4/, "both conditions gate the hunt");
  assert.match(block, /lastGoldHuntMs > 900_000/, "a cooldown keeps it from eating the miner's hour");
  assert.match(block, /overworld/, "gold hunting belongs in the overworld, not past the portal");
});

test("gold hunt: calls the action by the name the roles actually allow", () => {
  // Run 775: the override never fired once. It gated on allowedActions
  // containing "mine", and every role lists the action as "mine_block", so
  // the condition was false for all five bots. The action also takes
  // blockType rather than block.
  const roles = fs.readFileSync(path.join(__dirname, "role.ts"), "utf8");
  assert.match(roles, /"mine_block"/, "the roles name the action mine_block");
  const start = BRAIN.indexOf("THE FORTRESS IS ONE GOLD INGOT SHORT");
  const block = BRAIN.slice(start, BRAIN.indexOf('blockType: "gold_ore"', start) + 60);
  assert.match(block, /allowedActions\.includes\("mine_block"\)/, "gate on the name the roles use");
  assert.match(block, /blockType: "gold_ore"/, "mine_block reads blockType");
});

test("gold hunt: counts every form of gold the team can reach", () => {
  const start = BRAIN.indexOf("const ingotsAbout =");
  assert.notStrictEqual(start, -1);
  const block = BRAIN.slice(start, start + 400);
  for (const form of ["gold_ingot", "gold_nugget", "raw_gold", "gold_block"]) {
    assert.match(block, new RegExp(form), `${form} must count toward the four`);
  }
  assert.match(block, /gold_nugget", stashY\) \/ 9/, "nine nuggets make an ingot");
  assert.match(block, /gold_block", stashY\) \* 9/, "a block is nine ingots");
});

test("gold hunt: gets an iron pickaxe before trying to mine gold", () => {
  // Run 776, first firing: "Can't harvest gold_ore with stone_pickaxe — it
  // needs a iron_pickaxe". A fair refusal, and a dead end on its own, since
  // craft_gear spends iron on armour first and only reserves three ingots for
  // a pick when the bot carries none at all, and a stone pick counts as one.
  const start = BRAIN.indexOf("gold needs an iron pickaxe");
  assert.notStrictEqual(start, -1, "the pickaxe step must exist");
  const mine = BRAIN.indexOf('blockType: "gold_ore"');
  assert.ok(start < mine, "ask for the pick before swinging at gold ore");
  const block = BRAIN.slice(start - 700, start + 500);
  assert.match(block, /iron_pickaxe|diamond_pickaxe|netherite_pickaxe/, "any pick that can harvest gold counts");
  assert.match(block, /item: "iron_pickaxe"/, "craft the pick by name");
});

test("gold hunt: fetches the pickaxe makings from the stash first", () => {
  // Run 777: Atlas, Forge and Mason all reached the pickaxe step, nine times
  // between them, and every attempt answered "Can't craft iron_pickaxe -
  // need: iron_ingot, stick" while the stash held three ingots and six raw
  // iron. The craft action builds from the pack and never walks to a chest.
  const start = BRAIN.indexOf("Pickaxe makings from the stash");
  assert.notStrictEqual(start, -1, "the withdrawal must exist and report itself");
  const craft = BRAIN.indexOf('item: "iron_pickaxe"', start);
  assert.notStrictEqual(craft, -1, "the craft still follows");
  const block = BRAIN.slice(start - 900, craft);
  for (const need of ["iron_ingot", "stick", "_log"]) {
    assert.match(block, new RegExp(`"${need}"`), `${need} must be fetched before crafting`);
  }
});
