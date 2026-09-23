import type { Bot } from "mineflayer";
import { markPiglinPassport } from "../bot/gold-passport.js";

/**
 * Piglins leave a player alone who wears any one gold armour piece. Every
 * Nether trip past the portal (the fortress sweep, the bastion raid) wears a
 * piece first, and the brain's trip gates count a piece worn OR carried.
 *
 * Run 701: Mason wore the golden boots home from a fortress sweep, and the
 * bastion reflex then never fired again because its gate read only the pack
 * (bot.inventory.items() skips the four armour slots).
 */
const GOLD_PIECE = /^golden_(boots|helmet|chestplate|leggings)$/;

/** True when a worn armour slot holds a gold piece. */
export function wornGold(bot: Bot): boolean {
  const inv = bot.inventory;
  return [5, 6, 7, 8].some((i) => !!inv.slots[i] && inv.slots[i]!.name.startsWith("golden_"));
}

/** A gold piece worn or in the pack: the brain's gate for a piglin-country trip. */
export function hasGoldPiece(bot: Bot): boolean {
  return wornGold(bot) || bot.inventory.items().some((i) => GOLD_PIECE.test(i.name));
}

/**
 * Wear one gold piece before crossing, fetching golden boots from the stash
 * when the pack holds none. Resolves to whether gold is worn afterwards.
 */
