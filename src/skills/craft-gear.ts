import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { LOG_TYPES } from "./materials.js";
import mcDataLoader from "minecraft-data";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { Vec3 } from "vec3";
import { baseMoves } from "../bot/navigation.js";

/** Tool tiers from best to worst. */
const TIERS = [
  { name: "diamond", material: "diamond" },
  { name: "iron", material: "iron_ingot" },
  { name: "stone", material: "cobblestone" },
  { name: "wooden", material: "oak_planks" },
];

const TOOL_TYPES = ["pickaxe", "axe", "sword", "shovel"];

/** Pickaxe tiers for the metal-reservation check below. */
const PICK_PRIORITY: Record<string, number> = {
  wooden_pickaxe: 0,
  stone_pickaxe: 1,
  golden_pickaxe: 1,
  iron_pickaxe: 2,
  diamond_pickaxe: 3,
  netherite_pickaxe: 4,
};
// Armor: bots were ALL fighting unarmored (combat was the top death cause —
// 12 of 21 deaths/run). craft_gear made tools but never armor, so the brain's
// auto-equip-armor timer had nothing to wear. Iron armor ~halves damage.
const ARMOR_TYPES = ["helmet", "chestplate", "leggings", "boots"];

/** Iron cost and protection of each armour piece. */
export const ARMOUR_COST: Record<string, { ingots: number; points: number }> = {
  iron_chestplate: { ingots: 8, points: 6 },
  iron_leggings: { ingots: 7, points: 5 },
  iron_helmet: { ingots: 5, points: 2 },
  iron_boots: { ingots: 4, points: 2 },
};

/** Which armour piece to craft with the iron a bot actually holds.
 *
 *  craft_gear tried the chestplate first and nothing else, on the reasoning that
 *  it is the single biggest protection. That is true and it does not survive
 *  contact with the economy: a chestplate costs 8 ingots, the swarm mines about
 *  4 an hour, and bots were dying 13 times an hour and dropping everything they
 *  carried. Measured in one session: 15 of 21 deaths with NO armour at all, 14
 *  of them to zombies, and "No iron_ingot in the stash" 56 times.
 *
 *  A bot holding 4 ingots and waiting for 8 dies wearing nothing. Boots at 4
 *  give 2 armour points today, which beats 6 points it will never reach. So
 *  take the best piece that is affordable NOW, preferring protection per ingot
 *  when several fit, and skip anything already worn or carried.
 *
 *  Returns null when nothing is affordable, which is the caller's cue to spend
 *  its iron on tools instead. */
export function affordableArmourPiece(ingots: number, owned: string[] = []): string | null {
  const candidates = Object.entries(ARMOUR_COST)
    .filter(([name, c]) => !owned.includes(name) && c.ingots <= ingots)
    .sort((a, b) => b[1].points - a[1].points || a[1].ingots - b[1].ingots);
  return candidates.length ? candidates[0][0] : null;
}

const ARMOR_TIERS = ["diamond", "iron"]; // only metal armor is worth crafting

