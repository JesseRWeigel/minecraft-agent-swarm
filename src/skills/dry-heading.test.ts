import { test } from "node:test";
import assert from "node:assert/strict";
import { driestDirection } from "./escape-to-surface.js";

const DIRS: [number, number][] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/** A bot that only knows where the water is. */
function botWithWaterAt(wet: (x: number, y: number, z: number) => boolean) {
  return {
    blockAt: (p: { x: number; y: number; z: number }) => ({ name: wet(p.x, p.y, p.z) ? "water" : "stone" }),
  } as never;
}

test("driest direction: heads away from the water", () => {
  // A lake filling everything west of x=0. East is the only dry heading.
  const bot = botWithWaterAt((x) => x < 0);
  assert.deepStrictEqual(driestDirection(bot, 0, 41, 0, DIRS), [1, 0]);
});

test("driest direction: the reach decides which question is asked", () => {
  // Dry within a few blocks east, soaked further out; the near sample and the
  // far sample should disagree, which is the whole reason reach exists.
  const bot = botWithWaterAt((x) => x > 8);
  const near = driestDirection(bot, 0, 41, 0, DIRS, 3);
  const far = driestDirection(bot, 0, 41, 0, DIRS, 16);
  assert.deepStrictEqual(near, [1, 0], "close in, east still looks dry");
  assert.notDeepStrictEqual(far, [1, 0], "sixteen blocks out, east is the lake");
});

test("driest direction: returns a usable heading when everything is dry", () => {
  const bot = botWithWaterAt(() => false);
  const dir = driestDirection(bot, 0, 41, 0, DIRS, 16);
  assert.ok(
    DIRS.some((d) => d[0] === dir[0] && d[1] === dir[1]),
    "a dry cave must still produce a direction to walk",
  );
});
