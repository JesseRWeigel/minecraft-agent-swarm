import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(__dirname, "piglin-gold.ts"), "utf8");

test("piglin gold: nuggets count as gold and become ingots", () => {
  // Nether gold ore drops nuggets, and that is the form this swarm mines on
  // every crossing. Run 773 stood down nine fortress trips with "No gold to
  // wear" while the preflight knew only about ingots, blocks and raw gold.
  const nugget = SOURCE.indexOf('withdrawStash(bot, STASH_POS, "gold_nugget"');
  const forge = SOURCE.indexOf("Forging golden boots from stash gold");
  assert.notStrictEqual(nugget, -1, "nuggets must be withdrawn from the stash");
  assert.ok(nugget < forge, "convert nuggets before deciding the boots cannot be forged");
  assert.match(SOURCE, /\(4 - ingots\(\)\) \* 9/, "nine nuggets make one ingot");
});

test("piglin gold: the other gold forms are still handled", () => {
  assert.match(SOURCE, /"gold_block"/, "a bastion gold block is still broken down");
  assert.match(SOURCE, /"raw_gold"/, "raw gold is still smelted");
  assert.match(SOURCE, /"gold_ingot"/, "banked ingots are still withdrawn");
});
