import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("smelt ores: banks a full pack before working the furnace", () => {
  // Run 765: "[Skill] Smelt error: Error: destination full", twice, and the
  // gear step read "1 ingots and 3 raw iron - smelting" then "1 ingots after
  // smelting". The reclaim cannot work with a full pack, because takeOutput
  // has nowhere to put the ingots, so the furnace stays jammed and putInput
  // fails for the same reason. Guard the ordering by shape.
  const source = fs.readFileSync(path.join(__dirname, "smelt-ores.ts"), "utf8");
  const room = source.indexOf("emptySlotCount() < 2");
  const reclaim = source.indexOf("furnace.takeOutput()");
  const put = source.indexOf("furnace.putInput(");
  assert.notStrictEqual(room, -1, "the room check must exist");
  assert.ok(room < reclaim, "make room before reclaiming the furnace");
  assert.ok(reclaim < put, "reclaim before putting the batch in");
});

test("smelt ores: the reclaim failure says why", () => {
  // A silent catch here is indistinguishable from an empty furnace.
  const source = fs.readFileSync(path.join(__dirname, "smelt-ores.ts"), "utf8");
  assert.match(source, /furnace reclaim failed \(\$\{\(e as Error\)\.message\}\)/, "log the real error");
});
