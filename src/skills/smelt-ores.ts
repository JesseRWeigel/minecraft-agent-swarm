import type { Block } from "prismarine-block";
import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import mcDataLoader from "minecraft-data";
import { withdrawStash } from "./stash.js";
import { classifyWithdraw, nothingToSmeltMessage, type WithdrawOutcome } from "./smelt-advice.js";
import { baseMoves } from "../bot/navigation.js";

/** Items that can be smelted: input → output name. */
const SMELT_RECIPES: Record<string, string> = {
  raw_iron: "iron_ingot",
  iron_ore: "iron_ingot",
  raw_gold: "gold_ingot",
  gold_ore: "gold_ingot",
  raw_copper: "copper_ingot",
  copper_ore: "copper_ingot",
  sand: "glass",
};

/** Valid fuel items, roughly ordered by efficiency. */
const FUEL_ITEMS = [
  "coal",
  "charcoal",
  "oak_planks",
  "spruce_planks",
  "birch_planks",
  "jungle_planks",
  "acacia_planks",
  "dark_oak_planks",
  "cherry_planks",
  "mangrove_planks",
  "oak_log",
  "spruce_log",
  "birch_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
  "cherry_log",
  "mangrove_log",
  "pale_oak_log",
  "pale_oak_planks", // MC 1.21.4
];

