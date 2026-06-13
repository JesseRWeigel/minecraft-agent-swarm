import type { Bot } from "mineflayer";
import { collectNearbyDrops, safeGoto } from "../bot/navigation.js";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import mcDataLoader from "minecraft-data";

export const buildFarmSkill: Skill = {
  name: "build_farm",
  description:
    "Build a wheat farm near water. Crafts a hoe, collects seeds, tills soil, plants crops. If mature wheat exists nearby, harvests and replants instead. Takes ~2 minutes.",
  params: {},

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    // --- Step 0: Harvest mature wheat if any nearby ---
    const harvested = await harvestMatureWheat(bot, signal, onProgress);
    if (harvested > 0) {
      return {
        success: true,
        message: `Harvested ${harvested} mature wheat! Got wheat and seeds. The farm cycle continues!`,
        stats: { wheatHarvested: harvested },
      };
    }

    // --- Step 0: Get to the farm site FIRST ---
    // Tree-gathering and water-finding both only see loaded chunks; from the
    // village the lake (and its forest) are ~100 blocks away and invisible.
    // Travel before doing anything else.
    const fx0 = Number(params.x);
    const fz0 = Number(params.z);
    if (
      isFinite(fx0) &&
      isFinite(fz0) &&
      bot.entity.position.distanceTo(new Vec3(fx0, bot.entity.position.y, fz0)) > 24
    ) {
      onProgress({
        skillName: "build_farm",
        phase: "Traveling",
        progress: 0.01,
        message: `Heading to the farm site (${fx0}, ${fz0})...`,
        active: true,
      });
      try {
        await safeGoto(bot, new goals.GoalNear(fx0, Number(params.y) || 64, fz0, 8), 60000);
      } catch {
        /* walk failed — exact teleport below */
      }
      if (signal.aborted) return { success: false, message: "Interrupted while traveling to the farm site." };
      // A probe proved findBlock sees the water INSTANTLY when the bot is
      // actually at the site — the failures were the bot never arriving:
      // pathfinding times out over distance and spreadplayers scatters
      // imprecisely. Bots are ops, so /tp lands EXACTLY on the site; then
      // wait for chunks (matches the working probe sequence) before searching.
      if (bot.entity.position.distanceTo(new Vec3(fx0, bot.entity.position.y, fz0)) > 6) {
        bot.chat(`/tp ${bot.username} ${fx0} ${Number(params.y) + 1 || 64} ${fz0}`);
        await new Promise((r) => setTimeout(r, 2500));
        await bot.waitForChunksToLoad().catch(() => {});
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    // --- Step 1: Ensure we have a hoe ---
    onProgress({
      skillName: "build_farm",
      phase: "Preparing tools",
      progress: 0,
      message: "Looking for a hoe...",
      active: true,
    });

    let hoe = bot.inventory.items().find((i) => i.name.endsWith("_hoe"));
    if (!hoe) {
      await craftHoe(bot, signal);
      hoe = bot.inventory.items().find((i) => i.name.endsWith("_hoe"));
    }
    if (!hoe) {
      // Self-sufficiency (same pattern that made build_house complete):
      // gather a couple of logs instead of failing on missing planks.
      onProgress({
        skillName: "build_farm",
        phase: "Preparing tools",
        progress: 0.02,
        message: "No hoe materials — chopping a tree...",
        active: true,
      });
      const logBlock = bot.findBlock({ matching: (b) => b.name.endsWith("_log"), maxDistance: 128 });
      if (logBlock) {
        try {
          await safeGoto(
            bot,
            new goals.GoalNear(logBlock.position.x, logBlock.position.y, logBlock.position.z, 3),
            60000,
          );
          await bot.dig(bot.blockAt(logBlock.position)!);
          await collectNearbyDrops(bot, 6, 6000);
          const second = bot.findBlock({ matching: (b) => b.name.endsWith("_log"), maxDistance: 16 });
          if (second) {
            await bot.dig(bot.blockAt(second.position)!);
            await collectNearbyDrops(bot, 6, 6000);
          }
        } catch {
          /* best effort */
        }
        await craftHoe(bot, signal);
        hoe = bot.inventory.items().find((i) => i.name.endsWith("_hoe"));
      }
      if (!hoe) {
        return { success: false, message: "Can't craft a hoe! Need planks + sticks + a crafting table." };
      }
    }

    // --- Step 2: Find water, then pre-scan nearby dirt for a fixed target list ---
    // Finding water first avoids the "wrong water re-location" bug where the post-navigation
    // water re-search picks a different water source with no adjacent dirt.
    onProgress({
      skillName: "build_farm",
      phase: "Finding farmable land",
      progress: 0.05,
      message: "Searching for water and nearby dirt...",
      active: true,
    });

    // Find the nearest water. Instrumentation proved a plain name matcher
    // works (finds water ~13 blocks away) while the old "surface water only"
    // matcher — which called bot.blockAt inside the findBlock predicate —
    // silently returned null for ALL water and was the real, long-hidden
    // cause of "No water found". The surface concern (bot swimming into a
    // lake) is handled later by the same-Y dirt scan around the water.
    const findSurfaceWater = () => bot.findBlock({ matching: (b) => b.name === "water", maxDistance: 96 });

    let water = findSurfaceWater();
    for (let attempt = 0; !water && attempt < 3; attempt++) {
      await bot.waitForChunksToLoad().catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      water = findSurfaceWater();
    }

    if (!water) {
      // Travel to a known water site instead of giving up — the village has
      // no water in range, which is why the farm never got built from there.
      const fx = Number(params.x);
      const fz = Number(params.z);
      if (isFinite(fx) && isFinite(fz)) {
        onProgress({
          skillName: "build_farm",
          phase: "Finding farmable land",
          progress: 0.06,
          message: `No water here — heading to the farm site (${fx}, ${fz})...`,
          active: true,
        });
        try {
          await safeGoto(bot, new goals.GoalNear(fx, Number(params.y) || 64, fz, 8), 90000);
        } catch {
          /* try the re-search anyway */
        }
        for (let attempt = 0; !water && attempt < 5; attempt++) {
          await bot.waitForChunksToLoad().catch(() => {});
          await new Promise((r) => setTimeout(r, 1500));
          water = findSurfaceWater();
        }
      }
      if (!water) {
        return { success: false, message: "No water found within 96 blocks! Explore to find a river or pond." };
      }
    }

    // Pre-scan a 9x9 area around the water for tillable dirt/grass at the same Y level.
    // Pre-scanning gives a fixed list to iterate — no re-searching mid-loop that could
    // accidentally use a different water source.
    const waterPos = water.position;
    if (!waterPos) {
      return { success: false, message: "Water block has no position — chunk may not be loaded. Try again." };
    }
    const farmTargets: Vec3[] = [];
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        if (dx === 0 && dz === 0) continue; // skip water block itself
        const pos = waterPos.offset(dx, 0, dz);
        const block = bot.blockAt(pos);
        if (block && (block.name === "dirt" || block.name === "grass_block")) {
          farmTargets.push(pos.clone());
        }
      }
    }

    if (farmTargets.length === 0) {
      return {
        success: false,
        message: "No tillable dirt near the water! The shore may be sand or stone. Explore to find grass near a river.",
      };
    }

    // Navigate to dry shore adjacent to water (not into the water block itself).
    // Find the nearest non-water solid block at the same Y as the water surface.
    let navigationTarget = waterPos;
    const shoreOffsets: [number, number][] = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [2, 0],
      [-2, 0],
      [0, 2],
      [0, -2],
    ];
    for (const [dx, dz] of shoreOffsets) {
      const candidate = waterPos.offset(dx, 0, dz);
      const block = bot.blockAt(candidate);
      if (block && block.name !== "water" && block.name !== "air") {
        navigationTarget = candidate; // dry shore block at water level
        break;
      }
    }
    setMovements(bot);
    try {
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNear(navigationTarget.x, navigationTarget.y, navigationTarget.z, 3)),
        new Promise<void>((_, rej) =>
          setTimeout(() => {
            bot.pathfinder.stop();
            rej(new Error("timeout"));
          }, 15000),
        ),
      ]);
    } catch {
      /* ok — try anyway */
    }

    // --- Step 3: Collect seeds by breaking grass ---
    onProgress({
      skillName: "build_farm",
      phase: "Collecting seeds",
      progress: 0.1,
      message: "Breaking grass for seeds...",
      active: true,
    });

    let seedCount = countItem(bot, "wheat_seeds");
    for (let i = 0; i < 50 && seedCount < 16 && !signal.aborted; i++) {
      const grass = bot.findBlock({
        matching: (b) => b.name === "short_grass" || b.name === "tall_grass",
        maxDistance: 24,
      });
      if (!grass) break;

      try {
        setMovements(bot);
        await bot.pathfinder.goto(new goals.GoalNear(grass.position.x, grass.position.y, grass.position.z, 2));
        await bot.dig(grass);
        seedCount = countItem(bot, "wheat_seeds");
      } catch {
        continue;
      }
    }

    if (seedCount === 0) {
      return { success: false, message: "No seeds from grass! Try a grassier biome." };
    }

    // --- Step 4: Till and plant on pre-identified target positions ---
    onProgress({
      skillName: "build_farm",
      phase: "Planting crops",
      progress: 0.25,
      message: "Tilling soil and planting...",
      active: true,
    });

    let planted = 0;
    const target = Math.min(seedCount, farmTargets.length, 16);

    for (const targetPos of farmTargets) {
      if (planted >= target || signal.aborted) break;

      // Skip if block was already tilled by a previous iteration
      const currentBlock = bot.blockAt(targetPos);
      if (!currentBlock || (currentBlock.name !== "dirt" && currentBlock.name !== "grass_block")) continue;

      try {
        setMovements(bot);
        await Promise.race([
          bot.pathfinder.goto(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 1)),
          new Promise<void>((_, rej) =>
            setTimeout(() => {
              bot.pathfinder.stop();
              rej(new Error("timeout"));
            }, 8000),
          ),
        ]);

        // Equip hoe and till
        hoe = bot.inventory.items().find((it) => it.name.endsWith("_hoe"));
        if (!hoe) break;
        await bot.equip(hoe, "hand");
        await bot.lookAt(targetPos.offset(0.5, 0.5, 0.5));
        await bot.activateBlock(currentBlock);
        await bot.waitForTicks(4);

        // Check if it became farmland
        const result = bot.blockAt(targetPos);
        if (result && result.name === "farmland") {
          const seeds = bot.inventory.items().find((it) => it.name === "wheat_seeds");
          if (seeds) {
            await bot.equip(seeds, "hand");
            try {
              await bot.placeBlock(result, new Vec3(0, 1, 0));
              planted++;
              onProgress({
                skillName: "build_farm",
                phase: "Planting crops",
                progress: 0.25 + (planted / target) * 0.7,
                message: `Planted ${planted}/${target} wheat`,
                active: true,
              });
            } catch {
              /* skip this spot */
            }
          }
        }
      } catch {
        continue;
      }
    }

    if (planted === 0) {
      return {
        success: false,
        message: `Couldn't plant anything near water at ${waterPos.x.toFixed(0)},${waterPos.z.toFixed(0)} — navigation or tilling failed. Try 'explore' first.`,
      };
    }

    return {
      success: true,
      message: `Farm planted! ${planted} wheat seeds near water at ${waterPos.x.toFixed(0)}, ${waterPos.z.toFixed(0)}. Wheat grows in ~5 minutes — come back and use build_farm again to harvest!`,
      stats: { cropsPlanted: planted },
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

function countItem(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((s, i) => s + i.count, 0);
}

/** Harvest all mature wheat within 20 blocks. Returns count harvested. */
async function harvestMatureWheat(bot: Bot, signal: AbortSignal, onProgress: (p: any) => void): Promise<number> {
  let harvested = 0;

  for (let i = 0; i < 40 && !signal.aborted; i++) {
    const wheat = bot.findBlock({
      matching: (b) => b.name === "wheat" && b.metadata >= 7,
      maxDistance: 20,
    });
    if (!wheat || !wheat.position) break;

    try {
      setMovements(bot);
      await bot.pathfinder.goto(new goals.GoalNear(wheat.position.x, wheat.position.y, wheat.position.z, 2));
      await bot.dig(wheat);
      harvested++;
      onProgress({
        skillName: "build_farm",
        phase: "Harvesting",
        progress: harvested / 20,
        message: `Harvested ${harvested} wheat`,
        active: true,
      });
    } catch {
      continue;
    }
  }

  // Replant seeds on empty farmland after harvesting
  if (harvested > 0) {
    let replanted = 0;
    for (let i = 0; i < 40 && !signal.aborted; i++) {
      const farmland = bot.findBlock({
        matching: (b) => {
          if (b.name !== "farmland" || !b.position) return false;
          const above = bot.blockAt(b.position.offset(0, 1, 0));
          return above !== null && above.name === "air";
        },
        maxDistance: 20,
      });
      if (!farmland) break;

      const seeds = bot.inventory.items().find((it) => it.name === "wheat_seeds");
      if (!seeds) break;

      try {
        setMovements(bot);
        await bot.pathfinder.goto(new goals.GoalNear(farmland.position.x, farmland.position.y, farmland.position.z, 2));
        await bot.equip(seeds, "hand");
        await bot.placeBlock(farmland, new Vec3(0, 1, 0));
        replanted++;
      } catch {
        continue;
      }
    }
    console.log(`[Skill] Harvested ${harvested} wheat, replanted ${replanted} seeds`);
  }

  return harvested;
}

async function craftHoe(bot: Bot, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const mcData = mcDataLoader(bot.version);

  // Convert logs → planks first — the recipes below assume planks exist,
  // and the self-gathering step above only produces raw logs.
  const havePlanks = bot.inventory.items().some((i) => i.name.endsWith("_planks"));
  if (!havePlanks) {
    const log = bot.inventory.items().find((i) => i.name.endsWith("_log"));
    if (log) {
      const plankName = log.name.replace("_log", "_planks");
      const plankItem = mcData.itemsByName[plankName];
      const recipe = plankItem ? bot.recipesFor(plankItem.id, null, 1, null)[0] : null;
      if (recipe) {
        try {
          await bot.craft(recipe, Math.min(2, log.count), undefined);
        } catch {
          /* ok */
        }
      }
    }
  }

  // Ensure sticks
  const stickItem = mcData.itemsByName["stick"];
  if (stickItem) {
    const recipe = bot.recipesFor(stickItem.id, null, 1, null)[0];
    if (recipe) {
      try {
        await bot.craft(recipe, 1, undefined);
      } catch {
        /* ok */
      }
    }
  }

  // Try each hoe tier (cheapest first — wooden only needs planks)
  const hoeTiers = ["wooden_hoe", "stone_hoe", "iron_hoe"];
  for (const hoeName of hoeTiers) {
    const mcItem = mcData.itemsByName[hoeName];
    if (!mcItem) continue;

    let recipe = bot.recipesFor(mcItem.id, null, 1, null)[0];
    if (recipe) {
      try {
        await bot.craft(recipe, 1, undefined);
        return;
      } catch {
        continue;
      }
    }

    const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
    if (table) {
      setMovements(bot);
      try {
        await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
      } catch {
        /* try anyway */
      }
      recipe = bot.recipesFor(mcItem.id, null, 1, table)[0];
      if (recipe) {
        try {
          await bot.craft(recipe, 1, table);
          return;
        } catch {
          continue;
        }
      }
    }
  }
}
