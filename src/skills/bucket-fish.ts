import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto } from "../bot/navigation.js";
import { Vec3 } from "vec3";

/**
 * bucket_fish — earn "Tactical Fishing" (husbandry/tactical_fishing): scoop a
 * live fish into a water bucket. An RCON census on 2026-09-17 found 18 salmon
 * within 150 blocks of the village and three bots carrying water buckets, so
 * the point is a short swim away. The skill fills an empty bucket from nearby
 * water when needed, walks to the nearest fish in view, and uses the bucket on
 * it the way a player right-clicks a fish.
 */

const FISH = new Set(["salmon", "cod", "tropical_fish", "pufferfish"]);
const FISH_BUCKETS = /^(salmon|cod|tropical_fish|pufferfish)_bucket$/;

function has(bot: Bot, name: string): boolean {
  return bot.inventory.items().some((i) => i.name === name);
}

function fishBucket(bot: Bot): string | undefined {
  return bot.inventory.items().find((i) => FISH_BUCKETS.test(i.name))?.name;
}

export function nearestFish(bot: Bot, radius = 64) {
  const me = bot.entity?.position;
  if (!me) return null;
  let best: ReturnType<Bot["nearestEntity"]> = null;
  let bestD = radius;
  for (const e of Object.values(bot.entities)) {
    if (!e.name || !FISH.has(e.name) || !e.position) continue;
    const d = e.position.distanceTo(me);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

export const bucketFishSkill: Skill = {
  name: "bucket_fish",
  description:
    "Scoop a live fish (salmon, cod) into a water bucket for the Tactical Fishing advancement. Needs a bucket and a fish in view; rivers near the village have salmon.",
  params: {},
  timeoutMs: 180_000,

  estimateMaterials() {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const step = (progress: number, message: string) =>
      onProgress({ skillName: "bucket_fish", phase: "Fishing", progress, message, active: true });
    bot.pathfinder.setMovements(baseMoves(bot));
    const submergedMs = makeSubmersionClock(bot);

    if (fishBucket(bot)) {
      return { success: true, message: `Already holding a ${fishBucket(bot)} (Tactical Fishing).` };
    }

    // A water bucket, or an empty bucket filled from the nearest water.
    if (!has(bot, "water_bucket")) {
      if (!has(bot, "bucket")) {
        return {
          success: false,
          message: "No bucket aboard. Craft one (3 iron ingots) or withdraw one from the stash first.",
        };
      }
      const water = bot.findBlock({ matching: (b) => b.name === "water", maxDistance: 24 });
      if (!water) return { success: false, message: "Have an empty bucket but no water within 24 blocks to fill it." };
      step(0.1, "Filling the bucket...");
      await safeGoto(
        bot,
        new goals.GoalNear(water.position.x, water.position.y + 1, water.position.z, 2),
        30_000,
      ).catch(() => {});
      const bucket = bot.inventory.items().find((i) => i.name === "bucket");
      if (bucket) await bot.equip(bucket, "hand").catch(() => {});
      await bot.lookAt(water.position.offset(0.5, 0.5, 0.5), true).catch(() => {});
      bot.activateItem();
      await new Promise((r) => setTimeout(r, 600));
      bot.deactivateItem();
      await new Promise((r) => setTimeout(r, 400));
      if (!has(bot, "water_bucket"))
        return { success: false, message: "Could not fill the bucket from the water here." };
    }

    // Run 686: Mason waded after a salmon at y=60 and went to 3 air under
    // the lake while the walk goal sat on the fish. Never dive for a fish:
    // take only fish near the surface, walk to a standing spot on the shore
    // within reach, and use the bucket from there.
    // Run 687: every salmon seen was "too deep" with the surface test at two
    // blocks; salmon cruise two to three blocks under the surface. Three
    // blocks of water above the fish is still within reach from a shallow
    // standing spot.
    const nearSurface = (e: { position: Vec3 }) =>
      [1, 2, 3, 4, 5, 6].some((dy) => /air/.test(bot.blockAt(e.position.offset(0, dy, 0))?.name ?? ""));
    const shoreSpot = (e: { position: Vec3 }): Vec3 | null => {
      const c = e.position.floored();
      let best: Vec3 | null = null;
      let bestD = 3.4;
      for (let dx = -4; dx <= 4; dx++)
        for (let dz = -4; dz <= 4; dz++)
          for (let dy = -1; dy <= 3; dy++) {
            const feet = c.offset(dx, dy, dz);
            const under = bot.blockAt(feet.offset(0, -1, 0));
            const at = bot.blockAt(feet);
            const head = bot.blockAt(feet.offset(0, 1, 0));
            // Solid footing with the head in air; feet may stand in one
            // block of water (a player wades to the knees to reach a fish).
            if (!under || under.boundingBox !== "block") continue;
            if (!at || (at.name !== "air" && at.name !== "water") || !head || head.name !== "air") continue;
            const d = feet.offset(0.5, 1.6, 0.5).distanceTo(e.position);
            if (d < bestD) {
              bestD = d;
              best = feet;
            }
          }
      return best;
    };
    let fish = nearestFish(bot);
    if (!fish) {
      return {
        success: false,
        message:
          "No fish in view. Walk to a river or lake first (salmon live in rivers near the village), then try again.",
      };
    }

    const deadline = Date.now() + 120_000;
    let tries = 0;
    const tried = new Set<number>();
    let skippedDeep = 0;
    while (fish && Date.now() < deadline && !signal.aborted && tries < 6) {
      tries++;
      tried.add(fish.id);
      if (!nearSurface(fish)) {
        skippedDeep++;
        fish = nearestFishExcept(bot, tried);
        continue;
      }
      const spot = shoreSpot(fish);
      let approached = false;
      if (spot) {
        step(
          0.2 + tries * 0.1,
          `Walking to the shore beside a ${fish.name} ${fish.position.distanceTo(bot.entity.position).toFixed(0)} blocks away...`,
        );
        await safeGoto(bot, new goals.GoalBlock(spot.x, spot.y, spot.z), 30_000).catch(() => {});
        approached = fish.isValid && fish.position.distanceTo(bot.entity.position.offset(0, 1.6, 0)) <= 3.5;
      }
      if (!approached && fish.isValid) {
        // Runs 687-688: every salmon sat two to five blocks under a lake with
        // no shore block within reach, so the shore walk never swung. Do what
        // a player does: swim on the surface above the fish with jump held,
        // then dip for the swing when the fish is a little deeper. Air stays
        // above 12 or the dip is skipped; the drown reflex still owns the keys
        // if anything goes wrong.
        approached = await surfaceSwimTo(bot, fish, signal, step, tries, submergedMs);
      }
      if (!fish.isValid || !approached || submergedMs() > 8000) {
        const gap = fish.isValid ? fish.position.distanceTo(bot.entity.position.offset(0, 1.6, 0)) : 99;
        console.log(
          `[FishDebug] ${bot.username}: ${fish.isValid ? fish.name : "fish"} out of reach (gap ${gap.toFixed(1)}, under ${submergedMs()} ms, depth ${fish.isValid ? depthBelowSurface(bot, fish.position) : "?"}); next fish`,
        );
        fish = nearestFishExcept(bot, tried);
        continue;
      }
      const wb = bot.inventory.items().find((i) => i.name === "water_bucket");
      if (!wb) return { success: false, message: "Lost the water bucket on the way." };
      await bot.equip(wb, "hand").catch(() => {});
      await bot.lookAt(fish.position.offset(0, 0.2, 0), true).catch(() => {});
      for (let swing = 0; swing < 3 && fish.isValid && !fishBucket(bot); swing++) {
        try {
          await bot.activateEntityAt(fish, fish.position);
        } catch {
          /* fall through to the plain interact */
        }
        await new Promise((r) => setTimeout(r, 300));
        if (!fishBucket(bot)) {
          try {
            await bot.activateEntity(fish);
          } catch {
            /* the fish moved; try again */
          }
        }
        await new Promise((r) => setTimeout(r, 700));
        console.log(
          `[FishDebug] ${bot.username}: swing ${swing + 1} at ${fish.name} gap ${fish.position.distanceTo(bot.entity.position.offset(0, 1.6, 0)).toFixed(1)} held=${bot.heldItem?.name ?? "none"} result=${fishBucket(bot) ?? "nothing"}`,
        );
      }
      bot.setControlState("forward", false);
      if (/water/.test(bot.blockAt(bot.entity.position)?.name ?? "")) bot.setControlState("jump", true);
      const got = fishBucket(bot);
      if (got) {
        bot.clearControlStates();
        console.log(`[Fish] ${bot.username}: scooped a ${fish.name} into a bucket at ${fish.position.floored()}`);
        return { success: true, message: `Scooped a ${fish.name} into a bucket (Tactical Fishing).`, stats: { tries } };
      }
      fish = nearestFishExcept(bot, tried);
    }
    return {
      success: false,
      message: `Tried ${tries} fish (${skippedDeep} too deep to reach from shore) and none went into the bucket. invoke_skill {"skill":"bucket_fish"} again to retry.`,
    };
  },
};

function nearestFishExcept(bot: Bot, skip: Set<number>) {
  const me = bot.entity?.position;
  if (!me) return null;
  let best: ReturnType<Bot["nearestEntity"]> = null;
  let bestD = 64;
  for (const e of Object.values(bot.entities)) {
    if (!e.name || !FISH.has(e.name) || !e.position || skip.has(e.id)) continue;
    const d = e.position.distanceTo(me);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/** Run 690: bot.oxygenLevel read 7 and 8 while Mason stood on dry land 38
 *  blocks from the water, so every air guard refused. The client's air
 *  value lags the server; the skill now times its own submersion instead:
 *  continuous milliseconds with the head under water, 0 when the head is in
 *  air. A player has about 15 s of breath, so the guards use 8 s. */
export function makeSubmersionClock(bot: Bot): () => number {
  let since = 0;
  return () => {
    const head = bot.blockAt(bot.entity.position.offset(0, 1.6, 0));
    const under = !!head && /water/.test(head.name);
    if (!under) {
      since = 0;
      return 0;
    }
    if (!since) since = Date.now();
    return Date.now() - since;
  };
}

/** Blocks of water between the fish and the first air above it (0 = at the surface). */
function depthBelowSurface(bot: Bot, p: Vec3): number {
  for (let dy = 1; dy <= 8; dy++) {
    const b = bot.blockAt(p.offset(0, dy, 0));
    if (!b || !/water/.test(b.name)) return dy - 1;
  }
  return 8;
}

/** Swim on the surface toward the fish with jump held, then dip for the swing
 *  when the fish is up to three blocks down. Returns true when the fish is
 *  within reach of the eyes. Never runs the air under 12. */
async function surfaceSwimTo(
  bot: Bot,
  fish: { position: Vec3; isValid: boolean; name?: string },
  signal: AbortSignal,
  step: (progress: number, message: string) => void,
  tries: number,
  submergedMs: () => number,
): Promise<boolean> {
  const inWater = () => /water/.test(bot.blockAt(bot.entity.position)?.name ?? "");
  const depth = depthBelowSurface(bot, fish.position);
  // Run 689: every salmon was four to six blocks down, past the three-block
  // dip. A player dives that far on one breath; a bot at 16+ air has 12 s
  // under water before the reflex takes over, and the dive below is capped
  // at 4.5 s.
  if (depth > 6) {
    console.log(`[FishDebug] ${bot.username}: ${fish.name} is ${depth} blocks under the surface; too deep to dive for`);
    return false;
  }
  // Get into the water first: the nearest water block to the bot, then the
  // pathfinder walks to its edge.
  if (!inWater()) {
    const water = bot.findBlock({ matching: (b) => b.name === "water", maxDistance: 24 });
    if (!water) return false;
    step(0.2 + tries * 0.1, `Wading in toward a ${fish.name}...`);
    await safeGoto(bot, new goals.GoalNear(water.position.x, water.position.y + 1, water.position.z, 1), 20_000).catch(
      () => {},
    );
  }
  const end = Date.now() + 25_000;
  let reached = false;
  while (Date.now() < end && fish.isValid && !signal.aborted) {
    if (submergedMs() > 8000) break;
    const me = bot.entity.position;
    const flat = Math.hypot(fish.position.x - me.x, fish.position.z - me.z);
    if (flat <= 1.2) {
      reached = true;
      break;
    }
    const surfaceY = fish.position.y + depthBelowSurface(bot, fish.position) + 0.5;
    await bot.lookAt(new Vec3(fish.position.x, surfaceY, fish.position.z), true).catch(() => {});
    bot.setControlState("forward", true);
    bot.setControlState("jump", true);
    await new Promise((r) => setTimeout(r, 400));
  }
  bot.setControlState("forward", false);
  if (!reached || !fish.isValid) {
    if (inWater()) bot.setControlState("jump", true);
    return false;
  }
  // Dip: release jump so the bot sinks toward a fish two or three blocks down.
  const dipMs = Math.min(4500, Math.max(0, (depthBelowSurface(bot, fish.position) - 1) * 900));
  if (dipMs > 0 && submergedMs() < 1500) {
    // Look down at the fish so the sink runs toward it, then release jump.
    await bot.lookAt(fish.position, true).catch(() => {});
    bot.setControlState("forward", true);
    bot.setControlState("jump", false);
    bot.setControlState("sneak", true);
    await new Promise((r) => setTimeout(r, dipMs));
    bot.setControlState("sneak", false);
    bot.setControlState("forward", false);
  }
  const gap = fish.position.distanceTo(bot.entity.position.offset(0, 1.6, 0));
  console.log(
    `[FishDebug] ${bot.username}: surface swim reached ${fish.name}, gap ${gap.toFixed(1)}, depth ${depth}, under ${submergedMs()} ms`,
  );
  return gap <= 3.5;
}
