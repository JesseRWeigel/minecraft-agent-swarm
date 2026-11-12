import { test } from "node:test";
import assert from "node:assert/strict";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

import { ensureReachableCraftingTable, placeFurnaceNearBot, type WalkNear } from "./furnace-table.js";

// Regression: a one-hour baseline logged repeated smelt_ores failures of
// "Couldn't craft a furnace. Need 8 cobblestone and a crafting table." with 8+
// cobblestone aboard. No table within 32 blocks meant recipesFor(furnace,
// null) found nothing (a furnace needs the 3x3 grid), and nothing ever
// placed a held table or crafted one from planks.

const ITEMS: Record<string, { id: number }> = {
  furnace: { id: 1 },
  crafting_table: { id: 2 },
  oak_planks: { id: 3 },
  oak_log: { id: 4 },
  cobblestone: { id: 5 },
};
const mcData = { itemsByName: ITEMS };

type FakeBlock = { name: string; position: Vec3; boundingBox: "block" | "empty" };
type Recipe = { out: string; yields: number; needs: Record<string, number>; requiresTable: boolean };

const RECIPES: Record<number, Recipe> = {
  1: { out: "furnace", yields: 1, needs: { cobblestone: 8 }, requiresTable: true },
  2: { out: "crafting_table", yields: 1, needs: { oak_planks: 4 }, requiresTable: false },
  3: { out: "oak_planks", yields: 4, needs: { oak_log: 1 }, requiresTable: false },
};

interface FakeOptions {
  inventory?: Record<string, number>;
  tableAt?: Vec3;
  /** Pre-existing furnaces in the world, unrelated to this placement. */
  furnacesAt?: Vec3[];
  /** true = every placement throws without placing; a name = only that item. */
  placeThrows?: boolean | string;
  /** Place the block, then throw anyway (a block-update timeout after success). */
  placeThrowsAfterPlacing?: string;
  craftThrows?: string;
  /** Called after equip resolves, with the equipped item name. */
  onEquip?: (name: string) => void;
  /** Called after a block lands, with its name. */
  onPlace?: (name: string) => void;
}

/**
 * A small world faithful to the mineflayer behaviour the skill relies on:
 * recipesFor omits table recipes when no table is passed and omits recipes
 * the pack cannot afford; craft at a table throws when out of reach;
 * placeBlock puts the held item on the face of the reference block.
 */
function fakeBot(opts: FakeOptions = {}) {
  const inv = new Map<string, number>(Object.entries(opts.inventory ?? {}));
  const world = new Map<string, FakeBlock>();
  const key = (v: Vec3) => `${v.x},${v.y},${v.z}`;
  const put = (name: string, p: Vec3) =>
    world.set(key(p), { name, position: p.clone(), boundingBox: name === "air" ? "empty" : "block" });
  for (let x = -40; x <= 40; x++) for (let z = -4; z <= 4; z++) put("stone", new Vec3(x, 63, z));
  if (opts.tableAt) put("crafting_table", opts.tableAt);
  for (const p of opts.furnacesAt ?? []) put("furnace", p);

  const log: string[] = [];
  let held: string | null = null;
  const has = (needs: Record<string, number>) => Object.entries(needs).every(([n, c]) => (inv.get(n) ?? 0) >= c);

  const bot = {
    username: "Tester",
    version: "1.21.4",
    entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory: {
      items: () =>
        [...inv.entries()]
          .filter(([, c]) => c > 0)
          .map(([name, c]) => ({ name, count: c, type: ITEMS[name]?.id ?? 99 })),
    },
    blockAt(v: Vec3) {
      const p = v.floored();
      return world.get(key(p)) ?? { name: "air", position: p, boundingBox: "empty" };
    },
    findBlock({ matching, maxDistance }: { matching: (b: FakeBlock) => boolean; maxDistance: number }) {
      let best: FakeBlock | null = null;
      for (const b of world.values()) {
        const d = bot.entity.position.distanceTo(b.position);
        if (matching(b) && d <= maxDistance && (!best || d < bot.entity.position.distanceTo(best.position))) best = b;
      }
      return best;
    },
    recipesFor(id: number, _meta: null, _n: number, table: FakeBlock | null) {
      const r = RECIPES[id];
      if (!r || (r.requiresTable && !table) || !has(r.needs)) return [];
      return [r];
    },
    async craft(r: Recipe, times: number, table?: FakeBlock) {
      log.push(`craft:${r.out}`);
      if (opts.craftThrows === r.out) throw new Error(`server rejected ${r.out}`);
      if (r.requiresTable && !table) throw new Error("Recipe requires craftingTable");
      if (table && bot.entity.position.distanceTo(table.position) > 4.5) throw new Error("table out of reach");
      for (let t = 0; t < times; t++) {
        if (!has(r.needs)) throw new Error("missing ingredient");
        for (const [n, c] of Object.entries(r.needs)) inv.set(n, inv.get(n)! - c);
        inv.set(r.out, (inv.get(r.out) ?? 0) + r.yields);
      }
    },
    async equip(item: { name: string }) {
      held = item.name;
      opts.onEquip?.(item.name);
    },
    async placeBlock(ref: FakeBlock, face: Vec3) {
      log.push(`place:${held}`);
      if (opts.placeThrows === true || opts.placeThrows === held) throw new Error("blockUpdate timeout");
      if (!held || !inv.get(held)) throw new Error("nothing held");
      inv.set(held, inv.get(held)! - 1);
      put(held, ref.position.plus(face));
      opts.onPlace?.(held);
      if (opts.placeThrowsAfterPlacing === held) throw new Error("blockUpdate timeout after placing");
    },
  };
  return { bot: bot as unknown as Bot, inv, world, log, raw: bot };
}

