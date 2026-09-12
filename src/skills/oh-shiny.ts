import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import mcDataLoader from "minecraft-data";
import { baseMoves, safeGoto, collectNearbyDrops } from "../bot/navigation.js";

/**
 * oh_shiny — distract a piglin with gold (nether/distract_piglin).
 *
 * Twelve gold ingots sit banked with no other job. Piglins ignore anyone in
 * gold armor, so the skill crafts golden boots first (4 ingots), carries a
 * few more through the village portal, finds a piglin, and tosses an ingot
 * at its feet. The pickup is the advancement. Every leg is bounded and the
 * skill walks itself home through the same portal, win or lose — the Nether
 * has eaten enough bots this run.
 */

function count(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((s, i) => s + i.count, 0);
}

function inNether(bot: Bot): boolean {
  const d = String(bot.game.dimension);
  return d === "the_nether" || d === "minecraft:the_nether";
}

async function craftAtTable(bot: Bot, want: string, n: number): Promise<boolean> {
  const mc = mcDataLoader(bot.version);
  const item = mc.itemsByName[want];
  if (!item) return false;
  const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 48 });
  if (!table) return false;
  try {
    await safeGoto(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20_000);
  } catch {
    /* craft still tries from where we are */
  }
  const recipe = bot.recipesFor(item.id, null, n, table)[0];
  if (!recipe) return false;
  try {
    await bot.craft(recipe, n, table);
    return true;
  } catch {
    return false;
  }
}

async function stepThroughPortal(bot: Bot, wantNether: boolean, budgetMs: number): Promise<boolean> {
  if (inNether(bot) === wantNether) return true;
  const portal = bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 64 });
  if (!portal) return false;
  // Reuse the crossing that actually earned We Need to Go Deeper. My two
  // rewrites both lost to the same pair of details it already handles:
  // clearing the pathfinder goal before manual controls (else the two fight
  // over steering), and STOPPING inside the frame — holding forward walks
  // straight through and out the far side before the ~4s teleport fires.
  const { crossPortal } = await import("./nether-portal.js");
  const wantDim = (dim: string) => {
    const nether = dim.includes("nether");
    return wantNether ? nether : !nether;
  };
  return crossPortal(bot, portal.position, budgetMs, wantDim);
}

