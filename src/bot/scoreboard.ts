/**
 * Session scoreboard — the measurement layer for "are the bots getting
 * better over time?"
 *
 * Tracks per-session, per-bot performance plus team tech-tree milestones
 * (first log, first tool, first iron...) with timestamps relative to
 * session start. Written to logs/sessions/<sessionId>.json every minute so
 * sessions can be compared across code changes: if a change makes
 * time-to-first-tool worse, revert it.
 */

import fs from "fs";
import path from "path";
import type { Bot } from "mineflayer";

interface BotStats {
  actions: number;
  successes: number;
  failures: number;
  deaths: number;
  deposits: number;
  itemsDeposited: number;
  skillSuccesses: number;
  skillFailures: number;
}

interface Milestone {
  name: string;
  bot: string;
  /** Seconds since session start */
  atSec: number;
}

interface SessionStats {
  sessionId: string;
  sessionStart: string;
  /** Updated on each save */
  durationSec: number;
  perBot: Record<string, BotStats>;
  milestones: Milestone[];
}

const SESSION_START = Date.now();
const stats: SessionStats = {
  sessionId: new Date(SESSION_START).toISOString().replace(/[:.]/g, "-"),
  sessionStart: new Date(SESSION_START).toISOString(),
  durationSec: 0,
  perBot: {},
  milestones: [],
};

const reachedMilestones = new Set<string>();
let saveTimer: NodeJS.Timeout | null = null;
let dirty = false;

function botStats(name: string): BotStats {
  if (!stats.perBot[name]) {
    stats.perBot[name] = {
      actions: 0,
      successes: 0,
      failures: 0,
      deaths: 0,
      deposits: 0,
      itemsDeposited: 0,
      skillSuccesses: 0,
      skillFailures: 0,
    };
  }
  return stats.perBot[name];
}

/** Tech-tree milestones checked against inventory after each action. */
const INVENTORY_MILESTONES: { name: string; matches: (itemName: string) => boolean }[] = [
  { name: "first_log", matches: (n) => n.endsWith("_log") },
  { name: "first_planks", matches: (n) => n.endsWith("_planks") },
  { name: "first_crafting_table", matches: (n) => n === "crafting_table" },
  { name: "first_wooden_tool", matches: (n) => n.startsWith("wooden_") },
  { name: "first_stone_tool", matches: (n) => n.startsWith("stone_") && n !== "stone" },
  { name: "first_furnace", matches: (n) => n === "furnace" },
  { name: "first_coal", matches: (n) => n === "coal" || n === "charcoal" },
  { name: "first_iron_ingot", matches: (n) => n === "iron_ingot" },
  { name: "first_iron_tool", matches: (n) => n.startsWith("iron_") && n !== "iron_ingot" && n !== "iron_ore" },
  { name: "first_diamond", matches: (n) => n === "diamond" },
  { name: "first_bed", matches: (n) => n.endsWith("_bed") },
  { name: "first_chest", matches: (n) => n === "chest" },
];

function recordMilestone(name: string, bot: string): void {
  if (reachedMilestones.has(name)) return;
  reachedMilestones.add(name);
  const atSec = Math.round((Date.now() - SESSION_START) / 1000);
  stats.milestones.push({ name, bot, atSec });
  console.log(`[Scoreboard] 🏆 MILESTONE: ${name} by ${bot} at ${atSec}s`);
  dirty = true;
}

/** Call after every executed action. */
export function recordAction(botName: string, action: string, result: string, success: boolean): void {
  const b = botStats(botName);
  b.actions++;
  if (success) b.successes++;
  else b.failures++;

  const depositMatch = result.match(/Deposited (\d+) items/);
  if (depositMatch) {
    b.deposits++;
    b.itemsDeposited += parseInt(depositMatch[1]);
    if (parseInt(depositMatch[1]) > 0) recordMilestone("first_stash_deposit", botName);
  }
  if (/HOUSE BUILT/.test(result)) recordMilestone("first_complete_house", botName);
  if (/Farm complete|planted/i.test(result)) recordMilestone("first_farm", botName);
  if (/Stash bootstrapped/.test(result)) recordMilestone("first_stash", botName);
  dirty = true;
}

/** Call after skill executions (invoke_skill / direct skill actions). */
export function recordSkillResult(botName: string, success: boolean): void {
  const b = botStats(botName);
  if (success) b.skillSuccesses++;
  else b.skillFailures++;
  dirty = true;
}

export function recordDeath(botName: string): void {
  botStats(botName).deaths++;
  dirty = true;
}

/** Scan a bot's inventory for first-time tech milestones. */
export function checkInventoryMilestones(bot: Bot, botName: string): void {
  try {
    const names = bot.inventory.items().map((i) => i.name);
    for (const m of INVENTORY_MILESTONES) {
      if (!reachedMilestones.has(m.name) && names.some(m.matches)) {
        recordMilestone(m.name, botName);
      }
    }
  } catch {
    /* inventory not ready */
  }
}

function save(): void {
  if (!dirty) return;
  dirty = false;
  stats.durationSec = Math.round((Date.now() - SESSION_START) / 1000);
  try {
    const dir = path.resolve("logs", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${stats.sessionId}.json`), JSON.stringify(stats, null, 2));
  } catch (err) {
    console.error("[Scoreboard] Save failed:", err);
  }
}

/** Start periodic persistence. Idempotent. */
export function startScoreboard(): void {
  if (saveTimer) return;
  saveTimer = setInterval(save, 60_000);
  saveTimer.unref?.();
  console.log(`[Scoreboard] Session ${stats.sessionId} started`);
}

/** Current stats — used by the dashboard. */
export function getSessionStats(): SessionStats {
  stats.durationSec = Math.round((Date.now() - SESSION_START) / 1000);
  return stats;
}
