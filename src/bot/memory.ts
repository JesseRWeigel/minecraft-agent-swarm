import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface Structure {
  type: "house" | "farm" | "mine" | "furnace" | "other";
  x: number;
  y: number;
  z: number;
  builtAt: string;
  notes?: string;
}

export interface Death {
  location: string;
  x: number;
  y: number;
  z: number;
  cause: string;
  timestamp: string;
  /** Which dimension the death happened in; routes only price same-dimension spots. */
  dim?: string;
}

export interface OreDiscovery {
  type: string;
  x: number;
  y: number;
  z: number;
  timestamp: string;
}

export interface SkillAttempt {
  skill: string;
  success: boolean;
  durationSeconds: number;
  notes: string;
  timestamp: string;
}

export interface BotMemory {
  structures: Structure[];
  deaths: Death[];
  oreDiscoveries: OreDiscovery[];
  skillHistory: SkillAttempt[];
  lessons: string[];
  lastUpdated: string;
  /** Persistent set of skills confirmed broken (5+ failures with 0% success rate). Never cleared by rolling window. */
  brokenSkillNames: string[];
  seasonGoal?: string;
}

const defaultMemory: BotMemory = {
  structures: [],
  deaths: [],
  oreDiscoveries: [],
  skillHistory: [],
  lessons: [],
  lastUpdated: new Date().toISOString(),
  brokenSkillNames: [],
  seasonGoal: undefined,
};

/**
 * A skill that THREW is a broken skill, whatever the exception happened to say.
 *
 * dynamic-loader returns `<name> failed: <err.message>` only from its catch
 * branch; a precondition is a clean early return, not an exception. Without
 * this override, "Cannot find" — added so Voyager's mineBlock is not retired
 * for ore simply not being nearby — also swallowed
 * "craftChest failed: Cannot find crafting_table nearby". Every one of
 * craftChest's 85 consecutive failures was therefore excluded from its own
 * statistics, its attempt count stayed 0, isRetired never fired, and the swarm
 * re-invoked a skill with a 0% success rate indefinitely. Measured 2026-08-14.
 */
// "X failed: ..." (action results) and "Crashed: ..." (executor.ts's note for
// a thrown exception). The second form slipped through — an exception whose
// text happened to contain a precondition keyword classified as environment.
const CRASHED = /^\s*\S+ failed:|^\s*crashed:/i;

export function isSkillCrash(notes: string): boolean {
  return CRASHED.test(notes || "");
}

/**
 * Was this failure the environment's fault rather than the skill's?
 *
 * A crash always counts against the skill, even when the exception text
 * contains a precondition phrase. Single source of truth for both the
 * per-bot broken-skill list here and the team-wide retirement stats in
 * skills/reliability.ts, which had drifted into two copies of this rule.
 */
/**
 * The resumable-run protocol. A skill that banks progress and hands the run
 * back ends its message with "…again to continue" / "…retry to continue";
 * actions.ts grants those continuations automatically. The reliability layer
 * must honor the SAME protocol: build_nether_portal re-retired itself on its
 * own honest "Walking to lava — still 19 blocks away" hand-backs, and the
 * gate then blocked forty invocations from a fully kitted bot. This is a
 * structural marker shared with the auto-continue loop — the fourth round of
 * failure-keyword whack-a-mole is the wrong tool (see PRECONDITION_KEYWORDS
 * history).
 */
export const RESUMABLE_PROTOCOL = /again to continue|retry to continue/i;

export function isPreconditionFailure(notes: string): boolean {
  if (isSkillCrash(notes)) return false;
  if (RESUMABLE_PROTOCOL.test(notes || "")) return true;
  const lower = (notes || "").toLowerCase();
  return PRECONDITION_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
}

