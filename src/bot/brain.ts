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

import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { config } from "../config.js";
import { BotRoleConfig } from "./role.js";
import { queryStrategic, queryReactive, queryCritic, chatWithLLM, type LLMMessage } from "../llm/index.js";
import type { RoleContext } from "../llm/prompts.js";
import { getWorldContext, isHostile } from "./perception.js";
import { executeAction } from "./actions.js";
import { updateOverlay, addChatMessage, speakThought, setCurrentBot } from "../stream/overlay.js";
import { generateSpeech } from "../stream/tts.js";
import { filterContent, filterChatMessage, filterViewerMessage } from "../safety/filter.js";
import { abortActiveSkill, isSkillRunning, getActiveSkillName } from "../skills/executor.js";
import { skillRegistry } from "../skills/registry.js";
import { BotMemoryStore } from "./memory.js";
import { updateBulletin, formatTeamBulletin } from "./bulletin.js";
import { createLogger } from "../util/logger.js";

export interface ChatMessage {
  source: "minecraft" | "twitch" | "youtube";
  username: string;
  message: string;
  timestamp: number;
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

  // Processing state
  private processing = false;
  private stopped = false;
  private eventQueue: BrainEvent[] = [];

  // Timers
  private idleTimer: NodeJS.Timeout | null = null;
  private hostileScanner: NodeJS.Timeout | null = null;
  private overlayInterval: NodeJS.Timeout | null = null;

  // Decision state (migrated from the old decide() function)
  private currentGoal = "";
  private goalStepsLeft = 0;
  private lastAction = "";
  private lastResult = "";
  private lastActionWasSuccess = false;
  private repeatCount = 0;
  private recentHistory: LLMMessage[] = [];
  private pendingChatMessages: ChatMessage[] = [];

  // Failure tracking
  private recentFailures = new Map<string, string>();
  private failureCounts = new Map<string, number>();
  private successesSinceLastExpiry = 0;

