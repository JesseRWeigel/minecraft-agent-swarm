import type { Bot } from "mineflayer";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import mcDataLoader from "minecraft-data";

/** Crafting dependency tree: item → { inputs needed, yield per craft } */
const CRAFT_TREE: Record<string, { inputs: Record<string, number>; yields: number }> = {
  oak_planks: { inputs: { oak_log: 1 }, yields: 4 },
  spruce_planks: { inputs: { spruce_log: 1 }, yields: 4 },
  birch_planks: { inputs: { birch_log: 1 }, yields: 4 },
  stick: { inputs: { oak_planks: 2 }, yields: 4 },
  crafting_table: { inputs: { oak_planks: 4 }, yields: 1 },
  torch: { inputs: { stick: 1, coal: 1 }, yields: 4 },
  oak_door: { inputs: { oak_planks: 6 }, yields: 3 },
  oak_fence: { inputs: { oak_planks: 4, stick: 2 }, yields: 3 },
  wooden_pickaxe: { inputs: { oak_planks: 3, stick: 2 }, yields: 1 },
  wooden_axe: { inputs: { oak_planks: 3, stick: 2 }, yields: 1 },
  wooden_shovel: { inputs: { oak_planks: 1, stick: 2 }, yields: 1 },
  wooden_sword: { inputs: { oak_planks: 2, stick: 1 }, yields: 1 },
  stone_pickaxe: { inputs: { cobblestone: 3, stick: 2 }, yields: 1 },
  stone_axe: { inputs: { cobblestone: 3, stick: 2 }, yields: 1 },
  stone_sword: { inputs: { cobblestone: 2, stick: 1 }, yields: 1 },
  stone_shovel: { inputs: { cobblestone: 1, stick: 2 }, yields: 1 },
  furnace: { inputs: { cobblestone: 8 }, yields: 1 },
  chest: { inputs: { oak_planks: 8 }, yields: 1 },
};

/** Wood type constants — any log can become planks, all planks are interchangeable for building */
export const LOG_TYPES = [
  "oak_log",
  "spruce_log",
  "birch_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
  "cherry_log",
  "mangrove_log",
  "pale_oak_log", // MC 1.21.4 Pale Garden biome
] as const;

export const PLANK_TYPES = [
  "oak_planks",
  "spruce_planks",
  "birch_planks",
  "jungle_planks",
  "acacia_planks",
  "dark_oak_planks",
  "cherry_planks",
  "mangrove_planks",
  "pale_oak_planks", // MC 1.21.4 Pale Garden biome
] as const;

/** Count all logs (any type) in inventory */
export function countAllLogs(bot: Bot): number {
  return bot.inventory
    .items()
    .filter((i) => (LOG_TYPES as readonly string[]).includes(i.name))
    .reduce((sum, i) => sum + i.count, 0);
}

/** Count all planks (any type) in inventory */
export function countAllPlanks(bot: Bot): number {
  return bot.inventory
    .items()
    .filter((i) => (PLANK_TYPES as readonly string[]).includes(i.name))
    .reduce((sum, i) => sum + i.count, 0);
}

/** Block types that can be mined to obtain an item */
const MINE_SOURCES: Record<string, string[]> = {
  oak_log: ["oak_log"],
  spruce_log: ["spruce_log"],
  birch_log: ["birch_log"],
  jungle_log: ["jungle_log"],
  acacia_log: ["acacia_log"],
  dark_oak_log: ["dark_oak_log"],
  cherry_log: ["cherry_log"],
  mangrove_log: ["mangrove_log"],
  cobblestone: ["stone", "cobblestone"],
  coal: ["coal_ore", "deepslate_coal_ore"],
  sand: ["sand"],
  dirt: ["dirt"],
};

export interface GatherResult {
  success: boolean;
  message: string;
}

/** Count how many of an item the bot currently has. */
function countItem(bot: Bot, itemName: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === itemName)
    .reduce((sum, i) => sum + i.count, 0);
}

