import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { LOG_TYPES } from "./materials.js";
import mcDataLoader from "minecraft-data";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { Vec3 } from "vec3";

/** Tool tiers from best to worst. */
const TIERS = [
  { name: "diamond", material: "diamond" },
  { name: "iron", material: "iron_ingot" },
  { name: "stone", material: "cobblestone" },
  { name: "wooden", material: "oak_planks" },
];

const TOOL_TYPES = ["pickaxe", "axe", "sword", "shovel"];
// Armor: bots were ALL fighting unarmored (combat was the top death cause —
// 12 of 21 deaths/run). craft_gear made tools but never armor, so the brain's
// auto-equip-armor timer had nothing to wear. Iron armor ~halves damage.
const ARMOR_TYPES = ["helmet", "chestplate", "leggings", "boots"];
const ARMOR_TIERS = ["diamond", "iron"]; // only metal armor is worth crafting

export const craftGearSkill: Skill = {
  name: "craft_gear",
  description:
    "Craft the best tools (pickaxe, axe, sword, shovel) AND armor (helmet, chestplate, leggings, boots) from available materials; pulls iron from the stash. The bot auto-equips crafted armor.",
  params: {},

  estimateMaterials(_bot, _params) {
    // This skill uses whatever is already in inventory — no gathering phase
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    const mcData = mcDataLoader(bot.version);
    const crafted: string[] = [];
    const total = TOOL_TYPES.length;
    let done = 0;

    // Pull iron ingots from the shared stash before crafting (the stash is the
    // team warehouse — use it). The smelter deposits ingots; whoever crafts
    // withdraws them. Without this, craft_gear only ever found enough materials
    // for stone/wood tools and never made iron, even though the team had smelted
    // plenty. Mirrors smelt_ores' stash withdrawal.
    const stashPos = params?.stashPos as { x: number; y: number; z: number } | undefined;
    if (stashPos && !signal.aborted) {
      const ironIngots = bot.inventory
        .items()
        .filter((i) => i.name === "iron_ingot")
        .reduce((s, i) => s + i.count, 0);
      // Tools need ~9 ingots, a full iron armor set needs 24 — withdraw enough
      // for both so the bot can armor up in one trip.
      if (ironIngots < 33) {
        const { withdrawStash } = await import("./stash.js");
        try {
          await withdrawStash(bot, stashPos, "iron_ingot", 33 - ironIngots);
        } catch {
          /* none in stash — craft whatever tier we can */
        }
      }
    }

    // WOOD SELF-SUPPLY (same pattern as build_farm's hoe step, which works):
    // craft_gear failed 79x in one run with "Missing: pickaxe... use
    // gather_wood" — the LLM never holds the gather->keep->craft sequence,
    // and gathered logs evaporate into other uses first. Withdraw logs from
    // the stash; failing that, chop a couple of nearby trees right here.
    const hasWood = () => bot.inventory.items().some((i) => i.name.endsWith("_log") || i.name.endsWith("_planks"));
    if (!signal.aborted && !hasWood()) {
      if (stashPos) {
        const { withdrawStash } = await import("./stash.js");
        try {
          await withdrawStash(bot, stashPos, "log", 8);
        } catch {
          /* none pooled */
        }
      }
      if (!hasWood()) {
        const { safeGoto, collectNearbyDrops } = await import("../bot/navigation.js");
        for (let t = 0; t < 2 && !signal.aborted && !hasWood(); t++) {
          let logBlock = bot.findBlock({ matching: (b) => b.name.endsWith("_log"), maxDistance: 64 });
          if (!logBlock) break;
          // Walk to the trunk BASE (canopy-branch lesson) and skip floaters.
          let below = bot.blockAt(logBlock.position.offset(0, -1, 0));
          while (below && below.name.endsWith("_log")) {
            logBlock = below;
            below = bot.blockAt(logBlock.position.offset(0, -1, 0));
          }
          if (!below || below.name === "air" || below.name === "water") continue;
          try {
            await safeGoto(
              bot,
              new goals.GoalNear(logBlock.position.x, logBlock.position.y, logBlock.position.z, 2),
              20000,
            );
            await Promise.race([
              bot.dig(logBlock),
              new Promise<void>((_, rej) =>
                setTimeout(() => {
                  try {
                    bot.stopDigging();
                  } catch {
                    /* not digging */
                  }
                  rej(new Error("dig timeout"));
                }, 12000),
              ),
            ]);
            await collectNearbyDrops(bot, 8, 6000);
          } catch {
            /* try the next tree */
          }
        }
      }
    }

    // INSTRUMENTATION (craft-gear debugging): entry material state, so the
    // next failure diagnosis reads evidence instead of guessing (5 previous
    // wood-chain fixes were each one layer deeper than the guess).
    {
      const cnt = (suffix: string) =>
        bot.inventory
          .items()
          .filter((i) => i.name.endsWith(suffix))
          .reduce((s, i) => s + i.count, 0);
      const tableNear = !!bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
      console.log(
        `[GearDebug] entry: logs=${cnt("_log")} planks=${cnt("_planks")} sticks=${cnt("stick")} cobble=${cnt("cobblestone")} ingots=${cnt("iron_ingot")} table=${tableNear}`,
      );
    }

    // ARMOR-FIRST for the chestplate (the single biggest protection). Iron is
    // scarce and tools were eating ALL of it (craft_gear made pickaxe+sword
    // every run, never reaching the armor step), so bots stayed unarmored.
    // Crafting the chestplate before tools routes the bot's handful of iron to
    // survival gear first; tools still get crafted after (and stone fallbacks
    // cover most tasks). The brain's auto-equip timer then wears it.
    if (!signal.aborted && !bot.inventory.items().some((i) => i.name === "iron_chestplate")) {
      await craftPiece(bot, mcData, "iron_chestplate", crafted);
    }

    // Ensure we have sticks (need at least 8 for a full set)
    await ensureSticks(bot, 8, signal);

    for (const toolType of TOOL_TYPES) {
      if (signal.aborted) break;

      done++;
      onProgress({
        skillName: "craft_gear",
        phase: "Crafting tools",
        progress: done / total,
        message: `Trying to craft ${toolType}...`,
        active: true,
      });

      // Try each tier from best to worst
      for (const tier of TIERS) {
        const itemName = `${tier.name}_${toolType}`;
        const mcItem = mcData.itemsByName[itemName];
        if (!mcItem) continue;

        // Check if we already have this or better
        const have = bot.inventory.items().find((i) => i.name === itemName);
        if (have) {
          crafted.push(`${itemName} (already had)`);
          break;
        }

        // Find crafting table if needed for 3x3 recipe
        let table = bot.findBlock({
          matching: (b) => b.name === "crafting_table",
          maxDistance: 32,
        });

        // If no table nearby, try to place one from inventory (or craft one from planks)
        if (!table) {
          await placeCraftingTable(bot);
          table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 8 });
        }

        const recipe = table
          ? bot.recipesFor(mcItem.id, null, 1, table)[0]
          : bot.recipesFor(mcItem.id, null, 1, null)[0];

        if (!recipe) continue;

        // Navigate to table if needed
        if (table && recipe) {
          const pkg = await import("mineflayer-pathfinder");
          const { goals, Movements } = pkg.default;
          const moves = new Movements(bot);
          moves.canDig = false;
          bot.pathfinder.setMovements(moves);
          try {
            await Promise.race([
              bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2)),
              new Promise<void>((_, rej) =>
                setTimeout(() => {
                  bot.pathfinder.stop();
                  rej(new Error("goto timeout"));
                }, 15000),
              ),
            ]);
          } catch {
            /* try anyway */
          }
        }

        try {
          const countOf = (n: string) =>
            bot.inventory
              .items()
              .filter((i) => i.name === n)
              .reduce((s, i) => s + i.count, 0);
          const before = countOf(itemName);
          await bot.craft(recipe, 1, table || undefined);
          // VERIFY the craft actually produced the item. bot.craft can return
          // without error yet without crafting (e.g. not actually at the table),
          // which made craft_gear report phantom 'iron_pickaxe' successes while
          // the bot held nothing. Only claim it if the count truly rose; else
          // fall through to a lower tier so the bot still gets a working tool.
          if (countOf(itemName) > before) {
            crafted.push(itemName);
            break;
          }
        } catch {
          continue;
        }
      }
    }

    // --- Craft ARMOR (iron/diamond) — the brain's auto-equip timer wears it ---
    for (const piece of ARMOR_TYPES) {
      if (signal.aborted) break;
      for (const tier of ARMOR_TIERS) {
        const itemName = `${tier}_${piece}`;
        const mcItem = mcData.itemsByName[itemName];
        if (!mcItem) continue;
        if (bot.inventory.items().some((i) => i.name === itemName)) {
          crafted.push(`${itemName} (already had)`);
          break;
        }
        let table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
        if (!table) {
          await placeCraftingTable(bot);
          table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 8 });
        }
        const recipe = table
          ? bot.recipesFor(mcItem.id, null, 1, table)[0]
          : bot.recipesFor(mcItem.id, null, 1, null)[0];
        if (!recipe) continue;
        if (table) {
          const pkg = await import("mineflayer-pathfinder");
          const { goals, Movements } = pkg.default;
          const moves = new Movements(bot);
          moves.canDig = false;
          bot.pathfinder.setMovements(moves);
          try {
            await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
          } catch {
            /* try anyway */
          }
        }
        try {
          const countOf = (n: string) =>
            bot.inventory
              .items()
              .filter((i) => i.name === n)
              .reduce((s, i) => s + i.count, 0);
          const before = countOf(itemName);
          await bot.craft(recipe, 1, table || undefined);
          if (countOf(itemName) > before) {
            crafted.push(itemName);
            break; // got this piece — next slot
          }
        } catch {
          continue; // try lower tier
        }
      }
    }

    const newlyCrafted = crafted.filter((c) => !c.includes("already had"));

    if (crafted.length === 0 || newlyCrafted.length === 0) {
      // No new tools made — report what's missing so the LLM knows to get materials
      const missing = TOOL_TYPES.map((t) => {
        const have = bot.inventory.items().find((i) => i.name.endsWith(`_${t}`));
        return have ? null : t;
      }).filter(Boolean);
      const hasWood = bot.inventory.items().some((i) => i.name.endsWith("_log") || i.name.endsWith("_planks"));
      const hasCobble = bot.inventory.items().some((i) => i.name === "cobblestone");
      const hasTable = !!bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
      const hints: string[] = [];
      if (!hasTable && !hasWood) hints.push("need wood to craft a crafting table");
      else if (!hasTable) hints.push("need to place a crafting table");
      if (missing.includes("pickaxe") && !hasCobble) hints.push("need cobblestone for pickaxe");
      return {
        success: false,
        message: `No new tools crafted. Missing: ${missing.join(", ") || "none"}. ${hints.join(". ")}. Use gather_wood to get materials first.`,
      };
    }

    return {
      success: true,
      message: `Gear crafted! Got: ${newlyCrafted.join(", ")}. Ready for action!`,
      stats: { toolsCrafted: newlyCrafted.length },
    };
  },
};

