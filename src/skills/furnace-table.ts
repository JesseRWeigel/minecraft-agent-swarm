import type { Block } from "prismarine-block";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

/**
 * The physical prerequisites for standing a furnace beside the bot.
 *
 * A furnace is a 3x3 recipe, so it needs a crafting table in interaction
 * reach. The old smelt_ores path looked for a table within 32 blocks, and when
 * none was there asked recipesFor(furnace, ..., null) — which never offers a
 * table-only recipe — so it crafted nothing and failed with "Need 8
 * cobblestone and a crafting table" while holding planks or even a table.
 * When a table WAS found but the walk failed, the craft from out of reach
 * threw into an empty catch and produced the same message.
 *
 * Order here: a reachable existing table, else place a held table, else craft
 * one from planks (or a log turned into planks) and place it. Nothing is
 * assumed from recipe availability; every step is checked against the world
 * or the inventory afterwards.
 */

/** Walk to within `range` of `pos`, bounded by `timeoutMs`. May throw. */
export type WalkNear = (pos: Vec3, range: number, timeoutMs: number) => Promise<void>;

type McData = { itemsByName: Record<string, { id: number } | undefined> };

export type Failure = { success: false; message: string };

/** Interaction reach used to decide a table or furnace can be worked from here. */
export const CRAFT_REACH = 4.5;
const TABLE_SEARCH = 32;
const WALK_MS = 20000;
const TABLE_PLANKS = 4;

const CANCELLED: Failure = { success: false, message: "smelt_ores cancelled while preparing a furnace." };

function count(bot: Bot, pred: (name: string) => boolean): number {
  return bot.inventory
    .items()
    .filter((i) => pred(i.name))
    .reduce((s, i) => s + i.count, 0);
}