export const PRECONDITION_KEYWORDS = [
  "No trees found",
  "need wood",
  "Need a pickaxe",
  "No torches",
  "Couldn't plant",
  "aborted",
  "No crafting_table",
  "No furnace",
  "Need more",
  "not enough",
  "missing materials",
  // build_nether_portal invoked where the world has no lava nearby — the
  // same environment shortage as "No trees found". Seven of these plus three
  // long-fixed crashes were the entire 0/10 that kept the skill retired
  // while a kitted bot stood 19 blocks from a pool.
  "No lava source within",
  // build_farm environment failures (not skill bugs — just wrong location)
  "No water found",
  "No tillable dirt",
  "No seeds from grass",
  "Can't craft a hoe",
  "chunk may not be loaded",
  // voyager mineBlock / exploreUntil: resource not nearby (precondition, not bug)
  "Cannot find",
  "Could not find",
  // smelt_ores when inventory has no ore / no fuel (environment, not bug —
  // analogous to "No water found" for build_farm). Without "No fuel" excluded,
  // a working smelt skill gets retired during the team's fuel droughts, which
  // then permanently blocks the iron loop once ore IS available.
  "Nothing to smelt",
  "No fuel",
  // craft_gear with an empty inventory (environment, not bug)
  "No new tools crafted",
  "get materials first",
  // Any "missing <item>" refusal is an inventory shortage, not a code bug.
  // build_nether_portal was retired at 0/9 when every one of those failures
  // was "Not ready for a portal: missing flint_and_steel" — the smelt_ores
  // fuel-drought story again, one skill later. "missing materials" above was
  // too narrow; the phrasing that actually occurs is "missing flint_and_steel",
  // "Still missing bucket", "Missing: pickaxe". Crashes are exempt regardless
  // (isSkillCrash is checked first), so a stack trace mentioning "missing"
  // still counts as real.
  "missing",
  "Not ready",
  // build_nether_portal environment/progress reports. "No clear 4x5 space" is
  // a location problem; a stalled or unfinished frame is banked PARTIAL
  // progress (the site persists and the next run continues it). Neither says
  // the skill is broken, and both re-retired it a day after the flint
  // shortage did — the stats recompute from stored notes, so adding the
  // phrasings here heals the historical record too.
  "No clear",
  "Portal stalled",
  "Frame unfinished",
  // "timed out" removed — combat/mining skills that time out are real failures,
  // not precondition failures. exploreUntil timeouts use "aborted" instead.
];

export class BotMemoryStore {
  private memory: BotMemory;
  private memoryFile: string;

  constructor(memoryFileName = "memory.json") {
    this.memoryFile = path.join(__dirname, "../../", memoryFileName);
    this.memory = { ...defaultMemory };
  }

  // Static skills are TypeScript source files that developers can fix.
  // They should NOT be permanently blacklisted — clear them from brokenSkillNames
  // on every load so a fixed version gets a fresh chance each session.
  // Dynamic/Voyager skills have no developer fix path, so they stay permanently blocked.
  private static readonly STATIC_SKILL_NAMES = new Set([
    "build_house",
    "craft_gear",
    "light_area",
    "build_farm",
    "strip_mine",
    "smelt_ores",
    "go_fishing",
    "build_bridge",
    "hunt_food",
    "escape_to_surface",
    "hunt_string",
    // Run 689: bucket_fish, a hand-written skill added that day, was marked
    // "permanently broken" after five outings. Every registered snake_case
    // skill belongs here; generated skills are camelCase.
    "bucket_fish",
    "breed_animals",
    "build_nether_portal",
    "find_fortress",
    "harvest_honey",
    "hunt_leather",
    "loot_bastion",
    "mine_frontier",
    "oh_shiny",
    "return_from_nether",
    "setup_enchanting",
    "setup_stash",
    "shoot_arrow",
    "tame_animal",
    "trade_with_villager",
    "wax_copper",
    "wax_off",
    "craft_bucket",
    "craft_flint_and_steel",
    "fill_bucket",
  ]);

  load(): BotMemory {
    try {
      if (fs.existsSync(this.memoryFile)) {
        const data = fs.readFileSync(this.memoryFile, "utf-8");
        this.memory = JSON.parse(data);
        if (!this.memory.brokenSkillNames) this.memory.brokenSkillNames = [];

        // Startup heal: remove static skills from brokenSkillNames so a fixed
        // version of the skill can be tried again. If still broken, it will
        // re-accumulate failures and be re-added within the session.
        const before = this.memory.brokenSkillNames.length;
        this.memory.brokenSkillNames = this.memory.brokenSkillNames.filter(
          (s) => !BotMemoryStore.STATIC_SKILL_NAMES.has(s),
        );
        const healed = before - this.memory.brokenSkillNames.length;

        console.log(
          `[Memory] Loaded from ${path.basename(this.memoryFile)}: ${this.memory.structures.length} structures, ${this.memory.skillHistory.length} skill attempts, ${this.memory.brokenSkillNames.length} known broken skills${healed > 0 ? ` (healed ${healed} static skills)` : ""}`,
        );
      }
    } catch (err) {
      console.error("[Memory] Failed to load:", err);
      this.memory = { ...defaultMemory };
    }
    return this.memory;
  }