export const craftGearSkill: Skill = {
  name: "craft_gear",
  description:
    "Craft the best tools (pickaxe, axe, sword, shovel) AND armor (helmet, chestplate, leggings, boots) from available materials; pulls iron from the stash. The bot auto-equips crafted armor.",
  params: {},

  estimateMaterials(_bot, _params) {
    // This skill uses whatever is already in inventory — no gathering phase
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    const mcData = mcDataLoader(bot.version);
    const crafted: string[] = [];
    const total = TOOL_TYPES.length;
    let done = 0;

    // Optional caller-imposed deadline. strip_mine's inline gear-up call was
    // blocking for the mining trip's entire 480s envelope on bad days (tree
    // hunts, cobble digs, deaths mid-errand) — runs 383-384 lost 33 trips to
    // watchdog kills that all began inside this function. Past the deadline,
    // each phase is skipped and whatever was crafted so far is returned.
    const deadlineMs = (params as { deadlineMs?: number } | undefined)?.deadlineMs;
    const gearDeadline = deadlineMs ? Date.now() + deadlineMs : Infinity;
    const gearExpired = () => Date.now() > gearDeadline;

    // Pull iron ingots from the shared stash before crafting (the stash is the
    // team warehouse — use it). The smelter deposits ingots; whoever crafts
    // withdraws them. Without this, craft_gear only ever found enough materials
    // for stone/wood tools and never made iron, even though the team had smelted
    // plenty. Mirrors smelt_ores' stash withdrawal.
    const stashPos = params?.stashPos as { x: number; y: number; z: number } | undefined;
    if (stashPos && !signal.aborted) {
      const ironIngots = bot.inventory
        .items()
        .filter((i) => i.name === "iron_ingot")
        .reduce((s, i) => s + i.count, 0);
      // Tools need ~9 ingots, a full iron armor set needs 24 — withdraw enough
      // for both so the bot can armor up in one trip.
      if (ironIngots < 33) {
        const { withdrawStash } = await import("./stash.js");
        try {
          await withdrawStash(bot, stashPos, "iron_ingot", 33 - ironIngots);
        } catch {
          /* none in stash — craft whatever tier we can */
        }
      }
    }

    // WOOD SELF-SUPPLY (same pattern as build_farm's hoe step, which works):
    // craft_gear failed 79x in one run with "Missing: pickaxe... use
    // gather_wood" — the LLM never holds the gather->keep->craft sequence,
    // and gathered logs evaporate into other uses first. Withdraw logs from
    // the stash; failing that, chop a couple of nearby trees right here.
    // SUFFICIENCY, not existence: GearDebug caught the failure at
    // planks=1 sticks=10 — one lonely plank made the old some() check skip
    // self-supply, then the wooden pickaxe (3 planks) had no recipe. Count
    // planks-equivalents (a log crafts into 4 planks); resupply below 6.
    const hasWood = () => {
      const logs = bot.inventory
        .items()
        .filter((i) => i.name.endsWith("_log"))
        .reduce((s, i) => s + i.count, 0);
      const planks = bot.inventory
        .items()
        .filter((i) => i.name.endsWith("_planks"))
        .reduce((s, i) => s + i.count, 0);
      return logs * 4 + planks >= 6;
    };
    if (!signal.aborted && !hasWood()) {
      if (stashPos) {
        const { withdrawStash } = await import("./stash.js");
        try {
          await withdrawStash(bot, stashPos, "log", 8);
        } catch {
          /* none pooled */
        }
      }
      if (!hasWood()) {
        const { safeGoto, collectNearbyDrops } = await import("../bot/navigation.js");
        for (let t = 0; t < 2 && !signal.aborted && !hasWood() && !gearExpired(); t++) {
          let logBlock = bot.findBlock({ matching: (b) => b.name.endsWith("_log"), maxDistance: 64 });
          if (!logBlock) break;
          // Walk to the trunk BASE (canopy-branch lesson) and skip floaters.
          let below = bot.blockAt(logBlock.position.offset(0, -1, 0));
          while (below && below.name.endsWith("_log")) {
            logBlock = below;
            below = bot.blockAt(logBlock.position.offset(0, -1, 0));
          }
          if (!below || below.name === "air" || below.name === "water") continue;
          try {
            await safeGoto(
              bot,
              new goals.GoalNear(logBlock.position.x, logBlock.position.y, logBlock.position.z, 2),
              20000,
            );
            await Promise.race([
              bot.dig(logBlock),
              new Promise<void>((_, rej) =>
                setTimeout(() => {
                  try {
                    bot.stopDigging();
                  } catch {
                    /* not digging */
                  }
                  rej(new Error("dig timeout"));
                }, 12000),
              ),
            ]);
            await collectNearbyDrops(bot, 8, 6000);
          } catch {
            /* try the next tree */
          }
        }
      }
    }

    // COBBLE SELF-SUPPLY, the same courtesy wood gets: the village is
    // deforested (no stash logs, no trees within 64) so the wood chain dead
    // -ends, while the stash holds a full stack of cobblestone nobody
    // thought to withdraw — craft_gear kept reporting "need cobblestone for
    // pickaxe" ten blocks from sixty-four of them. Sticks were already in
    // the pack; one withdrawal unlocks the stone pick and the whole mining
    // ladder behind it.
    const hasCobbleFor = () => bot.inventory.items().some((i) => i.name === "cobblestone" && i.count >= 3);
    if (!signal.aborted && !gearExpired() && !hasCobbleFor() && stashPos) {
      const { withdrawStash } = await import("./stash.js");
      try {
        await withdrawStash(bot, stashPos, "cobblestone", 8);
      } catch {
        /* none pooled */
      }
    }

    // STICKS get the same treatment: GearDebug caught the miner at
    // cobble=33 sticks=0 — the cobble courtesy worked and the craft still
    // died on handles, thirty-three times in one hour. Withdraw sticks,
    // then planks, before the recipe check; the log withdrawal above only
    // helps when logs are actually banked.
    const stickCount = () =>
      bot.inventory
        .items()
        .filter((i) => i.name === "stick")
        .reduce((s, i) => s + i.count, 0);
    if (!signal.aborted && stickCount() < 4 && stashPos) {
      const { withdrawStash } = await import("./stash.js");
      for (const want of ["stick", "planks"]) {
        if (stickCount() >= 4) break;
        try {
          await withdrawStash(bot, stashPos, want, 8);
        } catch {
          /* none pooled */
        }
      }
    }

    // INSTRUMENTATION (craft-gear debugging): entry material state, so the
    // next failure diagnosis reads evidence instead of guessing (5 previous
    // wood-chain fixes were each one layer deeper than the guess).
    {
      const cnt = (suffix: string) =>
        bot.inventory
          .items()
          .filter((i) => i.name.endsWith(suffix))
          .reduce((s, i) => s + i.count, 0);
      const tableNear = !!bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
      console.log(
        `[GearDebug] entry: logs=${cnt("_log")} planks=${cnt("_planks")} sticks=${cnt("stick")} cobble=${cnt("cobblestone")} ingots=${cnt("iron_ingot")} table=${tableNear}`,
      );
    }

    // ARMOR-FIRST for the chestplate (the single biggest protection). Iron is
    // scarce and tools were eating ALL of it (craft_gear made pickaxe+sword
    // every run, never reaching the armor step), so bots stayed unarmored.
    // Crafting the chestplate before tools routes the bot's handful of iron to
    // survival gear first; tools still get crafted after (and stone fallbacks
    // cover most tasks). The brain's auto-equip timer then wears it.
    if (!signal.aborted && !gearExpired()) {
      const ingots = bot.inventory
        .items()
        .filter((i) => i.name === "iron_ingot")
        .reduce((sum, i) => sum + i.count, 0);
      // ALL slots, worn armor included: inventory.items() skips equipment
      // slots 5-8, so a bot wearing an iron_chestplate read as not owning
      // one and crafted duplicates instead of the next piece (PR #25).
      const owned = bot.inventory.slots.filter((i): i is NonNullable<typeof i> => i !== null).map((i) => i.name);
      // Reserve 3 ingots for a pickaxe ONLY when the bot is truly pickless.
      // The old rule reserved whenever the bot lacked an IRON pick, but a stone
      // pick already harvests iron ore at y=15 — so a stone-pick bot with 4
      // ingots (a pair of boots) had its whole budget clawed back to 1 for an
      // iron pick it did not need yet, and stayed naked. A bot that can already
      // mine routes its scarce iron to armour first; the iron pick waits until
      // it is armoured and diving for diamonds.
      const hasAnyPick = bot.inventory.items().some((i) => i.name.endsWith("_pickaxe"));
      const armourBudget = hasAnyPick ? ingots : Math.max(0, ingots - 3);
      const piece = affordableArmourPiece(armourBudget, owned);
      if (piece) {
        console.log(`[GearDebug] armour: ${ingots} ingots (budget ${armourBudget}) -> attempting ${piece}`);
        await craftPiece(bot, mcData, piece, crafted);
      } else {
        console.log(
          `[GearDebug] armour: ${ingots} ingots (budget ${armourBudget}), nothing affordable (cheapest piece costs 4)`,
        );
      }
    }

    // Logs are not planks. Run 378: bots stood at the table with 8 logs and
    // 62 sticks, planks=0, and every pickaxe tier read recipe=NO — a wooden
    // pick needs 3 PLANKS and recipesFor only sees what is already in the
    // inventory. Convert a couple of logs up front; 2 logs = 8 planks covers
    // a wooden pick plus the handle sticks.
    if (!signal.aborted) {
      const planksHeld = bot.inventory
        .items()
        .filter((i) => i.name.endsWith("_planks"))
        .reduce((s, i) => s + i.count, 0);
      const logHeld = bot.inventory.items().find((i) => i.name.endsWith("_log"));
      if (planksHeld < 6 && logHeld) {
        const plankDef = mcData.itemsByName[logHeld.name.replace("_log", "_planks")];
        const recipe = plankDef && bot.recipesFor(plankDef.id, null, 1, null)[0];
        if (recipe) {
          await bot.craft(recipe, Math.min(2, logHeld.count), undefined).catch((e) => {
            console.log(`[GearDebug] log->planks craft failed: ${(e as Error).message}`);
          });
        }
      }
    }

    // Ensure we have sticks (need at least 8 for a full set)
    await ensureSticks(bot, 8, signal);

    for (const toolType of TOOL_TYPES) {
      if (signal.aborted || gearExpired()) break;

      done++;
      onProgress({
        skillName: "craft_gear",
        phase: "Crafting tools",
        progress: done / total,
        message: `Trying to craft ${toolType}...`,
        active: true,
      });

      // Try each tier from best to worst
      for (const tier of TIERS) {
        // RESERVE metal for the pickaxe, per tier: iron stays pickaxe-only
        // until an iron+ pick exists. Diamond is pickaxe-only PERIOD: the old
        // release-once-a-diamond-pick-exists check let the very craft run that
        // minted the pick continue down the tool list and spend the enchanting
        // table's 2-diamond reserve on a diamond SHOVEL. Iron tools serve every
        // other job; diamonds only ever go to the pickaxe and the table.
        // Iron is pickaxe-and-armour-only, PERIOD — never an iron axe, sword,
        // or shovel. The swarm fought naked for days because a bot with a pick
        // and 3 spare ingots (one short of the 4 a boots costs) spent them on a
        // redundant iron axe instead of banking them toward armour. Stone tools
        // do every non-mining job; the scarce iron all goes to the pickaxe and
        // the armour set, where survival actually depends on it.
        if (tier.name === "iron" && toolType !== "pickaxe") continue;
        if (tier.name === "diamond" && toolType !== "pickaxe") continue;
        const itemName = `${tier.name}_${toolType}`;
        const mcItem = mcData.itemsByName[itemName];
        if (!mcItem) continue;

        // Check if we already have this or better. A nearly-dead pickaxe does
        // NOT count: run 376's iron pick died of durability mid-dive, and the
        // recraft the brain ordered would have been declined here as "already
        // had". 150 uses is the floor a dive needs.
        const TOOL_MAX_DURABILITY: Record<string, number> = {
          iron_pickaxe: 250,
          diamond_pickaxe: 1561,
          netherite_pickaxe: 2031,
        };
        const have = bot.inventory
          .items()
          .find(
            (i) =>
              i.name === itemName &&
              (toolType !== "pickaxe" || (TOOL_MAX_DURABILITY[i.name] ?? Infinity) - (i.durabilityUsed ?? 0) >= 150),
          );
        if (have) {
          crafted.push(`${itemName} (already had)`);
          break;
        }

        // Find crafting table if needed for 3x3 recipe
        let table = bot.findBlock({
          matching: (b) => b.name === "crafting_table",
          maxDistance: 32,
        });

        // If no table nearby, try to place one from inventory (or craft one from planks)
        if (!table) {
          await placeCraftingTable(bot);
          table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 8 });
        }

        let recipe = table ? bot.recipesFor(mcItem.id, null, 1, table)[0] : bot.recipesFor(mcItem.id, null, 1, null)[0];

        // Thirty-six full craft runs produced zero pickaxes with materials
        // visibly aboard — name the exact tier verdicts so the next failure
        // identifies itself. Pickaxe only: it is the tool the arc hinges on.
        if (toolType === "pickaxe") {
          const c = (n: string) =>
            bot.inventory
              .items()
              .filter((i) => i.name.endsWith(n))
              .reduce((s, i) => s + i.count, 0);
          console.log(
            `[GearDebug] pickaxe/${tier.name}: recipe=${recipe ? "yes" : "NO"} table=${table ? "yes" : "no"} planks=${c("_planks")} sticks=${c("stick")} cobble=${c("cobblestone")} logs=${c("_log")}`,
          );
        }

        if (!recipe) continue;

        // Navigate to table if needed
        if (table && recipe) {
          const pkg = await import("mineflayer-pathfinder");
          const { goals, Movements } = pkg.default;
          const moves = baseMoves(bot);
          moves.canDig = false;
          bot.pathfinder.setMovements(moves);
          try {
            await Promise.race([
              bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2)),
              new Promise<void>((_, rej) =>
                setTimeout(() => {
                  bot.pathfinder.setGoal(null); // synchronous reset; stop() only raises a flag that kills the NEXT walk
                  rej(new Error("goto timeout"));
                }, 15000),
              ),
            ]);
          } catch {
            /* try anyway */
          }
        }

        // The found table may be walled off, and a pickless miner cannot dig to
        // it — so the navigate above leaves the bot out of reach and bot.craft
        // silently no-ops (recipe=yes, table=yes, yet nothing is produced: the
        // exact stall that stranded Forge for an hour with 18 cobble and 13
        // planks aboard). If we still are not beside a table, place a fresh one
        // adjacent (crafted from planks) and craft against that.
        if (!table || table.position.distanceTo(bot.entity.position) > 3.5) {
          await placeCraftingTable(bot);
          const fresh = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 4 });
          if (fresh) {
            table = fresh;
            recipe = bot.recipesFor(mcItem.id, null, 1, fresh)[0] ?? recipe;
          }
        }

        try {
          const countOf = (n: string) =>
            bot.inventory
              .items()
              .filter((i) => i.name === n)
              .reduce((s, i) => s + i.count, 0);
          const before = countOf(itemName);
          await bot.craft(recipe, 1, table || undefined);
          // VERIFY the craft actually produced the item. bot.craft can return
          // without error yet without crafting (e.g. not actually at the table),
          // which made craft_gear report phantom 'iron_pickaxe' successes while
          // the bot held nothing. Only claim it if the count truly rose; else
          // fall through to a lower tier so the bot still gets a working tool.
          if (countOf(itemName) > before) {
            crafted.push(itemName);
            // SPARE iron pickaxe when the metal allows. At diamond depth an
            // iron pick (250 uses) dies inside ~1.5 trips, and every death of
            // the only pick stalls the fleet for a full smelt-and-craft cycle
            // (runs 376-387, recurring). A second pick costs 3 ingots; the
            // keep-best-pick rule banks it on the next stash visit, and the
            // trip-start reclaim pulls it the moment the working pick wears
            // out — a buffer instead of a stall.
            if (
              itemName === "iron_pickaxe" &&
              bot.inventory
                .items()
                .filter((i) => i.name === "iron_ingot")
                .reduce((s, i) => s + i.count, 0) >= 3
            ) {
              await bot.craft(recipe, 1, table || undefined).catch(() => {});
              if (countOf(itemName) > before + 1) crafted.push(`${itemName} (spare)`);
            }
            break;
          }
        } catch {
          continue;
        }
      }
    }

    // --- Craft ARMOR (iron/diamond) — the brain's auto-equip timer wears it ---
    for (const piece of ARMOR_TYPES) {
      if (signal.aborted || gearExpired()) break;
      for (const tier of ARMOR_TIERS) {
        // Diamonds are pickaxe-only until the diamond pickaxe exists. This
        // loop tries diamond first, and it's how Forge's FOUR dive diamonds
        // became diamond_boots (run 372) while the portal doorway kept
        // waiting on a pick — the whole mission stalled for a pair of shoes.
        if (tier === "diamond" && !bot.inventory.items().some((i) => (PICK_PRIORITY[i.name] ?? 0) >= 3)) {
          continue;
        }
        const itemName = `${tier}_${piece}`;
        const mcItem = mcData.itemsByName[itemName];
        if (!mcItem) continue;
        if (bot.inventory.items().some((i) => i.name === itemName)) {
          crafted.push(`${itemName} (already had)`);
          break;
        }
        let table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
        if (!table) {
          await placeCraftingTable(bot);
          table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 8 });
        }
        const recipe = table
          ? bot.recipesFor(mcItem.id, null, 1, table)[0]
          : bot.recipesFor(mcItem.id, null, 1, null)[0];
        if (!recipe) continue;
        if (table) {
          const pkg = await import("mineflayer-pathfinder");
          const { goals, Movements } = pkg.default;
          const moves = baseMoves(bot);
          moves.canDig = false;
          bot.pathfinder.setMovements(moves);
          try {
            await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
          } catch {
            /* try anyway */
          }
        }
        try {
          const countOf = (n: string) =>
            bot.inventory
              .items()
              .filter((i) => i.name === n)
              .reduce((s, i) => s + i.count, 0);
          const before = countOf(itemName);
          await bot.craft(recipe, 1, table || undefined);
          if (countOf(itemName) > before) {
            crafted.push(itemName);
            break; // got this piece — next slot
          }
        } catch {
          continue; // try lower tier
        }
      }
    }

    const newlyCrafted = crafted.filter((c) => !c.includes("already had"));

    if (crafted.length === 0 || newlyCrafted.length === 0) {
      // No new tools made — report what's missing so the LLM knows to get materials
      const missing = TOOL_TYPES.map((t) => {
        const have = bot.inventory.items().find((i) => i.name.endsWith(`_${t}`));
        return have ? null : t;
      }).filter(Boolean);
      const hasWood = bot.inventory.items().some((i) => i.name.endsWith("_log") || i.name.endsWith("_planks"));
      const hasCobble = bot.inventory.items().some((i) => i.name === "cobblestone");
      const hasTable = !!bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
      const hints: string[] = [];
      if (!hasTable && !hasWood) hints.push("need wood to craft a crafting table");
      else if (!hasTable) hints.push("need to place a crafting table");
      if (missing.includes("pickaxe") && !hasCobble) hints.push("need cobblestone for pickaxe");
      return {
        success: false,
        message: `No new tools crafted. Missing: ${missing.join(", ") || "none"}. ${hints.join(". ")}. Use gather_wood to get materials first.`,
      };
    }

    return {
      success: true,
      message: `Gear crafted! Got: ${newlyCrafted.join(", ")}. Ready for action!`,
      stats: { toolsCrafted: newlyCrafted.length },
    };
  },
};

