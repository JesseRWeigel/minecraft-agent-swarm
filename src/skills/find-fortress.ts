import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto } from "../bot/navigation.js";

/**
 * find_fortress — A Terrible Fortress (nether/find_fortress), the gateway to
 * the whole brewing branch: blaze rods, potions, the zombie-villager cure,
 * and the long-parked trading advancement all sit behind it.
 *
 * The advancement fires on ENTERING the structure, so the job is pure
 * exploration: cross the village portal, sweep a bounded arc for nether
 * bricks (nothing else in the Nether is built from them), walk onto them,
 * record the spot, and come home. Each firing sweeps a different compass
 * heading, so resumable refires compound into a widening search.
 */

const HEADINGS = [
  ["east", 1, 0],
  ["southeast", 0.7, 0.7],
  ["south", 0, 1],
  ["southwest", -0.7, 0.7],
  ["west", -1, 0],
  ["northwest", -0.7, -0.7],
  ["north", 0, -1],
  ["northeast", 0.7, -0.7],
] as const;
// Module-level so refires rotate through headings within a session.
let headingIndex = 0;

function inNether(bot: Bot): boolean {
  return String(bot.game.dimension).includes("nether");
}

export const findFortressSkill: Skill = {
  name: "find_fortress",
  description:
    "Cross the nether portal and sweep for a nether fortress (nether bricks). Walking into one earns A Terrible Fortress and unlocks the blaze-rod chain. Records the location for later trips.",
  params: {},
  timeoutMs: 480_000,

  estimateMaterials(): Record<string, number> {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "find_fortress", phase: "Hunt", progress, message, active: true });
    const resumable = (msg: string) => `${msg} invoke_skill {"skill":"find_fortress"} again to continue.`;
    // Dig-capable sweep: the outbound legs now reach 400 blocks per heading,
    // and cautious moves snagged on Nether walls and lava long before that.
    // A bulldozer profile actually tiles the wider search disk instead of
    // stalling on the first ridge. The searchRadius cap bounds it.
    const sweepMoves = baseMoves(bot);
    (sweepMoves as unknown as { canDig: boolean; allow1by1towers: boolean }).canDig = true;
    (sweepMoves as unknown as { canDig: boolean; allow1by1towers: boolean }).allow1by1towers = true;
    // Run 664: the sweep's default four-block drop let Mason step off a
    // Nether ledge into lava at the same spot two days running. Two is a
    // stair, four is a cliff over lava.
    (sweepMoves as unknown as { maxDropDown: number }).maxDropDown = 2;
    bot.pathfinder.setMovements(sweepMoves);

    // --- Cross over (proven routine) ---
    if (!inNether(bot)) {
      // Run 696: Mason crossed, swept seven legs east and was killed by a
      // piglin at (71, 73, -39) wearing an iron chestplate and no gold.
      // Piglins leave a player alone who wears any one gold piece, and the
      // stash holds a pair of golden boots from the bastion trip. Wear gold
      // before crossing, fetching the boots from the stash when needed.
      const wornGold = () => {
        const inv = bot.inventory;
        const slots = [inv.slots[5], inv.slots[6], inv.slots[7], inv.slots[8]];
        return slots.some((it) => !!it && it.name.startsWith("golden_"));
      };
      if (!wornGold()) {
        let gold = bot.inventory.items().find((i) => /^golden_(boots|helmet|chestplate|leggings)$/.test(i.name));
        if (!gold) {
          step("Fetching golden boots for the piglins...", 0.05);
          const { withdrawStash } = await import("./stash.js");
          const { STASH_POS } = await import("../bot/role.js");
          await withdrawStash(bot, STASH_POS, "golden_boots", 1, 60_000).catch(() => {});
          gold = bot.inventory.items().find((i) => /^golden_(boots|helmet|chestplate|leggings)$/.test(i.name));
        }
        if (gold) {
          const dest = gold.name.endsWith("boots")
            ? "feet"
            : gold.name.endsWith("helmet")
              ? "head"
              : gold.name.endsWith("leggings")
                ? "legs"
                : "torso";
          await bot.equip(gold, dest).catch(() => {});
          console.log(
            `[Fortress] ${bot.username}: wearing ${gold.name} for the piglins (${wornGold() ? "on" : "equip failed"})`,
          );
        }
        if (!wornGold()) {
          return {
            success: false,
            message: resumable(
              "No gold to wear: piglins kill a bot without a gold piece. Bank a golden_boots (4 gold ingots at a crafting table) in the stash first.",
            ),
          };
        }
      }
      step("Stepping through the portal...", 0.1);
      const portal = bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 64 });
      if (!portal)
        return { success: false, message: resumable("No portal within 64 blocks — walk to the village first.") };
      const { crossPortal } = await import("./nether-portal.js");
      const crossed = await crossPortal(bot, portal.position, 30_000, (d) => d.includes("nether"));
      if (!crossed) return { success: false, message: resumable("Couldn't cross the portal this trip.") };
    }

    const homePortal = bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 32 });

    // --- Already visible? ---
    let bricks = bot.findBlock({ matching: (b) => b.name === "nether_bricks", maxDistance: 128 });

    // --- Sweep one heading, scanning as we go ---
    if (!bricks) {
      const [label, dx, dz] = HEADINGS[headingIndex % HEADINGS.length];
      headingIndex++;
      const start = bot.entity.position.clone();
      step(`No fortress in sight — sweeping ${label}...`, 0.3);
      const legDeadline = Date.now() + 300_000;
      for (let leg = 1; leg <= 8 && !bricks && !signal.aborted && Date.now() < legDeadline; leg++) {
        await safeGoto(
          bot,
          new goals.GoalNearXZ(start.x + dx * 50 * leg, start.z + dz * 50 * leg, 8),
          45_000,
          12_000,
        ).catch(() => {});
        bricks = bot.findBlock({ matching: (b) => b.name === "nether_bricks", maxDistance: 128 });
        step(`Sweeping ${label} — leg ${leg}/8, no bricks yet...`, 0.3 + leg * 0.08);
      }
    }

    let entered = false;
    if (bricks) {
      step(`NETHER BRICKS at ${bricks.position} — walking into the fortress...`, 0.7);
      const approachDeadline = Date.now() + 120_000;
      while (!signal.aborted && Date.now() < approachDeadline && bot.entity.position.distanceTo(bricks.position) > 3) {
        await safeGoto(
          bot,
          new goals.GoalNear(bricks.position.x, bricks.position.y + 1, bricks.position.z, 2),
          45_000,
          12_000,
        ).catch(() => {});
        if (bot.entity.position.distanceTo(bricks.position) > 3) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      entered = bot.entity.position.distanceTo(bricks.position) <= 4;
      const p = bot.entity.position.floored();
      console.log(
        `[FortressDebug] ${bot.username}: bricks=${bricks.position} stoodAt=${p.x},${p.y},${p.z} entered=${entered}`,
      );
    }

    // --- Always walk home ---
    // Run 658: Mason died in Nether lava, respawned at the village bed ten
    // blocks from the portal, and this leg then walked him straight back
    // through it; three Nether deaths in five minutes. A death aborts the
    // skill, so honour the signal here, and never "return" through a portal
    // from the Overworld side.
    if (signal.aborted) {
      return {
        success: false,
        message: "Fortress hunt aborted (death or interruption); not walking back through the portal.",
      };
    }
    step("Heading back through the portal...", 0.9);
    if (homePortal && inNether(bot)) {
      await safeGoto(
        bot,
        new goals.GoalNear(homePortal.position.x, homePortal.position.y, homePortal.position.z, 2),
        90_000,
      ).catch(() => {});
      const { crossPortal } = await import("./nether-portal.js");
      await crossPortal(bot, homePortal.position, 30_000, (d) => !d.includes("nether")).catch(() => false);
    }

    if (entered && bricks) {
      return {
        success: true,
        message: `Walked the fortress bricks at ${bricks.position.x},${bricks.position.y},${bricks.position.z} — A Terrible Fortress should be banked (files confirm). Location recorded.`,
        stats: { fortressX: bricks.position.x, fortressY: bricks.position.y, fortressZ: bricks.position.z },
      };
    }
    if (bricks) {
      return {
        success: false,
        message: resumable(
          `Saw nether bricks at ${bricks.position.x},${bricks.position.y},${bricks.position.z} but couldn't reach them this trip.`,
        ),
      };
    }
    return { success: false, message: resumable("No fortress on this heading — next firing sweeps the next one.") };
  },
};
