import { test } from "node:test";
import assert from "node:assert/strict";
import { getWorldContext, isHostile, isPassive } from "./perception.js";

// ── Helper: build a minimal mock bot ────────────────────────────────────────

function mockBot(overrides: Record<string, any> = {}) {
  const pos = overrides.position ?? { x: 100, y: 64, z: -200 };
  return {
    health: overrides.health ?? 20,
    food: overrides.food ?? 20,
    time: { timeOfDay: overrides.timeOfDay ?? 6000 },
    username: overrides.username ?? "TestBot",
    entity: {
      position: {
        ...pos,
        offset: (dx: number, dy: number, dz: number) => ({
          x: pos.x + dx,
          y: pos.y + dy,
          z: pos.z + dz,
        }),
        distanceTo: (other: any) => Math.sqrt((pos.x - other.x) ** 2 + (pos.y - other.y) ** 2 + (pos.z - other.z) ** 2),
      },
    },
    inventory: {
      items: () => overrides.items ?? [],
    },
    entities: overrides.entities ?? {},
    blockAt: overrides.blockAt ?? (() => ({ name: "air" })),
  } as any;
}

function makeEntity(name: string, type: string, x: number, y: number, z: number, extra: Record<string, any> = {}) {
  return {
    name,
    mobType: name,
    type,
    username: extra.username,
    position: { x, y, z },
  };
}

// ── isHostile / isPassive ───────────────────────────────────────────────────

test("isHostile: recognizes zombie as hostile", () => {
  assert.equal(isHostile({ name: "zombie", mobType: "zombie" } as any), true);
});

test("isHostile: recognizes creeper as hostile", () => {
  assert.equal(isHostile({ name: "creeper", mobType: "creeper" } as any), true);
});

test("isHostile: cow is not hostile", () => {
  assert.equal(isHostile({ name: "cow", mobType: "cow" } as any), false);
});

test("isHostile: classifies by entity.name (mobType is deprecated, no longer read)", () => {
  // entity.name is populated in 1.21.4; mobType is a deprecated getter that
  // console.trace-spams on access, so entityName uses ONLY name now.
  assert.equal(isHostile({ name: "skeleton" } as any), true);
});

test("isHostile: empty name is not classified as hostile (no mobType fallback)", () => {
  assert.equal(isHostile({ name: "", mobType: "skeleton" } as any), false);
});

test("isHostile: never throws on a bad entity ref", () => {
  assert.equal(isHostile(null as any), false);
  assert.equal(isHostile({} as any), false);
});

test("isPassive: recognizes cow as passive", () => {
  assert.equal(isPassive({ name: "cow", mobType: "cow" } as any), true);
});

test("isPassive: recognizes sheep as passive", () => {
  assert.equal(isPassive({ name: "sheep", mobType: "sheep" } as any), true);
});

test("isPassive: zombie is not passive", () => {
  assert.equal(isPassive({ name: "zombie", mobType: "zombie" } as any), false);
});

test("isPassive: unknown mob is neither passive nor hostile", () => {
  assert.equal(isPassive({ name: "unknown_creature", mobType: "unknown_creature" } as any), false);
  assert.equal(isHostile({ name: "unknown_creature", mobType: "unknown_creature" } as any), false);
});

// ── getWorldContext: basic fields ────────────────────────────────────────────

test("getWorldContext: includes position", () => {
  const ctx = getWorldContext(mockBot({ position: { x: 50.7, y: 63.2, z: -100.9 } }));
  assert.ok(ctx.includes("Position: 51, 63, -101"), `Expected position in output, got: ${ctx}`);
});

test("getWorldContext: includes health and hunger", () => {
  const ctx = getWorldContext(mockBot({ health: 14, food: 18 }));
  assert.ok(ctx.includes("Health: 14/20"));
  assert.ok(ctx.includes("Hunger: 18/20"));
});

test("getWorldContext: shows daytime for early morning", () => {
  const ctx = getWorldContext(mockBot({ timeOfDay: 6000 }));
  assert.ok(ctx.includes("daytime"));
});

test("getWorldContext: shows nighttime for midnight", () => {
  const ctx = getWorldContext(mockBot({ timeOfDay: 18000 }));
  assert.ok(ctx.includes("nighttime"));
  assert.ok(ctx.includes("hostile mobs spawn"));
});

test("getWorldContext: shows daytime just before dawn boundary (23001+)", () => {
  const ctx = getWorldContext(mockBot({ timeOfDay: 23500 }));
  assert.ok(ctx.includes("daytime"));
});

// ── getWorldContext: inventory ───────────────────────────────────────────────

