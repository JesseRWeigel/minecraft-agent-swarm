import { test } from "node:test";
import assert from "node:assert/strict";
import { isStandingTree } from "./wood-run.js";

function world(cells: Record<string, string>) {
  return (x: number, y: number, z: number) => cells[`${x},${y},${z}`] ?? "air";
}

test("an oak on grass with leaves at the top is a standing tree", () => {
  const w = world({
    "0,63,0": "grass_block",
    "0,64,0": "oak_log",
    "0,65,0": "oak_log",
    "0,66,0": "oak_log",
    "1,67,0": "oak_leaves",
  });
  assert.equal(isStandingTree(0, 65, 0, w), true);
});

test("run 835: a village beam floating over air is no tree", () => {
  const w = world({ "293,73,-312": "oak_log", "293,74,-311": "oak_leaves" });
  assert.equal(isStandingTree(293, 73, -312, w), false);
});

test("cave timber on stone with no leaves is no tree", () => {
  const w = world({ "294,45,-323": "stone", "294,46,-323": "oak_log" });
  assert.equal(isStandingTree(294, 46, -323, w), false);
});

test("a trunk on dirt with no leaves near the top is no tree", () => {
  const w = world({ "0,63,0": "dirt", "0,64,0": "spruce_log", "0,65,0": "spruce_log" });
  assert.equal(isStandingTree(0, 64, 0, w), false);
});
