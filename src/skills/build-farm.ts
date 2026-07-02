import type { Bot } from "mineflayer";
import { collectNearbyDrops, safeGoto } from "../bot/navigation.js";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import mcDataLoader from "minecraft-data";
import { getBotMemoryStore } from "../bot/memory-registry.js";
import { config } from "../config.js";

export const buildFarmSkill: Skill = {
  name: "build_farm",
  description:
    "Build a wheat farm near water. Crafts a hoe, collects seeds, tills soil, plants crops. If mature wheat exists nearby, harvests and replants instead. Takes ~2 minutes.",
  params: {},

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    // --- Step 0: Harvest mature wheat, then BAKE BREAD ---
    // The loop used to dead-end here: wheat was harvested but never turned into
    // bread (wheat isn't edible), so the team starved beside a working farm.
    // Bake any accumulated wheat (>=3) into bread — done inside the skill so it
    // bypasses the blacklisted `craft:bread` action.
    const harvested = await harvestMatureWheat(bot, signal, onProgress);
    const baked = await bakeBread(bot, signal, onProgress, params?.stashPos as { x: number; y: number; z: number });
    if (harvested > 0 || baked > 0) {
      const breadNote =
        baked > 0
          ? `Baked ${baked} bread — food secured! 🍞`
          : "Not enough wheat to bake bread yet (need 3+); farm is still growing.";
      return {
        success: true,
        message: `${harvested > 0 ? `Harvested ${harvested} wheat. ` : ""}${breadNote} The farm cycle continues!`,
        stats: { wheatHarvested: harvested, breadBaked: baked },
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
      // actually at the site — the failures were the bot never arriving
      // (pathfinding times out over distance). A /tp fallback lived here but
      // violated the no-cheat rule (it was the ONLY command not gated behind
      // allowInterventions); now it's gated like every other intervention.
      // With interventions off the bot either walks there or reports failure.
      if (bot.entity.position.distanceTo(new Vec3(fx0, bot.entity.position.y, fz0)) > 6) {
        if (config.bot.allowInterventions) {
          bot.chat(`/tp ${bot.username} ${fx0} ${Number(params.y) + 1 || 64} ${fz0}`);
          await new Promise((r) => setTimeout(r, 2500));
          await bot.waitForChunksToLoad().catch(() => {});
          await new Promise((r) => setTimeout(r, 1500));
        } else {
          return {
            success: false,
            message: `Couldn't reach the farm site (${fx0}, ${fz0}) by walking — try again when closer, or go_to it first.`,
          };
        }
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
          await digT(bot, bot.blockAt(logBlock.position)!);
          await collectNearbyDrops(bot, 6, 6000);
          const second = bot.findBlock({ matching: (b) => b.name.endsWith("_log"), maxDistance: 16 });
          if (second) {
            await digT(bot, bot.blockAt(second.position)!);
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
    // Find a water source that ACTUALLY HAS tillable land around it. The old
    // code took the single nearest water — but after weeks of mining, the base
    // pond is ringed by cobble/sand (no dirt), so build_farm failed 'No tillable
    // dirt' every run as the base degraded. Scan many water sources and pick the
    // first with enough grass/dirt nearby (fresh grassland the bots explore).
    const scanTillable = (wp: Vec3): Vec3[] => {
      const targets: Vec3[] = [];
      for (let dx = -6; dx <= 6; dx++) {
        for (let dz = -6; dz <= 6; dz++) {
          if (dx === 0 && dz === 0) continue;
          const pos = wp.offset(dx, 0, dz);
          const b = bot.blockAt(pos);
          if (b && (b.name === "dirt" || b.name === "grass_block")) targets.push(pos.clone());
        }
      }
      return targets;
    };
    const findSurfaceWater = () => {
      const waters = bot.findBlocks({ matching: (b) => b.name === "water", maxDistance: 96, count: 40 });
      for (const wp of waters) {
        if (scanTillable(wp).length >= 4) return bot.blockAt(wp);
      }
      return null;
    };

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
    // 13x13 around the water (was 9x9): a bigger plot = bigger harvests = enough
    // bread to actually feed the team. Food scarcity (workers starving, unable
    // to mine/build) is the universal bottleneck; the farm is the only renewable
    // source, so make each pass yield more.
    for (let dx = -6; dx <= 6; dx++) {
      for (let dz = -6; dz <= 6; dz++) {
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
    for (let i = 0; i < 90 && seedCount < 32 && !signal.aborted; i++) {
      const grass = bot.findBlock({
        matching: (b) => b.name === "short_grass" || b.name === "tall_grass",
        maxDistance: 40,
      });
      if (!grass) break;

      try {
        setMovements(bot);
        await gotoT(bot, new goals.GoalNear(grass.position.x, grass.position.y, grass.position.z, 2));
        await digT(bot, grass);
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
    const target = Math.min(seedCount, farmTargets.length, 32);

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

    // Record the farm so the deterministic override sees hasFarm=true and
    // stops force-firing build_farm every cooldown — the bots can still
    // CHOOSE to farm (harvest/replant) via normal decisions, but they're no
    // longer trapped in a permanent farming loop and can pursue other goals.
    const ms = getBotMemoryStore(bot);
    if (ms)
      ms.addStructure("farm", Math.round(waterPos.x), Math.round(waterPos.y), Math.round(waterPos.z), "Wheat farm");

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

/** pathfinder.goto with a hard timeout — build_farm was the last skill still
 *  hanging to the 240s watchdog (3 events/26h, always at 0% progress) because
 *  its harvest/bake/hoe phases used RAW gotos that block forever when the bot
 *  is stuck underground (the common food-spiral state). Same fix as the rest
 *  of the freeze-bug arc. */
async function gotoT(bot: Bot, goal: InstanceType<typeof goals.GoalNear>, ms = 15000): Promise<void> {
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

/** bot.dig with a hard timeout (see gotoT). */
async function digT(bot: Bot, block: import("prismarine-block").Block): Promise<void> {
  await Promise.race([
    bot.dig(block),
    new Promise<void>((_, rej) =>
      setTimeout(() => {
        try {
          bot.stopDigging();
        } catch {
          /* wasn't digging */
        }
        rej(new Error("dig timeout"));
      }, 12000),
    ),
  ]);
}

/** bot.craft with a hard timeout (see gotoT) — table interaction can stall. */
async function craftT(bot: Bot, recipe: Parameters<Bot["craft"]>[0], count: number, table?: any): Promise<void> {
  await Promise.race([
    bot.craft(recipe, count, table),
    new Promise<void>((_, rej) => setTimeout(() => rej(new Error("craft timeout")), 20000)),
  ]);
}

/** Harvest all mature wheat within 20 blocks. Returns count harvested. */
async function harvestMatureWheat(bot: Bot, signal: AbortSignal, onProgress: (p: any) => void): Promise<number> {
  let harvested = 0;

  // Aggregate budget (freeze-arc LESSON 2): 40 iterations of bounded travel
  // still sums past the 240s skill watchdog — cap the phase's wall-clock.
  const harvestStart = Date.now();
  for (let i = 0; i < 40 && !signal.aborted && Date.now() - harvestStart < 90000; i++) {
    const wheat = bot.findBlock({
      matching: (b) => b.name === "wheat" && b.metadata >= 7,
      maxDistance: 20,
    });
    if (!wheat || !wheat.position) break;

    try {
      setMovements(bot);
      await gotoT(bot, new goals.GoalNear(wheat.position.x, wheat.position.y, wheat.position.z, 2));
      await digT(bot, wheat);
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
    const replantStart = Date.now();
    for (let i = 0; i < 40 && !signal.aborted && Date.now() - replantStart < 45000; i++) {
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
        await gotoT(bot, new goals.GoalNear(farmland.position.x, farmland.position.y, farmland.position.z, 2));
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

/**
 * Bake bread from accumulated wheat (3 wheat -> 1 bread). Needs a crafting
 * table (3-wide recipe). This is the step that finally closes the farm->food
 * loop. Done in-skill to dodge the blacklisted `craft:bread` action.
 */
async function bakeBread(
  bot: Bot,
  signal: AbortSignal,
  onProgress: (p: any) => void,
  stashPos?: { x: number; y: number; z: number },
): Promise<number> {
  if (signal.aborted) return 0;
  // Pool wheat from the shared stash before baking. Harvests are small (~1-2
  // wheat/pass) and scattered across bots, so no single baker reaches the 3
  // wheat a loaf needs — 81 wheat harvested/run yet only 4 bread baked, and the
  // team starved (1214 eat-fails). Withdraw the team's pooled wheat to bake a
  // real batch. (shouldKeep now lets wheat surplus deposit so it pools here.)
  if (stashPos && countItem(bot, "wheat") < 9) {
    const { withdrawStash } = await import("./stash.js");
    try {
      await withdrawStash(bot, stashPos, "wheat", 18);
    } catch {
      /* none pooled yet — bake whatever we have */
    }
  }
  const wheat = countItem(bot, "wheat");
  if (wheat < 3) return 0;

  const mcData = mcDataLoader(bot.version);
  const breadItem = mcData.itemsByName["bread"];
  if (!breadItem) return 0;
  const count = Math.floor(wheat / 3);

  // Bread is a 3-wide recipe → requires a crafting table.
  const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 48 });
  if (!table || !table.position) return 0; // no table in reach — bake next cycle near one

  onProgress({
    skillName: "build_farm",
    phase: "Baking bread",
    progress: 0.95,
    message: `Baking ${count} bread from ${wheat} wheat...`,
    active: true,
  });

  setMovements(bot);
  try {
    await gotoT(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
  } catch {
    /* try crafting from where we are */
  }

  const recipe = bot.recipesFor(breadItem.id, null, count, table)[0];
  if (!recipe) return 0;

  const before = countItem(bot, "bread");
  try {
    await craftT(bot, recipe, count, table);
  } catch {
    return 0;
  }
  return countItem(bot, "bread") - before;
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
          await craftT(bot, recipe, Math.min(2, log.count));
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
        await craftT(bot, recipe, 1);
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
        await craftT(bot, recipe, 1);
        return;
      } catch {
        continue;
      }
    }

    const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
    if (table) {
      setMovements(bot);
      try {
        await gotoT(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
      } catch {
        /* try anyway */
      }
      recipe = bot.recipesFor(mcItem.id, null, 1, table)[0];
      if (recipe) {
        try {
          await craftT(bot, recipe, 1, table);
          return;
        } catch {
          continue;
        }
      }
    }
  }
}