const live = () => new AbortController().signal;

function walker(raw: { entity: { position: Vec3 } }, reachable: boolean) {
  const calls: Vec3[] = [];
  const walk: WalkNear = async (pos) => {
    calls.push(pos);
    if (!reachable) throw new Error("No path to the goal!");
    raw.entity.position = new Vec3(pos.x + 1.5, pos.y, pos.z + 0.5);
  };
  return { walk, calls };
}

const blocksNamed = (world: Map<string, FakeBlock>, name: string) =>
  [...world.values()].filter((b) => b.name === name).length;

test("existing table out of reach: walks to it and crafts there, no new table", async () => {
  const f = fakeBot({ inventory: { cobblestone: 8, oak_planks: 4 }, tableAt: new Vec3(20, 64, 0) });
  const w = walker(f.raw, true);
  const furnace = await placeFurnaceNearBot(f.bot, { mcData, signal: live(), walk: w.walk });
  assert.ok("position" in furnace, JSON.stringify(furnace));
  assert.equal(w.calls.length, 1);
  assert.deepEqual(f.log, ["craft:furnace", "place:furnace"]);
  assert.equal(blocksNamed(f.world, "crafting_table"), 1, "the existing table is reused");
  assert.equal(f.inv.get("oak_planks"), 4, "planks untouched");
  assert.equal(f.inv.get("cobblestone"), 0);
});

test("existing table already in reach: no walk", async () => {
  const f = fakeBot({ inventory: { cobblestone: 8 }, tableAt: new Vec3(2, 64, 0) });
  const w = walker(f.raw, true);
  const table = await ensureReachableCraftingTable(f.bot, mcData, live(), { walk: w.walk });
  assert.ok("position" in table);
  assert.equal(w.calls.length, 0);
});

test("held table: placed beside the bot, then the furnace is crafted at it", async () => {
  const f = fakeBot({ inventory: { cobblestone: 9, crafting_table: 1 } });
  const furnace = await placeFurnaceNearBot(f.bot, { mcData, signal: live(), walk: walker(f.raw, true).walk });
  assert.ok("position" in furnace, JSON.stringify(furnace));
  assert.deepEqual(f.log, ["place:crafting_table", "craft:furnace", "place:furnace"]);
  assert.equal(f.inv.get("crafting_table"), 0);
  assert.equal(f.inv.get("cobblestone"), 1);
});

test("unreachable existing table falls back to placing a held one", async () => {
  const f = fakeBot({ inventory: { cobblestone: 8, crafting_table: 1 }, tableAt: new Vec3(20, 64, 0) });
  const w = walker(f.raw, false);
  const furnace = await placeFurnaceNearBot(f.bot, { mcData, signal: live(), walk: w.walk });
  assert.ok("position" in furnace, JSON.stringify(furnace));
  assert.equal(w.calls.length, 1);
  assert.equal(blocksNamed(f.world, "crafting_table"), 2);
});