  // Leash
  private homePos: { x: number; y: number; z: number } | null;

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
      this.recentFailures.set(`skill:${skill}`, msg);
    }
    if (this.recentFailures.size > 0) {
      this.log.debug("Brain", `Pre-populated ${this.recentFailures.size} blacklist entries from memory`);
    }
  }

  /** Start the event-driven brain. Call after spawn safety completes. */
  start(): void {
    this.log.info("Brain", `Starting (idle interval: ${this.IDLE_INTERVAL_MS}ms)`);

    // 1. Idle timer — triggers strategic planning when nothing else is happening
    this.resetIdleTimer();

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
        seasonGoal: this.memStore.getSeasonGoal() ?? undefined,
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
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.hostileScanner) clearInterval(this.hostileScanner);
    if (this.overlayInterval) clearInterval(this.overlayInterval);
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
    if (this.stopped) return;
    this.idleTimer = setTimeout(() => {
      this.pushEvent({ type: "strategic", priority: 5, timestamp: Date.now() });
      this.resetIdleTimer();
    }, this.IDLE_INTERVAL_MS);
  }

  private pushEvent(event: BrainEvent): void {
    if (this.stopped) return;

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
    if (this.processing || this.stopped) return;
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
      if (this.eventQueue.length > 0 && !this.stopped) {
        setImmediate(() => this.processNext());
      }
    }
  }

  // ─── Hostile scanning ─────────────────────────────────────────────────────

  private scanHostiles(): void {
    if (this.processing || this.stopped) return;
    if (isSkillRunning(this.bot)) return; // Don't interrupt skills

    const now = Date.now();
    if (now - this.lastReactiveMs < this.REACTIVE_COOLDOWN_MS) return;

    const hostiles = Object.values(this.bot.entities).filter(
      (e) => e !== this.bot.entity && isHostile(e) && e.position.distanceTo(this.bot.entity.position) < 16,
    );

    if (hostiles.length === 0) return;

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

  private checkVitals(): void {
    if (this.stopped) return;
    const now = Date.now();
    if (now - this.lastReactiveMs < this.REACTIVE_COOLDOWN_MS) return;

    if (this.bot.health <= 6) {
      this.pushEvent({
        type: "reactive",
        priority: 0,
        data: { reason: "low_health", health: this.bot.health },
        timestamp: now,
      });
    } else if (this.bot.food <= 6) {
      this.pushEvent({
        type: "reactive",
        priority: 2,
        data: { reason: "low_hunger", food: this.bot.food },
        timestamp: now,
      });
    }
  }

  // ─── Safety overrides ─────────────────────────────────────────────────────

  /** Check for water/underground and handle before LLM query. Returns true if override handled. */
  private async runSafetyOverrides(): Promise<boolean> {
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
        this.bot.chat(`/tp ${x} 80 ${z}`);
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
      this.bot.chat(`/tp ${tx} 80 ${tz}`);
      await new Promise((r) => setTimeout(r, 2000));
      return true;
    }

    return false;
  }

  // ─── Context building ─────────────────────────────────────────────────────

  /** Build the world context string for strategic decisions. */
  private buildContext(): string {
    const worldContext = getWorldContext(this.bot);
    let ctx = `CURRENT STATE:\n${worldContext}`;

    // Pending chat messages
    if (this.pendingChatMessages.length > 0) {
      const chatStr = this.pendingChatMessages.map((m) => `[${m.source}] ${m.username}: ${m.message}`).join("\n");
      ctx += `\n\nMESSAGES FROM PLAYERS/VIEWERS:\n${chatStr}`;
      this.pendingChatMessages.length = 0;
    }

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
        .map(
          (e: Entity) =>
            `${e.name || e.mobType} (${e.position.distanceTo(this.bot.entity.position).toFixed(0)} blocks)`,
        )
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

    const decision = await queryReactive(this.roleConfig.name, situation, this.roleConfig.allowedActions);
    await this.executeDecision(decision);
  }

  private async handleChat(event: BrainEvent): Promise<void> {
    const msg = event.data as ChatMessage;
    if (!msg) return;

    const activity = `${this.lastAction || "exploring"} (${this.currentGoal || "no specific goal"})`;
    const response = await chatWithLLM(`[${msg.source}] ${msg.username}: ${msg.message}`, activity, {
      name: this.roleConfig.name,
    });

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

    // Leash hard override — skip LLM entirely if way too far from home
    if (this.homePos && this.roleConfig.leashRadius > 0) {
      const dx = this.bot.entity.position.x - this.homePos.x;
      const dz = this.bot.entity.position.z - this.homePos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= this.roleConfig.leashRadius * 1.5) {
        this.log.info("Brain", `LEASH: ${dist.toFixed(0)} blocks away — forcing return home`);
        const result = await executeAction(this.bot, "go_to", this.homePos);
        this.events.onAction("go_to", result);
        return;
      }
    }

    const context = this.buildContext();
    const memoryCtx = this.memStore.getMemoryContext();
    const role: RoleContext = {
      name: this.roleConfig.name,
      personality: this.roleConfig.personality,
      role: this.roleConfig.role,
      seasonGoal: this.memStore.getSeasonGoal(),
      allowedActions: this.roleConfig.allowedActions,
      allowedSkills: this.roleConfig.allowedSkills,
      priorities: this.roleConfig.priorities,
    };

    const decision = await queryStrategic(context, this.recentHistory, memoryCtx, role);
    await this.executeDecision(decision);
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

    const verdict = await queryCritic(this.roleConfig.name, criticContext, this.roleConfig.allowedActions);

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
    } else if (verdict.nextAction && verdict.success) {
      // Critic suggests next step — execute directly without full LLM call
      this.log.debug("Brain:critic", `Next step: ${verdict.nextAction}`);
      await this.executeDecision({
        thought: verdict.thought,
        action: verdict.nextAction,
        params: verdict.nextParams,
      });
    } else if (!verdict.success) {
      // Action failed — trigger strategic re-plan
      this.log.info("Brain:critic", "Action failed. Re-planning.");
      setTimeout(() => this.triggerReplan(), 500);
    }
  }

  // ─── Action execution ─────────────────────────────────────────────────────

  private async executeDecision(decision: {
    thought: string;
    action: string;
    params: Record<string, any>;
    goal?: string;
    goalSteps?: number;
  }): Promise<void> {
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
    updateOverlay({
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
    generateSpeech(decision.thought)
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
      "idle",
      "respond_to_chat",
      "invoke_skill",
      "deposit_stash",
      "withdraw_stash",
      "chat",
      "generate_skill",
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
      return;
    }

    // ── Blacklist check ──
    const actionKey = this.getActionKey(decision);
    if (this.recentFailures.has(actionKey)) {
      const blockMsg = `Blocked: "${actionKey}" recently failed. Try something else.`;
      this.log.debug("Brain", blockMsg);
      this.events.onAction(decision.action, blockMsg);
      this.lastResult = blockMsg;
      // Trigger re-plan since this action was blocked
      setTimeout(() => this.triggerReplan(), 500);
      return;
    }

    // ── Normalize params ──
    const normalizedParams = { ...(decision.params ?? {}) };
    const rawDecision = decision as Record<string, any>;
    for (const field of ["direction", "skill", "item", "block", "blockType", "count", "x", "y", "z", "message"]) {
      if (rawDecision[field] !== undefined && normalizedParams[field] === undefined) {
        normalizedParams[field] = rawDecision[field];
      }
    }

    // Inject stash config
    if ((decision.action === "deposit_stash" || decision.action === "withdraw_stash") && this.roleConfig.stashPos) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
      normalizedParams.keepItems = this.roleConfig.keepItems;
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

    // ── Execute ──
    const result = await executeAction(this.bot, decision.action, normalizedParams);
    this.lastAction = decision.action;
    this.lastResult = result;
    this.events.onAction(decision.action, result);
    this.log.info("Brain", `Result: ${result}`);

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
    });

    // Update overlay with result
    updateOverlay({
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

    // ── Track success/failure ──
    const isSuccess =
      /complet|harvest|built|planted|smelted|crafted|arriv|gather|mined|caught|lit|bridg|chop|killed|ate|explored|placed|fished|sleep|zzz/i.test(
        result,
      );
    this.lastActionWasSuccess = isSuccess;

    // Track repeats
    if (decision.action !== "idle") {
      if (actionKey === this.lastAction) {
        this.repeatCount++;
      } else {
        this.repeatCount = 1;
      }
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
      this.recentFailures.set(decision.action, "Unknown action");
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
          this.recentFailures.set("attack", "No mobs nearby — explore first");
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
            this.recentFailures.set(actionKey, result.slice(0, 120));
          }
        } else if (!isAlreadyRunning && /no trees/i.test(result)) {
          this.recentFailures.set(actionKey, "No trees — explore first");
        } else if (!isAlreadyRunning && /no water/i.test(result)) {
          this.recentFailures.set(actionKey, "No water — explore first");
        }
      } else {
        this.failureCounts.delete(actionKey);
        this.recentFailures.delete(actionKey);
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