export async function wearGoldForPiglins(bot: Bot, tag: string, onStep?: (msg: string) => void): Promise<boolean> {
  if (wornGold(bot)) return true;
  let gold = bot.inventory.items().find((i) => GOLD_PIECE.test(i.name));
  if (!gold) {
    onStep?.("Fetching golden boots for the piglins...");
    const { withdrawStash } = await import("./stash.js");
    const { STASH_POS } = await import("../bot/role.js");
    await withdrawStash(bot, STASH_POS, "golden_boots", 1, 60_000).catch(() => {});
    gold = bot.inventory.items().find((i) => GOLD_PIECE.test(i.name));
    if (!gold) {
      // Run 709: the boots burned off Mason's feet in Nether fire (gold armour
      // has 91 durability), and the stash held five gold ingots and no boots,
      // so both Nether trips stood down. Forge a pair: four ingots at a table.
      const ingots = () =>
        bot.inventory
          .items()
          .filter((i) => i.name === "gold_ingot")
          .reduce((n, i) => n + i.count, 0);
      if (ingots() < 4) await withdrawStash(bot, STASH_POS, "gold_ingot", 4 - ingots(), 60_000).catch(() => {});
      // Run 711: both Nether trips stood down for sixteen hours with "only 0
      // gold ingots reachable", while a gold_block from the bastion chest sat
      // in the stash. One block is nine ingots at a crafting table.
      if (ingots() < 4) {
        const hasBlock = () => bot.inventory.items().some((i) => i.name === "gold_block");
        if (!hasBlock()) await withdrawStash(bot, STASH_POS, "gold_block", 1, 60_000).catch(() => {});
        if (hasBlock()) {
          const { craftPiece } = await import("./craft-gear.js");
          const mcd = (await import("minecraft-data")).default;
          const ok = await craftPiece(bot, mcd(bot.version), "gold_ingot", []).catch(() => false);
          console.log(
            `[${tag}] ${bot.username}: broke a gold_block for ingots ${ok ? "ok" : "failed"} (now ${ingots()})`,
          );
        }
      }
      // Nuggets are gold too, and they are the form this swarm actually mines.
      //
      // Nether gold ore drops nuggets, not ingots, and Mason has been mining
      // it on every crossing. Nine nuggets make an ingot at a table, and this
      // preflight knew about ingots, blocks and raw gold while walking past
      // the nuggets. Run 773 stood down nine fortress trips with "No gold to
      // wear" on the strength of that gap.
      if (ingots() < 4) {
        const nuggetsHeld = () =>
          bot.inventory
            .items()
            .filter((i) => i.name === "gold_nugget")
            .reduce((n, i) => n + i.count, 0);
        const want = (4 - ingots()) * 9;
        if (nuggetsHeld() < want) {
          await withdrawStash(bot, STASH_POS, "gold_nugget", want - nuggetsHeld(), 60_000).catch(() => {});
        }
        if (nuggetsHeld() >= 9) {
          const mcDataLoader = (await import("minecraft-data")).default;
          const mcData = mcDataLoader(bot.version);
          const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 24 });
          const def = mcData.itemsByName["gold_ingot"];
          const recipe = def && table ? bot.recipesFor(def.id, null, 1, table)[0] : null;
          if (recipe && table) {
            const batches = Math.floor(nuggetsHeld() / 9);
            await bot.craft(recipe, batches, table).catch(() => {});
          }
          console.log(
            `[${tag}] ${bot.username}: ${nuggetsHeld()} nuggets, table=${!!table}, recipe=${!!recipe} -> ingots now ${ingots()}`,
          );
        } else if (nuggetsHeld() > 0) {
          console.log(`[${tag}] ${bot.username}: only ${nuggetsHeld()} gold nuggets, nine make an ingot`);
        }
      }
      if (ingots() >= 4) {
        onStep?.("Forging golden boots from stash gold...");
        const { craftPiece } = await import("./craft-gear.js");
        const mcDataLoader = (await import("minecraft-data")).default;
        const ok = await craftPiece(bot, mcDataLoader(bot.version), "golden_boots", []).catch(() => false);
        console.log(`[${tag}] ${bot.username}: golden boots forge ${ok ? "done" : "failed"} (ingots left ${ingots()})`);
        gold = bot.inventory.items().find((i) => GOLD_PIECE.test(i.name));
      }
      if (ingots() < 4) {
        // Run 728: four trips in a row ended here with "only 2 gold ingots
        // reachable" while six raw gold sat in the stash. Gold armour wears
        // out in the Nether, so every trip spends a pair of boots and the
        // ingot pile runs down. Raw gold becomes ingots in a furnace, and
        // smelt_ores already withdraws ore from the stash and smelts it.
        const { stashCount } = await import("./stash-ledger.js");
        const { STASH_POS: SP } = await import("../bot/role.js");
        const rawBanked = stashCount("raw_gold", SP.y);
        if (rawBanked > 0) {
          onStep?.("Smelting raw gold for boots...");
          // Run 729: the smelting skill answered "Nothing to smelt" with six
          // raw gold banked, because its whole stash-withdrawal step is
          // skipped unless a stash position is passed in, and the call gave
          // it none. Take the gold out first, so the skill smelts THAT
          // rather than whichever ore its own loop reaches first, and hand
          // it the stash so it can fetch its own fuel.
          const rawHeld = () =>
            bot.inventory
              .items()
              .filter((i) => i.name === "raw_gold")
              .reduce((n, i) => n + i.count, 0);
          if (rawHeld() < 4) await withdrawStash(bot, STASH_POS, "raw_gold", 4 - rawHeld(), 60_000).catch(() => {});
          const { smeltOresSkill } = await import("./smelt-ores.js");
          const r = await smeltOresSkill
            .execute(bot, { stashPos: SP }, new AbortController().signal, () => {})
            .catch((e: Error) => ({ message: String(e).slice(0, 70) }));
          console.log(
            `[${tag}] ${bot.username}: smelting raw_gold (banked ${rawBanked}, aboard ${rawHeld()}) -> ${String(r.message).slice(0, 70)} (ingots now ${ingots()})`,
          );
        }
      }
      if (ingots() >= 4) {
        onStep?.("Forging golden boots from smelted gold...");
        const { craftPiece: craftAgain } = await import("./craft-gear.js");
        const mcd2 = (await import("minecraft-data")).default;
        await craftAgain(bot, mcd2(bot.version), "golden_boots", []).catch(() => false);
        gold = bot.inventory.items().find((i) => GOLD_PIECE.test(i.name));
      }
      if (!gold) {
        console.log(
          `[${tag}] ${bot.username}: no golden boots and only ${ingots()} gold ingots reachable (raw gold in the stash is the next source)`,
        );
      }
    }
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
    // Tell the armour pass why this piece is on, or it upgrades the bot out of
    // it before the crossing (run 758: iron boots went back on twenty seconds
    // later, in the overworld, and piglins shot him twice past the portal).
    if (wornGold(bot)) markPiglinPassport(bot.username);
    console.log(
      `[${tag}] ${bot.username}: wearing ${gold.name} for the piglins (${wornGold(bot) ? "on" : "equip failed"})`,
    );
  }
  return wornGold(bot);
}

/**
 * Run 733: hoglins killed Mason three times in one hour on the Nether route,
 * and his armour line read "-,-,-,golden_boots" every time. Gold answers
 * piglins and nothing else, so a trip past the portal needs real armour.
 * The stash holds raw iron the miner brought home, which is a furnace and a
 * crafting table away from a set. Best effort, before the crossing.
 */
