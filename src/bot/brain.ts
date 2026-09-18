/**
 * Event-driven decision engine — replaces the 500ms polling loop.
 *
 * Instead of asking the LLM every 500ms, the brain listens for game events
 * and routes them to the appropriate handler with a focused prompt:
 *
 * - HOSTILE detected  → reactive prompt (fast model, ~300 tokens)
 * - Damage taken      → reactive prompt
 * - Low health/hunger → reactive prompt
 * - Chat received     → chat response (fast model)
 * - Action completed  → critic check (fast model) → next step or re-plan
 * - Idle timeout      → strategic planning (strong model, ~1200 tokens)
 *
 * This cuts LLM calls from ~120/min/bot to ~6-10/min/bot and lets us use
 * the strong model (32b) for the decisions that matter.
 */

import { randomUUID } from "node:crypto";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { Entity } from "prismarine-entity";
import { config } from "../config.js";
import { BotRoleConfig, FARM_SITE, BOT_ROSTER } from "./role.js";
import { queryStrategic, queryReactive, queryCritic, chatWithLLM, type LLMMessage } from "../llm/index.js";
import type { RoleContext } from "../llm/prompts.js";
import { getWorldContext, isHostile } from "./perception.js";
import { executeAction, FOOD_PRIORITY } from "./actions.js";
import {
  digOutIfStuck,
  escapeWaterIfDrowning,
  headUnderWater,
  safeGoto,
  explorerMoves,
  GoalNearXZAbove,
} from "./navigation.js";
import navPkg from "mineflayer-pathfinder";
const { goals: navGoals } = navPkg;
import { isStallResult, shouldForceDigOut, pruneStalls } from "./stall-rescue.js";
import { isDeathTrap } from "./death-trap.js";
import { classifyResult } from "./action-result.js";
import { freshState, sampleMovement, isStuck } from "./stuck-detector.js";
import { blockDurationFor } from "./block-escalation.js";
import { isAtBase } from "./respawn.js";
import { updateOverlay, addChatMessage, speakThought, setCurrentBot } from "../stream/overlay.js";
import { generateSpeech } from "../stream/tts.js";
import { filterContent, filterChatMessage, filterViewerMessage } from "../safety/filter.js";
import { abortActiveSkill, isSkillRunning, getActiveSkillName, takeSkillOutcome } from "../skills/executor.js";
import { stashCount, ledgerKnown } from "../skills/stash-ledger.js";
import { handsBusy } from "../skills/fluid.js";
import { skillRegistry } from "../skills/registry.js";
import { isBuried } from "../skills/escape-to-surface.js";
import { hasGoldPiece } from "../skills/piglin-gold.js";
import { nearestNest } from "../skills/wax-copper.js";
import { knownWaxedBlocks } from "./nests.js";
import { nearestFoodAnimal } from "../skills/hunt-food.js";
import { BotMemoryStore } from "./memory.js";

/** Rim blocks a right-click activates instead of placing against (run 674:
 *  every bot spent an hour trying to cap a shaft whose first solid rim block
 *  was a furnace, and the click opened the furnace instead). */
const INTERACTIVE_RIM =
  /chest|furnace|smoker|crafting_table|barrel|door|trapdoor|bed|anvil|shulker|hopper|dispenser|dropper|lectern|loom|stonecutter|grindstone|cartography|smithing|brewing|beacon|enchanting|button|lever|fence_gate|note_block|jukebox|composter|cauldron|campfire|sign|repeater|comparator/;

/** Holes whose cap failed, shared by every bot in the process, so a hole that
 *  refuses a cap is left alone for an hour after two failures. */
const capFailures = new Map<string, { n: number; at: number }>();

/** Exactly what the eat action will consume. */
const EDIBLE = new Set<string>(FOOD_PRIORITY);
import { getAllMemoryStores } from "./memory-registry.js";
import { updateBulletin, formatTeamBulletin } from "./bulletin.js";
import { createLogger } from "../util/logger.js";
import { recordAction, recordSkillResult, checkInventoryMilestones } from "./scoreboard.js";
import { getTechTreeLine } from "./curriculum.js";
import { advancementLine } from "./advancement-line.js";
import { readTeamEarned } from "./advancement-progress.js";
import { recordTrajectory, type TrajectoryModelMetadata } from "./trajectory.js";
import {
  appendEpisodeEvent,
  currentCollectionContext,
  currentEpisodeId,
  type ActionOutcome,
  type ActionStatus,
} from "../data/episode-events.js";
import type { ProviderResponseMetadata } from "../llm/provider.js";
import { captureActionObservation } from "../data/action-observation.js";

export interface ChatMessage {
  source: "minecraft" | "twitch" | "youtube";
  username: string;
  message: string;
  timestamp: number;
}

export interface DecisionMetadata {
  requestId: string | null;
  origin: "provider" | "local_fallback" | "deterministic";
  provider?: ProviderResponseMetadata;
}

export interface BrainDecision {
  thought: string;
  action: string;
  params: Record<string, any>;
  goal?: string;
  goalSteps?: number;
  metadata?: DecisionMetadata;
}
interface ActionCapture {
  actionId: string;
  requestId: string | null;
  episodeId: string;
  botId: string;
  startPayloadRef: string;
  beforeObservationRef: string;
  observationTelemetryComplete: boolean;
  interruptionGeneration: number;
  outcome?: ActionOutcome;
}
function trajectoryModelMetadata(decision: BrainDecision): TrajectoryModelMetadata {
  const provider = decision.metadata?.provider;
  return {
    origin: decision.metadata?.origin ?? "deterministic",
    provider: provider?.provider ?? null,
    model: provider?.model ?? null,
    providerModel: provider?.providerModel ?? null,
    providerRequestId: provider?.providerRequestId ?? null,
    durationMs: provider?.durationMs ?? null,
    usage: provider?.usage ?? {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
    },
  };
}
export interface BrainEvents {
  onThought: (thought: string) => void;
  onAction: (action: string, result: string) => void;
  onChat: (message: string) => void;
}

// ─── Event types ────────────────────────────────────────────────────────────

type EventType = "strategic" | "reactive" | "chat" | "critic";

interface BrainEvent {
  type: EventType;
  priority: number; // Lower = higher priority (0 = most urgent)
  data?: any;
  timestamp: number;
}

// ─── Brain ──────────────────────────────────────────────────────────────────

export class BotBrain {
  private bot: Bot;
  private roleConfig: BotRoleConfig;
  private events: BrainEvents;
  private memStore: BotMemoryStore;
  private log;
  /** Injectable seams keep outcome/cancellation tests local and provider-free. */
  private actionExecutor = executeAction;
  private speechGenerator = generateSpeech;
  private overlayUpdater = updateOverlay;
  private skillOutcomeReader = takeSkillOutcome;
  private interruptionGeneration = 0;
  private interruptionHistory: Array<{ generation: number; reason: string }> = [];

  // Processing state
  private processing = false;
  private stopped = false;
  private paused = false;
  private rescuingFromWater = false;
  private eventQueue: BrainEvent[] = [];

  // Timers
  private idleTimer: NodeJS.Timeout | null = null;
  private hostileScanner: NodeJS.Timeout | null = null;
  private overlayInterval: NodeJS.Timeout | null = null;

  // Decision state (migrated from the old decide() function)
  private currentGoal = "";
  private activeAction = "";
  private goalStepsLeft = 0;
  private lastAction = "";
  private lastResultSig = "";
  private sameResultCount = 0;
  private lastResult = "";
  private lastActionWasSuccess = false;
  private repeatCount = 0;
  private recentHistory: LLMMessage[] = [];
  private pendingChatMessages: ChatMessage[] = [];

  // Failure tracking
  private recentFailures = new Map<string, string>();
  // recentFailures entries EXPIRE. They used to live forever, and a blocked
  // action can never run again to clear itself — so over a long run the
  // blacklist saturated (eat/explore/go_to/mine_block all blocked) and all 5
  // bots stood frozen churning "Blocked:" x357/15min at hour ~20 of run 118.
  // Transient failures (no path, no food HERE, no mobs NOW) age out fast; the
  // world changes. Structural blocks (wrong-role action, retired skill,
  // hallucinated name) persist long.
  private failureExpiry = new Map<string, number>();
  private recentStalls: number[] = [];
  private static readonly FAILURE_TTL_TRANSIENT_MS = 120_000;
  private static readonly FAILURE_TTL_STRUCTURAL_MS = 3_600_000;

  /** How many times each key has been blocked, so repeat offenders escalate. */
  private readonly blockCounts = new Map<string, number>();

  /**
   * Suppress an action. With no explicit ttlMs the window ESCALATES with the
   * number of prior blocks, so a skill that can never succeed stops cycling
   * back every two minutes. See block-escalation.ts for why.
   */
  private blockAction(key: string, msg: string, ttlMs?: number): void {
    const times = (this.blockCounts.get(key) ?? 0) + 1;
    this.blockCounts.set(key, times);
    this.recentFailures.set(key, msg);
    this.failureExpiry.set(key, Date.now() + (ttlMs ?? blockDurationFor(times)));
  }

  /** An action that works again earns back a clean slate. */
  private clearBlockHistory(key: string): void {
    this.blockCounts.delete(key);
  }

  private purgeExpiredFailures(): void {
    const now = Date.now();
    for (const [k, exp] of this.failureExpiry.entries()) {
      if (now > exp) {
        this.failureExpiry.delete(k);
        this.recentFailures.delete(k);
        this.failureCounts.delete(k);
      }
    }
  }
  private failureCounts = new Map<string, number>();
  private successesSinceLastExpiry = 0;

  // Leash
  private homePos: { x: number; y: number; z: number } | null;

  // Farm override cooldown — a fast-failing skill must not thrash every cycle
  private lastFarmOverrideMs = 0;
  private lastIronOverrideMs = 0;
  private lastGearOverrideMs = 0;
  private lastLightOverrideMs = 0;
  private lastSmeltOverrideMs = 0;
  private lastPortalOverrideMs = 0;
  private lastEnchantOverrideMs = 0;
  private lastBreedOverrideMs = 0;
  private lastFishOverrideMs = 0;
  private lastHuntFoodOverrideMs = 0;
  private lastStashFoodMs = 0;
  private lastHealEatMs = 0;
  private lastBankGroceriesMs = 0;
  /** Edible items aboard, pantry sense (run 599: Forge died mining with 37 potatoes). */
  private pantryAboard(): number {
    const re =
      /(^bread$|^potato$|baked_potato|^cooked_|^beef$|^porkchop$|^mutton$|^chicken$|^rabbit$|^cod$|^salmon$|^apple$|^carrot$)/;
    return this.bot.inventory
      .items()
      .filter((i) => re.test(i.name))
      .reduce((n, i) => n + i.count, 0);
  }
  private pantryBanked(stashY: number): number {
    const names = [
      "bread",
      "baked_potato",
      "potato",
      "carrot",
      "apple",
      "cooked_beef",
      "cooked_porkchop",
      "cooked_mutton",
      "cooked_chicken",
      "cooked_cod",
      "cooked_salmon",
      "beef",
      "porkchop",
      "mutton",
      "chicken",
      "cod",
      "salmon",
    ];
    return names.reduce((n, k) => n + stashCount(k, stashY), 0);
  }
  private lastWaxOffMs = 0;
  private lastHoneyMs = 0;
  private lastToolReturnMs = 0;
  private lastLeatherHuntMs = 0;
  private lastBedPrepMs = 0;
  private lastTameMs = 0;
  private lastStringHuntMs = 0;
  private lastAimMs = 0;
  private lastShinyMs = 0;
  private bedClaimed = false;

  /** Forget the claimed bed so the village bed-claim reflex runs again (the lethal-respawn handler broke the old one). */
  resetBedClaim(): void {
    this.bedClaimed = false;
  }
  private lastBedClaimMs = 0;
  /** When the server last refused a sleep (monsters nearby), so the night reflex backs off. */
  private lastSleepRefusedMs = 0;
  private lastGoldBankMs = 0;
  private lastFortressMs = 0;
  private lastPortalRelightMs = 0;
  private lastNetherReturnMs = 0;
  private lastBiomeRoamMs = 0;
  private biomeRoamIdx = 0;
  private lastTradeMs = 0;

  /**
   * The What a Deal trip is ready: unearned, cooled, daytime, near the stash,
   * with coal aboard or in the stash band. The mining overrides ahead of it in
   * the chain yield when this is true. Run 578: Forge stood beside the stash
   * with 2,882 coal banked and spent the hour on the frontier ferry and four
   * strip-mine runs; the trade override never got a turn.
   */
  private tradeReady(): boolean {
    if (!this.roleConfig.allowedSkills.includes("trade_with_villager")) return false;
    const sp = this.roleConfig.stashPos;
    if (!sp) return false;
    const earned = readTeamEarned(BOT_ROSTER.map((b) => b.name));
    const tradeDone = earned.has("adventure/trade") || earned.has("minecraft:adventure/trade");
    // After What a Deal the trip still pays: an emerald buys six bread. A
    // bread run fires when an emerald is aboard or banked and food is low.
    const emeralds =
      this.bot.inventory
        .items()
        .filter((i) => i.name === "emerald")
        .reduce((n, i) => n + i.count, 0) + (ledgerKnown() ? stashCount("emerald", sp.y) : 0);
    const breadRun = emeralds >= 1 && this.bot.food < 10;
    // Run 592: the last emerald went to a cleric for redstone and no trip
    // ran in run 593 while three bots sat at 0 hunger. The village fields
    // feed the trip on their own (potato fallback, run 591 reached them),
    // so a hungry bot goes without an emerald too.
    // Run 599: the pantry emptied within ten minutes of the first courier
    // trip (Atlas took 5 potatoes, Flora the last chicken) and four bots sat
    // at 0 hunger while Forge, fed, went mining. The trip also runs for the
    // team when the stash holds fewer than 8 edible items.
    const foodRun = this.bot.food < 10 || (ledgerKnown() && this.pantryBanked(sp.y) < 8);
    if (tradeDone && !breadRun && !foodRun) return false;
    if (Date.now() - this.lastTradeMs < 1_800_000) return false;
    if ((this.bot.time?.timeOfDay ?? 0) >= 9000) return false;
    if (Math.hypot(this.bot.entity.position.x - sp.x, this.bot.entity.position.z - sp.z) >= 40) return false;
    // Run 596: the trip fired with Forge 47 blocks under the stash in a
    // flooded cave (the XZ test alone said "near"), and every leg stalled
    // at (309, 24, -325) for the whole trip while his hunger fell to 3.
    // The march starts on the surface or not at all.
    if (this.bot.entity.position.y < sp.y - 8) return false;
    // Run 603: a pickless Forge marched into a roofed hill pocket at
    // (584, 70, -467), 43 blocks short, and every leg said "No path" for
    // the rest of the trip: the march digs, and a bare hand cannot. The
    // strip_mine re-arm runs first when no pickaxe is aboard.
    if (!this.bot.inventory.items().some((i) => i.name.endsWith("_pickaxe"))) return false;
    const coal = this.bot.inventory
      .items()
      .filter((i) => i.name === "coal")
      .reduce((n, i) => n + i.count, 0);
    return coal >= 15 || (ledgerKnown() && stashCount("coal", sp.y) >= 16);
  }
  private lastBastionMs = 0;
  private lastArmorCraftMs = 0;
  private lastPickCraftMs = 0;
  private lastFrontierMs = 0;
  private lastWaxMs = 0;
  /** Until when a known nest is refilling near Forge: hold him there instead of sending him mining. */
  private waxWaitingUntil = 0;
  /**
   * Hold the mining reflexes while a wax is pending: either a nest is
   * refilling nearby (20-min window set from the skill's result), or the
   * whole kit is in hand. Forge carried the block and shears past a full
   * nest and got sent 66 blocks underground by strip_mine between attempts.
   */
  private waxWaiting(): boolean {
    if (Date.now() < this.waxWaitingUntil) return true;
    if (this.bot.username !== "Forge" || !this.roleConfig.allowedSkills.includes("wax_copper")) return false;
    const names = new Set(this.bot.inventory.items().map((i) => i.name));
    if (!names.has("copper_block") || !names.has("shears")) return false;
    const earned = readTeamEarned(BOT_ROSTER.map((b) => b.name));
    return !(earned.has("husbandry/wax_on") || earned.has("minecraft:husbandry/wax_on"));
  }
  private lastPocketShedMs = 0;
  private lastWalkHomeMs = 0;
  private lastEscapeMs = 0;

  // Chat dedup — the 8B anchors on its own last thought and re-sends the
  // same demand every strategic cycle ("Give me the logs!" x7 in 2 min)
  private lastChatSent = "";
  private lastChatSentMs = 0;

  // Cooldowns — prevent spamming the same event type
  private lastReactiveMs = 0;
  private lastStrategicMs = 0;
  private lastHostileSeen = "";

  // Configuration
  private IDLE_INTERVAL_MS: number;
  private HOSTILE_CHECK_MS = 2000;
  private REACTIVE_COOLDOWN_MS = 3000;
  private STRATEGIC_COOLDOWN_MS = 8000;
  private CRITIC_ENABLED = true;

  constructor(bot: Bot, roleConfig: BotRoleConfig, events: BrainEvents, memStore: BotMemoryStore) {
    this.bot = bot;
    this.roleConfig = roleConfig;
    this.events = events;
    this.memStore = memStore;
    this.log = createLogger(roleConfig.name);
    this.homePos = roleConfig.homePos ?? null;
    this.IDLE_INTERVAL_MS = config.bot.idleIntervalMs ?? 10_000;

    // Pre-populate failure blacklist from memory
    for (const [skill, msg] of memStore.getSessionPreconditionBlocks()) {
      this.blockAction(`skill:${skill}`, msg, BotBrain.FAILURE_TTL_STRUCTURAL_MS);
    }
    if (this.recentFailures.size > 0) {
      this.log.debug("Brain", `Pre-populated ${this.recentFailures.size} blacklist entries from memory`);
    }
  }

  /**
   * Auto-equip the best armor the bot is carrying. Bots had no behavior to
   * WEAR armor, so bootstrapped/crafted iron armor sat unworn in inventory
   * while they fought unprotected and died. Runs periodically; idempotent.
   */
  private async equipBestArmor(): Promise<void> {
    // NOT skill-gated: the old isSkillRunning guard meant a bot in a
    // near-continuous skill chain (Atlas in find_fortress) could never run
    // the equip pass, leaving crafted armor unworn indefinitely. Equipping is
    // a benign window click that does not disturb pathfinding, so armor goes
    // on whenever it is owned, mid-skill or not. (Confirmed working: Forge
    // wears diamond, Atlas wears his diamond boots.)
    const TIER = ["netherite", "diamond", "iron", "chainmail", "golden", "leather"];
    const slots: [string, string, number][] = [
      ["head", "_helmet", 5],
      ["torso", "_chestplate", 6],
      ["legs", "_leggings", 7],
      ["feet", "_boots", 8],
    ];
    // (The old "attempting equip" diagnostic is gone: it fired every cycle
    // even when the armor was already WORN — inventory.items() includes the
    // armor slots — producing thousands of noise lines. The "equipped" /
    // "equip FAILED" lines below are the real signals, and they confirmed the
    // system works: Atlas, Forge, and Flora all equipped iron chestplates.)
    for (const [dest, suffix, slotIdx] of slots) {
      const cands = this.bot.inventory.items().filter((i) => i.name.endsWith(suffix));
      if (!cands.length) continue;
      cands.sort((a, b) => {
        const ta = TIER.findIndex((t) => a.name.includes(t));
        const tb = TIER.findIndex((t) => b.name.includes(t));
        return (ta < 0 ? 99 : ta) - (tb < 0 ? 99 : tb);
      });
      const best = cands[0];
      const worn = this.bot.inventory.slots[slotIdx];
      // Compare TIERS, not names: inventory.items() excludes worn armor, so a
      // bot wearing iron while carrying a leather spare sees best=leather,
      // fails the name check, and swaps — then swaps back next cycle. Flora
      // flip-flopped iron<->leather helmets 149 times in an hour this way.
      // Only equip when the carried candidate strictly beats what's worn.
      const tierOf = (n: string) => {
        const t = TIER.findIndex((tier) => n.includes(tier));
        return t < 0 ? 99 : t;
      };
      if (worn && tierOf(worn.name) <= tierOf(best.name)) continue; // worn is same or better
      try {
        await this.bot.equip(best, dest as any);
        this.log.info("Armor", `equipped ${best.name}`);
      } catch (e: any) {
        this.log.warn("Armor", `equip ${best.name} FAILED: ${e?.message || e}`);
      }
    }
  }

  /**
   * How many of the four armor slots (helmet/chest/legs/boots, inventory slots
   * 5-8) currently hold a piece. Nether expeditions gate on this: a naked bot
   * dies to the first piglin, so throwing it at the bastion or a fortress is
   * pure death tax (Mason logged 8 deaths and 0 loot in one run doing exactly
   * that). Zero means do not depart.
   */
  private wornArmorCount(): number {
    return [5, 6, 7, 8].filter((i) => this.bot.inventory.slots[i]).length;
  }

  /** Start the event-driven brain. Call after spawn safety completes. */
  start(): void {
    this.log.info("Brain", `Starting (idle interval: ${this.IDLE_INTERVAL_MS}ms)`);

    // 1. Idle timer — triggers strategic planning when nothing else is happening
    this.resetIdleTimer();

    // 0. Auto-equip armor on spawn and every 20s thereafter
    this.equipBestArmor().catch((e) => this.log.warn("Armor", `equipBestArmor threw: ${e?.message || e}`));
    const armorTimer = setInterval(() => {
      if (!this.paused)
        this.equipBestArmor().catch((e) => this.log.warn("Armor", `equipBestArmor threw: ${e?.message || e}`));
    }, 20_000);
    armorTimer.unref?.();

    // 0a. Ghast-fireball deflect — a FAST tick handler, not a brain override.
    // The old override was gated on !isSkillRunning and the fortress hunters
    // are perpetually mid-skill, so it fired ZERO times while ghasts killed
    // them — same trap the armor equip fell into. A fireball also moves too
    // fast for the strategic/reactive cadence. This 200ms loop runs
    // regardless of skill state: when a ghast fireball is within reach and
    // return_to_sender is unearned, it looks at the shot and swings, batting
    // it back along its vector into the ghast that fired it.
    const deflectTimer = setInterval(() => {
      if (this.paused) return;
      try {
        const earned = readTeamEarned(BOT_ROSTER.map((b) => b.name));
        if (earned.has("nether/return_to_sender") || earned.has("minecraft:nether/return_to_sender")) return;
        const fb = this.bot.nearestEntity(
          (e) => e.name === "fireball" && this.bot.entity.position.distanceTo(e.position) < 9,
        );
        if (!fb) return;
        // AIM AT THE GHAST, not the fireball: a batted fireball flies where
        // the player is LOOKING at the moment of the hit, so to send it back
        // the bot must face the ghast that fired it. 8 swings last hour all
        // looked at the fireball itself and none returned to sender. Fall
        // back to the fireball's own position when no ghast is in view (its
        // incoming line still points roughly homeward).
        const ghast = this.bot.nearestEntity((e) => e.name === "ghast");
        const aimAt = ghast ? ghast.position.offset(0, 0, 0) : fb.position;
        void this.bot.lookAt(aimAt, true).then(() => {
          try {
            this.bot.attack(fb);
            this.log.info(
              "Deflect",
              `swung at a fireball ${this.bot.entity.position.distanceTo(fb.position).toFixed(1)} away, aiming at ${ghast ? "the ghast" : "its incoming line"}`,
            );
          } catch {
            /* missed the window */
          }
        });
      } catch {
        /* entity vanished mid-check */
      }
    }, 200);
    deflectTimer.unref?.();

    // 0b. Self-unstick: if boxed into a hole, dig out (own hands, not a TP).
    //
    // This used to be gated on `!this.processing`, which disabled it exactly
    // when it was needed. A bot trapped in a FAILING ACTION LOOP is never idle:
    // Forge spent 1,181 consecutive deposit attempts stuck 18 blocks from the
    // stash, every one logging "moved 0 on first goto", and the rescue could not
    // run because the brain was always mid-action. 3,512 log lines from one bot
    // going nowhere.
    //
    // Same defect as the drowning rescue that swam at a stone ceiling: the
    // mechanism was fine, its precondition was wrong. The drown timer already
    // solved this correctly by overriding mid-action when air is critical.
    //
    // Key on real immobility instead of perceived idleness. A skill that
    // legitimately stays put (strip_mine digging down) still moves, so this does
    // not fight normal work.
    const STUCK_MS = 90_000;
    let stuckState = freshState(this.bot.entity?.position ?? { x: 0, y: 0, z: 0 }, Date.now());

    const unstickTimer = setInterval(() => {
      if (this.paused) return;
      const pos = this.bot.entity?.position;
      if (!pos) return;

      // Compare against the PREVIOUS SAMPLE, not a stale anchor. The old rule
      // only advanced its reference on a >2-block jump, so a bot mining a vein
      // or smelting at a furnace looked motionless and was dug out mid-action
      // every 90s — 892 times across the swarm in one 5.5h session.
      stuckState = sampleMovement(stuckState, pos, Date.now());
      const stuck = isStuck(stuckState, Date.now(), STUCK_MS);
      const idle = !this.processing && !isSkillRunning(this.bot);

      // Idle bots get the original gentle treatment; genuinely immobile ones get
      // rescued whatever they believe they are doing.
      if (idle || stuck) {
        if (stuck) {
          const stuckFor = Date.now() - stuckState.lastMoveAt;
          console.log(
            `[Unstick] ${this.roleConfig.name} has not moved in ${Math.round(stuckFor / 1000)}s — digging out mid-action`,
          );
          stuckState = freshState(pos, Date.now()); // don't re-fire while it works
        }
        digOutIfStuck(this.bot).catch(() => {});
      }
    }, 25_000);
    unstickTimer.unref?.();

    // 0c. Anti-drown: ~90% of all deaths were bots drowning in the stash water
    // pit. Drowning kills in ~15s, so check often and swim out even mid-action
    // (this overrides whatever the bot is doing — staying alive comes first).
    const drownTimer = setInterval(() => {
      if (this.paused) return;
      if (this.rescuingFromWater) return;
      this.rescuingFromWater = true;
      escapeWaterIfDrowning(this.bot)
        .catch(() => {})
        .finally(() => {
          this.rescuingFromWater = false;
        });
    }, 3000);
    drownTimer.unref?.();

    // 2. Hostile scanner — checks for nearby threats every 2s
    this.hostileScanner = setInterval(() => this.scanHostiles(), this.HOSTILE_CHECK_MS);

    // 3. Health/hunger monitoring via mineflayer events
    this.bot.on("health", () => this.checkVitals());

    // 4. Entity hurt — react when bot takes damage
    this.bot.on("entityHurt", (entity: Entity) => {
      if (entity === this.bot.entity) {
        this.pushEvent({
          type: "reactive",
          priority: 0,
          data: { reason: "took_damage", health: this.bot.health },
          timestamp: Date.now(),
        });
      }
    });

    // 5. Overlay updates every 2s
    this.overlayInterval = setInterval(() => {
      setCurrentBot(this.roleConfig.name);
      const overlayData: any = {
        health: this.bot.health,
        food: this.bot.food,
        position: {
          x: this.bot.entity.position.x,
          y: this.bot.entity.position.y,
          z: this.bot.entity.position.z,
        },
        time: this.bot.time.timeOfDay < 13000 || this.bot.time.timeOfDay > 23000 ? "Daytime" : "Nighttime",
        inventory: this.bot.inventory.items().map((i) => `${i.name}x${i.count}`),
        // Role mission outranks broadcast steering: specialists hold their
        // lane even when a chat-set goal sweeps the team.
        seasonGoal: this.roleConfig.seasonGoal ?? this.memStore.getSeasonGoal() ?? undefined,
      };
      if (isSkillRunning(this.bot)) {
        overlayData.action = `[SKILL] ${getActiveSkillName(this.bot)}`;
      }
      updateOverlay(overlayData);
    }, 2000);

    // Trigger first strategic decision immediately
    this.pushEvent({ type: "strategic", priority: 5, timestamp: Date.now() });
  }

