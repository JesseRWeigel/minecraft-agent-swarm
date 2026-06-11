import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder } = pathfinderPkg;
import customPvpPkg from "@nxg-org/mineflayer-custom-pvp";
const customPvp = (customPvpPkg as any).default ?? customPvpPkg;
import { loader as autoEat } from "mineflayer-auto-eat";
import { config } from "../config.js";
import { registerBot as registerViewerBot, isUnifiedViewerStarted } from "../stream/unified-viewer.js";
import { startViewer } from "../stream/viewer.js";
import { addChatMessage, setCurrentBot } from "../stream/overlay.js";
import { abortActiveSkill } from "../skills/executor.js";
import { registerBotMemory } from "./memory-registry.js";
import { skillRegistry } from "../skills/registry.js";
import { BotMemoryStore } from "./memory.js";
import { BotRoleConfig, ATLAS_CONFIG } from "./role.js";
import { spawn } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { isNeuralServerRunning } from "../neural/bridge.js";
import { BotBrain, type ChatMessage, type BrainEvents } from "./brain.js";

// Re-export types used by src/index.ts
export type { ChatMessage, BrainEvents as BotEvents };

async function ensureNeuralServer(): Promise<void> {
  if (await isNeuralServerRunning()) {
    console.log("[Bot] Neural server already running.");
    return;
  }
  console.log("[Bot] Starting neural server...");
  const proc = spawn("python3", [path.resolve(__dirname, "../../neural_server.py")], { stdio: "pipe" });
  proc.stdout?.on("data", (d) => console.log(`[Neural] ${d.toString().trim()}`));
  proc.stderr?.on("data", (d) => console.log(`[Neural] ${d.toString().trim()}`));
  proc.on("exit", (code) => console.log(`[Neural] Server exited (${code})`));

  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isNeuralServerRunning()) {
      console.log("[Bot] Neural server ready.");
      return;
    }
  }
  console.warn("[Bot] Neural server timed out — combat fallback active.");
}

