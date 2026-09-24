import { test } from "node:test";
import assert from "node:assert/strict";
import { frameInteriorAt } from "./nether-portal.js";

// Run 824, RCON map of the village portal at z=-310 (O = obsidian):
// y74 ...OO..   x 290..296
// y73 ..O..O.
// y72 ..O..O.
// y71 ..O..O.
// y70 ...OO..
function village(extra: Record<string, string> = {}) {
  const obs = new Set<string>();
  for (const x of [293, 294]) {
    obs.add(`${x},70,-310`);
    obs.add(`${x},74,-310`);
  }
  for (const y of [71, 72, 73]) {
    obs.add(`292,${y},-310`);
    obs.add(`295,${y},-310`);
  }
  return (x: number, y: number, z: number) => {
    const k = `${x},${y},${z}`;
    if (k in extra) return extra[k];
    return obs.has(k) ? "obsidian" : "air";
  };
}

test("run 824: the village frame is complete and unlit along x", () => {
  assert.deepEqual(frameInteriorAt({ x: 293, y: 70, z: -310 }, "x", village()), { x: 293, y: 71, z: -310 });
});

test("the same block read along z is no frame", () => {
  assert.equal(frameInteriorAt({ x: 293, y: 70, z: -310 }, "z", village()), null);
});

test("a missing side block is no frame", () => {
  assert.equal(frameInteriorAt({ x: 293, y: 70, z: -310 }, "x", village({ "295,72,-310": "air" })), null);
});

test("a blocked interior is no frame", () => {
  assert.equal(frameInteriorAt({ x: 293, y: 70, z: -310 }, "x", village({ "294,72,-310": "cobblestone" })), null);
});