/** Navigation wrapper that respects AbortSignal. */
async function safeGotoWithSignal(bot: Bot, goal: any, signal: AbortSignal, timeoutMs = 15000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    let lastPos = bot.entity.position.clone();
    let stallTicks = 0;

    const onAbort = () => {
      cleanup();
      bot.pathfinder.stop();
      reject(new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const timeout = setTimeout(() => {
      cleanup();
      bot.pathfinder.stop();
      reject(new Error("Navigation timed out"));
    }, timeoutMs);

    const stallCheck = setInterval(() => {
      const moved = bot.entity.position.distanceTo(lastPos);
      if (moved < 0.3) {
        stallTicks++;
        if (stallTicks >= 5) {
          cleanup();
          bot.pathfinder.stop();
          reject(new Error("Stuck"));
        }
      } else {
        stallTicks = 0;
      }
      lastPos = bot.entity.position.clone();
    }, 1000);

    function cleanup() {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timeout);
      clearInterval(stallCheck);
    }

    bot.pathfinder
      .goto(goal)
      .then(() => {
        cleanup();
        resolve();
      })
      .catch((err: any) => {
        cleanup();
        reject(err);
      });
  });
}

/**
 * Gather all materials needed for a skill.
 *
 * 1. Compute deficit (needed minus inventory)
 * 2. For mineable items, go mine them
 * 3. For craftable items, resolve dependencies recursively, then craft
 */
export async function gatherMaterials(
  bot: Bot,
  needed: Record<string, number>,
  signal: AbortSignal,
  onProgress: (message: string, progressFraction: number) => void,
): Promise<GatherResult> {
  const totalNeeded = Object.values(needed).reduce((a, b) => a + b, 0);
  let gathered = 0;

  function deficit(item: string): number {
    return Math.max(0, (needed[item] || 0) - countItem(bot, item));
  }

  function setMoves() {
    const moves = new Movements(bot);
    moves.canDig = false;
    moves.allow1by1towers = false;
    moves.allowFreeMotion = false;
    moves.scafoldingBlocks = [];
    bot.pathfinder.setMovements(moves);
  }

  // --- Phase 1: Mine raw materials ---
  for (const [item, count] of Object.entries(needed)) {
    if (signal.aborted) return { success: false, message: "Gathering interrupted." };

    const mineTargets = MINE_SOURCES[item];
    if (!mineTargets) continue;

    const remaining = deficit(item);
    if (remaining <= 0) continue;

    onProgress(`Mining ${remaining}x ${item}...`, gathered / totalNeeded);

    for (let i = 0; i < remaining + 5 && deficit(item) > 0 && !signal.aborted; i++) {
      const block = bot.findBlock({
        matching: (b) => mineTargets.includes(b.name),
        maxDistance: 64,
      });
      if (!block) {
        return { success: false, message: `Can't find ${item} to mine nearby.` };
      }

      try {
        setMoves();
        await safeGotoWithSignal(
          bot,
          new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2),
          signal,
        );
        await bot.dig(block);
        gathered++;
        // Walk over the drop — digging alone leaves the item on the ground
        await new Promise((r) => setTimeout(r, 400));
        await collectNearbyDrops(bot, 6, 5000);
        onProgress(`Mined ${item} (${countItem(bot, item)}/${needed[item]})`, gathered / totalNeeded);
      } catch {
        // Failed to reach or mine, try next block
        continue;
      }
    }

    if (deficit(item) > 0) {
      return { success: false, message: `Could only get ${countItem(bot, item)}/${needed[item]} ${item}.` };
    }
  }

  // --- Phase 2: Craft items in dependency order ---
  // Build a crafting plan: resolve dependencies bottom-up
  const craftOrder = resolveCraftOrder(needed, bot);

  for (const { item, craftCount } of craftOrder) {
    if (signal.aborted) return { success: false, message: "Gathering interrupted." };
    if (countItem(bot, item) >= (needed[item] || 0)) continue;

    onProgress(`Crafting ${item}...`, gathered / totalNeeded);

    const ok = await craftItem(bot, item, craftCount, signal);
    if (!ok) {
      return { success: false, message: `Failed to craft ${item}. Missing materials or no crafting table.` };
    }
    gathered += craftCount;
    onProgress(`Crafted ${item}`, gathered / totalNeeded);
  }

  // Final check
  for (const [item, count] of Object.entries(needed)) {
    if (countItem(bot, item) < count) {
      return { success: false, message: `Still missing ${item}: have ${countItem(bot, item)}, need ${count}.` };
    }
  }

  return { success: true, message: "All materials gathered!" };
}

