import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bedTooFarFromHome, bedTooFarMessage, bedExplodesHere } from "./bed-safety.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("bed safety: the nether and the end detonate beds", () => {
  for (const dim of ["minecraft:the_nether", "the_nether", "nether", "minecraft:the_end", "the_end"]) {
    assert.strictEqual(bedExplodesHere(dim), true, `${dim} should be refused`);
  }
});

test("bed safety: the overworld sleeps normally", () => {
  for (const dim of ["minecraft:overworld", "overworld"]) {
    assert.strictEqual(bedExplodesHere(dim), false, `${dim} should still allow sleep`);
  }
});

test("bed safety: an unknown dimension keeps the nights working", () => {
  // Refusing on a string we do not recognise would cost every bot its sleep.
  assert.strictEqual(bedExplodesHere(undefined), false);
  assert.strictEqual(bedExplodesHere(null), false);
  assert.strictEqual(bedExplodesHere(""), false);
});

test("bed safety: a bed far from the village is refused and broken on respawn", () => {
  // Runs 803 and 804: Forge's respawn point sat at the plains village bed
  // 650 blocks east after a trade trip, and he died sixteen times out there.
  const home = { x: 286, z: -314 };
  assert.equal(bedTooFarFromHome({ x: 604, z: -496 }, home), true, "the plains village bed is far");
  assert.equal(bedTooFarFromHome({ x: 295, z: -317 }, home), false, "the village bed is home");
  assert.equal(bedTooFarFromHome({ x: 604, z: -496 }, undefined), false, "no home known, no refusal");
  assert.match(bedTooFarMessage(650), /650 blocks from the village/);
  const actions = fs.readFileSync(path.join(__dirname, "actions.ts"), "utf8");
  const sleep = actions.slice(
    actions.indexOf("async function sleepInBed"),
    actions.indexOf("await bot.sleep(target);"),
  );
  assert.match(
    sleep,
    /bedTooFarFromHome\(target\.position, STASH_POS\)/,
    "the sleep action refuses a far bed before using it",
  );
  const index = fs.readFileSync(path.join(__dirname, "index.ts"), "utf8");
  assert.match(
    index,
    /const farBed = !!bed && bedTooFarFromHome\(bed\.position, home\);/,
    "respawn safety measures the bed",
  );
  assert.match(index, /if \(bed && clustered < 3 && !farBed\)/, "a far bed is never kept");
});