export const smeltOresSkill: Skill = {
  name: "smelt_ores",
  description:
    "Smelt raw ores into ingots using a furnace. Crafts and places a furnace if needed (8 cobblestone). Uses coal or wood as fuel.",
  params: {},

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    const mcData = mcDataLoader(bot.version);
    const countInv = (name: string) =>
      bot.inventory
        .items()
        .filter((i) => i.name === name)
        .reduce((s, i) => s + i.count, 0);

    // What each stash withdrawal established, so the failure message below can
    // tell "no ore anywhere" apart from "ore pooled but the stash is unreachable".
    const withdrawOutcomes: WithdrawOutcome[] = [];

    // --- Step 0: Pull ore + fuel from the shared stash if we lack them. ---
    // Bots kept invoking smelt empty-handed ("Nothing to smelt" / "No fuel")
    // because the miner deposits raw_iron + coal and a DIFFERENT bot tries to
    // smelt. Withdraw what the team already mined (the stash is the intended
    // hand-off mechanism — not a cheat).
    const stashPos = params?.stashPos as { x: number; y: number; z: number } | undefined;
    if (stashPos && !signal.aborted) {
      // TIME BUDGET: each withdrawStash re-walks to the stash (safeGoto up to
      // 30s). Looping all 6 ore + 2 fuel types when the stash is EMPTY (common —
      // ore production is low) meant 8 x 30s ≈ 240s → the skill watchdog fired
      // and Forge/Atlas/Flora hung repeatedly producing 0 ingots. Cap the whole
      // withdrawal phase at 30s; if nothing's pooled, bail and let smelt report
      // "Nothing to smelt" fast instead of stalling.
      const wdStart = Date.now();
      const budgetLeft = () => Date.now() - wdStart < 30000;
      const haveSmeltable = Object.keys(SMELT_RECIPES).some((n) => countInv(n) > 0);
      if (!haveSmeltable) {
        for (const ore of ["raw_iron", "iron_ore", "raw_copper", "copper_ore", "raw_gold", "gold_ore"]) {
          if (!budgetLeft()) break;
          try {
            // withdrawStash RETURNS a message, it does not throw, so this catch
            // never fired and the result was discarded. Neither "Withdrew Nx
            // raw_iron" nor "No raw_iron in the stash" appeared even once in a
            // 2h42m session, leaving the skill blind to its own supply line.
            const wd = await withdrawStash(bot, stashPos, ore, 16);
            withdrawOutcomes.push(classifyWithdraw(wd, false));
            console.log(`[Smelt] ${bot.username} withdraw ${ore}: ${wd}`);
          } catch (err) {
            // A throw here is a failure to REACH the stash, not proof the stash
            // is empty. Recording only the returned half is what let 18 "mine
            // some ore first" messages fire while the ore sat pooled and
            // unreachable, sending bots to produce more for the same dead drop.
            withdrawOutcomes.push(classifyWithdraw((err as Error).message, true));
            console.log(`[Smelt] ${bot.username} withdraw ${ore} threw: ${(err as Error).message}`);
          }
          if (Object.keys(SMELT_RECIPES).some((n) => countInv(n) > 0)) break;
        }
      }
      const haveFuel = FUEL_ITEMS.some((n) => countInv(n) > 0);
      if (!haveFuel) {
        for (const fuel of ["coal", "charcoal"]) {
          if (!budgetLeft()) break;
          try {
            await withdrawStash(bot, stashPos, fuel, 16);
          } catch {
            /* none — try next */
          }
          if (FUEL_ITEMS.some((n) => countInv(n) > 0)) break;
        }
      }
    }

    // --- Step 1: Find smeltable items in inventory ---
    const toSmelt: Array<{ itemName: string; count: number; output: string }> = [];
    for (const [input, output] of Object.entries(SMELT_RECIPES)) {
      const count = bot.inventory
        .items()
        .filter((i) => i.name === input)
        .reduce((s, i) => s + i.count, 0);
      if (count > 0) {
        toSmelt.push({ itemName: input, count, output });
      }
    }

    if (toSmelt.length === 0) {
      return { success: false, message: nothingToSmeltMessage(withdrawOutcomes) };
    }

    // --- Step 2: Check fuel ---
    const fuel = bot.inventory.items().find((i) => FUEL_ITEMS.includes(i.name));
    if (!fuel) {
      return { success: false, message: "No fuel! Need coal, charcoal, or wood to power the furnace." };
    }

    const totalItems = toSmelt.reduce((s, t) => s + t.count, 0);
    onProgress({
      skillName: "smelt_ores",
      phase: "Preparing",
      progress: 0,
      message: `${totalItems} items to smelt...`,
      active: true,
    });

    // --- Step 3: Find or craft+place furnace ---
    let furnaceBlock = bot.findBlock({
      matching: (b) => b.name === "furnace" || b.name === "lit_furnace",
      maxDistance: 32,
    });

    // Craft a furnace from pack cobblestone and stand it beside the bot.
    // Returns the failure to hand back, or null once a furnace is within
    // reach. Used when no furnace is near and again when the one that is
    // near cannot be walked to.
    const placeFurnaceHere = async (): Promise<Block | { success: false; message: string }> => {
      const cobble = countItem(bot, "cobblestone");
      if (cobble < 8) {
        return {
          success: false,
          message: "No furnace nearby and need 8 cobblestone to craft one. Mine some stone first!",
        };
      }

      onProgress({
        skillName: "smelt_ores",
        phase: "Crafting furnace",
        progress: 0.05,
        message: "Making a furnace...",
        active: true,
      });

      // Craft furnace at crafting table
      const furnaceItemDef = mcData.itemsByName["furnace"];
      if (furnaceItemDef) {
        const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
        let recipe = table ? bot.recipesFor(furnaceItemDef.id, null, 1, table)[0] : null;
        if (!recipe) recipe = bot.recipesFor(furnaceItemDef.id, null, 1, null)[0];
        if (recipe) {
          if (table) {
            setMovements(bot);
            try {
              await gotoTimed(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20000);
            } catch {
              /* best-effort */
            }
          }
          try {
            await bot.craft(recipe, 1, table || undefined);
          } catch {
            /* best-effort */
          }
        }
      }

      // Place furnace
      const fItem = bot.inventory.items().find((i) => i.name === "furnace");
      if (!fItem) {
        return { success: false, message: "Couldn't craft a furnace. Need 8 cobblestone and a crafting table." };
      }

      await bot.equip(fItem, "hand");
      const pos = bot.entity.position.floored();
      for (const offset of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const below = bot.blockAt(new Vec3(pos.x + offset[0], pos.y - 1, pos.z + offset[1]));
        const target = bot.blockAt(new Vec3(pos.x + offset[0], pos.y, pos.z + offset[1]));
        if (below && below.name !== "air" && target && target.name === "air") {
          try {
            await bot.placeBlock(below, new Vec3(0, 1, 0));
            console.log("[Skill] Placed furnace");
            break;
          } catch {
            continue;
          }
        }
      }

      const placed = bot.findBlock({ matching: (b) => b.name === "furnace", maxDistance: 8 });
      if (!placed) {
        return { success: false, message: "Couldn't place furnace. Try in a flatter area." };
      }
      return placed;
    };

    if (!furnaceBlock) {
      const placed = await placeFurnaceHere();
      if (!("position" in placed)) return placed;
      furnaceBlock = placed;
    }

    // --- Step 4: Navigate to furnace --- (verify arrival: "try anyway" from
    // out of reach just converts a walk failure into an openFurnace timeout)
    setMovements(bot);
    for (let approach = 0; approach < 2; approach++) {
      try {
        await gotoTimed(
          bot,
          new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2),
          20000,
        );
      } catch {
        /* distance check decides whether to walk again */
      }
      if (bot.entity.position.distanceTo(furnaceBlock.position) <= 4) break;
    }

    // Run 788: Forge walked toward a furnace twelve blocks away five times,
    // read "phantom arrival, no route from here" each time, and the batch
    // loop below found nothing within eight blocks and broke without a word,
    // so the skill answered "Smelting produced nothing" with three raw iron
    // aboard. Say it, and stand a furnace here when the pack can afford one.
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
      const gap = bot.entity.position.distanceTo(furnaceBlock.position).toFixed(0);
      const at = `${furnaceBlock.position.x},${furnaceBlock.position.y},${furnaceBlock.position.z}`;
      console.log(
        `[Skill] ${bot.username}: furnace at ${at} is ${gap} blocks away and two walks did not reach it — placing one here`,
      );
      const placed = await placeFurnaceHere();
      if (!("position" in placed)) {
        return {
          success: false,
          message: `The furnace at ${at} is ${gap} blocks away and no route reaches it. ${placed.message}`,
        };
      }
      furnaceBlock = placed;
    }

    // --- Step 5: Smelt each batch ---
    let smelted = 0;
    const results: string[] = [];

    for (const batch of toSmelt) {
      if (signal.aborted) break;

      onProgress({
        skillName: "smelt_ores",
        phase: "Smelting",
        progress: 0.1 + (smelted / totalItems) * 0.85,
        message: `Smelting ${batch.count}x ${batch.itemName}...`,
        active: true,
      });

      // Where the batch got to, for the error line below.
      //
      // Runs 765, 766 and 767 all logged "Smelt error: Error: destination
      // full" and every guess about which call threw was wrong: the pack was
      // not full, the reclaim found nothing to clear, and capping the puts by
      // the slot's remaining room changed nothing. The catch wraps nine
      // furnace operations and names none of them, so say which one was in
      // flight and what the slots held when it went.
      let step = "find";
      let openFurnaceRef: Awaited<ReturnType<typeof bot.openFurnace>> | null = null;
      const slotState = () => {
        const f = openFurnaceRef;
        if (!f) return "no furnace";
        const name = (i: { name?: string; count?: number } | null) => (i ? `${i.name}x${i.count}` : "-");
        return `in=${name(f.inputItem())} fuel=${name(f.fuelItem())} out=${name(f.outputItem())}`;
      };
      try {
        // Re-find furnace (might have shifted from furnace to lit_furnace)
        furnaceBlock = bot.findBlock({
          matching: (b) => b.name === "furnace" || b.name === "lit_furnace",
          maxDistance: 8,
        });
        if (!furnaceBlock) {
          console.log(
            `[Skill] ${bot.username}: no furnace within 8 blocks when the batch started — giving up on this load`,
          );
          break;
        }

        // openFurnace blocks forever if the furnace GUI never opens (block not
        // truly reachable/loaded) — this hung smelt_ores to the 240s watchdog
        // repeatedly, producing 0 ingots. Bound it so it fails fast and the
        // batch is skipped (caught below).
        step = "open";
        const furnace = (await Promise.race([
          bot.openFurnace(furnaceBlock),
          new Promise((_, rej) => setTimeout(() => rej(new Error("openFurnace timeout")), 10000)),
        ])) as Awaited<ReturnType<typeof bot.openFurnace>>;
        openFurnaceRef = furnace;
        step = "opened";

        // Make room before touching the furnace.
        //
        // Run 765: "[Skill] Smelt error: Error: destination full" twice, and
        // the gear step reported "1 ingots and 3 raw iron - smelting" then
        // "1 ingots after smelting", so the raw iron came back unsmelted and
        // Forge went on dying with no armour. The unjam below cannot work with
        // a full pack: takeOutput has nowhere to put the ingots, so it throws,
        // the furnace stays jammed, and putInput then fails for the same
        // reason. Banking a few stacks first is what the reclaim needs.
        if (bot.inventory.emptySlotCount() < 2) {
          console.log(
            `[Skill] ${bot.username}: furnace work with ${bot.inventory.emptySlotCount()} free slots — banking first`,
          );
          if (stashPos) {
            const { depositStash } = await import("./stash.js");
            // Keep what this skill is here to use: the ores, the fuel and the
            // tools. Everything else can go in the chest.
            const keep = [
              { name: "raw_", minCount: 64 },
              { name: "coal", minCount: 32 },
              { name: "pickaxe", minCount: 1 },
              { name: "sword", minCount: 1 },
              { name: "food", minCount: 4 },
            ];
            await depositStash(bot, stashPos, keep).catch(() => {});
          }
          console.log(`[Skill] ${bot.username}: ${bot.inventory.emptySlotCount()} free slots after banking`);
        }

        // Clear jammed slots first. "destination full" killed the 10-raw-iron
        // batch in run 367: the shared village furnace held someone's old
        // output plus leftovers in the input/fuel slots, putInput threw, and
        // the whole load went unsmelted. Reclaim whatever is in the way —
        // output always (it's free ingots), input/fuel only when they hold
        // something this batch can't use.
        try {
          step = "reclaim-output";
          if (furnace.outputItem()) await furnace.takeOutput();
          step = "reclaim-input";
          const jammedInput = furnace.inputItem();
          if (jammedInput && jammedInput.name !== batch.itemName) await furnace.takeInput();
          const jammedFuel = furnace.fuelItem();
          if (jammedFuel && !FUEL_ITEMS.includes(jammedFuel.name)) await furnace.takeFuel();
        } catch (e) {
          // Say why. A silent reclaim failure is indistinguishable from an
          // empty furnace, and "destination full" here is the whole story.
          console.log(
            `[Skill] ${bot.username}: furnace reclaim failed (${(e as Error).message}) with ${bot.inventory.emptySlotCount()} free slots`,
          );
        }

        // Only put in what the slot can still hold.
        //
        // Run 766: four "Error: destination full", all thrown right after
        // "Smelting 2x raw_iron", with the reclaim above finding nothing to
        // clear and the pack not full. The furnace slots already held the SAME
        // item, and the reclaim leaves those alone on purpose, so the put
        // asked a slot with 64 coal to take more. A slot holds one stack; ask
        // for the difference.
        const roomIn = (slot: { count: number; stackSize?: number } | null, incoming: { type: number }) => {
          const max = bot.registry.items[incoming.type]?.stackSize ?? 64;
          return slot ? Math.max(0, max - slot.count) : max;
        };

        // Put fuel first
        step = "putFuel";
        const fuelItem = bot.inventory.items().find((i) => FUEL_ITEMS.includes(i.name));
        if (fuelItem) {
          // A slot holds ONE kind of item. Run 768 named this exactly:
          // 'smelt error at step "putFuel" on 21x raw_copper: Error:
          // destination full | furnace in=- fuel=oak_planksx4 out=- | pack 4
          // free'. Four planks in a sixty-four slot is not full, and coal
          // still cannot go in on top of planks. The reclaim above leaves
          // them because planks ARE fuel, which is right for the fuel already
          // burning and wrong for putting a different one in.
          const inFuelSlot = furnace.fuelItem();
          if (inFuelSlot && inFuelSlot.type !== fuelItem.type) {
            step = "reclaim-fuel-mismatch";
            console.log(
              `[Skill] ${bot.username}: fuel slot holds ${inFuelSlot.name}x${inFuelSlot.count} and this load brings ${fuelItem.name}; taking the ${inFuelSlot.name} back first`,
            );
            await furnace.takeFuel().catch(() => {});
            step = "putFuel";
          }
          const fuelNeeded =
            fuelItem.name === "coal" || fuelItem.name === "charcoal" ? Math.ceil(batch.count / 8) : batch.count;
          const room = roomIn(furnace.fuelItem(), fuelItem);
          const put = Math.min(fuelNeeded, fuelItem.count, room);
          if (put > 0) await furnace.putFuel(fuelItem.type, null, put);
          else console.log(`[Skill] ${bot.username}: fuel slot already full, smelting on what is in there`);
        }

        // Put ores in input
        step = "putInput";
        const inputItem = bot.inventory.items().find((i) => i.name === batch.itemName);
        if (inputItem) {
          const room = roomIn(furnace.inputItem(), inputItem);
          const put = Math.min(batch.count, inputItem.count, room);
          if (put > 0) await furnace.putInput(inputItem.type, null, put);
          else
            console.log(
              `[Skill] ${bot.username}: input slot already holds a full stack of ${batch.itemName}; waiting on this load`,
            );
        }

        // Wait for smelting (10s per item, capped at 2 minutes)
        step = "wait";
        const waitMs = Math.min(batch.count * 10500 + 3000, 120000);
        const startTime = Date.now();

        while (Date.now() - startTime < waitMs && !signal.aborted) {
          await new Promise((r) => setTimeout(r, 2500));
          const output = furnace.outputItem();
          if (output && output.count >= batch.count) break;
        }

        // Take output
        const output = furnace.outputItem();
        if (output) {
          await furnace.takeOutput();
          smelted += output.count;
          results.push(`${output.count}x ${batch.output}`);
        }

        furnace.close();
      } catch (err) {
        console.log(
          `[Skill] ${bot.username}: smelt error at step "${step}" on ${batch.count}x ${batch.itemName}: ${err} | furnace ${slotState()} | pack ${bot.inventory.emptySlotCount()} free`,
        );
        continue;
      }
    }

    if (smelted === 0) {
      return { success: false, message: "Smelting produced nothing. Maybe ran out of fuel or ores." };
    }

    // Bank the surplus, because the team crafts from the chest.
    //
    // Run 769 finally smelted ("Got: 7x iron_ingot, 10x copper_ingot") and
    // banked nothing: DEPOSITS was 0 for the hour, so those ingots stayed in
    // the smelter's pocket. Meanwhile Mason's fortress gate read "armour=1/2
    // gold=false" all hour, and craft_gear withdraws ingots from the stash by
    // design. A smelter that keeps its output turns a team supply into one
    // bot's pocket money.
    if (stashPos && !signal.aborted) {
      const { depositStash } = await import("./stash.js");
      const keep = [
        { name: "iron_ingot", minCount: 8 },
        { name: "pickaxe", minCount: 1 },
        { name: "sword", minCount: 1 },
        { name: "food", minCount: 4 },
        { name: "coal", minCount: 16 },
      ];
      const banked = await depositStash(bot, stashPos, keep).catch((e: Error) => `deposit failed: ${e.message}`);
      console.log(`[Skill] ${bot.username}: banking the smelt surplus -> ${String(banked).slice(0, 120)}`);
    }

    return {
      success: true,
      message: `Smelting done! Got: ${results.join(", ")}. Time to upgrade your gear with craft_gear!`,
      stats: { itemsSmelted: smelted },
    };
  },
};

function setMovements(bot: Bot) {
  const moves = baseMoves(bot);
  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowFreeMotion = false;
  moves.scafoldingBlocks = [];
  bot.pathfinder.setMovements(moves);
}

/** Bounded walk that survives external one-shot stops. The raw goto race this
 *  used to be had no interruption retry, so a single flee mid-walk stranded
 *  the smelter out of reach and the next openFurnace timed out — run 368's
 *  10-raw-iron batch died exactly this way. */
async function gotoTimed(bot: Bot, goal: any, ms: number): Promise<void> {
  const { safeGoto } = await import("../bot/navigation.js");
  await safeGoto(bot, goal, ms);
}

function countItem(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((s, i) => s + i.count, 0);
}
