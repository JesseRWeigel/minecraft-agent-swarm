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

test("gold hunt: asks for planks, which is the wood the stash actually holds", () => {
  // Run 781: the stash held 56 oak planks, no sticks and no logs, and the
  // withdrawal asked only for sticks and logs, so it came back empty while
  // the makings sat on the shelf. Two planks are four sticks.
  const start = BRAIN.indexOf("Pickaxe makings from the stash");
  const list = BRAIN.slice(start - 900, start);
  for (const want of ["iron_ingot", "stick", "planks", "_log"]) {
    assert.match(list, new RegExp(`"${want}"`), `${want} must be on the withdrawal list`);
  }
});

test("gold hunt: smelts raw iron when the pickaxe is short an ingot", () => {
  // A pickaxe costs three ingots. The stash sat on two with six raw iron
  // beside them for hours, and the craft can only ever report the shortfall.
  const start = BRAIN.indexOf("ingots for a pickaxe that costs 3");
  assert.notStrictEqual(start, -1, "the shortfall must be handled, not just reported");
  const block = BRAIN.slice(start - 700, start + 700);
  assert.match(block, /ingotsHeldNow < 3/, "three is the bar");
  assert.match(block, /countBanked\("raw_iron"/, "and only when there is ore to smelt");
  assert.match(block, /skill: "smelt_ores"/, "hand it to the smelter, which fetches its own ore");
});

test("gold hunt: mines iron ore when there is none held or banked", () => {
  // Run 787: the one chest the ledger credited with iron sat at y=4 and held
  // cobblestone, so three bots asked the stash for makings, got nothing, and
  // failed "Can't craft iron_pickaxe" every fifteen minutes. No bot had mined
  // iron ore in six of the last eight runs. A stone pick digs iron.
  const start = BRAIN.indexOf("Pickaxe makings from the stash");
  const craft = BRAIN.indexOf('item: "iron_pickaxe"', start);
  const block = BRAIN.slice(start, craft);
  const mine = block.indexOf('blockType: "iron_ore"');
  assert.notStrictEqual(mine, -1, "the pickaxe step mines iron ore before crafting");
  assert.match(block.slice(0, mine), /rawBanked > 0 \|\| rawHeldNow > 0/, "smelt when raw iron is held or banked");
  assert.ok(block.indexOf("smelt_ores") < mine, "smelting comes before mining");
  assert.match(block, /protectPos: this\.roleConfig\.stashPos/, "the iron trip keeps the stash zone protected");
});

test("gold hunt: gets sticks before crafting the pickaxe", () => {
  // The craft action turns logs into planks and never planks into sticks, so
  // a bot holding three ingots and a stack of planks still fails the craft.
  const start = BRAIN.indexOf("Pickaxe makings from the stash");
  const craft = BRAIN.indexOf('item: "iron_pickaxe"', start);
  const block = BRAIN.slice(start, craft);
  const stick = block.indexOf('item: "stick"');
  assert.notStrictEqual(stick, -1, "craft sticks when short of two");
  assert.ok(block.indexOf('"gather_wood", { count: 2 }') < stick, "gather wood first when holding none");
  assert.match(block, /allowedActions\.includes\("gather_wood"\)/, "only roles that may gather wood go for it");
});

test("gold hunt: a supply step that delivered earns a quicker next pass", () => {
  const start = BRAIN.indexOf("const quickerNextPass");
  assert.notStrictEqual(start, -1);
  assert.match(
    BRAIN.slice(start, start + 200),
    /lastGoldHuntMs = Date\.now\(\) - 600_000/,
    "five minutes, not fifteen",
  );
});

test("gold hunt: a walk that ended short earns a quicker next pass", () => {
  // Run 789: "stopped 49 blocks short" of ore at 295,8,-292, then fifteen
  // minutes of wandering before the next try started over from the surface.
  const mine = BRAIN.indexOf('blockType: "gold_ore"');
  const block = BRAIN.slice(mine, mine + 900);
  assert.match(block, /stopped \\d\+ blocks short/, "the short-walk result is recognised");
  assert.match(block, /lastGoldHuntMs = Date\.now\(\) - 600_000/, "five minutes until the next pass");
});
