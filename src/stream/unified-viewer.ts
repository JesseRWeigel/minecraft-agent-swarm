// src/stream/unified-viewer.ts
// Unified viewer server — serves prismarine-viewer static assets once on a single
// port (3000), with a relay-based default namespace. The webpack bundle's
// auto-created socket connects to "/", and the server streams chunk data from
// whichever bot the client has selected. On bot switch, the scene is reset
// (via a fresh "version" event) and new chunks stream in — without reloading
// the page, JS bundle, textures, or Three.js renderer.
//
// To let the client switch bots without reloading, we serve a patched version
// of the prismarine-viewer bundle that exposes the internal `viewer` and `socket`
// objects on `window`, allowing our viewer-client.html to send `switchBot` events
// on the bundle's own socket and call `viewer.resetAll()` for clean scene resets.

import type { Bot } from "mineflayer";
import net from "net";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { EventEmitter } from "events";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const UNIFIED_PORT = 3000;

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port);
  });
}

// Singleton state
let httpServer: any = null;
let io: any = null;
let started = false;
let startFailed = false;

/** Registered bot data: name -> { bot, primitives } */
interface BotEntry {
  bot: Bot;
  primitives: Record<string, any>;
}
const registeredBots = new Map<string, BotEntry>();

/** Per-client state: socket.id -> { cleanup, botName } */
const clientState = new Map<string, { cleanup: () => void; botName: string }>();

/** Names of all registered bots, in registration order. */
export function getRegisteredBotNames(): string[] {
  return Array.from(registeredBots.keys());
}

/**
 * Patch the prismarine-viewer webpack bundle to expose `viewer` and `socket`
 * on `window`, and suppress the bundle's built-in position/version handlers
 * so our viewer-client.html has full control over bot switching.
 */
