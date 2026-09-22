import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(__dirname, "stash.ts"), "utf8");

test("stash expansion: takes a banked chest before crafting one", () => {
  // Run 770 logged "Expansion blocked: carrying 0 planks and no logs" twice
  // while the stash ledger held 115 chests and no wood at all. The bot stood
  // at a wall of chests, needed a chest, and only knew how to make one.
  const start = SOURCE.indexOf("let expandBail");
  const craft = SOURCE.indexOf("const countPlanks =", start);
  const withdraw = SOURCE.indexOf('withdrawStash(bot, stashPos, "chest"', start);
  assert.notStrictEqual(withdraw, -1, "the expansion must try the stash for a chest");
  assert.ok(withdraw < craft, "ask for a spare chest before crafting one from wood");
});

test("stash expansion: the wood path survives as the fallback", () => {
  // Withdrawing must not replace crafting: a stash with no spare chests still
  // has to be able to build one.
  assert.match(SOURCE, /Converted logs to planks for expansion/, "the log conversion must remain");
  assert.match(SOURCE, /Crafted a chest for expansion/, "the craft path must remain");
});

test("withdrawal: walks to a ledger chest whose chunk is not loaded", () => {
  // Run 772: every armour attempt read "No raw_iron in the stash. Gather it
  // yourself instead." while the ledger held six raw iron and the stash had
  // grown to 173 chests, far past the twenty-block scan. blockAt returns null
  // for an unloaded position and the ledger loop skips those silently, so the
  // bot stood among chests declaring the shelves bare.
  const start = SOURCE.indexOf("chestsWithItem(matchName)");
  assert.notStrictEqual(start, -1, "the ledger-first lookup must exist");
  const walk = SOURCE.indexOf("that chunk is not loaded", start);
  const scan = SOURCE.indexOf("maxDistance: 20", start);
  assert.notStrictEqual(walk, -1, "an unloaded ledger chest must be walked to");
  assert.ok(walk < scan, "try the ledger's chest before falling back to the local scan");
  const block = SOURCE.slice(walk - 400, walk + 700);
  assert.match(block, /safeGoto\(/, "walking is what makes the chunk load");
  assert.match(block, /slice\(0, 2\)/, "bounded: two walks at most, this runs inside a budget");
});
