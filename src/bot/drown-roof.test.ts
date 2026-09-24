import { test } from "node:test";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { roofOverHitbox, openHeadroomNeighbour } from "./navigation.js";

// A tiny world: a map of "x,y,z" -> block name. Unlisted cells are water.
function world(solid: string[], air: string[] = []) {
  return (v: Vec3) => {
    const k = `${v.x},${v.y},${v.z}`;
    if (solid.includes(k)) return { name: "andesite", boundingBox: "block" };
    if (air.includes(k)) return { name: "air", boundingBox: "empty" };
    return { name: "water", boundingBox: "empty" };
  };
}

test("run 812: a lid over the centre column is a roof", () => {
  const w = world(["336,46,-333"]);
  assert.equal(roofOverHitbox(new Vec3(336.7, 44.2, -332.3), w)?.name, "andesite");
});

test("an overhang over only the neighbour column the head touches is still a roof", () => {
  // x=361.72 spans 361.42..362.02, so column 362 is under the head too.
  const w = world(["362,62,-351"]);
  assert.equal(roofOverHitbox(new Vec3(361.72, 60.2, -350.89), w)?.name, "andesite");
});

test("open water overhead is no roof", () => {
  assert.equal(roofOverHitbox(new Vec3(336.5, 44.2, -332.5), world([])), null);
});

test("the pinned swimmer slides toward a neighbour with open headroom", () => {
  // Rock over the bot's own column and over east/west; south is open.
  const w = world(["336,46,-333", "337,46,-333", "335,46,-333", "336,46,-334"]);
  const open = openHeadroomNeighbour(new Vec3(336.5, 44.2, -332.5), w);
  assert.deepEqual(open && [open.x, open.y, open.z], [336, 44, -332]);
});

test("no neighbour qualifies when every column is capped or walled", () => {
  const w = world(["337,46,-333", "335,46,-333", "336,46,-332", "336,46,-334"]);
  assert.equal(openHeadroomNeighbour(new Vec3(336.5, 44.2, -332.5), w), null);
});
