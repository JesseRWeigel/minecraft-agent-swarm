/**
 * Skill reliability — aggregates success rates across every bot's memory
 * and retires skills that demonstrably never work.
 *
 * Before this existed, the team retried craftWoodenPickaxe 56 times with
 * 1 success: the per-bot "broken skill" detection excludes precondition
 * failures, so chronically failing skills were re-attempted forever. This
 * module closes the loop: stats are computed team-wide, surfaced in the
 * strategic prompt (the LLM prefers skills that work), and skills below
 * the retirement threshold are removed from the menu entirely.
 */

import { getAllMemoryStores } from "../bot/memory-registry.js";
import { PRECONDITION_KEYWORDS } from "../bot/memory.js";

export interface SkillStats {
  attempts: number;
  successes: number;
  rate: number;
}

/** Retire a skill once it has this many attempts with a rate below RETIRE_RATE. */
const RETIRE_MIN_ATTEMPTS = 8;
const RETIRE_RATE = 0.1;

const CACHE_TTL_MS = 60_000;
let cache: Map<string, SkillStats> | null = null;
let cacheAt = 0;

function isPreconditionFailure(notes: string): boolean {
  const lower = (notes || "").toLowerCase();
  return PRECONDITION_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
}

function computeStats(): Map<string, SkillStats> {
  const m = new Map<string, SkillStats>();
  for (const store of getAllMemoryStores()) {
    for (const attempt of store.getSkillHistory()) {
      // Precondition failures (missing materials, wrong location) say nothing
      // about whether the skill WORKS — don't let yesterday's wood shortage
      // permanently retire a fixable skill. Successes always count.
      if (!attempt.success && isPreconditionFailure(attempt.notes)) continue;
      const cur = m.get(attempt.skill) ?? { attempts: 0, successes: 0, rate: 0 };
      cur.attempts++;
      if (attempt.success) cur.successes++;
      m.set(attempt.skill, cur);
    }
  }
  for (const s of m.values()) s.rate = s.attempts ? s.successes / s.attempts : 0;
  return m;
}

function statsMap(): Map<string, SkillStats> {
  const now = Date.now();
  if (!cache || now - cacheAt > CACHE_TTL_MS) {
    cache = computeStats();
    cacheAt = now;
  }
  return cache;
}

export function getSkillStats(name: string): SkillStats | undefined {
  return statsMap().get(name);
}

/** Blocked-invocation counters for parole (see isRetired). */
const blockedCounts = new Map<string, number>();
const PAROLE_EVERY = 10;

/** True when the team has thoroughly proven this skill doesn't work. Pure — no side effects. */
export function isRetired(name: string): boolean {
  const s = statsMap().get(name);
  return !!s && s.attempts >= RETIRE_MIN_ATTEMPTS && s.rate < RETIRE_RATE;
}

/**
 * Invocation-gate variant with parole: every 10th blocked invocation lets
 * one attempt through. Without this, a retired skill could never demonstrate
 * that an underlying fix (sandbox improvement, refinement, library update)
 * repaired it — new successes would lift its rate, but it could never earn
 * them. Only call this from the actual invocation path, never from prompt
 * rendering (which would inflate the counter).
 */
export function checkRetiredWithParole(name: string): boolean {
  if (!isRetired(name)) return false;
  const blocked = (blockedCounts.get(name) ?? 0) + 1;
  blockedCounts.set(name, blocked);
  if (blocked % PAROLE_EVERY === 0) {
    console.log(`[Reliability] Parole attempt for retired skill '${name}' (block #${blocked})`);
    cache = null; // pick up the parole attempt's result promptly
    return false;
  }
  return true;
}

/**
 * Order skills for the prompt: proven performers first, untried skills next
 * (exploration), strugglers last, retired excluded.
 */
export function rankSkills(names: string[]): string[] {
  const proven: string[] = [];
  const untried: string[] = [];
  const struggling: string[] = [];
  for (const n of names) {
    if (isRetired(n)) continue;
    const s = getSkillStats(n);
    if (!s || s.attempts < 2) untried.push(n);
    else if (s.rate >= 0.5) proven.push(n);
    else struggling.push(n);
  }
  proven.sort((a, b) => (getSkillStats(b)?.rate ?? 0) - (getSkillStats(a)?.rate ?? 0));
  return [...proven, ...untried, ...struggling];
}

/** "skillName (73% of 11)" — annotation for the strategic prompt. */
export function annotateSkill(name: string): string {
  const s = getSkillStats(name);
  if (!s || s.attempts < 2) return name;
  return `${name} (${Math.round(s.rate * 100)}% of ${s.attempts})`;
}
