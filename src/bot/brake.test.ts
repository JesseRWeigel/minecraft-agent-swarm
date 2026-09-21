import { test } from "node:test";
import assert from "node:assert/strict";
import { brakeToStop, BRAKE_MAX_TICKS, BRAKE_STOPPED_SPEED } from "./brake.js";

function fakeBot(startSpeed: number, decayPerTick = 0.5) {
  const log: string[] = [];
  const bot = {
    entity: { velocity: { x: startSpeed, z: 0 } },
    sneaking: false,
    clearControlStates() {
      log.push("clear");
    },
    setControlState(control: string, state: boolean) {
      log.push(`${control}=${state}`);
      if (control === "sneak") bot.sneaking = state;
    },
    async waitForTicks() {
      bot.entity.velocity.x *= decayPerTick;
      log.push(`tick sneak=${bot.sneaking}`);
    },
  };
  return { bot, log };
}

test("brake: sneaks while the bot is still sliding and releases after", async () => {
  const { bot, log } = fakeBot(0.28);
  const ticks = await brakeToStop(bot);
  assert.ok(ticks > 0, "a sliding bot must actually wait");
  assert.ok(
    log.filter((l) => l.startsWith("tick")).every((l) => l.endsWith("sneak=true")),
    "sneak must be held for every tick of the slide, since that is what holds the edge",
  );
  assert.strictEqual(bot.sneaking, false, "sneak must be released once stopped");
});

test("brake: a bot already at rest waits for nothing", async () => {
  const { bot } = fakeBot(0);
  assert.strictEqual(await brakeToStop(bot), 0);
  assert.strictEqual(bot.sneaking, false);
});

test("brake: gives up after a bounded number of ticks", async () => {
  // Never decays: pushed by a mob, in a current, or on ice.
  const { bot } = fakeBot(0.5, 1);
  const ticks = await brakeToStop(bot);
  assert.strictEqual(ticks, BRAKE_MAX_TICKS, "braking must not hold the march forever");
  assert.strictEqual(bot.sneaking, false);
});

test("brake: stops as soon as the speed is below the walking-off threshold", async () => {
  const { bot } = fakeBot(BRAKE_STOPPED_SPEED / 2);
  assert.strictEqual(await brakeToStop(bot), 0);
});
