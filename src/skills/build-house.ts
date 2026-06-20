import type { Bot } from "mineflayer";
import type { Skill, SkillProgress, SkillResult } from "./types.js";
import { houseBlueprint } from "./blueprints/house.js";
import { LOG_TYPES, PLANK_TYPES, countAllLogs, countAllPlanks } from "./materials.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import mcDataLoader from "minecraft-data";
import { hasStructureNearby, addStructure, getNearestStructure } from "../bot/memory.js";
import { getBotMemoryStore, getAllMemoryStores } from "../bot/memory-registry.js";
import { collectNearbyDrops } from "../bot/navigation.js";

/** All door types — any wood's door works interchangeably */
const DOOR_TYPES = [
  "oak_door",
  "spruce_door",
  "birch_door",
  "jungle_door",
  "acacia_door",
  "dark_oak_door",
  "cherry_door",
  "mangrove_door",
] as const;

/** Remember last build site so repeated build_house calls finish the same house */
let lastBuildSite: Vec3 | null = null;

export const buildHouseSkill: Skill = {
  name: "build_house",
  description:
    "Build a 7x7 house with walls, roof, door, crafting table, and torches. Works with ANY wood type. Gathers materials automatically. Takes ~2 minutes.",
  params: {},

  estimateMaterials(_bot, _params) {
    // All material gathering is handled inside execute().
    // Wood: any log type works, handled internally.
    // Coal: optional (torches are nice-to-have, not required for the house).
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const bp = houseBlueprint;

    // --- Step 1: Find a flat build site ---
    onProgress({
      skillName: "build_house",
      phase: "Finding build site",
      progress: 0,
      message: "Scanning for flat ground...",
      active: true,
    });

    // Site selection — TEAM-aware. Check every bot's memory, not just our own:
    // per-bot structure memory made each bot start its own overlapping shell
    // one block apart because it couldn't see what teammates had built.
    let origin: Vec3 | null = null;
    if (lastBuildSite && bot.entity.position.distanceTo(lastBuildSite) < 50) {
      origin = lastBuildSite;
      console.log(`[Skill] Reusing previous build site at ${origin.x}, ${origin.y}, ${origin.z}`);
    } else {
      const botPos = bot.entity.position;
      const candidates = getAllMemoryStores()
        .map((s) => s.getNearestStructure("house", botPos.x, botPos.z))
        .filter((st): st is NonNullable<typeof st> => !!st)
        .filter((st) => Math.hypot(st.x - botPos.x, st.z - botPos.z) < 12)
        .sort((a, b) => Math.hypot(a.x - botPos.x, a.z - botPos.z) - Math.hypot(b.x - botPos.x, b.z - botPos.z));
      const nearest =
        candidates[0] ??
        (hasStructureNearby("house", botPos.x, botPos.y, botPos.z, 12)
          ? getNearestStructure("house", botPos.x, botPos.z)
          : null);

      if (nearest && !(nearest.notes ?? "").includes("partial")) {
        return {
          success: true, // Treat as success so it doesn't get blacklisted — house already built!
          message: `House already built at (${nearest.x}, ${nearest.y}, ${nearest.z}). Use go_to ${nearest.x} ${nearest.y} ${nearest.z} to visit the existing home.`,
        };
      }
      if (nearest) {
        // Partial house — RESUME it. The placement loop counts already-placed
        // blocks as done, so re-running at the same origin fills the gaps.
        origin = new Vec3(nearest.x, nearest.y, nearest.z);
        console.log(`[Skill] Resuming partial house at ${origin.x}, ${origin.y}, ${origin.z}`);
      } else {
        origin = findBuildSite(bot, 7, 7);
      }
    }
    if (!origin) {
      return {
        success: false,
        message: "Can't find flat ground for a 7x7 house nearby. Try exploring to find open terrain!",
      };
    }
    lastBuildSite = origin;

    console.log(`[Skill] Build site at ${origin.x}, ${origin.y}, ${origin.z}`);

    // --- Step 2: Gather wood (any type) ---
    const totalPlanksNeeded = Object.entries(bp.materials)
      .filter(([name]) => name.endsWith("_planks"))
      .reduce((sum, [, count]) => sum + count, 0);

    // +8 margin for crafting table (4 planks) and sticks (2 planks) and waste
    // +6 for door crafting (6 planks → 3 doors, we need 2)
    const doorsNeeded = bp.materials["oak_door"] || 0;
    const totalPlanksTarget = totalPlanksNeeded + 8 + (doorsNeeded > 0 ? 6 : 0);

    const existingPlanks = countAllPlanks(bot);
    const existingLogs = countAllLogs(bot);
    const planksFromLogs = existingLogs * 4;
    const plankDeficit = Math.max(0, totalPlanksTarget - existingPlanks - planksFromLogs);
    const logsToMine = Math.ceil(plankDeficit / 4);

    if (logsToMine > 0) {
      onProgress({
        skillName: "build_house",
        phase: "Chopping trees",
        progress: 0.02,
        message: `Need ${logsToMine} more logs...`,
        active: true,
      });

      const logBlockNames = [...LOG_TYPES] as string[];
      let mined = 0;
      for (let i = 0; i < logsToMine + 15 && mined < logsToMine && !signal.aborted; i++) {
        const block = bot.findBlock({
          matching: (b) => logBlockNames.includes(b.name),
          maxDistance: 128,
        });
        if (!block) {
          if (mined === 0) {
            return {
              success: false,
              message: "No trees found nearby! Explore to find a forest, then try build_house again.",
            };
          }
          break; // Use what we have
        }

        try {
          setMovements(bot);
          await Promise.race([
            bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2)),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pathfinder timeout")), 15_000)),
          ]);
          await bot.dig(block);
          mined++;
          // Walk over the drop — digging alone leaves the log on the ground
          await collectNearbyDrops(bot, 6, 5000);
          onProgress({
            skillName: "build_house",
            phase: "Chopping trees",
            progress: 0.02 + (mined / logsToMine) * 0.13,
            message: `Chopped ${mined}/${logsToMine} logs`,
            active: true,
          });
        } catch {
          continue;
        }
      }
    }

    if (signal.aborted) {
      return { success: false, message: "Interrupted while gathering wood!" };
    }

    // --- Step 2.5: Clear inventory junk before crafting ---
    // (Tree chopping generates saplings, sticks, buttons that fill inventory)
    await clearInventoryJunk(bot);

    // --- Step 3: Craft materials ---
    onProgress({
      skillName: "build_house",
      phase: "Crafting materials",
      progress: 0.15,
      message: "Turning logs into planks...",
      active: true,
    });

    // Craft ALL log types into their respective planks
    await craftAllLogsToPlanks(bot, signal);

    // Material gate: starting a 174-block build with a handful of planks
    // produces roofless 35-block shells. Precondition-style failure message
    // (matches the brain's non-blacklisting patterns) so the bot gathers more.
    const planksNow = countAllPlanks(bot);
    if (planksNow < totalPlanksNeeded * 0.7) {
      return {
        success: false,
        message: `Not enough planks to build a real house — need ~${totalPlanksTarget}, have ${planksNow}. Use gather_wood to get more logs first.`,
      };
    }

    // Craft sticks (just enough for torches — recipe uses any plank type via tags)
    const torchesNeeded = bp.materials["torch"] || 0;
    const sticksNeeded = Math.ceil(torchesNeeded / 4) + 1;
    await craftSome(bot, "stick", sticksNeeded, signal);

    // Craft torches
    if (torchesNeeded > 0) {
      await craftSome(bot, "torch", torchesNeeded, signal);
    }

    // Craft crafting table
    await craftSome(bot, "crafting_table", 1, signal);

    // Place crafting table so we can use it for door recipe (3x3 grid)
    await placeTableIfNeeded(bot);

    // Craft doors (any wood type — 6 planks → 3 doors)
    if (doorsNeeded > 0) {
      await craftDoors(bot, doorsNeeded, signal);
    }

    if (signal.aborted) {
      return { success: false, message: "House building was interrupted during crafting!" };
    }

    const planksReady = countAllPlanks(bot);
    console.log(`[Skill] Crafting done. Have ${planksReady} planks, need ~${totalPlanksNeeded}`);

    // --- Step 4: Place blocks from blueprint ---
    const structureBlocks = bp.blocks.filter((b) => b.phase === "structure").sort((a, b) => a.pos[1] - b.pos[1]); // bottom-up

    const interiorBlocks = bp.blocks.filter((b) => b.phase === "interior");
    const allBlocks = [...structureBlocks, ...interiorBlocks];
    const total = allBlocks.length;
    let placed = 0;
    let skipped = 0;

    for (let i = 0; i < allBlocks.length; i++) {
      if (signal.aborted) {
        return {
          success: false,
          message: `House building interrupted! Placed ${placed}/${total} blocks. It's... abstract art now.`,
        };
      }

      const bpBlock = allBlocks[i];
      const worldPos = new Vec3(origin.x + bpBlock.pos[0], origin.y + bpBlock.pos[1], origin.z + bpBlock.pos[2]);

      // Skip if already occupied
      const existing = bot.blockAt(worldPos);
      if (
        existing &&
        existing.name !== "air" &&
        existing.name !== "water" &&
        existing.name !== "short_grass" &&
        existing.name !== "tall_grass"
      ) {
        placed++;
        continue;
      }

      // Find the item — use ANY wood variant for planks and doors
      const isDoor = bpBlock.block.endsWith("_door");
      const item = isDoor
        ? bot.inventory.items().find((it) => (DOOR_TYPES as readonly string[]).includes(it.name))
        : bpBlock.block.endsWith("_planks")
          ? bot.inventory.items().find((it) => (PLANK_TYPES as readonly string[]).includes(it.name))
          : bot.inventory.items().find((it) => it.name === bpBlock.block);
      if (!item) {
        skipped++;
        continue;
      }

      try {
        // Navigate close enough to place
        const dist = bot.entity.position.distanceTo(worldPos);
        if (dist > 4.5) {
          setMovements(bot);
          await bot.pathfinder.goto(new goals.GoalNear(worldPos.x, worldPos.y, worldPos.z, 3));
        }

        await bot.equip(item, "hand");

        if (isDoor) {
          // Doors must be placed on the floor block below — Minecraft auto-fills top half
          const floorBlock = bot.blockAt(worldPos.offset(0, -1, 0));
          if (floorBlock && floorBlock.name !== "air") {
            await bot.lookAt(worldPos.offset(0.5, 0, 0.5));
            const ok = await Promise.race([
              bot
                .placeBlock(floorBlock, new Vec3(0, 1, 0))
                .then(() => true)
                .catch(() => false),
              new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
            ]);
            if (ok) placed++;
            else skipped++;
          } else {
            skipped++;
          }
        } else {
          // Normal block: find a solid adjacent block to place against
          const ref = findPlacementRef(bot, worldPos);
          if (ref) {
            await bot.lookAt(worldPos.offset(0.5, 0.5, 0.5));
            // Fast placement with 2s timeout
            const ok = await Promise.race([
              bot
                .placeBlock(ref.block, ref.face)
                .then(() => true)
                .catch(() => false),
              new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
            ]);
            if (ok) placed++;
            else skipped++;
          } else {
            skipped++;
          }
        }
      } catch {
        skipped++;
      }

      // Progress update every 5 blocks
      if (i % 5 === 0) {
        onProgress({
          skillName: "build_house",
          phase: bpBlock.phase === "structure" ? "Building walls & roof" : "Decorating interior",
          progress: 0.2 + ((placed + skipped) / total) * 0.75,
          message: `${placed} blocks placed, ${skipped} skipped`,
          active: true,
        });
      }
    }

    // --- Step 5: Navigate to entrance ---
    const entrancePos = new Vec3(
      origin.x + bp.entrance.pos[0],
      origin.y + bp.entrance.pos[1],
      origin.z + bp.entrance.pos[2],
    );
    try {
      setMovements(bot);
      await bot.pathfinder.goto(new goals.GoalNear(entrancePos.x, entrancePos.y, entrancePos.z, 1));
    } catch {
      /* ok */
    }

    if (placed > total * 0.7) {
      // Save house to per-bot memory (falls back to singleton if no per-bot store registered)
      const _ms = getBotMemoryStore(bot);
      if (_ms) _ms.addStructure("house", origin.x, origin.y, origin.z, bp.name);
      else addStructure("house", origin.x, origin.y, origin.z, bp.name);
      return {
        success: true,
        message: `HOUSE BUILT! "${bp.name}" at ${origin.x}, ${origin.y}, ${origin.z}. Placed ${placed} blocks (${skipped} skipped). It's GORGEOUS. It's HOME.`,
        stats: { blocksPlaced: placed, blocksSkipped: skipped },
      };
    } else if (placed > 0) {
      // Save house to per-bot memory (even if partial)
      const _ms = getBotMemoryStore(bot);
      if (_ms) _ms.addStructure("house", origin.x, origin.y, origin.z, `${bp.name} (partial)`);
      else addStructure("house", origin.x, origin.y, origin.z, `${bp.name} (partial)`);
      return {
        success: true,
        message: `House partially built (${placed}/${total} blocks). It has... character. Maybe patch the holes later.`,
        stats: { blocksPlaced: placed, blocksSkipped: skipped },
      };
    }
    return {
      success: false,
      message: "Couldn't place any blocks. Terrain problems or empty inventory.",
    };
  },
};