test("craftable from planks: crafts a table, places it, crafts and places the furnace", async () => {
  const f = fakeBot({ inventory: { cobblestone: 8, oak_planks: 4, coal: 3 } });
  const furnace = await placeFurnaceNearBot(f.bot, { mcData, signal: live(), walk: walker(f.raw, true).walk });
  assert.ok("position" in furnace, JSON.stringify(furnace));
  assert.deepEqual(f.log, ["craft:crafting_table", "place:crafting_table", "craft:furnace", "place:furnace"]);
  assert.equal(blocksNamed(f.world, "furnace"), 1);
});

test("craftable from a log: makes planks first", async () => {
  const f = fakeBot({ inventory: { cobblestone: 8, oak_log: 2 } });
  const furnace = await placeFurnaceNearBot(f.bot, {
    mcData,
    signal: live(),
    walk: walker(f.raw, true).walk,
    woodIsOnlyFuel: true,
  });
  assert.ok("position" in furnace, JSON.stringify(furnace));
  assert.deepEqual(f.log.slice(0, 2), ["craft:oak_planks", "craft:crafting_table"]);
  assert.equal(f.inv.get("oak_log"), 1, "one log left to burn");
});

test("missing materials: names the wood shortfall and spends nothing", async () => {
  const f = fakeBot({ inventory: { cobblestone: 8, oak_planks: 2 } });
  const r = await placeFurnaceNearBot(f.bot, { mcData, signal: live(), walk: walker(f.raw, true).walk });
  assert.ok(!("position" in r));
  assert.match(r.message, /8 cobblestone/);
  assert.match(r.message, /only 2 planks and 0 logs/);
  assert.match(r.message, /needs 4 planks/);
  assert.deepEqual(f.log, []);
  assert.equal(f.inv.get("cobblestone"), 8);
});

test("the table will not eat the only fuel", async () => {
  const f = fakeBot({ inventory: { cobblestone: 8, oak_planks: 4 } });
  const r = await placeFurnaceNearBot(f.bot, {
    mcData,
    signal: live(),
    walk: walker(f.raw, true).walk,
    woodIsOnlyFuel: true,
  });
  assert.ok(!("position" in r));
  assert.match(r.message, /only fuel/);
  assert.equal(f.inv.get("oak_planks"), 4);
});

test("cobblestone short is still reported before any table work", async () => {
  const f = fakeBot({ inventory: { cobblestone: 7, crafting_table: 1 } });
  const r = await placeFurnaceNearBot(f.bot, { mcData, signal: live(), walk: walker(f.raw, true).walk });
  assert.ok(!("position" in r));
  assert.match(r.message, /need 8 cobblestone/);
  assert.deepEqual(f.log, []);
});

test("failed table placement: says so and keeps the table item", async () => {
  const f = fakeBot({ inventory: { cobblestone: 8, crafting_table: 1 }, placeThrows: true });
  const r = await placeFurnaceNearBot(f.bot, { mcData, signal: live(), walk: walker(f.raw, true).walk });
  assert.ok(!("position" in r));
  assert.match(r.message, /could not place it/);
  assert.match(r.message, /blockUpdate timeout/);
  assert.equal(f.inv.get("crafting_table"), 1);
  assert.equal(f.inv.get("cobblestone"), 8);
});

test("failed table craft: carries the craft error", async () => {
  const f = fakeBot({ inventory: { cobblestone: 8, oak_planks: 4, coal: 1 }, craftThrows: "crafting_table" });
  const r = await placeFurnaceNearBot(f.bot, { mcData, signal: live(), walk: walker(f.raw, true).walk });
  assert.ok(!("position" in r));
  assert.match(r.message, /crafting a crafting_table failed: server rejected crafting_table/);
});

test("failed furnace craft at a good table: carries the craft error", async () => {
  const f = fakeBot({ inventory: { cobblestone: 8 }, tableAt: new Vec3(2, 64, 0), craftThrows: "furnace" });
  const r = await placeFurnaceNearBot(f.bot, { mcData, signal: live(), walk: walker(f.raw, true).walk });
  assert.ok(!("position" in r));
  assert.match(r.message, /Crafting a furnace at the table at 2,64,0 failed: server rejected furnace/);
});

test("a furnace already in the pack needs no cobblestone or table", async () => {
  const f = fakeBot({ inventory: { furnace: 1 } });
  const r = await placeFurnaceNearBot(f.bot, { mcData, signal: live(), walk: walker(f.raw, true).walk });
  assert.ok("position" in r, JSON.stringify(r));
  assert.deepEqual(f.log, ["place:furnace"]);
});

