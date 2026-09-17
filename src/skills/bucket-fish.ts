import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto } from "../bot/navigation.js";

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
    while (fish && Date.now() < deadline && !signal.aborted && tries < 6) {
      tries++;
      tried.add(fish.id);
      step(
        0.2 + tries * 0.1,
        `Wading to a ${fish.name} ${fish.position.distanceTo(bot.entity.position).toFixed(0)} blocks away...`,
      );
      const end = Date.now() + 40_000;
      while (
        fish.isValid &&
        Date.now() < end &&
        fish.position.distanceTo(bot.entity.position) > 2.5 &&
        !signal.aborted
      ) {
        const p = fish.position;
        await safeGoto(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 12_000).catch(() => {});
      }
      if (!fish.isValid || fish.position.distanceTo(bot.entity.position) > 3.5) {
        fish = nearestFishExcept(bot, tried);
        continue;
      }
      const wb = bot.inventory.items().find((i) => i.name === "water_bucket");
      if (!wb) return { success: false, message: "Lost the water bucket on the way." };
      await bot.equip(wb, "hand").catch(() => {});
      await bot.lookAt(fish.position.offset(0, 0.2, 0), true).catch(() => {});
      try {
        await bot.activateEntity(fish);
      } catch {
        /* the fish moved; try again */
      }
      await new Promise((r) => setTimeout(r, 800));
      const got = fishBucket(bot);
      if (got) {
        console.log(`[Fish] ${bot.username}: scooped a ${fish.name} into a bucket at ${fish.position.floored()}`);
        return { success: true, message: `Scooped a ${fish.name} into a bucket (Tactical Fishing).`, stats: { tries } };
      }
    }
    return {
      success: false,
      message: `Waded after ${tries} fish and none went into the bucket. invoke_skill {"skill":"bucket_fish"} again to retry.`,
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