// --- Helpers ---

/** Drop junk items to make room for building materials. Keep best tools, food, and building items. */
async function clearInventoryJunk(bot: Bot) {
  const items = bot.inventory.items();
  const usedSlots = items.length;
  if (usedSlots < 30) return; // Plenty of room

  console.log(`[Skill] Inventory cleanup: ${usedSlots}/36 slots used`);

  // Items worth keeping (one each unless stackable building material)
  const keepBest: Record<string, number> = {}; // track best tool of each type

  // Junk to drop: extra duplicate tools, buttons, saplings, non-essential items
  const JUNK_PATTERNS = ["_button", "_sapling", "dandelion", "poppy", "fern", "dead_bush", "feather"];
  const KEEP_ONE = ["stick", "dirt", "cobblestone", "coal", "crafting_table", "red_bed"];
  const TOOL_TYPES_SET = ["_pickaxe", "_axe", "_sword", "_shovel"];

  // Find best tool of each type (diamond > iron > stone > wood)
  const toolRanks: Record<string, number> = { diamond: 4, iron: 3, stone: 2, wooden: 1 };
  const bestTool: Record<string, { rank: number; slot: number }> = {};

  for (const item of items) {
    for (const toolSuffix of TOOL_TYPES_SET) {
      if (item.name.endsWith(toolSuffix)) {
        const tierName = item.name.replace(toolSuffix, "");
        const rank = toolRanks[tierName] || 0;
        const existing = bestTool[toolSuffix];
        if (!existing || rank > existing.rank) {
          bestTool[toolSuffix] = { rank, slot: item.slot };
        }
      }
    }
  }

  const bestToolSlots = new Set(Object.values(bestTool).map((t) => t.slot));

  for (const item of items) {
    // Keep food
    if (item.name.includes("cooked") || item.name.includes("steak") || item.name === "bread") continue;
    // Keep planks and logs (building materials)
    if (item.name.endsWith("_planks") || item.name.endsWith("_log")) continue;
    // Keep torches
    if (item.name === "torch") continue;
    // Keep the best tool of each type
    if (bestToolSlots.has(item.slot)) continue;
    // Keep one of essential items
    if (KEEP_ONE.includes(item.name)) {
      if (!keepBest[item.name]) {
        keepBest[item.name] = 1;
        continue;
      }
    }

    // Drop junk patterns
    const isJunk = JUNK_PATTERNS.some((p) => item.name.includes(p));
    // Drop duplicate tools (not the best)
    const isDupeTool = TOOL_TYPES_SET.some((t) => item.name.endsWith(t)) && !bestToolSlots.has(item.slot);
    // Drop ALL sticks (we can re-craft if needed, they're cheap)
    const isStick = item.name === "stick";

    if (isJunk || isDupeTool || isStick) {
      try {
        await bot.tossStack(item);
        console.log(`[Skill] Dropped ${item.name}x${item.count}`);
      } catch {
        /* ok */
      }
    }
  }

  console.log(`[Skill] Inventory after cleanup: ${bot.inventory.items().length}/36 slots`);
}

