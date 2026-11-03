import assert from "node:assert/strict";
import { test } from "node:test";
import { applyStartupGamerules } from "./startup-gamerules.js";

test("default startup sends no gamerules and does not reset existing world settings", async () => {
  const sent: string[] = [];
  await applyStartupGamerules(
    {
      chat: (message) => {
        sent.push(message);
      },
    },
    "Atlas",
    false,
  );
  assert.deepEqual(sent, []);
});

test("only opted-in Atlas sends the two existing demo gamerules", async () => {
  const sent: string[] = [];
  const bot = {
    chat: (message: string) => {
      sent.push(message);
    },
  };
  await applyStartupGamerules(bot, "Flora", true);
  assert.deepEqual(sent, []);
  await applyStartupGamerules(bot, "Atlas", true);
  assert.deepEqual(sent, ["/gamerule keepInventory true", "/gamerule doMobSpawning true"]);
});

test("opted-in Paper 26.3 uses the renamed server gamerules", async () => {
  const sent: string[] = [];
  await applyStartupGamerules(
    {
      chat: (message) => {
        sent.push(message);
      },
    },
    "Atlas",
    true,
    "26.3",
  );
  assert.deepEqual(sent, ["/gamerule minecraft:keep_inventory true", "/gamerule minecraft:spawn_mobs true"]);
});