  /** Stop the brain — clears all timers. */
  stop(): void {
    this.markInterruption("brain_stopped_during_action");
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.hostileScanner) clearInterval(this.hostileScanner);
    if (this.overlayInterval) clearInterval(this.overlayInterval);
  }

  /** Pause autonomous decisions and discard queued work that has not started. */
  pause(): void {
    this.markInterruption("paused_during_action");
    this.paused = true;
    this.eventQueue = [];
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Mark an in-flight action as interrupted by a Minecraft death. */
  markDeathInterruption(): void {
    this.markInterruption("death_interrupted");
  }

  private markInterruption(reason: string): void {
    const generation = ++this.interruptionGeneration;
    this.interruptionHistory.push({ generation, reason });
    if (this.interruptionHistory.length > 256) this.interruptionHistory.shift();
  }

  private interruptionReasonSince(generation: number): string | null {
    return this.interruptionHistory.find((entry) => entry.generation > generation)?.reason ?? null;
  }
  /** Resume autonomous decisions with a fresh strategic plan. */
  resume(): void {
    if (!this.paused || this.stopped) return;
    this.paused = false;
    this.resetIdleTimer();
    this.triggerReplan();
  }

  /** Current state used by the in-game status command. */
  getStatus(): { paused: boolean; action: string; goal: string } {
    const activeSkill = getActiveSkillName(this.bot);
    return {
      paused: this.paused,
      action: (activeSkill ?? this.activeAction) || (this.processing ? "planning" : "idle"),
      goal: this.currentGoal || this.memStore.getSeasonGoal() || "none",
    };
  }

  /** Queue a chat message for processing. */
  queueChat(msg: ChatMessage): void {
    const viewerFilter = filterViewerMessage(msg.message);
    if (!viewerFilter.safe) {
      this.log.debug("Brain", `Filtered viewer message from ${msg.username}: ${viewerFilter.reason}`);
      msg.message = viewerFilter.cleaned;
    }
    this.pendingChatMessages.push(msg);
    if (this.pendingChatMessages.length > 10) this.pendingChatMessages.shift();

    // Push chat event — paid messages are higher priority
    const isPaid = (msg as any).tier === "paid";
    this.pushEvent({
      type: isPaid ? "strategic" : "chat", // Paid messages trigger full re-planning
      priority: isPaid ? 1 : 4,
      data: msg,
      timestamp: Date.now(),
    });
  }

  /** Force immediate strategic re-evaluation. */
  triggerReplan(): void {
    this.pushEvent({ type: "strategic", priority: 5, timestamp: Date.now() });
  }

  // ─── Event queue management ─────────────────────────────────────────────

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.stopped || this.paused) return;
    this.idleTimer = setTimeout(() => {
      this.pushEvent({ type: "strategic", priority: 5, timestamp: Date.now() });
      this.resetIdleTimer();
    }, this.IDLE_INTERVAL_MS);
  }

  private pushEvent(event: BrainEvent): void {
    if (this.stopped || this.paused) return;

    // Deduplicate: don't queue same type if already pending with equal/higher priority
    const existingIdx = this.eventQueue.findIndex((e) => e.type === event.type);
    if (existingIdx !== -1) {
      if (event.priority < this.eventQueue[existingIdx].priority) {
        this.eventQueue.splice(existingIdx, 1); // Replace with higher priority
      } else {
        return; // Already have an equal/higher priority event of this type
      }
    }

    this.eventQueue.push(event);
    this.eventQueue.sort((a, b) => a.priority - b.priority);
    this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.stopped || this.paused) return;
    const event = this.eventQueue.shift();
    if (!event) return;

    this.processing = true;
    setCurrentBot(this.roleConfig.name);

    try {
      // Skip if a skill is running (let it finish)
      if (isSkillRunning(this.bot) && event.type !== "reactive") {
        // Re-queue non-urgent events to process after skill completes
        if (event.type === "strategic") {
          setTimeout(() => this.pushEvent(event), 3000);
        }
        return;
      }

      switch (event.type) {
        case "reactive":
          // Survival reflexes may interrupt skills — but not the ~2s bucket
          // critical section. A "Flee from creeper" between equip and the use
          // packet dragged the caster off mid-scoop (probe-verified: same code
          // fills flawlessly with no brain attached). Deferred, not dropped:
          // the threat is still there two seconds later.
          if (handsBusy(this.bot)) {
            setTimeout(() => this.pushEvent(event), 2000);
            break;
          }
          await this.handleReactive(event);
          break;
        case "chat":
          await this.handleChat(event);
          break;
        case "strategic":
          await this.handleStrategic(event);
          break;
        case "critic":
          await this.handleCritic(event);
          break;
      }
    } catch (err) {
      this.log.error(`Brain:${event.type}`, "Error:", err);
    } finally {
      this.processing = false;
      this.resetIdleTimer();
      // Process next queued event
      if (this.eventQueue.length > 0 && !this.stopped && !this.paused) {
        setImmediate(() => this.processNext());
      }
    }
  }

  // ─── Hostile scanning ─────────────────────────────────────────────────────

  private scanHostiles(): void {
    if (this.processing || this.stopped || this.paused) return;
    if (isSkillRunning(this.bot)) return; // Don't interrupt skills

    const myPos = this.bot.entity?.position;
    if (!myPos) return;

    const now = Date.now();
    if (now - this.lastReactiveMs < this.REACTIVE_COOLDOWN_MS) return;

    const hostiles = Object.values(this.bot.entities).filter(
      (e) => e !== this.bot.entity && !!e.position && isHostile(e) && e.position.distanceTo(myPos) < 16,
    );

    if (hostiles.length === 0) return;

    // A real threat is present — clear any stale "no mobs / attack failed"
    // blacklist so the bot can actually engage. Without this, the no-target
    // failures that pile up while safe (Peaceful, or just daytime) permanently
    // block attack/neural_combat, so Blade could never fight when mobs finally
    // appeared — he had 0 kills all session.
    for (const key of ["attack", "neural_combat", "skill:neural_combat"]) {
      this.recentFailures.delete(key);
      this.failureCounts.delete(key);
    }

    // Don't spam for the same hostile
    const hostileKey = hostiles.map((h) => `${h.name}:${Math.round(h.position.x)}`).join(",");
    if (hostileKey === this.lastHostileSeen && now - this.lastReactiveMs < 10_000) return;
    this.lastHostileSeen = hostileKey;

    this.pushEvent({
      type: "reactive",
      priority: 1,
      data: { reason: "hostile_nearby", entities: hostiles },
      timestamp: now,
    });
  }

  /** A hostile mob within `radius` blocks of the bot, by the perception rules. */
  private hostileWithin(radius: number): boolean {
    const me = this.bot.entity?.position;
    if (!me) return false;
    return !!this.bot.nearestEntity((e) => !!e.position && isHostile(e) && e.position.distanceTo(me) < radius);
  }

  private checkVitals(): void {
    if (this.stopped || this.paused) return;
    const now = Date.now();
    if (now - this.lastReactiveMs < this.REACTIVE_COOLDOWN_MS) return;

    if (this.bot.health <= 6) {
      // Run 675: on Normal a starving bot sits at 1 to 6 hp for hours, and this
      // fired on every health tick: 176 reactive calls in the hour, 74 of them
      // a "flee" with nothing in sight that jogged 15 blocks and aborted the
      // hunt or farm pass that would have fed the bot. Low health with nobody
      // around is the food layer's job; the hostile scanner covers the rest.
      if (!this.hostileWithin(16)) return;
      this.pushEvent({
        type: "reactive",
        priority: 0,
        data: { reason: "low_health", health: this.bot.health },
        timestamp: now,
      });
    } else if (this.bot.food <= 6 && this.hasEdibleAboard()) {
      // Only when there is something to eat: run 569 logged 156 "eat" actions
      // in an hour, most answered "No food in inventory!", each one an LLM
      // call and an item swap that cancels whatever the bot was holding (a
      // fishing cast, a chest walk). Starvation with an empty pack is the
      // hunger and fishing overrides' job.
      this.pushEvent({
        type: "reactive",
        priority: 2,
        data: { reason: "low_hunger", food: this.bot.food },
        timestamp: now,
      });
    }
  }

  private hasEdibleAboard(): boolean {
    // Run 676: the old regex matched rabbit_hide, rabbit_foot and
    // poisonous_potato, so Blade at 0 hunger with a rabbit hide drew a
    // low-hunger reactive on every health tick (143 calls in the hour) and
    // every "eat" answered "No food in inventory!". Use the eat action's own
    // list, so this asks only when eat would succeed.
    return this.bot.inventory.items().some((i) => EDIBLE.has(i.name));
  }

  // ─── Safety overrides ─────────────────────────────────────────────────────

  /** Check for water/underground and handle before LLM query. Returns true if override handled. */
  private lastCapMs = 0;
  private lastSeedShedMs = 0;
  private lastBucketFishMs = 0;

  /** A one-wide vertical hole open at the surface: air at the rim level and
   *  for at least six blocks below, with three or four solid rim neighbours. */
  private findDeepHole(
    center: { x: number; y: number; z: number },
    radius: number,
  ): { x: number; z: number; top: number; depth: number; ref: Vec3; face: Vec3 } | null {
    const bot = this.bot;
    const solid = (p: Vec3) => {
      const b = bot.blockAt(p);
      return !!b && b.boundingBox === "block";
    };
    const air = (p: Vec3) => {
      const b = bot.blockAt(p);
      return !!b && b.name === "air";
    };
    const cx = Math.floor(center.x);
    const cz = Math.floor(center.z);
    const baseY = Math.floor(center.y);
    let best: { x: number; z: number; top: number; depth: number; ref: Vec3; face: Vec3 } | null = null;
    for (let x = cx - radius; x <= cx + radius; x++) {
      for (let z = cz - radius; z <= cz + radius; z++) {
        // The rim: a surface-level cell within a few blocks of the stash's height.
        for (let top = baseY + 4; top >= baseY - 4; top--) {
          const cell = new Vec3(x, top, z);
          if (!air(cell) || !air(cell.offset(0, 1, 0))) continue;
          const sides: [Vec3, Vec3][] = [
            [cell.offset(1, 0, 0), new Vec3(-1, 0, 0)],
            [cell.offset(-1, 0, 0), new Vec3(1, 0, 0)],
            [cell.offset(0, 0, 1), new Vec3(0, 0, -1)],
            [cell.offset(0, 0, -1), new Vec3(0, 0, 1)],
          ];
          const solidSides = sides.filter(([p]) => solid(p));
          if (solidSides.length < 3) continue;
          let depth = 0;
          while (depth < 40 && air(cell.offset(0, -1 - depth, 0))) depth++;
          if (depth < 6) continue;
          const failed = capFailures.get(`${x},${top},${z}`);
          if (failed && failed.n >= 2 && Date.now() - failed.at < 3_600_000) continue;
          // Prefer a plain rim block (a click on a furnace or chest opens it
          // instead of placing) with a standable cell on its far side.
          const standable = ([p, f]: [Vec3, Vec3]) => {
            const stand = p.offset(-f.x, 0, -f.z);
            return solid(stand.offset(0, -1, 0)) && air(stand) && air(stand.offset(0, 1, 0));
          };
          const ranked = [...solidSides].sort((a, b) => {
            const score = (side: [Vec3, Vec3]) =>
              (INTERACTIVE_RIM.test(bot.blockAt(side[0])?.name ?? "") ? 0 : 2) + (standable(side) ? 1 : 0);
            return score(b) - score(a);
          });
          const [ref, face] = ranked[0]!;
          if (!best || depth > best.depth) best = { x, z, top, depth, ref, face };
          break;
        }
      }
    }
    return best;
  }

  private async capHole(
    hole: { x: number; z: number; top: number; depth: number; ref: Vec3; face: Vec3 },
    filler: string,
  ): Promise<string> {
    const bot = this.bot;
    try {
      const { safeGoto, baseMoves } = await import("./navigation.js");
      const moves = baseMoves(bot);
      (moves as unknown as { maxDropDown: number; canDig: boolean }).maxDropDown = 1;
      (moves as unknown as { maxDropDown: number; canDig: boolean }).canDig = false;
      bot.pathfinder.setMovements(moves);
      // Stand on the far side of the reference block, never over the hole.
      const standAt = hole.ref.offset(-hole.face.x, 1, -hole.face.z);
      await safeGoto(bot, new navGoals.GoalNear(standAt.x, standAt.y, standAt.z, 1), 20_000);
      const refBlock = bot.blockAt(hole.ref);
      const item = bot.inventory.items().find((i) => i.name === filler);
      if (!refBlock || !item) return "Cap failed: lost the reference block or the filler.";
      await bot.equip(item, "hand");
      // Sneak so a click on a container rim still places instead of opening it.
      bot.setControlState("sneak", true);
      try {
        await bot.placeBlock(refBlock, hole.face);
      } finally {
        bot.setControlState("sneak", false);
      }
      const placed = bot.blockAt(new Vec3(hole.x, hole.top, hole.z));
      const ok = !!placed && placed.name !== "air";
      if (!ok) this.noteCapFailure(hole);
      console.log(
        `[Cap] ${bot.username}: ${ok ? "capped" : "failed to cap"} a ${hole.depth}-deep hole at (${hole.x}, ${hole.top}, ${hole.z}) with ${filler}`,
      );
      return ok
        ? `Capped a ${hole.depth}-deep hole at ${hole.x}, ${hole.top}, ${hole.z} with ${filler}.`
        : `Cap failed at ${hole.x}, ${hole.top}, ${hole.z}: the block did not appear.`;
    } catch (e) {
      bot.setControlState("sneak", false);
      this.noteCapFailure(hole);
      const msg = (e as Error)?.message ?? String(e);
      console.log(
        `[Cap] ${bot.username}: cap failed at (${hole.x}, ${hole.top}, ${hole.z}) against ${bot.blockAt(hole.ref)?.name ?? "?"}: ${msg.slice(0, 80)}`,
      );
      return `Cap failed at ${hole.x}, ${hole.top}, ${hole.z}: ${msg.slice(0, 80)}`;
    }
  }

  private noteCapFailure(hole: { x: number; z: number; top: number }): void {
    const key = `${hole.x},${hole.top},${hole.z}`;
    const prev = capFailures.get(key);
    const n = (prev?.n ?? 0) + 1;
    capFailures.set(key, { n, at: Date.now() });
    if (n >= 2) console.log(`[Cap] hole at (${key}) failed ${n} caps; skipping it for an hour`);
  }

  private async runSafetyOverrides(): Promise<boolean> {
    // Teleport-based water/buried escapes are interventions — off by default so
    // bots must swim/dig out themselves (or die; keepInventory protects progress).
    if (!config.bot.allowInterventions) return false;
    const pos = this.bot.entity.position;

    // Water escape
    const feetBlock = this.bot.blockAt(pos);
    const headBlock = this.bot.blockAt(pos.offset(0, 1, 0));
    if (feetBlock?.name === "water" || headBlock?.name === "water") {
      // Wait 3s for natural swim-out
      await new Promise((r) => setTimeout(r, 3000));
      const feetNow = this.bot.blockAt(this.bot.entity.position);
      const headNow = this.bot.blockAt(this.bot.entity.position.offset(0, 1, 0));
      if (feetNow?.name !== "water" && headNow?.name !== "water") return false;

      if (this.roleConfig.safeSpawn) {
        const { x, z } = this.roleConfig.safeSpawn;
        this.log.debug("Brain", `In water — TPing to safeSpawn (${x},80,${z})`);
        // spreadplayers lands on the topmost safe block — a raw /tp X 80 Z
        // materialized bots inside hills taller than Y=80 (suffocation deaths)
        this.bot.chat(`/spreadplayers ${x} ${z} 0 2 false ${this.bot.username}`);
        await new Promise((r) => setTimeout(r, 4000));
        return true;
      }
      return false;
    }

    // Underground/buried escape
    const isInsideSolid =
      feetBlock &&
      feetBlock.name !== "air" &&
      feetBlock.name !== "cave_air" &&
      feetBlock.name !== "water" &&
      feetBlock.diggable &&
      pos.y < 55;
    if (isInsideSolid) {
      const tx = Math.floor(pos.x);
      const tz = Math.floor(pos.z);
      this.log.debug("Brain", `Buried in ${feetBlock?.name} at Y=${pos.y.toFixed(1)} — escaping`);
      this.bot.chat(`/spreadplayers ${tx} ${tz} 0 2 false ${this.bot.username}`);
      await new Promise((r) => setTimeout(r, 2000));
      return true;
    }

    return false;
  }

  // ─── Context building ─────────────────────────────────────────────────────

  /** Build the world context string for strategic decisions. */
  private buildContext(): string {
    const worldContext = getWorldContext(this.bot, this.roleConfig.role);
    let ctx = `CURRENT STATE:\n${worldContext}`;

    // Pending chat messages
    if (this.pendingChatMessages.length > 0) {
      const chatStr = this.pendingChatMessages.map((m) => `[${m.source}] ${m.username}: ${m.message}`).join("\n");
      ctx += `\n\nMESSAGES FROM PLAYERS/VIEWERS:\n${chatStr}`;
      this.pendingChatMessages.length = 0;
    }

    // Tech-tree curriculum — deterministic "what's next" from inventory
    const techLine = getTechTreeLine(this.bot, this.roleConfig.role);
    if (techLine) ctx += `\n\n${techLine}`;

    // Ground truth from the server, not from the bot's own claims. Cached by
    // readTeamEarned's caller cadence — buildContext runs at most every ~10s.
    const advLine = advancementLine(this.roleConfig.role, readTeamEarned(BOT_ROSTER.map((b) => b.name)));
    if (advLine) ctx += `\n\n${advLine}`;

    // Current goal
    if (this.currentGoal && this.goalStepsLeft > 0) {
      ctx += `\n\nCURRENT GOAL: "${this.currentGoal}" (${this.goalStepsLeft} steps left). Continue.`;
    }

    // Last action result
    if (this.lastAction && this.lastResult) {
      ctx += `\n\nLAST ACTION: ${this.lastAction} → ${this.lastResult}`;
    }

    // Leash enforcement
    if (this.homePos && this.roleConfig.leashRadius > 0) {
      const dx = this.bot.entity.position.x - this.homePos.x;
      const dz = this.bot.entity.position.z - this.homePos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= this.roleConfig.leashRadius * 0.8) {
        ctx += `\n\nLEASH WARNING: ${dist.toFixed(0)} blocks from home (max: ${this.roleConfig.leashRadius}). Head back to (${this.homePos.x}, ${this.homePos.y}, ${this.homePos.z}).`;
      }
    }

    // Stash position
    if (this.roleConfig.stashPos) {
      const { x, y, z } = this.roleConfig.stashPos;
      ctx += `\n\nTHE STASH: Shared chest area at (${x}, ${y}, ${z}).`;
    }

    // Team bulletin
    const teamStatus = formatTeamBulletin(this.roleConfig.name);
    if (teamStatus) ctx += `\n${teamStatus}`;

    // Recent failures
    this.purgeExpiredFailures();
    if (this.recentFailures.size > 0) {
      const lines: string[] = [];
      for (const [k, v] of this.recentFailures.entries()) {
        lines.push(`- ${k.replace(/^skill:/, "")}: ${v}`);
      }
      ctx += `\n\nRECENTLY FAILED (do NOT retry):\n${lines.join("\n")}`;
    }

    ctx += "\n\nWhat should you do next? Respond with JSON.";
    return ctx;
  }

  // ─── Event handlers ───────────────────────────────────────────────────────

  private async handleReactive(event: BrainEvent): Promise<void> {
    this.lastReactiveMs = Date.now();
    const { reason, entities, health, food } = event.data ?? {};

    // Build a tiny situation description
    let situation: string;
    if (reason === "hostile_nearby" && entities?.length) {
      const hostileList = entities
        .slice(0, 3)
        .map((e: Entity) => `${e.name || "mob"} (${e.position.distanceTo(this.bot.entity.position).toFixed(0)} blocks)`)
        .join(", ");
      const equipment =
        this.bot.inventory
          .items()
          .filter((i) => i.name.includes("sword") || i.name.includes("shield") || i.name.includes("bow"))
          .map((i) => i.name)
          .join(", ") || "bare hands";
      const foodItems =
        this.bot.inventory
          .items()
          .filter((i) =>
            ["bread", "cooked_beef", "cooked_porkchop", "apple", "cooked_chicken", "baked_potato"].includes(i.name),
          )
          .map((i) => `${i.name}x${i.count}`)
          .join(", ") || "none";
      situation = `THREAT: ${hostileList}\nHealth: ${this.bot.health}/20, Food: ${this.bot.food}/20\nEquipment: ${equipment}\nFood items: ${foodItems}`;
    } else if (reason === "took_damage") {
      situation = `TOOK DAMAGE! Health: ${this.bot.health}/20. Check for nearby threats and react.`;
    } else if (reason === "low_health") {
      situation = `LOW HEALTH: ${this.bot.health}/20. Eat food or flee to safety.`;
    } else if (reason === "low_hunger") {
      situation = `LOW HUNGER: ${this.bot.food}/20. Eat something before starving.`;
    } else {
      situation = `Health: ${this.bot.health}/20, Food: ${this.bot.food}/20. Assess situation.`;
    }

    // Run 675: damage and low-health prompts with nobody around drew "flee"
    // 74 times in an hour. Say so, and the model can pick eat or idle.
    const threatNear = reason === "hostile_nearby" || this.hostileWithin(16);
    if (!threatNear) {
      situation += `\nNo hostile within 16 blocks (food ${this.bot.food}/20): fleeing is pointless; eat if you can, otherwise idle or keep working.`;
    }

    // Run 621: 38 of 73 blocked "eat" picks came from this prompt, which
    // still listed eat while the strategic menu had dropped it.
    this.purgeExpiredFailures();
    const reactiveMenu = this.roleConfig.allowedActions.filter((a) => !this.recentFailures.has(a));
    const decision = await queryReactive(
      this.roleConfig.name,
      situation,
      reactiveMenu.length ? reactiveMenu : this.roleConfig.allowedActions,
    );
    // A reactive MOVE while a skill is walking steals the pathfinder: the
    // skill's goto rejects with "goal was changed", and run 500 logged 324
    // such interruptions for Blade and 130 for Flora in one hour, killing
    // farm walks, plantings and stash trips. If the bot is in real danger,
    // abort the skill first so the flee owns the controls; otherwise let the
    // skill finish and only allow actions that do not move.
    const MOVING = new Set(["flee", "attack", "go_to", "explore", "hunt", "gather_wood", "mine_block"]);
    if (isSkillRunning(this.bot) && MOVING.has(decision.action)) {
      // A flee with no hostile in sight must never abort a skill (run 675).
      const critical =
        this.bot.health <= 8 && threatNear && (decision.action === "flee" || decision.action === "attack");
      if (critical) {
        this.log.info(
          "Brain",
          `Reactive ${decision.action} at ${this.bot.health}/20 — aborting ${getActiveSkillName(this.bot)} first`,
        );
        abortActiveSkill(this.bot);
        await new Promise((r) => setTimeout(r, 300));
      } else {
        this.log.info("Brain", `Reactive ${decision.action} deferred — ${getActiveSkillName(this.bot)} is walking`);
        return;
      }
    }
    await this.executeDecision(decision);
  }

  private async handleChat(event: BrainEvent): Promise<void> {
    const msg = event.data as ChatMessage;
    if (!msg) return;

    const activity = `${this.lastAction || "exploring"} (${this.currentGoal || "no specific goal"})`;
    const response = await chatWithLLM(`[${msg.source}] ${msg.username}: ${msg.message}`, activity, {
      name: this.roleConfig.name,
    });
    if (this.paused) return;

    const chatFilter = filterChatMessage(response);
    const safeResponse = chatFilter.safe ? response : chatFilter.cleaned;

    this.bot.chat(safeResponse);
    this.events.onChat(safeResponse);
    addChatMessage(this.roleConfig.name, safeResponse, "bot");
  }

  private async handleStrategic(event: BrainEvent): Promise<void> {
    const now = Date.now();
    if (now - this.lastStrategicMs < this.STRATEGIC_COOLDOWN_MS) return;
    this.lastStrategicMs = now;

    // Safety overrides first
    if (await this.runSafetyOverrides()) return;

    // Bank the groceries FIRST. Run 600: the courier walked 365 blocks home
    // in 80 s with 13 potatoes and the ferry override, earlier in this
    // chain, sent him back to the frontier before the banking step ran; he
    // died there with the food. A bot at the stash with a pantry load puts
    // it in the chests (keeping the role's food reserve) so the pantry reflex
    // below can feed the others.
    if (config.bot.allowStrategyOverrides && !isSkillRunning(this.bot) && this.roleConfig.stashPos) {
      const sp = this.roleConfig.stashPos;
      const atStash =
        Math.hypot(this.bot.entity.position.x - sp.x, this.bot.entity.position.z - sp.z) < 40 &&
        this.bot.entity.position.y >= sp.y - 8;
      const load = this.pantryAboard();
      // Run 607: Flora baked bread four times in an hour and ate every loaf
      // while four bots sat at 0 hunger; nothing under a 12-item load ever
      // reached the chests. A fed bot (hunger 12 or more) banks a load of
      // four or more and keeps two.
      const fed = this.bot.food >= 12;
      const keepFood = fed ? 2 : 8;
      if (atStash && (load >= 12 || (fed && load >= 4)) && Date.now() - this.lastBankGroceriesMs > 600_000) {
        this.lastBankGroceriesMs = Date.now();
        this.log.info("Brain", `OVERRIDE: ${load} food items aboard at the stash — banking the groceries`);
        this.events.onThought("Food for the team goes in the chests.");
        // Bake first: raw potatoes feed one hunger each, baked five (run 609).
        try {
          const raw = this.bot.inventory
            .items()
            .filter((i) => i.name === "potato")
            .reduce((n, i) => n + i.count, 0);
          const hasFuel = this.bot.inventory.items().some((i) => i.name === "coal" || i.name === "charcoal");
          if (raw >= 4 && hasFuel) {
            const { bakePotatoes } = await import("../skills/bake-potatoes.js");
            await bakePotatoes(this.bot, 16);
          }
        } catch (e) {
          console.log(`[Bake] ${this.bot.username}: ${(e as Error).message}`);
        }
        const { depositStash } = await import("../skills/stash.js");
        // Run 608: Flora banked 87 items and kept all 5 loaves, because her
        // role's generic "food" keep entry outranks the deposit's food
        // reserve. A fed bot banks with the food entries stripped.
        const foodEntry =
          /^(food|bread|potato|baked_potato|cooked_|beef|porkchop|mutton|chicken|rabbit|cod|salmon|apple|carrot)/;
        const keepList = fed
          ? this.roleConfig.keepItems.filter((k) => !foodEntry.test(k.name))
          : this.roleConfig.keepItems;
        const r = await depositStash(
          this.bot,
          sp,
          keepList,
          undefined,
          undefined,
          keepFood,
          Date.now() + 120_000,
        ).catch((e: Error) => e.message);
        console.log(
          `[Pantry] ${this.bot.username} banked groceries: ${String(r).slice(0, 100)}; aboard now ${this.pantryAboard()}`,
        );
        this.lastAction = "bank_groceries";
        this.lastResult = String(r);
        return;
      }
    }

    // NIGHT REFLEX. playersSleepingPercentage=1 (Jesse-approved 2026-08-27)
    // means ONE sleeping bot skips the night for the whole server — but across
    // the first full night with the rule live, the models chose sleep ZERO
    // times in 1,292 actions and the fleet spent the dark hours in flee/eat
    // churn (9% action success). Same doctrine as auto-eat: survival plumbing
    // is mechanical, the LLM plans on top of it. Only idle bots get here
    // (skills re-queue strategic events), so nobody abandons a job to nap.
    const timeOfDay = this.bot.time?.timeOfDay ?? 0;
    // 11800, before beds unlock at 12542: the sleep action walks FIRST and
    // clicks last, so a dusk invocation parks the bot beside its bed through
    // twilight and the click lands the moment it becomes legal — winning the
    // race against mob aggro that three straight 20-death nights kept losing
    // (the reflex used to start the 75s bed-walk only after the mobs were
    // already out).
    // 12542 is the first tick a bed accepts a sleeper; run 634 logged eight
    // "it's not night" failures from starting at 11800.
    // Run 646: "Sleep failed: bot is not sleeping" 20 times in one hour, the
    // server refusing the bed for monsters nearby, and the reflex walked the
    // bot back to the bed every strategic tick to be refused again while the
    // mobs closed in. After a refusal the reflex stands down for 45 s so the
    // normal planning (flee, fight) gets the turn.
    if (
      timeOfDay >= 12542 &&
      timeOfDay <= 23458 &&
      !(this.bot as any).isSleeping &&
      Date.now() - this.lastSleepRefusedMs > 45_000
    ) {
      const slept = await this.executeActionUnlessPaused("sleep", {});
      this.log.info("Brain", `Night reflex: sleep → ${slept}`);
      if (/zzz|sleeping/i.test(slept)) return; // in bed — skip the LLM turn
      if (/not sleeping|monsters nearby|occupied/i.test(slept)) this.lastSleepRefusedMs = Date.now();
      // Sleep failed (no bed, hostiles nearby) — fall through to normal planning.
    }

    // (Ghast-fireball deflect moved to a 200ms tick handler in start() — the
    // brain override was skill-gated and the fortress hunters are always
    // mid-skill, so it never fired. See "0a. Ghast-fireball deflect".)

    // ESCAPE-TO-SURFACE reflex — RUNS BEFORE walk-home, because a bot stranded
    // underground can do nothing else first. The softlock this breaks: a miner
    // whose pickaxe broke ends up below ground surrounded by stone it cannot
    // break (pickless fails the pathfinder's tool check, so walk-home stalls
    // instantly), with no wood down there to craft a pick and too far from the
    // stash to withdraw one. Three bots sat this way at once at 7% action
    // success. The escape hand-digs a staircase up to daylight — bare hands
    // still break stone — from where wood and the stash are reachable again.
    // Gated on being genuinely buried (deep, with a solid ceiling overhead) so
    // it never fires for a bot working normally near the surface.
    if (
      config.bot.allowStrategyOverrides &&
      !isSkillRunning(this.bot) &&
      /overworld/.test(String(this.bot.game.dimension)) &&
      Date.now() - this.lastEscapeMs > 60_000
    ) {
      const f = this.bot.entity.position.floored();
      // Scan 64 up, not 24: Atlas sat at y=16 in a shaft whose stone roof
      // was 35 blocks above him (a lake on top of that), and read as not
      // buried while his walks failed 930 times in an hour.
      // Near the surface, a roof also has to be dark: the sky tower's
      // scattered cobblestone over the stash counted as four blocks
      // overhead for Blade at y=70 (run 548, seven escapes that each
      // "climbed out" at once). Sky light reaches around a pillar and into a
      // hillside notch; it does not reach a sealed pocket.
      // Sealed by geometry, since client sky light is unreliable (it reads 0
      // wherever the section carries no light data, which made the village
      // surface count as dark). A sealed pocket has a solid block within six
      // above every one of the nine columns around the head; a bot under a
      // scattered tower of planks and chests has open columns beside it.
      // Run 582: Forge fired "buried pickless at y=69-71" eleven times at the
      // village with five climb-out timeouts, under exactly that scatter.
      const sealedNearSurface = (() => {
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            let roof = false;
            for (let dy = 2; dy <= 7; dy++) {
              if (this.bot.blockAt(new Vec3(f.x + dx, f.y + dy, f.z + dz))?.boundingBox === "block") {
                roof = true;
                break;
              }
            }
            if (!roof) return false;
          }
        }
        return true;
      })();
      const buried =
        isBuried((x, y, z) => this.bot.blockAt(new Vec3(x, y, z)), f.x, f.y, f.z, 64) &&
        (f.y < 55 || sealedNearSurface);
      const pickless = !this.bot.inventory.items().some((i) => i.name.endsWith("_pickaxe"));
      const walledIn = this.navFailStreak >= 3;
      // A pit too shallow to count as buried still traps a bot: Forge and
      // Atlas shared a three-deep hole at 243,58,-512 with water at the
      // bottom (run 545), where the pathfinder never starts a dig because
      // it waits for solid ground. Three solid sides at the feet and two at
      // the head is a pit; the escape staircase handles water.
      const solidAt = (dx: number, dy: number, dz: number) =>
        this.bot.blockAt(new Vec3(f.x + dx, f.y + dy, f.z + dz))?.boundingBox === "block";
      const sides: Array<[number, number]> = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ];
      const feetWalls = sides.filter(([dx, dz]) => solidAt(dx, 0, dz)).length;
      const headWalls = sides.filter(([dx, dz]) => solidAt(dx, 1, dz)).length;
      const pit = feetWalls >= 3 && headWalls >= 2;
      // Floating in water at the bottom of a hole is the same trap with one
      // open side (Forge at 243,58,-513, run 546: two solid sides at the
      // feet, water underfoot, every walk 'stuck'): the pathfinder never
      // digs while the bot is off the ground.
      const feetBlock = this.bot.blockAt(new Vec3(f.x, f.y, f.z))?.name ?? "";
      const inWater = feetBlock === "water" || feetBlock === "flowing_water";
      const waterTrap = inWater && walledIn && feetWalls >= 2;
      // Chronic: six failed walks in a row from one spot is a trap whatever
      // the geometry (Forge on a cobblestone ledge over a drop at
      // 243,58,-512, no water after all, 100+ stuck resets per walk). A bot
      // with a pickaxe digs a staircase out in under a minute.
      const chronic = this.navFailStreak >= 6 && !pickless;
      // Pit, water hole and chronic need a failing walk streak: a hillside
      // notch at y=81 read as a pit for Atlas every ninety seconds (run 547),
      // each time costing a turn for an escape that returned at once.
      if ((buried && (pickless || walledIn)) || ((pit || waterTrap || chronic) && walledIn)) {
        this.lastEscapeMs = Date.now();
        this.navFailStreak = 0;
        this.log.info(
          "Brain",
          `OVERRIDE: ${buried ? "buried" : pit ? "in a pit" : waterTrap ? "in a water hole" : "stuck in place"} ${pickless ? "pickless" : `with a pick but ${walledIn ? "walks keep failing" : ""}`} at y=${f.y} — digging up to the surface`,
        );
        // The client's own view of the column overhead, for the desync seen
        // in run 537/538: the server held Flora at 363,62,-281 under stone
        // while her client walked to y=79 through it.
        const column = Array.from(
          { length: 18 },
          (_, i) => this.bot.blockAt(new Vec3(f.x, f.y + 1 + i, f.z))?.name ?? "?",
        )
          .map((n) => (n === "air" || n === "cave_air" ? "." : n === "stone" ? "s" : n.slice(0, 4)))
          .join(" ");
        this.log.info("Brain", `[EscapeDebug] client column above ${f}: ${column}`);
        this.events.onThought("No pickaxe and walled in down here. Cut a staircase up by hand.");
        const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "escape_to_surface" });
        this.events.onAction("escape_to_surface", result);
        this.lastAction = "escape_to_surface";
        this.lastResult = result;
        return;
      }
    }

    // WALK-HOME reflex — the honest replacement for the deleted spawn
    // teleport. Removing the /tp took away the force that kept the swarm
    // clustered at the village; frontier bed-anchoring then drifted three
    // bots 350 blocks WEST, out of reach of the stash, the portal, AND the
    // fund drop, where they were stranded (respawn west → never return →
    // never claim a village bed → respawn west). A bot far from home and
    // not mid-skill walks back, deterministically, before anything else —
    // and arriving lets the village-only bed claim finally fire.
    // OVERWORLD ONLY: the stash XZ is an overworld coordinate, and the Nether
    // is scaled 1:8, so a bot idle in the Nether computes a bogus 300+ block
    // "homeGap" and would bulldoze toward overworld coords inside the Nether —
    // dragging Atlas off his fortress sweeps between resumable refires. Home
    // is an overworld concept; only pull bots home when they are in it.
    // Flora is the designated ROAMER now that her farm and breeding work are
    // done — walk-home would tether her to the village and defeat the point,
    // so she is exempt. Everyone else still re-clusters.
    // Forge re-clusters like everyone EXCEPT while he is out east doing his
    // real work: the fresh-ore frontier (450,-420) and the bee hive (472,-445)
    // wax_on needs are both ~250 blocks from the village, and walk-home would
    // tether him off them. But a BLANKET exemption stranded him the other way —
    // he got stuck underground at (172,26,-251), far WEST of base, and with no
    // walk-home to rescue him the wax reflex pinned him there firing 54 times
    // at a hive he could never path to (357 blocks across the base's water),
    // while mine_frontier never once fired. So exempt him ONLY when he is near
    // the hive/frontier; when he strands anywhere else, walk-home marches him
    // back to base, from where the frontier ferry can carry him east again.
    const HIVE_XZ = nearestNest(this.bot.entity.position.x, this.bot.entity.position.z);
    const forgeHoldingEast =
      this.bot.username === "Forge" &&
      Math.hypot(this.bot.entity.position.x - HIVE_XZ.x, this.bot.entity.position.z - HIVE_XZ.z) < 200;
    const inOverworld = /overworld/.test(String(this.bot.game.dimension));
    if (
      config.bot.allowStrategyOverrides &&
      !isSkillRunning(this.bot) &&
      this.roleConfig.stashPos &&
      inOverworld &&
      this.bot.username !== "Flora" &&
      this.bot.username !== "Atlas" &&
      // Runs 604 to 606: a pickless Forge at 0 hunger spent three hours on
      // the eastern ground (a mountain pocket at y=150, then a cave at y=15)
      // because the hive hold kept him from walking home, where the stash
      // has cobblestone for a pick and the pantry. The hold yields to a
      // courier load, a bare hand, or an empty stomach.
      (!forgeHoldingEast ||
        this.pantryAboard() >= 12 ||
        !this.bot.inventory.items().some((i) => i.name.endsWith("_pickaxe")) ||
        this.bot.food < 6)
    ) {
      const sp = this.roleConfig.stashPos;
      const homeGap = Math.hypot(this.bot.entity.position.x - sp.x, this.bot.entity.position.z - sp.z);
      const cooledHome = Date.now() - this.lastWalkHomeMs > 120_000;
      if (homeGap > 120 && cooledHome) {
        this.lastWalkHomeMs = Date.now();
        this.log.info("Brain", `OVERRIDE: ${homeGap.toFixed(0)} blocks from the village — marching home to regroup`);
        this.events.onThought("Too far from the team. Back to the village.");
        // MARCH, don't step: a single go_to covers ~30-50 blocks then times
        // out, and Atlas was stranded at 368 for an hour — every partial walk
        // erased by a death that respawned him at the frontier bed. Loop the
        // walk within one invocation so a bot covers real ground (200+
        // blocks) between deaths and actually reaches the village, where the
        // bed claim finally re-anchors him. Bounded so a genuinely trapped
        // bot still yields the turn.
        const gapNow = () => Math.hypot(this.bot.entity.position.x - sp.x, this.bot.entity.position.z - sp.z);
        const marchUntil = Date.now() + 150_000;
        let stallGuard = 0;
        // BULLDOZER MARCH — swim AND dig AND pillar. RCON ground truth ended
        // the guessing: Atlas was not across water, he stood at the foot of a
        // solid hillside rising east, every block toward home solid at his
        // level, and explorerMoves (canDig false) can neither climb nor
        // tunnel it — hence zero progress through three "swim" fixes. A dig-
        // and-tower march bores straight home through hills and bridges pits;
        // the searchRadius cap (256) + thinkTimeout (1500) keep the dig-
        // enabled search bounded against the OOM class.
        const homeMoves = explorerMoves(this.bot);
        homeMoves.canDig = true;
        homeMoves.allow1by1towers = true;
        this.bot.pathfinder.setMovements(homeMoves);
        while (Date.now() < marchUntil && gapNow() > 60 && !this.paused) {
          const p = this.bot.entity.position;
          const gap = gapNow();
          const stepFrac = Math.min(1, 120 / gap);
          const wx = Math.round(p.x + (sp.x - p.x) * stepFrac);
          const wz = Math.round(p.z + (sp.z - p.z) * stepFrac);
          const before = gap;
          // Surface arrivals only (see GoalNearXZAbove): run 559 delivered
          // Blade to the village column at y=29 and cost him twenty minutes of
          // bare-handed stone. Sea level is the floor for intermediate legs;
          // the last leg must come up to the stash's own height.
          const legMinY = stepFrac >= 1 ? sp.y - 4 : 62;
          await safeGoto(this.bot, new GoalNearXZAbove(wx, wz, 6, legMinY), 40_000, 12_000).catch((e: Error) => {
            this.log.info("Brain", `Walk-home leg to (${wx}, ${wz}) y>=${legMinY} rejected: ${e.message}`);
          });
          if (before - gapNow() < 5) {
            if (++stallGuard >= 3) {
              this.log.info("Brain", `Walk-home: stalled at ${gapNow().toFixed(0)} blocks — yielding the turn`);
              break;
            }
          } else {
            stallGuard = 0;
          }
          if (gapNow() > 60) await new Promise((r) => setTimeout(r, 800));
        }
        const result = `Walk-home ended ${gapNow().toFixed(0)} blocks out`;
        this.log.info("Brain", `Walk-home: now ${gapNow().toFixed(0)} blocks from the village`);
        this.events.onAction("go_to", result);
        this.lastAction = "go_to";
        this.lastResult = result;
        return;
      }
    }

    // Portal-breach override — RUNS FIRST among mission overrides. In run
    // 391 the village-lighting and mining pushes both outranked it in code
    // order: Mason marched 20 blocks toward the doorway, lost his turn to a
    // torch chore, wandered home, and the commute reset from 71 to 89 blocks.
    // While the doorway pick is in hand, the doorway IS the mission. Forge's
    // mission text stops at "craft a diamond_pickaxe" and no reflex sent the
    // finished pick anywhere: the doorway at 278,14,-243 would have waited on
    // the model to volunteer. Diamond pick + the portal skill = go clear it.
    // build_nether_portal handles the interior obsidian, ignition, and entry.
    // An empty allowedSkills list is permissive (Atlas ran this skill all
    // night on one), and the stranded-in-the-Nether rescue must reach every
    // bot that can fall through the doorway.
    if (
      config.bot.allowStrategyOverrides &&
      (this.roleConfig.allowedSkills.length === 0 || this.roleConfig.allowedSkills.includes("build_nether_portal")) &&
      !isSkillRunning(this.bot)
    ) {
      const holdsDoorwayPick = this.bot.inventory
        .items()
        .some((i) => i.name === "diamond_pickaxe" || i.name === "netherite_pickaxe");
      // A full frame in the pack is a stronger signal than any pickaxe:
      // Atlas carried all ten blocks through an entire run while this
      // override ignored him because he never owned a diamond pick, and
      // placement waited on the strategic model's whims.
      const holdsFullFrame =
        this.bot.inventory
          .items()
          .filter((i) => i.name === "obsidian")
          .reduce((s, i) => s + i.count, 0) >= 10;
      // A bot stuck on the far side flails: Forge lost his whole kit to a
      // ghast while his strategic model hunted for trees in the Nether. The
      // portal skill starts with a return-home leg, so firing it IS the
      // rescue.
      const dimNow = String(this.bot.game.dimension);
      const strandedInNether = dimNow === "the_nether" || dimNow === "minecraft:the_nether";
      // With the village portal lit, a diamond pick alone is no reason to
      // run the builder — the skill returns "nothing to build" instantly and
      // the override was firing that no-op every five minutes forever. A
      // pick-holder only builds when no lit doorway stands nearby; the
      // full-pocket and stranded triggers are unaffected.
      const litPortalNearby =
        holdsDoorwayPick &&
        !strandedInNether &&
        !!this.bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 48 });
      // Once the Nether has been ENTERED, a diamond pick is never again a
      // reason to build a portal. The 48-block proximity guard fails deep
      // underground (the village portal is unseeable from y=-36), and this
      // zombie trigger hijacked Forge for 3 minutes the moment diamond pick
      // #2 landed — right when the enchanting endgame needed him, and the 2
      // table diamonds left his pocket somewhere inside that portal run. The
      // stranded and full-frame triggers stay: those are reactive rescues.
      const netherEntered = readTeamEarned(BOT_ROSTER.map((b) => b.name)).has("story/enter_the_nether");
      const cooledDown = Date.now() - this.lastPortalOverrideMs > 300_000;
      // Run 706: this rescue runs ahead of the heal-eat rule, and Mason sat
      // stranded at 0 hunger and a quarter heart with three bread aboard for
      // two hours while it refired every five minutes. A hurt bot with food
      // eats first; the march home follows.
      const needsMealFirst = this.bot.health < 14 && this.bot.food < 18 && this.hasEdibleAboard();
      if (
        ((holdsDoorwayPick && !litPortalNearby && !netherEntered) || holdsFullFrame || strandedInNether) &&
        cooledDown &&
        !needsMealFirst
      ) {
        this.lastPortalOverrideMs = Date.now();
        this.log.info(
          "Brain",
          `OVERRIDE: ${strandedInNether ? "stranded in the Nether" : holdsFullFrame ? "full portal frame in the pack" : "diamond pickaxe in hand"} — running build_nether_portal`,
        );
        this.events.onThought("The pick that opens the Nether is in my hand. To the doorway!");
        const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "build_nether_portal" });
        this.events.onAction("build_nether_portal", result);
        this.lastAction = "build_nether_portal";
        this.lastResult = result;
        this.trackFailure(
          "skill:build_nether_portal",
          { action: "build_nether_portal", params: {} },
          result,
          /lit|ignit|portal|cleared|complete/i.test(result),
        );
        return;
      }
    }

    // Survival override: starvation was killing the team (whole roster at
    // hunger 0, 286 failed "eat" attempts in one run). If hungry with no food
    // on hand, withdraw food from the stash so auto-eat has fuel — no waiting
    // on the LLM to figure out the farm→bake→eat loop.
    const FOOD_NAMES = [
      "bread",
      "cooked_beef",
      "cooked_porkchop",
      "cooked_chicken",
      "cooked_mutton",
      "apple",
      "carrot",
      "baked_potato",
    ];
    if (config.bot.allowInterventions && this.bot.food <= 10 && this.roleConfig.stashPos) {
      const hasFood = this.bot.inventory.items().some((i) => FOOD_NAMES.some((f) => i.name.includes(f)));
      if (!hasFood) {
        // Survival safety net. Routing starving bots to a chest proved
        // hopeless — withdraw_stash's pathfinding fails ("Path was stopped")
        // even after teleporting them onto the stash, so distant bots starved
        // to death on loop (Atlas repeatedly hit hunger 0). Like keepInventory
        // and the safety teleports, this is a survival floor, not a gameplay
        // mechanic: give a small ration directly (bots are ops) so auto-eat
        // has fuel. The farm/cooking economy still runs for real food.
        // Saturation EFFECT, not an item: /give depends on inventory + auto-eat
        // timing and left Forge stuck at hunger 4. The effect refills hunger
        // directly with zero dependencies — the bulletproof survival floor.
        // Also hand over a few cooked_beef so they have reserves to eat normally.
        this.log.info("Brain", `SURVIVAL: hungry (${this.bot.food}/20), no food — saturation ration`);
        this.bot.chat(`/effect give ${this.bot.username} minecraft:saturation 2 3 true`);
        this.bot.chat(`/give ${this.bot.username} minecraft:cooked_beef 4`);
        await new Promise((r) => setTimeout(r, 600));
        this.events.onAction("eat", "Survival ration — recovered hunger.");
        this.lastAction = "eat";
        this.lastResult = "Recovered hunger with a ration.";
        return;
      }
    }

    // Leash hard override — skip LLM entirely if way too far from home
    if (this.homePos && this.roleConfig.leashRadius > 0) {
      const dx = this.bot.entity.position.x - this.homePos.x;
      const dz = this.bot.entity.position.z - this.homePos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= this.roleConfig.leashRadius * 1.5) {
        this.log.info("Brain", `LEASH: ${dist.toFixed(0)} blocks away — forcing return home`);
        const result = await this.executeActionUnlessPaused("go_to", this.homePos);
        this.events.onAction("go_to", result);
        return;
      }
    }

    // Stash bootstrap override — deterministic, like the leash. The LLM
    // reliably circles this goal (hand-placing chests, re-gathering wood)
    // without ever picking setup_stash, so when the preconditions are met
    // we just run it.
    if (
      config.bot.allowStrategyOverrides &&
      this.roleConfig.allowedSkills.includes("setup_stash") &&
      this.roleConfig.stashPos &&
      !this.recentFailures.has("skill:setup_stash")
    ) {
      const { x, y, z } = this.roleConfig.stashPos;
      const nearStash = this.bot.entity.position.distanceTo(new Vec3(x, y, z)) < 64;
      const chestAtStash = this.bot.findBlock({
        matching: (b) => b.name === "chest" || b.name === "trapped_chest",
        maxDistance: 16,
        point: new Vec3(x, y, z),
      });
      const logsAndPlanks = this.bot.inventory
        .items()
        .reduce(
          (s, i) => s + (i.name.endsWith("_log") ? i.count * 4 : 0) + (i.name.endsWith("_planks") ? i.count : 0),
          0,
        );
      const chestsHeld = this.bot.inventory
        .items()
        .filter((i) => i.name === "chest")
        .reduce((s, i) => s + i.count, 0);
      if (nearStash && !chestAtStash && (logsAndPlanks >= 16 || chestsHeld >= 2)) {
        this.log.info("Brain", "OVERRIDE: materials ready and no stash chest — running setup_stash");
        this.events.onThought("The Stash must rise. I have the materials. No more excuses.");
        const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "setup_stash", x, y, z });
        this.events.onAction("setup_stash", result);
        this.lastAction = "setup_stash";
        this.lastResult = result;
        this.trackFailure(
          "skill:setup_stash",
          { action: "setup_stash", params: {} },
          result,
          /bootstrapped|already/i.test(result),
        );
        return;
      }
    }

    // Pack hygiene: a seed glut. Run 679: Flora carried 34 stacks of wheat
    // seeds and Mason 15, every slot, so meat, logs and drops could not be
    // picked up and hunts ended "+0 meat". Keep one stack for replanting and
    // toss the rest; the stash keep rule now banks surplus too, but a bot
    // far from home needs the slots now.
    if (Date.now() - this.lastSeedShedMs > 300_000) {
      const seedStacks = this.bot.inventory.items().filter((i) => i.name === "wheat_seeds");
      const seedTotal = seedStacks.reduce((n, i) => n + i.count, 0);
      if (seedTotal > 192) {
        this.lastSeedShedMs = Date.now();
        const freeBefore = this.bot.inventory.emptySlotCount();
        let tossed = 0;
        for (const st of seedStacks.sort((a, b) => a.count - b.count)) {
          if (seedTotal - tossed - st.count < 64) break;
          try {
            await this.bot.toss(st.type, null, st.count);
            tossed += st.count;
          } catch {
            break;
          }
        }
        console.log(
          `[Pack] ${this.bot.username}: tossed ${tossed} wheat seeds (kept ${seedTotal - tossed}), free slots ${freeBefore} -> ${this.bot.inventory.emptySlotCount()}`,
        );
      }
    }

    // Hole cap override (runs 658-661: a one-wide shaft beside the village
    // crafting table, (297, 50..69, -315), killed Flora twice, Mason and
    // Blade in four hours). Any bot at home with a spare block caps the top
    // of a shaft deeper than six blocks, the way a player would.
    if (
      config.bot.allowStrategyOverrides &&
      !isSkillRunning(this.bot) &&
      this.roleConfig.stashPos &&
      Date.now() - this.lastCapMs > 600_000
    ) {
      const sp = this.roleConfig.stashPos;
      const me = this.bot.entity.position;
      const homeGapCap = Math.hypot(me.x - sp.x, me.z - sp.z);
      const filler = this.bot.inventory
        .items()
        .find((i) => ["cobblestone", "dirt", "cobbled_deepslate", "stone"].includes(i.name));
      // Run 663: the finder scanned 14 blocks around the stash at the bot's
      // own height, so a miner at y=10 chased cave holes and the crafting
      // table shaft 18 blocks out was never in scope. Scan 20 blocks at the
      // stash's surface band, from the surface only, deepest hole first.
      const onSurface = Math.abs(me.y - sp.y) <= 6;
      if (homeGapCap < 24 && filler && onSurface) {
        const hole = this.findDeepHole(sp, 20);
        if (hole) {
          this.lastCapMs = Date.now();
          this.log.info(
            "Brain",
            `OVERRIDE: a ${hole.depth}-deep hole at (${hole.x}, ${hole.top}, ${hole.z}) beside home — capping it with ${filler.name}`,
          );
          const result = await this.capHole(hole, filler.name);
          this.events.onAction("cap_hole", result);
          this.lastAction = "cap_hole";
          this.lastResult = result;
          return;
        }
      }
    }

    // Farm bootstrap override — deterministic, like the stash. Flora spent
    // 45 minutes in the wood-acquisition layer without once invoking
    // build_farm; the skill is now fully self-sufficient (travels to the
    // lake, chops its own logs, crafts the hoe), so when there's no farm
    // yet we just run it.
    // NOTE: deliberately NOT gated on recentFailures. The override's whole
    // job is to force the farm past the LLM's avoidance and past stale
    // precondition blocks (the chunk-load bug recorded many "No water found"
    // failures that pre-loaded as a blacklist entry every restart, which then
    // blocked the override from ever firing). Cooldown alone bounds retries.
    if (
      config.bot.allowStrategyOverrides &&
      this.roleConfig.allowedSkills.includes("build_farm") &&
      !isSkillRunning(this.bot)
    ) {
      const hasFarm = getAllMemoryStores().some((st) =>
        st.hasStructureNearby(
          "farm",
          this.bot.entity.position.x,
          this.bot.entity.position.y,
          this.bot.entity.position.z,
          300,
        ),
      );
      // No day-gate: a Minecraft day is only ~20 real minutes, so day-gating
      // meant the farm rarely got a window — crops grow fine at night and the
      // skill handles its own safety. Cooldown alone prevents thrash.
      //
      // HARVEST, not just build. The override used to fire only when NO farm
      // existed, so the farm was built once and never revisited — wheat grew to
      // maturity and rotted in place because the model never chose build_farm to
      // harvest it, and the team starved beside a full field (census: zero bread
      // anywhere, bots hunting nonexistent food for a whole hour). build_farm
      // already harvests mature wheat and bakes it into bread when re-run, so
      // fire it periodically once a farm exists too — slower (8 min, matched to
      // crop growth) than the initial build (4 min).
      const cooldownMs = hasFarm ? 480_000 : 240_000;
      const cooledDown = Date.now() - this.lastFarmOverrideMs > cooldownMs;
      // Run 647: Atlas at 218 blocks and Flora at 184 blocks took the override,
      // walked 90 s toward the site and timed out, three times in the hour.
      // The walk-home reflex brings a far bot back; the farm waits for it.
      const farmGap = Math.hypot(this.bot.entity.position.x - FARM_SITE.x, this.bot.entity.position.z - FARM_SITE.z);
      if (cooledDown && farmGap > 120) {
        this.log.info("Brain", `Farm override skipped: ${Math.round(farmGap)} blocks from the farm site`);
      } else if (cooledDown) {
        this.lastFarmOverrideMs = Date.now();
        this.log.info(
          "Brain",
          hasFarm
            ? "OVERRIDE: tending the farm — running build_farm to harvest and bake"
            : "OVERRIDE: no farm exists — running build_farm (self-sufficient)",
        );
        this.events.onThought(
          hasFarm
            ? "The wheat is calling. Time to harvest and bake the team some bread."
            : "The fields call to me. Today the farm gets BUILT — no more excuses.",
        );
        const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "build_farm", ...FARM_SITE });
        this.events.onAction("build_farm", result);
        this.lastAction = "build_farm";
        this.lastResult = result;
        this.trackFailure(
          "skill:build_farm",
          { action: "build_farm", params: {} },
          result,
          /complete|harvest|planted/i.test(result),
        );
        return;
      }
    }

    // Wax-copper override — RUNS BEFORE frontier mining. Once Forge has banked
    // enough copper and iron (or the finished shears/block), stop mining and go
    // earn Wax On: it needs only a copper block, a honeycomb sheared from the
    // full hive the roamers reach, and no Nether or piglins at all. Fires ahead
    // of mine_frontier so a stocked bot cashes in instead of digging forever.
    if (
      config.bot.allowStrategyOverrides &&
      !isSkillRunning(this.bot) &&
      this.bot.username === "Forge" &&
      this.roleConfig.allowedSkills.includes("wax_copper") &&
      /overworld/.test(String(this.bot.game.dimension))
    ) {
      const earnedWax = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      const waxDone = earnedWax.has("husbandry/wax_on") || earnedWax.has("minecraft:husbandry/wax_on");
      const held = (n: string) =>
        this.bot.inventory
          .items()
          .filter((i) => i.name === n)
          .reduce((s, i) => s + i.count, 0);
      const hasCopper = held("copper_block") >= 1 || held("copper_ingot") >= 9;
      const hasShearMakings = held("shears") >= 1 || held("iron_ingot") >= 2;
      // While a nest is refilling nearby, retry every 2.5 min instead of 10:
      // the nest at 452,72,-361 went 0→2 in ten minutes after a harvest.
      const cooledWax = Date.now() - this.lastWaxMs > (this.waxWaiting() ? 150_000 : 600_000);
      // Only fire near the hive. Wax fired from anywhere pinned a stranded
      // Forge in a dead loop 357 blocks out that the walk could never close —
      // the route from the west side of base to the hive crosses impassable
      // water. Gated to the hive/frontier neighbourhood, wax runs the short,
      // roamer-proven hop it was designed for; when Forge is elsewhere, the
      // walk-home + frontier-ferry reflexes reposition him east first.
      const nest = nearestNest(this.bot.entity.position.x, this.bot.entity.position.z);
      const nearHive = Math.hypot(this.bot.entity.position.x - nest.x, this.bot.entity.position.z - nest.z) < 140;
      if (!waxDone && hasCopper && hasShearMakings && cooledWax && nearHive) {
        this.lastWaxMs = Date.now();
        this.log.info("Brain", "OVERRIDE: enough copper banked — going to wax a block for Wax On");
        this.events.onThought("Copper in my pack and a hive full of honeycomb. Time to earn Wax On.");
        const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "wax_copper" });
        // "not full yet" with a level above zero means bees are working it:
        // stay in the neighbourhood for 20 min rather than going underground.
        const refilling = /at [1-4]\/5/.test(result) || /honey [1-4]\/5/.test(result);
        this.waxWaitingUntil = refilling ? Date.now() + 1_200_000 : 0;
        if (refilling) this.log.info("Brain", "Wax: a nest is refilling — holding near it, mining reflexes paused");
        this.events.onAction("wax_copper", result);
        this.lastAction = "wax_copper";
        this.lastResult = result;
        return;
      }
    }

    // Wax Off override — Forge only, after Wax On. The waxed block stands by
    // the third nest; one axe swing earns the point.
    if (
      config.bot.allowStrategyOverrides &&
      !isSkillRunning(this.bot) &&
      this.bot.username === "Forge" &&
      this.roleConfig.allowedSkills.includes("wax_off") &&
      /overworld/.test(String(this.bot.game.dimension))
    ) {
      const e = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      const onDone = e.has("husbandry/wax_on") || e.has("minecraft:husbandry/wax_on");
      const offDone = e.has("husbandry/wax_off") || e.has("minecraft:husbandry/wax_off");
      const cooled = Date.now() - this.lastWaxOffMs > 600_000;
      const waxed = knownWaxedBlocks().sort(
        (a, b) =>
          Math.hypot(a.x - this.bot.entity.position.x, a.z - this.bot.entity.position.z) -
          Math.hypot(b.x - this.bot.entity.position.x, b.z - this.bot.entity.position.z),
      )[0];
      const nearBlock =
        !!waxed && Math.hypot(this.bot.entity.position.x - waxed.x, this.bot.entity.position.z - waxed.z) < 220;
      const fitWax = this.bot.food >= 10;
      if (onDone && !offDone && cooled && nearBlock && fitWax) {
        this.lastWaxOffMs = Date.now();
        this.log.info("Brain", "OVERRIDE: Wax On banked, Wax Off open — scraping the block by the nest");
        this.events.onThought("That waxed block by the hive owes me one more point. Axe time.");
        const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "wax_off" });
        this.events.onAction("wax_off", result);
        this.lastAction = "wax_off";
        this.lastResult = result;
        this.trackFailure("skill:wax_off", { action: "wax_off", params: {} }, result, /Scraped/.test(result));
        return;
      }
    }

    // Bee Our Guest override — Forge only, after Wax Off. Phase A needs the
    // stash (glass), phase B needs the nest (campfire + bottle).
    if (
      config.bot.allowStrategyOverrides &&
      !isSkillRunning(this.bot) &&
      this.bot.username === "Forge" &&
      this.roleConfig.allowedSkills.includes("harvest_honey") &&
      /overworld/.test(String(this.bot.game.dimension))
    ) {
      const e = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      const honeyDone = e.has("husbandry/safely_harvest_honey") || e.has("minecraft:husbandry/safely_harvest_honey");
      const offDone = e.has("husbandry/wax_off") || e.has("minecraft:husbandry/wax_off");
      const cooled = Date.now() - this.lastHoneyMs > 600_000;
      const hasBottle = this.bot.inventory.items().some((i) => i.name === "glass_bottle");
      const sp = this.roleConfig.stashPos;
      const nearStash = !!sp && Math.hypot(this.bot.entity.position.x - sp.x, this.bot.entity.position.z - sp.z) < 60;
      const nest = nearestNest(this.bot.entity.position.x, this.bot.entity.position.z);
      const nearNest = Math.hypot(this.bot.entity.position.x - nest.x, this.bot.entity.position.z - nest.z) < 220;
      const fit = this.bot.food >= 10;
      if (offDone && !honeyDone && cooled && fit && (hasBottle ? nearNest : nearStash)) {
        this.lastHoneyMs = Date.now();
        this.log.info(
          "Brain",
          `OVERRIDE: Bee Our Guest open — ${hasBottle ? "bottling honey at the nest" : "fetching glass for a bottle"}`,
        );
        this.events.onThought(
          hasBottle ? "Bottle in hand. The bees owe me some honey." : "A glass bottle first, then the hive.",
        );
        const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "harvest_honey" });
        this.events.onAction("harvest_honey", result);
        this.lastAction = "harvest_honey";
        this.lastResult = result;
        this.trackFailure(
          "skill:harvest_honey",
          { action: "harvest_honey", params: {} },
          result,
          /Bottled honey/.test(result),
        );
        return;
      }
    }

    // Frontier-mine override — RUNS BEFORE base strip_mine. The village
    // ground is a mined-out honeycomb ringed by water: strip_mine there logs
    // "couldn't reach fresh rock" trip after trip and the swarm produced
    // almost no ore for days. An RCON survey found solid un-mined ore-bearing
    // rock in the fresh forest the roamers reach (~450,-420). So the miner
    // ferries out there and mines fresh ground instead of shafting the dead
    // base. Long cooldown — it is a full round-trip — and only while short on
    // iron, since the whole point is to restart the iron→armour supply.
    if (
      config.bot.allowStrategyOverrides &&
      !isSkillRunning(this.bot) &&
      this.bot.username === "Forge" &&
      this.roleConfig.allowedSkills.includes("mine_frontier") &&
      /overworld/.test(String(this.bot.game.dimension))
    ) {
      const ironHeld = this.bot.inventory
        .items()
        .filter((i) => i.name === "iron_ingot" || i.name === "raw_iron")
        .reduce((s, i) => s + i.count, 0);
      const cooledFrontier = Date.now() - this.lastFrontierMs > 900_000 && !this.waxWaiting();
      const spF = this.roleConfig.stashPos;
      const nearBaseF =
        !!spF && Math.hypot(this.bot.entity.position.x - spF.x, this.bot.entity.position.z - spF.z) < 60;
      // The frontier is also Forge's ride EAST toward the hive: it drops him at
      // (450,-420), ~34 blocks from the bee nest. A Forge already stocked with
      // iron but carrying the copper for an un-earned Wax On would otherwise
      // have no reflex to carry him out there, so ferry him regardless of iron
      // when he has a wax to go do — the frontier trip lands him next to the
      // hive, where the (now hive-gated) wax reflex takes over.
      const copperForWax =
        this.bot.inventory
          .items()
          .filter((i) => i.name === "copper_block" || i.name === "copper_ingot")
          .reduce((s, i) => s + (i.name === "copper_block" ? 9 : i.count), 0) >= 9;
      const earnedF = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      const waxStillOpen = !earnedF.has("husbandry/wax_on") && !earnedF.has("minecraft:husbandry/wax_on");
      const wantsFrontier = ironHeld < 8 || (copperForWax && waxStillOpen);
      // Fed and healthy first: run 530 ferried Forge out and dove him to
      // y=-38 at 2 hearts and 0 food while the hunger override waited for
      // daylight.
      const fitF = this.bot.food >= 10; // health only returns above 18 food, so gate on food alone
      if (wantsFrontier && cooledFrontier && nearBaseF && fitF && !this.tradeReady()) {
        this.lastFrontierMs = Date.now();
        this.log.info("Brain", "OVERRIDE: base is mined out — ferrying to the frontier for fresh ore");
        this.events.onThought("Nothing left to dig here. To the fresh rock out east.");
        const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "mine_frontier" });
        this.events.onAction("mine_frontier", result);
        this.lastAction = "mine_frontier";
        this.lastResult = result;
        return;
      }
    }

    // Iron/strip-mine override — same deterministic pattern. The miner has
    // strip_mine (staircases to Y=11, mines for ore) but the LLM won't pick it
    // for the iron goal, so Forge mines surface dirt and the team never gets
    // iron. When the miner has a pickaxe and no iron yet, run strip_mine. This
    // both advances the iron-age goal AND generates the iron/ore trajectories
    // the v2 dataset is starved of.
    if (
      config.bot.allowStrategyOverrides &&
      this.roleConfig.allowedSkills.includes("strip_mine") &&
      !isSkillRunning(this.bot)
    ) {
      // CRAFTABLE iron only: the old any-iron_* match counted the iron
      // shovels minted during the bad-budget era, so shovel-carrying miners
      // read as iron-rich and the push stood down for a full hour. Tools in
      // the hand are not ingots for the pickaxe.
      const hasIron = this.bot.inventory.items().some((i) => i.name === "iron_ingot" || i.name === "raw_iron");
      // No pickaxe requirement anymore: the skill self-supplies its pick
      // (withdraws stash cobble, crafts inline) — requiring one here meant
      // a toolless miner could never trigger the very push that would have
      // equipped him.
      // Diamond leg: once a miner owns an iron+ pick, having iron is no
      // longer a reason to stay home — the mission needs 3 diamonds and
      // strip_mine already dives to y=-58 with that pick. Run 371 proved the
      // gap: the iron push stood down (everyone had iron) and mining stopped
      // COLD — one strip_mine start all run while Blade "explored" for
      // diamonds on the surface.
      const holdsIronPick = this.bot.inventory
        .items()
        .some((i) => i.name === "iron_pickaxe" || i.name === "diamond_pickaxe" || i.name === "netherite_pickaxe");
      const diamonds = this.bot.inventory
        .items()
        .filter((i) => i.name === "diamond")
        .reduce((s, i) => s + i.count, 0);
      const hasDiamondPick = this.bot.inventory
        .items()
        .some((i) => i.name === "diamond_pickaxe" || i.name === "netherite_pickaxe");
      // The dive used to stand down for good once the diamond pickaxe existed —
      // its job was the pick's 3 diamonds. But craft_gear's tool loop then
      // spent the table's reserve on a diamond shovel, leaving 0 in pocket:
      // the enchanting table still needs 2, and only this override sends a
      // miner to diamond depth. Keep diving while the Enchanter chain is
      // unearned and the pocket holds fewer than the table's 2 — with the
      // diamond pick those dives are fast and cheap.
      const tableNeedsDiamonds =
        this.roleConfig.allowedSkills.includes("setup_enchanting") &&
        !readTeamEarned(BOT_ROSTER.map((b) => b.name)).has("story/enchant_item");
      // Dive target matches the CRAFT threshold: while the Enchanter chain is
      // unearned the pick-craft waits for 5 (3 pick + 2 table), so stopping
      // the dive at 3 stranded Forge between thresholds — 3 in pocket, no
      // pick minted, no push to fetch the last 2.
      const wantsDive =
        (holdsIronPick && !hasDiamondPick && diamonds < (tableNeedsDiamonds ? 5 : 3)) ||
        (hasDiamondPick && tableNeedsDiamonds && diamonds < 2);
      // A pickless miner MUST mine — strip_mine self-supplies a pick (crafts a
      // wooden one, withdraws a banked spare). Without this, a crafter-miner who
      // wears out his pick mid-dive and holds a single leftover ingot lands in a
      // dead zone: that 1 ingot marks him "iron-rich" so the push stands down,
      // 1 ingot is short of a pickaxe's 3, and pickless he cannot mine more — so
      // the model flails (Forge chased an ender-eye quest for an hour). Any bot
      // with strip_mine that holds no pickaxe re-arms first.
      const pickless = !this.bot.inventory.items().some((i) => i.name.endsWith("_pickaxe"));
      // A non-smith carrying a diamond must NOT start another 15-minute mining
      // trip: this override sits above the tool-return reflex in the decision
      // order, so an iron-less Mason with 3 vein diamonds re-entered strip_mine
      // on every tick and the hand-off to the smith never got a turn. Skip
      // mining for one tick and let the diamond route first.
      const carryingDiamondForSmith =
        !this.roleConfig.primarySmith && this.bot.inventory.items().some((i) => i.name === "diamond");
      const cooledDown = Date.now() - this.lastIronOverrideMs > 180_000 && !(this.waxWaiting() && !pickless);
      // Run 631: Forge was pickless for over an hour with only coal aboard
      // and food 3, so this gate never let the re-arm run; he dug out of
      // caves by hand three times and died to a wall, a lake and lava. A
      // pickless miner re-arms whatever his hunger; strip_mine supplies the
      // pick from the stash before it digs.
      const fitDive = this.bot.food >= 10 || pickless;
      // Run 599: Forge left the village fields with 37 potatoes, started a
      // strip mine at (469, 11, -502) and died five times; the team's food
      // went with him. A courier carrying a pantry load far from home walks
      // home first (the walk-home override above) and mines after banking.
      const spMine = this.roleConfig.stashPos;
      const groceriesFar =
        !!spMine &&
        this.pantryAboard() >= 12 &&
        Math.hypot(this.bot.entity.position.x - spMine.x, this.bot.entity.position.z - spMine.z) > 120;
      if (
        (!hasIron || wantsDive || pickless) &&
        !carryingDiamondForSmith &&
        cooledDown &&
        fitDive &&
        !groceriesFar &&
        !this.tradeReady()
      ) {
        this.lastIronOverrideMs = Date.now();
        this.log.info(
          "Brain",
          wantsDive
            ? `OVERRIDE: ${hasDiamondPick ? "diamond" : "iron"} pick + ${diamonds}/${hasDiamondPick ? 2 : tableNeedsDiamonds ? 5 : 3} diamonds — diving to diamond depth`
            : pickless
              ? "OVERRIDE: pickless — running strip_mine to re-arm and mine"
              : "OVERRIDE: no iron yet — running strip_mine for ore",
        );
        this.events.onThought(
          wantsDive
            ? "Iron pick in hand and diamonds waiting at the bottom of the world. DIVE."
            : pickless
              ? "No pickaxe in hand — back to the mine to forge a fresh one."
              : "The deep calls. Time to carve for iron — pickaxe in hand, downward!",
        );
        const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "strip_mine" });
        this.events.onAction("strip_mine", result);
        this.lastAction = "strip_mine";
        this.lastResult = result;
        this.trackFailure(
          "skill:strip_mine",
          { action: "strip_mine", params: {} },
          result,
          /mined|ore|iron|complete/i.test(result),
        );
        return;
      }
    }

    // Village-lighting override. Mob spawns need block-light 0 and one torch
    // clears ~12 blocks (domain research), yet light_area was invoked ZERO
    // times in run 361 while the fleet logged 152 flees in an hour and both
    // hike attempts of every mining trip died to "goal was changed" — the
    // reactive layer seizing the pathfinder to run from mobs that spawned in
    // the unlit village. Torching the base is the standard human answer;
    // deterministic here because the model never chooses it. Daytime only
    // (torch-placing during a night flee storm is chaos), near the stash,
    // 40-minute cooldown — the grid is idempotent so repeats are cheap.
    if (
      config.bot.allowStrategyOverrides &&
      this.roleConfig.allowedSkills.includes("light_area") &&
      !isSkillRunning(this.bot) &&
      this.roleConfig.stashPos
    ) {
      const tod = this.bot.time?.timeOfDay ?? 0;
      const p = this.bot.entity.position;
      const nearStash = Math.hypot(p.x - this.roleConfig.stashPos.x, p.z - this.roleConfig.stashPos.z) < 30;
      const cooledDown = Date.now() - this.lastLightOverrideMs > 2_400_000;
      if (tod < 12000 && nearStash && cooledDown) {
        this.lastLightOverrideMs = Date.now();
        this.log.info("Brain", "OVERRIDE: daylight at the unlit village — running light_area");
        this.events.onThought("Enough midnight ambushes. Today this village gets TORCHES.");
        const result = await this.executeActionUnlessPaused("invoke_skill", {
          skill: "light_area",
          stashPos: this.roleConfig.stashPos,
        });
        this.events.onAction("light_area", result);
        this.lastAction = "light_area";
        this.lastResult = result;
        this.trackFailure(
          "skill:light_area",
          { action: "light_area", params: {} },
          result,
          /placed|torch/i.test(result),
        );
        return;
      }
    }

    // Opportunistic leather reflex — EVERY bot is a scout for the book.
    // Forge's own hunt sweeps out from the stash, but the animals spawn
    // wherever they like: the one cow that ever came in range wandered off
    // between skill firings, and a horse got eaten with a zero-leather drop.
    // Five pairs of eyes beat one; any bot that can SEE a leather-bearing
    // animal while the Enchanter is unearned takes the shot. The leather then
    // reaches Forge via the routing reflex below or the stash ledger.
    if (config.bot.allowStrategyOverrides && !isSkillRunning(this.bot)) {
      const earned = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      const enchanterDone = earned.has("story/enchant_item") || earned.has("minecraft:story/enchant_item");
      const holdsLeather = this.bot.inventory.items().some((i) => i.name === "leather");
      const cooled = Date.now() - this.lastLeatherHuntMs > 180_000;
      if (!enchanterDone && !holdsLeather && cooled) {
        const { nearestLeatherDropper } = await import("../skills/hunt-leather.js");
        const prey = nearestLeatherDropper(this.bot);
        if (prey && this.bot.entity.position.distanceTo(prey.position) < 24) {
          this.lastLeatherHuntMs = Date.now();
          this.log.info("Brain", `OVERRIDE: ${prey.name} in sight and the book still needs leather — hunting`);
          this.events.onThought(`A ${prey.name}! That's the book's leather walking around right there.`);
          const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "hunt_leather" });
          this.events.onAction("hunt_leather", result);
          this.lastAction = "hunt_leather";
          this.lastResult = result;
          return;
        }
      }
    }

    // Pocket-hygiene reflex — a bot with ZERO free slots silently refuses
    // every ground pickup: hand-off catches, mined ore, hunt drops. The
    // giver-side sheds fixed half the economy; five straight missed payroll
    // catches say the RECIPIENT side needs the same medicine. All bots,
    // cheap check, ten-minute cadence.
    if (
      config.bot.allowStrategyOverrides &&
      !isSkillRunning(this.bot) &&
      this.bot.inventory.emptySlotCount() === 0 &&
      Date.now() - this.lastPocketShedMs > 600_000
    ) {
      this.lastPocketShedMs = Date.now();
      const { shedJunk } = await import("./navigation.js");
      const shed = await shedJunk(this.bot, 2);
      if (shed > 0) {
        this.log.info("Brain", `Pocket hygiene: shed ${shed} junk stacks — pickups work again`);
        return;
      }
    }

    // NETHER-RETURN reflex — the walk-home reflex is overworld-only (correct:
    // Nether coords are 1:8), which left a gap: a bot idle in the Nether had
    // NO way out. Atlas sat stranded at one nether spot for two cycles,
    // LLM-flailing 1000+ mine/explore/flee actions, because the fortress
    // reflex only fires near the village and walk-home skips the Nether. Any
    // idle bot in the Nether now runs return_from_nether (find the portal
    // within 64, else march to the frame's 1:8 nether-side address and
    // cross). Gets stranded searchers home, where the fortress cycle resumes.
    if (config.bot.allowStrategyOverrides && !isSkillRunning(this.bot)) {
      const inNether = /the_nether/.test(String(this.bot.game.dimension));
      const cooledReturn = Date.now() - this.lastNetherReturnMs > 60_000;
      if (inNether && cooledReturn) {
        this.lastNetherReturnMs = Date.now();
        this.log.info("Brain", "OVERRIDE: idle in the Nether — returning to the overworld");
        this.events.onThought("Nothing more to do down here. Back through the portal.");
        const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "return_from_nether" });
        this.events.onAction("return_from_nether", result);
        this.lastAction = "return_from_nether";
        this.lastResult = result;
        return;
      }
    }

    // Portal-relight reflex — the entire Nether strategy (fortress hunt,
    // ghast deflect, piglin lottery) died silently this hour because the
    // village portal went DARK: a ghast fireball (or stray water) snuffed the
    // 8-block obsidian frame at ~294,72,-310, and find_fortress kept reporting
    // "no portal within 64". The frame still stands, so this is a relight, not
    // a rebuild. Any portal-capable bot near the village that sees standing
    // obsidian but no lit portal fires build_nether_portal, which resumes to
    // the ignition step. Gated on the fortress being unearned so it stops
    // once the Nether work is done.
    if (
      config.bot.allowStrategyOverrides &&
      !isSkillRunning(this.bot) &&
      this.roleConfig.allowedSkills.includes("build_nether_portal") &&
      this.roleConfig.stashPos
    ) {
      const earnedPortal = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      const fortDoneP = earnedPortal.has("nether/find_fortress") || earnedPortal.has("minecraft:nether/find_fortress");
      const spP = this.roleConfig.stashPos;
      const nearVillageP = Math.hypot(this.bot.entity.position.x - spP.x, this.bot.entity.position.z - spP.z) < 45;
      const litPortal = this.bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 48 });
      const frame = this.bot.findBlock({ matching: (b) => b.name === "obsidian", maxDistance: 48 });
      const cooledP = Date.now() - this.lastPortalRelightMs > 300_000;
      if (!fortDoneP && nearVillageP && !litPortal && frame && cooledP) {
        this.lastPortalRelightMs = Date.now();
        this.log.info(
          "Brain",
          "OVERRIDE: village portal is dark and the frame stands — relighting for the Nether work",
        );
        this.events.onThought("The doorway went out. Relighting it.");
        const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "build_nether_portal" });
        this.events.onAction("build_nether_portal", result);
        this.lastAction = "build_nether_portal";
        this.lastResult = result;
        return;
      }
    }

    // Bastion-loot reflex (Mason) — takes priority over the fortress hunt
    // below because it is actually reachable. The server locates the fortress
    // 622 blocks out in the lava-locked direction (unreachable, pure death
    // tax), but the bastion sits at nether (320,-304), ~387 blocks the other
    // way, and we already earned find_bastion by entering it. Opening one of
    // its loot chests banks Those Were the Days and can drop a saddle (ride a
    // strider) or crying obsidian (respawn anchor) — two more advancements.
    if (
      config.bot.allowStrategyOverrides &&
      !isSkillRunning(this.bot) &&
      (this.bot.username === "Mason" || this.bot.username === "Forge") &&
      this.roleConfig.allowedSkills.includes("loot_bastion")
    ) {
      const earnedBastion = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      const bastionDone =
        earnedBastion.has("nether/loot_bastion") || earnedBastion.has("minecraft:nether/loot_bastion");
      const cooledBastion = Date.now() - this.lastBastionMs > 1_200_000;
      const spBastion = this.roleConfig.stashPos;
      const nearStashBastion =
        !!spBastion &&
        /overworld/.test(String(this.bot.game.dimension)) &&
        Math.hypot(this.bot.entity.position.x - spBastion.x, this.bot.entity.position.z - spBastion.z) < 40;
      // Armor gate: a naked Mason walked into the bastion's piglins 12 times
      // for 8 deaths and 0 loot. The expedition only makes sense once he can
      // survive it, so it stands down until at least two armor pieces are worn
      // — which also makes the run wait on the iron→armor pipeline being fixed
      // rather than feeding him to the Nether in the meantime.
      const armoredForBastion = this.wornArmorCount() >= 2;
      // GOLD gate: iron/diamond armour does NOT neutralise piglins — only gold
      // does. Armoured Forge reached the bastion twice and both times was shot
      // dead by piglins before opening a real chest, while the 8 failed cross
      // attempts cannibalised the frontier mining that armours the swarm in the
      // first place (a productive session's iron output dropped to zero). So
      // the raid stands down until the bot carries a gold armour piece to wear
      // for neutrality; without one it is the same futility as the naked runs.
      // No gold on any bot today, so this parks the run and lets Forge mine.
      // Run 701: Mason came home from a fortress sweep WEARING the golden
      // boots, and inventory.items() skips the armour slots, so this gate
      // read "no gold" for hours while every other gate was met. Count a
      // piece worn or carried. Same fitness rule as the fortress trip: a
      // hungry, hurt bot dies on the 387-block march before any chest.
      const hasGoldArmour = hasGoldPiece(this.bot);
      const fitForBastion = this.bot.food >= 8 && this.bot.health >= 14;
      // Run 705: Mason reached the bastion and saw the chest 17 blocks below
      // him, with both his pickaxes worn out on the netherrack march and no
      // route the planner would take without digging. The raid needs a pick;
      // the no-pickaxe override arms him before this fires.
      const hasPickForBastion = this.bot.inventory.items().some((i) => /_pickaxe$/.test(i.name));
      if (
        !bastionDone &&
        cooledBastion &&
        nearStashBastion &&
        armoredForBastion &&
        hasGoldArmour &&
        fitForBastion &&
        hasPickForBastion
      ) {
        this.lastBastionMs = Date.now();
        this.log.info("Brain", "OVERRIDE: the bastion is reachable — marching to loot a chest for Those Were the Days");
        this.events.onThought("The fortress is walled off by lava, but the bastion isn't. Time to raid it.");
        const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "loot_bastion" });
        this.events.onAction("loot_bastion", result);
        this.lastAction = "loot_bastion";
        this.lastResult = result;
        return;
      }
    }

    // Fortress-hunt reflex (Atlas) — A Terrible Fortress gates the entire
    // brewing branch (blaze rods, potions, the zombie-villager cure, and
    // through it the parked trading advancement). Atlas is the explorer;
    // each daytime departure sweeps one compass heading from the portal and
    // refires compound into a widening search.
    // TWO searchers now, not one: the fortress is THE bottleneck (100s of
    // sweeps, still zero bricks), and Mason was idle-flailing 300+ explore
    // actions an hour with no task. He already carries build_nether_portal,
    // so he can cross. Two bots sharing the module-level heading rotation
    // naturally split the compass between them, roughly halving expected
    // time-to-fortress. Both gated below on find_fortress being in the role.
    // Atlas pivoted to overworld biome-roaming (cycle 445): the fortress
    // disk around the village portal is exhausted — no fortress in reach, all
    // nether biomes already earned — so his 7-deaths/hr there bought nothing.
    // Mason keeps one lottery ticket + one deflect participant in the Nether.
    const isFortressHunter = this.bot.username === "Mason";
    if (
      config.bot.allowStrategyOverrides &&
      !isSkillRunning(this.bot) &&
      isFortressHunter &&
      this.roleConfig.allowedSkills.includes("find_fortress")
    ) {
      const earnedFort = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      const fortDone = earnedFort.has("nether/find_fortress") || earnedFort.has("minecraft:nether/find_fortress");
      // 45min: the reachable disk from this portal is exhausted, so frequent
      // sweeps just tax Mason with deaths for no new coverage. One occasional
      // lottery ticket (accidental explore advancements, a stray fortress
      // edge) is worth keeping; a fast cadence is not. The real fortress fix
      // is a second portal in fresh territory, a deliberate future build.
      const cooledFort = Date.now() - this.lastFortressMs > 2_700_000;
      const todFort = this.bot.time?.timeOfDay ?? 0;
      const spFort = this.roleConfig.stashPos;
      const nearStashFort =
        !!spFort && Math.hypot(this.bot.entity.position.x - spFort.x, this.bot.entity.position.z - spFort.z) < 40;
      // Run 661: Mason went to the Nether at 0 hunger four times today and
      // died there each time. A fortress trip needs a fed, healthy bot.
      const fitForNether = this.bot.food >= 8 && this.bot.health >= 14;
      if (!fortDone && cooledFort && todFort < 11000 && nearStashFort && this.wornArmorCount() >= 2 && fitForNether) {
        this.lastFortressMs = Date.now();
        this.log.info("Brain", "OVERRIDE: the brewing branch waits on a fortress — running find_fortress");
        this.events.onThought("Somewhere out in that red haze stands a fortress. Today I go look.");
        const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "find_fortress" });
        this.events.onAction("find_fortress", result);
        this.lastAction = "find_fortress";
        this.lastResult = result;
        return;
      }
    }

    // Trade reflex (Forge) — What a Deal! wants one villager trade, but there
    // is no village near our base; the nearest is the plains village ~650
    // blocks out at (608,-496). Forge is the one bot that reliably carries a
    // sellable good (coal, which toolsmiths, armorers, weaponsmiths and
    // fishermen all buy), so he makes the run. Daylight-only and a long
    // cooldown keep this from re-creating a death spike on the long march;
    // the skill's own march runs to completion in one firing (walk-home would
    // otherwise drag him back), and keepInventory means a failed trip is free.
    if (
      config.bot.allowStrategyOverrides &&
      !isSkillRunning(this.bot) &&
      this.bot.username === "Forge" &&
      this.roleConfig.allowedSkills.includes("trade_with_villager") &&
      /overworld/.test(String(this.bot.game.dimension))
    ) {
      const earnedTrade = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      const tradeDone = earnedTrade.has("adventure/trade") || earnedTrade.has("minecraft:adventure/trade");
      const cooledTrade = Date.now() - this.lastTradeMs > 1_800_000;
      const todTrade = this.bot.time?.timeOfDay ?? 0;
      const spTrade = this.roleConfig.stashPos;
      const nearStashTrade =
        !!spTrade && Math.hypot(this.bot.entity.position.x - spTrade.x, this.bot.entity.position.z - spTrade.z) < 40;
      // Coal aboard OR in the stash band: the skill now withdraws 32 before
      // the march (2,882 coal banked while four trips failed for want of it).
      const coalAboard = this.bot.inventory
        .items()
        .filter((i) => i.name === "coal")
        .reduce((s, i) => s + i.count, 0);
      const hasCoal = coalAboard >= 15 || (ledgerKnown() && stashCount("coal", spTrade?.y) >= 16);
      if ((!tradeDone || this.tradeReady()) && cooledTrade && todTrade < 9000 && nearStashTrade && hasCoal) {
        this.lastTradeMs = Date.now();
        this.log.info("Brain", "OVERRIDE: no village nearby — marching to sell coal for What a Deal!");
        this.events.onThought("Coal in my pack, a village on the horizon. Time to strike a deal.");
        const result = await this.executeActionUnlessPaused("invoke_skill", {
          skill: "trade_with_villager",
          keepItems: this.roleConfig.keepItems,
        });
        this.events.onAction("trade_with_villager", result);
        this.lastAction = "trade_with_villager";
        this.lastResult = result;
        return;
      }
    }

    // Biome-roamer reflex (Flora) — her farm and breeding are done, so she
    // becomes the overworld's explorer. Adventuring Time wants every biome
    // visited (she is ~30 of ~50), and a wide roam also scouts the ocean the
    // fish advancement needs and the flowered biomes bees live in. Explore
    // NEW ground: march to a far waypoint on a rotating heading, pushing the
    // frontier outward, dig-capable so terrain does not pin her. The same
    // accidental-advancement engine that just earned Hot Tourist Destinations
    // in the Nether, pointed at the overworld.
    if (
      config.bot.allowStrategyOverrides &&
      !isSkillRunning(this.bot) &&
      (this.bot.username === "Flora" || this.bot.username === "Atlas") &&
      /overworld/.test(String(this.bot.game.dimension))
    ) {
      const cooledRoam = Date.now() - this.lastBiomeRoamMs > 240_000;
      if (cooledRoam) {
        this.lastBiomeRoamMs = Date.now();
        // DIRECTED roam toward the biomes Adventuring Time still needs, not a
        // blind compass sweep. The server locates every unvisited biome 600+
        // blocks out (jungle 1546, badlands 3008, ...), so random headings
        // mostly re-tread visited ground; heading at the nearest missing ones
        // pushes the frontier where the advancement actually lives and sweeps
        // new biomes en route. Coordinates from a `locate biome` survey at the
        // village; roamers rotate through the nearest cluster so they spread
        // instead of funnelling into one lane.
        const BIOME_TARGETS: [number, number][] = [
          [606, 198], // lush_caves ~603
          [958, -602], // frozen_peaks ~731
          [1022, -1530], // stony_peaks
          [926, -1722], // jungle
          [1086, -1914], // bamboo_jungle
          [1790, -666], // savanna_plateau
        ];
        const target = BIOME_TARGETS[this.biomeRoamIdx % BIOME_TARGETS.length];
        this.biomeRoamIdx++;
        const p = this.bot.entity.position;
        const dx = target[0] - p.x;
        const dz = target[1] - p.z;
        const dist = Math.hypot(dx, dz) || 1;
        const tx = Math.round(p.x + (dx / dist) * 140);
        const tz = Math.round(p.z + (dz / dist) * 140);
        this.log.info(
          "Brain",
          `Biome roam: heading toward missing biome at ${target[0]},${target[1]} (next hop ${tx},${tz})`,
        );
        this.events.onThought("New horizons. Let's see what biome lies out there.");
        // Surface-only roaming: plain explorerMoves cannot dig, so it paths
        // OVER the terrain instead of through it. The old dig-capable roam let
        // GoalNearXZ route through caves to any depth — Flora kept ending up at
        // y=-23/-36 underground, dying to zombies and creepers (a 5/hr death
        // spike) and collecting no new biomes down there. Without digging she
        // stays on top where the unvisited biomes actually are; if terrain pins
        // her, the stall-guard below rotates her to the next heading.
        const roamMoves = explorerMoves(this.bot);
        this.bot.pathfinder.setMovements(roamMoves);
        const marchUntil = Date.now() + 120_000;
        const gap = () => Math.hypot(this.bot.entity.position.x - tx, this.bot.entity.position.z - tz);
        let guard = 0;
        while (Date.now() < marchUntil && gap() > 20 && !this.paused) {
          const before = gap();
          await safeGoto(this.bot, new navGoals.GoalNearXZ(tx, tz, 12), 40_000, 12_000).catch(() => {});
          if (before - gap() < 8 && ++guard >= 3) break;
          else if (before - gap() >= 8) guard = 0;
        }
        this.lastAction = "biome_roam";
        return;
      }
    }

    // Bed-claim reflex — honest-spawn era (Jesse's ruling 2026-09-07): the
    // /spawnpoint plumbing is gone, so each bot claims a bed once per
    // session. In modern Java, USING a bed sets the respawn point even in
    // daylight; at night this same click just sleeps, which also sets it.
    if (config.bot.allowStrategyOverrides && !isSkillRunning(this.bot) && !this.bedClaimed) {
      // VILLAGE beds only. The first version claimed the nearest bed
      // anywhere, and wandering bots bound themselves to a frontier
      // structure 270 blocks west — every death then respawned them far
      // from the stash, the portal, and each other, quietly scattering the
      // team (Blade and Forge spent a whole session failing to overlap).
      const spBed = this.roleConfig.stashPos;
      const nearStashBed =
        !!spBed && Math.hypot(this.bot.entity.position.x - spBed.x, this.bot.entity.position.z - spBed.z) < 40;
      // Ground-level beds only. Run 518: a bed placed on top of a rescue
      // tower at (281, 114, -316) was the nearest bed to the stash by 3D
      // distance, and three bots in turn walked up the tower and stalled at
      // y=91..96 trying to reach it.
      const bed = nearStashBed
        ? (() => {
            const groundY = spBed!.y;
            const spots = this.bot
              .findBlocks({ matching: (b) => b.name.endsWith("_bed"), maxDistance: 48, count: 24 })
              .filter((p) => Math.abs(p.y - groundY) <= 10)
              .sort((a, b) => a.distanceTo(this.bot.entity.position) - b.distanceTo(this.bot.entity.position));
            return spots.length > 0 ? this.bot.blockAt(spots[0]) : null;
          })()
        : null;
      const cooledClaim = Date.now() - this.lastBedClaimMs > 180_000;
      if (bed && cooledClaim) {
        this.lastBedClaimMs = Date.now();
        this.log.info("Brain", `Bed-claim: walking to the bed at ${bed.position} for an honest respawn point`);
        await this.executeActionUnlessPaused("go_to", {
          x: bed.position.x,
          y: bed.position.y,
          z: bed.position.z,
        });
        if (this.bot.entity.position.distanceTo(bed.position) < 4) {
          try {
            await this.bot.activateBlock(bed);
            this.bedClaimed = true;
            this.log.info("Brain", "Bed-claim: respawn point set the vanilla way");
          } catch (e) {
            this.log.info("Brain", `Bed-claim failed: ${(e as Error).message}`);
          }
        }
        return;
      }
    }

    // Smith-surplus gold deposit — the routing rails all flow TOWARD the
    // smith, so Forge smelts the team's gold into his own pocket (13 ingots
    // aboard tonight) while Blade's piglin trips beg an empty stash. The
    // smith banks surplus gold whenever he is home; the ledger and Blade's
    // withdraw do the rest.
    if (config.bot.allowStrategyOverrides && !isSkillRunning(this.bot) && this.roleConfig.primarySmith) {
      const goldAboard = this.bot.inventory
        .items()
        .filter((i) => i.name === "gold_ingot")
        .reduce((s, i) => s + i.count, 0);
      const spGold = this.roleConfig.stashPos;
      const nearStashGold =
        !!spGold && Math.hypot(this.bot.entity.position.x - spGold.x, this.bot.entity.position.z - spGold.z) < 40;
      // 5min, down from 10: the custody rail is verifiably lossless now (two
      // missed catches tonight, both fully reclaimed on tape), so a retry
      // costs nothing and the only enemy is Blade being mid-flee at the
      // moment of the toss. More tickets, same lottery.
      const cooledGold = Date.now() - this.lastGoldBankMs > 300_000;
      if (goldAboard >= 4 && nearStashGold && cooledGold) {
        this.lastGoldBankMs = Date.now();
        // DEAD DROP first: ground transfers at the village are a coin flip
        // (a reclaim sweep recovered 0/4 tossed ingots INSIDE the village),
        // so the fund now moves through one designated chest on the proven-
        // walkable farm shore. Give-rail and stash stay as fallbacks.
        {
          const { fundDeposit } = await import("../skills/fund-chest.js");
          const hasChestItem = this.bot.inventory.items().some((i) => i.name === "chest");
          if (!hasChestItem) {
            const { withdrawStash } = await import("../skills/stash.js");
            await withdrawStash(this.bot, this.roleConfig.stashPos!, "chest", 1, 30_000).catch(() => {});
          }
          const fres = await fundDeposit(this.bot, "gold_ingot", 64).catch((e: Error) => `threw: ${e.message}`);
          this.log.info("Brain", `Fund deposit: ${fres}`);
          if (fres.startsWith("Banked")) {
            this.lastAction = "fund_deposit";
            this.lastResult = fres;
            return;
          }
        }
        // Hand-deliver when the spender is in sight: the chest run keeps
        // dying to village-clutter pathfinding ("Stuck" four straight
        // firings), while the point-blank give rail is custody-verified and
        // walks three blocks. Blade is the whole reason the fund exists.
        const blade = this.bot.players["Blade"]?.entity;
        if (blade && this.bot.username !== "Blade" && this.bot.entity.position.distanceTo(blade.position) < 24) {
          this.log.info("Brain", `OVERRIDE: smith holding ${goldAboard} gold — handing it straight to Blade`);
          this.events.onThought("Blade! Payroll for the piglin fund. Catch.");
          const result = await this.executeActionUnlessPaused("give_item", {
            to: "Blade",
            item: "gold_ingot",
            count: 9,
          });
          this.events.onAction("give_item", result);
          this.lastAction = "give_item";
          this.lastResult = result;
          return;
        }
        this.log.info("Brain", `OVERRIDE: smith holding ${goldAboard} gold ingots — banking them for the piglin fund`);
        this.events.onThought("The piglin fund needs this more than my pockets do.");
        // deposit_stash reads its stash from PARAMS — the first five firings
        // passed {} and bounced off "No stash position configured".
        const result = await this.executeActionUnlessPaused("deposit_stash", {
          stashPos: this.roleConfig.stashPos,
          keepItems: this.roleConfig.keepItems,
          canMine: true,
        });
        this.events.onAction("deposit_stash", result);
        this.lastAction = "deposit_stash";
        this.lastResult = result;
        return;
      }
    }

    // Taming reflex — Best Friends Forever, the same shape as the leather
    // hunt: any bot that can SEE a horse/donkey/mule while the advancement
    // is unearned takes a two-minute mounting break. No materials needed;
    // persistence is the whole mechanic.
    if (config.bot.allowStrategyOverrides && !isSkillRunning(this.bot)) {
      const earnedTame = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      const tameDone =
        earnedTame.has("husbandry/tame_an_animal") || earnedTame.has("minecraft:husbandry/tame_an_animal");
      const cooledTame = Date.now() - this.lastTameMs > 300_000;
      if (!tameDone && cooledTame) {
        const { nearestTameable } = await import("../skills/tame-animal.js");
        const mount = nearestTameable(this.bot);
        if (mount && this.bot.entity.position.distanceTo(mount.position) < 32) {
          this.lastTameMs = Date.now();
          this.log.info("Brain", `OVERRIDE: ${mount.name} in sight and nobody has a best friend yet — taming`);
          this.events.onThought(`A ${mount.name}! Time to make a friend the bruise-collecting way.`);
          const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "tame_animal" });
          this.events.onAction("tame_animal", result);
          this.lastAction = "tame_animal";
          this.lastResult = result;
          return;
        }
      }
    }

    // String reflex (Blade only) — Take Aim needs a bow, the bow needs 3
    // string, and the armory audit found zero anywhere while holding 63
    // arrows. Spiders are the source and Blade is the bot built to fight
    // them; everyone else keeps their distance.
    // Runs 605 to 611: the reflex never fired in seven hours while fishing,
    // the one food loop that fed a bot to 17 hunger, stayed dead for lack
    // of string (stash 3, two of them 66 blocks underground). Any bot with
    // a sword now hunts a spider within 24 blocks whenever the stash holds
    // fewer than 2 string, bow or no bow.
    const swordAboard = this.bot.inventory.items().some((i) => i.name.endsWith("_sword"));
    const spY = this.roleConfig.stashPos?.y ?? 70;
    const stringShort = ledgerKnown() && stashCount("string", spY) < 2 && stashCount("fishing_rod", spY) < 1;
    if (
      config.bot.allowStrategyOverrides &&
      !isSkillRunning(this.bot) &&
      (this.bot.username === "Blade" || swordAboard)
    ) {
      const earnedAim = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      const aimDone = earnedAim.has("adventure/shoot_arrow") || earnedAim.has("minecraft:adventure/shoot_arrow");
      const cooledString = Date.now() - this.lastStringHuntMs > 120_000;
      if ((!aimDone || stringShort) && cooledString) {
        const { nearestSpider } = await import("../skills/hunt-string.js");
        const spider = nearestSpider(this.bot);
        if (spider && this.bot.entity.position.distanceTo(spider.position) < 24) {
          this.lastStringHuntMs = Date.now();
          this.log.info("Brain", "OVERRIDE: spider in sight and the bow still needs string — hunting");
          this.events.onThought("Spider! Your silk funds an archery program.");
          const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "hunt_string" });
          this.events.onAction("hunt_string", result);
          this.lastAction = "hunt_string";
          this.lastResult = result;
          return;
        }
      }
    }

    // Archery reflex (Blade) — once string exists, everything else for Take
    // Aim is banked: 63 arrows, sticks by the stack, a table at the stash.
    // Fires near the stash (crafting range) or whenever a bow is in hand.
    if (config.bot.allowStrategyOverrides && !isSkillRunning(this.bot) && this.bot.username === "Blade") {
      const earnedAim2 = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      const aimDone2 = earnedAim2.has("adventure/shoot_arrow") || earnedAim2.has("minecraft:adventure/shoot_arrow");
      const cooledAim = Date.now() - this.lastAimMs > 600_000;
      if (!aimDone2 && cooledAim) {
        const hasBow = this.bot.inventory.items().some((i) => i.name === "bow");
        const stringHeld = this.bot.inventory
          .items()
          .filter((i) => i.name === "string")
          .reduce((s, i) => s + i.count, 0);
        const sp = this.roleConfig.stashPos;
        const nearStash = !!sp && Math.hypot(this.bot.entity.position.x - sp.x, this.bot.entity.position.z - sp.z) < 40;
        let stringBanked = 0;
        if (nearStash && stringHeld < 3) {
          const { chestsWithItem } = await import("../skills/stash-ledger.js");
          stringBanked = chestsWithItem("string").length;
        }
        if (hasBow || (nearStash && (stringHeld >= 3 || stringBanked > 0))) {
          this.lastAimMs = Date.now();
          this.log.info("Brain", "OVERRIDE: archery kit within reach and Take Aim unearned — shoot_arrow");
          this.events.onThought("String, sticks, arrows, table. Time to loose one for the record books.");
          const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "shoot_arrow" });
          this.events.onAction("shoot_arrow", result);
          this.lastAction = "shoot_arrow";
          this.lastResult = result;
          return;
        }
      }
    }

    // Oh Shiny reflex (Blade) — 12 banked gold ingots and a lit portal are a
    // piglin advancement waiting to happen. Daytime departures only (the
    // walk to the portal at night is how bots die), from the stash where the
    // gold and crafting table live.
    if (config.bot.allowStrategyOverrides && !isSkillRunning(this.bot) && this.bot.username === "Blade") {
      const earnedShiny = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      const shinyDone =
        earnedShiny.has("nether/distract_piglin") || earnedShiny.has("minecraft:nether/distract_piglin");
      const cooledShiny = Date.now() - this.lastShinyMs > 1_800_000;
      const todShiny = this.bot.time?.timeOfDay ?? 0;
      const spShiny = this.roleConfig.stashPos;
      const nearStashShiny =
        !!spShiny && Math.hypot(this.bot.entity.position.x - spShiny.x, this.bot.entity.position.z - spShiny.z) < 40;
      if (!shinyDone && cooledShiny && todShiny < 11000 && nearStashShiny) {
        this.lastShinyMs = Date.now();
        this.log.info("Brain", "OVERRIDE: gold banked, portal lit, piglin unmet — running oh_shiny");
        this.events.onThought("Golden boots, pocket of ingots, and a doorway to pig country. Business trip.");
        const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "oh_shiny" });
        this.events.onAction("oh_shiny", result);
        this.lastAction = "oh_shiny";
        this.lastResult = result;
        return;
      }
    }

    // Bed-prep reflex (Flora). Nobody has EVER slept — sleep_in_a_bed is
    // unearned across 5 bots and hundreds of nights — while 11 white wool sit
    // banked 15 blocks from where she idles. The sleep action already crafts
    // and places a bed on its own, but only from POCKET wool. Stock her by
    // day; the night reflex does the rest.
    if (
      config.bot.allowStrategyOverrides &&
      !isSkillRunning(this.bot) &&
      this.bot.username === "Flora" &&
      this.roleConfig.stashPos
    ) {
      const earnedBed = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      // The real ID is sleep_in_bed — the first version gated on a
      // nonexistent sleep_in_a_bed key, which reads as never-earned forever.
      const sleptDone = earnedBed.has("adventure/sleep_in_bed") || earnedBed.has("minecraft:adventure/sleep_in_bed");
      const tod = this.bot.time?.timeOfDay ?? 0;
      const wool = this.bot.inventory
        .items()
        .filter((i) => i.name === "white_wool")
        .reduce((s, i) => s + i.count, 0);
      const p = this.bot.entity.position;
      const nearStash = Math.hypot(p.x - this.roleConfig.stashPos.x, p.z - this.roleConfig.stashPos.z) < 40;
      const cooled = Date.now() - this.lastBedPrepMs > 900_000;
      if (!sleptDone && tod < 11000 && wool < 3 && nearStash && cooled) {
        this.lastBedPrepMs = Date.now();
        this.log.info("Brain", "OVERRIDE: nobody has ever slept — stocking Flora with wool for tonight's bed");
        this.events.onThought("Tonight I sleep in a real bed. Fetching wool.");
        const { withdrawStash } = await import("../skills/stash.js");
        const result = await withdrawStash(this.bot, this.roleConfig.stashPos, "white_wool", 3, 60_000).catch(
          (e: Error) => `withdraw failed: ${e.message}`,
        );
        this.log.info("Brain", `Bed prep: ${result}`);
        this.lastAction = "bed_prep";
        return;
      }
    }

    // Tool-return reflex. The best-pickaxe deposit policy (c01bf0d) only
    // works if the holder ever visits the stash, and Blade — carrying the
    // team's only iron pickaxe he cannot swing — chose deposit_stash zero
    // times in run 375 (it isn't even in his action list, so the model
    // could not have picked it). A non-miner holding any pickaxe walks it
    // back; depositStash's canMine=false banks every pick he carries.
    if (config.bot.allowStrategyOverrides && !isSkillRunning(this.bot) && this.roleConfig.stashPos) {
      const canMine =
        this.roleConfig.allowedActions.includes("mine_block") || this.roleConfig.allowedSkills.includes("strip_mine");
      const roleCanCraft =
        this.roleConfig.allowedActions.includes("craft") || this.roleConfig.allowedSkills.includes("craft_gear");
      const holdsPick = this.bot.inventory.items().some((i) => i.name.endsWith("_pickaxe"));
      // Diamonds pool only in a crafter-miner's pocket. Blade's toss landed
      // the stone on ATLAS (run 381) — who can mine but not craft and has no
      // strip_mine, so it was just a different dead end; the old !canMine
      // guard never fired for him. A diamond leaves any bot that cannot
      // complete the set itself.
      // Diamonds route to the PRIMARY SMITH from everyone else, the same as
      // iron: pick-crafting is smith-only now, so a diamond in any other
      // pocket is dead capital — Mason mined a 3-diamond vein and could
      // neither craft with it (smith gate) nor start enchanting (no pick,
      // no obsidian, no table), and his old return clause never fired
      // because a crafter-miner "could complete the set itself" back when
      // that was true.
      const holdsDiamond =
        !this.roleConfig.primarySmith && this.bot.inventory.items().some((i) => i.name === "diamond");
      // Iron consolidation: a bot that is NOT the primary smith should not sit on
      // iron. Making iron its own reserve stopped the leak, but a second
      // crafter-miner (Mason) then hoarded 2 ingots while Forge sat at 2 — the
      // team's 4 split so neither reached the 3 a pickaxe needs, and nothing
      // pushed Mason to hand his over. Route all non-smith iron to the smith.
      // RAW iron routes to the smith too, now that the smith owns a furnace.
      // The old doctrine sent raw ore through the stash because "the smelter is
      // usually a different bot" — but the smelter IS the primary smith, and
      // the stash round-trip left Atlas walking around with 6 raw_iron while
      // Forge sat one ingot short of the iron pick. A direct hand-off puts the
      // ore where the "raw metal aboard" smelt override fires on it.
      const holdsSpareIron =
        !this.roleConfig.primarySmith &&
        this.bot.inventory.items().some((i) => i.name === "iron_ingot" || i.name === "raw_iron");
      // Leather rides the same rail as diamonds: only the smith assembles the
      // book, so leather in any other pocket is the hunt reflex's kill going
      // stale. Hand it straight over when Forge is in sight.
      const holdsSpareLeather =
        !this.roleConfig.primarySmith && this.bot.inventory.items().some((i) => i.name === "leather");
      // A role that keeps a pickaxe (every role since run 571: the re-arm
      // reflex crafts one so the bot can climb out of caves) never returns
      // it: Blade crafted three stone picks in one hour and this reflex
      // handed each one away within minutes.
      const keepsPick = this.roleConfig.keepItems.some((k) => k.name === "pickaxe");
      const wantsReturn = (holdsPick && !canMine && !keepsPick) || holdsDiamond || holdsSpareIron || holdsSpareLeather;
      // 5min, down from 10: every attempt is a lottery ticket on a quiet
      // window between mob waves — run 380 got five tickets and no winner.
      const cooledDown = Date.now() - this.lastToolReturnMs > 300_000;
      if (wantsReturn && cooledDown) {
        this.lastToolReturnMs = Date.now();
        // FAST PATH: toss to a visible miner. Blade's five stash errands in
        // run 380 all died to combat interruption (150s of walk plus chest
        // work never fits between pillager attacks) — but a hand-off to a
        // miner standing in the village is a 3-block walk and one throw.
        // Crafter-miners only: the first live toss went to Atlas, a plain
        // miner who can never craft the pickaxe — a different pocket, same
        // dead end. Forge and Mason are where a diamond becomes a tool.
        const minerNames = BOT_ROSTER.filter(
          (r) =>
            (r.allowedActions.includes("mine_block") || r.allowedSkills.includes("strip_mine")) &&
            (r.allowedActions.includes("craft") || r.allowedSkills.includes("craft_gear")),
        ).map((r) => r.name);
        // A returnable pick is one this role cannot swing (non-miner); iron is
        // returned only when there is no diamond or unusable pick also aboard,
        // so a crafter-miner keeps the pickaxe it mines with and still ships its
        // spare iron. Iron must reach the SINGLE smith who consolidates it; a
        // diamond or spare pick can go to any crafter-miner. Handing iron to the
        // other crafter-miner would just re-split the pile it is meant to gather.
        const returnablePick = holdsPick && !canMine;
        const ironReturn = holdsSpareIron && !holdsDiamond && !returnablePick;
        const smithNames = BOT_ROSTER.filter((r) => r.primarySmith).map((r) => r.name);
        // Diamonds and iron both go to the single smith who can use them; only
        // a stray pickaxe may go to any crafter-miner. Never target self —
        // bot.players includes the bot itself at distance zero.
        const targetNames = holdsDiamond || holdsSpareLeather || ironReturn ? smithNames : minerNames;
        const nearbyMiner = targetNames.find((n) => {
          if (n === this.bot.username) return false;
          const e = this.bot.players[n]?.entity;
          return e && this.bot.entity.position.distanceTo(e.position) < 24;
        });
        if (nearbyMiner) {
          const itemToGive = holdsDiamond
            ? "diamond"
            : holdsSpareLeather
              ? "leather"
              : returnablePick
                ? (this.bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"))?.name ?? "iron_ingot")
                : this.bot.inventory.items().some((i) => i.name === "iron_ingot")
                  ? "iron_ingot"
                  : "raw_iron";
          this.log.info("Brain", `OVERRIDE: handing ${itemToGive} to ${nearbyMiner} (miner nearby)`);
          this.events.onThought(`${nearbyMiner} can actually use this. Here, catch!`);
          const result = await this.executeActionUnlessPaused("give_item", {
            to: nearbyMiner,
            item: itemToGive,
            count: 64,
          });
          this.events.onAction("give_item", result);
          this.lastAction = "give_item";
          this.lastResult = result;
          return;
        }
        this.log.info("Brain", "OVERRIDE: carrying mining assets this role can't use — returning them to the stash");
        this.events.onThought("This belongs in a crafter-miner's hands. Back to the stash it goes.");
        // Honest capability flags: Atlas (a plain miner banking a diamond)
        // still keeps his best pickaxe; the reserve-zero override is what
        // sends the diamond to the chest.
        const result = await this.executeActionUnlessPaused("deposit_stash", {
          stashPos: this.roleConfig.stashPos,
          keepItems: this.roleConfig.keepItems,
          // Only the primary smith keeps iron; every other bot pools it so the
          // team's scarce iron consolidates into one pocket instead of splitting
          // across two crafter-miners and never reaching a pickaxe's 3 ingots.
          ...(roleCanCraft && canMine && this.roleConfig.primarySmith ? {} : { materialReserve: 0 }),
          canMine,
        });
        this.events.onAction("deposit_stash", result);
        this.lastAction = "deposit_stash";
        this.lastResult = result;
        return;
      }
    }

    // Smelt override — the rung between mined and craftable. The first
    // end-to-end iron arrived in run 364, and in run 365 Forge stood holding
    // raw iron while the model tried to convert it with CRAFT twice ("Can't
    // craft iron_ingot — need: iron_nugget"); craft cannot smelt, and
    // smelt_ores was never chosen. Raw metal in hand plus the skill = smelt
    // now. smelt_ores already handles furnace, fuel, and stash withdrawal.
    if (
      config.bot.allowStrategyOverrides &&
      this.roleConfig.allowedSkills.includes("smelt_ores") &&
      !isSkillRunning(this.bot)
    ) {
      const rawMetal = this.bot.inventory
        .items()
        .filter((i) => i.name === "raw_iron" || i.name === "raw_gold" || i.name === "raw_copper")
        .reduce((s, i) => s + i.count, 0);
      const cooledDown = Date.now() - this.lastSmeltOverrideMs > 300_000;
      if (rawMetal >= 1 && cooledDown) {
        this.lastSmeltOverrideMs = Date.now();
        this.log.info("Brain", `OVERRIDE: ${rawMetal} raw metal aboard — running smelt_ores`);
        this.events.onThought("Raw ore does nothing in a pocket. To the furnace!");
        // stashPos unlocks the skill's fuel withdrawal — without it the whole
        // Step 0 is skipped and a bot with ore but no coal loops "No fuel!"
        // beside a stash holding a full stack of it (run 389, 4x in a row).
        const result = await this.executeActionUnlessPaused("invoke_skill", {
          skill: "smelt_ores",
          stashPos: this.roleConfig.stashPos,
        });
        this.events.onAction("smelt_ores", result);
        this.lastAction = "smelt_ores";
        this.lastResult = result;
        this.trackFailure(
          "skill:smelt_ores",
          { action: "smelt_ores", params: {} },
          result,
          /smelted|ingot/i.test(result),
        );
        return;
      }
    }

    // Enchanter override — RUNS BEFORE craft_gear so 2 diamonds route to an
    // enchanting table, not a third pickaxe. The strategic model is told
    // "enchant an item" every cycle and never assembles the table; this fires
    // the deterministic setup_enchanting skill for a crafter-miner holding the
    // diamonds while the team has not yet earned Enchanter. Gated on the
    // advancement itself so it stops the instant the point lands.
    if (
      config.bot.allowStrategyOverrides &&
      this.roleConfig.allowedSkills.includes("setup_enchanting") &&
      !isSkillRunning(this.bot)
    ) {
      const diamonds = this.bot.inventory
        .items()
        .filter((i) => i.name === "diamond")
        .reduce((s, i) => s + i.count, 0);
      // Only fire when the skill can actually make progress: it needs a
      // diamond pick to mine the table's obsidian, or obsidian already in
      // hand, or the table already standing. Firing merely on held diamonds
      // shadowed the gear reflex that crafts the pick — the skill would keep
      // returning "need a pick" while the pick never got made. With the pick
      // present (5 diamonds -> gear reflex mints it, 2 remain), this proceeds.
      const canProgress =
        this.bot.inventory.items().some((i) => i.name === "diamond_pickaxe" || i.name === "netherite_pickaxe") ||
        this.bot.inventory.items().some((i) => i.name === "obsidian") ||
        !!this.bot.findBlock({ matching: (b) => b.name === "enchanting_table", maxDistance: 24 });
      const earned = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      const enchanterDone = earned.has("story/enchant_item") || earned.has("minecraft:story/enchant_item");
      const cooled = Date.now() - this.lastEnchantOverrideMs > 300_000;
      if (diamonds >= 2 && canProgress && !enchanterDone && cooled) {
        this.lastEnchantOverrideMs = Date.now();
        this.log.info("Brain", `OVERRIDE: ${diamonds} diamonds and no Enchanter yet — running setup_enchanting`);
        this.events.onThought("Time to build an enchanting table and finally enchant something.");
        const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "setup_enchanting" });
        this.events.onAction("setup_enchanting", result);
        this.lastAction = "setup_enchanting";
        this.lastResult = result;
        this.trackFailure(
          "skill:setup_enchanting",
          { action: "setup_enchanting", params: {} },
          result,
          /enchant|Enchanter earned/i.test(result),
        );
        return;
      }
    }

    // Fishing override — Fishy Business, a cheap husbandry point. Fires while
    // it is unearned; the skill self-supplies a rod (stash string, else a
    // spider hunt) and needs water nearby, handing back gracefully otherwise.
    if (
      config.bot.allowStrategyOverrides &&
      this.roleConfig.allowedSkills.includes("go_fishing") &&
      !isSkillRunning(this.bot)
    ) {
      const earned = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      const fished = earned.has("husbandry/fishy_business") || earned.has("minecraft:husbandry/fishy_business");
      const cooled = Date.now() - this.lastFishOverrideMs > 600_000;
      // Fishing is also the team's FALLBACK PANTRY. The farm has failed six
      // distinct ways while the whole swarm starved (bots burning hours
      // seeking bread that does not exist); go_fishing is the one food path
      // proven end-to-end — it earned Fishy Business and lands 3-5 edible
      // catches a run with no terrain luck. A fisher who is hungry with
      // nothing edible aboard goes fishing even after the advancement banked.
      const edible = /(bread|cooked_|^cod$|^salmon$|apple|carrot|potato|baked|melon_slice|cookie|beef|porkchop|mutton)/;
      const starving = this.bot.food < 12 && !this.bot.inventory.items().some((i) => edible.test(i.name));
      // Every role may fish now (run 563: 17 deaths, four bots at 0 food, nine
      // empty hunts). The Fishy Business chase stays Flora's; the others go
      // to the water only when starving.
      const chasesFishy = !fished && this.bot.username === "Flora";
      // No rod and no way to make one means no trip: run 568 sent rodless
      // bots to the stash nine times for string that sat 66 blocks down, two
      // minutes each. Rods wear out after 64 casts, so this gate matters.
      const inv = this.bot.inventory.items();
      const hasRod = inv.some((i) => i.name === "fishing_rod");
      const stringHeld = inv.filter((i) => i.name === "string").reduce((n, i) => n + i.count, 0);
      const stashY = this.roleConfig.stashPos?.y;
      const canRig =
        hasRod ||
        stringHeld >= 2 ||
        !ledgerKnown() ||
        stashCount("fishing_rod", stashY) >= 1 ||
        stashCount("string", stashY) >= 2 ||
        // Run 615: two string sit 66 blocks under the stash; the miner can
        // reach that chest (deep withdraw), nobody else should try.
        (this.bot.username === "Forge" && stashCount("string") >= 2);
      if ((chasesFishy || starving) && cooled && !canRig) {
        this.lastFishOverrideMs = Date.now();
        this.log.info(
          "Brain",
          `Fishing skipped: no rod, string ${stringHeld} aboard, stash string ${stashCount("string", stashY)} reachable — hunting instead`,
        );
      }
      if ((chasesFishy || starving) && cooled && canRig) {
        this.lastFishOverrideMs = Date.now();
        this.log.info(
          "Brain",
          fished
            ? "OVERRIDE: starving with nothing aboard — fishing for dinner"
            : "OVERRIDE: Fishy Business unearned — running go_fishing",
        );
        this.events.onThought(
          fished
            ? "The pantry is bare and my stomach is growling. The lake will feed me."
            : "A rod, some water, and patience. Let's catch a fish.",
        );
        const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "go_fishing" });
        this.events.onAction("go_fishing", result);
        this.lastAction = "go_fishing";
        this.lastResult = result;
        this.trackFailure(
          "skill:go_fishing",
          { action: "go_fishing", params: {} },
          result,
          /caught|fish/i.test(result),
        );
        return;
      }
    }

    // Heal first. Run 704: Mason stood at 6 health and 9 hunger at the
    // village with three bread aboard for twenty minutes, under the 14-health
    // gate both Nether trips need, while the planner picked other work and
    // auto-eat never fired. A hurt bot short of the healing range eats what
    // it carries before anything else, up to three meals.
    if (
      config.bot.allowStrategyOverrides &&
      !isSkillRunning(this.bot) &&
      this.bot.health < 14 &&
      this.bot.food < 18 &&
      this.hasEdibleAboard() &&
      Date.now() - this.lastHealEatMs > 60_000
    ) {
      this.lastHealEatMs = Date.now();
      this.log.info(
        "Brain",
        `OVERRIDE: health ${this.bot.health.toFixed(0)}/20 at hunger ${this.bot.food}/20 with food aboard — eating to heal`,
      );
      let last = "";
      for (let meal = 0; meal < 3; meal++) {
        last = String(await this.executeActionUnlessPaused("eat", {}));
        this.log.info("Brain", `Heal: ate -> ${last}`);
        if (!/^Ate /.test(last) || (this.bot.food ?? 20) >= 18) break;
      }
      this.lastAction = "eat";
      this.lastResult = last;
      return;
    }

    // Pantry first. Run 598: the village trip brought 37 potatoes home while
    // Mason (1 hp) and Blade sat at 0 hunger beside the stash, and nothing
    // ever fetched banked food for a hungry bot. A hungry bot near the stash
    // withdraws the first edible the ledger knows of and eats it before any
    // 300-block scout.
    if (config.bot.allowStrategyOverrides && !isSkillRunning(this.bot) && this.roleConfig.stashPos) {
      const sp = this.roleConfig.stashPos;
      const edibleRe =
        /(bread|cooked_|^cod$|^salmon$|apple|carrot|^potato$|baked_potato|melon_slice|cookie|^beef$|porkchop|mutton|^chicken$|^rabbit$)/;
      const hasEdible = this.bot.inventory.items().some((i) => edibleRe.test(i.name));
      const nearStash =
        Math.hypot(this.bot.entity.position.x - sp.x, this.bot.entity.position.z - sp.z) < 60 &&
        this.bot.entity.position.y >= sp.y - 8;
      const cooled = Date.now() - this.lastStashFoodMs > 600_000;
      // Run 702: a bot heals only above 18 hunger, and this trip fired only
      // at 8 or below. Mason sat at 12 health and 11 hunger for an hour beside
      // a pantry holding potatoes, and both Nether trips gate on 14 health.
      // A hurt bot short of the healing range fetches food as well.
      const hurtAndUnderfed = this.bot.health < 14 && this.bot.food < 18;
      if ((this.bot.food <= 8 || hurtAndUnderfed) && !hasEdible && nearStash && cooled && ledgerKnown()) {
        const PANTRY = [
          "bread",
          "baked_potato",
          "cooked_beef",
          "cooked_porkchop",
          "cooked_mutton",
          "cooked_chicken",
          "cooked_cod",
          "cooked_salmon",
          "potato",
          "carrot",
          "apple",
          "beef",
          "porkchop",
          "mutton",
          "chicken",
          "cod",
          "salmon",
        ];
        const pick = PANTRY.find((n) => stashCount(n, sp.y) >= 1);
        if (pick) {
          this.lastStashFoodMs = Date.now();
          const want = Math.min(8, stashCount(pick, sp.y));
          this.log.info(
            "Brain",
            `OVERRIDE: hunger ${this.bot.food}/20, health ${this.bot.health.toFixed(0)}/20 — fetching ${want} ${pick} from the stash pantry`,
          );
          this.events.onThought("The pantry has food. Fetch some before the long walk.");
          const { withdrawStash } = await import("../skills/stash.js");
          const r = await withdrawStash(this.bot, sp, pick, want, 90_000).catch((e: Error) => e.message);
          // Run 624: the withdraw matches by substring, so "potato" fetched
          // baked_potato, and this exact-name check said nothing arrived.
          // Mason walked away twice with three baked potatoes uneaten.
          const got = this.bot.inventory.items().some((i) => i.name.includes(pick));
          console.log(`[Pantry] ${this.bot.username} ${pick} x${want}: ${String(r).slice(0, 90)}; aboard=${got}`);
          if (got) {
            // Eat up to the healing range: one meal from 11 lands at 16, still
            // short of the 18 that starts regeneration.
            for (let meal = 0; meal < 3; meal++) {
              const ate = await this.executeActionUnlessPaused("eat", {});
              this.log.info("Brain", `Pantry: ate -> ${ate}`);
              if (!/^Ate /.test(String(ate)) || (this.bot.food ?? 20) >= 18) break;
            }
          }
          this.lastAction = "pantry";
          this.lastResult = String(r);
          return;
        }
      }
    }

    // Hunger override, every role. Run 517: four of five bots at 0 food and
    // 20 deaths in an hour while "eat" found nothing 54 times; the fishing
    // pantry is retired (no string) and the bakers eat the bread. A bot that
    // is hungry with nothing edible aboard goes and kills a food animal,
    // scouting outward in daylight when none is in sight, and eats it there.
    if (config.bot.allowStrategyOverrides && !isSkillRunning(this.bot)) {
      const edible =
        /(bread|cooked_|^cod$|^salmon$|apple|carrot|potato|baked|melon_slice|cookie|beef|porkchop|mutton|chicken|rabbit)/;
      const hasEdible = this.bot.inventory.items().some((i) => edible.test(i.name));
      const cooled = Date.now() - this.lastHuntFoodOverrideMs > 240_000;
      // At night the skill will not scout, but an animal already in view is
      // a safe kill (run 535: Atlas, Flora and Forge at 1 to 3 hearts with 0
      // food through the night while the override waited for daylight).
      const animalInView = !this.bot.time.isDay && !!nearestFoodAnimal(this.bot);
      if (this.bot.food <= 8 && !hasEdible && cooled && (this.bot.time.isDay || animalInView)) {
        this.lastHuntFoodOverrideMs = Date.now();
        this.log.info("Brain", `OVERRIDE: hunger ${this.bot.food}/20 with nothing edible aboard — hunting for food`);
        this.events.onThought("Nothing to eat and my stomach is empty. Time to find an animal.");
        const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "hunt_food" });
        this.events.onAction("hunt_food", result);
        this.lastAction = "hunt_food";
        this.lastResult = result;
        this.trackFailure(
          "skill:hunt_food",
          { action: "hunt_food", params: {} },
          result,
          /Hunger \d+ -> \d+/.test(result),
        );
        return;
      }
    }

    // Tactical Fishing override (2026-09-17): 18 salmon within 150 blocks of
    // the village and three bots carrying water buckets, and the point is one
    // right-click. Fires for a capable bot with a bucket while a fish is in
    // view and the advancement is unearned; the skill is bounded.
    if (
      config.bot.allowStrategyOverrides &&
      this.roleConfig.allowedSkills.includes("bucket_fish") &&
      !isSkillRunning(this.bot) &&
      Date.now() - this.lastBucketFishMs > 600_000
    ) {
      const earnedFish = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      const done =
        earnedFish.has("husbandry/tactical_fishing") || earnedFish.has("minecraft:husbandry/tactical_fishing");
      const hasBucket = this.bot.inventory.items().some((i) => i.name === "water_bucket" || i.name === "bucket");
      if (!done && hasBucket) {
        const { nearestFish } = await import("../skills/bucket-fish.js");
        const fish = nearestFish(this.bot, 48);
        if (fish) {
          this.lastBucketFishMs = Date.now();
          this.log.info(
            "Brain",
            `OVERRIDE: a ${fish.name} ${fish.position.distanceTo(this.bot.entity.position).toFixed(0)} blocks away and a bucket aboard — running bucket_fish`,
          );
          this.events.onThought("A fish, a bucket, and an idea.");
          const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "bucket_fish" });
          this.events.onAction("bucket_fish", result);
          this.lastAction = "bucket_fish";
          this.lastResult = result;
          this.trackFailure(
            "skill:bucket_fish",
            { action: "bucket_fish", params: {} },
            result,
            /Scooped|Tactical/i.test(result),
          );
          return;
        }
      }
    }

    // Breeding override — cheap husbandry point the model never assembles.
    // Fires for a capable bot while "breed an animal" is unearned; the skill
    // itself checks for food + nearby animals and hands back gracefully when
    // either is missing, so a wrong-place firing costs one bounded attempt.
    if (
      config.bot.allowStrategyOverrides &&
      this.roleConfig.allowedSkills.includes("breed_animals") &&
      !isSkillRunning(this.bot)
    ) {
      const earned = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      const bred = earned.has("husbandry/breed_an_animal") || earned.has("minecraft:husbandry/breed_an_animal");
      const cooled = Date.now() - this.lastBreedOverrideMs > 600_000;
      // DAYTIME ONLY. The scout marches Flora ~210 blocks out to reach the
      // dispersed herds, and at night that is a walk into open-field zombies —
      // she died five times in one night on futile scouts that never found a
      // pair anyway. By day the same walk is safe and animals are easier to
      // spot; at night she stays home. timeOfDay 0-12000 is day.
      const isDay = this.bot.time.timeOfDay < 12000;
      if (!bred && cooled && isDay) {
        this.lastBreedOverrideMs = Date.now();
        this.log.info("Brain", "OVERRIDE: breeding advancement unearned — running breed_animals");
        this.events.onThought("Two of a kind and a handful of wheat. Time to make some babies.");
        const result = await this.executeActionUnlessPaused("invoke_skill", { skill: "breed_animals" });
        this.events.onAction("breed_animals", result);
        this.lastAction = "breed_animals";
        this.lastResult = result;
        this.trackFailure(
          "skill:breed_animals",
          { action: "breed_animals", params: {} },
          result,
          /breed|Fed two/i.test(result),
        );
        return;
      }
    }

    // Iron-pickaxe override — the rung the other pushes stop short of. The
    // strip_mine push stands down as soon as a bot HOLDS iron (correctly), but
    // nothing then converts it: Mason carried 9-11 iron_ingot for a full run,
    // shuffling them between slots, while the model never chose craft_gear.
    // Ingots in hand + no iron pick = craft now. This is the gate to the
    // diamond depth (strip_mine only descends to -58 with an iron pick).
    // Diamond-reserve guard: while Enchanter is unearned and a crafter holds
    // exactly the 2 diamonds the table needs, do not let those become a third
    // pickaxe — the enchanting override above owns them.
    if (
      config.bot.allowStrategyOverrides &&
      this.roleConfig.allowedSkills.includes("craft_gear") &&
      !isSkillRunning(this.bot)
    ) {
      const ingots = this.bot.inventory
        .items()
        .filter((i) => i.name === "iron_ingot")
        .reduce((s, i) => s + i.count, 0);
      // Wear-aware: an iron pick with under 150 uses left dies mid-dive (250
      // total, a descent alone costs ~130 — run 376 lost its pick that way),
      // so a nearly-dead pick counts as no pick and the crafter re-mints.
      const PICK_MAX: Record<string, number> = { iron_pickaxe: 250, diamond_pickaxe: 1561 };
      const hasIronPick = this.bot.inventory
        .items()
        .some(
          (i) =>
            (i.name === "iron_pickaxe" || i.name === "diamond_pickaxe") &&
            (PICK_MAX[i.name] ?? 250) - (i.durabilityUsed ?? 0) >= 150,
        );
      // Diamond tier, same shape: 3 diamonds + 2 sticks = the pickaxe that
      // clears the portal doorway. craft_gear's tier loop prefers the best
      // affordable pick, so invoking it with diamonds aboard mints it.
      const diamondCount = this.bot.inventory
        .items()
        .filter((i) => i.name === "diamond")
        .reduce((s, i) => s + i.count, 0);
      const hasDiamondPickax = this.bot.inventory
        .items()
        .some((i) => i.name === "diamond_pickaxe" || i.name === "netherite_pickaxe");
      // Only the primary smith turns ingots into a pickaxe. A second
      // crafter-miner (Mason) that reached 3 iron minted his OWN iron pick,
      // spending the scarce iron the routing reflex was busy funnelling to
      // Forge — the two competed for a supply barely enough for one. Non-smiths
      // re-arm with a wooden pick via the pickless override and ship their iron
      // onward; the smith alone forges the iron and diamond picks.
      const wantsIronPick = ingots >= 3 && !hasIronPick && !!this.roleConfig.primarySmith;
      // Reserve 2 diamonds for the enchanting table until Enchanter is earned:
      // a crafter with setup_enchanting only mints a diamond pick from a FIFTH
      // diamond (3 for the pick + 2 held for the table), so the table's stock
      // is never consumed. Bots without the skill keep the plain >=3 rule.
      const reservesForTable =
        this.roleConfig.allowedSkills.includes("setup_enchanting") &&
        !readTeamEarned(BOT_ROSTER.map((b) => b.name)).has("story/enchant_item");
      const diamondPickThreshold = reservesForTable ? 5 : 3;
      const wantsDiamondPick =
        diamondCount >= diamondPickThreshold && !hasDiamondPickax && !!this.roleConfig.primarySmith;
      const cooledDown = Date.now() - this.lastGearOverrideMs > 180_000;
      if ((wantsIronPick || wantsDiamondPick) && cooledDown) {
        this.lastGearOverrideMs = Date.now();
        this.log.info(
          "Brain",
          wantsDiamondPick
            ? `OVERRIDE: ${diamondCount} diamonds and no diamond pickaxe — running craft_gear`
            : `OVERRIDE: ${ingots} iron ingots and no iron pickaxe — running craft_gear`,
        );
        this.events.onThought(
          wantsDiamondPick
            ? "THREE DIAMONDS. The doorway-clearing pickaxe gets crafted RIGHT NOW."
            : "Enough iron in my pack for a REAL pickaxe. To the crafting table!",
        );
        const result = await this.executeActionUnlessPaused("invoke_skill", {
          skill: "craft_gear",
          stashPos: this.roleConfig.stashPos,
          keepItems: this.roleConfig.keepItems,
        });
        this.events.onAction("craft_gear", result);
        this.lastAction = "craft_gear";
        this.lastResult = result;
        this.trackFailure(
          "skill:craft_gear",
          { action: "craft_gear", params: {} },
          result,
          /crafted|iron_pickaxe|complete/i.test(result),
        );
        return;
      }
    }

    // Armour-craft reflex — the whole swarm fought NAKED because the only
    // craft_gear trigger above is the pickaxe one, which stops firing the
    // moment a bot owns an iron pick. Iron then flowed to tools and was never
    // converted to armour, so equipBestArmor had nothing to wear. craft_gear
    // crafts armour-first (chestplate, then the cheapest affordable piece) and
    // tops up from the stash, so once a bot has its pick and 4+ spare ingots,
    // route them to survival gear. This is the missing link between "iron is
    // mined" and "the swarm survives an expedition".
    if (
      config.bot.allowStrategyOverrides &&
      !isSkillRunning(this.bot) &&
      this.roleConfig.allowedSkills.includes("craft_gear") &&
      this.wornArmorCount() < 4
    ) {
      const hasPick = this.bot.inventory.items().some((i) => i.name.endsWith("_pickaxe"));
      const cooledArmor = Date.now() - this.lastArmorCraftMs > 300_000;
      // Invoke blind rather than gating on held iron: strip_mine's pre-mine
      // deposit banks iron ingots to the stash (they are not on its keep
      // list), so a naked miner almost never HOLDS iron — it sits in the
      // chest. craft_gear withdraws up to 33 iron from the stash on entry, so
      // firing it whenever a bot is unarmoured and has a working pick lets it
      // pull the accumulated iron and forge a piece. A 5-minute cooldown
      // bounds the wasted table trip on the runs where the stash is dry.
      // An unarmed bot forges a sword the same way (craft_gear crafts every
      // tool type it has materials for): run 543 lost seven bots in fifteen
      // minutes to a five-pillager patrol camped on the stash, with one stone
      // sword in the whole swarm and 5,000 cobblestone banked.
      const noSword = !this.bot.inventory.items().some((i) => i.name.endsWith("_sword"));
      // Armour needs iron: the cheapest piece costs 4 ingots. Run 569 ran
      // craft_gear 20 times for "No new tools crafted" because every bot
      // had a pick and no armour while the pack and stash held 0 to 2 iron.
      const ironAboard = this.bot.inventory
        .items()
        .filter((i) => i.name === "iron_ingot")
        .reduce((n, i) => n + i.count, 0);
      const ironReachable = ironAboard + (ledgerKnown() ? stashCount("iron_ingot", this.roleConfig.stashPos?.y) : 99);
      // Run 697: 472 leather in the stash and no iron; leather armour is a
      // craft too, so a reachable hide counts the way ingots do.
      const leatherReachable =
        this.bot.inventory
          .items()
          .filter((i) => i.name === "leather")
          .reduce((n, i) => n + i.count, 0) + (ledgerKnown() ? stashCount("leather", this.roleConfig.stashPos?.y) : 0);
      if (((hasPick && (ironReachable >= 4 || leatherReachable >= 4)) || noSword) && cooledArmor) {
        this.lastArmorCraftMs = Date.now();
        this.log.info("Brain", "OVERRIDE: unarmoured with a pick in hand — running craft_gear to forge armour");
        this.events.onThought("A pick in hand but nothing on my back. Time to forge some armour.");
        const result = await this.executeActionUnlessPaused("invoke_skill", {
          skill: "craft_gear",
          stashPos: this.roleConfig.stashPos,
          keepItems: this.roleConfig.keepItems,
        });
        this.events.onAction("craft_gear", result);
        this.lastAction = "craft_gear";
        this.lastResult = result;
        return;
      }
    }

    // Re-arm reflex for every role: a pickless bot at village level crafts a
    // stone pick with the stash's cobblestone and sticks. Run 570: all five
    // bots pickless, 25 bare-handed escapes (six died on the way up), 15
    // deaths, and the only craft_gear run of the hour had cobble=0 because
    // the LLM invoked it without the stash. Nothing re-armed anyone but
    // Forge's strip_mine branch. Runs last among the overrides so escape,
    // drowning and hunger keep priority.
    if (
      config.bot.allowStrategyOverrides &&
      !isSkillRunning(this.bot) &&
      this.roleConfig.allowedSkills.includes("craft_gear") &&
      this.roleConfig.stashPos
    ) {
      const inv = this.bot.inventory.items();
      const pickless = !inv.some((i) => i.name.endsWith("_pickaxe"));
      const cnt = (n: string) => inv.filter((i) => i.name === n).reduce((t, i) => t + i.count, 0);
      const sp = this.roleConfig.stashPos;
      const p = this.bot.entity.position;
      const atVillage = Math.hypot(p.x - sp.x, p.z - sp.z) < 120 && p.y >= sp.y - 8;
      // Underground re-arm: a wooden pick is 3 planks + 2 sticks, plus 4
      // planks for a table when none is near, and a log is 4 planks. Run 572:
      // Mason and Flora sat 30 to 40 blocks under the village pickless, five
      // climb-outs hit the 240s watchdog, and the override never fired
      // because it wanted cobblestone or village level. A wooden pick digs
      // stone five times faster than a hand and drops the cobble to pillar.
      const plankEq =
        inv.filter((i) => i.name.endsWith("_planks")).reduce((t, i) => t + i.count, 0) +
        4 * inv.filter((i) => i.name.endsWith("_log")).reduce((t, i) => t + i.count, 0);
      const materials =
        (cnt("cobblestone") >= 3 && (cnt("stick") >= 2 || plankEq >= 2)) ||
        plankEq >= 7 ||
        (plankEq >= 5 && cnt("stick") >= 2);
      const cooledPick = Date.now() - this.lastPickCraftMs > 300_000;
      if (pickless && cooledPick && (atVillage || materials)) {
        this.lastPickCraftMs = Date.now();
        this.log.info(
          "Brain",
          `OVERRIDE: no pickaxe — running craft_gear (cobble ${cnt("cobblestone")}, sticks ${cnt("stick")}, ${atVillage ? "at the village" : "materials aboard"})`,
        );
        this.events.onThought("No pickaxe in hand. Time to forge one.");
        const result = await this.executeActionUnlessPaused("invoke_skill", {
          skill: "craft_gear",
          stashPos: sp,
          keepItems: this.roleConfig.keepItems,
        });
        this.events.onAction("craft_gear", result);
        this.lastAction = "craft_gear";
        this.lastResult = result;
        return;
      }
    }

    const context = this.buildContext();
    const memoryCtx = this.memStore.getMemoryContext();
    // Run 619: "eat" was blocked for ten minutes after "No food in
    // inventory", and the model still picked it 102 times in an hour (a
    // third of all decisions) because the menu kept offering it and the
    // RECENTLY FAILED note went unread. A blocked action leaves the menu.
    this.purgeExpiredFailures();
    const menu = this.roleConfig.allowedActions.filter((a) => !this.recentFailures.has(a));
    const role: RoleContext = {
      name: this.roleConfig.name,
      personality: this.roleConfig.personality,
      role: this.roleConfig.role,
      seasonGoal: this.roleConfig.seasonGoal ?? this.memStore.getSeasonGoal(),
      allowedActions: menu.length ? menu : this.roleConfig.allowedActions,
      eatBlocked: this.recentFailures.has("eat"),
      allowedSkills: this.roleConfig.allowedSkills,
      priorities: this.roleConfig.priorities,
    };

    const decision = await queryStrategic(context, this.recentHistory, memoryCtx, role);
    const outcome = await this.executeDecision(decision);

    // Exact provider messages and raw responses live in episode-events-v1.
    // The compact v2 trajectory joins them by requestId and the local outcome by actionId.
    recordTrajectory({
      schemaVersion: 2,
      bot: this.roleConfig.name,
      requestId: decision.metadata?.requestId ?? null,
      actionId: outcome.actionId,
      decision: { thought: decision.thought, action: decision.action, params: decision.params, goal: decision.goal },
      outcome,
      model: trajectoryModelMetadata(decision),
      timestamp: new Date().toISOString(),
    });
  }

  private async handleCritic(event: BrainEvent): Promise<void> {
    if (!this.CRITIC_ENABLED) return;
    const { action, result, goal } = event.data ?? {};
    if (!action || !result) return;

    // Skip critic for trivial actions
    if (["idle", "chat", "respond_to_chat"].includes(action)) return;

    const criticContext = [
      `Action: ${action}`,
      `Result: ${result}`,
      goal ? `Goal: ${goal} (${this.goalStepsLeft} steps left)` : "No active goal.",
      `Health: ${this.bot.health}/20, Food: ${this.bot.food}/20`,
      `Inventory: ${
        this.bot.inventory
          .items()
          .map((i) => `${i.name}x${i.count}`)
          .join(", ") || "empty"
      }`,
    ].join("\n");

    // Run 622: 37 critic verdicts suggested "eat" while it was blocked, and
    // the next-step path below executes without the strategic menu. Give the
    // critic the same filtered list.
    this.purgeExpiredFailures();
    const criticMenu = this.roleConfig.allowedActions.filter((a) => !this.recentFailures.has(a));
    const verdict = await queryCritic(
      this.roleConfig.name,
      criticContext,
      criticMenu.length ? criticMenu : this.roleConfig.allowedActions,
    );
    if (this.paused) return;

    // Update thought display
    if (verdict.thought) {
      this.events.onThought(`[critic] ${verdict.thought}`);
    }

    if (verdict.goalComplete) {
      this.log.info("Brain:critic", `Goal "${this.currentGoal}" complete. Re-planning.`);
      this.currentGoal = "";
      this.goalStepsLeft = 0;
      // Trigger strategic re-plan after a brief pause
      setTimeout(() => this.triggerReplan(), 1000);
    } else if (verdict.nextAction && verdict.success && this.recentFailures.has(verdict.nextAction)) {
      this.log.info("Brain:critic", `Next step "${verdict.nextAction}" is blocked — re-planning instead`);
      setTimeout(() => this.triggerReplan(), 1000);
    } else if (verdict.nextAction && verdict.success) {
      // Critic suggests next step — execute directly without full LLM call
      this.log.debug("Brain:critic", `Next step: ${verdict.nextAction}`);
      await this.executeDecision({
        thought: verdict.thought,
        action: verdict.nextAction,
        params: verdict.nextParams,
        metadata: verdict.metadata,
      });
    } else if (!verdict.success) {
      // Action failed — trigger strategic re-plan
      this.log.info("Brain:critic", "Action failed. Re-planning.");
      setTimeout(() => this.triggerReplan(), 500);
    }
  }

  // ─── Action execution ─────────────────────────────────────────────────────

  /** Consecutive walk failures, for the escape reflex: a bot with a pick can
   *  still be stuck in a shaft (Mason, 17 blocks under the stash, every chest
   *  walk timing out with zero velocity) and the pickless gate ignored him. */
  private navFailStreak = 0;

  private beginActionCapture(
    decision: BrainDecision,
    origin = decision.metadata?.origin ?? "deterministic",
  ): ActionCapture {
    const actionId = randomUUID();
    const requestId = decision.metadata?.requestId ?? null;
    const botId = this.roleConfig.name;
    const episodeId = currentEpisodeId(botId);
    const started = appendEpisodeEvent(
      { botId, episodeId, actionId, requestId, kind: "action_started" },
      {
        captureVersion: 1,
        origin,
        proposedDecision: {
          thought: decision.thought,
          action: decision.action,
          params: decision.params,
          goal: decision.goal,
          goalSteps: decision.goalSteps,
        },
        provider: decision.metadata?.provider ?? null,
        collection: currentCollectionContext(),
      },
    );
    let beforeObservationRef = "unavailable:observation_capture_failed";
    let observationTelemetryComplete = false;
    try {
      const observation = captureActionObservation(this.bot, botId, actionId, "before_execution");
      const recorded = appendEpisodeEvent({ botId, episodeId, actionId, requestId, kind: "observation" }, observation);
      beforeObservationRef = recorded.payloadRef;
      observationTelemetryComplete = observation.capture.complete && recorded.payloadRef.startsWith("sha256:");
    } catch (error) {
      this.log.warn(
        "Brain:telemetry",
        `Before-action state observation failed: ${(error as Error)?.message ?? String(error)}`,
      );
    }
    return {
      actionId,
      requestId,
      episodeId,
      botId,
      startPayloadRef: started.payloadRef,
      beforeObservationRef,
      observationTelemetryComplete,
      interruptionGeneration: this.interruptionGeneration,
    };
  }

  private finishActionCapture(
    capture: ActionCapture,
    status: ActionStatus,
    reasonCode: string,
    resultText: string,
    evidenceRefs: string[] = [],
    details: Record<string, unknown> = {},
  ): ActionOutcome {
    if (capture.outcome) return capture.outcome;
    let terminalObservationRef = "unavailable:observation_capture_failed";
    let terminalObservationComplete = false;
    try {
      const observation = captureActionObservation(this.bot, capture.botId, capture.actionId, "at_terminal");
      const recorded = appendEpisodeEvent(
        {
          botId: capture.botId,
          episodeId: capture.episodeId,
          actionId: capture.actionId,
          requestId: capture.requestId,
          kind: "observation",
        },
        observation,
      );
      terminalObservationRef = recorded.payloadRef;
      terminalObservationComplete = observation.capture.complete && recorded.payloadRef.startsWith("sha256:");
    } catch (error) {
      this.log.warn(
        "Brain:telemetry",
        `Terminal state observation failed: ${(error as Error)?.message ?? String(error)}`,
      );
    }
    const observationRefs = {
      beforeExecution: capture.beforeObservationRef,
      atTerminal: terminalObservationRef,
    };
    const observationTelemetryComplete = capture.observationTelemetryComplete && terminalObservationComplete;
    const outcome: ActionOutcome = {
      actionId: capture.actionId,
      status,
      reasonCode,
      resultText,
      evidenceRefs: [capture.startPayloadRef, capture.beforeObservationRef, ...evidenceRefs, terminalObservationRef],
    };
    // Mark terminal before persistence so a later callback failure cannot emit
    // a contradictory second terminal event for this invocation.
    capture.outcome = outcome;
    appendEpisodeEvent(
      {
        botId: capture.botId,
        episodeId: capture.episodeId,
        actionId: capture.actionId,
        requestId: capture.requestId,
        kind: "action_finished",
      },
      {
        captureVersion: 1,
        outcome,
        observationRefs,
        observationTelemetry: {
          complete: observationTelemetryComplete,
          limitation:
            "Same-process Mineflayer client samples; deltas alone do not establish success, transfer attribution, or recovery.",
        },
        ...details,
      },
    );
    return outcome;
  }

  private executionObservation(capture: ActionCapture, resultText: string, reportedSuccess: boolean | null) {
    return appendEpisodeEvent(
      {
        botId: capture.botId,
        episodeId: capture.episodeId,
        actionId: capture.actionId,
        requestId: capture.requestId,
        kind: "observation",
      },
      { captureVersion: 1, stage: "execution_result", resultText, reportedSuccess },
    );
  }

  private outcomeForExecution(
    capture: ActionCapture,
    action: string,
    resultText: string,
    skillSuccess: boolean | undefined,
    evidenceRef: string,
  ): ActionOutcome {
    if (capture.interruptionGeneration !== this.interruptionGeneration) {
      const reason = this.interruptionReasonSince(capture.interruptionGeneration) ?? "action_interrupted";
      return this.finishActionCapture(capture, "cancelled", reason, resultText, [evidenceRef]);
    }
    if (resultText === "Stopped before action execution") {
      return this.finishActionCapture(capture, "cancelled", "brain_stopped_during_action", resultText, [evidenceRef]);
    }
    if (resultText === "Paused by player command") {
      return this.finishActionCapture(capture, "cancelled", "paused_during_action", resultText, [evidenceRef]);
    }
    if (resultText === "Underwater and short of air \u2014 surfacing first, try again once breathing.") {
      return this.finishActionCapture(capture, "blocked", "drowning_safety_gate", resultText, [evidenceRef]);
    }
    if (/^Already running skill "[^"]+"\. Wait for it to finish\.$/.test(resultText)) {
      return this.finishActionCapture(capture, "blocked", "skill_already_running", resultText, [evidenceRef]);
    }
    if (
      /^Action "[^"]+" timed out after \d+(?:\.\d+)?s \u2014 aborted to free the brain\.$/.test(resultText) ||
      /^.+ timed out after \d+(?:\.\d+)?s \u2014 aborted to free the bot\.$/.test(resultText)
    ) {
      return this.finishActionCapture(capture, "timed_out", "action_timeout", resultText, [evidenceRef]);
    }
    if (/^Skill .+ was interrupted\.$/.test(resultText)) {
      return this.finishActionCapture(capture, "cancelled", "action_cancelled", resultText, [evidenceRef]);
    }
    if (/needs? (?:an? |a )?['"]?\w+['"]? param|nothing was said|non-empty ['"]?task['"]? param/i.test(resultText)) {
      return this.finishActionCapture(capture, "blocked", "invalid_params", resultText, [evidenceRef]);
    }
    if (skillSuccess !== undefined) {
      return this.finishActionCapture(
        capture,
        skillSuccess ? "unknown" : "failed",
        skillSuccess ? "skill_reported_success_unverified" : "skill_reported_failure",
        resultText,
        [evidenceRef],
        { reportedSuccess: skillSuccess, verifiedMissionProgress: null },
      );
    }
    if ((action === "chat" || action === "respond_to_chat") && /^(Said|Replied):/.test(resultText)) {
      return this.finishActionCapture(capture, "succeeded", "chat_sent", resultText, [evidenceRef], {
        reportedSuccess: true,
        verifiedMissionProgress: null,
      });
    }
    if (
      /^(?:Unknown action:|Action "[^"]+" threw:|Failed(?:\b|:)|Can't\b|Cannot\b|Couldn't\b|Nothing to\b|Refusing to\b|Blocked:|No path to the goal\b|Skill .+ (?:failed|crashed):|Skill '[^']+' not found\.)/i.test(
        resultText,
      )
    ) {
      return this.finishActionCapture(capture, "failed", "action_reported_failure", resultText, [evidenceRef], {
        reportedSuccess: false,
        verifiedMissionProgress: null,
      });
    }
    return this.finishActionCapture(capture, "unknown", "unverified_builtin_result", resultText, [evidenceRef], {
      reportedSuccess: null,
      verifiedMissionProgress: null,
    });
  }

  /**
   * Capture a top-level deterministic reflex without adding brain pause or
   * drowning gates. Respawn safety used to call the dispatcher directly, so
   * keeping this wrapper ungated preserves that behavior.
   */
  async executeDeterministicAction(
    action: string,
    params: Record<string, any>,
    thought = "Deterministic runtime action",
  ): Promise<string> {
    const capture = this.beginActionCapture({
      thought,
      action,
      params,
      metadata: { requestId: null, origin: "deterministic" },
    });
    try {
      const result = await this.actionExecutor(this.bot, action, params);
      const skillName = action === "invoke_skill" ? (params.skill as string) : action;
      const skillSuccess = result.startsWith("Already running skill ")
        ? undefined
        : this.skillOutcomeReader(this.bot, skillName);
      const observation = this.executionObservation(capture, result, skillSuccess ?? null);
      this.outcomeForExecution(capture, action, result, skillSuccess, observation.payloadRef);
      return result;
    } catch (error) {
      const message = 'Action "' + action + '" threw: ' + ((error as Error)?.message ?? String(error));
      const observation = this.executionObservation(capture, message, false);
      const interruptionReason = this.interruptionReasonSince(capture.interruptionGeneration);
      if (interruptionReason) {
        this.finishActionCapture(capture, "cancelled", interruptionReason, message, [observation.payloadRef]);
      } else {
        this.finishActionCapture(capture, "failed", "execution_exception", message, [observation.payloadRef]);
      }
      throw error;
    }
  }

  private async executeActionUnlessPaused(
    action: string,
    params: Record<string, any>,
    captureDeterministic = true,
  ): Promise<string> {
    const capture = captureDeterministic
      ? this.beginActionCapture({
          thought: "Deterministic runtime action",
          action,
          params,
          metadata: {
            requestId: null,
            origin: "deterministic",
          },
        })
      : null;
    if (this.stopped) {
      const result = "Stopped before action execution";
      if (capture) this.finishActionCapture(capture, "cancelled", "brain_stopped", result);
      return result;
    }
    if (this.paused) {
      const result = "Paused by player command";
      if (capture) this.finishActionCapture(capture, "cancelled", "brain_paused", result);
      return result;
    }
    if (headUnderWater(this.bot) && (this.bot.oxygenLevel ?? 20) < 16) {
      this.log.info("Brain", `Drowning (air ${this.bot.oxygenLevel}) — surfacing before ${action}`);
      const result = "Underwater and short of air — surfacing first, try again once breathing.";
      if (capture) this.finishActionCapture(capture, "blocked", "drowning_safety_gate", result);
      return result;
    }
    this.activeAction = action;
    try {
      const result = await this.actionExecutor(this.bot, action, params);
      if (
        /Navigation timed out|Stuck — not making progress|No path to the goal|No route from here|Couldn't reach|Couldn't move|path blocked/i.test(
          result,
        )
      ) {
        this.navFailStreak++;
      } else if (/Arrived|Explored|reached|Walked|Deposited|Withdrew|Harvested|Farm planted/i.test(result)) {
        this.navFailStreak = 0;
      }
      const noTool = /Can't harvest (\w+) with/.exec(result);
      if (noTool) {
        this.blockAction(`mine_block:${noTool[1]}`, result.slice(0, 120), BotBrain.FAILURE_TTL_STRUCTURAL_MS);
      }
      if (capture) {
        const skillName = action === "invoke_skill" ? (params.skill as string) : action;
        const skillSuccess = this.skillOutcomeReader(this.bot, skillName);
        const observation = this.executionObservation(capture, result, skillSuccess ?? null);
        this.outcomeForExecution(capture, action, result, skillSuccess, observation.payloadRef);
      }
      return result;
    } catch (error) {
      if (capture) {
        const message = `Action "${action}" threw: ${(error as Error)?.message ?? String(error)}`;
        const observation = this.executionObservation(capture, message, false);
        const interruptionReason = this.interruptionReasonSince(capture.interruptionGeneration);
        if (interruptionReason) {
          this.finishActionCapture(capture, "cancelled", interruptionReason, message, [observation.payloadRef]);
        } else {
          this.finishActionCapture(capture, "failed", "execution_exception", message, [observation.payloadRef]);
        }
      }
      throw error;
    } finally {
      this.activeAction = "";
    }
  }
  private async executeDecision(input: BrainDecision): Promise<ActionOutcome> {
    const decision: BrainDecision = { ...input, params: { ...(input.params ?? {}) } };
    const capture = this.beginActionCapture(decision);
    try {
      return await this.executeDecisionCaptured(decision, capture);
    } catch (error) {
      if (capture.outcome) {
        this.log.error("Brain", "Post-outcome callback failed: " + ((error as Error)?.message ?? String(error)));
        return capture.outcome;
      }
      const result = "Decision pipeline threw: " + ((error as Error)?.message ?? String(error));
      this.lastAction = decision.action;
      this.lastResult = result;
      try {
        this.events.onAction(decision.action, result);
      } catch {
        // The terminal event below remains authoritative when UI callbacks fail.
      }
      return this.finishActionCapture(capture, "failed", "decision_pipeline_exception", result);
    }
  }

  private async executeDecisionCaptured(decision: BrainDecision, capture: ActionCapture): Promise<ActionOutcome> {
    if (this.stopped) {
      return this.finishActionCapture(capture, "cancelled", "brain_stopped", "Stopped before action execution");
    }
    if (this.paused) {
      return this.finishActionCapture(capture, "cancelled", "brain_paused", "Paused by player command");
    }
    // Filter thought for safety
    const thoughtFilter = filterContent(decision.thought);
    if (!thoughtFilter.safe) {
      decision.thought = thoughtFilter.cleaned;
    }

    // Filter chat actions
    if ((decision.action === "chat" || decision.action === "respond_to_chat") && decision.params?.message) {
      const chatFilter = filterChatMessage(decision.params.message);
      if (!chatFilter.safe) {
        decision.params.message = chatFilter.cleaned;
      }
    }

    // Display thought
    this.events.onThought(decision.thought);
    this.log.info("Brain", `"${decision.thought}" → ${decision.action}`);
    this.log.debug("Brain", "Decision params:", JSON.stringify(decision.params));

    // Update overlay
    this.overlayUpdater({
      health: this.bot.health,
      food: this.bot.food,
      position: {
        x: this.bot.entity.position.x,
        y: this.bot.entity.position.y,
        z: this.bot.entity.position.z,
      },
      time: this.bot.time.timeOfDay < 13000 || this.bot.time.timeOfDay > 23000 ? "Daytime" : "Nighttime",
      thought: decision.thought,
      action: decision.action,
      actionResult: "...",
      inventory: this.bot.inventory.items().map((i) => `${i.name}x${i.count}`),
    });

    // TTS in background
    this.speechGenerator(decision.thought)
      .then((url) => {
        if (url) speakThought(url);
      })
      .catch(() => {});

    // Unwrap invoke_skill aliasing a built-in action (e.g. {"skill":"deposit_stash"})
    // so gating and param injection below see the real action.
    const BUILTIN_VIA_SKILL = new Set(["deposit_stash", "withdraw_stash", "gather_wood", "eat", "flee", "explore"]);
    if (decision.action === "invoke_skill" && BUILTIN_VIA_SKILL.has(decision.params?.skill)) {
      decision.action = decision.params.skill;
      delete decision.params.skill;
    }

    // ── Action gating ──
    const UNIVERSAL_ACTIONS = new Set([
      "give_item",
      "idle",
      "respond_to_chat",
      "invoke_skill",
      "deposit_stash",
      "withdraw_stash",
      "chat",
      "generate_skill",
      // Every bot must be able to MOVE and LOOK. Withholding "explore" from
      // non-scout roles meant the farmer/builder/guard fired thousands of
      // rejected look_around/scan/explore decisions (27% of Flora's actions
      // overnight) — looking like they were "standing around" when they were
      // actually stuck in a rejection loop. The alias family (scan,
      // look_around, search...) already normalizes to explore in parseDecision.
      "explore",
    ]);
    if (
      this.roleConfig.allowedActions.length > 0 &&
      !this.roleConfig.allowedActions.includes(decision.action) &&
      !UNIVERSAL_ACTIONS.has(decision.action) &&
      !this.roleConfig.allowedSkills.includes(decision.action)
    ) {
      const gateMsg = `Action "${decision.action}" not allowed for ${this.roleConfig.name}. Use: ${this.roleConfig.allowedActions.join(", ")}`;
      this.log.debug("Brain", `GATED: ${gateMsg}`);
      this.events.onAction(decision.action, gateMsg);
      this.lastResult = gateMsg;
      // Blacklist it so the RECENTLY FAILED prompt section stops the bot from
      // re-picking it — the fine-tuned model especially leaks other roles'
      // actions (trained on all five bots' decisions mixed together).
      this.blockAction(
        decision.action,
        `Not in YOUR toolkit — use: ${this.roleConfig.allowedActions.join(", ")}`,
        BotBrain.FAILURE_TTL_STRUCTURAL_MS,
      );
      return this.finishActionCapture(capture, "blocked", "role_denied", gateMsg);
    }

    // ── Blacklist check ──
    this.purgeExpiredFailures();
    const actionKey = this.getActionKey(decision);
    if (this.recentFailures.has(actionKey)) {
      const blockMsg = `Blocked: "${actionKey}" recently failed. Try something else.`;
      this.log.debug("Brain", blockMsg);
      this.events.onAction(decision.action, blockMsg);
      this.lastResult = blockMsg;
      // Trigger re-plan since this action was blocked
      setTimeout(() => this.triggerReplan(), 500);
      return this.finishActionCapture(capture, "blocked", "recent_failure_gate", blockMsg);
    }

    // ── Normalize params ──
    const normalizedParams = { ...(decision.params ?? {}) };
    const rawDecision = decision as Record<string, any>;
    for (const field of ["direction", "skill", "item", "block", "blockType", "count", "x", "y", "z", "message"]) {
      if (rawDecision[field] !== undefined && normalizedParams[field] === undefined) {
        normalizedParams[field] = rawDecision[field];
      }
    }

    if (
      (decision.action === "chat" || decision.action === "respond_to_chat") &&
      (typeof normalizedParams.message !== "string" || !normalizedParams.message.trim())
    ) {
      const msg = `${decision.action} needs a 'message' param — nothing was said.`;
      this.events.onAction(decision.action, msg);
      this.lastResult = msg;
      return this.finishActionCapture(capture, "blocked", "invalid_params", msg);
    }
    // Chat dedup — refuse to re-broadcast a near-identical message
    if ((decision.action === "chat" || decision.action === "respond_to_chat") && normalizedParams.message) {
      const sig = String(normalizedParams.message).slice(0, 40);
      if (sig === this.lastChatSent && Date.now() - this.lastChatSentMs < 180_000) {
        const msg =
          "You already said that. Talking won't make it happen — ACT instead (check your inventory first; you may already have what you asked for).";
        this.events.onAction(decision.action, msg);
        this.lastResult = msg;
        return this.finishActionCapture(capture, "blocked", "duplicate_chat", msg);
      }
      this.lastChatSent = sig;
      this.lastChatSentMs = Date.now();
    }

    // Inject stash config
    if ((decision.action === "deposit_stash" || decision.action === "withdraw_stash") && this.roleConfig.stashPos) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
      normalizedParams.keepItems = this.roleConfig.keepItems;
      // The ingot pocket-reserve assumes the holder can craft with it. A bot
      // with no craft action and no craft_gear skill (Atlas) just hoards:
      // he carried 9 iron ingots for a day while the toolsmith sat 1 ingot
      // short of the iron pickaxe. Non-crafters bank every ingot.
      // The ingot/diamond pocket reserve is for bots that can both craft AND
      // mine — they alone can complete a 3-diamond set on their own. Blade
      // (craft yes, mine no) kept 1 diamond as dead capital for five runs:
      // he can never dig the other two, and the divers can't use his one.
      const canCraft =
        this.roleConfig.allowedActions.includes("craft") || this.roleConfig.allowedSkills.includes("craft_gear");
      const canMine =
        this.roleConfig.allowedActions.includes("mine_block") || this.roleConfig.allowedSkills.includes("strip_mine");
      // Only the primary smith keeps iron; a second crafter-miner hoarding its
      // own reserve is what split the team's 4 ingots 2-and-2 so neither could
      // craft a pickaxe. Everyone else pools it for the smith to consolidate.
      if (!(canCraft && canMine && this.roleConfig.primarySmith)) normalizedParams.materialReserve = 0;
      normalizedParams.canMine = canMine;
    }

    // Protect the village site from being strip-mined into bot-trapping pits
    if (decision.action === "mine_block" && this.roleConfig.stashPos) {
      normalizedParams.protectPos = this.roleConfig.stashPos;
    }

    // Inject the farm site (lake shore) into build_farm so the skill can
    // travel to water instead of failing "no water within 96 blocks"
    const isBuildFarm =
      decision.action === "build_farm" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "build_farm");
    if (isBuildFarm && normalizedParams.x === undefined) {
      normalizedParams.x = FARM_SITE.x;
      normalizedParams.y = FARM_SITE.y;
      normalizedParams.z = FARM_SITE.z;
    }
    // build_farm's bake step withdraws pooled wheat from the stash to bake a
    // real bread batch (harvests are too small/scattered to bake individually).
    if (isBuildFarm && this.roleConfig.stashPos && normalizedParams.stashPos === undefined) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
    }

    // Inject stash coordinates into setup_stash — the LLM invents garbage coords otherwise
    const isSetupStash =
      decision.action === "setup_stash" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "setup_stash");
    if (isSetupStash && this.roleConfig.stashPos) {
      normalizedParams.x = this.roleConfig.stashPos.x;
      normalizedParams.y = this.roleConfig.stashPos.y;
      normalizedParams.z = this.roleConfig.stashPos.z;
    }

    // Give smelt_ores the stash position so it can withdraw ore/fuel the team
    // already mined. Bots kept invoking smelt empty-handed ("Nothing to smelt"
    // / "No fuel") because the miner deposits ore+coal and a different bot
    // smelts — this connects them via the shared stash.
    const isSmelt =
      decision.action === "smelt_ores" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "smelt_ores");
    if (isSmelt && this.roleConfig.stashPos && normalizedParams.stashPos === undefined) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
    }

    // Give craft_gear the stash position so it can withdraw iron ingots the team
    // already smelted (the stash is the shared warehouse — use it, per design).
    const isCraftGear =
      decision.action === "craft_gear" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "craft_gear");
    if (isCraftGear && this.roleConfig.stashPos && normalizedParams.stashPos === undefined) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
    }

    // build_house pulls planks/logs from the stash so the builder isn't blocked
    // chopping a whole house's worth of wood from scratch.
    const isBuildHouse =
      decision.action === "build_house" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "build_house");
    if (isBuildHouse && this.roleConfig.stashPos && normalizedParams.stashPos === undefined) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
    }

    // light_area pulls torches from the stash (or crafts them) so it stops
    // failing "No torches" — lit caves cut the top death cause (cave mobs).
    const isLightArea =
      decision.action === "light_area" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "light_area");
    if (isLightArea && this.roleConfig.stashPos && normalizedParams.stashPos === undefined) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
    }

    appendEpisodeEvent(
      {
        botId: capture.botId,
        episodeId: capture.episodeId,
        actionId: capture.actionId,
        requestId: capture.requestId,
        kind: "observation",
      },
      {
        captureVersion: 1,
        stage: "normalized_decision",
        action: decision.action,
        params: normalizedParams,
      },
    );
    // ── Execute ──
    // Do not walk back into the place that keeps killing you.
    //
    // Forge died 31 times in under two hours, median gap 53 seconds, five inside
    // 94 seconds, wearing an iron chestplate for 16 of them. 13 of those deaths
    // are within 8 blocks of one tunnel. He respawns at base, walks back, dies.
    //
    // The respawn-loop breaker fired 7 times and did not help, because it resets
    // the SPAWN point and the danger is where he walks to. memory's
    // shouldAvoidLocation has existed all along with zero callers, and the
    // prompt already says "RECENT DEATHS at (x,y,z)" — the model read that and
    // went back thirteen times. Advice the model can ignore is not a guard.
    //
    // The base is exempt: deaths cluster at the stash too, and refusing to go
    // there would stop the swarm depositing, which is worse than the deaths.
    if (typeof normalizedParams.x === "number" && typeof normalizedParams.z === "number") {
      const target = { x: normalizedParams.x as number, z: normalizedParams.z as number };
      const atBase = isAtBase(
        { x: target.x, y: (normalizedParams.y as number) ?? this.roleConfig.stashPos?.y ?? 0, z: target.z },
        this.roleConfig.stashPos,
      );
      if (isDeathTrap(target, this.memStore.getDeaths(), Date.now(), atBase)) {
        const msg =
          `Refusing to go to ${target.x},${target.z} — you have died there repeatedly in the last 20 minutes. ` +
          `Pick somewhere else, or clear the threat first.`;
        this.log.info("Brain", `DEATH TRAP: ${this.roleConfig.name} blocked from ${target.x},${target.z}`);
        this.events.onAction(decision.action, msg);
        this.lastResult = msg;
        this.blockAction(decision.action, msg, BotBrain.FAILURE_TTL_TRANSIENT_MS);
        return this.finishActionCapture(capture, "blocked", "death_trap_gate", msg);
      }
    }

    let result: string;
    try {
      result = await this.executeActionUnlessPaused(decision.action, normalizedParams, false);
    } catch (error) {
      result = `Action "${decision.action}" threw: ${(error as Error)?.message ?? String(error)}`;
      this.lastAction = decision.action;
      this.lastResult = result;
      this.events.onAction(decision.action, result);
      const observation = this.executionObservation(capture, result, false);
      const interruptionReason = this.interruptionReasonSince(capture.interruptionGeneration);
      if (interruptionReason) {
        return this.finishActionCapture(capture, "cancelled", interruptionReason, result, [observation.payloadRef]);
      }
      return this.finishActionCapture(capture, "failed", "execution_exception", result, [observation.payloadRef]);
    }
    this.lastAction = decision.action;
    this.lastResult = result;
    this.events.onAction(decision.action, result);
    this.log.info("Brain", `Result: ${result}`);

    const skillName = decision.action === "invoke_skill" ? (normalizedParams.skill as string) : decision.action;
    const skillReportedSuccess = result.startsWith("Already running skill ")
      ? undefined
      : this.skillOutcomeReader(this.bot, skillName);
    const isSuccess = skillReportedSuccess ?? classifyResult(result);
    const executionEvent = this.executionObservation(capture, result, skillReportedSuccess ?? null);
    const outcome = this.outcomeForExecution(
      capture,
      decision.action,
      result,
      skillReportedSuccess,
      executionEvent.payloadRef,
    );

    // A bot wedged in a pit is not immobile, so nothing rescued it.
    //
    // The dig-out already exists and the pit already qualifies for it, but it
    // only runs when the bot is idle or has not moved in 90 seconds. A bot
    // thrashing in a hole is neither: it is processing continuously, and each
    // failed path shuffles it enough to reset the movement clock.
    //
    // Measured in one 52 minute session: 204 navigation stalls, 111 of them at
    // a single spot four blocks from the stash and three blocks below it, walls
    // of cobblestone on three sides. maxDropDown=3 lets a bot walk INTO that,
    // and safeMoves forbids both digging and towers, so it cannot climb out.
    // Ore mined that hour: zero.
    //
    // Count consecutive stalls instead of watching the position. Repeated
    // failure to reach anything is the symptom that matters, whether or not the
    // bot is shuffling while it fails.
    if (isStallResult(result)) {
      const now = Date.now();
      this.recentStalls = pruneStalls([...this.recentStalls, now], now);
      if (shouldForceDigOut(this.recentStalls, now)) {
        this.log.info(
          "Brain",
          `${this.roleConfig.name} stalled ${this.recentStalls.length}x in 3min — forcing dig-out`,
        );
        this.recentStalls = [];
        // Log the OUTCOME, not just the call. digOutIfStuck returns false
        // immediately when fewer than three walls surround the bot, so 21
        // "forcing dig-out" lines could be 21 escapes or 21 no-ops and the log
        // reads the same. That ambiguity is why I could not explain why Forge
        // kept stalling at 4.5/min while the rescue appeared to be running.
        const dug = await digOutIfStuck(this.bot).catch(() => false);
        this.log.info(
          "Brain",
          `${this.roleConfig.name} dig-out ${dug ? "ATTEMPTED an escape" : "declined (not boxed in)"}`,
        );
      }
    }

    // Update team bulletin
    updateBulletin({
      name: this.roleConfig.name,
      action: decision.action,
      position: {
        x: this.bot.entity.position.x,
        y: this.bot.entity.position.y,
        z: this.bot.entity.position.z,
      },
      thought: decision.thought,
      health: this.bot.health,
      food: this.bot.food,
      timestamp: Date.now(),
      goal: this.currentGoal || decision.goal,
      lastResult: result.slice(0, 120),
    });

    // Update overlay with result
    this.overlayUpdater({
      health: this.bot.health,
      food: this.bot.food,
      position: {
        x: this.bot.entity.position.x,
        y: this.bot.entity.position.y,
        z: this.bot.entity.position.z,
      },
      time: this.bot.time.timeOfDay < 13000 || this.bot.time.timeOfDay > 23000 ? "Daytime" : "Nighttime",
      actionResult: result,
      inventory: this.bot.inventory.items().map((i) => `${i.name}x${i.count}`),
    });

    // ── Track goal ──
    if (decision.goal) {
      this.currentGoal = decision.goal;
      this.goalStepsLeft = decision.goalSteps || 5;
    }

    // ── Scoreboard ──
    // (isSuccess computed below — record after it)
    // Skills know whether they worked; only prose has to be guessed at. Reading
    // the recorded boolean first is what stops "HOUSE BUILT!" scoring as a
    // failure and blacklisting a skill that works.

    this.lastActionWasSuccess = isSuccess;
    recordAction(this.roleConfig.name, decision.action, result, isSuccess);
    if (decision.action === "invoke_skill" || skillRegistry.has(decision.action)) {
      recordSkillResult(this.roleConfig.name, isSuccess);
    }
    checkInventoryMilestones(this.bot, this.roleConfig.name);

    // Track repeats
    if (decision.action !== "idle") {
      if (actionKey === this.lastAction) {
        this.repeatCount++;
      } else {
        this.repeatCount = 1;
      }
    }

    // "No food" is not transient: food appears only when someone works, so
    // the generic three-repeats-then-brief-block cycle let hungry bots burn
    // three hundred decisions an hour re-ordering from an empty kitchen.
    // Block eat immediately and for long enough that a real restock (a farm
    // harvest, a hunt, a stash run) can happen before the next attempt.
    if (result.startsWith("No food in inventory")) {
      this.blockAction("eat", "No food to eat — withdraw some or work your trade first.", 10 * 60_000);
    }

    // General repeat-breaker: the same action producing the SAME result 3x in
    // a row is a stuck loop — even if the action reports "success" (e.g. Flora
    // "withdrew" planks 6x that never arrived, or chat begging). Blacklist it
    // briefly and force a re-plan so no buggy effector can trap a bot forever.
    const resultSig = `${actionKey}|${result.slice(0, 60)}`;
    if (decision.action !== "idle" && resultSig === this.lastResultSig) {
      this.sameResultCount++;
      if (this.sameResultCount >= 2) {
        this.blockAction(actionKey, `Stuck repeating "${decision.action}" with no change — do something different.`);
        this.sameResultCount = 0;
        this.lastResultSig = "";
        setTimeout(() => this.triggerReplan(), 300);
      }
    } else {
      this.sameResultCount = 0;
      this.lastResultSig = resultSig;
    }

    // Failure tracking
    this.trackFailure(actionKey, decision, result, isSuccess);

    // Track goal steps
    if (isSuccess && this.goalStepsLeft > 0) {
      this.goalStepsLeft--;
    }

    // Lock home position when first house built
    if (isSuccess && decision.action === "build_house" && !this.homePos) {
      const p = this.bot.entity.position;
      this.homePos = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
      this.log.debug("Brain", `Home locked at ${this.homePos.x}, ${this.homePos.y}, ${this.homePos.z}`);
    }

    // Track history
    this.recentHistory.push({
      role: "assistant",
      content: `I decided to ${decision.action}: ${decision.thought}. Result: ${result}`,
    });
    if (this.recentHistory.length > 12) {
      this.recentHistory.splice(0, this.recentHistory.length - 8);
    }

    // ── Trigger critic ──
    if (this.CRITIC_ENABLED && !["idle", "chat", "respond_to_chat"].includes(decision.action)) {
      this.pushEvent({
        type: "critic",
        priority: 6,
        data: {
          action: decision.action,
          result,
          goal: this.currentGoal,
        },
        timestamp: Date.now(),
      });
    }
    return outcome;
  }

  // ─── Failure tracking ─────────────────────────────────────────────────────

  private getActionKey(decision: { action: string; params: Record<string, any> }): string {
    if (decision.action === "invoke_skill" && decision.params?.skill) {
      return `skill:${decision.params.skill}`;
    }
    if (skillRegistry.has(decision.action)) {
      return `skill:${decision.action}`;
    }
    if (decision.action === "craft" && decision.params?.item) {
      return `craft:${decision.params.item}`;
    }
    if (decision.action === "mine_block") {
      const b = decision.params?.block ?? decision.params?.blockType ?? decision.params?.item;
      if (typeof b === "string" && b) return `mine_block:${b}`;
    }
    return decision.action;
  }

  private trackFailure(
    actionKey: string,
    decision: { action: string; params: Record<string, any> },
    result: string,
    isSuccess: boolean,
  ): void {
    // Hallucinated action names
    if (result.startsWith("Unknown action:")) {
      this.blockAction(decision.action, "Unknown action", BotBrain.FAILURE_TTL_STRUCTURAL_MS);
      return;
    }

    // Retired skills — put them straight into the do-NOT-retry prompt list
    // so the LLM stops re-picking them from conversation history.
    if (result.includes("is RETIRED")) {
      this.blockAction(
        actionKey,
        "Retired — proven broken, use basic actions instead",
        BotBrain.FAILURE_TTL_STRUCTURAL_MS,
      );
      return;
    }

    const isSkillAction =
      skillRegistry.has(decision.action) ||
      decision.action === "invoke_skill" ||
      decision.action === "neural_combat" ||
      decision.action === "generate_skill" ||
      decision.action === "craft";

    if (!isSkillAction) {
      // Track "attack" no-target failures
      if (decision.action === "attack" && /no mobs to attack nearby/i.test(result)) {
        const prevCount = (this.failureCounts.get("attack") ?? 0) + 1;
        this.failureCounts.set("attack", prevCount);
        if (prevCount >= 3) {
          this.blockAction("attack", "No mobs nearby — explore first");
        }
      } else if (decision.action === "attack" && isSuccess) {
        this.failureCounts.delete("attack");
        this.recentFailures.delete("attack");
      }
    }

    if (isSkillAction) {
      if (!isSuccess) {
        const isAlreadyRunning = result.startsWith("Already running skill");
        const isPreconditionFailure =
          /missing:|need \d|no water|no trees|no coal|no iron|no pickaxe|Can't craft|could not find|not enough|need to (mine|craft|find|smelt)|Can't sleep|terrain too rough|not nighttime|already sleeping|zzz/i.test(
            result,
          );

        if (!isAlreadyRunning && !isPreconditionFailure) {
          const prevCount = (this.failureCounts.get(actionKey) ?? 0) + 1;
          this.failureCounts.set(actionKey, prevCount);
          if (prevCount >= 2) {
            this.blockAction(actionKey, result.slice(0, 120));
          }
        } else if (!isAlreadyRunning && /no trees/i.test(result)) {
          this.blockAction(actionKey, "No trees — explore first");
        } else if (!isAlreadyRunning && /no water/i.test(result)) {
          this.blockAction(actionKey, "No water — explore first");
        }
      } else {
        this.failureCounts.delete(actionKey);
        this.recentFailures.delete(actionKey);
        this.clearBlockHistory(actionKey);
      }
    }

    // Expire old failures every 8 successes
    if (isSuccess) {
      this.successesSinceLastExpiry++;
      if (this.successesSinceLastExpiry >= 8 && this.recentFailures.size > 0) {
        this.successesSinceLastExpiry = 0;
        for (const [firstKey, firstMsg] of this.recentFailures.entries()) {
          if (!/no water found/i.test(firstMsg) && !/need 3 wool/i.test(firstMsg)) {
            this.recentFailures.delete(firstKey);
            break;
          }
        }
      }
    }

    // Dynamic precondition clearing
    for (const [key, msg] of this.recentFailures.entries()) {
      if (/missing.*coal/i.test(msg)) {
        const count = this.bot.inventory
          .items()
          .filter((i) => i.name === "coal")
          .reduce((s, i) => s + i.count, 0);
        if (count > 0) {
          this.recentFailures.delete(key);
          this.failureCounts.delete(key);
        }
      } else if (/missing.*stick/i.test(msg)) {
        const count = this.bot.inventory
          .items()
          .filter((i) => i.name === "stick")
          .reduce((s, i) => s + i.count, 0);
        if (count > 0) {
          this.recentFailures.delete(key);
          this.failureCounts.delete(key);
        }
      } else if (/missing.*wood|missing.*log|missing.*plank/i.test(msg)) {
        const count = this.bot.inventory
          .items()
          .filter((i) => i.name.includes("log") || i.name.includes("planks"))
          .reduce((s, i) => s + i.count, 0);
        if (count > 0) {
          this.recentFailures.delete(key);
          this.failureCounts.delete(key);
        }
      } else if (/no torch/i.test(msg)) {
        const count = this.bot.inventory
          .items()
          .filter((i) => i.name === "torch")
          .reduce((s, i) => s + i.count, 0);
        if (count > 0) {
          this.recentFailures.delete(key);
          this.failureCounts.delete(key);
        }
      }
    }
  }
}
