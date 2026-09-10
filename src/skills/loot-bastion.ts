import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto } from "../bot/navigation.js";

/**
 * loot_bastion — Those Were the Days (nether/loot_bastion), which fires the
 * first time a bot opens a loot chest inside a bastion remnant.
 *
 * Unlike the fortress — which the server locates 622 blocks out in the
 * lava-locked direction, unreachable from our portal — the bastion sits at
 * nether (320,-304), only ~387 blocks from the portal exit, and we already
 * earned find_bastion by physically entering it. So this is a reachable,
 * concrete target that also drops the goods gating two more advancements:
 * a saddle (This Boat Has Legs) and crying obsidian (Not Quite Nine Lives).
 *
 * The job: cross the village portal, march dig-capable to the bastion, find a
 * chest on-site (the bot's own block search beats any remote scan), open it —
 * which generates the loot and banks the advancement — grab anything useful,
 * and come home.
 */

// The bastion remnant the server locates from our portal, in Nether coords.
const BASTION = { x: 320, z: -304 };
// Loot worth carrying home if the chest holds it.
const PRIZES = new Set([
  "saddle",
  "crying_obsidian",
  "gilded_blackstone",
  "netherite_scrap",
  "ancient_debris",
  "gold_ingot",
  "gold_block",
  "iron_ingot",
  "diamond",
]);

function inNether(bot: Bot): boolean {
  return String(bot.game.dimension).includes("nether");
}

export const lootBastionSkill: Skill = {
  name: "loot_bastion",
  description:
    "Cross the nether portal and march to the bastion remnant, then open a loot chest inside it. Opening it earns Those Were the Days and can yield a saddle or crying obsidian.",
  params: {},
  timeoutMs: 480_000,

  estimateMaterials(): Record<string, number> {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "loot_bastion", phase: "Loot", progress, message, active: true });
    const resumable = (msg: string) => `${msg} invoke_skill {"skill":"loot_bastion"} again to continue.`;

    // Dig-and-tower moves: the same bulldozer profile the fortress sweep uses,
    // so Nether walls and ridges don't pin the march short of the bastion.
    const marchMoves = baseMoves(bot);
    (marchMoves as unknown as { canDig: boolean; allow1by1towers: boolean }).canDig = true;
    (marchMoves as unknown as { canDig: boolean; allow1by1towers: boolean }).allow1by1towers = true;
    bot.pathfinder.setMovements(marchMoves);

    // --- Cross over (proven routine) ---
    if (!inNether(bot)) {
      step("Stepping through the portal...", 0.1);
      const portal = bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 64 });
      if (!portal)
        return { success: false, message: resumable("No portal within 64 blocks — walk to the village first.") };
      const { crossPortal } = await import("./nether-portal.js");
      const crossed = await crossPortal(bot, portal.position, 30_000, (d) => d.includes("nether"));
      if (!crossed) return { success: false, message: resumable("Couldn't cross the portal this trip.") };
    }

    // Belt-and-suspenders: crossPortal has resolved true while the bot was
    // still in the overworld (a dimension-event race), and the chest search
    // below then matched a BASE chest at the village — Forge "opened a bastion
    // chest at 285,69,-322", an overworld chest by the stash, and of course
    // Those Were the Days never fired. Only loot when genuinely in the Nether.
    if (!inNether(bot)) {
      return { success: false, message: resumable("Cross reported success but I'm still overworld — retry.") };
    }

    const homePortal = bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 32 });

    // --- March to the bastion in ~100-block hops (inside the searchRadius cap) ---
    const gap = () => Math.hypot(bot.entity.position.x - BASTION.x, bot.entity.position.z - BASTION.z);
    const marchUntil = Date.now() + 300_000;
    let guard = 0;
    let chest = bot.findBlock({ matching: (b) => b.name === "chest" || b.name === "trapped_chest", maxDistance: 48 });
    while (gap() > 24 && !chest && !signal.aborted && Date.now() < marchUntil) {
      const g = gap();
      step(`Marching to the bastion — ${Math.round(g)} blocks out...`, 0.2 + Math.min(0.4, (387 - g) / 967));
      const t = Math.min(1, 100 / g);
      const wx = Math.round(bot.entity.position.x + (BASTION.x - bot.entity.position.x) * t);
      const wz = Math.round(bot.entity.position.z + (BASTION.z - bot.entity.position.z) * t);
      const before = gap();
      await safeGoto(bot, new goals.GoalNearXZ(wx, wz, 10), 45_000, 12_000).catch(() => {});
      chest = bot.findBlock({ matching: (b) => b.name === "chest" || b.name === "trapped_chest", maxDistance: 48 });
      if (before - gap() < 8 && ++guard >= 3) break;
      else if (before - gap() >= 8) guard = 0;
    }

    // Widen the search once we're in the neighbourhood — bastion chests sit in
    // ramparts and treasure rooms, not always dead-centre.
    if (!chest && gap() <= 64) {
      chest = bot.findBlock({ matching: (b) => b.name === "chest" || b.name === "trapped_chest", maxDistance: 96 });
    }
    if (!chest) {
      return {
        success: false,
        message: resumable(
          gap() > 64
            ? `Couldn't reach the bastion this trip — still ${Math.round(gap())} blocks out.`
            : "At the bastion but no chest in view yet — it may be walled off or already looted.",
        ),
      };
    }

    // --- Approach and open the chest (opening banks the advancement) ---
    step(`Chest at ${chest.position} — walking over to open it...`, 0.7);
    const approachUntil = Date.now() + 90_000;
    while (!signal.aborted && Date.now() < approachUntil && bot.entity.position.distanceTo(chest.position) > 2.5) {
      await safeGoto(
        bot,
        new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2),
        30_000,
        10_000,
      ).catch(() => {});
      if (bot.entity.position.distanceTo(chest.position) > 2.5) await new Promise((r) => setTimeout(r, 800));
    }
    if (bot.entity.position.distanceTo(chest.position) > 3.5) {
      return {
        success: false,
        message: resumable(`Reached the bastion but couldn't get to the chest at ${chest.position}.`),
      };
    }

    const took: string[] = [];
    try {
      const container = await bot.openContainer(chest);
      // The open itself generates the loot and fires Those Were the Days.
      for (const item of container.containerItems()) {
        if (PRIZES.has(item.name)) {
          await container.withdraw(item.type, item.metadata ?? null, item.count).catch(() => {});
          took.push(`${item.count} ${item.name}`);
        }
      }
      await container.close();
    } catch (e) {
      return { success: false, message: resumable(`Found the chest but couldn't open it (${String(e)}).`) };
    }

    // --- Walk home ---
    step("Heading back through the portal...", 0.9);
    if (homePortal) {
      await safeGoto(
        bot,
        new goals.GoalNear(homePortal.position.x, homePortal.position.y, homePortal.position.z, 2),
        90_000,
      ).catch(() => {});
      const { crossPortal } = await import("./nether-portal.js");
      await crossPortal(bot, homePortal.position, 30_000, (d) => !d.includes("nether")).catch(() => false);
    }

    return {
      success: true,
      message:
        `Opened a bastion chest at ${chest.position.x},${chest.position.y},${chest.position.z} — Those Were the Days should be banked` +
        (took.length ? `; carried out ${took.join(", ")}.` : "."),
      stats: { bastionX: BASTION.x, bastionZ: BASTION.z },
    };
  },
};