test("getWorldContext: shows empty inventory", () => {
  const ctx = getWorldContext(mockBot({ items: [] }));
  assert.ok(ctx.includes("Inventory: empty"));
});

test("getWorldContext: summarizes inventory items", () => {
  const items = [
    { name: "oak_log", count: 5 },
    { name: "iron_ingot", count: 3 },
  ];
  const ctx = getWorldContext(mockBot({ items }));
  assert.ok(ctx.includes("oak_logx5"));
  assert.ok(ctx.includes("iron_ingotx3"));
});

// ── getWorldContext: entities ────────────────────────────────────────────────

test("getWorldContext: shows hostile mobs nearby", () => {
  const botPos = { x: 100, y: 64, z: 100 };
  const entities = {
    "1": makeEntity("zombie", "mob", 105, 64, 100),
  };
  const bot = mockBot({ position: botPos, entities });
  const ctx = getWorldContext(bot);
  assert.ok(ctx.includes("DANGER"));
  assert.ok(ctx.includes("zombie"));
});

test("getWorldContext: shows players nearby (excluding self)", () => {
  const botPos = { x: 0, y: 64, z: 0 };
  const entities = {
    "1": makeEntity("Steve", "player", 5, 64, 0, { username: "Steve" }),
    "2": makeEntity("TestBot", "player", 0, 64, 0, { username: "TestBot" }),
  };
  const bot = mockBot({ position: botPos, entities, username: "TestBot" });
  const ctx = getWorldContext(bot);
  assert.ok(ctx.includes("Players nearby: Steve"));
  assert.ok(!ctx.includes("Players nearby: Steve, TestBot"));
});

test("getWorldContext: shows animals nearby", () => {
  const entities = {
    "1": makeEntity("cow", "mob", 105, 64, -200),
    "2": makeEntity("sheep", "mob", 108, 64, -200),
  };
  const bot = mockBot({ entities });
  const ctx = getWorldContext(bot);
  assert.ok(ctx.includes("Animals nearby"));
  assert.ok(ctx.includes("cow"));
  assert.ok(ctx.includes("sheep"));
});

test("getWorldContext: no entity sections when none nearby", () => {
  const ctx = getWorldContext(mockBot({ entities: {} }));
  assert.ok(!ctx.includes("DANGER"));
  assert.ok(!ctx.includes("Players nearby"));
  assert.ok(!ctx.includes("Animals nearby"));
});

test("getWorldContext: entities beyond 16 blocks are excluded", () => {
  const botPos = { x: 0, y: 64, z: 0 };
  const entities = {
    "1": makeEntity("zombie", "mob", 50, 64, 0), // 50 blocks away
  };
  const bot = mockBot({ position: botPos, entities });
  const ctx = getWorldContext(bot);
  assert.ok(!ctx.includes("DANGER"));
});

// ── getWorldContext: warnings ────────────────────────────────────────────────

test("getWorldContext: warns when very hungry", () => {
  const ctx = getWorldContext(mockBot({ food: 4 }));
  assert.ok(ctx.includes("WARNING: Very hungry"));
});

test("getWorldContext: no hunger warning at food=7", () => {
  const ctx = getWorldContext(mockBot({ food: 7 }));
  assert.ok(!ctx.includes("Very hungry"));
});

test("getWorldContext: warns when low health", () => {
  const ctx = getWorldContext(mockBot({ health: 5 }));
  assert.ok(ctx.includes("WARNING: Low health"));
});

test("getWorldContext: no health warning at health=9", () => {
  const ctx = getWorldContext(mockBot({ health: 9 }));
  assert.ok(!ctx.includes("Low health"));
});

// ── getWorldContext: water detection ─────────────────────────────────────────

test("getWorldContext: alerts when bot is in water", () => {
  const bot = mockBot({
    blockAt: (pos: any) => ({ name: "water" }),
  });
  const ctx = getWorldContext(bot);
  assert.ok(ctx.includes("ALERT: Bot is IN WATER"));
});

// ── getWorldContext: notable blocks ─────────────────────────────────────────

test("getWorldContext: shows nearby diamond ore", () => {
  const botPos = { x: 10, y: 12, z: 10 };
  const bot = mockBot({
    position: botPos,
    blockAt: (pos: any) => {
      if (pos.x === 10 && pos.y === 12 && pos.z === 10) return { name: "stone" };
      if (pos.x === 12 && pos.y === 12 && pos.z === 10) return { name: "diamond_ore" };
      return { name: "stone" };
    },
  });
  const ctx = getWorldContext(bot);
  assert.ok(ctx.includes("diamond_ore"));
});