/** Craft one gear item (tool/armor) at a crafting table, verifying it appeared. Returns true if crafted. */
async function craftPiece(
  bot: Bot,
  mcData: ReturnType<typeof mcDataLoader>,
  itemName: string,
  crafted: string[],
): Promise<boolean> {
  const mcItem = mcData.itemsByName[itemName];
  if (!mcItem) return false;
  let table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
  if (!table) {
    await placeCraftingTable(bot);
    table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 8 });
  }
  const recipe = table ? bot.recipesFor(mcItem.id, null, 1, table)[0] : bot.recipesFor(mcItem.id, null, 1, null)[0];
  if (!recipe) return false;
  if (table) {
    const pkg = await import("mineflayer-pathfinder");
    const { goals, Movements } = pkg.default;
    const moves = baseMoves(bot);
    moves.canDig = false;
    bot.pathfinder.setMovements(moves);
    try {
      await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
    } catch {
      /* try anyway */
    }
  }
  const countOf = (n: string) =>
    bot.inventory
      .items()
      .filter((i) => i.name === n)
      .reduce((s, i) => s + i.count, 0);
  const before = countOf(itemName);
  try {
    await bot.craft(recipe, 1, table || undefined);
  } catch {
    return false;
  }
  if (countOf(itemName) > before) {
    crafted.push(itemName);
    return true;
  }
  return false;
}

