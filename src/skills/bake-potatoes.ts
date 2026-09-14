import type { Bot } from "mineflayer";
import pkg from "mineflayer-pathfinder";
import { safeGoto } from "../bot/navigation.js";

const { goals } = pkg;

/**
 * Bake raw potatoes at the nearest furnace. Run 609: the village trip
 * brought 28 potatoes home and three bots ate them raw at one hunger each;
 * a baked potato restores five. The stash holds thousands of coal.
 * Returns the number of baked potatoes taken out of the furnace.
 */
export async function bakePotatoes(bot: Bot, maxCount = 16): Promise<number> {
  const count = (name: string) =>
    bot.inventory
      .items()
      .filter((i) => i.name === name)
      .reduce((n, i) => n + i.count, 0);
  const potatoes = Math.min(maxCount, count("potato"));
  const fuel = bot.inventory.items().find((i) => i.name === "coal" || i.name === "charcoal");
  if (potatoes < 1 || !fuel) return 0;
  let furnaceBlock = bot.findBlock({
    matching: (b) => b.name === "furnace" || b.name === "lit_furnace",
    maxDistance: 24,
  });
  if (!furnaceBlock) {
    console.log(`[Bake] ${bot.username}: no furnace within 24 blocks`);
    return 0;
  }
  const fp = furnaceBlock.position;
  await safeGoto(bot, new goals.GoalNear(fp.x, fp.y, fp.z, 2), 30_000, 8_000).catch(() => {});
  if (bot.entity.position.distanceTo(fp) > 4.5) {
    console.log(`[Bake] ${bot.username}: could not reach the furnace at ${fp}`);
    return 0;
  }
  furnaceBlock = bot.findBlock({
    matching: (b) => b.name === "furnace" || b.name === "lit_furnace",
    maxDistance: 6,
  });
  if (!furnaceBlock) return 0;
  let baked = 0;
  try {
    const furnace = (await Promise.race([
      bot.openFurnace(furnaceBlock),
      new Promise((_, rej) => setTimeout(() => rej(new Error("openFurnace timeout")), 10_000)),
    ])) as Awaited<ReturnType<typeof bot.openFurnace>>;
    try {
      if (furnace.outputItem()) await furnace.takeOutput();
      const jammedInput = furnace.inputItem();
      if (jammedInput && jammedInput.name !== "potato") await furnace.takeInput();
      const jammedFuel = furnace.fuelItem();
      if (jammedFuel && jammedFuel.name !== "coal" && jammedFuel.name !== "charcoal") await furnace.takeFuel();
    } catch {
      /* best effort */
    }
    const fuelNeeded = Math.ceil(potatoes / 8);
    await furnace.putFuel(fuel.type, null, Math.min(fuelNeeded, fuel.count));
    const spud = bot.inventory.items().find((i) => i.name === "potato");
    if (spud) await furnace.putInput(spud.type, null, Math.min(potatoes, spud.count));
    const waitMs = Math.min(potatoes * 10_500 + 3_000, 180_000);
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      await new Promise((r) => setTimeout(r, 2_500));
      const out = furnace.outputItem();
      if (out && out.count >= potatoes) break;
    }
    const out = furnace.outputItem();
    if (out) {
      await furnace.takeOutput();
      baked = out.count;
    }
    furnace.close();
  } catch (err) {
    console.log(`[Bake] ${bot.username}: ${String(err).slice(0, 100)}`);
  }
  console.log(`[Bake] ${bot.username} baked ${baked} potatoes (had ${potatoes} raw, fuel ${fuel.name})`);
  return baked;
}
