import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTIONS = fs.readFileSync(path.join(__dirname, "actions.ts"), "utf8");
const BRAIN = fs.readFileSync(path.join(__dirname, "brain.ts"), "utf8");

test("place protection: the stash zone refuses block placement", () => {
  // Run 786: the most-failed walk goal in the swarm was the stash itself at
  // (286, 70, -314), 34 failures in half an hour, and an RCON scan found
  // scattered cobblestone at head height on every side of it. Mason placed
  // it, wherever he happened to be standing, which was the stash.
  assert.match(ACTIONS, /const PLACE_PROTECT_RADIUS = 12/, "the same twelve blocks mine_block protects");
  const start = ACTIONS.indexOf("async function placeBlock(");
  const guard = ACTIONS.indexOf("zone around The Stash is protected", start);
  const equip = ACTIONS.indexOf('await bot.equip(item, "hand")', start);
  assert.notStrictEqual(guard, -1, "placeBlock must refuse inside the zone");
  assert.ok(guard < equip, "refuse before equipping, so nothing is placed");
});

test("place protection: the brain hands place_block the stash position", () => {
  // mine_block already received it; place_block never did, so the guard in
  // the action had nothing to measure against.
  assert.match(
    BRAIN,
    /decision\.action === "mine_block" \|\| decision\.action === "place_block"\) && this\.roleConfig\.stashPos/,
    "protectPos is injected for both",
  );
  assert.match(
    ACTIONS,
    /placeBlock\(bot, params\.blockType \|\| params\.block \|\| params\.item, params\.protectPos\)/,
  );
});
