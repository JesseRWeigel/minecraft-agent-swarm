import type { Bot } from "mineflayer";

/** Opt-in demo commands only; disabling them does not reset existing world rules. */
export async function applyStartupGamerules(bot: Pick<Bot, "chat">, username: string, allowInterventions: boolean) {
  if (username !== "Atlas" || !allowInterventions) return;
  bot.chat("/gamerule keepInventory true");
  await new Promise((resolve) => setTimeout(resolve, 500));
  bot.chat("/gamerule doMobSpawning true");
  await new Promise((resolve) => setTimeout(resolve, 500));
}