function setMovements(bot: Bot) {
  const moves = new Movements(bot);
  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowFreeMotion = false;
  moves.scafoldingBlocks = [];
  bot.pathfinder.setMovements(moves);
}

/** Find a reasonably flat rectangular area near the bot. Returns origin (ground level). */
function findBuildSite(bot: Bot, width: number, depth: number): Vec3 | null {
  const pos = bot.entity.position.floored();

  // Two passes: strict (1 block tolerance), then relaxed (2 block tolerance)
  for (const tolerance of [1, 2]) {
    for (let r = 3; r <= 30; r++) {
      for (let dx = -r; dx <= r; dx += 2) {
        for (let dz = -r; dz <= r; dz += 2) {
          if (Math.abs(dx) < r - 1 && Math.abs(dz) < r - 1) continue;

          const baseY = groundLevel(bot, pos.x + dx, pos.z + dz);
          if (baseY === null) continue;

          let flat = true;
          for (let fx = 0; fx < width && flat; fx += 3) {
            for (let fz = 0; fz < depth && flat; fz += 3) {
              const gy = groundLevel(bot, pos.x + dx + fx, pos.z + dz + fz);
              if (gy === null || Math.abs(gy - baseY) > tolerance) flat = false;
            }
          }
          if (flat) return new Vec3(pos.x + dx, baseY, pos.z + dz);
        }
      }
    }
  }
  return null;
}

