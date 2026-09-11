import type { Block } from "prismarine-block";
import type { Bot } from "mineflayer";
import { baseMoves, collectNearbyDrops, safeGoto } from "../bot/navigation.js";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import mcDataLoader from "minecraft-data";
import { getBotMemoryStore } from "../bot/memory-registry.js";
import { config } from "../config.js";
/** Below this the water is an aquifer and the dirt is unlit; the farm belongs on the surface. */
const SURFACE_WATER_MIN_Y = 50;
/** Tillable dirt/grass blocks a water block needs around it to count as a farm site. */
const MIN_TILLABLE_RING = 3;

/**
 * Cut ripe wheat within 20 blocks and bake what we hold; returns the skill
 * result when anything was harvested or baked, else null.
 */
async function harvestAndBake(
  bot: Bot,
  signal: AbortSignal,
  onProgress: (p: any) => void,
  stashPos: { x: number; y: number; z: number } | undefined,
): Promise<SkillResult | null> {
  const harvested = await harvestMatureWheat(bot, signal, onProgress);
  const baked = await bakeBread(bot, signal, onProgress, stashPos);
  if (harvested > 0 || baked > 0) {
    const wheatNow = bot.inventory
      .items()
      .filter((i) => i.name === "wheat")
      .reduce((s, i) => s + i.count, 0);
    const breadNote =
      baked > 0
        ? `Baked ${baked} bread — food secured! 🍞`
        : wheatNow >= 3 && lastBakeProblem
          ? `Bake failed: ${lastBakeProblem}.`
          : "Not enough wheat to bake bread yet (need 3+); farm is still growing.";
    // STOCK THE PANTRY. Baking closed the wheat→bread gap, but the loaves
    // sat in the baker's pack (shouldKeep holds 6 food) and never reached
    // the shared chests — an RCON audit found 3 cooked items across 60
    // chests while miners starved 300 blocks out. Deposit the surplus now,
    // beside the crafting table where baking just happened. shouldKeep keeps
    // the baker's own 6-food buffer; everything over that pools for the team.
    let bankedNote = "";
    const breadHeld = () =>
      bot.inventory
        .items()
        .filter((i) => i.name === "bread")
        .reduce((s, i) => s + i.count, 0);
    if (stashPos && !signal.aborted && breadHeld() > 6) {
      try {
        const { depositStash } = await import("./stash.js");
        const keep = [
          { name: "sapling", minCount: 16 },
          { name: "hoe", minCount: 1 },
          { name: "sword", minCount: 1 },
          { name: "axe", minCount: 1 },
        ];
        await depositStash(bot, stashPos, keep, 0, false);
        bankedNote = " Surplus bread banked to the pantry.";
      } catch {
        /* stash unreachable this pass — bread stays in the pack, banks next time */
      }
    }
    return {
      success: true,
      message: `${harvested > 0 ? `Harvested ${harvested} wheat. ` : ""}${breadNote}${bankedNote} The farm cycle continues!`,
      stats: { wheatHarvested: harvested, breadBaked: baked },
    };
  }

  return null;
}

