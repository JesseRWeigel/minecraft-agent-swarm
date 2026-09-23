import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("build_farm: the bake takes a crafting table from the stash before giving up", () => {
  // Run 797: every table within 48 blocks of the farm read unreachable, the
  // pack held no planks, and the bake was skipped with six wheat in hand
  // while the stash held 1,010 crafting tables.
  const src = fs.readFileSync(path.join(__dirname, "build-farm.ts"), "utf8");
  const fn = src.slice(src.indexOf("async function reachTable"), src.indexOf("async function bakeBread"));
  assert.match(fn, /stashPos\?: \{ x: number; y: number; z: number \}/, "reachTable takes the stash");
  const ask = fn.indexOf('"crafting_table", 1');
  const planks = fn.indexOf("planks < 4");
  assert.ok(ask > 0 && ask < planks, "the stash is asked before the planks check refuses");
  assert.match(src, /reachTable\(bot, stashPos\)/, "the bake passes the stash through");
});