/** Place a crafting table from inventory near the bot, or craft one from planks first. */
async function placeCraftingTable(bot: Bot): Promise<void> {
  const mcData = mcDataLoader(bot.version);

  // Ensure we have a crafting_table item — craft from planks if needed
  let ctItem = bot.inventory.items().find((i) => i.name === "crafting_table");
  if (!ctItem) {
    const ctMcItem = mcData.itemsByName["crafting_table"];
    if (!ctMcItem) return;
    const recipe = bot.recipesFor(ctMcItem.id, null, 1, null)[0];
    if (recipe) {
      // First make planks from any log we have
      for (const logType of LOG_TYPES) {
        const log = bot.inventory.items().find((i) => i.name === logType);
        if (!log) continue;
        const plankName = logType.replace("_log", "_planks");
        const plankItem = mcData.itemsByName[plankName];
        if (!plankItem) continue;
        const plankRecipe = bot.recipesFor(plankItem.id, null, 1, null)[0];
        if (plankRecipe) {
          try {
            await bot.craft(plankRecipe, 2, undefined);
          } catch {
            /* ok */
          }
        }
        break;
      }
      try {
        await bot.craft(recipe, 1, undefined);
      } catch {
        /* ok */
      }
    }
    ctItem = bot.inventory.items().find((i) => i.name === "crafting_table");
  }

  if (!ctItem) return;

  // Place on the block below bot's feet, one step to the side
  const pos = bot.entity.position.floored();
  const candidates = [pos.offset(1, 0, 0), pos.offset(-1, 0, 0), pos.offset(0, 0, 1), pos.offset(0, 0, -1)];
  for (const candidate of candidates) {
    const ground = bot.blockAt(candidate.offset(0, -1, 0));
    if (!ground || ground.name === "air") continue;
    const atCandidate = bot.blockAt(candidate);
    if (atCandidate && atCandidate.name !== "air") continue; // occupied
    try {
      await bot.equip(ctItem, "hand");
      await bot.placeBlock(ground, new Vec3(0, 1, 0));
      return;
    } catch {
      /* try next position */
    }
  }
}

