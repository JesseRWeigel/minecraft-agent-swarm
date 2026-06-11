// src/skills/setup-stash.ts
// Bootstraps the shared stash — crafts & places a double chest at the stash position.

import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { LOG_TYPES, PLANK_TYPES, countAllLogs, countAllPlanks } from "./materials.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import mcDataLoader from "minecraft-data";
import { safeGoto } from "../bot/actions.js";

export const setupStashSkill: Skill = {
  name: "setup_stash",
  description:
    "Bootstrap the shared stash: walk to the stash position, craft 2 chests if needed, and place them as a double chest. Requires logs or planks in inventory.",
  params: {
    x: { type: "number", description: "Stash X coordinate" },
    y: { type: "number", description: "Stash Y coordinate" },
    z: { type: "number", description: "Stash Z coordinate" },
  },

  estimateMaterials(_bot, _params) {
    // 2 chests = 16 planks = 4 logs. Gathering is handled inside execute().
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    const stashX = Number(params.x);
    const stashY = Number(params.y);
    const stashZ = Number(params.z);

    if (isNaN(stashX) || isNaN(stashY) || isNaN(stashZ)) {
      return { success: false, message: "Invalid stash position — x, y, z must be numbers." };
    }

    const stashPos = new Vec3(stashX, stashY, stashZ);

    // --- Step 1: Walk to the stash position ---
    onProgress({
      skillName: "setup_stash",
      phase: "Navigating to stash",
      progress: 0.0,
      message: `Walking to stash at ${stashX}, ${stashY}, ${stashZ}...`,
      active: true,
    });

    try {
      await safeGoto(bot, new goals.GoalNear(stashX, stashY, stashZ, 3), 30000);
    } catch {
      return { success: false, message: "Could not navigate to stash position." };
    }

    if (signal.aborted) {
      return { success: false, message: "Interrupted while navigating to stash." };
    }

    // Ground-snap Y: the configured stash Y is approximate — find the actual
    // surface at (x, z) so chest placement doesn't end up floating or buried.
    for (let y = stashY + 20; y >= stashY - 20; y--) {
      const block = bot.blockAt(new Vec3(stashX, y, stashZ));
      const above = bot.blockAt(new Vec3(stashX, y + 1, stashZ));
      if (
        block &&
        block.name !== "air" &&
        block.name !== "cave_air" &&
        block.name !== "water" &&
        !block.name.includes("leaves") &&
        above &&
        (above.name === "air" || above.name === "short_grass" || above.name === "tall_grass")
      ) {
        stashPos.y = y + 1;
        break;
      }
    }

    // --- Step 2: Check if chests already exist nearby ---
    onProgress({
      skillName: "setup_stash",
      phase: "Checking for existing chests",
      progress: 0.15,
      message: "Scanning for nearby chests...",
      active: true,
    });

    const existingChest = bot.findBlock({
      matching: (b) => b.name === "chest" || b.name === "trapped_chest",
      maxDistance: 8,
    });

    if (existingChest) {
      onProgress({
        skillName: "setup_stash",
        phase: "Done",
        progress: 1.0,
        message: "Stash already set up!",
        active: false,
      });
      return {
        success: true,
        message: `Stash already exists — chest found at ${existingChest.position.x}, ${existingChest.position.y}, ${existingChest.position.z}.`,
      };
    }

    // --- Step 3: Ensure we have 2 chests ---
    onProgress({
      skillName: "setup_stash",
      phase: "Preparing chests",
      progress: 0.25,
      message: "Checking inventory for chests...",
      active: true,
    });

    let chestCount = bot.inventory
      .items()
      .filter((i) => i.name === "chest")
      .reduce((sum, i) => sum + i.count, 0);

    if (chestCount < 2) {
      // Need to craft chests — check for planks
      const planksHave = countAllPlanks(bot);
      const planksNeeded = (2 - chestCount) * 8; // 8 planks per chest

      if (planksHave < planksNeeded) {
        // Try crafting planks from logs
        const logsHave = countAllLogs(bot);
        const plankDeficit = planksNeeded - planksHave;
        const logsNeeded = Math.ceil(plankDeficit / 4);

        if (logsHave < logsNeeded) {
          return {
            success: false,
            message: `Not enough materials for chests. Need ${planksNeeded} planks (have ${planksHave}) or ${logsNeeded} logs (have ${logsHave}). Gather wood first!`,
          };
        }

        // Craft logs into planks
        onProgress({
          skillName: "setup_stash",
          phase: "Crafting planks",
          progress: 0.35,
          message: "Turning logs into planks...",
          active: true,
        });

        await craftAllLogsToPlanks(bot, signal, logsNeeded);
      }

      if (signal.aborted) {
        return { success: false, message: "Interrupted while crafting planks." };
      }

      // Now craft chests — requires a crafting table (3x3 recipe)
      onProgress({
        skillName: "setup_stash",
        phase: "Crafting chests",
        progress: 0.5,
        message: "Crafting chests...",
        active: true,
      });

      // Ensure we have a crafting table
      await ensureCraftingTable(bot, signal);

      const chestsToMake = 2 - chestCount;
      const mcData = mcDataLoader(bot.version);
      const chestMcItem = mcData.itemsByName["chest"];

      if (!chestMcItem) {
        return { success: false, message: "Chest item not found in game data." };
      }

      const table = bot.findBlock({
        matching: (b) => b.name === "crafting_table",
        maxDistance: 32,
      });

      if (table) {
        // Navigate to crafting table
        try {
          setMovements(bot);
          await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
        } catch {
          /* try anyway */
        }

        for (let i = 0; i < chestsToMake && !signal.aborted; i++) {
          const recipe = bot.recipesFor(chestMcItem.id, null, 1, table)[0];
          if (!recipe) {
            return {
              success: false,
              message: `Can't find chest recipe. Have ${countAllPlanks(bot)} planks — need 8 per chest.`,
            };
          }
          try {
            await bot.craft(recipe, 1, table);
          } catch (e) {
            return { success: false, message: `Failed to craft chest: ${e}` };
          }
        }
      } else {
        // No table — try hand-crafting (unlikely to work for chests but try)
        for (let i = 0; i < chestsToMake && !signal.aborted; i++) {
          const recipe = bot.recipesFor(chestMcItem.id, null, 1, null)[0];
          if (!recipe) {
            return {
              success: false,
              message: "Need a crafting table to craft chests (3x3 recipe). Place one nearby.",
            };
          }
          try {
            await bot.craft(recipe, 1, undefined);
          } catch (e) {
            return { success: false, message: `Failed to craft chest: ${e}` };
          }
        }
      }

      // Verify we now have enough chests
      chestCount = bot.inventory
        .items()
        .filter((i) => i.name === "chest")
        .reduce((sum, i) => sum + i.count, 0);

      if (chestCount < 2) {
        return {
          success: false,
          message: `Only crafted ${chestCount} chests — needed 2. Not enough planks.`,
        };
      }
    }

    if (signal.aborted) {
      return { success: false, message: "Interrupted while crafting chests." };
    }

    // --- Step 4: Place double chest at stash position ---
    onProgress({
      skillName: "setup_stash",
      phase: "Placing chests",
      progress: 0.7,
      message: "Placing double chest at stash...",
      active: true,
    });

    // Navigate back to stash pos if we wandered to find a crafting table
    try {
      await safeGoto(bot, new goals.GoalNear(stashX, stashY, stashZ, 3), 15000);
    } catch {
      /* close enough */
    }

    // Place first chest at stashPos
    const placed1 = await placeChestAt(bot, stashPos);
    if (!placed1) {
      return {
        success: false,
        message: "Failed to place first chest at stash position. Check terrain.",
      };
    }

    onProgress({
      skillName: "setup_stash",
      phase: "Placing chests",
      progress: 0.85,
      message: "Placing second chest for double chest...",
      active: true,
    });

    // Place second chest adjacent (+1 on X axis) for double chest
    const secondPos = stashPos.offset(1, 0, 0);
    const placed2 = await placeChestAt(bot, secondPos);
    if (!placed2) {
      // Try other adjacent positions if +1 X didn't work
      const alternatives = [stashPos.offset(-1, 0, 0), stashPos.offset(0, 0, 1), stashPos.offset(0, 0, -1)];
      let placedAlt = false;
      for (const altPos of alternatives) {
        if (await placeChestAt(bot, altPos)) {
          placedAlt = true;
          break;
        }
      }
      if (!placedAlt) {
        return {
          success: true, // one chest is better than none
          message: `Placed 1 chest at stash (${stashX}, ${stashY}, ${stashZ}) but couldn't place second for double chest. Terrain issue.`,
          stats: { chestsPlaced: 1 },
        };
      }
    }

    onProgress({
      skillName: "setup_stash",
      phase: "Done",
      progress: 1.0,
      message: "Stash set up!",
      active: false,
    });

    return {
      success: true,
      message: `Stash bootstrapped! Double chest placed at (${stashX}, ${stashY}, ${stashZ}). Ready for deposits.`,
      stats: { chestsPlaced: 2 },
    };
  },
};

