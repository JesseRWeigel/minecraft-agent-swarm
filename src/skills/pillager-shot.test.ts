import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL = fs.readFileSync(path.join(__dirname, "shoot-arrow.ts"), "utf8");
const BRAIN = fs.readFileSync(path.join(__dirname, "..", "bot", "brain.ts"), "utf8");

test("pillager shot: the archery rule stays awake for the pillager point", () => {
  // Run 778: forty pillager lines at the village, Mason shot dead by one
  // three times, five crossbows and 110 arrows banked, and this override
  // fired zero times because Take Aim and Ol' Betsy were both earned.
  assert.match(BRAIN, /whos_the_pillager_now/, "the third archery point must be checked");
  assert.match(BRAIN, /!aimDone2 \|\| !betsyDone \|\| !pillagerDone/, "any unearned archery point keeps it running");
  assert.match(BRAIN, /prefer: !pillagerDone/, "the preference is passed only while that point is open");
});

test("pillager shot: hunting keeps firing until the raider is down", () => {
  // Take Aim and Ol' Betsy need a hit. This one needs the pillager dead, so
  // one arrow is not the finish line.
  assert.match(SKILL, /const HOSTILE_TARGET = "pillager"/, "the target is named once");
  assert.match(SKILL, /hunting \? 12 : 4/, "a hunt gets more shots than a plink");
  assert.match(SKILL, /hunting \? !target\.isValid : hit/, "a hunt ends when the target drops, not on first blood");
});

test("pillager shot: falls back to an animal when no raider is about", () => {
  assert.match(SKILL, /\?\?\s*bot\.nearestEntity\(\(e\) => TARGETS\.has/, "the animal search remains the fallback");
});
