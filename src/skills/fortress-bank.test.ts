import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pickSighting, addSighting, recordApproach, dropSighting, parseBank } from "./fortress-bank.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FROM = { x: 30, z: -35 }; // the Nether portal exit
const REACHED = { x: 535, y: 52, z: -17, seenAt: "2026-09-19T20:24:00Z", by: "Mason", bestGap: 84 };
const STALLED = { x: 490, y: 51, z: 37, seenAt: "2026-09-21T14:28:02Z", by: "Mason", bestGap: 464 };

test("bank: a proven approach outranks a nearer sighting", () => {
  // The whole bug: (490, 37) is closer to the portal, and every march to it
  // stalled at 464 while (535, -17) had been reached to 84 blocks.
  assert.deepStrictEqual(pickSighting([STALLED, REACHED], FROM), REACHED);
});

test("bank: an untried sighting is judged by distance", () => {
  const fresh = { x: 100, y: 50, z: 0, seenAt: "now", by: "Mason" };
  const far = { x: 900, y: 50, z: 0, seenAt: "now", by: "Mason" };
  assert.deepStrictEqual(pickSighting([far, fresh], FROM), fresh);
});

test("bank: the same structure seen twice is banked once", () => {
  const again = { ...REACHED, x: 538, z: -20, seenAt: "later" };
  assert.strictEqual(addSighting([REACHED], again).length, 1);
  assert.strictEqual(addSighting([REACHED], STALLED).length, 2);
});

test("bank: an approach keeps the best result, never the latest", () => {
  const worse = recordApproach([REACHED], REACHED, 300);
  assert.strictEqual(worse[0].bestGap, 84, "a bad march must not erase a good one");
  assert.strictEqual(worse[0].attempts, 1);
  const better = recordApproach(worse, REACHED, 40);
  assert.strictEqual(better[0].bestGap, 40);
  assert.strictEqual(better[0].attempts, 2);
});

test("bank: a dropped sighting is kept but never chosen", () => {
  const dropped = dropSighting([REACHED, STALLED], REACHED, "2026-09-21T20:00:00Z");
  assert.strictEqual(dropped.length, 2, "the study rule keeps every row");
  assert.deepStrictEqual(pickSighting(dropped, FROM), STALLED);
});

test("bank: reads the old single-sighting file as well as the list", () => {
  assert.strictEqual(parseBank({ x: 490, y: 51, z: 37, seenAt: "x", by: "Mason" }).length, 1);
  assert.strictEqual(parseBank({ sightings: [REACHED, STALLED] }).length, 2);
  assert.strictEqual(parseBank({ droppedAt: "2026-09-20T00:00:00Z" }).length, 0, "an old tombstone holds nothing");
});

test("find_fortress: the skill budget covers the preflight and a full march", () => {
  // Run 790, 01:54Z: 309 seconds at the stash and the portal, then a march
  // from 504 to 203 blocks out in ninety seconds, cut off by the 480 second
  // skill budget with the bricks 203 blocks away.
  const src = fs.readFileSync(path.join(__dirname, "find-fortress.ts"), "utf8");
  const budget = Number(src.match(/timeoutMs: (\d+)_000/)?.[1]);
  const march = Number(src.match(/marchToward\(bot, sighting, (\d+)_000/)?.[1]);
  assert.ok(budget && march, "both numbers are readable");
  assert.ok(
    budget >= 300 + march + 120,
    `budget ${budget}s must fit a 5 minute preflight, the ${march}s march and a sweep`,
  );
});

test("find_fortress: hunts blazes once inside, and the brain keeps sending it until a rod is earned", () => {
  // Run 791, 02:56Z: A Terrible Fortress landed with Mason among four
  // hundred bricks and a wither skeleton killed him four seconds later.
  // Nothing in the swarm hunted a blaze, so the brewing chain had no path.
  const src = fs.readFileSync(path.join(__dirname, "find-fortress.ts"), "utf8");
  const entered = src.indexOf("entered = !!nearBrick;");
  const abort = src.indexOf("if (signal.aborted) {", entered);
  assert.ok(entered > 0 && abort > entered);
  assert.match(src.slice(entered, abort), /await huntBlazes\(bot, signal, step\)/, "the hunt runs after entering");
  const hunt = src.slice(src.indexOf("async function huntBlazes"), src.indexOf("function inNether"));
  assert.match(hunt, /e\.name === "blaze"/, "it looks for blazes");
  assert.match(hunt, /bot\.attack\(blaze\)/, "it swings at them");
  assert.match(hunt, /blaze_rod/, "it counts and collects rods");
  assert.match(hunt, /240_000/, "the hunt is bounded");
  const brain = fs.readFileSync(path.join(__dirname, "..", "bot", "brain.ts"), "utf8");
  const gate = brain.slice(brain.indexOf("const fortDone ="), brain.indexOf("const fortDone =") + 400);
  assert.match(gate, /obtain_blaze_rod/, "the trip stands down only once a rod is earned too");
});
