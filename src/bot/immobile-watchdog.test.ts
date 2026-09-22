import { test } from "node:test";
import assert from "node:assert/strict";
import { trackPosition, isPinned, IMMOBILE_MS, DEEP_Y, MOVED_BLOCKS } from "./immobile-watchdog.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("watchdog: a moving bot keeps resetting its clock", () => {
  const t0 = 1_000_000;
  let s = trackPosition(null, { x: 0, y: 10, z: 0 }, t0);
  s = trackPosition(s, { x: 20, y: 10, z: 0 }, t0 + 60_000);
  assert.strictEqual(s.since, t0 + 60_000, "a real move restarts the clock");
  assert.strictEqual(isPinned(s, t0 + 60_000 + IMMOBILE_MS - 1, 10), false);
});

test("watchdog: wandering inside a cave does not count as going anywhere", () => {
  // Run 785: Forge reported stuck at (357, 24, -287) nine times and the
  // watchdog fired zero, because a wedged bot still shuffles and swims, and
  // a three-block clock reset on every twitch. Net displacement is the test.
  const t0 = 1_000_000;
  let s = trackPosition(null, { x: 357, y: 24, z: -287 }, t0);
  s = trackPosition(s, { x: 361, y: 27, z: -284 }, t0 + 120_000);
  assert.strictEqual(s.since, t0, "a few blocks of shuffling keeps the clock running");
  assert.ok(MOVED_BLOCKS >= 8, "the anchor is wide enough to ignore cave wandering");
  assert.strictEqual(isPinned(s, t0 + IMMOBILE_MS, 24), true, "four minutes underground is a trap");
});

test("watchdog: standing still near the surface with nothing in hand is not a trap", () => {
  const t0 = 1_000_000;
  const s = trackPosition(null, { x: 300, y: 70, z: -310 }, t0);
  assert.strictEqual(isPinned(s, t0 + IMMOBILE_MS * 3, 70, false), false, `y above ${DEEP_Y} and idle is fine`);
});

test("watchdog: above ground it also takes failing walks", () => {
  // Sixteen blocks is wide enough that a farmer working one plot could trip
  // it, so near the surface the rule wants a second sign of trouble.
  const t0 = 1_000_000;
  const s = trackPosition(null, { x: 300, y: 70, z: -310 }, t0);
  assert.strictEqual(isPinned(s, t0 + IMMOBILE_MS, 70, true, false), false, "busy but walking fine is left alone");
  assert.strictEqual(isPinned(s, t0 + IMMOBILE_MS, 70, true, true), true, "busy and failing walks is stuck");
});

test("watchdog: motionless with work in hand is a trap at any height", () => {
  // Run 784: Atlas reported stuck at (357, 55, -309) fifteen times and the
  // watchdog ignored all of them, because 55 is above the y=45 line drawn to
  // protect a bot idling at the village, whose floor is around y=70. The
  // depth line excluded exactly the middle ground where bots get wedged.
  const t0 = 1_000_000;
  const s = trackPosition(null, { x: 357, y: 55, z: -309 }, t0);
  assert.strictEqual(isPinned(s, t0 + IMMOBILE_MS, 55, true, true), true, "trying and failing means stuck");
  assert.strictEqual(isPinned(s, t0 + IMMOBILE_MS, 55, false, false), false, "idle and fine is left alone");
});

test("watchdog: the brain aborts the held skill before digging out", () => {
  // The escape that already exists is gated on no skill running, which is
  // exactly the bot that needs it. Aborting first is what makes the rule
  // reachable for a bot wedged inside a long skill.
  const brain = fs.readFileSync(path.join(__dirname, "brain.ts"), "utf8");
  const start = brain.indexOf("pinned at");
  assert.notStrictEqual(start, -1, "the watchdog override must exist");
  const block = brain.slice(start - 900, start + 900);
  assert.match(block, /abortActiveSkill\(this\.bot\)/, "the held skill is cancelled");
  assert.match(block, /skill: "escape_to_surface"/, "and the escape is what runs next");
  assert.ok(block.indexOf("abortActiveSkill") < block.indexOf('skill: "escape_to_surface"'), "abort first");
});

test("watchdog: the brain measures work as a held skill or a live walk", () => {
  const brain = fs.readFileSync(path.join(__dirname, "brain.ts"), "utf8");
  const start = brain.indexOf("const working =");
  assert.notStrictEqual(start, -1, "the brain must decide what counts as trying");
  const block = brain.slice(start, start + 200);
  assert.match(block, /skillHolding\(this\.bot\)/, "a held skill counts");
  assert.match(block, /pathfinder\?\.isMoving\?\.\(\)/, "so does a walk in progress");
});

test("watchdog: the brain says how long the anchor has held", () => {
  // Two cycles running this rule fired zero times and the log could not say
  // whether the clock was resetting, the test was wrong, or the block never
  // ran. A periodic line answers that without waiting for another hour.
  const brain = fs.readFileSync(path.join(__dirname, "brain.ts"), "utf8");
  assert.match(brain, /\[PinDebug\]/, "the diagnostic must exist");
  assert.match(brain, /working=\$\{working\}, navFails=\$\{this\.navFailStreak\}/, "and report both conditions");
});