const isPlank = (n: string) => n.endsWith("_planks");
const isLog = (n: string) => n.endsWith("_log") || n.endsWith("_stem");
const fmt = (p: Vec3) => `${p.x},${p.y},${p.z}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function inReach(bot: Bot, block: Block): boolean {
  return bot.entity.position.distanceTo(block.position) <= CRAFT_REACH;
}

const HORIZONTAL = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

function isOpen(block: Block | null): boolean {
  return !!block && (block.name === "air" || block.name === "cave_air");
}

function isSolid(block: Block | null): boolean {
  if (!block) return false;
  // Real prismarine blocks carry boundingBox; "empty" covers air, water,
  // grass and the like, none of which can hold a placed block on top.
  if (block.boundingBox !== undefined) return block.boundingBox === "block";
  return block.name !== "air";
}

/** Place the held `crafting_table` item on a free neighbouring cell. */
async function placeHeldTable(bot: Bot, signal: AbortSignal): Promise<Block | Failure> {
  const feet = bot.entity.position.floored();
  let lastError = "";
  let tried = 0;
  for (const [dx, dz] of HORIZONTAL) {
    if (signal.aborted) return CANCELLED;
    const target = new Vec3(feet.x + dx, feet.y, feet.z + dz);
    const ground = bot.blockAt(target.offset(0, -1, 0));
    if (!isSolid(ground) || !isOpen(bot.blockAt(target))) continue;
    const item = bot.inventory.items().find((i) => i.name === "crafting_table");
    if (!item) break;
    tried++;
    try {
      await bot.equip(item, "hand");
      if (signal.aborted) return CANCELLED;
      await bot.placeBlock(ground!, new Vec3(0, 1, 0));
    } catch (e) {
      // placeBlock can time out on the block update even when the block went
      // down, so the world decides below, not the exception.
      lastError = errText(e);
    }
    if (signal.aborted) return CANCELLED;
    const now = bot.blockAt(target);
    if (now && now.name === "crafting_table") {
      console.log(`[Skill] ${bot.username}: placed a crafting table at ${fmt(target)} for the furnace`);
      return now;
    }
  }
  const why =
    tried === 0
      ? `no free cell with solid ground beside ${fmt(feet)}`
      : `${tried} placement attempt(s) beside ${fmt(feet)} failed${lastError ? ` (${lastError})` : ""}`;
  return { success: false, message: `Holding a crafting_table but could not place it: ${why}.` };
}

export interface TableOptions {
  /** True when wood is the only fuel aboard, so the table must not eat all of it. */
  woodIsOnlyFuel?: boolean;
  walk: WalkNear;
}

/**
 * Get a crafting table the bot can craft at right now. Returns the table
 * block, or a failure naming exactly what was missing or what went wrong.
 */
export async function ensureReachableCraftingTable(
  bot: Bot,
  mcData: McData,
  signal: AbortSignal,
  opts: TableOptions,
): Promise<Block | Failure> {
  if (signal.aborted) return CANCELLED;

  // 1. An existing table, if the bot can actually get to it.
  let unreachable = "";
  const existing = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: TABLE_SEARCH });
  if (existing) {
    if (!inReach(bot, existing)) {
      try {
        await opts.walk(existing.position, 2, WALK_MS);
      } catch {
        /* the distance check decides */
      }
      if (signal.aborted) return CANCELLED;
    }
    if (inReach(bot, existing)) return existing;
    unreachable = `the crafting table at ${fmt(existing.position)} stayed ${bot.entity.position
      .distanceTo(existing.position)
      .toFixed(0)} blocks away`;
    console.log(`[Skill] ${bot.username}: ${unreachable}; making one here instead`);
  }
  const prefix = unreachable ? `No reachable crafting table (${unreachable})` : "No crafting table nearby";

  // 2. Craft a table item if none is held.
  if (!bot.inventory.items().some((i) => i.name === "crafting_table")) {
    const planks = count(bot, isPlank);
    const logs = count(bot, isLog);
    if (planks + logs * 4 < TABLE_PLANKS) {
      return {
        success: false,
        message: `${prefix}, and only ${planks} planks and ${logs} logs aboard; a crafting table needs ${TABLE_PLANKS} planks (1 log). Gather wood first.`,
      };
    }
    if (opts.woodIsOnlyFuel && planks + logs * 4 - TABLE_PLANKS < 1) {
      return {
        success: false,
        message: `${prefix}, and the ${planks} planks/${logs} logs aboard are the only fuel; a table would burn all of it. Bring coal or more wood.`,
      };
    }

    if (planks < TABLE_PLANKS) {
      const log = bot.inventory.items().find((i) => isLog(i.name));
      const plankName = log?.name.replace(/^stripped_/, "").replace(/_(log|stem)$/, "_planks");
      const plankDef = plankName ? mcData.itemsByName[plankName] : undefined;
      const plankRecipe = plankDef ? bot.recipesFor(plankDef.id, null, 1, null)[0] : undefined;
      if (!plankRecipe) {
        return { success: false, message: `${prefix}, and no plank recipe matched the ${log?.name ?? "log"} aboard.` };
      }
      try {
        await bot.craft(plankRecipe, 1, undefined);
      } catch (e) {
        return { success: false, message: `${prefix}, and crafting ${plankName} failed: ${errText(e)}` };
      }
      if (signal.aborted) return CANCELLED;
      if (count(bot, isPlank) < TABLE_PLANKS) {
        return {
          success: false,
          message: `${prefix}, and crafting ${plankName} left only ${count(bot, isPlank)} planks.`,
        };
      }
    }

    const tableDef = mcData.itemsByName["crafting_table"];
    const tableRecipe = tableDef ? bot.recipesFor(tableDef.id, null, 1, null)[0] : undefined;
    if (!tableRecipe) {
      return {
        success: false,
        message: `${prefix}, and no crafting_table recipe matched the ${count(bot, isPlank)} planks aboard.`,
      };
    }
    try {
      await bot.craft(tableRecipe, 1, undefined);
    } catch (e) {
      return { success: false, message: `${prefix}, and crafting a crafting_table failed: ${errText(e)}` };
    }
    if (signal.aborted) return CANCELLED;
    if (!bot.inventory.items().some((i) => i.name === "crafting_table")) {
      return { success: false, message: `${prefix}, and the crafting_table craft produced no table.` };
    }
  }

  // 3. Place it.
  const placed = await placeHeldTable(bot, signal);
  if (!("position" in placed)) {
    return placed === CANCELLED ? placed : { success: false, message: `${prefix}. ${placed.message}` };
  }
  return placed;
}

export interface FurnaceOptions {
  mcData: McData;
  signal: AbortSignal;
  walk: WalkNear;
  woodIsOnlyFuel?: boolean;
  onPhase?: () => void;
}

/**
 * Craft a furnace from pack cobblestone and stand it beside the bot. Returns
 * the placed furnace, or the failure to hand back.
 */
export async function placeFurnaceNearBot(bot: Bot, opts: FurnaceOptions): Promise<Block | Failure> {
  const { mcData, signal } = opts;
  if (signal.aborted) return CANCELLED;

  // A furnace already in the pack needs no cobblestone and no table.
  if (!bot.inventory.items().some((i) => i.name === "furnace")) {
    const cobble = count(bot, (n) => n === "cobblestone");
    if (cobble < 8) {
      return {
        success: false,
        message: "No furnace nearby and need 8 cobblestone to craft one. Mine some stone first!",
      };
    }
    opts.onPhase?.();

    const table = await ensureReachableCraftingTable(bot, mcData, signal, {
      walk: opts.walk,
      woodIsOnlyFuel: opts.woodIsOnlyFuel,
    });
    if (!("position" in table)) {
      return table === CANCELLED
        ? table
        : {
            success: false,
            message: `Have ${cobble} cobblestone for a furnace but no table to craft it. ${table.message}`,
          };
    }
    // The table may have been walked to or placed; a cancel during either
    // must not go on to spend the cobblestone.
    if (signal.aborted) return CANCELLED;

    const furnaceDef = mcData.itemsByName["furnace"];
    const recipe = furnaceDef ? bot.recipesFor(furnaceDef.id, null, 1, table)[0] : undefined;
    if (!recipe) {
      return {
        success: false,
        message: `Have ${cobble} cobblestone and a crafting table at ${fmt(table.position)}, but no furnace recipe matched.`,
      };
    }
    try {
      await bot.craft(recipe, 1, table);
    } catch (e) {
      return {
        success: false,
        message: `Crafting a furnace at the table at ${fmt(table.position)} failed: ${errText(e)}`,
      };
    }
    if (signal.aborted) return CANCELLED;
  }

  const fItem = bot.inventory.items().find((i) => i.name === "furnace");
  if (!fItem) {
    return { success: false, message: "The furnace craft finished but no furnace is in the pack." };
  }

  await bot.equip(fItem, "hand");
  if (signal.aborted) return CANCELLED;

  // Judge each attempt by the exact cell it targeted. A findBlock("furnace")
  // afterwards could return some other furnace within 8 blocks — one the bot
  // may not be able to reach — and call a failed placement a success.
  const pos = bot.entity.position.floored();
  let lastError = "";
  let tried = 0;
  for (const [dx, dz] of HORIZONTAL) {
    if (signal.aborted) return CANCELLED;
    const targetPos = new Vec3(pos.x + dx, pos.y, pos.z + dz);
    const below = bot.blockAt(targetPos.offset(0, -1, 0));
    const target = bot.blockAt(targetPos);
    if (!below || below.name === "air" || !target || target.name !== "air") continue;
    tried++;
    try {
      await bot.placeBlock(below, new Vec3(0, 1, 0));
    } catch (e) {
      // As with the table: the block update can time out after the block
      // went down, so the world decides.
      lastError = errText(e);
    }
    if (signal.aborted) return CANCELLED;
    const now = bot.blockAt(targetPos);
    if (now && (now.name === "furnace" || now.name === "lit_furnace")) {
      console.log(`[Skill] Placed furnace at ${fmt(targetPos)}`);
      return now;
    }
  }

  const why =
    tried === 0
      ? `no free cell with solid ground beside ${fmt(pos)}`
      : `${tried} placement attempt(s) beside ${fmt(pos)} failed${lastError ? ` (${lastError})` : ""}`;
  return { success: false, message: `Couldn't place furnace: ${why}. Try in a flatter area.` };
}
