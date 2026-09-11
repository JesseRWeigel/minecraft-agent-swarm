import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { explorerMoves, safeGoto } from "../bot/navigation.js";
import { nearestNest, knownWaxedBlocks } from "../bot/nests.js";
import { executeAction } from "../bot/actions.js";

/**
 * wax_off — scrape the wax back off the copper block Forge waxed for Wax On.
 *
 * The block stands next to the third bee nest (waxed_copper_block at
 * 475,78,-321 on 2026-09-11). One right-click with any axe removes the wax
 * and earns "Wax Off". Needs an axe (stone: 3 cobblestone + 2 sticks) and
 * the walk; nothing else.
 */

function count(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((s, i) => s + i.count, 0);
}

export const waxOffSkill: Skill = {
  name: "wax_off",
  description:
    "Walk to the waxed copper block by the bee nest and scrape the wax off with an axe. Earns Wax Off once Wax On is done.",
  params: {},

  estimateMaterials(): Record<string, number> {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "wax_off", phase: "Wax off", progress, message, active: true });

    // --- An axe of any material ---
    let axe = bot.inventory.items().find((i) => i.name.endsWith("_axe"));
    if (!axe) {
      step("No axe — crafting a stone axe...", 0.1);
      const sticks = count(bot, "stick");
      const cobble = count(bot, "cobblestone") + count(bot, "cobbled_deepslate");
      if (cobble < 3) return { success: false, message: `No axe and only ${cobble} cobblestone (need 3 + 2 sticks).` };
      if (sticks < 2) await executeAction(bot, "craft", { item: "stick", count: 4 }).catch(() => "");
      const r = await executeAction(bot, "craft", { item: "stone_axe", count: 1 }).catch((e: Error) => e.message);
      axe = bot.inventory.items().find((i) => i.name.endsWith("_axe"));
      if (!axe) return { success: false, message: `Couldn't craft a stone axe: ${String(r).slice(0, 80)}` };
    }

    // --- Walk to the remembered waxed block (run 529: "nearest nest" was a
    // recorded nest by the village, 200 blocks from the block) ---
    const here = bot.entity.position;
    const isWaxed = (name: string) => name.startsWith("waxed_");
    let block = bot.findBlock({ matching: (b) => isWaxed(b.name), maxDistance: 32 });
    const known = knownWaxedBlocks().sort(
      (a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z),
    );
    const target = known[0] ?? nearestNest(here.x, here.z);
    if (!block) {
      // Waypoints, the way the hive walk and the frontier ferry close ground:
      // a goal 190 blocks out is a search the planner gives up on (run 530:
      // two attempts, "I am 192 out" both times, no movement). Step toward a
      // point ~100 blocks ahead until the last stretch.
      bot.pathfinder.setMovements(explorerMoves(bot));
      const gapXZ = () => Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z);
      const deadline = Date.now() + 170_000;
      let guard = 0;
      while (gapXZ() > 24 && Date.now() < deadline && !signal.aborted) {
        step(`Walking to the waxed block — ${Math.round(gapXZ())} blocks out...`, 0.3);
        const before = gapXZ();
        const t = Math.min(1, 100 / before);
        const wx = Math.round(bot.entity.position.x + (target.x - bot.entity.position.x) * t);
        const wz = Math.round(bot.entity.position.z + (target.z - bot.entity.position.z) * t);
        await safeGoto(bot, new goals.GoalNearXZ(wx, wz, 10), 45_000, 12_000).catch(() => {});
        if (before - gapXZ() >= 6) guard = 0;
        else if (++guard >= 3) break;
      }
      if (gapXZ() <= 40) {
        await safeGoto(bot, new goals.GoalNear(target.x, target.y, target.z, 3), 45_000, 12_000).catch(() => {});
      }
      block = bot.findBlock({ matching: (b) => isWaxed(b.name), maxDistance: 32 });
    }
    if (!block) {
      const d = Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z);
      return {
        success: false,
        message: `No waxed copper block within 32 blocks of ${target.x},${target.z} (I am ${d.toFixed(0)} out).`,
      };
    }
    if (signal.aborted) return { success: false, message: "Aborted." };

    step("Walking up to the waxed block...", 0.6);
    if (bot.entity.position.distanceTo(block.position) > 3.5) {
      await safeGoto(bot, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), 60_000).catch(
        () => {},
      );
    }
    const dist = bot.entity.position.distanceTo(block.position);
    if (dist > 4.5)
      return { success: false, message: `Couldn't reach the waxed block (${dist.toFixed(1)} blocks away).` };

    // --- Scrape ---
    step("Scraping the wax off...", 0.8);
    await bot.equip(axe, "hand");
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
    try {
      await bot.activateBlock(block);
    } catch (e) {
      return { success: false, message: `Right-click failed: ${(e as Error).message}` };
    }
    await new Promise((r) => setTimeout(r, 1200));
    const after = bot.blockAt(block.position);
    const scraped = !!after && !isWaxed(after.name);
    console.log(`[WaxDebug] ${bot.username} wax_off: ${block.name} -> ${after?.name ?? "?"} at ${block.position}`);
    if (scraped) {
      return {
        success: true,
        message: `Scraped the wax off the copper block at ${block.position}. Wax Off should be banked.`,
      };
    }
    return {
      success: false,
      message: `Clicked the block with ${axe.name} but it still reads ${after?.name ?? "unknown"}.`,
    };
  },
};
