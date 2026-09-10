import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto } from "../bot/navigation.js";

/**
 * mine_frontier — mine where there is still ore to mine.
 *
 * The village base is a mined-out honeycomb ringed by water: strip_mine there
 * reports "couldn't reach fresh rock, mined-out village ground" trip after
 * trip, and the swarm has produced almost no ore for days. But an RCON survey
 * of the fresh forest the roamers reach (~450,-420, where the bee hive is)
 * shows solid un-mined stone with iron/copper/coal at y=15 — reachable on the
 * surface, just not dug yet.
 *
 * So this skill ferries a miner OUT to that fresh ground first, then hands off
 * to the proven strip_mine core to descend and tunnel there. The ore it finds
 * stays in the miner's pocket (strip_mine tosses junk, keeps ore), where the
 * smelt and armour reflexes turn it into the armour that reopens the Nether.
 */

// The fresh, un-mined forest the roamers reach — surface-traversable from base.
const FRONTIER = { x: 450, z: -420 };

export const mineFrontierSkill: Skill = {
  name: "mine_frontier",
  description:
    "March to fresh un-mined territory away from the exhausted base, then strip-mine it for real ore. The way to restart the swarm's iron supply.",
  params: {},
  timeoutMs: 900_000,

  estimateMaterials(): Record<string, number> {
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "mine_frontier", phase: "Frontier", progress, message, active: true });
    const resumable = (msg: string) => `${msg} invoke_skill {"skill":"mine_frontier"} again to continue.`;

    if (!/overworld/.test(String(bot.game.dimension))) {
      return { success: false, message: resumable("Not in the overworld — can't reach the frontier from here.") };
    }

    // Dig-capable so a ridge or a shallow bank doesn't pin the ferry; the
    // waypoint hops stay inside the searchRadius cap.
    const marchMoves = baseMoves(bot);
    (marchMoves as unknown as { canDig: boolean; allow1by1towers: boolean }).canDig = true;
    (marchMoves as unknown as { canDig: boolean; allow1by1towers: boolean }).allow1by1towers = true;
    bot.pathfinder.setMovements(marchMoves);

    const gap = () => Math.hypot(bot.entity.position.x - FRONTIER.x, bot.entity.position.z - FRONTIER.z);
    const marchUntil = Date.now() + 300_000;
    let guard = 0;
    while (gap() > 30 && !signal.aborted && Date.now() < marchUntil) {
      const g = gap();
      step(`Ferrying to fresh ground — ${Math.round(g)} blocks out...`, 0.1 + Math.min(0.4, (250 - g) / 625));
      const t = Math.min(1, 100 / g);
      const wx = Math.round(bot.entity.position.x + (FRONTIER.x - bot.entity.position.x) * t);
      const wz = Math.round(bot.entity.position.z + (FRONTIER.z - bot.entity.position.z) * t);
      const before = gap();
      await safeGoto(bot, new goals.GoalNearXZ(wx, wz, 12), 45_000, 12_000).catch(() => {});
      if (before - gap() < 8 && ++guard >= 3) break;
      else if (before - gap() >= 8) guard = 0;
    }

    if (gap() > 60) {
      return {
        success: false,
        message: resumable(`Couldn't reach the frontier this trip — still ${Math.round(gap())} blocks out.`),
      };
    }

    // On fresh ground now — hand off to strip_mine, which descends to the iron
    // band and tunnels. Its hike-out from here heads further into un-mined
    // rock rather than back through the honeycombed village.
    step("On fresh ground — strip-mining for ore...", 0.6);
    const { stripMineSkill } = await import("./strip-mine.js");
    const result = await stripMineSkill.execute(bot, params, signal, onProgress);
    return {
      success: result.success,
      message: `Frontier trip: ${result.message}`,
      stats: result.stats,
    };
  },
};