export async function armourUpForNether(bot: Bot, tag: string, onStep?: (msg: string) => void): Promise<number> {
  const worn = () => [5, 6, 7, 8].filter((i) => !!bot.inventory.slots[i]).length;
  // Run 743: this returned here the moment the armour was full, which skipped
  // the stone and the sword below it, so the carve reported "no scaffold
  // block to pillar with" on a bot wearing four pieces. Armour is one part of
  // the kit; the rest is packed whichever way this test goes.
  const armourDone = worn() >= 3;
  const { withdrawStash } = await import("./stash.js");
  const { STASH_POS } = await import("../bot/role.js");
  const { craftPiece } = await import("./craft-gear.js");
  const mcDataLoader = (await import("minecraft-data")).default;
  const mcData = mcDataLoader(bot.version);
  const count = (n: string) =>
    bot.inventory
      .items()
      .filter((i) => i.name === n)
      .reduce((a, i) => a + i.count, 0);

  // helmet 5, chestplate 8, leggings 7, boots 4; feet are usually the gold.
  const wanted: Array<[string, number, "head" | "torso" | "legs"]> = [
    ["iron_chestplate", 8, "torso"],
    ["iron_helmet", 5, "head"],
    ["iron_leggings", 7, "legs"],
  ];
  for (const [piece, cost, dest] of wanted) {
    if (armourDone || worn() >= 3) break;
    let have = bot.inventory.items().find((i) => i.name === piece);
    if (!have) {
      if (count("iron_ingot") < cost) {
        const short = cost - count("iron_ingot");
        await withdrawStash(bot, STASH_POS, "iron_ingot", short, 45_000).catch(() => {});
      }
      if (count("iron_ingot") < cost && count("raw_iron") + count("iron_ingot") < cost) {
        await withdrawStash(bot, STASH_POS, "raw_iron", cost - count("iron_ingot"), 45_000).catch(() => {});
      }
      if (count("iron_ingot") < cost && count("raw_iron") > 0) {
        onStep?.(`Smelting raw iron for ${piece}...`);
        const { smeltOresSkill } = await import("./smelt-ores.js");
        await smeltOresSkill
          .execute(bot, { stashPos: STASH_POS }, new AbortController().signal, () => {})
          .catch(() => ({}));
      }
      if (count("iron_ingot") >= cost) {
        onStep?.(`Forging ${piece}...`);
        await craftPiece(bot, mcData, piece, []).catch(() => false);
        have = bot.inventory.items().find((i) => i.name === piece);
      }
    }
    if (have) await bot.equip(have, dest).catch(() => {});
  }
  // Run 742: the climb out of the cavern finally fired and failed twice,
  // once for a perch four blocks overhead. Mason was carrying no building
  // blocks at all, so there was nothing to tower with, while the stash held
  // fifteen thousand cobblestone. A Nether trip carries stone for towering
  // and bridging the same way it carries gold and armour.
  const blocksHeld = () =>
    bot.inventory
      .items()
      .filter((i) => i.name === "cobblestone" || i.name === "netherrack" || i.name === "dirt")
      .reduce((a, i) => a + i.count, 0);
  if (blocksHeld() < 32) {
    onStep?.("Packing stone for the climb...");
    for (const block of ["cobblestone", "netherrack", "dirt"]) {
      if (blocksHeld() >= 32) break;
      await withdrawStash(bot, STASH_POS, block, 64 - blocksHeld(), 45_000).catch(() => {});
    }
  }

  // Armour without a weapon still loses the fight: he had none all run.
  // Run 808: two trips crossed with sword=false and the second was killed by
  // a wither skeleton 38 blocks from the bricks. Both blades need a stick,
  // the swarm had none and no wood in the stash, while the stash ledger held
  // 385 stone swords and an iron one. Take a finished sword before crafting.
  const hasSword = () => bot.inventory.items().some((i) => i.name.endsWith("_sword"));
  for (const blade of ["diamond_sword", "iron_sword", "stone_sword"]) {
    if (hasSword()) break;
    await withdrawStash(bot, STASH_POS, blade, 1, 45_000).catch(() => {});
  }
  if (!hasSword()) {
    onStep?.("Forging a sword for the crossing...");
    for (const blade of ["iron_sword", "stone_sword"]) {
      const made = await craftPiece(bot, mcData, blade, []).catch(() => false);
      if (made) break;
    }
  }
  console.log(
    `[${tag}] ${bot.username}: armour before the crossing -> ${worn()} pieces worn (iron ingots ${count("iron_ingot")}, raw ${count("raw_iron")}), sword=${bot.inventory.items().some((i) => i.name.endsWith("_sword"))}, blocks=${blocksHeld()}`,
  );
  return worn();
}