/** Determine crafting order with dependencies resolved bottom-up. */
function resolveCraftOrder(needed: Record<string, number>, bot: Bot): Array<{ item: string; craftCount: number }> {
  const order: Array<{ item: string; craftCount: number }> = [];
  const visited = new Set<string>();

  function resolve(item: string, count: number) {
    if (visited.has(item)) return;
    const recipe = CRAFT_TREE[item];
    if (!recipe) return; // Raw material, not craftable

    const have = countItem(bot, item);
    const deficit = Math.max(0, count - have);
    if (deficit <= 0) return;

    const craftTimes = Math.ceil(deficit / recipe.yields);

    // Resolve inputs first (deeper dependencies)
    for (const [input, inputPer] of Object.entries(recipe.inputs)) {
      resolve(input, inputPer * craftTimes);
    }

    visited.add(item);
    order.push({ item, craftCount: craftTimes });
  }

  for (const [item, count] of Object.entries(needed)) {
    resolve(item, count);
  }

  return order;
}

/** Craft an item, handling crafting table placement. */
async function craftItem(bot: Bot, itemName: string, count: number, signal: AbortSignal): Promise<boolean> {
  const mcData = mcDataLoader(bot.version);
  const mcItem = mcData.itemsByName[itemName];
  if (!mcItem) return false;

  // Find or place crafting table
  let table = bot.findBlock({
    matching: (b) => b.name === "crafting_table",
    maxDistance: 32,
  });

  // Try recipe with table first, fall back to hand crafting
  let recipe = table ? bot.recipesFor(mcItem.id, null, 1, table)[0] : null;

  if (!recipe) {
    recipe = bot.recipesFor(mcItem.id, null, 1, null)[0];
  }

  // If no recipe found with or without table, try placing a crafting table from inventory
  if (!recipe) {
    const tableItem = bot.inventory.items().find((i) => i.name === "crafting_table");
    if (tableItem) {
      await bot.equip(tableItem, "hand");
      const pos = bot.entity.position.floored();
      const below = bot.blockAt(pos.offset(1, -1, 0));
      if (below && below.name !== "air") {
        const aboveRef = bot.blockAt(pos.offset(1, 0, 0));
        if (aboveRef && aboveRef.name === "air") {
          try {
            const { Vec3 } = await import("vec3");
            await bot.placeBlock(below, new Vec3(0, 1, 0));
          } catch {
            /* placement failed */
          }
        }
      }
      table = bot.findBlock({
        matching: (b) => b.name === "crafting_table",
        maxDistance: 8,
      });
      if (table) {
        recipe = bot.recipesFor(mcItem.id, null, 1, table)[0];
      }
    }
  }

  if (!recipe) return false;

  // Navigate to table if needed
  if (table) {
    const moves = new Movements(bot);
    moves.canDig = false;
    bot.pathfinder.setMovements(moves);
    try {
      await safeGotoWithSignal(
        bot,
        new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2),
        signal,
      );
    } catch {
      return false;
    }
  }

  try {
    await bot.craft(recipe, count, table || undefined);
    return true;
  } catch {
    return false;
  }
}
