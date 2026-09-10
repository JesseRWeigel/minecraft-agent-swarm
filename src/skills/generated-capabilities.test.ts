import assert from "node:assert/strict";
import { test } from "node:test";
import { createGeneratedCapabilityHandler } from "./generated-capabilities.js";

function fakeBot() {
  const calls: string[] = [];
  const blocks = new Map([
    ["1,64,1", { name: "oak_log", position: { x: 1, y: 64, z: 1 } }],
    ["2,63,2", { name: "stone", position: { x: 2, y: 63, z: 2 } }],
  ]);
  const bot: any = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    health: 18,
    food: 16,
    inventory: {
      items: () => [
        { name: "oak_log", count: 3, type: 5, metadata: 0 },
        { name: "apple", count: 2, type: 6, metadata: 0 },
      ],
    },
    registry: {
      blocksByName: { oak_log: { id: 1 }, stone: { id: 2 } },
      itemsByName: { oak_planks: { id: 10 } },
    },
    entities: {
      7: { id: 7, name: "zombie", type: "mob", position: { x: 3, y: 64, z: 3 } },
      8: { id: 8, username: "player", name: "player", type: "player", position: { x: 2, y: 64, z: 2 } },
    },
    findBlocks: () => [{ x: 1, y: 64, z: 1 }],
    findBlock: ({ matching }: any) => [...blocks.values()].find(matching) ?? null,
    blockAt: (position: any) => blocks.get(`${position.x},${position.y},${position.z}`) ?? null,
    pathfinder: {
      setMovements: () => calls.push("movements"),
      goto: async () => calls.push("navigate"),
      stop: () => calls.push("stop"),
    },
    dig: async () => calls.push("dig"),
    stopDigging: () => calls.push("stopDigging"),
    recipesFor: () => [{ id: "recipe" }],
    craft: async () => calls.push("craft"),
    equip: async () => calls.push("equip"),
    consume: async () => calls.push("consume"),
    placeBlock: async () => calls.push("place"),
    lookAt: async () => calls.push("look"),
    attack: () => calls.push("attack"),
    waitForTicks: async () => calls.push("wait"),
  };
  return { bot, calls };
}

test("capability observations contain bounded DTOs and omit players", async () => {
  const { bot } = fakeBot();
  const handle = createGeneratedCapabilityHandler(bot);
  const result = (await handle("observe", {
    blocks: ["oak_log"],
    includeEntities: true,
    radius: 8,
  })) as any;
  assert.deepEqual(result.position, { x: 0, y: 64, z: 0 });
  assert.deepEqual(result.inventory, [
    { name: "oak_log", count: 3 },
    { name: "apple", count: 2 },
  ]);
  assert.deepEqual(result.blocks, [{ name: "oak_log", position: { x: 1, y: 64, z: 1 } }]);
  assert.deepEqual(result.entities, [{ id: 7, name: "zombie", type: "mob", position: { x: 3, y: 64, z: 3 } }]);
});

test("capability handler exposes useful high-level operations without raw bot access", async () => {
  const { bot, calls } = fakeBot();
  const handle = createGeneratedCapabilityHandler(bot);
  await handle("navigate", { x: 2, y: 64, z: 2, radius: 2 });
  await handle("mine", { block: "oak_log", count: 1 });
  await handle("craft", { item: "oak_planks", count: 1 });
  await handle("equip", { item: "apple", destination: "hand" });
  await handle("consume", { item: "apple" });
  await handle("place", { block: "oak_log", x: 2, y: 64, z: 2 });
  await handle("look", { x: 1, y: 65, z: 1 });
  await handle("attack", { entityId: 7 });
  await handle("wait", { ticks: 1 });
  assert.deepEqual(
    new Set(calls),
    new Set(["navigate", "dig", "craft", "equip", "consume", "place", "look", "attack", "wait"]),
  );
});

test("capability handler rejects distant actions, players, extra keys, and quota exhaustion", async () => {
  const { bot } = fakeBot();
  const handle = createGeneratedCapabilityHandler(bot);
  await assert.rejects(handle("navigate", { x: 100, y: 64, z: 0 }), /radius|distance/i);
  await assert.rejects(handle("attack", { entityId: 8 }), /player/i);
  await assert.rejects(handle("wait", { ticks: 1, command: "/op" }), /unexpected/i);
  for (let i = 0; i < 7; i++) await handle("attack", { entityId: 7 });
  await assert.rejects(handle("attack", { entityId: 7 }), /quota/i);
});

test("capability abort stops bot operations and prevents a pre-aborted operation from starting", async () => {
  const { bot, calls } = fakeBot();
  let releaseNavigation: (() => void) | undefined;
  bot.pathfinder.goto = () =>
    new Promise<void>((resolve) => {
      releaseNavigation = resolve;
    });
  const controller = new AbortController();
  const handle = createGeneratedCapabilityHandler(bot, { signal: controller.signal });
  const navigation = handle("navigate", { x: 2, y: 64, z: 2 });
  controller.abort();
  await assert.rejects(navigation, /aborted/i);
  assert.ok(calls.includes("stop"));
  releaseNavigation?.();

  let digs = 0;
  bot.dig = async () => {
    digs++;
  };
  await assert.rejects(handle("mine", { block: "oak_log", count: 1 }), /aborted/i);
  assert.equal(digs, 0);
});
