import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { explorerMoves, safeGoto } from "../bot/navigation.js";
import { knownNests } from "../bot/nests.js";
import { ensureCampfire, honeyLevel, FULL_HONEY } from "./wax-copper.js";
import { executeAction } from "../bot/actions.js";

/**
 * harvest_honey — Bee Our Guest: bottle honey from a nest with a campfire
 * under it, so the bees stay calm.
 *
 * Two phases, because the glass is at the stash and the nests are 200
 * blocks east of it. Near the stash with no bottle: withdraw three glass
 * and craft bottles. Near a nest with a bottle: seat a campfire under it
 * (wax_copper's helper), wait for honey level 5, and right-click with the
 * bottle. The stash ledger recorded 23 glass and 61 sand on 2026-09-11.
 */

function count(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((s, i) => s + i.count, 0);
}

export const harvestHoneySkill: Skill = {
  name: "harvest_honey",
  description:
    "Bottle honey from a bee nest with a campfire under it (earns Bee Our Guest). Needs a glass bottle: withdraws glass at the stash and crafts one first.",
  params: {},

  // Empty on purpose: the executor refuses a skill whose estimate is
  // unmet before execute() runs, and this skill supplies its own bottle
  // (run 533: "Still missing glass_bottle: have 0, need 1" at 0%).
  estimateMaterials(): Record<string, number> {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "harvest_honey", phase: "Honey", progress, message, active: true });
    const resumable = (m: string) => `${m} invoke_skill {"skill":"harvest_honey"} again to continue.`;

    // --- Phase A: a glass bottle, plus the campfire kit (the meadows around
    // the nests have no trees, and run 534 stalled at the nest on "need coal
    // or charcoal for a campfire"; the stash holds coal, logs and sticks) ---
    const { STASH_POS } = await import("../bot/role.js");
    const nearStash = Math.hypot(bot.entity.position.x - STASH_POS.x, bot.entity.position.z - STASH_POS.z) < 60;
    const isLog = (n: string) => n.endsWith("_log") || n.endsWith("_wood");
    const logsHeld = () =>
      bot.inventory
        .items()
        .filter((i) => isLog(i.name))
        .reduce((s, i) => s + i.count, 0);
    const hasFuel = () => count(bot, "coal") + count(bot, "charcoal") >= 1;
    if (nearStash && count(bot, "campfire") < 1 && (!hasFuel() || logsHeld() < 3 || count(bot, "stick") < 3)) {
      step("Withdrawing the campfire kit from the stash...", 0.05);
      const { withdrawStash } = await import("./stash.js");
      const want: Array<[string, number]> = [];
      if (!hasFuel()) want.push(["coal", 2]);
      if (logsHeld() < 3) want.push(["oak_log", 3]);
      if (count(bot, "stick") < 3) want.push(["stick", 4]);
      for (const [name, n] of want) {
        if (signal.aborted) break;
        await Promise.race([
          withdrawStash(bot, STASH_POS, name, n),
          new Promise<void>((r) => setTimeout(r, 40_000)),
        ]).catch(() => {});
      }
      console.log(
        `[HoneyDebug] ${bot.username}: kit after stash — coal ${count(bot, "coal")} logs ${logsHeld()} sticks ${count(bot, "stick")} glass ${count(bot, "glass")}`,
      );
    }
    if (count(bot, "glass_bottle") < 1) {
      if (count(bot, "glass") < 3) {
        if (!nearStash)
          return {
            success: false,
            message: resumable("No glass bottle and no glass. Go to the stash for glass first."),
          };
        step("Withdrawing glass from the stash...", 0.1);
        const { withdrawStash } = await import("./stash.js");
        await Promise.race([
          withdrawStash(bot, STASH_POS, "glass", 3),
          new Promise<void>((r) => setTimeout(r, 45_000)),
        ]).catch(() => {});
      }
      if (count(bot, "glass") < 3) {
        return {
          success: false,
          message: resumable(`Only ${count(bot, "glass")} glass in the pack and the stash gave none (need 3).`),
        };
      }
      step("Crafting a glass bottle...", 0.2);
      const r = await executeAction(bot, "craft", { item: "glass_bottle", count: 1 }).catch((e: Error) => e.message);
      if (count(bot, "glass_bottle") < 1)
        return { success: false, message: resumable(`Couldn't craft a bottle: ${String(r).slice(0, 80)}`) };
    }
    if (signal.aborted) return { success: false, message: "Aborted." };

    // --- Phase B: the nest ---
    const here = bot.entity.position;
    const nests = knownNests().sort(
      (a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z),
    );
    const target = nests[0];
    if (!target) return { success: false, message: "No known bee nest." };
    const gapXZ = () => Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z);
    if (gapXZ() > 24) {
      bot.pathfinder.setMovements(explorerMoves(bot));
      const deadline = Date.now() + 170_000;
      let guard = 0;
      while (gapXZ() > 24 && Date.now() < deadline && !signal.aborted) {
        step(`Walking to the nest — ${Math.round(gapXZ())} blocks out...`, 0.3);
        const before = gapXZ();
        const t = Math.min(1, 100 / before);
        const wx = Math.round(bot.entity.position.x + (target.x - bot.entity.position.x) * t);
        const wz = Math.round(bot.entity.position.z + (target.z - bot.entity.position.z) * t);
        await safeGoto(bot, new goals.GoalNearXZ(wx, wz, 10), 45_000, 12_000).catch(() => {});
        if (before - gapXZ() >= 6) guard = 0;
        else if (++guard >= 3) break;
      }
    }
    if (gapXZ() <= 40) {
      await safeGoto(bot, new goals.GoalNear(target.x, target.y, target.z, 3), 45_000, 12_000).catch(() => {});
    }
    const { Vec3 } = await import("vec3");
    const hive = bot.blockAt(new Vec3(target.x, target.y, target.z));
    if (!hive || (hive.name !== "bee_nest" && hive.name !== "beehive")) {
      return {
        success: false,
        message: resumable(
          `Couldn't reach a nest (${Math.round(gapXZ())} blocks from ${target.x},${target.z}; there reads ${hive?.name ?? "unloaded"}).`,
        ),
      };
    }

    step("Seating a campfire under the nest...", 0.6);
    const fire = await ensureCampfire(bot, hive);
    if (fire) return { success: false, message: resumable(`No campfire under the nest: ${fire}.`) };

    let level = honeyLevel(hive.getProperties() as Record<string, unknown>) ?? 0;
    const until = Date.now() + 180_000;
    while (level < FULL_HONEY && Date.now() < until && !signal.aborted) {
      step(`Nest at honey ${level}/${FULL_HONEY} — waiting for the bees...`, 0.7);
      await new Promise((r) => setTimeout(r, 10_000));
      const b = bot.blockAt(hive.position);
      level = (b && honeyLevel(b.getProperties() as Record<string, unknown>)) ?? level;
    }
    if (level < FULL_HONEY) {
      return {
        success: false,
        message: resumable(`Nest at honey ${level}/${FULL_HONEY} — refilling. Stay near and retry.`),
      };
    }

    step("Bottling the honey...", 0.9);
    const bottle = bot.inventory.items().find((i) => i.name === "glass_bottle");
    if (!bottle) return { success: false, message: resumable("The glass bottle went missing.") };
    const before = count(bot, "honey_bottle");
    await bot.equip(bottle, "hand");
    await bot.lookAt(hive.position.offset(0.5, 0.5, 0.5), true);
    await bot.activateBlock(hive).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));
    const gained = count(bot, "honey_bottle") - before;
    console.log(`[HoneyDebug] ${bot.username}: honey_bottle +${gained} at nest ${hive.position} (campfire seated)`);
    if (gained > 0) {
      return {
        success: true,
        message: `Bottled honey at ${hive.position} with a campfire beneath — Bee Our Guest should be banked.`,
      };
    }
    return { success: false, message: resumable("Clicked the nest with the bottle but got no honey — retry.") };
  },
};
