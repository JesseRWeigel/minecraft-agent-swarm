import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import mcDataLoader from "minecraft-data";
import { withdrawStash } from "./stash.js";

/** Items that can be smelted: input → output name. */
const SMELT_RECIPES: Record<string, string> = {
  raw_iron: "iron_ingot",
  iron_ore: "iron_ingot",
  raw_gold: "gold_ingot",
  gold_ore: "gold_ingot",
  raw_copper: "copper_ingot",
  copper_ore: "copper_ingot",
  sand: "glass",
};

/** Valid fuel items, roughly ordered by efficiency. */
const FUEL_ITEMS = [
  "coal",
  "charcoal",
  "oak_planks",
  "spruce_planks",
  "birch_planks",
  "jungle_planks",
  "acacia_planks",
  "dark_oak_planks",
  "cherry_planks",
  "mangrove_planks",
  "oak_log",
  "spruce_log",
  "birch_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
  "cherry_log",
  "mangrove_log",
  "pale_oak_log",
  "pale_oak_planks", // MC 1.21.4
];

export const smeltOresSkill: Skill = {
  name: "smelt_ores",
  description:
    "Smelt raw ores into ingots using a furnace. Crafts and places a furnace if needed (8 cobblestone). Uses coal or wood as fuel.",
  params: {},

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    const mcData = mcDataLoader(bot.version);
    const countInv = (name: string) =>
      bot.inventory
        .items()
        .filter((i) => i.name === name)
        .reduce((s, i) => s + i.count, 0);

    // --- Step 0: Pull ore + fuel from the shared stash if we lack them. ---
    // Bots kept invoking smelt empty-handed ("Nothing to smelt" / "No fuel")
    // because the miner deposits raw_iron + coal and a DIFFERENT bot tries to
    // smelt. Withdraw what the team already mined (the stash is the intended
    // hand-off mechanism — not a cheat).
    const stashPos = params?.stashPos as { x: number; y: number; z: number } | undefined;
    if (stashPos && !signal.aborted) {
      const haveSmeltable = Object.keys(SMELT_RECIPES).some((n) => countInv(n) > 0);
      if (!haveSmeltable) {
        for (const ore of ["raw_iron", "iron_ore", "raw_copper", "copper_ore", "raw_gold", "gold_ore"]) {
          try {
            await withdrawStash(bot, stashPos, ore, 16);
          } catch {
            /* none in stash — try next */
          }
          if (Object.keys(SMELT_RECIPES).some((n) => countInv(n) > 0)) break;
        }
      }
      const haveFuel = FUEL_ITEMS.some((n) => countInv(n) > 0);
      if (!haveFuel) {
        for (const fuel of ["coal", "charcoal"]) {
          try {
            await withdrawStash(bot, stashPos, fuel, 16);
          } catch {
            /* none — try next */
          }
          if (FUEL_ITEMS.some((n) => countInv(n) > 0)) break;
        }
      }
    }

    // --- Step 1: Find smeltable items in inventory ---
    const toSmelt: Array<{ itemName: string; count: number; output: string }> = [];
    for (const [input, output] of Object.entries(SMELT_RECIPES)) {
      const count = bot.inventory
        .items()
        .filter((i) => i.name === input)
        .reduce((s, i) => s + i.count, 0);
      if (count > 0) {
        toSmelt.push({ itemName: input, count, output });
      }
    }

    if (toSmelt.length === 0) {
      return { success: false, message: "Nothing to smelt! Mine some ore first (strip_mine for iron, gold, copper)." };
    }

    // --- Step 2: Check fuel ---
    const fuel = bot.inventory.items().find((i) => FUEL_ITEMS.includes(i.name));
    if (!fuel) {
      return { success: false, message: "No fuel! Need coal, charcoal, or wood to power the furnace." };
    }

    const totalItems = toSmelt.reduce((s, t) => s + t.count, 0);
    onProgress({
      skillName: "smelt_ores",
      phase: "Preparing",
      progress: 0,
      message: `${totalItems} items to smelt...`,
      active: true,
    });

    // --- Step 3: Find or craft+place furnace ---
    let furnaceBlock = bot.findBlock({
      matching: (b) => b.name === "furnace" || b.name === "lit_furnace",
      maxDistance: 32,
    });

    if (!furnaceBlock) {
      const cobble = countItem(bot, "cobblestone");
      if (cobble < 8) {
        return {
          success: false,
          message: "No furnace nearby and need 8 cobblestone to craft one. Mine some stone first!",
        };
      }

      onProgress({
        skillName: "smelt_ores",
        phase: "Crafting furnace",
        progress: 0.05,
        message: "Making a furnace...",
        active: true,
      });

      // Craft furnace at crafting table
      const furnaceItemDef = mcData.itemsByName["furnace"];
      if (furnaceItemDef) {
        const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
        let recipe = table ? bot.recipesFor(furnaceItemDef.id, null, 1, table)[0] : null;
        if (!recipe) recipe = bot.recipesFor(furnaceItemDef.id, null, 1, null)[0];
        if (recipe) {
          if (table) {
            setMovements(bot);
            try {
              await gotoTimed(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20000);
            } catch {
              /* best-effort */
            }
          }
          try {
            await bot.craft(recipe, 1, table || undefined);
          } catch {
            /* best-effort */
          }
        }
      }

      // Place furnace
      const fItem = bot.inventory.items().find((i) => i.name === "furnace");
      if (!fItem) {
        return { success: false, message: "Couldn't craft a furnace. Need 8 cobblestone and a crafting table." };
      }

      await bot.equip(fItem, "hand");
      const pos = bot.entity.position.floored();
      for (const offset of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const below = bot.blockAt(new Vec3(pos.x + offset[0], pos.y - 1, pos.z + offset[1]));
        const target = bot.blockAt(new Vec3(pos.x + offset[0], pos.y, pos.z + offset[1]));
        if (below && below.name !== "air" && target && target.name === "air") {
          try {
            await bot.placeBlock(below, new Vec3(0, 1, 0));
            console.log("[Skill] Placed furnace");
            break;
          } catch {
            continue;
          }
        }
      }

      furnaceBlock = bot.findBlock({ matching: (b) => b.name === "furnace", maxDistance: 8 });
      if (!furnaceBlock) {
        return { success: false, message: "Couldn't place furnace. Try in a flatter area." };
      }
    }

    // --- Step 4: Navigate to furnace ---
    setMovements(bot);
    try {
      await gotoTimed(
        bot,
        new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2),
        20000,
      );
    } catch {
      /* try anyway */
    }

    // --- Step 5: Smelt each batch ---
    let smelted = 0;
    const results: string[] = [];

    for (const batch of toSmelt) {
      if (signal.aborted) break;

      onProgress({
        skillName: "smelt_ores",
        phase: "Smelting",
        progress: 0.1 + (smelted / totalItems) * 0.85,
        message: `Smelting ${batch.count}x ${batch.itemName}...`,
        active: true,
      });

      try {
        // Re-find furnace (might have shifted from furnace to lit_furnace)
        furnaceBlock = bot.findBlock({
          matching: (b) => b.name === "furnace" || b.name === "lit_furnace",
          maxDistance: 8,
        });
        if (!furnaceBlock) break;

        // openFurnace blocks forever if the furnace GUI never opens (block not
        // truly reachable/loaded) — this hung smelt_ores to the 240s watchdog
        // repeatedly, producing 0 ingots. Bound it so it fails fast and the
        // batch is skipped (caught below).
        const furnace = (await Promise.race([
          bot.openFurnace(furnaceBlock),
          new Promise((_, rej) => setTimeout(() => rej(new Error("openFurnace timeout")), 10000)),
        ])) as Awaited<ReturnType<typeof bot.openFurnace>>;

        // Put fuel first
        const fuelItem = bot.inventory.items().find((i) => FUEL_ITEMS.includes(i.name));
        if (fuelItem) {
          const fuelNeeded =
            fuelItem.name === "coal" || fuelItem.name === "charcoal" ? Math.ceil(batch.count / 8) : batch.count;
          await furnace.putFuel(fuelItem.type, null, Math.min(fuelNeeded, fuelItem.count));
        }

        // Put ores in input
        const inputItem = bot.inventory.items().find((i) => i.name === batch.itemName);
        if (inputItem) {
          await furnace.putInput(inputItem.type, null, Math.min(batch.count, inputItem.count));
        }

        // Wait for smelting (10s per item, capped at 2 minutes)
        const waitMs = Math.min(batch.count * 10500 + 3000, 120000);
        const startTime = Date.now();

        while (Date.now() - startTime < waitMs && !signal.aborted) {
          await new Promise((r) => setTimeout(r, 2500));
          const output = furnace.outputItem();
          if (output && output.count >= batch.count) break;
        }

        // Take output
        const output = furnace.outputItem();
        if (output) {
          await furnace.takeOutput();
          smelted += output.count;
          results.push(`${output.count}x ${batch.output}`);
        }

        furnace.close();
      } catch (err) {
        console.log(`[Skill] Smelt error: ${err}`);
        continue;
      }
    }

    if (smelted === 0) {
      return { success: false, message: "Smelting produced nothing. Maybe ran out of fuel or ores." };
    }

    return {
      success: true,
      message: `Smelting done! Got: ${results.join(", ")}. Time to upgrade your gear with craft_gear!`,
      stats: { itemsSmelted: smelted },
    };
  },
};

function setMovements(bot: Bot) {
  const moves = new Movements(bot);
  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowFreeMotion = false;
  moves.scafoldingBlocks = [];
  bot.pathfinder.setMovements(moves);
}

/** pathfinder.goto with a hard timeout — an unreachable furnace/table goal
 *  otherwise hangs smelt_ores to the 240s skill watchdog, stalling the smelter. */
async function gotoTimed(bot: Bot, goal: any, ms: number): Promise<void> {
  await Promise.race([
    bot.pathfinder.goto(goal),
    new Promise<void>((_, rej) =>
      setTimeout(() => {
        bot.pathfinder.stop();
        rej(new Error("goto timeout"));
      }, ms),
    ),
  ]);
}

function countItem(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((s, i) => s + i.count, 0);
}