/** Craft one gear item (tool/armor) at a crafting table, verifying it appeared. Returns true if crafted. */
async function craftPiece(
  bot: Bot,
  mcData: ReturnType<typeof mcDataLoader>,
  itemName: string,
  crafted: string[],
): Promise<boolean> {
  const mcItem = mcData.itemsByName[itemName];
  if (!mcItem) return false;
  let table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
  if (!table) {
    await placeCraftingTable(bot);
    table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 8 });
  }
  const recipe = table ? bot.recipesFor(mcItem.id, null, 1, table)[0] : bot.recipesFor(mcItem.id, null, 1, null)[0];
  if (!recipe) return false;
  if (table) {
    const pkg = await import("mineflayer-pathfinder");
    const { goals, Movements } = pkg.default;
    const moves = new Movements(bot);
    moves.canDig = false;
    bot.pathfinder.setMovements(moves);
    try {
      await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
    } catch {
      /* try anyway */
    }
  }
  const countOf = (n: string) =>
    bot.inventory
      .items()
      .filter((i) => i.name === n)
      .reduce((s, i) => s + i.count, 0);
  const before = countOf(itemName);
  try {
    await bot.craft(recipe, 1, table || undefined);
  } catch {
    return false;
  }
  if (countOf(itemName) > before) {
    crafted.push(itemName);
    return true;
  }
  return false;
}

