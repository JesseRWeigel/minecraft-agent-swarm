import { test } from "node:test";
import assert from "node:assert/strict";
import { worthBanking, isBulk, BULK_CAP } from "./stash-glut.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("stash glut: ores, ingots and tools are always banked", () => {
  for (const name of ["iron_ingot", "raw_gold", "diamond", "crossbow", "bread"]) {
    assert.strictEqual(isBulk(name), false, `${name} is not bulk`);
    assert.strictEqual(worthBanking(name, 99_999), true, `${name} is always worth banking`);
  }
});

test("stash glut: rubble is banked up to a cap and refused after", () => {
  // The real numbers from 2026-09-22: 16,420 cobblestone and 9,594 cobbled
  // deepslate in 178 chests, with the stash full and every deposit bouncing.
  assert.strictEqual(worthBanking("cobblestone", 100), true, "a modest pile is useful");
  assert.strictEqual(worthBanking("cobblestone", BULK_CAP), false, "at the cap it stops");
  assert.strictEqual(worthBanking("cobbled_deepslate", 9_594), false);
  assert.strictEqual(worthBanking("coal", 4_192), false);
});

test("stash glut: the cap is per item, not shared", () => {
  assert.strictEqual(worthBanking("gravel", 10), true, "gravel is judged on gravel");
  assert.strictEqual(worthBanking("dirt", 20_000), false);
});

test("stash glut: the deposit path consults the cap before banking", () => {
  const source = fs.readFileSync(path.join(__dirname, "stash.ts"), "utf8");
  const check = source.indexOf("isBulk(item.name) && !worthBanking(item.name");
  const keep = source.indexOf("shouldKeep(item.name");
  const group = source.indexOf("const cat = categorizeItem(item.name)");
  assert.notStrictEqual(check, -1, "the deposit loop must consult the cap");
  assert.ok(keep < check && check < group, "after the keep list, before the item is grouped for a chest");
  assert.match(source, /kept .* out of the chests/, "and say what it left out");
});
