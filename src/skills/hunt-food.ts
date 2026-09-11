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

// Hunger per raw drop: beef and porkchop 3, mutton and rabbit 3 (rabbit only
// half the time), chicken 2 and a poisoning chance. A cow 60 blocks out beats
// a chicken 20 blocks out (run 523: two kills, one mutton and one chicken,
// took Mason from 0 to 2 and back to 0 by the walk home).
const VALUE: Record<string, number> = { cow: 3, mooshroom: 3, pig: 3, sheep: 2, rabbit: 1.5, chicken: 1 };
const FUEL = new Set([
  "coal",
  "charcoal",
  "oak_log",
  "birch_log",
  "spruce_log",
  "oak_planks",
  "birch_planks",
  "spruce_planks",
]);
const RAW_TO_COOKED: Record<string, string> = {
  beef: "cooked_beef",
  porkchop: "cooked_porkchop",
  mutton: "cooked_mutton",
  chicken: "cooked_chicken",
  rabbit: "cooked_rabbit",
};

function nearestFoodAnimal(bot: Bot) {
  let best: ReturnType<Bot["nearestEntity"]> = null;
  let bestScore = 0;
  for (const e of Object.values(bot.entities)) {
    const v = VALUE[e.name ?? ""];
    if (!v) continue;
    const d = e.position.distanceTo(bot.entity.position);
    if (d > 96) continue;
    const score = v / (1 + d / 40);
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

/** Cook the raw meat aboard in a furnace already standing within 12 blocks,
 *  when the bot carries fuel. Doubles the hunger per drop (cooked beef 8,
 *  cooked mutton 6). Bounded: at most three items, 40 seconds. */
async function cookIfEasy(bot: Bot, signal: AbortSignal): Promise<number> {
  const raw = bot.inventory.items().find((i) => RAW_TO_COOKED[i.name]);
  const fuel = bot.inventory.items().find((i) => FUEL.has(i.name));
  if (!raw || !fuel) return 0;
  const furnace = bot.findBlock({ matching: (b) => b.name === "furnace" || b.name === "lit_furnace", maxDistance: 12 });
  if (!furnace) return 0;
  try {
    await safeGoto(bot, new goals.GoalNear(furnace.position.x, furnace.position.y, furnace.position.z, 2), 15_000);
    const f = (await Promise.race([
      bot.openFurnace(furnace),
      new Promise((_, rej) => setTimeout(() => rej(new Error("openFurnace timeout")), 10_000)),
    ])) as Awaited<ReturnType<typeof bot.openFurnace>>;
    try {
      if (f.outputItem()) await f.takeOutput();
      const n = Math.min(3, raw.count);
      const fuelNeeded = fuel.name === "coal" || fuel.name === "charcoal" ? 1 : n;
      if (!f.fuelItem()) await f.putFuel(fuel.type, null, Math.min(fuelNeeded, fuel.count));
      if (!f.inputItem()) await f.putInput(raw.type, null, n);
      const until = Date.now() + n * 10_500 + 3_000;
      while (Date.now() < until && !signal.aborted) {
        await new Promise((r) => setTimeout(r, 2_500));
        const out = f.outputItem();
        if (out && out.count >= n) break;
      }
      const out = f.outputItem();
      if (out) await f.takeOutput();
      return out?.count ?? 0;
    } finally {
      f.close();
    }
  } catch (e) {
    console.log(`[HuntDebug] ${bot.username} cooking skipped: ${(e as Error).message}`);
    return 0;
  }
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

    const weapon =
      bot.inventory.items().find((i) => i.name.endsWith("_sword")) ??
      bot.inventory.items().find((i) => i.name.endsWith("_axe")) ??
      bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
    if (weapon) await bot.equip(weapon, "hand").catch(() => {});

    // One kill is a snack (2 to 3 hunger raw) and the walk home eats it. Keep
    // hunting while animals are in sight, up to three kills or a decent meal.
    const meatBefore = countMeat(bot);
    const outingUntil = Date.now() + 150_000;
    let kills = 0;
    let swings = 0;
    let lastSpecies = target.name ?? "animal";
    let escaped = false;
    while (target && kills < 3 && countMeat(bot) < 4 && Date.now() < outingUntil && !signal.aborted) {
      const species = target.name ?? "animal";
      lastSpecies = species;
      const startDist = bot.entity.position.distanceTo(target.position);
      step(`Hunting a ${species} (${startDist.toFixed(0)} blocks away)...`, 0.5 + kills * 0.1);
      const fightUntil = Date.now() + 45_000;
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
        await collectNearbyDrops(bot, 8, 7000);
      } catch {
        /* best effort; the deltas below are the verdict */
      }
      if (target.isValid) {
        escaped = true;
        break;
      }
      kills++;
      target = nearestFoodAnimal(bot);
    }

    const gained = countMeat(bot) - meatBefore;
    step("Cooking what is easy, then eating...", 0.9);
    const cooked = gained > 0 ? await cookIfEasy(bot, signal) : 0;
    const eaten = gained > 0 ? await eatMeat(bot, signal) : 0;
    console.log(
      `[HuntDebug] ${bot.username} food hunt: kills=${kills} last=${lastSpecies} swings=${swings} ` +
        `meat +${gained} cooked=${cooked} ate=${eaten} hunger ${foodBefore}->${bot.food}`,
    );
    if (gained > 0) {
      return {
        success: true,
        message: `Killed ${kills} animal${kills === 1 ? "" : "s"}: +${gained} meat, cooked ${cooked}, ate ${eaten}. Hunger ${foodBefore} -> ${bot.food}.`,
        stats: { meat: gained, eaten, kills },
      };
    }
    if (kills > 0) {
      return { success: false, message: `Killed ${kills} ${lastSpecies} but picked up no meat.` };
    }
    return { success: false, message: escaped ? `The ${lastSpecies} got away after ${swings} swings.` : "No kill." };
  },
};
