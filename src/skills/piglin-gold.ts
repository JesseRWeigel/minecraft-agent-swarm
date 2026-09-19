import type { Bot } from "mineflayer";

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
      if (ingots() >= 4) {
        onStep?.("Forging golden boots from stash gold...");
        const { craftPiece } = await import("./craft-gear.js");
        const mcDataLoader = (await import("minecraft-data")).default;
        const ok = await craftPiece(bot, mcDataLoader(bot.version), "golden_boots", []).catch(() => false);
        console.log(`[${tag}] ${bot.username}: golden boots forge ${ok ? "done" : "failed"} (ingots left ${ingots()})`);
        gold = bot.inventory.items().find((i) => GOLD_PIECE.test(i.name));
      } else {
        console.log(`[${tag}] ${bot.username}: no golden boots and only ${ingots()} gold ingots reachable`);
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
    console.log(
      `[${tag}] ${bot.username}: wearing ${gold.name} for the piglins (${wornGold(bot) ? "on" : "equip failed"})`,
    );
  }
  return wornGold(bot);
}