  private save() {
    try {
      this.memory.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.memoryFile, JSON.stringify(this.memory, null, 2));
    } catch (err) {
      console.error("[Memory] Failed to save:", err);
    }
  }

  addStructure(type: Structure["type"], x: number, y: number, z: number, notes?: string): boolean {
    const existing = this.memory.structures.find(
      (s) => s.type === type && Math.abs(s.x - x) < 10 && Math.abs(s.z - z) < 10,
    );
    if (existing) {
      // Upgrade the record (e.g. "Oak House (partial)" → "Oak House" once
      // a resumed build completes) instead of silently keeping stale notes.
      if (notes && existing.notes !== notes) {
        existing.notes = notes;
        this.save();
        console.log(`[Memory] Structure at ${existing.x}, ${existing.y}, ${existing.z} updated: ${notes}`);
      } else {
        console.log(`[Memory] Structure already exists nearby at ${existing.x}, ${existing.y}, ${existing.z}`);
      }
      return false;
    }
    this.memory.structures.push({
      type,
      x: Math.round(x),
      y: Math.round(y),
      z: Math.round(z),
      builtAt: new Date().toISOString(),
      notes,
    });
    console.log(`[Memory] Added ${type} at ${x}, ${y}, ${z}. Total: ${this.memory.structures.length}`);
    this.save();
    return true;
  }

  hasStructureNearby(type: Structure["type"], x: number, y: number, z: number, radius = 50): boolean {
    return this.memory.structures.some(
      (s) => s.type === type && Math.abs(s.x - x) <= radius && Math.abs(s.z - z) <= radius,
    );
  }

  getNearestStructure(type: Structure["type"], x: number, z: number): Structure | null {
    let nearest: Structure | null = null;
    let minDist = Infinity;
    for (const s of this.memory.structures) {
      if (s.type === type) {
        const dist = Math.sqrt((s.x - x) ** 2 + (s.z - z) ** 2);
        if (dist < minDist) {
          minDist = dist;
          nearest = s;
        }
      }
    }
    return nearest;
  }

  recordDeath(x: number, y: number, z: number, cause: string, dim?: string): void {
    this.memory.deaths.push({
      location: `${x}, ${y}, ${z}`,
      x: Math.round(x),
      y: Math.round(y),
      z: Math.round(z),
      cause,
      // Run 719: the Nether and the Overworld share one coordinate space in
      // this file, so a lava death at Nether (143, 30, -46) also priced the
      // Overworld block of the same name, and every overworld drowning
      // priced the Nether. Routes are filtered on this.
      dim: dim ? (dim.includes("nether") ? "nether" : dim.includes("end") ? "end" : "overworld") : undefined,
      timestamp: new Date().toISOString(),
    });
    if (this.memory.deaths.length > 50) {
      this.memory.deaths = this.memory.deaths.slice(-50);
    }
    console.log(`[Memory] Recorded death at ${x}, ${y}, ${z} (cause: ${cause})`);
    this.save();
  }

  /** Nearest remembered ore of a type (name contains `match`) within `radius`
   *  blocks on the XZ plane, or null. */
  getNearestOre(match: string, x: number, z: number, radius = 200): OreDiscovery | null {
    let best: OreDiscovery | null = null;
    let bestDist = radius;
    for (const o of this.memory.oreDiscoveries) {
      if (!o.type.includes(match)) continue;
      const dist = Math.hypot(o.x - x, o.z - z);
      if (dist < bestDist) {
        bestDist = dist;
        best = o;
      }
    }
    return best;
  }

  /** Drop remembered ore of a type within `radius` blocks of a point: the
   *  vein was dug out or was never there. Returns how many were dropped. */
  forgetOreNear(match: string, x: number, z: number, radius = 16): number {
    const before = this.memory.oreDiscoveries.length;
    this.memory.oreDiscoveries = this.memory.oreDiscoveries.filter(
      (o) => !(o.type.includes(match) && Math.hypot(o.x - x, o.z - z) <= radius),
    );
    const dropped = before - this.memory.oreDiscoveries.length;
    if (dropped > 0) this.save();
    return dropped;
  }

  recordOre(oreType: string, x: number, y: number, z: number): void {
    const existing = this.memory.oreDiscoveries.find(
      (o) => o.type === oreType && Math.abs(o.x - x) < 5 && Math.abs(o.z - z) < 5,
    );
    if (existing) return;
    this.memory.oreDiscoveries.push({
      type: oreType,
      x: Math.round(x),
      y: Math.round(y),
      z: Math.round(z),
      timestamp: new Date().toISOString(),
    });
    console.log(`[Memory] Discovered ${oreType} at ${x}, ${y}, ${z}`);
    this.save();
  }

  recordSkillAttempt(skill: string, success: boolean, durationSeconds: number, notes: string): void {
    this.memory.skillHistory.push({ skill, success, durationSeconds, notes, timestamp: new Date().toISOString() });
    if (this.memory.skillHistory.length > 100) {
      this.memory.skillHistory = this.memory.skillHistory.slice(-100);
    }

    const skillAttempts = this.memory.skillHistory.filter((s) => s.skill === skill);
    const successCount = skillAttempts.filter((s) => s.success).length;
    const successRate = skillAttempts.length > 0 ? (successCount / skillAttempts.length) * 100 : 0;

    const isPreconditionFail = !success && isPreconditionFailure(notes);
    const realFailures = skillAttempts.filter((a) => !a.success && !isPreconditionFailure(a.notes || ""));
    // Run 678: hunt_food, go_fishing, build_farm and escape_to_surface were
    // each written into this list mid-run after five bad outings, and the
    // strategic prompt then showed the farmer and the fighter "hunt_food
    // (historically broken)" while they starved. The list exists for
    // generated skills that can be deleted; hand-written skills in
    // STATIC_SKILL_NAMES are fixed in code and never retire here.
    const generated = !BotMemoryStore.STATIC_SKILL_NAMES.has(skill);
    if (
      !success &&
      !isPreconditionFail &&
      generated &&
      realFailures.length >= 5 &&
      !this.memory.brokenSkillNames.includes(skill)
    ) {
      this.memory.brokenSkillNames.push(skill);
      console.log(`[Memory] ${skill} added to permanent broken skills list`);
    }
    // NOTE: we intentionally do NOT auto-remove from brokenSkillNames on success.
    // brokenSkillNames is permanently managed — a skill that was manually added or flagged
    // as broken (e.g., after deletion) stays broken. Fake successes from a buggy old
    // version of a skill must not inadvertently restore it.

    console.log(
      `[Memory] ${skill}: ${success ? "SUCCESS" : "FAIL"} (${successRate.toFixed(0)}% success rate over ${skillAttempts.length} attempts)`,
    );
    this.save();
  }

  getSkillSuccessRate(skill: string): { successRate: number; totalAttempts: number; avgDuration: number } {
    const attempts = this.memory.skillHistory.filter((s) => s.skill === skill);
    if (attempts.length === 0) return { successRate: -1, totalAttempts: 0, avgDuration: 0 };
    const successes = attempts.filter((a) => a.success).length;
    const avgDuration = attempts.reduce((sum, a) => sum + a.durationSeconds, 0) / attempts.length;
    return { successRate: (successes / attempts.length) * 100, totalAttempts: attempts.length, avgDuration };
  }

  addLesson(lesson: string): void {
    this.memory.lessons.push(lesson);
    if (this.memory.lessons.length > 20) {
      this.memory.lessons = this.memory.lessons.slice(-20);
    }
    this.save();
  }

  getMemoryContext(): string {
    const parts: string[] = [];

    // Show last 5 skill actions first — helps LLM detect spin loops and avoid repeating
    if (this.memory.skillHistory.length > 0) {
      const recent = this.memory.skillHistory.slice(-5);
      // Check if the bot is spinning: same skill repeated 3+ times with no-op notes
      const skillNames = recent.map((s) => s.skill);
      const dominant = skillNames.find((s) => skillNames.filter((x) => x === s).length >= 3);
      const spinWarning = dominant
        ? ` ⚠ WARNING: You have called '${dominant}' ${skillNames.filter((x) => x === dominant).length} times in a row — DO SOMETHING DIFFERENT!`
        : "";
      const recentDesc = recent
        .map((s) => {
          const icon = s.success ? "✓" : "✗";
          const note = s.notes.slice(0, 55).replace(/\n/g, " ");
          return `${icon}${s.skill}(${note})`;
        })
        .join(", ");
      parts.push(`LAST ${recent.length} ACTIONS: ${recentDesc}.${spinWarning}`);
    }

    if (this.memory.structures.length > 0) {
      const houses = this.memory.structures.filter((s) => s.type === "house");
      if (houses.length > 0) {
        parts.push(
          `HOUSES BUILT: ${houses.length} at ${houses.map((h) => `(${h.x}, ${h.z})`).join(", ")} — GOAL ACHIEVED, no need to build again`,
        );
      }
    }

    if (this.memory.deaths.length > 0) {
      const recentDeaths = this.memory.deaths.slice(-5);
      parts.push(`RECENT DEATHS: ${recentDeaths.map((d) => `${d.cause} at (${d.x}, ${d.y}, ${d.z})`).join("; ")}`);
    }

    if (this.memory.oreDiscoveries.length > 0) {
      const uniqueOres = [...new Set(this.memory.oreDiscoveries.map((o) => o.type))];
      parts.push(`ORES FOUND: ${uniqueOres.join(", ")}`);
    }

    const brokenSet = new Set(this.memory.brokenSkillNames);
    const skills = [...new Set(this.memory.skillHistory.map((s) => s.skill))];
    if (brokenSet.size > 0 || skills.length > 0) {
      const brokenLabel: string[] = [];
      const preconditionLabel: string[] = [];
      const normalStats: string[] = [];
      for (const skill of brokenSet) {
        brokenLabel.push(`${skill} (historically broken)`);
      }
      for (const skill of skills) {
        if (brokenSet.has(skill)) continue;
        const attempts = this.memory.skillHistory.filter((s) => s.skill === skill);
        const successes = attempts.filter((a) => a.success).length;
        const realFailures = attempts.filter(
          (a) =>
            !a.success && !PRECONDITION_KEYWORDS.some((k) => (a.notes || "").toLowerCase().includes(k.toLowerCase())),
        );
        const preconditionFailures = attempts.filter(
          (a) =>
            !a.success && PRECONDITION_KEYWORDS.some((k) => (a.notes || "").toLowerCase().includes(k.toLowerCase())),
        );
        // Static skills (fixable TypeScript source) should never be shown as permanently broken
        // based on history alone — a bug fix can change everything. Show normal stats for them.
        const isStatic = BotMemoryStore.STATIC_SKILL_NAMES.has(skill);
        if (!isStatic && successes === 0 && realFailures.length >= 2) {
          // No successes, at least 2 genuine failures — truly broken (dynamic skills only)
          brokenLabel.push(`${skill} (failed ${attempts.length}/${attempts.length} times)`);
        } else if (successes === 0 && preconditionFailures.length >= 2 && realFailures.length === 0) {
          // All failures are precondition misses (no trees, no materials, etc.) — skill works, just needs resources
          preconditionLabel.push(`${skill} (needs resources — explore/gather first)`);
        } else {
          const rate = attempts.length > 0 ? ((successes / attempts.length) * 100).toFixed(0) : "0";
          normalStats.push(`${skill}: ${rate}%`);
        }
      }
      if (brokenLabel.length > 0) {
        parts.push(
          `BROKEN SKILLS — DO NOT USE EVER: ${brokenLabel.join(", ")}. These have NEVER succeeded. Choose completely different skills.`,
        );
      }
      if (preconditionLabel.length > 0) {
        parts.push(
          `SKILLS WAITING FOR RESOURCES (these work fine — just need prerequisites): ${preconditionLabel.join(", ")}`,
        );
      }
      if (normalStats.length > 0) {
        parts.push(`SKILL PERFORMANCE: ${normalStats.join(", ")}`);
      }
    }

    if (this.memory.lessons.length > 0) {
      const recentLessons = this.memory.lessons.slice(-3);
      parts.push(`LESSONS LEARNED: ${recentLessons.join("; ")}`);
    }

    return parts.length > 0 ? parts.join(". ") : "No memory yet.";
  }

  getBrokenSkills(): Map<string, string> {
    const broken = new Map<string, string>();
    for (const skill of this.memory.brokenSkillNames) {
      const msg = `Historically broken (0% success) — never use this skill`;
      broken.set(skill, msg);
      broken.set(`skill:${skill}`, msg);
    }
    const skills = [...new Set(this.memory.skillHistory.map((s) => s.skill))];
    for (const skill of skills) {
      if (broken.has(skill)) continue;
      const attempts = this.memory.skillHistory.filter((s) => s.skill === skill);
      const successes = attempts.filter((a) => a.success).length;
      const realFailures = attempts.filter(
        (a) =>
          !a.success && !PRECONDITION_KEYWORDS.some((k) => (a.notes || "").toLowerCase().includes(k.toLowerCase())),
      );
      // Only flag as broken if there are REAL failures (not just precondition misses like "no trees").
      // Static skills (fixable source code) are excluded — historical crashes don't mean unfixable.
      const isStatic = BotMemoryStore.STATIC_SKILL_NAMES.has(skill);
      if (!isStatic && successes === 0 && realFailures.length >= 2) {
        const msg = `Failed ${attempts.length} times (0% success rate) — this skill is broken, never use it`;
        broken.set(skill, msg);
        broken.set(`skill:${skill}`, msg);
      }
    }
    return broken;
  }

  /**
   * Remove skills from brokenSkillNames that are now in the skill registry.
   * Call this after loadDynamicSkills() so newly-created skill files auto-heal
   * any blacklist entries that accumulated before the file existed.
   */
  healBrokenSkillsFromRegistry(registeredNames: Set<string>): void {
    const before = this.memory.brokenSkillNames.length;
    this.memory.brokenSkillNames = this.memory.brokenSkillNames.filter((s) => !registeredNames.has(s));
    const healed = before - this.memory.brokenSkillNames.length;
    if (healed > 0) {
      console.log(
        `[Memory] Auto-healed ${healed} skill(s) now in registry: ${
          this.memory.brokenSkillNames.length === before ? "none" : "saved"
        }`,
      );
      this.save();
    }
  }

  /** Returns only the persistent brokenSkillNames list (for execution-layer gating). */
  getPersistentBrokenSkillNames(): Set<string> {
    return new Set(this.memory.brokenSkillNames);
  }

  /**
   * Returns a map of skill → soft-blacklist message for skills whose last 2+
   * attempts were all precondition failures with a known pattern.
   * Used to pre-populate recentFailures on restart so the bot doesn't re-run
   * the same failing actions immediately after a server disconnect.
   *
   * Only covers patterns that don't self-resolve with time (water proximity,
   * wool count). "No trees found" is intentionally excluded — the bot may have
   * moved to a new forest area since the last session.
   */
  getSkillHistory(): SkillAttempt[] {
    return this.memory.skillHistory;
  }

  getSessionPreconditionBlocks(): Map<string, string> {
    const result = new Map<string, string>();
    const skills = [...new Set(this.memory.skillHistory.map((s) => s.skill))];
    for (const skill of skills) {
      const attempts = this.memory.skillHistory.filter((s) => s.skill === skill);
      const recent = attempts.slice(-3);
      // Only pre-block if the last 2+ attempts were all precondition failures
      if (recent.length < 2) continue;
      const allPrecondition = recent.every(
        (a) => !a.success && PRECONDITION_KEYWORDS.some((k) => a.notes.toLowerCase().includes(k.toLowerCase())),
      );
      if (!allPrecondition) continue;

      const lastNotes = recent[recent.length - 1].notes;
      if (/no water found/i.test(lastNotes)) {
        result.set(skill, "No water found within 96 blocks — explore to find a river or pond, then retry build_farm");
      } else if (/cannot find.*wool|need.*wool/i.test(lastNotes)) {
        result.set(
          skill,
          "Need 3 wool of same color — first EXPLORE to find a sheep flock, then use 'attack' on a sheep mob to get wool",
        );
      } else if (/no torch/i.test(lastNotes)) {
        result.set(skill, "No torches — mine coal_ore first, then craft torches (coal + stick), then retry light_area");
      }
      // "No trees found" excluded — bot may have moved to a new forest area.
    }
    return result;
  }

  /** Recent death records, for the death-trap guard in brain.ts.
   *  shouldAvoidLocation below has existed with zero callers the whole time,
   *  which is why Forge walked back into the same tunnel thirteen times. */
  getDeaths(): { x: number; y: number; z: number; cause?: string; timestamp?: string; dim?: string }[] {
    return this.memory.deaths;
  }

  shouldAvoidLocation(x: number, y: number, z: number, radius = 10): boolean {
    return this.memory.deaths.some((d) => Math.abs(d.x - x) < radius && Math.abs(d.z - z) < radius);
  }

  getStats(): { structures: number; deaths: number; ores: number; skills: number } {
    return {
      structures: this.memory.structures.length,
      deaths: this.memory.deaths.length,
      ores: this.memory.oreDiscoveries.length,
      skills: this.memory.skillHistory.length,
    };
  }

  getSeasonGoal(): string | undefined {
    return this.memory.seasonGoal;
  }

  setSeasonGoal(goal: string): void {
    this.memory.seasonGoal = goal.trim();
    this.save();
    console.log(`[Memory] Season goal set: "${this.memory.seasonGoal}"`);
  }

  clearSeasonGoal(): void {
    this.memory.seasonGoal = undefined;
    this.save();
    console.log("[Memory] Season goal cleared.");
  }
}

