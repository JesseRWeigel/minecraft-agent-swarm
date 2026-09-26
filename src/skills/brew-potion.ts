import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import mcDataLoader from "minecraft-data";
import { safeGoto } from "../bot/navigation.js";

/**
 * brew_potion: earn Local Brewery by brewing one potion at a stand by the
 * stash.
 *
 * Run 818 banked the swarm's first blaze rod. A brewing stand is one rod on
 * three cobblestone, its fuel is blaze powder ground from a second rod, and
 * sugar in a water bottle brews a Mundane Potion. Taking any brewed potion
 * out of the stand is the advancement.
 *
 * Brewing stand window slots (1.21): 0-2 bottles, 3 ingredient, 4 fuel.
 */

const BOTTLE_SLOTS = [0, 1, 2];
const INGREDIENT_SLOT = 3;
const FUEL_SLOT = 4;
const BREW_WAIT_MS = 35_000;

export interface BrewStock {
  rods: number;
  powder: number;
  standPlaced: boolean;
  standHeld: boolean;
  sugar: number;
  sugarCane: number;
  emptyBottles: number;
  filledBottles: number;
}

/**
 * What is still missing before a brew can start. An empty list means go.
 * The stand costs a rod unless one is already placed or held; the fuel
 * costs a rod unless powder is already in hand.
 */
export function brewShortfall(s: BrewStock): string[] {
  const missing: string[] = [];
  const rodsForStand = s.standPlaced || s.standHeld ? 0 : 1;
  const rodsForFuel = s.powder > 0 ? 0 : 1;
  if (s.rods < rodsForStand + rodsForFuel) missing.push(`blaze_rod x${rodsForStand + rodsForFuel - s.rods}`);
  if (s.sugar + s.sugarCane < 1) missing.push("sugar");
  if (s.emptyBottles + s.filledBottles < 1) missing.push("glass_bottle");
  return missing;
}

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

/** Can a bottle reach this water? Its top face must be open air. */
export function openToSky(above: string | undefined): boolean {
  return above === "air" || above === "cave_air";
}

