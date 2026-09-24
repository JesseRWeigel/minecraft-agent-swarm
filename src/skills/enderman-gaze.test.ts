import { test } from "node:test";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { gazeProvokes, viewVector } from "./enderman-gaze.js";

const eye = new Vec3(0, 53.62, 0);
// mineflayer yaw 0 looks toward -z.
const northFeet = (d: number) => new Vec3(0, 52, -d);

test("yaw 0, pitch 0 looks toward -z", () => {
  const v = viewVector(0, 0);
  assert.ok(Math.abs(v.x) < 1e-9 && Math.abs(v.y) < 1e-9 && Math.abs(v.z + 1) < 1e-9);
});

test("looking straight at an enderman's eyes provokes it", () => {
  const feet = northFeet(12);
  const toEyes = feet.offset(0, 2.55, 0).minus(eye);
  const pitch = Math.atan2(toEyes.y, Math.hypot(toEyes.x, toEyes.z));
  assert.equal(gazeProvokes(eye, 0, pitch, feet), true);
});

test("run 820 march pose: level view with an enderman ahead is inside the safety cone", () => {
  assert.equal(gazeProvokes(eye, 0, 0.0, northFeet(20)), true);
});

test("looking down at the path is safe", () => {
  assert.equal(gazeProvokes(eye, 0, -1.2, northFeet(12)), false);
});

test("an enderman off to the side is safe", () => {
  assert.equal(gazeProvokes(eye, 0, 0, new Vec3(12, 52, 0)), false);
});

test("one beyond 64 blocks never counts", () => {
  assert.equal(gazeProvokes(eye, 0, 0.0, northFeet(70)), false);
});
