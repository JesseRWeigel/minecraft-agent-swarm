/**
 * Per-bot memory store registry.
 *
 * Extracted into its own module to avoid circular imports:
 *   executor.ts → registry.ts → build-house.ts → memory-registry.ts ← executor.ts (OK)
 *
 * Both executor.ts (skill recording) and build-house.ts (structure recording)
 * need per-bot stores. Having this in a separate leaf module breaks the cycle.
 */
import type { Bot } from "mineflayer";
import type { BotMemoryStore } from "./memory.js";

const memStoreMap = new Map<Bot, BotMemoryStore>();

export function registerBotMemory(bot: Bot, store: BotMemoryStore): void {
  memStoreMap.set(bot, store);
}

export function getBotMemoryStore(bot: Bot): BotMemoryStore | undefined {
  return memStoreMap.get(bot);
}

/**
 * All registered bot memory stores. Used for TEAM-wide queries — e.g.
 * "did ANY bot build a house near here?" Per-bot structure memory caused
 * each bot to start its own overlapping shell because it couldn't see
 * what teammates had already built.
 */
export function getAllMemoryStores(): BotMemoryStore[] {
  return [...new Set(memStoreMap.values())];
}
