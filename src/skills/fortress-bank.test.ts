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
  assert.match(gate, /rodSupplyDone/, "the trip stands down only once the team holds two rods or has brewed");
});

test("find_fortress: fights off wither skeletons on the walk in and during the hunt", () => {
  // Runs 791 and 792: two trips in a row ended "slain by Wither Skeleton"
  // near (492, 54, 40) on the ninety second walk to the middle, sword in
  // hand and never swung, and each death dropped the boots and the gold.
  const src = fs.readFileSync(path.join(__dirname, "find-fortress.ts"), "utf8");
  const fend = src.indexOf("async function fendOff");
  assert.ok(fend > 0, "the fend-off helper exists");
  const foes = src.indexOf("const FORTRESS_FOES");
  assert.ok(foes > 0 && foes < fend, "the foe list sits above the helper");
  assert.match(src.slice(foes, fend), /wither_skeleton/, "wither skeletons are on the list");
  const middle = src.indexOf("walking to the middle at");
  const nearBrick = src.indexOf("const nearBrick", middle);
  assert.match(src.slice(middle, nearBrick), /await fendOff\(bot, signal\)/, "the walk to the middle fends off first");
  assert.doesNotMatch(src.slice(middle, nearBrick), /90_000, 12_000/, "no more single ninety second blind walk");
  const hunt = src.slice(src.indexOf("async function huntBlazes"), src.indexOf("function inNether"));
  assert.match(hunt, /await fendOff\(bot, signal\)/, "the hunt loop fends off each pass");
});

test("find_fortress: packs a crossbow and shoots blazes from a stand-off", () => {
  // Run 793: the first hunt walked Mason toward a blaze eight blocks off
  // with a sword and its fireballs killed him two blocks below the walkway,
  // while the armoury held four crossbows and seventy arrows.
  const src = fs.readFileSync(path.join(__dirname, "find-fortress.ts"), "utf8");
  const pre = src.slice(src.indexOf("armourUpForNether(bot"), src.indexOf("Stepping through the portal"));
  assert.match(pre, /"crossbow", 1/, "a crossbow is fetched before crossing");
  assert.match(pre, /"arrow", 24/, "arrows too");
  const hunt = src.slice(src.indexOf("async function huntBlazes"), src.indexOf("function inNether"));
  assert.match(hunt, /shootOnce\(blaze\)/, "the hunt shoots");
  assert.match(hunt, /bot\.health < 8/, "a health floor ends the hunt");
  assert.match(hunt, /gap > 24/, "it stands off rather than walking into the fireballs");
  assert.match(hunt, /crossbowShot\(bot, blaze\)/, "the hunt fires the shared crossbow shot");
  const shot = src.slice(src.indexOf("async function crossbowShot"), src.indexOf("async function fendOff"));
  assert.match(shot, /"entityHurt"/, "a hit is read from the hurt event");
});

test("find_fortress: leaves zombified piglins alone and reads rod drops through the item accessor", () => {
  // Run 794: "zombified_piglin 5.2 away — fighting it off first" on the walk
  // in, and a blaze down after ten bolts with no rod picked up because the
  // drop search read raw metadata.
  const src = fs.readFileSync(path.join(__dirname, "find-fortress.ts"), "utf8");
  const foes = src.slice(src.indexOf("const FORTRESS_FOES"), src.indexOf("async function fendOff"));
  assert.doesNotMatch(foes, /zombified_piglin"/, "zombified piglins are neutral until struck");
  assert.match(src, /getDroppedItem\?\.\(\)/, "rod drops are read through getDroppedItem");
  assert.match(src, /blaze rod on the floor at/, "a downed blaze is followed by a rod sweep");
  assert.match(src, /shot \$\{shots\} at blaze/, "every shot logs its range");
});

test("find_fortress: a downed blaze is reported as killed or gone, with the floor listed", () => {
  // Run 795: two blazes went "down" with hits seen and no rod on the floor.
  // Down covered both a kill and a despawn, so the log now says which and
  // names every drop within 32 blocks before the sweep.
  const src = fs.readFileSync(path.join(__dirname, "find-fortress.ts"), "utf8");
  const hunt = src.slice(src.indexOf("async function huntBlazes"), src.indexOf("function inNether"));
  assert.match(hunt, /"entityDead"/, "a kill is read from entityDead");
  assert.match(hunt, /"entityGone"/, "a despawn is read from entityGone");
  assert.match(hunt, /drops within 32/, "the floor is listed after a downed blaze");
  assert.match(hunt, /fate === "killed"/, "a kill sends the bot to where the blaze died");
});

test("find_fortress: the march fends off between hops, and an enderman only when it is biting", () => {
  // Runs 797 and 798: three marches ended "slain by Enderman" with no line
  // before the death, and one ended "slain by Magma Cube" on the ledge ten
  // blocks from the bricks, because the fend-off only ran on the walk to the
  // middle and the foe list left endermen alone at any range.
  const src = fs.readFileSync(path.join(__dirname, "find-fortress.ts"), "utf8");
  const marches = src.split("await marchToward(bot").length - 1;
  const hops = src.split("beforeHop: async () => {").length - 1;
  assert.equal(hops, marches, "every march passes a beforeHop fend-off");
  const fend = src.slice(src.indexOf("async function fendOff"), src.indexOf("async function huntBlazes"));
  assert.match(
    fend,
    /e\.name === "enderman" && d <= 3\.5 && bitten\(\)/,
    "endermen count only at arm's reach while hurt",
  );
  assert.match(src, /watchHurt\(bot\);/, "the hurt watch is armed when the trip starts");
  const bastion = fs.readFileSync(path.join(__dirname, "loot-bastion.ts"), "utf8");
  assert.match(bastion, /if \(o\.beforeHop\) await o\.beforeHop\(\);/, "marchToward runs the hook before each hop");
});