export const brewPotionSkill: Skill = {
  name: "brew_potion",
  description:
    "Build a brewing stand by the stash (blaze rod + 3 cobblestone), fuel it with blaze powder, and brew sugar into water bottles for a Mundane Potion. Earns Local Brewery. Needs two blaze rods banked.",
  params: {},
  timeoutMs: 240_000,

  estimateMaterials() {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "brew_potion", phase: "Brewing", progress, message, active: true });
    const { withdrawStash } = await import("./stash.js");
    const { STASH_POS } = await import("../bot/role.js");
    const take = async (name: string, n: number) => {
      if (count(bot, name) >= n) return;
      await withdrawStash(bot, STASH_POS, name, n - count(bot, name), 40_000).catch(() => {});
    };

    step("Gathering rods, stone, sugar and bottles from the stash...", 0.1);
    const placedStand = () => bot.findBlock({ matching: (b) => b.name === "brewing_stand", maxDistance: 24 });
    // Banked parts from an earlier attempt come first.
    if (!placedStand()) await take("brewing_stand", 1);
    await take("blaze_powder", 1);
    const rodsNeeded = (placedStand() || count(bot, "brewing_stand") > 0 ? 0 : 1) + (count(bot, "blaze_powder") > 0 ? 0 : 1);
    if (rodsNeeded > 0) await take("blaze_rod", rodsNeeded);
    await take("cobblestone", 3);
    await take("sugar_cane", 1);
    await take("glass_bottle", 3);
    if (count(bot, "glass_bottle") === 0) await take("potion", 3);
    if (signal.aborted) return { success: false, message: "Brewing aborted." };

    const stock: BrewStock = {
      rods: count(bot, "blaze_rod"),
      powder: count(bot, "blaze_powder"),
      standPlaced: !!placedStand(),
      standHeld: count(bot, "brewing_stand") > 0,
      sugar: count(bot, "sugar"),
      sugarCane: count(bot, "sugar_cane"),
      emptyBottles: count(bot, "glass_bottle"),
      filledBottles: count(bot, "potion"),
    };
    const missing = brewShortfall(stock);
    console.log(`[Brew] ${bot.username}: stock ${JSON.stringify(stock)} missing=[${missing.join(", ")}]`);
    if (missing.length) {
      return { success: false, message: `Can't brew yet: missing ${missing.join(", ")}.` };
    }

    // 2x2 crafts first: powder and sugar need no table.
    if (count(bot, "blaze_powder") === 0) await craftOne(bot, "blaze_powder", null);
    if (count(bot, "sugar") === 0) await craftOne(bot, "sugar", null);

    // The stand is a 3x3 recipe.
    if (!placedStand() && count(bot, "brewing_stand") === 0) {
      step("Crafting a brewing stand...", 0.3);
      const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
      if (!table) return { success: false, message: "No crafting table within 32 blocks for the brewing stand." };
      await safeGoto(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20_000).catch(
        () => {},
      );
      if (!(await craftOne(bot, "brewing_stand", table))) {
        return { success: false, message: "Couldn't craft the brewing stand (blaze rod + 3 cobblestone at a table)." };
      }
    }

    // Fill empty bottles at a still water block.
    let water: ReturnType<Bot["findBlock"]> = null;
    if (count(bot, "glass_bottle") > 0) {
      step("Filling bottles at the water...", 0.45);
      // Run 847: both waters Mason chose were covered, (252, 62, -319) under
      // stone and (303, 54, -315) in a cave, so the fill ray met rock first.
      // A probe filled 8 of 8 bottles at an open source. Take open water only.
      water =
        bot
          .findBlocks({ matching: (b) => b.name === "water" && (b.metadata ?? 0) === 0, maxDistance: 32, count: 64 })
          .filter((p) => openToSky(bot.blockAt(p.offset(0, 1, 0))?.name))
          .map((p) => bot.blockAt(p))
          .find((b) => !!b) ?? null;
      if (water) {
        await safeGoto(bot, new goals.GoalNear(water.position.x, water.position.y + 1, water.position.z, 3), 25_000).catch(
          () => {},
        );
        for (let i = 0; i < 3 && count(bot, "glass_bottle") > 0 && !signal.aborted; i++) {
          const bottle = bot.inventory.items().find((it) => it.name === "glass_bottle");
          if (!bottle) break;
          await bot.equip(bottle, "hand").catch(() => {});
          await bot.lookAt(water.position.offset(0.5, 0.9, 0.5), true).catch(() => {});
          bot.activateItem();
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      console.log(
        `[Brew] ${bot.username}: water ${water ? `at ${water.position} (${water.position.distanceTo(bot.entity.position).toFixed(1)} away)` : "not found within 32"}; bottles filled -> potion ${count(bot, "potion")}, empty ${count(bot, "glass_bottle")}`,
      );
    }
    // Run 844: the first brew with two rods in reach stopped here, three
    // bottles and none filled, while the stash held three potions. Take those
    // before giving up; a water bottle is what sugar brews from.
    if (count(bot, "potion") === 0) {
      await take("potion", 3);
      console.log(`[Brew] ${bot.username}: took banked potions instead -> ${count(bot, "potion")}`);
    }
    if (count(bot, "potion") === 0) return { success: false, message: "No water bottles: couldn't fill any." };

    // Place the stand beside the stash if none stands nearby.
    let stand = placedStand();
    if (!stand) {
      step("Placing the brewing stand...", 0.6);
      await safeGoto(bot, new goals.GoalNear(STASH_POS.x, STASH_POS.y, STASH_POS.z, 4), 30_000).catch(() => {});
      const item = bot.inventory.items().find((i) => i.name === "brewing_stand");
      if (item) {
        await bot.equip(item, "hand").catch(() => {});
        // Run 846: the first placement tried six cells beside the stash and
        // all six were chests, torches or rough ground. Try every air cell on
        // a solid top face within three blocks, nearest first, skipping the
        // cells the bot itself stands in.
        const pos = bot.entity.position.floored();
        const spots: Vec3[] = [];
        for (let dx = -3; dx <= 3; dx++) {
          for (let dz = -3; dz <= 3; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
              if (dx === 0 && dz === 0) continue;
              spots.push(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz));
            }
          }
        }
        spots.sort((a, b) => a.distanceTo(pos) - b.distanceTo(pos));
        let tried = 0;
        for (const t of spots) {
          const target = bot.blockAt(t);
          const below = bot.blockAt(t.offset(0, -1, 0));
          if (!target || target.name !== "air" || !below || below.boundingBox !== "block") continue;
          if (/chest|furnace|table|bed|door|torch/.test(below.name)) continue;
          tried++;
          try {
            await bot.placeBlock(below, new Vec3(0, 1, 0));
            if (placedStand()) break;
          } catch {
            /* next spot */
          }
          if (tried >= 8) break;
        }
        console.log(`[Brew] ${bot.username}: stand placement tried ${tried} spot(s) -> ${placedStand() ? "placed" : "none took"}`);
      }
      stand = placedStand();
      if (!stand) return { success: false, message: "Couldn't place the brewing stand here." };
    }

    // Brew.
    step("Brewing sugar into water bottles...", 0.75);
    await safeGoto(bot, new goals.GoalNear(stand.position.x, stand.position.y, stand.position.z, 2), 20_000).catch(
      () => {},
    );
    const win = await bot.openBlock(stand).catch(() => null);
    if (!win) return { success: false, message: "Couldn't open the brewing stand." };
    try {
      const move = async (name: string, dest: number) => {
        if (win.slots[dest]) return;
        const id = mcDataLoader(bot.version).itemsByName[name]?.id;
        if (id === undefined) return;
        const it = win.findInventoryItem(id, null, false);
        if (it) await bot.moveSlotItem(it.slot, dest);
      };
      await move("blaze_powder", FUEL_SLOT);
      for (const s of BOTTLE_SLOTS) await move("potion", s);
      await move("sugar", INGREDIENT_SLOT);
      console.log(
        `[Brew] ${bot.username}: loaded fuel=${win.slots[FUEL_SLOT]?.name} ingredient=${win.slots[INGREDIENT_SLOT]?.name} bottles=${BOTTLE_SLOTS.map((s) => win.slots[s]?.name ?? "-").join(",")}`,
      );
      if (!win.slots[INGREDIENT_SLOT] || !BOTTLE_SLOTS.some((s) => win.slots[s])) {
        return { success: false, message: "Couldn't load the brewing stand." };
      }
      const until = Date.now() + BREW_WAIT_MS;
      while (Date.now() < until && win.slots[INGREDIENT_SLOT] && !signal.aborted) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (win.slots[INGREDIENT_SLOT]) {
        return { success: false, message: "The sugar did not brew (bottles may not hold water)." };
      }
      // Taking the potion out is the advancement.
      for (const s of BOTTLE_SLOTS) {
        if (win.slots[s]) await bot.clickWindow(s, 0, 1).catch(() => {});
      }
      console.log(`[Brew] ${bot.username}: brewed and took ${count(bot, "potion")} potions`);
    } finally {
      bot.closeWindow(win);
    }
    return { success: true, message: "Brewed a Mundane Potion at the stand by the stash." };
  },
};
