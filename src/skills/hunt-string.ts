import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto, collectNearbyDrops } from "../bot/navigation.js";

/**
 * hunt_string — spider silk for the Take Aim bow.
 *
 * The armory audit found 63 arrows, 26 feathers and 693 sticks banked, and
 * zero string: the bow is three spider silks from existing. Same shape as
 * the leather hunt that fed the enchanting book — a reflex fires this when
 * Blade (the one bot built for a fight) can see a spider, and the drops ride
 * the stash ledger home.
 */

const STRING_DROPPERS = new Set(["spider", "cave_spider"]);

function countString(bot: Bot): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === "string")
    .reduce((s, i) => s + i.count, 0);
}

export function nearestSpider(bot: Bot) {
  return bot.nearestEntity((e) => STRING_DROPPERS.has(e.name ?? ""));
}

export const huntStringSkill: Skill = {
  name: "hunt_string",
  description:
    "Kill a visible spider and collect its string — the bow for Take Aim needs 3. Only works when a spider is already in sight.",
  params: {},

  estimateMaterials(): Record<string, number> {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "hunt_string", phase: "Hunt", progress, message, active: true });

    const target = nearestSpider(bot);
    if (!target) {
      return { success: false, message: "No spider in sight." };
    }

    step(`Engaging a ${target.name} (${bot.entity.position.distanceTo(target.position).toFixed(0)} blocks)...`, 0.2);

    if (bot.inventory.emptySlotCount() < 2) {
      const JUNK = new Set(["cobblestone", "cobbled_deepslate", "dirt", "gravel", "andesite", "diorite", "granite"]);
      for (const it of bot.inventory.items()) {
        if (bot.inventory.emptySlotCount() >= 2) break;
        if (JUNK.has(it.name)) await bot.toss(it.type, null, it.count).catch(() => {});
      }
    }

    const before = countString(bot);
    const weapon =
      bot.inventory.items().find((i) => i.name.endsWith("_sword")) ??
      bot.inventory.items().find((i) => i.name.endsWith("_axe")) ??
      bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
    if (weapon) await bot.equip(weapon, "hand").catch(() => {});

    bot.pathfinder.setMovements(baseMoves(bot));
    // Run 614: eight hunts, one kill. Flora swung 13 to 16 times at one
    // spider without killing it (16 hp; even a bare hand needs 16 hits at
    // most, a stone pick six): most swings landed out of reach after the
    // spider moved off during the follow. Close to 1.2, look at it, and
    // swing only inside three blocks; give the chase 45 s.
    const fightUntil = Date.now() + 45_000;
    let swings = 0;
    let misses = 0;
    try {
      while (target.isValid && Date.now() < fightUntil && !signal.aborted) {
        if (bot.entity.position.distanceTo(target.position) > 2.5) {
          await safeGoto(bot, new goals.GoalFollow(target, 1.2), 5_000).catch(() => {});
        }
        if (!target.isValid) break;
        const reach = bot.entity.position.distanceTo(target.position);
        if (reach > 3.0) {
          misses++;
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        await bot.lookAt(target.position.offset(0, 0.5, 0), true).catch(() => {});
        await bot.attack(target);
        swings++;
        await new Promise((r) => setTimeout(r, 620));
      }
      step("Sweeping the drops...", 0.8);
      await collectNearbyDrops(bot, 8, 6000);
    } catch {
      /* the delta below is the honest verdict */
    }

    const gained = countString(bot) - before;
    console.log(
      `[HuntDebug] ${bot.username} vs ${target.name}: swings=${swings} outOfReach=${misses} weapon=${weapon?.name ?? "hand"} targetDead=${!target.isValid} string ${before}->${before + gained}`,
    );
    if (gained > 0) {
      return { success: true, message: `Got ${gained} string from the spider!`, stats: { string: gained } };
    }
    if (!target.isValid) {
      return { success: false, message: "Killed the spider but the string rolled zero — next spider." };
    }
    return { success: false, message: "The spider got away (or fought back too well)." };
  },
};