async function ensureSticks(bot: Bot, count: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const mcData = mcDataLoader(bot.version);
  const stickItem = mcData.itemsByName["stick"];
  if (!stickItem) return;

  const have = bot.inventory
    .items()
    .filter((i) => i.name === "stick")
    .reduce((s, i) => s + i.count, 0);
  if (have >= count) return;

  // First ensure we have planks — craft any log type into its planks
  for (const logType of LOG_TYPES) {
    if (signal.aborted) break;
    const logCount = bot.inventory
      .items()
      .filter((i) => i.name === logType)
      .reduce((s, i) => s + i.count, 0);
    if (logCount === 0) continue;

    const plankName = logType.replace("_log", "_planks");
    const mcItem = mcData.itemsByName[plankName];
    if (!mcItem) continue;

    // Craft a few logs into planks (don't convert all — just need enough for sticks)
    const craftCount = Math.min(logCount, 3);
    for (let i = 0; i < craftCount; i++) {
      const recipe = bot.recipesFor(mcItem.id, null, 1, null)[0];
      if (!recipe) break;
      try {
        await bot.craft(recipe, 1, undefined);
      } catch {
        break;
      }
    }
    break; // One log type is enough for sticks
  }

  // Now craft sticks (recipe uses any plank type via tags). SINGLE crafts
  // in a loop, probe-validated: a bot sat at nine planks and zero sticks
  // while the old multi-count craft failed silently — the probe crafts
  // count=1 reliably, and a swallowed error here starves every pickaxe
  // above it. Failures now say so.
  const need = Math.ceil((count - have) / 4);
  for (let k = 0; k < need; k++) {
    const stickRecipe = bot.recipesFor(stickItem.id, null, 1, null)[0];
    if (!stickRecipe) {
      console.log(`[GearDebug] stick recipe unavailable at craft ${k + 1}/${need}`);
      break;
    }
    try {
      await bot.craft(stickRecipe, 1, undefined);
    } catch (e) {
      console.log(`[GearDebug] stick craft ${k + 1}/${need} failed: ${(e as Error).message}`);
      break;
    }
  }
}