// --- Helpers ---

function setMovements(bot: Bot) {
  const moves = new Movements(bot);
  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowFreeMotion = false;
  moves.scafoldingBlocks = [];
  bot.pathfinder.setMovements(moves);
}

/**
 * Craft logs into planks. Converts up to `maxLogs` logs of any type.
 */
async function craftAllLogsToPlanks(bot: Bot, signal: AbortSignal, maxLogs: number): Promise<void> {
  const mcData = mcDataLoader(bot.version);
  let converted = 0;

  for (const logType of LOG_TYPES) {
    if (signal.aborted || converted >= maxLogs) break;

    const logCount = bot.inventory
      .items()
      .filter((i) => i.name === logType)
      .reduce((s, i) => s + i.count, 0);
    if (logCount === 0) continue;

    const plankName = logType.replace("_log", "_planks");
    const mcItem = mcData.itemsByName[plankName];
    if (!mcItem) continue;

    const toCraft = Math.min(logCount, maxLogs - converted);

    for (let i = 0; i < toCraft && !signal.aborted; i++) {
      const recipe = bot.recipesFor(mcItem.id, null, 1, null)[0];
      if (!recipe) break;
      try {
        await bot.craft(recipe, 1, undefined);
        converted++;
      } catch {
        break;
      }
    }
  }
}