function patchBundle(bundlePath: string): string {
  let code = fs.readFileSync(bundlePath, "utf-8");

  // The minified bundle ends with something like:
  //   ...const u=new r(l);let h=new THREE.OrbitControls(u.camera,l.domElement);...
  //   o.on("version",(t=>{...}))})();
  //
  // We want to:
  // 1. Expose the socket (`o`) as window.__pvSocket
  // 2. Expose the viewer (`u`) as window.__pvViewer
  // 3. Remove the bundle's "version" handler so we control initialization ourselves
  //
  // Strategy: find the final self-executing block and inject exports + remove version handler.

  // Patch 1: Find the socket creation and expose it.
  // Pattern: `=i(8007)({path:window.location.pathname+"socket.io"})` (or similar module ID)
  // The socket variable is always assigned right before `let s=!0`
  // We find `let s=!0` and inject exports just before the animation frame.

  // More robust approach: find the "version" listener at the end and replace it.
  // The bundle ends with: `o.on("version",(t=>{if(!u.setVersion(t))return!1;...}))})();`
  // We replace the version handler with our export code.

  // Find the version handler: `o.on("version",(t=>{if(!u.setVersion(t))return!1;`
  // This is unique in the bundle since it's the entry point's version handler.
  const versionHandlerRegex = /(\w+)\.on\("version",\((\w+)=>\{if\(!(\w+)\.setVersion\(\2\)\)return!1;/;
  const match = code.match(versionHandlerRegex);

  if (match) {
    const socketVar = match[1]; // 'o' in the current bundle
    const versionVar = match[2]; // 't'
    const viewerVar = match[3]; // 'u'

    // Find the full version handler from the match to the end of the IIFE
    // Pattern: `o.on("version",(t=>{...}))})();`
    // We need to find the matching closing of the `.on("version", ...)` call.
    const matchStart = match.index!;

    // Instead of complex brace matching, replace the WHOLE on("version",...) call
    // with code that exports globals and sets up a minimal handler.
    // Find everything from the match to `})();` at the very end.
    const endPattern = "}))})();";
    const endIdx = code.lastIndexOf(endPattern);

    if (endIdx > matchStart) {
      const replacement =
        `window.__pvSocket=${socketVar};` + `window.__pvViewer=${viewerVar};` + `window.__pvViewerReady=true` + `})();`;

      code = code.substring(0, matchStart) + replacement;
    }
  } else {
    console.warn(
      "[UnifiedViewer] Could not patch bundle — version handler pattern not found. Falling back to unpatched bundle.",
    );
  }

  return code;
}

// Cache the patched bundle
let patchedBundle: string | null = null;

/**
 * Start the unified viewer HTTP server (called once, before any bots spawn).
 * Safe to call multiple times — only the first call does anything.
 */
export async function startUnifiedViewer(): Promise<boolean> {
  if (started || startFailed) return started;

  const available = await isPortAvailable(UNIFIED_PORT);
  if (!available) {
    console.log(`[UnifiedViewer] Port ${UNIFIED_PORT} already in use — viewer disabled.`);
    startFailed = true;
    return false;
  }

  try {
    const express = (await import("express")).default;
    const http = await import("http");
    const { Server: SocketServer } = await import("socket.io");

    const app = express();
    httpServer = http.createServer(app);
    io = new SocketServer(httpServer, {
      path: "/socket.io",
      cors: { origin: "*" },
    });

    // Serve our custom viewer HTML on "/"
    app.get("/", (_req: any, res: any) => {
      const htmlPath = path.join(__dirname, "viewer-client.html");
      res.sendFile(htmlPath);
    });

    // API: list registered bots (so viewer client knows what's available)
    app.get("/api/viewer-bots", (_req: any, res: any) => {
      res.json(Array.from(registeredBots.keys()));
    });

    // Serve the PATCHED prismarine-viewer bundle
    const pvDir = path.dirname(require.resolve("prismarine-viewer/package.json"));
    const bundlePath = path.join(pvDir, "public", "index.js");

    app.get("/index.js", (_req: any, res: any) => {
      if (!patchedBundle) {
        patchedBundle = patchBundle(bundlePath);
      }
      res.type("application/javascript");
      res.send(patchedBundle);
    });

    // Serve other prismarine-viewer static assets (textures, worker.js, etc.)
    app.use(express.static(path.join(pvDir, "public")));

    // ------------------------------------------------------------------
    // Default namespace "/" — relay proxy
    // ------------------------------------------------------------------
    setupRelayNamespace();

    httpServer.listen(UNIFIED_PORT, () => {
      console.log(`[UnifiedViewer] Viewer at http://localhost:${UNIFIED_PORT}`);
    });

    started = true;
    return true;
  } catch (err: any) {
    console.error("[UnifiedViewer] Failed to start:", err.message || err);
    startFailed = true;
    return false;
  }
}

function setupRelayNamespace(): void {
  const { WorldView } = require("prismarine-viewer/viewer");
  const viewDistance = 6;

  io.on("connection", (socket: any) => {
    // Handle bot switch requests from the client
    socket.on("switchBot", (botName: string) => {
      switchClientToBot(socket, botName, WorldView, viewDistance);
    });

    socket.on("disconnect", () => {
      cleanupClient(socket);
    });
  });
}

function switchClientToBot(socket: any, botName: string, WorldView: any, viewDistance: number): void {
  const entry = registeredBots.get(botName);
  if (!entry) {
    socket.emit("switchError", `Bot "${botName}" not registered`);
    return;
  }

  // Clean up previous bot's WorldView for this client
  cleanupClient(socket);

  const { bot, primitives } = entry;

  // Join room for this bot (used for primitive broadcasts)
  socket.join(`bot:${botName}`);

  // Send version — client's switchBot handler uses this to call viewer.setVersion()
  socket.emit("version", (bot as any).version);

  // Create a WorldView that streams chunk data to this client's socket
  const worldView = new WorldView(bot.world, viewDistance, bot.entity.position, socket);
  worldView.init(bot.entity.position);

  // Send existing primitives
  for (const id in primitives) {
    socket.emit("primitive", primitives[id]);
  }

  worldView.on("blockClicked", (block: any, face: any, button: any) => {
    (bot as any).viewer?.emit("blockClicked", block, face, button);
  });

  // Position updates. The viewed bot isn't in its own entity list, so we
  // also emit a synthetic player entity for it — prismarine-viewer renders
  // it with the real Steve model instead of the old light-blue fallback box.
  const SELF_ENTITY_ID = `self:${botName}`;
  function botPosition() {
    socket.emit("position", {
      pos: bot.entity.position,
      yaw: bot.entity.yaw,
      addMesh: false, // suppress the client's blue-box fallback
    });
    socket.emit("entity", {
      id: SELF_ENTITY_ID,
      name: "player",
      pos: bot.entity.position,
      width: 0.6,
      height: 1.8,
      yaw: bot.entity.yaw,
      pitch: bot.entity.pitch,
      username: botName,
    });
    worldView.updatePosition(bot.entity.position);
  }
  botPosition(); // render immediately, not only on first move

  bot.on("move", botPosition);
  worldView.listenToBot(bot);

  // Store cleanup function for this client
  clientState.set(socket.id, {
    cleanup: () => {
      bot.removeListener("move", botPosition);
      worldView.removeListenersFromBot(bot);
      socket.emit("entity", { id: SELF_ENTITY_ID, delete: true });
      socket.leave(`bot:${botName}`);
    },
    botName,
  });

  socket.emit("switchDone", botName);
}

function cleanupClient(socket: any): void {
  const state = clientState.get(socket.id);
  if (state) {
    state.cleanup();
    clientState.delete(socket.id);
  }
}

/**
 * Register a bot with the unified viewer. Must be called after startUnifiedViewer()
 * and after the bot has spawned.
 */
export function registerBot(botName: string, bot: Bot): void {
  if (!io) {
    console.warn(`[UnifiedViewer] Server not started — cannot register ${botName}`);
    return;
  }

  if (registeredBots.has(botName)) {
    // Bot is re-registering after a restart — clean up old clients and replace
    for (const [socketId, state] of clientState.entries()) {
      if (state.botName === botName) {
        state.cleanup();
        clientState.delete(socketId);
      }
    }
    registeredBots.delete(botName);
    console.log(`[UnifiedViewer] Re-registering bot "${botName}" (restart detected)`);
  }

  const primitives: Record<string, any> = {};

  // Set up bot.viewer event emitter (matches prismarine-viewer's API)
  (bot as any).viewer = new EventEmitter();

  (bot as any).viewer.erase = (id: string) => {
    delete primitives[id];
    if (io) io.to(`bot:${botName}`).emit("primitive", { id });
  };
  (bot as any).viewer.drawBoxGrid = (id: string, start: any, end: any, color = "aqua") => {
    primitives[id] = { type: "boxgrid", id, start, end, color };
    if (io) io.to(`bot:${botName}`).emit("primitive", primitives[id]);
  };
  (bot as any).viewer.drawLine = (id: string, points: any, color = 0xff0000) => {
    primitives[id] = { type: "line", id, points, color };
    if (io) io.to(`bot:${botName}`).emit("primitive", primitives[id]);
  };

  (bot as any).viewer.close = () => {
    for (const [socketId, state] of clientState.entries()) {
      if (state.botName === botName) {
        state.cleanup();
        clientState.delete(socketId);
      }
    }
    registeredBots.delete(botName);
  };

  registeredBots.set(botName, { bot, primitives });
  console.log(`[UnifiedViewer] Registered bot "${botName}"`);
}

/**
 * Whether the unified viewer has started successfully.
 */
export function isUnifiedViewerStarted(): boolean {
  return started;
}
