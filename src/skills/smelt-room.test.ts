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

test("smelt ores: never asks a furnace slot for more than it can hold", () => {
  // Run 766: four "Error: destination full", thrown straight after "Smelting
  // 2x raw_iron", with the reclaim finding nothing and the pack not full. The
  // slots already held the same item, which the reclaim leaves alone by
  // design, so the put asked a full stack to take more.
  const source = fs.readFileSync(path.join(__dirname, "smelt-ores.ts"), "utf8");
  const room = source.indexOf("const roomIn =");
  const fuel = source.indexOf("furnace.putFuel(");
  const input = source.indexOf("furnace.putInput(");
  assert.notStrictEqual(room, -1, "the remaining-room helper must exist");
  assert.ok(room < fuel && room < input, "compute the room before either put");
  const fuelCall = source.slice(fuel - 220, fuel + 80);
  const inputCall = source.slice(input - 260, input + 80);
  assert.match(fuelCall, /roomIn\(furnace\.fuelItem\(\)/, "the fuel put must be capped by the fuel slot's room");
  assert.match(inputCall, /roomIn\(furnace\.inputItem\(\)/, "the input put must be capped by the input slot's room");
  assert.match(source, /stackSize \?\? 64/, "a slot holds one stack, whatever that item's stack size is");
});

test("smelt ores: the error names the step it failed at", () => {
  // Three runs of "Error: destination full" and three wrong guesses, because
  // the catch wraps nine furnace operations and named none of them. The error
  // line must carry the step, the furnace slots and the free-slot count.
  const source = fs.readFileSync(path.join(__dirname, "smelt-ores.ts"), "utf8");
  assert.match(source, /smelt error at step "\$\{step\}"/, "the failing step must be named");
  assert.match(source, /furnace \$\{slotState\(\)\}/, "the slot contents must be reported");
  assert.match(source, /pack \$\{bot\.inventory\.emptySlotCount\(\)\} free/, "the pack state must be reported");
  for (const marker of ["open", "reclaim-output", "putFuel", "putInput", "wait"]) {
    assert.match(source, new RegExp(`step = "${marker}"`), `the ${marker} step must be marked`);
  }
});