export const buildFarmSkill: Skill = {
  name: "build_farm",
  description:
    "Build a wheat farm near water. Crafts a hoe, collects seeds, tills soil, plants crops. If mature wheat exists nearby, harvests and replants instead. Takes ~2 minutes.",
  params: {},
  // The clock doctrine, applied late: the hoe withdrawal plus a stash trip
  // plus tilling walks blew the default 240s watchdog mid-planting the very
  // first time the tool step succeeded — the run died at 48% with wheat
  // half in the ground. Tilled and planted cells persist between visits, so
  // a longer envelope converts straight into planted rows.
  timeoutMs: 480_000,

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    // --- Step 0: Harvest mature wheat, then BAKE BREAD ---
    // The loop used to dead-end here: wheat was harvested but never turned into
    // bread (wheat isn't edible), so the team starved beside a working farm.
    // Bake any accumulated wheat (>=3) into bread — done inside the skill so it
    // bypasses the blacklisted `craft:bread` action.
    const stashPos = params?.stashPos as { x: number; y: number; z: number } | undefined;
    const early = await harvestAndBake(bot, signal, onProgress, stashPos);
    if (early) return early;

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
        // XZ-only arrival: the site sits at a waterline BELOW the village
        // (y=58 vs ground 71), and a 3D GoalNear demanded the bot also reach
        // that exact depth — the slope down defeated the pathfinder and every
        // farm run died "Couldn't reach the farm site" at the NEW site too.
        // The farm only needs to be near the spot horizontally; the 96-block
        // water search finds the pond from whatever height the bot walks in at.
        setMovements(bot); // no digging, no big drops: the straight line to the site crosses old shafts
        await safeGoto(bot, new goals.GoalNearXZ(fx0, fz0, 8), 60000);
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
      // 9, aligned above the walk's own GoalNear radius of 8: the walk can
      // SUCCEED at 7-8 blocks out and the old >6 check then failed the whole
      // run as "couldn't reach" — a spurious loss, since the water search that
      // follows scans 96 blocks anyway.
      if (bot.entity.position.distanceTo(new Vec3(fx0, bot.entity.position.y, fz0)) > 9) {
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

    // The XZ-only site walk accepts any depth, and the ground around the
    // village is riddled with old shafts, so a bot can "arrive" forty blocks
    // under the pond. Farming there wastes seeds in the dark; say so.
    if (bot.entity.position.y < SURFACE_WATER_MIN_Y) {
      return {
        success: false,
        message: `Ended up underground at y=${Math.floor(bot.entity.position.y)} on the way to the farm site — the pond is on the surface. Climb out first, then try build_farm again.`,
      };
    }

    // Harvest AGAIN now that we stand at the field. The scan above ran from
    // wherever the bot started (often the village, 30 blocks off) with a
    // 20-block radius, so ripe wheat at the site was never cut: RCON found
    // five age-7 plots while every bot sat at food 0.
    const late = await harvestAndBake(bot, signal, onProgress, stashPos);
    if (late) return late;

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
      // The chest before the forest — the pickaxe lesson applied to
      // farming: Flora stood hoeless beside 983 banked planks while this
      // skill went hunting trees on deforested ground and the village
      // starved. Ask the stash for a hoe, then for plank stock, before
      // ever walking to a tree.
      try {
        const { withdrawStash } = await import("./stash.js");
        const { STASH_POS } = await import("../bot/role.js");
        const nearStash = Math.hypot(bot.entity.position.x - STASH_POS.x, bot.entity.position.z - STASH_POS.z) < 60;
        if (nearStash) {
          for (const want of ["stone_hoe", "wooden_hoe", "iron_hoe"]) {
            await Promise.race([
              withdrawStash(bot, STASH_POS, want, 1),
              new Promise<void>((r) => setTimeout(r, 45_000)),
            ]).catch(() => {});
            if (bot.inventory.items().some((i) => i.name.endsWith("_hoe"))) break;
          }
          if (!bot.inventory.items().some((i) => i.name.endsWith("_hoe"))) {
            await Promise.race([
              withdrawStash(bot, STASH_POS, "oak_planks", 8),
              new Promise<void>((r) => setTimeout(r, 45_000)),
            ]).catch(() => {});
            await craftHoe(bot, signal);
          }
          hoe = bot.inventory.items().find((i) => i.name.endsWith("_hoe"));
        }
      } catch {
        /* stash unavailable — the tree fallback below still applies */
      }
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
    // A plot is only tillable if its top face is CLEAR. The farm site sits in
    // the built-up village, so most "dirt/grass" it found had a chest, cobble,
    // or sapling sitting on it (FarmDebug: became=dirt above=chest/cobblestone)
    // — a covered block never converts to farmland, which is why 4 of 5 plots
    // silently failed and the team starved. Require air (or the short grass a
    // seed placement clears) directly above.
    const CLEAR_ABOVE = new Set(["air", "cave_air", "short_grass", "tall_grass", "grass", "fern"]);
    const tillable = (pos: Vec3): boolean => {
      const b = bot.blockAt(pos);
      // Empty farmland counts: RCON found 23 tilled plots with only 9 planted
      // while the farmer held 78 seeds, because a tilled plot is no longer
      // "dirt" and was skipped by both the site scan and the planting loop.
      if (!b || (b.name !== "dirt" && b.name !== "grass_block" && b.name !== "farmland")) return false;
      const above = bot.blockAt(pos.offset(0, 1, 0));
      return !!above && CLEAR_ABOVE.has(above.name);
    };
    const scanTillable = (wp: Vec3): Vec3[] => {
      const targets: Vec3[] = [];
      for (let dx = -6; dx <= 6; dx++) {
        for (let dz = -6; dz <= 6; dz++) {
          if (dx === 0 && dz === 0) continue;
          const pos = wp.offset(dx, 0, dz);
          if (tillable(pos)) targets.push(pos.clone());
        }
      }
      return targets;
    };
    // count 200 (was 40): the nearest 40 water blocks are all one pond, and
    // when that pond is ringed by sand or cobble the search never reached the
    // lake behind it. The FarmDebug line says what the search actually saw —
    // RCON found water 3 blocks from the farm site while this reported none.
    const findSurfaceWater = () => {
      // Surface water only: with the site walk dropping bots into old shafts,
      // the search once picked an aquifer at y=22 and Flora tilled and seeded
      // dirt at y=37 in the dark, where wheat never grows.
      // (Filter on the returned positions: findBlocks also runs `matching`
      // against palette blocks that carry no position, and reading .position
      // there crashed the skill and got it retired.)
      const waters = bot
        .findBlocks({ matching: (b) => b.name === "water", maxDistance: 96, count: 200 })
        .filter((p) => p.y >= SURFACE_WATER_MIN_Y);
      let bestN = -1;
      let bestWp: Vec3 | null = null;
      for (const wp of waters) {
        const n = scanTillable(wp).length;
        // 3 plots (was 4): FarmDebug at the site pond read "best had 3
        // tillable neighbours" three runs in a row and called it no water.
        if (n >= MIN_TILLABLE_RING) return bot.blockAt(wp);
        if (n > bestN) {
          bestN = n;
          bestWp = wp;
        }
      }
      const here = bot.entity.position.floored();
      const ring = bestWp
        ? [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]
            .map(([dx, dz]) => bot.blockAt(bestWp!.offset(dx, 0, dz))?.name ?? "?")
            .join("/")
        : "-";
      console.log(
        `[FarmDebug] ${bot.username} at ${here.x},${here.y},${here.z}: ${waters.length} water blocks within 96` +
          (waters.length ? ` (nearest ${waters[0].x},${waters[0].y},${waters[0].z})` : "") +
          `, best had ${Math.max(bestN, 0)} tillable neighbours` +
          (bestWp ? ` at ${bestWp.x},${bestWp.y},${bestWp.z} ring ${ring}` : ""),
      );
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
        const seen = bot
          .findBlocks({ matching: (b) => b.name === "water", maxDistance: 96, count: 200 })
          .filter((p) => p.y >= SURFACE_WATER_MIN_Y).length;
        return {
          success: false,
          message:
            seen > 0
              ? `Found ${seen} surface water blocks within 96 but none with ${MIN_TILLABLE_RING}+ clear dirt beside it to till. Try a grassy shoreline.`
              : "No water found within 96 blocks! Explore to find a river or pond.",
        };
      }
    }

    // Pre-scan a 9x9 area around the water for tillable dirt/grass at the same Y level.
    // Pre-scanning gives a fixed list to iterate — no re-searching mid-loop that could
    // accidentally use a different water source.
    const waterPos = water.position;
    if (!waterPos) {
      return { success: false, message: "Water block has no position — chunk may not be loaded. Try again." };
    }
    // Gather plots from EVERY surface water block in range, nearest first:
    // the field spans several water blocks at different heights (RCON: 23
    // farmland blocks around 300-310,-308..-320 at y56-60), and the old
    // 13x13 ring around a single water block yielded 4 targets from a field
    // of 23.
    const seen = new Set<string>();
    const farmTargets: Vec3[] = [];
    const waterCols = bot
      .findBlocks({ matching: (b) => b.name === "water", maxDistance: 96, count: 200 })
      .filter((p) => p.y >= SURFACE_WATER_MIN_Y)
      .sort((a, b) => a.distanceTo(waterPos) - b.distanceTo(waterPos));
    for (const wp of [waterPos, ...waterCols]) {
      for (const pos of scanTillable(wp)) {
        const key = `${pos.x},${pos.y},${pos.z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        farmTargets.push(pos);
      }
      if (farmTargets.length >= 48) break;
    }
    farmTargets.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
    if (farmTargets.length === 0) {
      return {
        success: false,
        message:
          "No CLEAR tillable dirt near the water — the plots here are built over (chests, cobble) or the shore is sand/stone. Explore to open grass near a river.",
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

    // Why plots are skipped, for the FarmDebug summary: of ~21 targets a pass
    // tilled 11 and seeded 1-3, and the rest fell through silent continues.
    const skips = {
      notPlot: 0,
      reach: 0,
      standing: 0,
      noHoe: 0,
      placeRejected: 0,
      errors: {} as Record<string, number>,
    };
    for (const targetPos of farmTargets) {
      if (planted >= target || signal.aborted) break;

      // Skip if block was already tilled by a previous iteration
      const currentBlock = bot.blockAt(targetPos);
      if (
        !currentBlock ||
        (currentBlock.name !== "dirt" && currentBlock.name !== "grass_block" && currentBlock.name !== "farmland")
      ) {
        skips.notPlot++;
        continue;
      }
      const alreadyTilled = currentBlock.name === "farmland";

      try {
        setMovements(bot);
        // Reach 2, not 1: tilling only needs the block within arm's reach
        // (~4.5), and demanding a cell exactly one block away made the
        // pathfinder fail to stand on ~80% of shore plots (planted 1 of 5 per
        // run, "navigation or tilling failed"). Standing two out still tills.
        await Promise.race([
          bot.pathfinder.goto(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 2)),
          new Promise<void>((_, rej) =>
            setTimeout(() => {
              bot.pathfinder.stop();
              rej(new Error("timeout"));
            }, 8000),
          ),
        ]);
        if (targetPos.distanceTo(bot.entity.position) > 4.4) {
          skips.reach++;
          continue; // out of till reach
        }

        // Step OFF the plot before tilling. GoalNear(2) happily parks the bot
        // ON the target block, and a bot standing on its own fresh farmland
        // tramples it back to dirt with the pathfinder's constant hops — every
        // FarmDebug failure this run tilled farmland that was gone by the seed
        // placement ("blockUpdate did not fire"), and RCON found neither wheat
        // nor farmland there afterward. Till from beside, never from on top.
        const feet = bot.entity.position.floored();
        if (feet.x === targetPos.x && feet.z === targetPos.z) {
          for (const [ox, oz] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const ground = bot.blockAt(targetPos.offset(ox, 0, oz));
            const standIn = bot.blockAt(targetPos.offset(ox, 1, oz));
            if (!ground || ground.name === "water" || ground.name === "air") continue;
            if (!standIn || (standIn.name !== "air" && !standIn.name.includes("grass"))) continue;
            await Promise.race([
              bot.pathfinder.goto(new goals.GoalBlock(targetPos.x + ox, targetPos.y + 1, targetPos.z + oz)),
              new Promise<void>((_, rej) =>
                setTimeout(() => {
                  bot.pathfinder.stop();
                  rej(new Error("timeout"));
                }, 5000),
              ),
            ]).catch(() => {});
            break;
          }
          const f2 = bot.entity.position.floored();
          if (f2.x === targetPos.x && f2.z === targetPos.z) {
            skips.standing++;
            continue; // still on it — skip, don't trample
          }
        }

        // Equip hoe and till (skip the hoe on a plot that is already farmland)
        if (!alreadyTilled) {
          hoe = bot.inventory.items().find((it) => it.name.endsWith("_hoe"));
          if (!hoe) {
            skips.noHoe++;
            break;
          }
          await bot.equip(hoe, "hand");
          await bot.lookAt(targetPos.offset(0.5, 0.5, 0.5));
          await bot.activateBlock(currentBlock);
          await bot.waitForTicks(4);
        }

        // Check if it became farmland
        const result = bot.blockAt(targetPos);
        // INSTRUMENTATION: 4 of 5 dirt/grass plots never became farmland even at
        // reach — pin down whether the till itself fails (result still dirt), a
        // block overhead blocks it, or the seed placement is the loser.
        const above = bot.blockAt(targetPos.offset(0, 1, 0));
        console.log(
          `[FarmDebug] till ${targetPos.x},${targetPos.y},${targetPos.z}: was=${currentBlock.name} became=${result?.name} above=${above?.name} dist=${targetPos.distanceTo(bot.entity.position).toFixed(1)}`,
        );
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
            } catch (e) {
              // placeBlock's confirmation event can miss even when the seed
              // landed — trust the world, not the event, before calling it lost.
              await bot.waitForTicks(4);
              const crop = bot.blockAt(targetPos.offset(0, 1, 0));
              if (crop && crop.name === "wheat") {
                planted++;
              } else {
                skips.placeRejected++;
                console.log(`[FarmDebug] plant failed at ${targetPos.x},${targetPos.z}: ${(e as Error).message}`);
              }
            }
          }
        }
      } catch (e) {
        const m = (e instanceof Error ? e.message : String(e)).slice(0, 60);
        skips.errors[m] = (skips.errors[m] ?? 0) + 1;
        continue;
      }
    }
    const skipSummary = `reach=${skips.reach} standing=${skips.standing} notPlot=${skips.notPlot} noHoe=${skips.noHoe} placeRejected=${skips.placeRejected} errors=${JSON.stringify(skips.errors)}`;
    console.log(
      `[FarmDebug] ${bot.username} planting: ${planted}/${target} of ${farmTargets.length} plots; skipped ${skipSummary}`,
    );

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
  const moves = baseMoves(bot);
  moves.canDig = false;
  moves.maxDropDown = 3; // the shore slope is fine; an old shaft is not (Flora "ended up underground at y=16")
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
    lastBakeProblem = "";
    const picked = await collectDrops(bot, new Set(["wheat", "wheat_seeds"]), 10, 20_000);
    if (picked > 0) console.log(`[FarmDebug] ${bot.username}: walked to ${picked} dropped wheat/seed stacks`);
    let replanted = 0;
    const replantStart = Date.now();
    for (let i = 0; i < 40 && !signal.aborted && Date.now() - replantStart < 45000; i++) {
      // (Positions first, then look above: a findBlock predicate that calls
      // bot.blockAt silently matches nothing, so replanting never ran.)
      const farmland =
        bot
          .findBlocks({ matching: (b) => b.name === "farmland", maxDistance: 20, count: 64 })
          .map((p) => bot.blockAt(p))
          .find((b) => !!b && bot.blockAt(b.position.offset(0, 1, 0))?.name === "air") ?? null;
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
/** Crafting only works with the table within about 4.5 blocks. */
const TABLE_REACH = 4.5;

/**
 * A crafting table the bot can actually use: walk to the nearest ones in
 * turn and return the first within reach; if none is reachable (the village
 * tables sit among chests and cobble the pathfinder times out on — Flora
 * stood 8 blocks from one and the craft window never opened), craft and
 * place a new table from pocket planks beside the bot.
 */
async function reachTable(bot: Bot): Promise<Block | null> {
  const near = () =>
    bot
      .findBlocks({ matching: (b) => b.name === "crafting_table", maxDistance: 48, count: 6 })
      .map((p) => bot.blockAt(p))
      .filter((b): b is Block => !!b)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
  for (const table of near()) {
    if (bot.entity.position.distanceTo(table.position) <= TABLE_REACH) return table;
    setMovements(bot);
    try {
      await gotoT(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 12_000);
    } catch {
      /* try the next table */
    }
    if (bot.entity.position.distanceTo(table.position) <= TABLE_REACH) return table;
    console.log(
      `[FarmDebug] ${bot.username}: table at ${table.position} unreachable (${Math.round(bot.entity.position.distanceTo(table.position))} blocks) — trying the next`,
    );
  }
  // Place our own.
  const mcData = mcDataLoader(bot.version);
  const planks = bot.inventory
    .items()
    .filter((i) => i.name.endsWith("_planks"))
    .reduce((s, i) => s + i.count, 0);
  if (!bot.inventory.items().some((i) => i.name === "crafting_table")) {
    if (planks < 4) {
      console.log(`[FarmDebug] ${bot.username}: no reachable table and only ${planks} planks to make one`);
      return null;
    }
    const rec = bot.recipesFor(mcData.itemsByName.crafting_table.id, null, 1, null)[0];
    if (rec) await bot.craft(rec, 1).catch(() => {});
  }
  const item = bot.inventory.items().find((i) => i.name === "crafting_table");
  if (!item) return null;
  await bot.equip(item, "hand").catch(() => {});
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const floor = bot.blockAt(bot.entity.position.offset(dx, -1, dz));
    const spot = bot.blockAt(bot.entity.position.offset(dx, 0, dz));
    if (floor && floor.boundingBox === "block" && spot && (spot.name === "air" || spot.name === "cave_air")) {
      try {
        await bot.placeBlock(floor, new Vec3(0, 1, 0));
        const placed = bot.blockAt(bot.entity.position.offset(dx, 0, dz));
        if (placed && placed.name === "crafting_table") {
          console.log(`[FarmDebug] ${bot.username}: placed a fresh crafting table at ${placed.position}`);
          return placed;
        }
      } catch {
        /* next side */
      }
    }
  }
  return null;
}

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
  const table = await reachTable(bot);
  if (!table || !table.position) {
    lastBakeProblem = `no reachable crafting table near ${bot.entity.position.floored()} and no planks to place one`;
    console.log(`[FarmDebug] ${bot.username}: bake skipped — ${lastBakeProblem}`);
    return 0;
  }

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
  } catch (err) {
    console.log(
      `[FarmDebug] ${bot.username}: couldn't reach the table at ${table.position} (${err instanceof Error ? err.message : String(err)}) — trying from ${Math.round(bot.entity.position.distanceTo(table.position))} blocks`,
    );
  }

  const recipe = bot.recipesFor(breadItem.id, null, count, table)[0];
  if (!recipe) {
    lastBakeProblem = `no bread recipe resolved with ${wheat} wheat`;
    console.log(`[FarmDebug] ${bot.username}: ${lastBakeProblem}`);
    return 0;
  }

  const before = countItem(bot, "bread");
  try {
    await craftT(bot, recipe, count, table);
  } catch (err) {
    lastBakeProblem = `craft threw: ${err instanceof Error ? err.message : String(err)} (table ${Math.round(bot.entity.position.distanceTo(table.position))} blocks away)`;
    console.log(`[FarmDebug] ${bot.username}: ${lastBakeProblem}`);
    return 0;
  }
  const made = countItem(bot, "bread") - before;
  if (made <= 0) {
    lastBakeProblem = `craft returned but bread count did not rise (wheat now ${countItem(bot, "wheat")})`;
    console.log(`[FarmDebug] ${bot.username}: ${lastBakeProblem}`);
  }
  return made;
}

/** Why the last bake produced nothing, for the skill's result message. */
let lastBakeProblem = "";

/** Walk over dropped items of the given names nearby and pick them up. Wheat
 * and seeds fly a block or two from a cut plant; the harvester stood 2 blocks
 * off and left 2 of 5 wheat on the ground. */
async function collectDrops(bot: Bot, names: Set<string>, radius: number, budgetMs: number): Promise<number> {
  const until = Date.now() + budgetMs;
  let walked = 0;
  while (Date.now() < until) {
    const drop = Object.values(bot.entities).find((e) => {
      if (e.name !== "item" || !e.position) return false;
      const it = e.getDroppedItem?.();
      return !!it && names.has(it.name) && e.position.distanceTo(bot.entity.position) < radius;
    });
    if (!drop) break;
    const d = drop.position;
    try {
      setMovements(bot);
      await gotoT(bot, new goals.GoalNear(Math.floor(d.x), Math.floor(d.y), Math.floor(d.z), 0));
      walked++;
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return walked;
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

    const table = await reachTable(bot);
    if (table) {
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
