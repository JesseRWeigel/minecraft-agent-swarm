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

test("watchdog: shuffling on the spot does not count as moving", () => {
  // Forge's stuck spot moved by less than a block between checks.
  const t0 = 1_000_000;
  let s = trackPosition(null, { x: 324, y: -15, z: -320 }, t0);
  s = trackPosition(s, { x: 324.5, y: -15, z: -320.4 }, t0 + 120_000);
  assert.strictEqual(s.since, t0, "a shuffle keeps the original timestamp");
  assert.ok(MOVED_BLOCKS >= 1, "the threshold is forgiving of normal jitter");
  assert.strictEqual(isPinned(s, t0 + IMMOBILE_MS, -15), true, "four minutes pinned underground");
});

test("watchdog: standing still near the surface is somebody's business, not a trap", () => {
  const t0 = 1_000_000;
  const s = trackPosition(null, { x: 300, y: 70, z: -310 }, t0);
  assert.strictEqual(isPinned(s, t0 + IMMOBILE_MS * 3, 70), false, `y above ${DEEP_Y} is not entombed`);
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
