import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRAIN = fs.readFileSync(path.join(__dirname, "brain.ts"), "utf8");

test("farm override: a farmer far from the farm walks home instead of being skipped", () => {
  // Run 796: Flora spent the hour 300 blocks from the farm site at 4/20
  // hunger while the stash held no bread and 1,664 wheat seeds, and the
  // override only logged "skipped: N blocks from the farm site".
  const start = BRAIN.indexOf("if (cooledDown && farmGap > 120) {");
  assert.notStrictEqual(start, -1, "the far-from-farm branch exists");
  const block = BRAIN.slice(start, start + 1200);
  assert.doesNotMatch(block, /Farm override skipped/, "the branch no longer just logs");
  assert.match(block, /walking back to the farm/, "it walks home");
  assert.match(block, /"go_to", \{ x: FARM_SITE\.x, y: FARM_SITE\.y, z: FARM_SITE\.z \}/, "to the farm site");
  assert.match(block, /Date\.now\(\) - cooldownMs \+ 90_000/, "the next pass comes in ninety seconds");
});

test("hunt-food override: yields to the farm walk when the farmer is far from the farm", () => {
  const start = BRAIN.indexOf("const farmerFarFromFarm =");
  assert.notStrictEqual(start, -1);
  const block = BRAIN.slice(start, start + 600);
  assert.match(block, /allowedSkills\.includes\("build_farm"\)/, "only the farmer");
  assert.match(block, /!farmerFarFromFarm/, "the hunt waits while she walks home");
});

test("roles: Atlas no longer lists find_fortress", () => {
  const roles = fs.readFileSync(path.join(__dirname, "role.ts"), "utf8");
  const atlas = roles.slice(roles.indexOf('name: "Atlas"'), roles.indexOf('name: "Flora"'));
  assert.doesNotMatch(atlas, /"find_fortress"/, "Atlas drew a crossbow and arrows for trips he could not make");
});
