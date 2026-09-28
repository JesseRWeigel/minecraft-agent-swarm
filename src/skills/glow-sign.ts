import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import mcDataLoader from "minecraft-data";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { safeGoto } from "../bot/navigation.js";

/**
 * glow_sign: earn "Glow and Behold!" (husbandry/make_a_sign_glow) by using a
 * glow ink sac on a sign. Advancements sat at 41 for two days (2026-09-26
 * to 09-28) while the stash held forty glow ink sacs from fishing and the
 * swarm had wood again. A sign is 6 planks of one kind and a stick at a
 * crafting table; it goes down on a solid block near the stash, and the ink
 * sac is used on it the way a player right-clicks.
 */

function count(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((s, i) => s + i.count, 0);
}

async function craftOne(bot: Bot, want: string, table: ReturnType<Bot["findBlock"]>): Promise<boolean> {
  const mc = mcDataLoader(bot.version);
  const item = mc.itemsByName[want];
  if (!item) return false;
  const recipe = bot.recipesFor(item.id, null, 1, table ?? null)[0];
  if (!recipe) return false;
  try {
    await bot.craft(recipe, 1, table ?? undefined);
    return true;
  } catch {
    return false;
  }
}

/** The wood kind of a planks stack with at least `n` items, or null. */
export function plankKindFor(stacks: { name: string; count: number }[], n = 6): string | null {
  const totals = new Map<string, number>();
  for (const s of stacks) {
    if (!s.name.endsWith("_planks")) continue;
    totals.set(s.name, (totals.get(s.name) ?? 0) + s.count);
  }
  for (const [name, total] of totals) if (total >= n) return name.replace(/_planks$/, "");
  return null;
}

const SKIP_TOPS = /chest|furnace|crafting_table|bed|door|torch|sign|brewing_stand|water|lava/;

