// src/skills/stash.ts
// Shared stash management — deposit/withdraw from categorised chests.

import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { snapshotChest } from "./stash-ledger.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { safeGoto } from "../bot/actions.js";

/** Stash row categories and their item patterns. Order matches physical chest rows. */
const STASH_ROWS: { category: string; patterns: string[] }[] = [
  {
    category: "building",
    patterns: [
      "log",
      "planks",
      "cobblestone",
      "stone",
      "deepslate",
      "glass",
      "sand",
      "sandstone",
      "brick",
      "terracotta",
      "concrete",
      "gravel",
      "dirt",
    ],
  },
  {
    category: "metals",
    patterns: [
      "raw_iron",
      "iron_ingot",
      "iron_nugget",
      "raw_copper",
      "copper_ingot",
      "raw_gold",
      "gold_ingot",
      "gold_nugget",
      "coal",
      "diamond",
      "emerald",
      "lapis",
      "redstone",
      "quartz",
      "netherite",
      "amethyst",
    ],
  },
  {
    category: "food",
    patterns: [
      "wheat",
      "seed",
      "bread",
      "carrot",
      "potato",
      "beetroot",
      "melon",
      "pumpkin",
      "apple",
      "porkchop",
      "beef",
      "chicken",
      "mutton",
      "cod",
      "salmon",
      "rabbit",
      "stew",
      "cookie",
      "cake",
      "pie",
      "sugar",
      "egg",
      "cocoa",
      "mushroom",
      "kelp",
      "sweet_berries",
    ],
  },
  {
    category: "tools",
    patterns: [
      "sword",
      "pickaxe",
      "axe",
      "shovel",
      "hoe",
      "bow",
      "crossbow",
      "arrow",
      "shield",
      "helmet",
      "chestplate",
      "leggings",
      "boots",
      "fishing_rod",
      "shears",
      "flint_and_steel",
      "compass",
      "clock",
      "spyglass",
      "trident",
    ],
  },
];

/** Determine which stash category an item belongs to. Returns "overflow" if no match. */
export function categorizeItem(itemName: string): string {
  for (const row of STASH_ROWS) {
    if (row.patterns.some((p) => itemName.includes(p))) {
      return row.category;
    }
  }
  return "overflow";
}

/** Get the chest offset for a category (row index along X axis, 2 blocks per row for double chests). */
export function getRowOffset(category: string): number {
  const idx = STASH_ROWS.findIndex((r) => r.category === category);
  return idx >= 0 ? idx * 2 : STASH_ROWS.length * 2; // overflow goes after last row
}

