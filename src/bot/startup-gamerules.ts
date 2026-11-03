import type { Bot } from "mineflayer";

/** Opt-in demo commands only; disabling them does not reset existing world rules. */
export async function applyStartupGamerules(
  bot: Pick<Bot, "chat">,
  username: string,
  allowInterventions: boolean,
  serverVersion = "1.21.4",
) {
  if (username !== "Atlas" || !allowInterventions) return;
  const [keepInventory, spawnMobs] =
    serverVersion === "26.3"
      ? ["minecraft:keep_inventory", "minecraft:spawn_mobs"]
      : ["keepInventory", "doMobSpawning"];
  bot.chat(`/gamerule ${keepInventory} true`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  bot.chat(`/gamerule ${spawnMobs} true`);
  await new Promise((resolve) => setTimeout(resolve, 500));
}