export const glowSignSkill: Skill = {
  name: "glow_sign",
  description:
    "Craft a sign from 6 planks and a stick, place it by the stash, and use a glow ink sac on it. Earns Glow and Behold!",
  params: {},
  timeoutMs: 240_000,

  estimateMaterials() {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "glow_sign", phase: "Sign", progress, message, active: true });
    const { withdrawStash } = await import("./stash.js");
    const { STASH_POS } = await import("../bot/role.js");
    const take = async (name: string, n: number) =>
      withdrawStash(bot, STASH_POS, name, n, 40_000).catch((e: Error) => e.message);

    step("Gathering an ink sac, planks and a stick...", 0.1);
    if (count(bot, "glow_ink_sac") === 0) await take("glow_ink_sac", 1);
    const signHeld = () => bot.inventory.items().find((i) => i.name.endsWith("_sign") && !i.name.includes("hanging"));
    if (!signHeld()) {
      if (!plankKindFor(bot.inventory.items())) await take("planks", 6);
      if (!plankKindFor(bot.inventory.items())) {
        await take("log", 2);
        const log = bot.inventory.items().find((i) => i.name.endsWith("_log") && !i.name.startsWith("stripped"));
        if (log) {
          const kind = log.name.replace(/_log$/, "");
          for (let i = 0; i < 2; i++) await craftOne(bot, `${kind}_planks`, null);
        }
      }
      if (count(bot, "stick") === 0) {
        await take("stick", 1);
        if (count(bot, "stick") === 0) await craftOne(bot, "stick", null);
      }
    }
    if (signal.aborted) return { success: false, message: "Sign run aborted." };
    const kind = plankKindFor(bot.inventory.items());
    console.log(
      `[Sign] ${bot.username}: ink ${count(bot, "glow_ink_sac")}, sign ${signHeld()?.name ?? "none"}, planks kind ${kind ?? "none"}, sticks ${count(bot, "stick")}`,
    );
    if (count(bot, "glow_ink_sac") === 0) return { success: false, message: "No glow ink sac in reach." };

    if (!signHeld()) {
      if (!kind || count(bot, "stick") === 0) {
        return { success: false, message: "Need 6 planks of one kind and a stick for a sign." };
      }
      step("Crafting a sign...", 0.35);
      const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
      if (!table) return { success: false, message: "No crafting table within 32 blocks for the sign." };
      await safeGoto(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20_000).catch(
        () => {},
      );
      if (!(await craftOne(bot, `${kind}_sign`, table))) {
        return { success: false, message: `Could not craft a ${kind}_sign at the table.` };
      }
    }
    const sign = signHeld();
    if (!sign) return { success: false, message: "No sign after crafting." };

    // Place it on a solid top within 3 blocks, nearest first.
    step("Placing the sign...", 0.6);
    await bot.equip(sign, "hand").catch(() => {});
    const pos = bot.entity.position.floored();
    const spots: Vec3[] = [];
    for (let dx = -3; dx <= 3; dx++)
      for (let dz = -3; dz <= 3; dz++)
        for (let dy = -1; dy <= 1; dy++) if (dx || dz) spots.push(pos.offset(dx, dy, dz));
    // Run 872: Mason tried eight spots and none took; a probe placed on the
    // nearest and timed out ("blockUpdate did not fire") on spots further
    // off. Keep to arm's reach from the eyes.
    const eye = bot.entity.position.offset(0, 1.62, 0);
    spots.sort((a, b) => a.distanceTo(pos) - b.distanceTo(pos));
    const inReach = (v: Vec3) => eye.distanceTo(v.offset(0.5, 0.5, 0.5)) <= 4.2;
    let placed: ReturnType<Bot["blockAt"]> = null;
    let tries = 0;
    for (const t of spots) {
      if (tries >= 8 || signal.aborted) break;
      const target = bot.blockAt(t);
      const below = bot.blockAt(t.offset(0, -1, 0));
      if (
        !target ||
        !/air$/.test(target.name) ||
        !below ||
        below.boundingBox !== "block" ||
        SKIP_TOPS.test(below.name) ||
        !inReach(t)
      )
        continue;
      tries++;
      try {
        await bot.placeBlock(below, new Vec3(0, 1, 0));
      } catch (e) {
        if (tries === 1) console.log(`[Sign] ${bot.username}: place at ${t} -> ${(e as Error).message.slice(0, 80)}`);
      }
      await new Promise((r) => setTimeout(r, 400));
      const now = bot.blockAt(t);
      if (now && now.name.endsWith("_sign")) {
        placed = now;
        break;
      }
    }
    console.log(`[Sign] ${bot.username}: sign placement tried ${tries} spot(s) -> ${placed ? `placed at ${placed.position}` : "none took"}`);
    if (!placed) return { success: false, message: "Couldn't place the sign here." };

    // Close the editor the server opens on placement, then apply the ink.
    try {
      bot.closeWindow(bot.currentWindow as never);
    } catch {
      /* no window */
    }
    // Glow ink only takes on a sign with writing on it (1.20+: the applicator
    // needs a message on the side it is used on). A probe's ink stayed at 2
    // on a blank sign. Write a word first.
    try {
      bot.updateSign(placed, "Glow");
    } catch {
      /* the next check reports it */
    }
    await new Promise((r) => setTimeout(r, 600));
    step("Making the sign glow...", 0.85);
    const ink = bot.inventory.items().find((i) => i.name === "glow_ink_sac");
    if (!ink) return { success: false, message: "The ink sac went missing." };
    await bot.equip(ink, "hand").catch(() => {});
    await bot.lookAt(placed.position.offset(0.5, 0.5, 0.5), true).catch(() => {});
    const before = count(bot, "glow_ink_sac");
    await bot.activateBlock(placed).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    const after = count(bot, "glow_ink_sac");
    console.log(`[Sign] ${bot.username}: used the ink sac on the sign -> ink ${before} -> ${after}`);
    return {
      success: after < before,
      message: after < before ? "The sign glows (Glow and Behold!)." : "The ink sac did not take on the sign.",
    };
  },
};
