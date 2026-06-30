import type { Bot } from "mineflayer";
import type { Skill, SkillProgress, SkillResult } from "./types.js";
import { gatherMaterials } from "./materials.js";
import { updateOverlay } from "../stream/overlay.js";
import { recordSkillAttempt } from "../bot/memory.js";
import { getBotMemoryStore, registerBotMemory } from "../bot/memory-registry.js";

export { registerBotMemory };

type ActiveSkillState = {
  skill: Skill;
  abortController: AbortController;
  promise: Promise<SkillResult>;
  startTime: number;
};

// Per-bot skill state — keyed by bot instance so multiple bots don't interfere.
const activeSkillMap = new Map<Bot, ActiveSkillState>();

export function isSkillRunning(bot: Bot): boolean {
  return activeSkillMap.has(bot);
}

export function getActiveSkillName(bot: Bot): string | null {
  return activeSkillMap.get(bot)?.skill.name ?? null;
}

export function abortActiveSkill(bot: Bot): void {
  const active = activeSkillMap.get(bot);
  if (active) {
    console.log(`[Skill] Aborting skill "${active.skill.name}"`);
    active.abortController.abort();
  }
}

/**
 * Run a skill to completion: gather materials → execute → return result string.
 * Called from executeAction() when the LLM picks a skill action.
 */
export async function runSkill(bot: Bot, skill: Skill, params: Record<string, any>): Promise<string> {
  const active = activeSkillMap.get(bot);
  if (active) {
    return `Already running skill "${active.skill.name}". Wait for it to finish.`;
  }

  const abortController = new AbortController();
  const { signal } = abortController;
  const startTime = Date.now();

  console.log(`[Skill] Starting "${skill.name}"`);

  const progress = (p: SkillProgress) => {
    updateOverlay({ skillProgress: p });
    if (p.message) {
      console.log(`[Skill] ${skill.name}: ${p.phase} — ${p.message} (${Math.round(p.progress * 100)}%)`);
    }
  };

  // Phase 1: Gather materials
  progress({
    skillName: skill.name,
    phase: "Checking materials",
    progress: 0,
    message: "Scanning inventory...",
    active: true,
  });

  const materialsNeeded = skill.estimateMaterials(bot, params);
  const materialsList = Object.entries(materialsNeeded);

  if (materialsList.length > 0) {
    const summary = materialsList.map(([k, v]) => `${v}x ${k}`).join(", ");
    console.log(`[Skill] Materials needed: ${summary}`);

    try {
      const gatherResult = await gatherMaterials(bot, materialsNeeded, signal, (msg, pct) => {
        progress({
          skillName: skill.name,
          phase: "Gathering materials",
          progress: pct * 0.3,
          message: msg,
          active: true,
        });
      });

      if (!gatherResult.success) {
        progress({ skillName: skill.name, phase: "Failed", progress: 0, message: gatherResult.message, active: false });
        return `Skill ${skill.name} failed: ${gatherResult.message}`;
      }
    } catch (err: any) {
      progress({ skillName: skill.name, phase: "Failed", progress: 0, message: err.message, active: false });
      return `Skill ${skill.name} crashed during gathering: ${err.message}`;
    }
  }

  if (signal.aborted) {
    progress({ skillName: skill.name, phase: "Aborted", progress: 0, message: "Interrupted!", active: false });
    return `Skill ${skill.name} was interrupted.`;
  }

  // Phase 2: Execute the skill
  const skillPromise = skill.execute(bot, params, signal, (p) => {
    progress({
      ...p,
      progress: 0.3 + p.progress * 0.7, // Remap: gathering = 0-30%, execution = 30-100%
    });
  });

  activeSkillMap.set(bot, { skill, abortController, promise: skillPromise, startTime });

  // Skill chatter — bot narrates every 30s so the stream isn't dead air during long skills
  const SKILL_QUIPS = [
    "Still working on it... this better be worth it.",
    "Don't rush me, I'm an AI. Time is relative.",
    "Going great. Totally under control.",
    "This is fine. Everything is fine.",
    "Almost there... maybe.",
    "I have no idea how long this will take.",
    "Chat, if this works, you owe me a follow.",
    "My hands are a blur right now. Well, I don't have hands. You know what I mean.",
    "The process is the journey. Or something. I don't know, I'm busy.",
  ];
  const chatterInterval = setInterval(() => {
    if (activeSkillMap.has(bot)) {
      const quip = SKILL_QUIPS[Math.floor(Math.random() * SKILL_QUIPS.length)];
      bot.chat(quip);
    }
  }, 30000);

  // HARD WATCHDOG: a skill that blocks in an unbounded call (e.g. a
  // pathfinder.goto to an unreachable goal, or bot.dig on a stuck block) never
  // observes the abort signal, so it freezes the bot's ENTIRE brain loop
  // indefinitely. Atlas + Flora were frozen ~13h inside a hung strip_mine.
  // Race the skill against a hard timeout that force-stops movement and RETURNS,
  // freeing the brain regardless of what the skill's internal await is doing.
  const MAX_SKILL_MS = 240_000;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<{ success: boolean; message: string }>((resolve) => {
    watchdog = setTimeout(() => {
      try {
        bot.pathfinder.stop();
      } catch {
        /* best effort */
      }
      abortController.abort();
      resolve({
        success: false,
        message: `${skill.name} timed out after ${MAX_SKILL_MS / 1000}s — aborted to free the bot.`,
      });
    }, MAX_SKILL_MS);
    watchdog.unref?.();
  });

  try {
    const result = await Promise.race([skillPromise, timeoutPromise]);
    const durationSeconds = (Date.now() - startTime) / 1000;

    // Record skill attempt in per-bot memory (fallback to singleton for non-registered bots)
    const memStore = getBotMemoryStore(bot);
    if (memStore) {
      memStore.recordSkillAttempt(skill.name, result.success, durationSeconds, result.message);
    } else {
      recordSkillAttempt(skill.name, result.success, durationSeconds, result.message);
    }

    progress({
      skillName: skill.name,
      phase: result.success ? "Complete!" : "Failed",
      progress: result.success ? 1.0 : 0,
      message: result.message,
      active: false,
    });

    console.log(`[Skill] "${skill.name}" finished: ${result.message}`);
    return result.message;
  } catch (err: any) {
    const durationSeconds = (Date.now() - startTime) / 1000;
    const memStore = getBotMemoryStore(bot);
    if (memStore) {
      memStore.recordSkillAttempt(skill.name, false, durationSeconds, `Crashed: ${err.message}`);
    } else {
      recordSkillAttempt(skill.name, false, durationSeconds, `Crashed: ${err.message}`);
    }

    progress({ skillName: skill.name, phase: "Crashed", progress: 0, message: err.message, active: false });
    return `Skill ${skill.name} crashed: ${err.message}`;
  } finally {
    if (watchdog) clearTimeout(watchdog);
    clearInterval(chatterInterval);
    activeSkillMap.delete(bot);
  }
}