export async function createBot(events: BrainEvents, roleConfig: BotRoleConfig = ATLAS_CONFIG) {
  ensureNeuralServer().catch((e) => console.warn("[Bot] Neural spawn error:", e));

  // Load memory — register with executor so skill results go to this bot's file.
  const memStore = new BotMemoryStore(roleConfig.memoryFile);
  memStore.load();
  memStore.healBrokenSkillsFromRegistry(new Set(skillRegistry.keys()));

  console.log(`[Bot] Connecting to ${config.mc.host}:${config.mc.port} as ${roleConfig.username}...`);

  const bot = mineflayer.createBot({
    host: config.mc.host,
    port: config.mc.port,
    username: roleConfig.username,
    version: config.mc.version,
    auth: config.mc.auth,
    checkTimeoutInterval: 120_000,
  });

  registerBotMemory(bot, memStore);

  // Load plugins
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(customPvp);
  bot.loadPlugin(autoEat);

  // ── Create the event-driven brain ──
  const brain = new BotBrain(bot, roleConfig, events, memStore);

  // ── Spawn safety ──────────────────────────────────────────────────────────
  let spawnSafetyRunning = false;
  let resolveSpawnSafetyDone!: () => void;
  const spawnSafetyDone = new Promise<void>((r) => {
    resolveSpawnSafetyDone = r;
  });

  async function runSpawnSafety() {
    if (spawnSafetyRunning) return;
    spawnSafetyRunning = true;
    await new Promise((r) => setTimeout(r, 800));

    if (roleConfig.safeSpawn) {
      const { x, z } = roleConfig.safeSpawn;
      console.log(`[Bot] safeSpawn configured — teleporting to ${x},80,${z}`);
      const preTpX = bot.entity.position.x;
      const preTpZ = bot.entity.position.z;
      bot.chat(`/tp ${x} 80 ${z}`);
      const moveDeadline = Date.now() + 5_000;
      while (Date.now() < moveDeadline) {
        await new Promise((r) => setTimeout(r, 200));
        const moved = Math.abs(bot.entity.position.x - preTpX) + Math.abs(bot.entity.position.z - preTpZ);
        if (moved > 5) break;
      }
      const landDeadline = Date.now() + 6_000;
      while (!bot.entity.onGround && Date.now() < landDeadline) {
        await new Promise((r) => setTimeout(r, 200));
        const feetBlock = bot.blockAt(bot.entity.position);
        if (feetBlock?.name === "water") break;
      }
      const feetCheck = bot.blockAt(bot.entity.position);
      if (feetCheck?.name === "water") {
        console.warn(`[Bot] safeSpawn landed in water — falling through to water handler`);
        spawnSafetyRunning = false;
        resolveSpawnSafetyDone();
        return;
      }
      const lx = Math.floor(bot.entity.position.x);
      const ly = Math.floor(bot.entity.position.y);
      const lz = Math.floor(bot.entity.position.z);
      console.log(`[Bot] Landed at ${lx},${ly},${lz} — setting spawnpoint`);
      bot.chat(`/spawnpoint ${roleConfig.username} ${lx} ${ly} ${lz}`);
      spawnSafetyRunning = false;
      resolveSpawnSafetyDone();
      return;
    }

    // If still falling, wait until onGround
    if (!bot.entity.onGround) {
      console.log(`[Bot] Spawn at Y=${bot.entity.position.y.toFixed(1)} — waiting for landing...`);
      const deadline = Date.now() + 60_000;
      while (!bot.entity.onGround && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!bot.entity.onGround) {
        const px = Math.floor(bot.entity.position.x);
        const pz = Math.floor(bot.entity.position.z);
        bot.chat(`/tp ${px} 80 ${pz}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    const pos = bot.entity.position;
    const feet = bot.blockAt(pos);
    const below = bot.blockAt(pos.offset(0, -1, 0));

    // In water — find land
    if (feet?.name === "water" || below?.name === "water") {
      console.log("[Bot] In water — using /tp to find land");
      const sx = Math.floor(pos.x);
      const sz = Math.floor(pos.z);
      let foundLand = false;
      for (const [dx, dz] of [
        [0, 300],
        [300, 0],
        [0, -300],
        [-300, 0],
        [300, 300],
      ]) {
        bot.chat(`/tp ${sx + dx} 80 ${sz + dz}`);
        await new Promise((r) => setTimeout(r, 3000));
        const fb = bot.blockAt(bot.entity.position);
        if (fb && fb.name !== "water" && fb.name !== "air") {
          const lx = Math.floor(bot.entity.position.x);
          const ly = Math.floor(bot.entity.position.y);
          const lz = Math.floor(bot.entity.position.z);
          bot.chat(`/spawnpoint ${roleConfig.username} ${lx} ${ly} ${lz}`);
          console.log(`[Bot] Spawnpoint set to land at ${lx},${ly},${lz}`);
          foundLand = true;
          break;
        }
      }
      if (!foundLand) console.warn("[Bot] Could not find dry land for spawnpoint");
      spawnSafetyRunning = false;
      resolveSpawnSafetyDone();
      return;
    }

    // Underground — TP to surface
    if (pos.y < 100) {
      let hasCeiling = false;
      for (let dy = 1; dy <= 6; dy++) {
        const b = bot.blockAt(pos.offset(0, dy, 0));
        if (b && b.name !== "air" && b.name !== "cave_air") {
          hasCeiling = true;
          break;
        }
      }
      if (hasCeiling) {
        const sx = Math.floor(pos.x);
        const sz = Math.floor(pos.z);
        console.log(`[Bot] Underground at Y=${pos.y.toFixed(0)} — /tp to surface`);
        bot.chat(`/effect give ${roleConfig.username} slow_falling 60 1`);
        await new Promise((r) => setTimeout(r, 500));
        bot.chat(`/tp ${sx} 200 ${sz}`);
        const deadline = Date.now() + 60_000;
        while (!bot.entity.onGround && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    }

    const lx = Math.floor(bot.entity.position.x);
    const ly = Math.floor(bot.entity.position.y);
    const lz = Math.floor(bot.entity.position.z);
    bot.chat(`/spawnpoint ${roleConfig.username} ${lx} ${ly} ${lz}`);
    console.log(`[Bot] Spawnpoint locked at ${lx},${ly},${lz}`);
    spawnSafetyRunning = false;
    resolveSpawnSafetyDone();
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  // In-game chat — ignore self. Other bots are heard ONLY when they address this
  // bot by name, and at most once per sender per cooldown window. This enables
  // team coordination ("Mason! Craft a chest!") without runaway feedback loops.
  const BOT_USERNAMES = new Set(["Atlas", "Flora", "Forge", "Mason", "Blade"]);
  const BOT_CHAT_COOLDOWN_MS = 45_000;
  const lastBotChatHeard = new Map<string, number>();
  bot.on("chat", async (username, message) => {
    if (!username || username === bot.username) return;
    if (BOT_USERNAMES.has(username)) {
      const mentionsMe = message.toLowerCase().includes(roleConfig.name.toLowerCase());
      const last = lastBotChatHeard.get(username) ?? 0;
      if (!mentionsMe || Date.now() - last < BOT_CHAT_COOLDOWN_MS) return;
      lastBotChatHeard.set(username, Date.now());
      brain.queueChat({ source: "minecraft", username, message, timestamp: Date.now() });
      return;
    }
    // Ignore server system messages (gamerule results, TP confirmations, etc.)
    if (message.startsWith("Gamerule ") || message.startsWith("Set spawn") || message.startsWith("Teleported ")) return;
    console.log(`[MC Chat] ${username}: ${message}`);

    // Eval commands
    if (message.startsWith("/eval ") || message === "/eval") {
      const parts = message.trim().split(/\s+/);
      const { evalSkill, evalAll } = await import("../eval/runner.js");
      if (parts[1] === "all") {
        evalAll(bot, parts[2]).catch((e: any) => bot.chat(`[EVAL] Error: ${e.message}`));
      } else if (parts[1]) {
        evalSkill(bot, parts[1]).catch((e: any) => bot.chat(`[EVAL] Error: ${e.message}`));
      } else {
        bot.chat("[EVAL] Usage: /eval <skillname>  or  /eval all [filter]");
      }
      return;
    }

    // !goal commands
    if (message.startsWith("!goal")) {
      const parts = message.trim().split(/\s+/);
      const sub = parts[1]?.toLowerCase();
      if (sub === "set" && parts.length > 2) {
        const newGoal = parts.slice(2).join(" ");
        memStore.setSeasonGoal(newGoal);
        bot.chat(`Mission accepted: "${newGoal}"`);
      } else if (sub === "clear") {
        memStore.clearSeasonGoal();
        bot.chat("Season goal cleared. Going freeform.");
      } else if (sub === "show" || !sub) {
        const current = memStore.getSeasonGoal();
        bot.chat(current ? `Current mission: "${current}"` : "No season goal set. Use !goal set <text>");
      } else {
        bot.chat("Usage: !goal set <text> | !goal clear | !goal show");
      }
      return;
    }

    // Queue for the brain to process
    brain.queueChat({
      source: "minecraft",
      username,
      message,
      timestamp: Date.now(),
    });
    addChatMessage(username, message, "free");
  });

  // Death
  bot.on("death", () => {
    const pos = bot.entity.position;
    memStore.recordDeath(pos.x, pos.y, pos.z, "unknown");
    console.log("[Bot] I died! Respawning...");
    abortActiveSkill(bot);
  });

  // Kicked
  bot.on("kicked", (reason) => {
    console.log(`[Bot] Kicked: ${JSON.stringify(reason)}`);
    brain.stop();
  });

  // Errors
  bot.on("error", (err) => {
    console.error("[Bot] Error:", err);
  });

  // Re-run spawn safety on every respawn
  // Only the first bot (Atlas) sends gamerule commands to avoid disconnect.spam kicks
  bot.on("spawn", async () => {
    if (roleConfig.username === "Atlas") {
      bot.chat("/gamerule keepInventory true");
      await new Promise((r) => setTimeout(r, 500));
      bot.chat("/gamerule doMobSpawning true");
      await new Promise((r) => setTimeout(r, 500));
    }
    runSpawnSafety().catch((e) => console.warn("[Bot] Spawn safety error:", e));
  });

  // One-time setup on first spawn
  bot.once("spawn", () => {
    console.log("[Bot] Spawned! Starting event-driven brain...");

    // Start browser viewer — use unified viewer if available, fall back to per-bot viewer
    if (isUnifiedViewerStarted()) {
      registerViewerBot(roleConfig.name, bot);
    } else {
      startViewer(bot, roleConfig.viewerPort);
    }

    // Pathfinder config
    bot.pathfinder.thinkTimeout = 10000;

    // Auto-eat config
    bot.autoEat.opts = {
      priority: "foodPoints",
      minHunger: 14,
      minHealth: 6,
      bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato"],
      returnToLastItem: true,
      offhand: false,
      eatingTimeout: 3000,
      strictErrors: false,
    };

    // Start the brain after spawn safety completes
    spawnSafetyDone
      .then(() => {
        brain.start();
      })
      .catch((e) => {
        console.error("[Bot] Brain start failed:", e);
      });
  });

  return {
    bot,
    queueChat: (msg: ChatMessage) => brain.queueChat(msg),
    stop: () => {
      brain.stop();
      bot.quit();
    },
  };
}
