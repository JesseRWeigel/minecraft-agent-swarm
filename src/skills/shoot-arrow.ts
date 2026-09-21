import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import mcDataLoader from "minecraft-data";
import { baseMoves, safeGoto } from "../bot/navigation.js";

/**
 * shoot_arrow — Take Aim, deterministically.
 *
 * The armory already banks 63 arrows; the bow is 3 sticks + 3 string at a
 * table. This skill assembles whatever is missing from the stash, walks to
 * the nearest passive animal, and fires one full-draw shot from close range.
 * Success is read from a server-echoed signal only: the entityHurt event for
 * the target (or its death) within two seconds of release.
 */

const TARGETS = new Set(["sheep", "chicken", "pig", "cow", "rabbit", "horse", "donkey"]);

function count(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((s, i) => s + i.count, 0);
}

export const shootArrowSkill: Skill = {
  name: "shoot_arrow",
  description:
    "Craft a bow if needed (3 sticks + 3 string, stash-first), take arrows from the stash, and shoot a nearby animal — earns the Take Aim advancement.",
  params: {},

  estimateMaterials(): Record<string, number> {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "shoot_arrow", phase: "Aim", progress, message, active: true });
    const resumable = (msg: string) => `${msg} invoke_skill {"skill":"shoot_arrow"} again to continue.`;

    const { withdrawStash } = await import("./stash.js");
    const { STASH_POS } = await import("../bot/role.js");
    const nearStash = () => Math.hypot(bot.entity.position.x - STASH_POS.x, bot.entity.position.z - STASH_POS.z) < 60;

    // --- Crossbow first ---
    // Run 748: the armoury holds crossbows and no string, and this skill
    // returned "Bow needs 3 string (have 1)" before it ever reached the
    // crossbow code further down. A crossbow does everything a bow does
    // here, so fetch one before spending string the swarm does not have.
    if (count(bot, "crossbow") < 1 && nearStash()) {
      step("Checking the armoury for a crossbow...", 0.1);
      await withdrawStash(bot, STASH_POS, "crossbow", 1, 30_000).catch(() => {});
    }
    const haveCrossbowEarly = count(bot, "crossbow") > 0;

    // --- Bow ---
    if (!haveCrossbowEarly && count(bot, "bow") < 1) {
      step("No bow yet — checking the stash...", 0.1);
      if (nearStash()) await withdrawStash(bot, STASH_POS, "bow", 1, 30_000).catch(() => {});
    }
    if (!haveCrossbowEarly && count(bot, "bow") < 1) {
      if (count(bot, "string") < 3 && nearStash()) {
        await withdrawStash(bot, STASH_POS, "string", 3 - count(bot, "string"), 30_000).catch(() => {});
      }
      if (count(bot, "stick") < 3 && nearStash()) {
        await withdrawStash(bot, STASH_POS, "stick", 3, 30_000).catch(() => {});
      }
      if (count(bot, "string") < 3) {
        return { success: false, message: resumable(`Bow needs 3 string (have ${count(bot, "string")}).`) };
      }
      step("Crafting the bow...", 0.3);
      const mc = mcDataLoader(bot.version);
      const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 48 });
      if (!table) return { success: false, message: resumable("No crafting table in range for the bow.") };
      await safeGoto(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20_000).catch(
        () => {},
      );
      const recipe = bot.recipesFor(mc.itemsByName.bow.id, null, 1, table)[0];
      if (!recipe) return { success: false, message: resumable("Bow recipe unavailable (missing materials?).") };
      try {
        await bot.craft(recipe, 1, table);
      } catch (e) {
        return { success: false, message: resumable(`Bow craft failed: ${(e as Error).message}.`) };
      }
    }

    // --- Arrows ---
    if (count(bot, "arrow") < 1 && nearStash()) {
      step("Taking arrows from the stash...", 0.5);
      await withdrawStash(bot, STASH_POS, "arrow", 8, 30_000).catch(() => {});
    }
    if (count(bot, "arrow") < 1) {
      return { success: false, message: resumable("Have the bow but no arrows in reach.") };
    }

    // --- Target ---
    const target = bot.nearestEntity((e) => TARGETS.has(e.name ?? ""));
    if (!target) {
      return { success: false, message: resumable("Bow and arrows ready — no animal in sight to shoot.") };
    }
    step(`Stalking a ${target.name} (${bot.entity.position.distanceTo(target.position).toFixed(0)} blocks)...`, 0.6);
    bot.pathfinder.setMovements(baseMoves(bot));
    await safeGoto(bot, new goals.GoalFollow(target, 4), 30_000).catch(() => {});
    if (!target.isValid || bot.entity.position.distanceTo(target.position) > 8) {
      return { success: false, message: resumable(`The ${target.name} slipped away before the shot.`) };
    }

    // --- Pick the weapon ---
    // Ol' Betsy wants a crossbow fired, and the armoury already holds five of
    // them next to 119 arrows while the ledger has never counted it. A
    // crossbow also satisfies everything a bow does here, so prefer one when
    // it is reachable; a crossbow is loaded first and fired second, where a
    // bow draws and looses in a single hold.
    const crossbow = bot.inventory.items().find((i) => i.name === "crossbow");
    const bow = crossbow ?? bot.inventory.items().find((i) => i.name === "bow");
    if (!bow) return { success: false, message: resumable("Bow vanished before the shot.") };
    await bot.equip(bow, "hand");
    const usingCrossbow = !!crossbow;
    if (usingCrossbow) {
      // Load it: hold, then release. The arrow stays on the string.
      bot.activateItem();
      await new Promise((r) => setTimeout(r, 1_500));
      bot.deactivateItem();
      await new Promise((r) => setTimeout(r, 300));
      console.log(`[AimDebug] ${bot.username}: crossbow loaded, firing at ${target.name}`);
    }

    let shots = 0;
    let hit = false;
    while (!hit && shots < 4 && target.isValid && !signal.aborted) {
      shots++;
      step(`Full draw on the ${target.name} (shot ${shots})...`, 0.7 + shots * 0.05);
      const hurtPromise = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          bot.removeListener("entityHurt" as any, onHurt);
          resolve(false);
        }, 2_500);
        const onHurt = (e: { id: number }) => {
          if (e.id === target.id) {
            clearTimeout(timer);
            bot.removeListener("entityHurt" as any, onHurt);
            resolve(true);
          }
        };
        bot.on("entityHurt" as any, onHurt);
      });
      await bot.lookAt(target.position.offset(0, (target.height ?? 1.4) * 0.85, 0), true);
      bot.activateItem();
      // A loaded crossbow fires on the click; a bow needs the draw held.
      await new Promise((r) => setTimeout(r, usingCrossbow ? 250 : 1_400));
      await bot.lookAt(target.position.offset(0, (target.height ?? 1.4) * 0.85, 0), true);
      bot.deactivateItem();
      if (usingCrossbow && !hit) {
        // Reload for the next shot.
        bot.activateItem();
        await new Promise((r) => setTimeout(r, 1_500));
        bot.deactivateItem();
      }
      hit = (await hurtPromise) || !target.isValid;
      if (!hit) await new Promise((r) => setTimeout(r, 800));
    }

    console.log(`[AimDebug] ${bot.username} vs ${target.name}: shots=${shots} hit=${hit} valid=${target.isValid}`);
    if (hit) {
      return {
        success: true,
        message: `Arrow struck the ${target.name} from a ${usingCrossbow ? "crossbow" : "bow"}${usingCrossbow ? " — Ol' Betsy too" : ""}!`,
        stats: { shots },
      };
    }
    return { success: false, message: resumable(`${shots} arrows missed the ${target.name} — will retry.`) };
  },
};
