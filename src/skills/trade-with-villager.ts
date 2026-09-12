import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto } from "../bot/navigation.js";

/**
 * trade_with_villager — What a Deal! (adventure/trade), which fires the first
 * time any bot completes a single villager trade.
 *
 * There is no village near our base: the nearest one the server can locate is
 * the plains village at (608, ~, -496), ~650 blocks out. So the job is a long
 * dig-capable march to that village, find a villager whose trade we can afford
 * with what we already carry (a miner's coal sells to toolsmiths, armorers,
 * weaponsmiths and fishermen), and complete one trade. The march runs entirely
 * inside this one invocation: the walk-home reflex would otherwise drag the bot
 * back between firings, so partial progress can't be banked across attempts —
 * this is a daylight lottery, and keepInventory means a failed trip costs only
 * time.
 */

// The plains village the server locates nearest our base. Villagers cluster
// here; y is left to the pathfinder since the surface height varies.
const VILLAGE = { x: 608, z: -496 };

function overworld(bot: Bot): boolean {
  return /overworld/.test(String(bot.game.dimension));
}

function invCount(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((sum, i) => sum + i.count, 0);
}

export const tradeWithVillagerSkill: Skill = {
  name: "trade_with_villager",
  description:
    "March to the plains village and complete one villager trade (e.g. sell coal for an emerald). Earns What a Deal! — the gateway to the villager-trading advancements.",
  params: {},
  timeoutMs: 480_000,

  estimateMaterials(): Record<string, number> {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "trade_with_villager", phase: "Trade", progress, message, active: true });
    const resumable = (msg: string) => `${msg} invoke_skill {"skill":"trade_with_villager"} again to continue.`;

    if (!overworld(bot)) {
      return { success: false, message: resumable("Not in the overworld — can't reach the village from here.") };
    }

    // Dig-capable march: unknown terrain over ~650 blocks snags cautious
    // moves on the first ridge, so bulldoze through. The searchRadius clamp
    // inside safeGoto bounds each hop.
    // Goods first. Runs 572 to 575: the march reached the village four times
    // and every trip ended "no villager had a trade I could afford", with 0
    // coal aboard and 2,882 coal in the stash. Sixteen coal is one emerald
    // at an armorer, toolsmith or weaponsmith; carry enough for two trades
    // so a bread purchase can follow.
    try {
      const { STASH_POS } = await import("../bot/role.js");
      const nearStash = Math.hypot(bot.entity.position.x - STASH_POS.x, bot.entity.position.z - STASH_POS.z) < 90;
      if (invCount(bot, "coal") < 16 && nearStash) {
        const { withdrawStash } = await import("./stash.js");
        step("Fetching coal from the stash to sell...", 0.05);
        const r = await Promise.race([
          withdrawStash(bot, STASH_POS, "coal", 32),
          new Promise<string>((res) => setTimeout(() => res("timeout"), 60_000)),
        ]).catch((e: Error) => e.message);
        console.log(`[TradeDebug] ${bot.username} coal withdraw: ${r} (coal now ${invCount(bot, "coal")})`);
      } else {
        console.log(`[TradeDebug] ${bot.username} goods aboard: coal ${invCount(bot, "coal")}, nearStash=${nearStash}`);
      }
    } catch (e) {
      console.log(`[TradeDebug] ${bot.username} coal withdraw skipped: ${(e as Error).message}`);
    }

    const marchMoves = baseMoves(bot);
    (marchMoves as unknown as { canDig: boolean; allow1by1towers: boolean }).canDig = true;
    (marchMoves as unknown as { canDig: boolean; allow1by1towers: boolean }).allow1by1towers = true;
    bot.pathfinder.setMovements(marchMoves);

    // --- March to the village in ~120-block hops (stays inside the OOM
    //     searchRadius cap; each hop re-plans from the new position). ---
    const gapToVillage = () => Math.hypot(bot.entity.position.x - VILLAGE.x, bot.entity.position.z - VILLAGE.z);
    const marchUntil = Date.now() + 360_000;
    let guard = 0;
    while (gapToVillage() > 40 && !signal.aborted && Date.now() < marchUntil) {
      const g = gapToVillage();
      step(`Marching to the village — ${Math.round(g)} blocks out...`, 0.1 + Math.min(0.5, (650 - g) / 1300));
      const t = Math.min(1, 120 / g);
      const wx = Math.round(bot.entity.position.x + (VILLAGE.x - bot.entity.position.x) * t);
      const wz = Math.round(bot.entity.position.z + (VILLAGE.z - bot.entity.position.z) * t);
      const before = gapToVillage();
      await safeGoto(bot, new goals.GoalNearXZ(wx, wz, 12), 45_000, 12_000).catch(() => {});
      if (before - gapToVillage() < 8 && ++guard >= 3) break;
      else if (before - gapToVillage() >= 8) guard = 0;
    }

    if (gapToVillage() > 48) {
      return {
        success: false,
        message: resumable(`Couldn't reach the village this trip — still ${Math.round(gapToVillage())} blocks out.`),
      };
    }

    // --- Find a villager and complete an affordable trade. Try the few
    //     nearest, since some may be unprofessioned (no trades). ---
    step("At the village — looking for a villager to trade with...", 0.7);
    const tried = new Set<number>();
    for (let attempt = 0; attempt < 5 && !signal.aborted; attempt++) {
      const villager = bot.nearestEntity((e: Entity) => e.name === "villager" && !tried.has(e.id));
      if (!villager) break;
      tried.add(villager.id);

      // Approach — openVillager needs to be within reach.
      const approachUntil = Date.now() + 45_000;
      while (!signal.aborted && Date.now() < approachUntil && bot.entity.position.distanceTo(villager.position) > 3) {
        await safeGoto(
          bot,
          new goals.GoalNear(villager.position.x, villager.position.y, villager.position.z, 2),
          20_000,
          8_000,
        ).catch(() => {});
        if (bot.entity.position.distanceTo(villager.position) > 3) await new Promise((r) => setTimeout(r, 800));
      }
      if (bot.entity.position.distanceTo(villager.position) > 4) continue;

      let win;
      try {
        win = await bot.openVillager(villager);
      } catch {
        continue;
      }
      const trades = win?.trades ?? [];
      const inputsOf = (t: (typeof trades)[number]) =>
        t.hasItem2 && t.inputItem2 ? [t.inputItem1, t.inputItem2] : [t.inputItem1];

      // Pick the first live trade whose inputs we can fully cover.
      const canPay = (t: (typeof trades)[number]) => {
        if (!t || t.tradeDisabled) return false;
        if (t.nbTradeUses >= t.maximumNbTradeUses) return false;
        return inputsOf(t).every((inp) => inp && invCount(bot, inp.name) >= inp.count);
      };
      // Name what the villager offers, so a "could afford" failure says why.
      console.log(
        `[TradeDebug] ${bot.username} villager ${villager.id}: ` +
          (trades.length
            ? trades
                .map(
                  (t) =>
                    `${inputsOf(t)
                      .map((i) => (i ? `${i.count} ${i.name}` : "?"))
                      .join(
                        "+",
                      )} -> ${t.outputItem ? `${t.outputItem.count} ${t.outputItem.name}` : "?"}${t.tradeDisabled ? " (disabled)" : ""}${canPay(t) ? " [ok]" : ""}`,
                )
                .join("; ")
            : "no trades (unprofessioned)"),
      );
      // Prefer food for emeralds when hungry and holding emeralds, else any
      // affordable trade (selling coal is the usual first deal).
      const isFood = (n: string | undefined) =>
        !!n && /bread|cooked_|apple|cookie|pie|baked_potato|carrot|potato|melon/.test(n);
      const foodTrade = bot.food < 14 ? trades.find((t) => canPay(t) && isFood(t.outputItem?.name)) : undefined;
      const affordable = foodTrade ?? trades.find(canPay);

      if (!affordable) {
        bot.closeWindow(win);
        continue;
      }

      const idx = trades.indexOf(affordable);
      const sold = inputsOf(affordable)
        .map((i) => `${i.count} ${i.name}`)
        .join(" + ");
      const got = affordable.outputItem ? `${affordable.outputItem.count} ${affordable.outputItem.name}` : "goods";
      step(`Trading ${sold} → ${got}...`, 0.9);
      try {
        await bot.trade(win, idx, 1);
      } catch (e) {
        bot.closeWindow(win);
        return { success: false, message: resumable(`The trade of ${sold} didn't go through (${String(e)}).`) };
      }
      bot.closeWindow(win);
      return {
        success: true,
        message: `Traded ${sold} for ${got} at the village — What a Deal! should be banked.`,
        stats: { villageX: VILLAGE.x, villageZ: VILLAGE.z },
      };
    }

    return {
      success: false,
      message: resumable(
        "Reached the village but no villager had a trade I could afford (need coal or crops, and a professioned villager).",
      ),
    };
  },
};
