import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto, collectNearbyDrops } from "../bot/navigation.js";

/**
 * hunt_food — the swarm's pantry when the farm and the lake both fail.
 *
 * Run 517: four of five bots at 0 food, 20 deaths in an hour, 211 eat actions
 * of which 27 found "No food in inventory" and 27 "No food animals nearby".
 * The fishing fallback is retired (0 of 12, no string), and bread is eaten by
 * the bakers. Animals do exist: this map's herds graze 60 to 200 blocks out,
 * past the 80-block range a bot perceives. This skill goes and gets one:
 * scout outward along one committed heading in daylight until a food animal
 * is in sight, kill it, sweep the drops, and eat on the spot.
 */

const FOOD_ANIMALS = new Set(["cow", "pig", "sheep", "chicken", "rabbit", "mooshroom"]);
const MEAT =
  /^(beef|porkchop|mutton|chicken|rabbit|cooked_beef|cooked_porkchop|cooked_mutton|cooked_chicken|cooked_rabbit)$/;

function nearestFoodAnimal(bot: Bot) {
  return bot.nearestEntity((e) => FOOD_ANIMALS.has(e.name ?? "") && e.position.distanceTo(bot.entity.position) < 96);
}

function countMeat(bot: Bot): number {
  return bot.inventory
    .items()
    .filter((i) => MEAT.test(i.name))
    .reduce((s, i) => s + i.count, 0);
}

/** Eat what was just gathered until hunger is comfortable. Raw meat is fine
 *  for a starving bot (3 to 4 hunger each); cooking can wait. */
async function eatMeat(bot: Bot, signal: AbortSignal): Promise<number> {
  let eaten = 0;
  for (let i = 0; i < 4 && bot.food < 18 && !signal.aborted; i++) {
    const meat = bot.inventory.items().find((it) => MEAT.test(it.name));
    if (!meat) break;
    try {
      await bot.equip(meat, "hand");
      await bot.consume();
      eaten++;
    } catch {
      break;
    }
  }
  return eaten;
}

export const huntFoodSkill: Skill = {
  name: "hunt_food",
  description:
    "Find a food animal (cow, pig, sheep, chicken, rabbit), scouting outward in daylight if none is in sight, kill it, collect the meat and eat it. The pantry of last resort when starving.",
  params: {},

  estimateMaterials(): Record<string, number> {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "hunt_food", phase: "Hunt", progress, message, active: true });

    const foodBefore = bot.food;
    bot.pathfinder.setMovements(baseMoves(bot));

    // A full pocket cannot pick the drop up. Shed mining junk first.
    if (bot.inventory.emptySlotCount() < 2) {
      const JUNK = new Set([
        "cobblestone",
        "cobbled_deepslate",
        "dirt",
        "gravel",
        "andesite",
        "diorite",
        "granite",
        "tuff",
      ]);
      for (const it of bot.inventory.items()) {
        if (bot.inventory.emptySlotCount() >= 2) break;
        if (JUNK.has(it.name)) await bot.toss(it.type, null, it.count).catch(() => {});
      }
    }

    // Already carrying meat: eat it and go home happy.
    if (countMeat(bot) > 0 && bot.food < 18) {
      const eaten = await eatMeat(bot, signal);
      if (eaten > 0) {
        return { success: true, message: `Ate ${eaten} meat from the pack. Hunger ${foodBefore} -> ${bot.food}.` };
      }
    }

    let target = nearestFoodAnimal(bot);

    // Nothing in sight: scout along one committed heading, three hops of
    // sixty blocks, rescanning after each. Daylight only. At night the walk
    // out is a walk into skeletons, which is how the breeding scout died
    // repeatedly before it got its daylight gate.
    if (!target) {
      if (!bot.time.isDay) {
        return { success: false, message: "No food animal in sight and it is night. Hunt again at daybreak." };
      }
      const cardinals = [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ];
      const [ddx, ddz] = cardinals[Math.floor(Math.random() * cardinals.length)];
      for (let hop = 0; hop < 3 && !target && !signal.aborted; hop++) {
        const p = bot.entity.position;
        step(`Scouting for animals (hop ${hop + 1}/3)...`, 0.1 + hop * 0.1);
        await safeGoto(bot, new goals.GoalNearXZ(p.x + ddx * 60, p.z + ddz * 60, 6), 45_000, 12_000).catch(() => {});
        target = nearestFoodAnimal(bot);
      }
      if (!target) {
        return { success: false, message: "Scouted 180 blocks and saw no food animal. Try another heading next time." };
      }
    }

    const species = target.name ?? "animal";
    const startDist = bot.entity.position.distanceTo(target.position);
    step(`Hunting a ${species} (${startDist.toFixed(0)} blocks away)...`, 0.5);

    const weapon =
      bot.inventory.items().find((i) => i.name.endsWith("_sword")) ??
      bot.inventory.items().find((i) => i.name.endsWith("_axe")) ??
      bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
    if (weapon) await bot.equip(weapon, "hand").catch(() => {});

    const meatBefore = countMeat(bot);
    const fightUntil = Date.now() + 45_000;
    let swings = 0;
    try {
      while (target.isValid && Date.now() < fightUntil && !signal.aborted) {
        if (bot.entity.position.distanceTo(target.position) > 2.5) {
          await safeGoto(bot, new goals.GoalFollow(target, 1.5), 8_000).catch(() => {});
        }
        if (!target.isValid) break;
        await bot.attack(target);
        swings++;
        // Full attack-cooldown charge between swings (1.21 scales damage by charge).
        await new Promise((r) => setTimeout(r, 1150));
      }
      step("Sweeping the drops...", 0.8);
      await collectNearbyDrops(bot, 8, 7000);
    } catch {
      /* best effort; the deltas below are the verdict */
    }

    const gained = countMeat(bot) - meatBefore;
    const eaten = gained > 0 ? await eatMeat(bot, signal) : 0;
    console.log(
      `[HuntDebug] ${bot.username} food hunt vs ${species}: start=${startDist.toFixed(1)} swings=${swings} ` +
        `targetDead=${!target.isValid} meat +${gained} ate=${eaten} hunger ${foodBefore}->${bot.food}`,
    );
    if (gained > 0) {
      return {
        success: true,
        message: `Killed a ${species}: +${gained} meat, ate ${eaten}. Hunger ${foodBefore} -> ${bot.food}.`,
        stats: { meat: gained, eaten },
      };
    }
    if (!target.isValid) {
      return { success: false, message: `Killed the ${species} but picked up no meat.` };
    }
    return { success: false, message: `The ${species} got away after ${swings} swings.` };
  },
};
