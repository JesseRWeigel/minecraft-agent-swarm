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
  assert.match(
    BRAIN,
    /!aimDone2 \|\| !betsyDone \|\| \(!pillagerDone && pillagerNear\)/,
    "an unearned point keeps it running, and the last one waits for a target",
  );
  assert.match(BRAIN, /prefer: onlyPillagerLeft \? "pillager"/, "the preference rides on the last-point flag");
  assert.match(
    BRAIN,
    /const onlyPillagerLeft = aimDone2 && betsyDone && !pillagerDone/,
    "which is what that flag means",
  );
});

test("pillager shot: hunting keeps firing until the raider is down", () => {
  // Take Aim and Ol' Betsy need a hit. This one needs the pillager dead, so
  // one arrow is not the finish line.
  assert.match(SKILL, /const HOSTILE_TARGET = "pillager"/, "the target is named once");
  assert.match(SKILL, /hunting \? 12 : 4/, "a hunt gets more shots than a plink");
  assert.match(SKILL, /hunting \? !target\.isValid : hit/, "a hunt ends when the target drops, not on first blood");
});

test("pillager shot: does not shoot an animal when a pillager was asked for", () => {
  // Take Aim and Ol' Betsy are earned by the time the pillager point is the
  // one left, so an animal shot reports success and earns nothing. Run 780
  // spent thirteen archery runs on donkeys and horses for no points.
  const start = SKILL.indexOf("const target = wantPillager");
  assert.notStrictEqual(start, -1, "the target choice must branch on the request");
  const block = SKILL.slice(start, start + 240);
  // The animal search must sit on the OTHER branch of the ternary, never as a
  // fallback after the pillager search.
  assert.match(block, /wantPillager\s*\?[\s\S]*HOSTILE_TARGET[\s\S]*:\s*bot\.nearestEntity/, "one branch each");
  assert.doesNotMatch(block, /HOSTILE_TARGET\)\s*\)\s*\?\?/, "the pillager search must not fall through to an animal");
});

test("pillager shot: the rule waits until a raider is actually nearby", () => {
  // Otherwise the override burns Blade's attention on an empty field.
  assert.match(BRAIN, /const pillagerNear =/, "the brain checks for a live pillager");
  assert.match(BRAIN, /!pillagerDone && pillagerNear/, "the last point only fires with a target in sight");
  assert.match(BRAIN, /< 48/, "and within a sensible radius");
});

test("pillager shot: stands off a raider rather than walking into it", () => {
  // Run 779 found pillagers twice and lost both to "The pillager slipped away
  // before the shot", because the approach closed to four blocks on a moving
  // patrol that shoots back. A crossbow reaches much further than that.
  const close = SKILL.indexOf("const closeTo =");
  assert.notStrictEqual(close, -1, "the approach distance must depend on the target");
  const block = SKILL.slice(close, close + 600);
  assert.match(block, /hunting \? 12 : 4/, "stand off a raider, close on an animal");
  assert.match(block, /hunting \? 24 : 8/, "and allow it to wander further before giving up");
  assert.match(
    block,
    /if \(bot\.entity\.position\.distanceTo\(target\.position\) > closeTo\)/,
    "only walk when out of range",
  );
});
