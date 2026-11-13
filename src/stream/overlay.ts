import express from "express";
import { createServer } from "http";
import { Server as SocketIO } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { AUDIO_RETENTION_MIN_AGE_MS } from "./audio-files.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_QUEUE_MAX_WAIT_MS = AUDIO_RETENTION_MIN_AGE_MS - 60_000;

export interface OverlayState {
  health: number;
  food: number;
  position: { x: number; y: number; z: number };
  time: string;
  thought: string;
  action: string;
  actionResult: string;
  inventory: string[];
  chatMessages: { username: string; message: string; tier: string }[];
  skillProgress?: { skillName: string; phase: string; progress: number; message: string; active: boolean };
  seasonGoal?: string;
}

export interface OverlayInstance {
  updateOverlay(partial: Partial<OverlayState>): void;
  speakThought(audioUrl: string): void;
  addChatMessage(username: string, message: string, tier: string): void;
}

const defaultState = (): OverlayState => ({
  health: 20,
  food: 20,
  position: { x: 0, y: 0, z: 0 },
  time: "daytime",
  thought: "Waking up...",
  action: "idle",
  actionResult: "",
  inventory: [],
  chatMessages: [],
});

/** Per-bot overlay instances keyed by bot name. */
const instances = new Map<string, OverlayInstance>();

/** Start an overlay server for a single bot. Returns per-bot functions. */
export function startOverlay(port = 3001, botName = "Atlas"): OverlayInstance {
  let io: SocketIO | null = null;
  let state: OverlayState = defaultState();

  const app = express();
  const http = createServer(app);
  io = new SocketIO(http, {
    cors: { origin: "*" },
  });

  app.use(express.static(path.join(__dirname, "../../overlay")));

  io.on("connection", (socket) => {
    socket.emit("state", state);
  });

  http.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.log(`[Overlay] Port ${port} in use, skipping overlay server`);
      io = null;
      return;
    }
    console.error("[Overlay] Server error:", err);
  });

  http.listen(port, process.env.SWARM_BIND_HOST || undefined, () => {
    console.log(`[Overlay] Stream overlay running at http://localhost:${port}`);
  });

  const instance: OverlayInstance = {
    updateOverlay(partial: Partial<OverlayState>) {
      state = { ...state, ...partial };
      if (io) io.emit("state", state);
    },
    speakThought(audioUrl: string) {
      if (io) io.emit("speak", { url: audioUrl, expiresAt: Date.now() + AUDIO_QUEUE_MAX_WAIT_MS });
    },
    addChatMessage(username: string, message: string, tier: string) {
      state.chatMessages.push({ username, message, tier });
      if (state.chatMessages.length > 8) state.chatMessages.shift();
      if (io) io.emit("state", state);
    },
  };

  instances.set(botName, instance);
  return instance;
}

/** Get a bot's overlay instance by name. */
export function getOverlay(botName: string): OverlayInstance | undefined {
  return instances.get(botName);
}

// --- Backwards-compatible module-level functions ---
// bot/index.ts calls these with no bot-name context.
// We keep a "current" pointer that gets set per-bot before the decision loop runs.

let currentBotName = "Atlas";

export function setCurrentBot(name: string) {
  currentBotName = name;
}

export function updateOverlay(partial: Partial<OverlayState>) {
  const inst = instances.get(currentBotName);
  if (inst) inst.updateOverlay(partial);
}

export function speakThought(audioUrl: string) {
  const inst = instances.get(currentBotName);
  if (inst) inst.speakThought(audioUrl);
}

export function addChatMessage(username: string, message: string, tier: string) {
  const inst = instances.get(currentBotName);
  if (inst) inst.addChatMessage(username, message, tier);
}