/** Check if an item should be kept based on the bot's keepItems config. */
export function shouldKeep(
  itemName: string,
  keepItems: { name: string; minCount: number }[],
  currentCounts: Map<string, number>,
): boolean {
  // ALWAYS keep valuable gear. Bots crafted iron tools (12 in one run) then
  // deposited them as "surplus" and re-ground iron forever, never advancing.
  // A bot should never give up its iron/diamond/netherite tools or armor.
  const GEAR = ["_pickaxe", "_axe", "_sword", "_shovel", "_hoe", "_helmet", "_chestplate", "_leggings", "_boots"];
  if (
    (itemName.startsWith("iron_") || itemName.startsWith("diamond_") || itemName.startsWith("netherite_")) &&
    GEAR.some((g) => itemName.includes(g))
  ) {
    return true;
  }
  if (itemName === "shield") return true;

  // Keep precious crafting materials in inventory. Bots deposited every iron
  // ingot the instant they smelted it (314 deposits/run, empty inventories), so
  // they never accumulated the 3+ ingots needed in-hand to craft an iron tool.
  // Hold onto these so the smelter can actually craft — surplus is fine, the
  // bots' inventories are nearly empty anyway.
  const KEEP_MATERIALS = ["raw_iron", "iron_ingot", "raw_gold", "gold_ingot", "diamond"];
  if (KEEP_MATERIALS.includes(itemName)) return true;

  // Keep wheat + seeds in inventory. The farm harvests only ~2 wheat per pass
  // and bread needs 3 — but bots deposited each harvest instantly, so wheat
  // never reached 3 and bread never baked ('Not enough wheat' x8/run). Holding
  // wheat lets small harvests accumulate across passes until bread can bake;
  // holding seeds keeps the bot able to replant.
  if (itemName === "wheat" || itemName === "wheat_seeds") return true;

  // Keep a PERSONAL FOOD BUFFER. Bots deposited every scrap of food the instant
  // they got it (314 deposits/run) and then starved between production cycles —
  // a starving worker (esp. the miner) burns all its turns failing to eat
  // instead of working. Hold up to KEEP_FOOD food stacks; surplus still goes to
  // the stash for the team.
  const FOOD = new Set([
    "bread",
    "cooked_beef",
    "cooked_porkchop",
    "cooked_mutton",
    "cooked_chicken",
    "cooked_cod",
    "cooked_salmon",
    "cooked_rabbit",
    "baked_potato",
    "apple",
    "golden_apple",
    "carrot",
    "melon_slice",
    "mushroom_stew",
    "rabbit_stew",
    "beetroot_soup",
    "raw_beef",
    "raw_porkchop",
    "raw_mutton",
    "raw_chicken",
    "raw_cod",
    "raw_salmon",
  ]);
  if (FOOD.has(itemName)) {
    const KEEP_FOOD = 6;
    const kept = currentCounts.get("__food") ?? 0;
    if (kept < KEEP_FOOD) {
      currentCounts.set("__food", kept + 1);
      return true;
    }
    return false;
  }

  for (const keep of keepItems) {
    if (itemName.includes(keep.name)) {
      const kept = currentCounts.get(keep.name) ?? 0;
      if (kept < keep.minCount) {
        currentCounts.set(keep.name, kept + 1);
        return true;
      }
    }
  }
  return false;
}

export { STASH_ROWS };

/**
 * Walk to stash, find the correct category chest for each item, deposit.
 * Keeps items on the bot's keepItems list.
 */
export async function depositStash(
  bot: Bot,
  stashPos: { x: number; y: number; z: number },
  keepItems: { name: string; minCount: number }[],
): Promise<string> {
  // Walk to stash area
  await safeGoto(bot, new goals.GoalNear(stashPos.x, stashPos.y, stashPos.z, 3), 30000);

  const itemsToDeposit = bot.inventory.items();
  if (itemsToDeposit.length === 0) return "Nothing to deposit — inventory is empty.";

  // Track kept items to respect minCount
  const keptCounts = new Map<string, number>();
  let deposited = 0;
  let noChest = 0;

  // Group items by category
  const byCategory = new Map<string, typeof itemsToDeposit>();
  for (const item of itemsToDeposit) {
    if (shouldKeep(item.name, keepItems, keptCounts)) continue;
    const cat = categorizeItem(item.name);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(item);
  }

  // For each category, find nearest chest at the right row offset and deposit
  for (const [category, items] of byCategory) {
    const rowOffset = getRowOffset(category);
    const chestPos = new Vec3(stashPos.x + rowOffset, stashPos.y, stashPos.z);

    // Find the nearest chest block near the expected position
    const chest = bot.findBlock({
      matching: (b) => b.name === "chest" || b.name === "trapped_chest",
      maxDistance: 6,
      point: chestPos,
    });

    if (!chest) {
      // No chest at this row — try any nearby chest as fallback
      const fallback = bot.findBlock({
        matching: (b) => b.name === "chest" || b.name === "trapped_chest",
        maxDistance: 8,
      });
      if (!fallback) {
        noChest += items.length;
        continue;
      }
      // Use fallback chest
      try {
        const container = await bot.openContainer(fallback);
        for (const item of items) {
          try {
            await container.deposit(item.type, null, item.count);
            deposited += item.count;
          } catch {
            // Chest might be full
          }
        }
        snapshotChest(fallback.position, container.containerItems(), container.inventoryStart);
        container.close();
      } catch {
        noChest += items.length;
      }
      continue;
    }

    try {
      await safeGoto(bot, new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2), 10000);
      const container = await bot.openContainer(chest);
      for (const item of items) {
        try {
          await container.deposit(item.type, null, item.count);
          deposited += item.count;
        } catch {
          // Chest full — this will trigger expansion request
        }
      }
      snapshotChest(chest.position, container.containerItems(), container.inventoryStart);
      container.close();
    } catch {
      noChest += items.length;
    }
  }

  if (noChest > 0 && deposited === 0) {
    return "All stash chests are full! Need more chests.";
  }
  if (noChest > 0) {
    return `Deposited ${deposited} items. ${noChest} items couldn't fit — stash needs expansion.`;
  }
  return `Deposited ${deposited} items at the stash.`;
}