function groundLevel(bot: Bot, x: number, z: number): number | null {
  const botY = Math.floor(bot.entity.position.y);
  for (let y = botY + 5; y >= botY - 10; y--) {
    const block = bot.blockAt(new Vec3(x, y, z));
    const above = bot.blockAt(new Vec3(x, y + 1, z));
    if (
      block &&
      block.name !== "air" &&
      block.name !== "water" &&
      block.name !== "short_grass" &&
      block.name !== "tall_grass" &&
      !block.name.includes("leaves") &&
      above &&
      (above.name === "air" || above.name === "short_grass" || above.name === "tall_grass")
    ) {
      return y;
    }
  }
  return null;
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

/** Craft each log type into its corresponding planks. */
async function craftAllLogsToPlanks(bot: Bot, signal: AbortSignal): Promise<void> {
  const mcData = mcDataLoader(bot.version);

  // Also try placing a crafting table for recipes that need one
  const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });

  for (const logType of LOG_TYPES) {
    if (signal.aborted) break;
    const logCount = bot.inventory
      .items()
      .filter((i) => i.name === logType)
      .reduce((s, i) => s + i.count, 0);
    if (logCount === 0) continue;

    const plankName = logType.replace("_log", "_planks");
    const mcItem = mcData.itemsByName[plankName];
    if (!mcItem) {
      console.log(`[Skill] Warning: ${plankName} not found in mcData`);
      continue;
    }

    console.log(`[Skill] Crafting ${logCount}x ${logType} → ${plankName}`);

    // Try without table first, then with table
    let recipe = bot.recipesFor(mcItem.id, null, 1, null)[0];
    let useTable = false;
    if (!recipe && table) {
      recipe = bot.recipesFor(mcItem.id, null, 1, table)[0];
      useTable = true;
    }

    if (!recipe) {
      console.log(`[Skill] No recipe found for ${plankName} — skipping ${logType}`);
      continue;
    }

    // Craft one at a time to avoid mineflayer window timeout issues
    let crafted = 0;
    for (let i = 0; i < logCount && !signal.aborted; i++) {
      try {
        await bot.craft(recipe, 1, useTable ? table || undefined : undefined);
        crafted++;
      } catch {
        // Re-fetch recipe in case inventory state changed
        recipe = bot.recipesFor(mcItem.id, null, 1, useTable ? table || null : null)[0];
        if (!recipe) break;
      }
    }
    console.log(`[Skill] Crafted ${crafted}x ${plankName} (${crafted * 4} planks)`);
  }
}