/** Place a crafting table from inventory near the bot, or craft one from planks first. */
async function placeCraftingTable(bot: Bot): Promise<void> {
  const mcData = mcDataLoader(bot.version);

  // Ensure we have a crafting_table item — craft from planks if needed
  let ctItem = bot.inventory.items().find((i) => i.name === "crafting_table");
  if (!ctItem) {
    const ctMcItem = mcData.itemsByName["crafting_table"];
    if (!ctMcItem) return;
    const recipe = bot.recipesFor(ctMcItem.id, null, 1, null)[0];
    if (recipe) {
      // First make planks from any log we have
      for (const logType of LOG_TYPES) {
        const log = bot.inventory.items().find((i) => i.name === logType);
        if (!log) continue;
        const plankName = logType.replace("_log", "_planks");
        const plankItem = mcData.itemsByName[plankName];
        if (!plankItem) continue;
        const plankRecipe = bot.recipesFor(plankItem.id, null, 1, null)[0];
        if (plankRecipe) {
          try {
            await bot.craft(plankRecipe, 2, undefined);
          } catch {
            /* ok */
          }
        }
        break;
      }
      try {
        await bot.craft(recipe, 1, undefined);
      } catch {
        /* ok */
      }
    }
    ctItem = bot.inventory.items().find((i) => i.name === "crafting_table");
  }

  if (!ctItem) return;

  // Place on the block below bot's feet, one step to the side
  const pos = bot.entity.position.floored();
  const candidates = [pos.offset(1, 0, 0), pos.offset(-1, 0, 0), pos.offset(0, 0, 1), pos.offset(0, 0, -1)];
  for (const candidate of candidates) {
    const ground = bot.blockAt(candidate.offset(0, -1, 0));
    if (!ground || ground.name === "air") continue;
    const atCandidate = bot.blockAt(candidate);
    if (atCandidate && atCandidate.name !== "air") continue; // occupied
    try {
      await bot.equip(ctItem, "hand");
      await bot.placeBlock(ground, new Vec3(0, 1, 0));
      return;
    } catch {
      /* try next position */
    }
  }
}

