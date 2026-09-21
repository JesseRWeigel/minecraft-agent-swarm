import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSighting, addSighting, recordApproach, dropSighting, parseBank } from "./fortress-bank.js";

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
