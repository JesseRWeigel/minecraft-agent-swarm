import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto, GoalNearXZAbove } from "../bot/navigation.js";

/**
 * trade_with_villager — What a Deal! (adventure/trade), which fires the first
 * time any bot completes a single villager trade.
 *
 * There is no village near our base: the nearest one the server can locate is
 * the plains village at (608, ~, -496), ~650 blocks out. So the job is a long
 * dig-capable march to that village, find a villager whose trade we can afford
 * with what we already carry (a miner's coal sells to toolsmiths, armorers,
 * weaponsmiths and fishermen), and complete one trade. The march runs entirely
 * inside this one invocation: the walk-home reflex would otherwise drag the bot
 * back between firings, so partial progress can't be banked across attempts —
 * this is a daylight lottery, and keepInventory means a failed trip costs only
 * time.
 */

// The plains village the server locates nearest our base. Villagers cluster
// here; y is left to the pathfinder since the surface height varies.
const VILLAGE = { x: 608, z: -496 };

function overworld(bot: Bot): boolean {
  return /overworld/.test(String(bot.game.dimension));
}

function invCount(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((sum, i) => sum + i.count, 0);
}

export const tradeWithVillagerSkill: Skill = {
  name: "trade_with_villager",
  description:
    "March to the plains village and complete one villager trade (e.g. sell coal for an emerald). Earns What a Deal! — the gateway to the villager-trading advancements.",
  params: {},
  timeoutMs: 480_000,

  estimateMaterials(): Record<string, number> {
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "trade_with_villager", phase: "Trade", progress, message, active: true });
    const resumable = (msg: string) => `${msg} invoke_skill {"skill":"trade_with_villager"} again to continue.`;

    if (!overworld(bot)) {
      return { success: false, message: resumable("Not in the overworld — can't reach the village from here.") };
    }

    // Dig-capable march: unknown terrain over ~650 blocks snags cautious
    // moves on the first ridge, so bulldoze through. The searchRadius clamp
    // inside safeGoto bounds each hop.
    // Goods first. Runs 572 to 575: the march reached the village four times
    // and every trip ended "no villager had a trade I could afford", with 0
    // coal aboard and 2,882 coal in the stash. Sixteen coal is one emerald
    // at an armorer, toolsmith or weaponsmith; carry enough for two trades
    // so a bread purchase can follow.
    try {
      const { STASH_POS } = await import("../bot/role.js");
      const nearStash = Math.hypot(bot.entity.position.x - STASH_POS.x, bot.entity.position.z - STASH_POS.z) < 90;
      const { withdrawStash, depositStash } = await import("./stash.js");
      // Run 591: the first march that reached the fields dug 8 potatoes and
      // carried 0 home. Forge's pack was full of mining haul, so every drop
      // stayed on the ground and the "Pocket hygiene" reflex only fired after
      // the trip. Bank the haul at the stash before setting out, keeping the
      // trade goods, tools and food aboard.
      if (nearStash && bot.inventory.emptySlotCount() < 6) {
        const keepItems = (params?.keepItems as { name: string; minCount: number }[] | undefined) ?? [
          { name: "coal", minCount: 32 },
          { name: "emerald", minCount: 64 },
          { name: "stick", minCount: 8 },
          { name: "pickaxe", minCount: 1 },
          { name: "sword", minCount: 1 },
          { name: "bread", minCount: 16 },
          { name: "potato", minCount: 16 },
        ];
        const before = bot.inventory.emptySlotCount();
        step("Banking the haul before the trip...", 0.03);
        const r0 = await depositStash(bot, STASH_POS, keepItems).catch((e: Error) => e.message);
        console.log(
          `[TradeDebug] ${bot.username} pack full (${before} free): deposit -> ${String(r0).slice(0, 80)}; free now ${bot.inventory.emptySlotCount()}`,
        );
      }
      if (invCount(bot, "coal") < 16 && nearStash) {
        step("Fetching coal from the stash to sell...", 0.05);
        const r = await withdrawStash(bot, STASH_POS, "coal", 32).catch((e: Error) => e.message);
        console.log(`[TradeDebug] ${bot.username} coal withdraw: ${r} (coal now ${invCount(bot, "coal")})`);
      } else {
        console.log(`[TradeDebug] ${bot.username} goods aboard: coal ${invCount(bot, "coal")}, nearStash=${nearStash}`);
      }
      // Emeralds banked by a deposit reflex come along too: one emerald is
      // six bread at the farmer, and the What a Deal emerald sat in the
      // stash while three bots ran at 0 hunger (run 584).
      if (nearStash) {
        try {
          const { stashCount, ledgerKnown } = await import("./stash-ledger.js");
          if (invCount(bot, "emerald") < 1 && ledgerKnown() && stashCount("emerald", STASH_POS.y) >= 1) {
            const r3 = await withdrawStash(bot, STASH_POS, "emerald", 4).catch((e: Error) => e.message);
            console.log(
              `[TradeDebug] ${bot.username} emerald withdraw: ${r3} (emeralds now ${invCount(bot, "emerald")})`,
            );
          }
        } catch {
          /* ledger unavailable */
        }
        if (invCount(bot, "stick") < 8) {
          const r2 = await withdrawStash(bot, STASH_POS, "stick", 32).catch((e: Error) => e.message);
          console.log(`[TradeDebug] ${bot.username} stick withdraw: ${r2} (sticks now ${invCount(bot, "stick")})`);
        }
      }
    } catch (e) {
      console.log(`[TradeDebug] ${bot.username} coal withdraw skipped: ${(e as Error).message}`);
    }

    // Run 590: every march leg died in 0.0s with "The goal was changed":
    // the withdraw calls above had been raced against timeouts, and a timed
    // out withdraw kept walking chests in the background, replacing the
    // march's goal the instant it was set. The races are gone; withdraws
    // budget themselves. Kill any leftover goal before the march anyway.
    {
      const { bumpNavGeneration } = await import("../bot/navigation.js");
      bumpNavGeneration(bot);
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        /* no goal */
      }
    }

    // Run 592: the first trip after a restart still lost every leg to "The
    // goal was changed" in 0.0s, three unwedge hops included, while the
    // second trip walked clean. Third pass on this symptom, so instrument:
    // for the length of the march, every setGoal on this bot logs its caller.
    const pf = bot.pathfinder as unknown as {
      setGoal: (goal: unknown, dynamic?: boolean) => void;
    };
    const origSetGoal = pf.setGoal;
    let goalLogs = 0;
    pf.setGoal = function (goal: unknown, dynamic?: boolean) {
      if (goalLogs < 16) {
        goalLogs++;
        const frames = (new Error().stack ?? "")
          .split("\n")
          .slice(2, 6)
          .map((f) =>
            f
              .trim()
              .replace(/^at /, "")
              .replace(/\(.*\/src\//, "(src/"),
          )
          .join(" <- ");
        const name = goal ? ((goal as { constructor?: { name?: string } }).constructor?.name ?? "goal") : "null";
        console.log(`[TradeDebug] ${bot.username} setGoal(${name}) from ${frames}`);
      }
      return origSetGoal.call(this, goal, dynamic);
    };
    const restoreSetGoal = () => {
      if (pf.setGoal !== origSetGoal) pf.setGoal = origSetGoal;
    };

    const marchMoves = baseMoves(bot);
    (marchMoves as unknown as { canDig: boolean; allow1by1towers: boolean }).canDig = true;
    (marchMoves as unknown as { canDig: boolean; allow1by1towers: boolean }).allow1by1towers = true;
    bot.pathfinder.setMovements(marchMoves);

    // --- March to the village in ~120-block hops (stays inside the OOM
    //     searchRadius cap; each hop re-plans from the new position). ---
    const gapToVillage = () => Math.hypot(bot.entity.position.x - VILLAGE.x, bot.entity.position.z - VILLAGE.z);
    const marchUntil = Date.now() + 360_000;
    let guard = 0;
    let unwedges = 0;
    while (gapToVillage() > 40 && !signal.aborted && Date.now() < marchUntil) {
      const g = gapToVillage();
      step(`Marching to the village — ${Math.round(g)} blocks out...`, 0.1 + Math.min(0.5, (650 - g) / 1300));
      const t = Math.min(1, 120 / g);
      const wx = Math.round(bot.entity.position.x + (VILLAGE.x - bot.entity.position.x) * t);
      const wz = Math.round(bot.entity.position.z + (VILLAGE.z - bot.entity.position.z) * t);
      const before = gapToVillage();
      const legStart = Date.now();
      let legError = "";
      await safeGoto(bot, new GoalNearXZAbove(wx, wz, 12, 60), 45_000, 12_000).catch((e: Error) => {
        legError = e.message;
      });
      // A leg that dies inside three seconds with "No path" never left the
      // start: the bot is wedged in a stash chest (run 585: three legs
      // rejected in one second at (289, 70, -314), five trips lost). Step
      // onto a standable neighbour by hand and try the leg again.
      // "No route from here" is the phantom-arrival rejection (an empty path
      // from an invalid start); it is the same wedge as "No path".
      // Run 589: twelve legs returned inside one second with no navigation
      // line at all, so the message is unknown. Log every leg, and treat any
      // leg that ends inside three seconds without progress as the wedge.
      console.log(
        `[TradeDebug] ${bot.username} leg to (${wx}, ${wz}) took ${((Date.now() - legStart) / 1000).toFixed(1)}s: ${legError || "resolved"}; gap ${Math.round(before)} -> ${Math.round(gapToVillage())}`,
      );
      if (Date.now() - legStart < 3000 && before - gapToVillage() < 2 && unwedges < 3) {
        unwedges++;
        const p = bot.entity.position.floored();
        const { Vec3 } = await import("vec3");
        let hopped = false;
        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
          [1, 1],
          [-1, -1],
          [1, -1],
          [-1, 1],
        ]) {
          for (const dy of [0, 1]) {
            const feet = bot.blockAt(new Vec3(p.x + dx, p.y + dy, p.z + dz));
            const head = bot.blockAt(new Vec3(p.x + dx, p.y + dy + 1, p.z + dz));
            const floor = bot.blockAt(new Vec3(p.x + dx, p.y + dy - 1, p.z + dz));
            if (
              feet?.name === "air" &&
              head?.name === "air" &&
              floor?.boundingBox === "block" &&
              !/chest|barrel/.test(floor.name)
            ) {
              await bot.lookAt(new Vec3(p.x + dx + 0.5, p.y + dy + 1, p.z + dz + 0.5), true).catch(() => {});
              bot.setControlState("forward", true);
              bot.setControlState("jump", true);
              await new Promise((r) => setTimeout(r, 800));
              bot.clearControlStates();
              hopped = true;
              break;
            }
          }
          if (hopped) break;
        }
        console.log(
          `[TradeDebug] ${bot.username} leg rejected at once (${legError}); unwedge ${unwedges}: ${hopped ? "hopped" : "no standable neighbour"} at ${bot.entity.position.floored()}`,
        );
        continue;
      }
      if (before - gapToVillage() < 8 && ++guard >= 3) break;
      else if (before - gapToVillage() >= 8) guard = 0;
    }

    restoreSetGoal();
    if (gapToVillage() > 48) {
      return {
        success: false,
        message: resumable(`Couldn't reach the village this trip — still ${Math.round(gapToVillage())} blocks out.`),
      };
    }

    // --- Find a villager and complete an affordable trade. Try the few
    //     nearest, since some may be unprofessioned (no trades). ---
    step("At the village — looking for a villager to trade with...", 0.7);
    const CROPS: Record<string, { block: string; mature: number }> = {
      carrot: { block: "carrots", mature: 7 },
      potato: { block: "potatoes", mature: 7 },
      wheat: { block: "wheat", mature: 7 },
      beetroot: { block: "beetroots", mature: 3 },
    };
    const isFood = (n: string | undefined) =>
      !!n && /bread|cooked_|apple|cookie|pie|baked_potato|carrot|potato|melon/.test(n);
    // Crop demands seen on the first pass: { item, count }. Run 579: the one
    // villager in range was a farmer (1 emerald -> 6 bread; 22 carrot -> 1
    // emerald) and Forge held only coal, so four arrivals ended with nothing.
    const cropWanted = new Map<string, number>();

    const tryVillagers = async (pass: number): Promise<SkillResult | null> => {
      const tried = new Set<number>();
      // Villagers keep to their houses and the entity range is short: sweep
      // the centre and three offsets before giving up on "no villager".
      const sweep = [
        { x: VILLAGE.x, z: VILLAGE.z },
        { x: VILLAGE.x + 24, z: VILLAGE.z },
        { x: VILLAGE.x, z: VILLAGE.z + 24 },
        { x: VILLAGE.x - 24, z: VILLAGE.z - 24 },
      ];
      let sweepIdx = 0;
      for (let attempt = 0; attempt < 6 && !signal.aborted; attempt++) {
        let villager = bot.nearestEntity((e: Entity) => e.name === "villager" && !tried.has(e.id));
        while (!villager && sweepIdx < sweep.length && !signal.aborted) {
          const w = sweep[sweepIdx++];
          step(`No villager in sight — sweeping to ${w.x}, ${w.z}...`, 0.72);
          await safeGoto(bot, new goals.GoalNearXZ(w.x, w.z, 6), 40_000, 12_000).catch(() => {});
          villager = bot.nearestEntity((e: Entity) => e.name === "villager" && !tried.has(e.id));
        }
        if (!villager) break;
        tried.add(villager.id);

        const approachUntil = Date.now() + 45_000;
        while (!signal.aborted && Date.now() < approachUntil && bot.entity.position.distanceTo(villager.position) > 3) {
          await safeGoto(
            bot,
            new goals.GoalNear(villager.position.x, villager.position.y, villager.position.z, 2),
            20_000,
            8_000,
          ).catch(() => {});
          if (bot.entity.position.distanceTo(villager.position) > 3) await new Promise((r) => setTimeout(r, 800));
        }
        if (bot.entity.position.distanceTo(villager.position) > 4) continue;

        let win;
        try {
          win = await bot.openVillager(villager);
        } catch {
          continue;
        }
        const trades = win?.trades ?? [];
        const inputsOf = (t: (typeof trades)[number]) =>
          t.hasItem2 && t.inputItem2 ? [t.inputItem1, t.inputItem2] : [t.inputItem1];
        const canPay = (t: (typeof trades)[number]) => {
          if (!t || t.tradeDisabled) return false;
          if (t.nbTradeUses >= t.maximumNbTradeUses) return false;
          return inputsOf(t).every((inp) => inp && invCount(bot, inp.name) >= inp.count);
        };
        console.log(
          `[TradeDebug] ${bot.username} pass ${pass} villager ${villager.id}: ` +
            (trades.length
              ? trades
                  .map(
                    (t) =>
                      `${inputsOf(t)
                        .map((i) => (i ? `${i.count} ${i.name}` : "?"))
                        .join(
                          "+",
                        )} -> ${t.outputItem ? `${t.outputItem.count} ${t.outputItem.name}` : "?"}${t.tradeDisabled ? " (disabled)" : ""}${canPay(t) ? " [ok]" : ""}`,
                  )
                  .join("; ")
              : "no trades (unprofessioned)"),
        );
        for (const t of trades) {
          const inp = t?.inputItem1;
          if (inp && CROPS[inp.name] && t.outputItem?.name === "emerald" && !t.tradeDisabled) {
            cropWanted.set(inp.name, Math.max(cropWanted.get(inp.name) ?? 0, inp.count));
          }
        }
        const foodTrade = bot.food < 14 ? trades.find((t) => canPay(t) && isFood(t.outputItem?.name)) : undefined;
        // Run 592: Forge sold the What a Deal emerald to a cleric for 2
        // redstone (the stash holds 811). Emeralds only leave for food.
        const spendsEmerald = (t: (typeof trades)[number]) => inputsOf(t).some((i) => i?.name === "emerald");
        const affordable = foodTrade ?? trades.find((t) => canPay(t) && !spendsEmerald(t));
        if (!affordable) {
          bot.closeWindow(win);
          continue;
        }

        const idx = trades.indexOf(affordable);
        const sold = inputsOf(affordable)
          .map((i) => `${i.count} ${i.name}`)
          .join(" + ");
        const got = affordable.outputItem ? `${affordable.outputItem.count} ${affordable.outputItem.name}` : "goods";
        step(`Trading ${sold} → ${got}...`, 0.9);
        try {
          await bot.trade(win, idx, 1);
        } catch (e) {
          bot.closeWindow(win);
          return { success: false, message: resumable(`The trade of ${sold} didn't go through (${String(e)}).`) };
        }
        console.log(`[TradeDebug] ${bot.username} TRADED ${sold} -> ${got}`);
        // With an emerald in hand and bread on offer, buy the bread too.
        const bread = trades.find(
          (t) => t !== affordable && t.outputItem?.name === "bread" && canPay(t) && !t.tradeDisabled,
        );
        if (bread) {
          try {
            await bot.trade(win, trades.indexOf(bread), 1);
            console.log(`[TradeDebug] ${bot.username} then bought ${bread.outputItem?.count} bread`);
          } catch {
            /* the first trade already counts */
          }
        }
        bot.closeWindow(win);
        return {
          success: true,
          message: `Traded ${sold} for ${got} at the village — What a Deal! should be banked.`,
          stats: { villageX: VILLAGE.x, villageZ: VILLAGE.z },
        };
      }
      return null;
    };

    const first = await tryVillagers(1);
    if (first) return first;

    // Meet a farmer's demand from the village's own fields: mature crops
    // drop 1 to 4 each, so 22 carrots is about ten plants.
    for (const [item, need] of cropWanted) {
      if (signal.aborted) break;
      const crop = CROPS[item];
      const have = () => invCount(bot, item);
      step(`Harvesting ${need} ${item} from the village fields...`, 0.8);
      let dug = 0;
      const deadline = Date.now() + 240_000;
      // Census first (run 580: "harvested 0 carrots" twice with no word on
      // what the fields held). Every crop block within 48, by type and age.
      const census: Record<string, Record<string, number>> = {};
      for (const pos of bot.findBlocks({
        matching: (b) => ["carrots", "potatoes", "wheat", "beetroots", "farmland"].includes(b.name),
        maxDistance: 48,
        count: 600,
      })) {
        const b = bot.blockAt(pos);
        if (!b) continue;
        const age = b.name === "farmland" ? "-" : String(b.getProperties()?.age ?? "?");
        census[b.name] = census[b.name] ?? {};
        census[b.name][age] = (census[b.name][age] ?? 0) + 1;
      }
      console.log(
        `[TradeDebug] ${bot.username} crops within 48 of (${Math.round(bot.entity.position.x)}, ${Math.round(bot.entity.position.z)}): ${JSON.stringify(census)}`,
      );
      {
        const { shedJunk } = await import("../bot/navigation.js");
        await shedJunk(bot, 4).catch(() => {});
      }
      while (have() < need && dug < 24 && Date.now() < deadline && !signal.aborted) {
        // Mature first; an immature plant still drops one item, which is
        // enough when the mature ones are gone.
        const plant =
          bot.findBlock({
            matching: (b) => b.name === crop.block && Number(b.getProperties()?.age ?? 0) >= crop.mature,
            maxDistance: 48,
          }) ??
          bot.findBlock({
            matching: (b) =>
              b.name === crop.block && Number(b.getProperties()?.age ?? 0) >= Math.floor(crop.mature / 2),
            maxDistance: 48,
          });
        if (!plant) break;
        await safeGoto(
          bot,
          new goals.GoalNear(plant.position.x, plant.position.y, plant.position.z, 2),
          30_000,
          8_000,
        ).catch(() => {});
        if (bot.entity.position.distanceTo(plant.position) > 4.5) break;
        try {
          await bot.dig(plant);
          dug++;
        } catch {
          break;
        }
        const { collectNearbyDrops } = await import("../bot/navigation.js");
        await collectNearbyDrops(bot, 4, 2000).catch(() => {});
      }
      console.log(`[TradeDebug] ${bot.username} harvested ${dug} ${crop.block}: ${item} now ${have()} (need ${need})`);
      if (have() >= need) {
        const second = await tryVillagers(2);
        if (second) return second;
      }
    }

    // No affordable trade. The trip still feeds the bot when the fields have
    // a crop nobody wants: run 586's census read 28 mature potatoes and no
    // wheat (the last trip took all 20), while Forge stood at 0 hunger. Take
    // up to 24 plants, replant one potato on each cleared farmland, eat raw
    // potatoes until hunger is back over 12, and carry the rest home.
    let potatoes = 0;
    let replanted = 0;
    if (bot.food < 14) {
      const { Vec3 } = await import("vec3");
      const { collectNearbyDrops, shedJunk } = await import("../bot/navigation.js");
      // Drops need open slots; toss bulk stone rather than dig into a full pack.
      await shedJunk(bot, 4).catch(() => {});
      const deadline = Date.now() + 200_000;
      let dug = 0;
      while (dug < 24 && Date.now() < deadline && !signal.aborted) {
        const plant = bot.findBlock({
          matching: (b) => b.name === "potatoes" && Number(b.getProperties()?.age ?? 0) >= 7,
          maxDistance: 48,
        });
        if (!plant) break;
        step(`No trade for me — harvesting potatoes (${dug} plants)...`, 0.85);
        await safeGoto(
          bot,
          new goals.GoalNear(plant.position.x, plant.position.y, plant.position.z, 2),
          30_000,
          8_000,
        ).catch(() => {});
        if (bot.entity.position.distanceTo(plant.position) > 4.5) break;
        try {
          await bot.dig(plant);
          dug++;
        } catch {
          break;
        }
        await collectNearbyDrops(bot, 4, 1500).catch(() => {});
        const seed = bot.inventory.items().find((i) => i.name === "potato");
        const soil = bot.blockAt(plant.position.offset(0, -1, 0));
        if (seed && soil?.name === "farmland") {
          try {
            await bot.equip(seed, "hand");
            await bot.placeBlock(soil, new Vec3(0, 1, 0));
            replanted++;
          } catch {
            /* replanting is a courtesy */
          }
        }
      }
      potatoes = invCount(bot, "potato");
      let ate = 0;
      for (let i = 0; i < 12 && bot.food < 12 && !signal.aborted; i++) {
        const spud = bot.inventory.items().find((it) => it.name === "potato");
        if (!spud) break;
        try {
          await bot.equip(spud, "hand");
          await bot.consume();
          ate++;
        } catch {
          break;
        }
      }
      console.log(
        `[TradeDebug] ${bot.username} potato fallback: dug ${dug}, replanted ${replanted}, ate ${ate}, carrying ${invCount(bot, "potato")}, hunger now ${bot.food}`,
      );
      if (dug > 0) {
        return {
          success: true,
          message: `No affordable trade, but harvested ${dug} potato plants at the village (replanted ${replanted}, ate ${ate}, carrying ${invCount(bot, "potato")}). Bake them at a furnace for 5 hunger each.`,
        };
      }
    }

    return {
      success: false,
      message: resumable(
        `Reached the village but no villager had a trade I could afford (carrying coal ${invCount(bot, "coal")}, sticks ${invCount(bot, "stick")}, potatoes ${potatoes}${[...cropWanted].map(([k, v]) => `, ${k} ${invCount(bot, k)}/${v}`).join("")}).`,
      ),
    };
  },
};
