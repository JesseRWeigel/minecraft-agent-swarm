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
  const start = BRAIN.indexOf("the Nether trip needs 4 gold");
  assert.notStrictEqual(start, -1, "the override must exist");
  const block = BRAIN.slice(start - 1400, start + 400);
  assert.match(block, /fortressStillOpen && ingotsAbout < 4/, "both conditions gate the hunt");
  assert.match(block, /lastGoldHuntMs > 900_000/, "a cooldown keeps it from eating the miner's hour");
  assert.match(block, /overworld/, "gold hunting belongs in the overworld, not past the portal");
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
