import { createRequire } from "module";

/**
 * Collision epsilon for prismarine-physics.
 *
 * Run 653 (2026-09-16): Blade spent ten minutes at the bottom of a one-block
 * shaft while the server put him back 3,800 times; Mason lost two hours the
 * same way the day before, and Forge a few minutes. A clean probe client at
 * Blade's exact server position reproduced it: pressing into the copper wall
 * drew twenty rejections a second. The server parks a player's box exactly
 * on a block face (x = 512.3 for a 0.6-wide box), and 512.3 - 0.3 comes out
 * as 511.99999999999994 in floating point, a hair inside the block. The
 * library's clamp test "player.minX >= block.maxX" then fails, the box walks
 * into the block, and the server rejects every packet with a teleport back
 * to the face. The vanilla client tolerates this with a 1e-7 epsilon in its
 * collision test, so give the library the same tolerance. Applied once at
 * startup, before any bot is created.
 */
const EPS = 1e-7;

type Box = { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
type Proto = {
  computeOffsetX: (this: Box, other: Box, offset: number) => number;
  computeOffsetY: (this: Box, other: Box, offset: number) => number;
  computeOffsetZ: (this: Box, other: Box, offset: number) => number;
  __epsilonPatched?: boolean;
};

export function installPhysicsEpsilon(): boolean {
  const require = createRequire(import.meta.url);
  const AABB = require("prismarine-physics/lib/aabb") as { prototype: Proto };
  const proto = AABB.prototype;
  if (proto.__epsilonPatched) return false;
  proto.__epsilonPatched = true;
  proto.computeOffsetX = function (this: Box, other: Box, offsetX: number) {
    if (other.maxY > this.minY && other.minY < this.maxY && other.maxZ > this.minZ && other.minZ < this.maxZ) {
      if (offsetX > 0 && other.maxX <= this.minX + EPS)
        offsetX = Math.min(Math.max(this.minX - other.maxX, 0), offsetX);
      else if (offsetX < 0 && other.minX >= this.maxX - EPS)
        offsetX = Math.max(Math.min(this.maxX - other.minX, 0), offsetX);
    }
    return offsetX;
  };
  proto.computeOffsetY = function (this: Box, other: Box, offsetY: number) {
    if (other.maxX > this.minX && other.minX < this.maxX && other.maxZ > this.minZ && other.minZ < this.maxZ) {
      if (offsetY > 0 && other.maxY <= this.minY + EPS)
        offsetY = Math.min(Math.max(this.minY - other.maxY, 0), offsetY);
      else if (offsetY < 0 && other.minY >= this.maxY - EPS)
        offsetY = Math.max(Math.min(this.maxY - other.minY, 0), offsetY);
    }
    return offsetY;
  };
  proto.computeOffsetZ = function (this: Box, other: Box, offsetZ: number) {
    if (other.maxX > this.minX && other.minX < this.maxX && other.maxY > this.minY && other.minY < this.maxY) {
      if (offsetZ > 0 && other.maxZ <= this.minZ + EPS)
        offsetZ = Math.min(Math.max(this.minZ - other.maxZ, 0), offsetZ);
      else if (offsetZ < 0 && other.minZ >= this.maxZ - EPS)
        offsetZ = Math.max(Math.min(this.maxZ - other.minZ, 0), offsetZ);
    }
    return offsetZ;
  };
  return true;
}