async function ensureSticks(bot: Bot, count: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const mcData = mcDataLoader(bot.version);
  const stickItem = mcData.itemsByName["stick"];
  if (!stickItem) return;

  const have = bot.inventory
    .items()
    .filter((i) => i.name === "stick")
    .reduce((s, i) => s + i.count, 0);
  if (have >= count) return;

  // First ensure we have planks — craft any log type into its planks
  for (const logType of LOG_TYPES) {
    if (signal.aborted) break;
    const logCount = bot.inventory
      .items()
      .filter((i) => i.name === logType)
      .reduce((s, i) => s + i.count, 0);
    if (logCount === 0) continue;

    const plankName = logType.replace("_log", "_planks");
    const mcItem = mcData.itemsByName[plankName];
    if (!mcItem) continue;

    // Craft a few logs into planks (don't convert all — just need enough for sticks)
    const craftCount = Math.min(logCount, 3);
    for (let i = 0; i < craftCount; i++) {
      const recipe = bot.recipesFor(mcItem.id, null, 1, null)[0];
      if (!recipe) break;
      try {
        await bot.craft(recipe, 1, undefined);
      } catch {
        break;
      }
    }
    break; // One log type is enough for sticks
  }

  // Now craft sticks (recipe uses any plank type via tags)
  const stickRecipe = bot.recipesFor(stickItem.id, null, 1, null)[0];
  if (stickRecipe) {
    const need = Math.ceil((count - have) / 4);
    try {
      await bot.craft(stickRecipe, need, undefined);
    } catch {
      /* ok */
    }
  }
}