// ---------------------------------------------------------------------------
// Backward-compat singleton — used by src/llm/index.ts and any code that
// hasn't been migrated to per-bot BotMemoryStore instances yet.
// createBot in src/bot/index.ts creates its own per-bot store separately.
// ---------------------------------------------------------------------------
const _singleton = new BotMemoryStore("memory.json");

export function loadMemory(): BotMemory {
  return _singleton.load();
}
export function getMemoryContext(): string {
  return _singleton.getMemoryContext();
}
export function recordDeath(x: number, y: number, z: number, cause: string): void {
  _singleton.recordDeath(x, y, z, cause);
}
export function recordOre(oreType: string, x: number, y: number, z: number): void {
  _singleton.recordOre(oreType, x, y, z);
}
export function recordSkillAttempt(skill: string, success: boolean, durationSeconds: number, notes: string): void {
  _singleton.recordSkillAttempt(skill, success, durationSeconds, notes);
}
export function getSkillSuccessRate(skill: string) {
  return _singleton.getSkillSuccessRate(skill);
}
export function addLesson(lesson: string): void {
  _singleton.addLesson(lesson);
}
export function addStructure(type: Structure["type"], x: number, y: number, z: number, notes?: string): boolean {
  return _singleton.addStructure(type, x, y, z, notes);
}
export function hasStructureNearby(type: Structure["type"], x: number, y: number, z: number, radius?: number): boolean {
  return _singleton.hasStructureNearby(type, x, y, z, radius);
}
export function getNearestStructure(type: Structure["type"], x: number, z: number): Structure | null {
  return _singleton.getNearestStructure(type, x, z);
}
export function getBrokenSkills(): Map<string, string> {
  return _singleton.getBrokenSkills();
}
export function shouldAvoidLocation(x: number, y: number, z: number, radius?: number): boolean {
  return _singleton.shouldAvoidLocation(x, y, z, radius);
}
export function getStats() {
  return _singleton.getStats();
}
export function getSeasonGoal(): string | undefined {
  return _singleton.getSeasonGoal();
}
export function setSeasonGoal(goal: string): void {
  _singleton.setSeasonGoal(goal);
}
export function clearSeasonGoal(): void {
  _singleton.clearSeasonGoal();
}