/**
 * Walk to stash, find item in categorized chests, withdraw specified count.
 */
export async function withdrawStash(
  bot: Bot,
  stashPos: { x: number; y: number; z: number },
  itemName: string,
  count: number,
): Promise<string> {
  await safeGoto(bot, new goals.GoalNear(stashPos.x, stashPos.y, stashPos.z, 3), 30000);

  const category = categorizeItem(itemName);
  const rowOffset = getRowOffset(category);
  const chestPos = new Vec3(stashPos.x + rowOffset, stashPos.y, stashPos.z);

  // Try category chest first, then scan all nearby chests
  const chestsToTry: any[] = [];

  const categoryChest = bot.findBlock({
    matching: (b) => b.name === "chest" || b.name === "trapped_chest",
    maxDistance: 6,
    point: chestPos,
  });
  if (categoryChest) chestsToTry.push(categoryChest);

  // Also check all nearby chests in case the item was overflow-deposited
  const allChests = bot.findBlocks({
    matching: (b) => b.name === "chest" || b.name === "trapped_chest",
    maxDistance: 10,
    count: 10,
  });
  for (const pos of allChests) {
    const block = bot.blockAt(pos);
    if (block && !chestsToTry.includes(block)) chestsToTry.push(block);
  }

  // Count what we actually have BEFORE, so we can report the real delta —
  // container.withdraw can resolve without delivering (Flora "withdrew" 48
  // planks across 6 calls and ended with 0), which made her loop forever.
  const countItem = () =>
    bot.inventory
      .items()
      .filter((i) => i.name.includes(itemName))
      .reduce((s, i) => s + i.count, 0);
  const before = countItem();

  let withdrawn = 0;
  const needed = count;

  for (const chest of chestsToTry) {
    if (withdrawn >= needed) break;
    try {
      await safeGoto(bot, new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2), 10000);
      const container = await bot.openContainer(chest);

      for (const slot of container.containerItems()) {
        if (withdrawn >= needed) break;
        if (slot.name.includes(itemName)) {
          const take = Math.min(slot.count, needed - withdrawn);
          try {
            await container.withdraw(slot.type, null, take);
            withdrawn += take;
          } catch {
            /* slot empty or race */
          }
        }
      }
      snapshotChest(chest.position, container.containerItems(), container.inventoryStart);
      container.close();
    } catch {
      /* can't open chest */
    }
  }

  // Report the VERIFIED delta, not what container.withdraw claimed.
  const gained = countItem() - before;
  if (gained <= 0 && withdrawn > 0) {
    return `Tried to withdraw ${itemName} but it never reached your inventory (stash transfer failed) — the stash may be empty of it. Gather it yourself or check a different item.`;
  }
  if (gained === 0) return `No ${itemName} in the stash. Gather it yourself instead.`;
  if (gained < needed) return `Withdrew ${gained}x ${itemName} from stash (wanted ${needed} — that's all there was).`;
  return `Withdrew ${gained}x ${itemName} from stash.`;
}