/** Place a crafting table from inventory if none nearby (needed for door recipe). */
async function placeTableIfNeeded(bot: Bot): Promise<void> {
  const existing = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
  if (existing) return;

  const tableItem = bot.inventory.items().find((i) => i.name === "crafting_table");
  if (!tableItem) return;

  await bot.equip(tableItem, "hand");
  const pos = bot.entity.position.floored();
  // Try placing on solid ground next to the bot
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
        console.log("[Skill] Placed crafting table for door crafting");
        return;
      } catch {
        continue;
      }
    }
  }
}

/** Craft doors from whatever planks are available (any wood type works). */
async function craftDoors(bot: Bot, count: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const mcData = mcDataLoader(bot.version);

  // Check if we already have enough doors
  const haveDoors = bot.inventory
    .items()
    .filter((i) => (DOOR_TYPES as readonly string[]).includes(i.name))
    .reduce((s, i) => s + i.count, 0);
  if (haveDoors >= count) return;

  // Need a crafting table for door recipe (3x3 grid)
  const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
  if (!table) {
    console.log("[Skill] No crafting table found — skipping door crafting");
    return;
  }

  // Navigate to table
  try {
    setMovements(bot);
    await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
  } catch {
    /* try anyway */
  }

  // Try each door type — whichever has a valid recipe (meaning we have 6 of its plank type)
  for (const doorType of DOOR_TYPES) {
    const mcItem = mcData.itemsByName[doorType];
    if (!mcItem) continue;
    const recipe = bot.recipesFor(mcItem.id, null, 1, table)[0];
    if (!recipe) continue;
    try {
      await bot.craft(recipe, 1, table); // 1 craft = 3 doors, enough for 2
      console.log(`[Skill] Crafted ${doorType}`);
      return;
    } catch {
      continue;
    }
  }
  console.log("[Skill] Couldn't craft any doors (need 6 planks of same wood type)");
}

/** Craft a specific count of an item (uses any valid recipe). */
async function craftSome(bot: Bot, itemName: string, count: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const mcData = mcDataLoader(bot.version);
  const mcItem = mcData.itemsByName[itemName];
  if (!mcItem) return;

  const have = bot.inventory
    .items()
    .filter((i) => i.name === itemName)
    .reduce((s, i) => s + i.count, 0);
  if (have >= count) return;

  // Try hand crafting first (no table needed for planks, sticks)
  let recipe = bot.recipesFor(mcItem.id, null, 1, null)[0];

  // If no hand recipe, try with a crafting table
  if (!recipe) {
    const table = bot.findBlock({
      matching: (b) => b.name === "crafting_table",
      maxDistance: 32,
    });
    if (table) {
      try {
        setMovements(bot);
        await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
      } catch {
        /* try anyway */
      }
      recipe = bot.recipesFor(mcItem.id, null, 1, table)[0];
    }
  }

  if (!recipe) return;
  const needed = Math.ceil(count - have);
  try {
    await bot.craft(recipe, needed, undefined);
  } catch {
    /* ok */
  }
}