/**
 * Ensure a crafting table is placed nearby. Crafts one from planks if needed.
 */
async function ensureCraftingTable(bot: Bot, signal: AbortSignal): Promise<void> {
  // Already placed nearby?
  const existing = bot.findBlock({
    matching: (b) => b.name === "crafting_table",
    maxDistance: 32,
  });
  if (existing) return;

  const mcData = mcDataLoader(bot.version);

  // Do we have one in inventory?
  let ctItem = bot.inventory.items().find((i) => i.name === "crafting_table");
  if (!ctItem) {
    // Craft from planks
    const ctMcItem = mcData.itemsByName["crafting_table"];
    if (!ctMcItem) return;
    const recipe = bot.recipesFor(ctMcItem.id, null, 1, null)[0];
    if (recipe) {
      try {
        await bot.craft(recipe, 1, undefined);
      } catch {
        /* ok */
      }
    }
    ctItem = bot.inventory.items().find((i) => i.name === "crafting_table");
  }

  if (!ctItem || signal.aborted) return;

  // Place it on solid ground near the bot
  await bot.equip(ctItem, "hand");
  const pos = bot.entity.position.floored();
  const offsets = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;

  for (const [dx, dz] of offsets) {
    const below = bot.blockAt(new Vec3(pos.x + dx, pos.y - 1, pos.z + dz));
    const target = bot.blockAt(new Vec3(pos.x + dx, pos.y, pos.z + dz));
    if (below && below.name !== "air" && target && target.name === "air") {
      try {
        await bot.placeBlock(below, new Vec3(0, 1, 0));
        console.log("[setup_stash] Placed crafting table");
        return;
      } catch {
        continue;
      }
    }
  }
}

/**
 * Place a chest from inventory at the given world position.
 * Returns true on success.
 */
async function placeChestAt(bot: Bot, targetPos: Vec3): Promise<boolean> {
  const chestItem = bot.inventory.items().find((i) => i.name === "chest");
  if (!chestItem) return false;

  // Navigate close enough
  const dist = bot.entity.position.distanceTo(targetPos);
  if (dist > 4) {
    try {
      setMovements(bot);
      await bot.pathfinder.goto(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 2));
    } catch {
      /* try anyway */
    }
  }

  // Check if position is already occupied
  const blockAtTarget = bot.blockAt(targetPos);
  if (
    blockAtTarget &&
    blockAtTarget.name !== "air" &&
    blockAtTarget.name !== "short_grass" &&
    blockAtTarget.name !== "tall_grass"
  ) {
    // Already something there — check if it's already a chest
    if (blockAtTarget.name === "chest" || blockAtTarget.name === "trapped_chest") return true;
    return false;
  }

  await bot.equip(chestItem, "hand");

  // Find a solid reference block to place against
  const ref = findPlacementRef(bot, targetPos);
  if (!ref) return false;

  try {
    await bot.lookAt(targetPos.offset(0.5, 0.5, 0.5));
    const ok = await Promise.race([
      bot
        .placeBlock(ref.block, ref.face)
        .then(() => true)
        .catch(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
    ]);
    return ok;
  } catch {
    return false;
  }
}

/** Find a solid block adjacent to targetPos that we can place against. */
function findPlacementRef(bot: Bot, targetPos: Vec3): { block: any; face: Vec3 } | null {
  const faces = [
    new Vec3(0, -1, 0),
    new Vec3(0, 1, 0),
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
  ];
  for (const face of faces) {
    const refPos = targetPos.minus(face);
    const refBlock = bot.blockAt(refPos);
    if (refBlock && refBlock.name !== "air" && refBlock.name !== "water" && !refBlock.name.includes("leaves")) {
      return { block: refBlock, face };
    }
  }
  return null;
}