export const ohShinySkill: Skill = {
  name: "oh_shiny",
  description:
    "Put on golden boots, carry gold ingots through the nether portal, and toss one to a piglin — earns the Oh Shiny advancement. Returns home afterward.",
  params: {},
  timeoutMs: 420_000,

  estimateMaterials(): Record<string, number> {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "oh_shiny", phase: "Barter", progress, message, active: true });
    const resumable = (msg: string) => `${msg} invoke_skill {"skill":"oh_shiny"} again to continue.`;

    const { withdrawStash } = await import("./stash.js");
    const { STASH_POS } = await import("../bot/role.js");
    const mc = mcDataLoader(bot.version);
    bot.pathfinder.setMovements(baseMoves(bot));

    // --- Overworld prep: boots + ingots ---
    if (!inNether(bot)) {
      const bootsAboard = () =>
        bot.inventory.items().some((i) => i.name === "golden_boots") ||
        bot.inventory.slots.some((s) => s?.name === "golden_boots");
      // The stash ledger recorded two pairs of golden boots on 2026-09-12
      // while this skill asked for four more gold to craft a third pair
      // ("Need 4 gold for boots (have 3)", four trips). Fetch a pair first.
      if (!bootsAboard()) {
        const nearStash = Math.hypot(bot.entity.position.x - STASH_POS.x, bot.entity.position.z - STASH_POS.z) < 60;
        if (nearStash) {
          step("Checking the stash for golden boots...", 0.06);
          const bres = await withdrawStash(bot, STASH_POS, "golden_boots", 1, 40_000).catch(
            (e: Error) => `threw: ${e.message}`,
          );
          console.log(`[ShinyDebug] boots withdraw: ${bres}`);
        }
      }
      const hasBoots = bootsAboard();
      const needGold = (hasBoots ? 0 : 4) + 3 - Math.min(3, count(bot, "gold_ingot"));
      if (needGold > 0) {
        step("Checking the fund chest...", 0.08);
        const { fundWithdraw } = await import("./fund-chest.js");
        const fw = await fundWithdraw(bot, "gold_ingot", needGold).catch((e: Error) => `threw: ${e.message}`);
        console.log(`[ShinyDebug] fund withdraw: ${fw}`);
      }
      if (count(bot, "gold_ingot") < needGold && needGold > 0) {
        step("Withdrawing gold from the stash...", 0.1);
        const wres = await withdrawStash(bot, STASH_POS, "gold_ingot", needGold, 40_000).catch(
          (e: Error) => `threw: ${e.message}`,
        );
        console.log(`[ShinyDebug] gold withdraw (want ${needGold}): ${wres}`);
        // Ingot drought: the stash's remaining gold is RAW. Take it aboard
        // and hand back — the raw-metal-aboard override smelts whatever a
        // bot carries (Blade's role now includes smelt_ores), and the next
        // firing finds real ingots in the pocket.
        if (count(bot, "gold_ingot") < needGold && count(bot, "raw_gold") < 1) {
          const rres = await withdrawStash(bot, STASH_POS, "raw_gold", 6, 40_000).catch(
            (e: Error) => `threw: ${e.message}`,
          );
          console.log(`[ShinyDebug] raw gold withdraw: ${rres}`);
          if (count(bot, "raw_gold") > 0) {
            return {
              success: false,
              message: resumable(
                `Raw gold aboard (${count(bot, "raw_gold")}) — the smelter reflex cooks it into ingots.`,
              ),
            };
          }
        }
      }
      if (!hasBoots) {
        // 4, not 5: the boots cost exactly 4, and the goldless Nether leg
        // below mines the offering gold on arrival. The old "need 5" gate
        // stranded Blade at exactly 4 for hours — one ingot short of a
        // threshold he never needed, since the trip funds its own offering.
        if (count(bot, "gold_ingot") < 4) {
          return {
            success: false,
            message: resumable(`Need 4 gold for boots (have ${count(bot, "gold_ingot")}).`),
          };
        }
        step("Crafting golden boots — piglins ignore a golden guest...", 0.2);
        const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 48 });
        if (!table) return { success: false, message: resumable("No crafting table for the boots.") };
        await safeGoto(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20_000).catch(
          () => {},
        );
        const recipe = bot.recipesFor(mc.itemsByName.golden_boots.id, null, 1, table)[0];
        if (!recipe) return { success: false, message: resumable("Golden boots recipe unavailable.") };
        try {
          await bot.craft(recipe, 1, table);
        } catch (e) {
          return { success: false, message: resumable(`Boot craft failed: ${(e as Error).message}.`) };
        }
      }
      const boots = bot.inventory.items().find((i) => i.name === "golden_boots");
      if (boots) await bot.equip(boots, "feet").catch(() => {});
      // The goldless leg mines nether gold ore, which needs any pickaxe: run
      // 552 found ore on the first scouting leg and the loop broke on "no
      // pickaxe" (Blade carried none). Fetch or craft one before crossing.
      const hasPick = () => bot.inventory.items().some((i) => i.name.endsWith("_pickaxe"));
      if (!hasPick() && count(bot, "gold_ingot") < 1) {
        step("No pickaxe for the gold ore — fetching one from the stash...", 0.12);
        for (const name of ["iron_pickaxe", "stone_pickaxe", "wooden_pickaxe"]) {
          if (hasPick()) break;
          await withdrawStash(bot, STASH_POS, name, 1, 30_000).catch(() => {});
        }
        if (!hasPick()) {
          if (count(bot, "cobblestone") < 3)
            await withdrawStash(bot, STASH_POS, "cobblestone", 3, 30_000).catch(() => {});
          if (count(bot, "stick") < 2) await withdrawStash(bot, STASH_POS, "stick", 4, 30_000).catch(() => {});
          const { executeAction } = await import("../bot/actions.js");
          const r = await executeAction(bot, "craft", { item: "stone_pickaxe", count: 1 }).catch(
            (e: Error) => e.message,
          );
          console.log(`[ShinyDebug] pickaxe craft: ${String(r).slice(0, 80)} -> hasPick=${hasPick()}`);
        }
        if (!hasPick()) {
          return {
            success: false,
            message: resumable("No pickaxe for the Nether gold ore and the stash had none to lend."),
          };
        }
      }
      // Self-funding: 9 nuggets craft an ingot, and the Nether leg below
      // mines nether gold ore when the pockets are empty — the stash ran
      // completely dry of gold, and waiting on overworld vein luck parked
      // the campaign. The Nether is made of gold; go get it.
      if (count(bot, "gold_ingot") < 1 && count(bot, "gold_nugget") >= 9) {
        step("Crafting ingots from mined nuggets...", 0.3);
        const crafted = await craftAtTable(bot, "gold_ingot", Math.floor(count(bot, "gold_nugget") / 9));
        console.log(`[ShinyDebug] nugget craft: ${crafted} -> ${count(bot, "gold_ingot")} ingots`);
      }
      if (count(bot, "gold_ingot") < 1) {
        const bootsOn = bot.inventory.slots.some((s) => s?.name === "golden_boots");
        if (!bootsOn) {
          return { success: false, message: resumable("No gold and no boots — need gold income first.") };
        }
        console.log("[ShinyDebug] goldless trip — heading over to MINE nether gold ore");
      }

      step("Stepping through the portal...", 0.35);
      const crossed = await stepThroughPortal(bot, true, 30_000);
      if (!crossed) {
        return { success: false, message: resumable("Couldn't reach or cross the portal this trip.") };
      }
    }

    // --- Nether: find a piglin, keep the portal at our back ---
    step("In the Nether — looking for a piglin...", 0.5);
    const homePortal = bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 24 });

    // Goldless trip: MINE instead of barter. Nether gold ore is everywhere
    // near the surface, digs with any pickaxe, and drops 2-6 nuggets each.
    if (count(bot, "gold_ingot") < 1) {
      step("Mining nether gold ore near the portal...", 0.55);
      const mineStart = Date.now();
      let dug = 0;
      // Search wider than 40 and, when the portal's neighbourhood has none,
      // scout two short legs before giving up: run 551 reported "mined 0"
      // on four trips without moving from the portal.
      let scouted = 0;
      while (dug < 6 && Date.now() - mineStart < 150_000 && !signal.aborted) {
        // Skip ore with lava within two blocks: Blade died twice in lava on
        // the first mining trip that worked (run 557, 6 ore, 30 nuggets).
        const { Vec3: V3 } = await import("vec3");
        const lavaNear = (p: { x: number; y: number; z: number }) => {
          for (let dx = -2; dx <= 2; dx++)
            for (let dy = -2; dy <= 1; dy++)
              for (let dz = -2; dz <= 2; dz++) {
                const n = bot.blockAt(new V3(p.x + dx, p.y + dy, p.z + dz))?.name;
                if (n === "lava" || n === "flowing_lava") return true;
              }
          return false;
        };
        const safeOre = (b: { name: string; position: { x: number; y: number; z: number } }) =>
          b.name === "nether_gold_ore" && !lavaNear(b.position);
        let ore = bot.findBlock({
          matching: (b) => b.name === "nether_gold_ore",
          maxDistance: 64,
          useExtraInfo: (b) => safeOre(b),
        });
        if (!ore && scouted < 2) {
          scouted++;
          const p = bot.entity.position;
          const [dx, dz] = scouted === 1 ? [40, 0] : [-40, 40];
          step(`No gold ore in sight — scouting leg ${scouted}...`, 0.58);
          await safeGoto(bot, new goals.GoalNearXZ(p.x + dx, p.z + dz, 8), 40_000, 12_000).catch(() => {});
          ore = bot.findBlock({
            matching: (b) => b.name === "nether_gold_ore",
            maxDistance: 64,
            useExtraInfo: (b) => safeOre(b),
          });
          console.log(`[ShinyDebug] scout leg ${scouted}: ore ${ore ? `at ${ore.position}` : "none within 64"}`);
        }
        if (!ore) break;
        const pick = bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
        if (!pick) break;
        await bot.equip(pick, "hand").catch(() => {});
        try {
          await safeGoto(bot, new goals.GoalNear(ore.position.x, ore.position.y, ore.position.z, 3), 30_000);
          const fresh = bot.blockAt(ore.position);
          if (fresh && fresh.name === "nether_gold_ore") await bot.dig(fresh);
          dug++;
        } catch (e) {
          console.log(`[ShinyDebug] gold-ore dig failed: ${(e as Error).message}`);
          break;
        }
      }
      await collectNearbyDrops(bot, 8, 6000);
      console.log(`[ShinyDebug] mined ${dug} nether_gold_ore — nuggets now ${count(bot, "gold_nugget")}`);
      step("Hauling the nuggets home...", 0.9);
      if (homePortal) {
        await safeGoto(
          bot,
          new goals.GoalNear(homePortal.position.x, homePortal.position.y, homePortal.position.z, 2),
          60_000,
        ).catch(() => {});
        await stepThroughPortal(bot, false, 30_000);
      }
      return {
        success: dug > 0,
        message: resumable(
          `Mined ${dug} gold ore (${count(bot, "gold_nugget")} nuggets aboard) — next trip crafts ingots and pays the piglin.`,
        ),
      };
    }
    // Adults only: a baby piglin SNATCHES gold from your hand and grants
    // nothing — no admire, no barter, no criteria progress, which matches
    // this trip's evidence exactly (held gold_ingot -> empty at 1.3 blocks,
    // zero advancement). Babies stand about half height.
    const adultPiglin = (e: { name?: string; height?: number }) => e.name === "piglin" && (e.height ?? 2) > 1.2;
    // Reachable piglins only: run 553 chose the nearest one, 16 blocks away
    // across something the planner could not cross ("No path to the goal"),
    // skipped four hand-offs out of reach and threw three ingots on the
    // ground that nobody picked up.
    const tried = new Set<number>();
    const nextPiglin = () =>
      Object.values(bot.entities)
        .filter((e) => adultPiglin(e) && !tried.has(e.id))
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] ??
      null;
    let piglin = nextPiglin();
    const scoutUntil = Date.now() + 90_000;
    while (!piglin && Date.now() < scoutUntil && !signal.aborted) {
      // Short bounded arcs around the portal — never out of walking-home range.
      const angle = Math.random() * Math.PI * 2;
      const base = homePortal?.position ?? bot.entity.position;
      await safeGoto(
        bot,
        new goals.GoalNearXZ(base.x + Math.cos(angle) * 32, base.z + Math.sin(angle) * 32, 6),
        30_000,
        12_000,
      ).catch(() => {});
      piglin = nextPiglin();
    }

    let tossed = 0;
    let approached = false;
    if (piglin) {
      step(`Piglin spotted — offering gold (${count(bot, "gold_ingot")} ingots aboard)...`, 0.7);
      console.log(`[ShinyDebug] target piglin height=${piglin.height?.toFixed(2)} (adult check passed)`);
      for (let attempt = 0; attempt < 3 && piglin && !signal.aborted; attempt++) {
        tried.add(piglin.id);
        await safeGoto(bot, new goals.GoalFollow(piglin, 2), 20_000).catch(() => {});
        const d = piglin.isValid ? bot.entity.position.distanceTo(piglin.position) : 99;
        console.log(`[ShinyDebug] approach ${attempt + 1}: piglin ${piglin.id} at ${d.toFixed(1)} blocks`);
        if (d <= 3.5) {
          approached = true;
          break;
        }
        const next = nextPiglin();
        if (!next) break;
        piglin = next;
      }
      if (!approached) {
        console.log(`[ShinyDebug] no reachable piglin this trip (tried ${tried.size}); keeping the gold`);
      }
      // Direct hand-off FIRST: the first expedition's thrown gold bartered
      // beautifully (crying obsidian came back) yet left ZERO criteria
      // progress on distract_piglin — the pickup never credited the thrower.
      // Using the ingot ON the piglin fires distract_piglin_directly, the
      // advancement's other criterion, deterministically.
      const handGold = bot.inventory.items().find((i) => i.name === "gold_ingot");
      if (approached && handGold && piglin.isValid) {
        await bot.equip(handGold, "hand").catch(() => {});
        await safeGoto(bot, new goals.GoalFollow(piglin, 2), 15_000).catch(() => {});
        if (piglin.isValid) {
          // activateEntity is the right-click INTERACT (the packet the
          // player_interacted_with_entity trigger listens for); useOn is the
          // use-item path for saddles and shears. The first direct attempt
          // sent only useOn and the criteria file stayed empty — send the
          // interact, with held-item and range logged so a miss has a name.
          for (let k = 0; k < 4 && piglin.isValid; k++) {
            // Re-close the gap EVERY round — the piglin wanders, and the
            // adult-piglin trip sent all three interacts from 8+ blocks out
            // (interact reach is ~4), two of them holding a pickaxe. Equip
            // first, approach second, and only send when both are right.
            const g = bot.inventory.items().find((i) => i.name === "gold_ingot");
            if (!g && bot.heldItem?.name !== "gold_ingot") break;
            if (bot.heldItem?.name !== "gold_ingot" && g) await bot.equip(g, "hand").catch(() => {});
            await safeGoto(bot, new goals.GoalFollow(piglin, 2), 12_000).catch(() => {});
            const held = bot.heldItem?.name ?? "empty";
            const range = bot.entity.position.distanceTo(piglin.position);
            console.log(`[ShinyDebug] direct hand-off ${k + 1}: held=${held} dist=${range.toFixed(1)}`);
            if (range > 3.5 || held !== "gold_ingot") {
              console.log(`[ShinyDebug] hand-off ${k + 1} skipped (out of reach or wrong item) — re-approaching`);
              continue;
            }
            await bot.lookAt(piglin.position.offset(0, 1.6, 0), true).catch(() => {});
            const goldBefore = count(bot, "gold_ingot");
            // The advancement's fine print (data/minecraft/advancement/nether/
            // distract_piglin.json): the player must be wearing NO piglin-safe
            // armor on head, chest, legs or feet at the moment of the
            // hand-off. Run 554: the piglin took the ingot into its offhand
            // and nothing was credited, because Blade wore golden boots. Take
            // them off for the instant of the offer and put them back on.
            // unequip needs a free inventory slot; a full pack leaves the boots
            // on and the criteria fail silently. Make room, then verify.
            if (bot.inventory.emptySlotCount() < 1) {
              const junk = bot.inventory
                .items()
                .find((i) =>
                  ["cobblestone", "netherrack", "dirt", "gravel", "cobbled_deepslate", "tuff"].includes(i.name),
                );
              if (junk) await bot.toss(junk.type, null, junk.count).catch(() => {});
            }
            await bot.unequip("feet").catch(() => {});
            await new Promise((r) => setTimeout(r, 300));
            const feetSlot = bot.inventory.slots[8]?.name ?? "empty";
            const armorNow = [5, 6, 7, 8].map((i) => bot.inventory.slots[i]?.name ?? "-").join(",");
            console.log(
              `[ShinyDebug] armor before hand-off: ${armorNow} (feet=${feetSlot}, freeSlots=${bot.inventory.emptySlotCount()})`,
            );
            try {
              await (bot as any).activateEntity(piglin);
            } catch (e) {
              console.log(`[ShinyDebug] activateEntity threw: ${(e as Error).message}`);
              try {
                (bot as any).useOn(piglin);
              } catch {
                /* both paths failed this round */
              }
            }
            await new Promise((r) => setTimeout(r, 1_500));
            // Ground truth for the hand-off (run 550: four hand-offs at one
            // block, no criteria written): a piglin that took the ingot
            // holds it in its offhand and admires it for six seconds, and
            // our stack drops by one. Log both, and give an accepted ingot
            // its six seconds before offering the next.
            const bootsBack = bot.inventory.items().find((i) => i.name === "golden_boots");
            if (bootsBack) await bot.equip(bootsBack, "feet").catch(() => {});
            const offhand = (piglin as any).equipment?.[1]?.name ?? "empty";
            const accepted = offhand === "gold_ingot" || count(bot, "gold_ingot") < goldBefore;
            console.log(
              `[ShinyDebug] after hand-off ${k + 1}: piglin offhand=${offhand} ourGold ${goldBefore}->${count(bot, "gold_ingot")} accepted=${accepted}`,
            );
            if (accepted) {
              await new Promise((r) => setTimeout(r, 8_000));
              break;
            }
            await new Promise((r) => setTimeout(r, 2_000));
          }
          tossed++;
          await new Promise((r) => setTimeout(r, 7_000));
        }
      }
      while (approached && tossed < 3 && piglin.isValid && count(bot, "gold_ingot") > 0 && !signal.aborted) {
        await safeGoto(bot, new goals.GoalFollow(piglin, 4), 15_000).catch(() => {});
        if (!piglin.isValid) break;
        const gold = bot.inventory.items().find((i) => i.name === "gold_ingot");
        if (!gold) break;
        await bot.lookAt(piglin.position.offset(0, 1, 0), true);
        // Same fine print for the thrown route: no gold armor while the
        // piglin picks the ingot up. Bare feet for a few seconds, then boots.
        await bot.unequip("feet").catch(() => {});
        await bot.toss(gold.type, null, 1).catch(() => {});
        tossed++;
        // The piglin walks over, picks it up, and admires it for six seconds.
        await new Promise((r) => setTimeout(r, 4_000));
        const offAfterToss = (piglin as any).equipment?.[1]?.name ?? "empty";
        const goldOnGround = Object.values(bot.entities).some(
          (e) =>
            e.name === "item" &&
            (e as any).getDroppedItem?.()?.name === "gold_ingot" &&
            e.position.distanceTo(bot.entity.position) < 12,
        );
        console.log(
          `[ShinyDebug] after toss ${tossed}: piglin offhand=${offAfterToss} goldStillOnGround=${goldOnGround}`,
        );
        await new Promise((r) => setTimeout(r, 5_000));
        const bootsAgain = bot.inventory.items().find((i) => i.name === "golden_boots");
        if (bootsAgain) await bot.equip(bootsAgain, "feet").catch(() => {});
      }
    }

    // --- Walk home, always ---
    step("Heading back through the portal...", 0.9);
    if (homePortal) {
      await safeGoto(
        bot,
        new goals.GoalNear(homePortal.position.x, homePortal.position.y, homePortal.position.z, 0),
        60_000,
      ).catch(() => {});
      await stepThroughPortal(bot, false, 30_000);
    }

    console.log(
      `[ShinyDebug] ${bot.username}: piglin=${!!piglin} tossed=${tossed} home=${!inNether(bot)} goldLeft=${count(bot, "gold_ingot")}`,
    );
    if (tossed > 0) {
      return {
        success: true,
        message: `Tossed ${tossed} gold to a piglin — Oh Shiny should be banked (files will confirm).`,
        stats: { tossed },
      };
    }
    if (!piglin) {
      return { success: false, message: resumable("No piglin found within the safe arc this trip.") };
    }
    return { success: false, message: resumable("Found a piglin but the gold never left the pocket.") };
  },
};