test("cancellation stops before crafting anything", async () => {
  const f = fakeBot({ inventory: { cobblestone: 8, oak_planks: 8 } });
  const ac = new AbortController();
  ac.abort();
  const r = await placeFurnaceNearBot(f.bot, { mcData, signal: ac.signal, walk: walker(f.raw, true).walk });
  assert.ok(!("position" in r));
  assert.match(r.message, /cancelled/);
  assert.deepEqual(f.log, []);
});

test("cancellation while equipping the table: nothing is placed or crafted", async () => {
  const ac = new AbortController();
  const f = fakeBot({
    inventory: { cobblestone: 8, crafting_table: 1 },
    onEquip: (n) => n === "crafting_table" && ac.abort(),
  });
  const r = await placeFurnaceNearBot(f.bot, { mcData, signal: ac.signal, walk: walker(f.raw, true).walk });
  assert.ok(!("position" in r));
  assert.match(r.message, /cancelled/);
  assert.deepEqual(f.log, []);
  assert.equal(f.inv.get("crafting_table"), 1);
  assert.equal(f.inv.get("cobblestone"), 8);
});

test("cancellation during table placement: the furnace is never crafted or placed", async () => {
  const ac = new AbortController();
  const f = fakeBot({
    inventory: { cobblestone: 8, crafting_table: 1 },
    onPlace: (n) => n === "crafting_table" && ac.abort(),
  });
  const r = await placeFurnaceNearBot(f.bot, { mcData, signal: ac.signal, walk: walker(f.raw, true).walk });
  assert.ok(!("position" in r));
  assert.match(r.message, /cancelled/);
  assert.deepEqual(f.log, ["place:crafting_table"]);
  assert.equal(f.inv.get("cobblestone"), 8);
  assert.equal(blocksNamed(f.world, "furnace"), 0);
});

test("cancellation while equipping the furnace: it is not placed", async () => {
  const ac = new AbortController();
  const f = fakeBot({ inventory: { furnace: 1 }, onEquip: (n) => n === "furnace" && ac.abort() });
  const r = await placeFurnaceNearBot(f.bot, { mcData, signal: ac.signal, walk: walker(f.raw, true).walk });
  assert.ok(!("position" in r));
  assert.match(r.message, /cancelled/);
  assert.deepEqual(f.log, []);
  assert.equal(f.inv.get("furnace"), 1);
});

test("an unrelated furnace nearby does not turn a failed placement into success", async () => {
  const f = fakeBot({ inventory: { furnace: 1 }, furnacesAt: [new Vec3(1, 64, 0)], placeThrows: "furnace" });
  const r = await placeFurnaceNearBot(f.bot, { mcData, signal: live(), walk: walker(f.raw, true).walk });
  assert.ok(!("position" in r), "must not return the pre-existing furnace");
  assert.match(r.message, /Couldn't place furnace: 3 placement attempt\(s\).*blockUpdate timeout/);
  assert.equal(f.inv.get("furnace"), 1);
});

test("placeBlock throwing after the furnace landed returns the new furnace, not a nearer old one", async () => {
  // The old furnace at (1,64,0) is nearer the bot than the new one, so a
  // findBlock afterwards would have picked it.
  const f = fakeBot({
    inventory: { furnace: 1 },
    furnacesAt: [new Vec3(1, 64, 0)],
    placeThrowsAfterPlacing: "furnace",
  });
  const r = await placeFurnaceNearBot(f.bot, { mcData, signal: live(), walk: walker(f.raw, true).walk });
  assert.ok("position" in r, JSON.stringify(r));
  assert.deepEqual([r.position.x, r.position.y, r.position.z], [-1, 64, 0]);
  assert.equal(f.inv.get("furnace"), 0);
});

test("cancellation during the walk to a table stops there", async () => {
  const f = fakeBot({ inventory: { cobblestone: 8, oak_planks: 8 }, tableAt: new Vec3(20, 64, 0) });
  const ac = new AbortController();
  const walk: WalkNear = async () => {
    ac.abort();
  };
  const r = await placeFurnaceNearBot(f.bot, { mcData, signal: ac.signal, walk });
  assert.ok(!("position" in r));
  assert.match(r.message, /cancelled/);
  assert.deepEqual(f.log, []);
});
