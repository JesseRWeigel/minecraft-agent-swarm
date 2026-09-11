import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder, goals } = pathfinderPkg;
import customPvpPkg from "@nxg-org/mineflayer-custom-pvp";
const customPvp = (customPvpPkg as any).default ?? customPvpPkg;
import { loader as autoEat } from "mineflayer-auto-eat";
import { config } from "../config.js";
import { registerBot as registerViewerBot, isUnifiedViewerStarted } from "../stream/unified-viewer.js";
import { startViewer } from "../stream/viewer.js";
import { addChatMessage, setCurrentBot } from "../stream/overlay.js";
import { abortActiveSkill, getActiveSkillName } from "../skills/executor.js";
import { registerBotMemory } from "./memory-registry.js";
import { skillRegistry } from "../skills/registry.js";
import { BotMemoryStore } from "./memory.js";
import { BotRoleConfig, ATLAS_CONFIG } from "./role.js";
import { spawn } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { isNeuralServerRunning } from "../neural/bridge.js";
import { appendSnapshot } from "./advancement-log.js";
import { BOT_ROSTER } from "./role.js";
import { BotBrain, type ChatMessage, type BrainEvents } from "./brain.js";
import { parseChatCommand } from "./chat-commands.js";
import { executeChatCommand } from "./chat-command-handler.js";
import { bumpNavGeneration, safeGoto, safeMoves } from "./navigation.js";
import { recordDeath, startScoreboard } from "./scoreboard.js";
import { createFallTracker, isFallDeath } from "./fall-tracker.js";
import { shouldFleeOnRespawn } from "./respawn-safety.js";
import { isHostile } from "./perception.js";
import { executeAction } from "./actions.js";

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

// createBot runs once per bot, and again on every reconnect (up to
// MAX_RESTARTS times each) — none of that is "swarm start". Gate on a
// module-level flag so the snapshot fires exactly once per process, on
// whichever bot happens to spin up first, rather than once per bot or once
// per restart.
let advancementSnapshotLogged = false;

export async function createBot(events: BrainEvents, roleConfig: BotRoleConfig = ATLAS_CONFIG) {
  startScoreboard();
  ensureNeuralServer().catch((e) => console.warn("[Bot] Neural spawn error:", e));

  // One row per swarm start. Cheap, and it is the only record of whether any
  // of this works. Must never take the swarm down with it — a missing server
  // directory (fresh checkout, server not yet provisioned) reads as zero
  // progress, not a crash.
  if (!advancementSnapshotLogged) {
    advancementSnapshotLogged = true;
    // One row per start AND one per hour. The "hourly" history in the CSV was
    // an artifact of hourly maintenance restarts; once runs started surviving
    // multiple hours, the chart silently starved.
    const snap = () => {
      try {
        appendSnapshot(
          BOT_ROSTER.map((b) => b.name),
          new Date(),
        );
      } catch (e) {
        console.warn("[Bot] Advancement snapshot failed:", e);
      }
    };
    snap();
    setInterval(snap, 60 * 60 * 1000).unref();
  }

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

  // Base height, for the furniture placement guard. Bots were placing chests and
  // crafting tables at y=119-123 -- 50 blocks above the stash -- and then falling
  // off them. See place-guard.ts.
  if (roleConfig.stashPos) {
    (bot as unknown as { swarmBaseY?: number }).swarmBaseY = roleConfig.stashPos.y;
  }

  // Load plugins
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(customPvp);
  bot.loadPlugin(autoEat);
  // BOUND the A* search. The default searchRadius is unlimited, and a goal
  // with a huge or unreachable frontier allocates nodes until V8 dies — the
  // three "heap out of memory" crashes all fired seconds after a bot in open
  // water pathed for the shore, with heapUsed at 173MB on the last reading
  // and 8GB moments later. The longest legitimate walk in the swarm is the
  // ~210-block breeding scout; 256 covers everything real and caps the bomb.
  // (searchRadius is real in the runtime — index.js line 41, default -1 —
  // but absent from the plugin's type declarations, hence the cast.)
  // 1500ms of A* think, down from the plugin's 5000ms default. The radius
  // cap alone did NOT stop the heap bombs: a water-movement search packs
  // millions of nodes into a 5-second think, and goto-retry churn across
  // five bots stacks those contexts faster than GC reclaims them (216MB to
  // 8GB between two heap readings, crash #4). Shorter thinks mean partial
  // paths recomputed as the bot walks — same destinations, bounded cost.
  //
  // FAIL-CLOSED: apply the caps the moment the plugin exists rather than
  // inside a spawn hook alone — a missed event must not leave the pathfinder
  // running with unlimited search. Immediate attempt, inject_allowed
  // fallback, and a spawn-time reapply as the belt over the braces.
  const capPathfinder = (): boolean => {
    const pf = bot.pathfinder as unknown as { searchRadius: number; thinkTimeout: number } | undefined;
    if (!pf) return false;
    pf.searchRadius = 256;
    pf.thinkTimeout = 1500;
    return true;
  };
  if (!capPathfinder()) {
    bot.once("inject_allowed", () => {
      capPathfinder();
    });
  }
  // Network handshake diagnostics (run 539: the server held Flora's
  // position, rotation and hotbar slot frozen for hours while her client
  // walked and crafted; the server discards movement until the client
  // confirms its last teleport, so count both directions).
  {
    const net = { posSent: 0, confirmSent: 0, tpRecv: 0, last: "" };
    const client = bot._client as unknown as {
      write: (name: string, params: unknown) => void;
      on: (ev: string, fn: (p: any) => void) => void;
    };
    const origWrite = client.write.bind(client);
    client.write = (name: string, params: unknown) => {
      if (name === "position" || name === "position_look" || name === "look") net.posSent++;
      else if (name === "teleport_confirm") net.confirmSent++;
      return origWrite(name, params);
    };
    client.on("position", (p: any) => {
      net.tpRecv++;
      net.last = `${Number(p?.x).toFixed(1)},${Number(p?.y).toFixed(1)},${Number(p?.z).toFixed(1)} id=${p?.teleportId}`;
      if (net.tpRecv <= 3 || net.tpRecv % 25 === 0) {
        console.log(`[NetDebug] ${roleConfig.name} server teleport #${net.tpRecv}: ${net.last}`);
      }
    });
    const timer = setInterval(() => {
      const e = bot.entity?.position;
      console.log(
        `[NetDebug] ${roleConfig.name}: sent pos=${net.posSent} confirm=${net.confirmSent} recv teleports=${net.tpRecv} (last ${net.last || "none"}) client at ${e ? e.floored() : "?"}`,
      );
      net.posSent = 0;
      net.confirmSent = 0;
    }, 120_000);
    bot.once("end", () => clearInterval(timer));
  }

  bot.once("spawn", () => {
    capPathfinder();
  });

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
    // HONEST-SPAWN ERA (Jesse's ruling, 2026-09-07): the /spawnpoint, /tp,
    // and /spreadplayers plumbing that used to live here is gone. Bots
    // respawn wherever the server says and WALK; respawn points are earned
    // the vanilla way — the brain's bed-claim reflex uses a bed, which sets
    // the respawn point even in daylight. keepInventory stays on as the
    // run's one documented concession, to be reconsidered later.
    const p = bot.entity.position;
    console.log(
      `[Bot] ${roleConfig.name} spawned at ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)} — no spawn commands (honest-spawn era)`,
    );
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
      if (!config.bot.commandWhitelist.includes(username)) {
        console.warn(`[EVAL] Ignored untrusted eval request from ${username}`);
        return;
      }
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

    const parsedCommand = parseChatCommand(username, message, config.bot.commandWhitelist);
    if (parsedCommand.kind === "denied") return;
    if (parsedCommand.kind === "invalid") {
      bot.chat(parsedCommand.message);
      return;
    }
    if (parsedCommand.kind === "command") {
      await executeChatCommand(parsedCommand.command, username, {
        bot,
        brain,
        memory: memStore,
        abortActiveSkill: () => abortActiveSkill(bot),
        stopMovement: () => {
          bumpNavGeneration(bot);
          bot.pathfinder.setGoal(null); // synchronous reset; stop() only raises a flag that kills the NEXT walk
          bot.clearControlStates();
        },
        goToPlayer: async (playerName) => {
          const player = bot.players[playerName]?.entity;
          if (!player) throw new Error("player is not visible");
          const { x, y, z } = player.position;
          bot.pathfinder.setMovements(safeMoves(bot));
          await safeGoto(bot, new goals.GoalNear(x, y, z, 2), 15_000);
        },
      });
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

  // Death cause capture — the server's death message ("X drowned", "X
  // suffocated in a wall", "X fell from a high place"…) arrives as chat just
  // before/with the death event. Recording the real cause (was hardcoded
  // "unknown") lets us diagnose recurring death-traps and feeds the bots'
  // death-location avoidance.
  let lastDeathMessage = "";
  // Respawn-camp breaker state: a mob parked on the spawnpoint has now
  // massacred two bots on two days (Forge, 9 pillager deaths; Mason, 40
  // zombie deaths at ~12s a life). The bot respawns INTO the kill zone and
  // dies before the brain takes a single decision.
  const recentDeathTimes: number[] = [];
  const DEATH_RE =
    /\b(drowned|suffocat|fell|hit the ground|tried to swim in lava|burned|went up in flames|walked into fire|was slain|was shot|was blown up|blew up|was killed|starv|was pricked|was squashed|was impaled|was struck|froze|magma|withered|didn'?t want to live)/i;
  bot.on("messagestr", (msg: string) => {
    if (msg.includes(roleConfig.username) && DEATH_RE.test(msg)) lastDeathMessage = msg.trim();
  });

  // Death
  //
  // RESPAWN-LOOP BREAKER. Spawn safety runs once at connect and sets
  // /spawnpoint wherever the bot lands. Nothing re-validates it afterwards, so a
  // bot that dies while on a ledge or self-built pillar gets that spot as its
  // PERMANENT respawn point — and then respawns into the same fatal drop
  // forever. Mason did exactly this: 55 falls in one hour, 58 of the swarm's 95
  // deaths, every one "fell from a high place. Respawning...".
  //
  // The loop is self-reinforcing and cannot break on its own, so detect it by
  // repetition and clear the spawnpoint back to a safe landing.
  let recentDeaths: number[] = [];
  let respawnFixing = false;
  // Sized against a measured loop, not a guess. Atlas died 460 times in three
  // days at a median of 235s between deaths — so a 4-in-180s window could never
  // close, and the breaker sat silent through the worst death loop the project
  // has had. 12 of 49 gaps were under 60s, so the old window caught only the
  // bursts and missed the steady bleed entirely.
  //
  // 4 deaths in 15 minutes is still far outside healthy (the whole swarm runs
  // 2-6/hr), and it catches a 235s cadence with room to spare.
  const LOOP_WINDOW_MS = 900_000;
  const LOOP_THRESHOLD = 4;

  // Highest ground the bot last stood on, and when. Falls are the top killer
  // (13 of 33 deaths this session, 9 of them Atlas) and every movement config
  // already caps maxDropDown at 3, so the pathfinder is not routing them off
  // ledges — two of the sampled falls happened right after `idle` and `eat`,
  // with no navigation running at all. Two hypotheses died against the source
  // before this: allowFreeMotion only engages for entity goals (pathfinder
  // index.js:421) so it never applies to explore's coordinate goals, and the
  // teleport fallback is gated off by default. Record the actual drop instead
  // of guessing a third time.
  //
  // The first version of this logged nothing across two real fall deaths: it
  // recorded ground height on every grounded tick, but a falling bot LANDS
  // before it dies, and that landing overwrote the height with the bottom of the
  // fall. See fall-tracker.ts — the origin is captured on the ground->airborne
  // transition so it survives the landing tick.
  const fallTracker = createFallTracker(bot.entity?.position.y ?? 0);

  // How does a bot get 48 blocks above its own base?
  //
  // 13 of 26 falls this session came from one small volume at x=284-286,
  // y=118-120, z=-320 to -322. That is the stash's x, 48 blocks up: the
  // cobblestone tower the pathfinder built while escaping being stuck. Every
  // sample reads controls=none pathing=false, so the bot is stationary at the
  // top when it comes off.
  //
  // Four hypotheses have died here — allowFreeMotion (entity goals only), the
  // teleport unstick (gated off), neural combat (never runs), and the
  // underground rescue (0 fires this session). The missing fact is not why he
  // falls, it is how he ASCENDS, and nothing records that. Log the crossing.
  const ASCENT_TRIGGER_ABOVE_BASE = 30;
  let wasHigh = false;
  bot.on("move", () => {
    if (!bot.entity) return;
    const baseY = roleConfig.stashPos?.y;
    if (baseY !== undefined) {
      const p = bot.entity.position;
      const high = p.y > baseY + ASCENT_TRIGGER_ABOVE_BASE;
      if (high && !wasHigh) {
        console.log(
          `[Ascent] ${roleConfig.name} rose to y=${p.y.toFixed(0)} at ${p.x.toFixed(0)},${p.z.toFixed(0)} ` +
            `(${(p.y - baseY).toFixed(0)} above base) onGround=${bot.entity.onGround}`,
        );
      } else if (!high && wasHigh) {
        console.log(`[Ascent] ${roleConfig.name} back down to y=${p.y.toFixed(0)}`);
      }
      wasHigh = high;
    }
    // Three mechanism hypotheses died against the source before this, each
    // plausible and each never actually firing: allowFreeMotion (only read for
    // entity goals), the teleport unstick (gated off), and neural combat's raw
    // sprint+strafe (0 runs all session). Atlas is 7-for-7 on fall deaths, three
    // from y=116. Stop guessing what moves him and record it: whatever holds the
    // controls at the instant he leaves the ground is the answer.
    const held = Object.entries(bot.controlState)
      .filter(([, on]) => on)
      .map(([k]) => k)
      .join("+");
    // What the bot was standing on, and where.
    //
    // Atlas has died 460 times in three days, every ~4 minutes, clustered 2-10
    // blocks from the stash between y=71 and y=95, alternating "fell from a high
    // place" and "fell off a ladder". Every sample says controls=none
    // pathing=false, so he is not climbing when he comes off — but nothing
    // records WHAT he leaves or WHERE, so the mechanism is still guesswork after
    // three dead hypotheses. Position plus footing is the missing fact.
    const p = bot.entity.position;
    const at = bot.blockAt(p)?.name ?? "?";
    const below = bot.blockAt(p.offset(0, -1, 0))?.name ?? "?";
    const ctx =
      `controls=${held || "none"} pathing=${bot.pathfinder?.isMoving?.() ?? "?"} ` +
      `vel=${bot.entity.velocity.y.toFixed(2)} at=${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)} ` +
      `in=${at} on=${below}`;
    // Report whether the block below is genuinely solid, separately from what
    // bot.entity.onGround claims. Three fall records showed vel=-0.08 (one tick
    // of gravity) at the last tick the flag said true, so the flag lags and the
    // world is the more reliable witness.
    const belowBlock = bot.blockAt(p.offset(0, -1, 0));
    const onSolid = belowBlock?.boundingBox === "block";
    fallTracker.update(bot.entity.position.y, bot.entity.onGround, Date.now(), ctx, onSolid);
  });

  // Run before resuming, if something lethal is standing where you woke up.
  //
  // The first action after a death was explore 23 times, go_to 13, mine_block 5
  // and flee ZERO times across one 9h session. Bots respawn at the base and walk
  // straight back into whatever killed them. Flora died three times in 76
  // seconds that way at y=69, two blocks from the stash, and her role has flee
  // but no attack, so running is her only defence and nothing ever chose it.
  //
  // Fleeing works when picked (119 successful flees in the same session). The
  // gap was that nothing looked for danger at the instant a bot is most exposed:
  // freshly respawned, unarmoured, unarmed.
  //
  // Hooked to "spawn", not "respawn". mineflayer emits `respawn` when the server
  // sends the respawn PACKET, at which point isAlive is false and the entity is
  // not yet placed; `spawn` fires once health is restored and the bot is really
  // in the world (see mineflayer/lib/plugins/health.js). The first version
  // listened on `respawn` and fired zero times across 29 deaths.
  //
  // Both branches log. The first version only logged when it decided to flee,
  // so a zero count could not distinguish "never ran" from "ran and found
  // nothing", which is the same observability gap that cost days on the fall
  // and deposit investigations.
  bot.on("spawn", () => {
    setTimeout(() => {
      try {
        if (!bot.entity) return;
        const hostile = bot.nearestEntity((e) => e !== bot.entity && isHostile(e));
        const dist = hostile ? hostile.position.distanceTo(bot.entity.position) : null;
        if (shouldFleeOnRespawn(dist)) {
          console.log(
            `[Respawn] ${roleConfig.name} woke up ${dist!.toFixed(1)} blocks from ${hostile!.name ?? "a hostile"} — fleeing before resuming`,
          );
          executeAction(bot, "flee", {}).catch(() => {});
        } else {
          console.log(
            `[Respawn] ${roleConfig.name} spawn check: nearest hostile ${dist === null ? "none" : dist.toFixed(1) + " blocks"} — resuming`,
          );
        }
      } catch (err) {
        // Never let the safety check itself break a spawn, but do not swallow
        // it silently either: a thrown check is indistinguishable from a quiet
        // one in the log, and that is how the first version hid.
        console.log(`[Respawn] ${roleConfig.name} spawn check failed: ${(err as Error).message}`);
      }
    }, 1200); // let the spawn settle so position and entities are current
  });

  bot.on("death", () => {
    const pos = bot.entity.position;
    const cause = lastDeathMessage || "unknown";
    memStore.recordDeath(pos.x, pos.y, pos.z, cause);
    recordDeath(roleConfig.name);
    recentDeathTimes.push(Date.now());
    while (recentDeathTimes.length > 12) recentDeathTimes.shift();

    // What was it WEARING when it died?
    //
    // Deaths ran 19-22/hr with "was shot by" dominant, and I could not tell from
    // the log whether bots were armoured: grepping for "armor" only matched the
    // LLM's own chatter about hunting iron, not the equipment state. equipBestArmor
    // logs when it equips something, which says nothing about what is worn at the
    // moment of death — an unarmoured bot that never found armour logs nothing at
    // all. Record the slots directly so the next spike is answerable.
    const worn = [5, 6, 7, 8].map((slot) => bot.inventory.slots[slot]?.name ?? "-").join(",");
    const drop = fallTracker.dropFrom(pos.y);
    // A fall death ALWAYS prints its record, however small the computed drop.
    // Gating on drop > 1 meant Blade's "fell from a high place" produced nothing
    // while a 1.1 block drop on Forge's zombie death produced a full record --
    // the instrument silent on the one case the investigation is waiting for.
    // When the tracker is confused, its own number cannot be the gate.
    const fallInfo =
      drop > 1 || isFallDeath(cause)
        ? ` Fell ${drop.toFixed(1)} blocks from y=${fallTracker.originY().toFixed(0)} ` +
          `(airborne ${(fallTracker.airborneMs(Date.now()) / 1000).toFixed(1)}s, ${fallTracker.originContext()})` +
          // Sampled one tick earlier, while still standing. The departure sample
          // above reads the block below a bot that is already over the gap, so
          // its on= is air for any fall at all and answers nothing.
          ` [stood ${fallTracker.originFooting() || "NEVER ON SOLID GROUND"}` +
          ` ${fallTracker.footingAgeMs(Date.now())}ms before leaving]`
        : "";
    console.log(`[Bot] I died! Cause: ${cause}. Armor: ${worn}.${fallInfo} Respawning...`);
    lastDeathMessage = "";
    abortActiveSkill(bot);

    // RESYNC the inventory after respawn. Deaths (lava especially) can leave
    // mineflayer's client-side inventory stale — twice now a bot's own view
    // went blind to items the server said it held, and every count-reading
    // override silently declined for hours (the 5-diamond endgame, the dive,
    // the pickless re-arm). Opening any container makes the server resend the
    // full window including the player inventory section, which is the one
    // reliable in-protocol refresh. Bots respawn at the village where chests
    // are everywhere; if none is in range the next natural chest visit heals
    // it instead.
    setTimeout(() => {
      void (async () => {
        try {
          const chest = bot.findBlock({ matching: (b) => b.name === "chest", maxDistance: 12 });
          if (!chest) return;
          const win = await bot.openContainer(chest);
          await new Promise((r) => setTimeout(r, 500));
          win.close();
          console.log(`[Bot] ${roleConfig.name} post-death inventory resync via chest at ${chest.position}`);
        } catch {
          /* best effort — a missed resync just waits for the next chest */
        }
      })();
    }, 4000);

    const now = Date.now();
    recentDeaths = recentDeaths.filter((t) => now - t < LOOP_WINDOW_MS);
    recentDeaths.push(now);

    if (recentDeaths.length >= LOOP_THRESHOLD && !respawnFixing) {
      respawnFixing = true;
      console.warn(
        `[Bot] ${roleConfig.name} died ${recentDeaths.length}x in ${LOOP_WINDOW_MS / 1000}s — respawn point looks lethal, resetting it`,
      );
      recentDeaths = [];
      // Re-run the same landing routine used at connect: spreadplayers to a
      // topmost safe block, then set the spawnpoint where it actually lands.
      setTimeout(() => {
        runSpawnSafety()
          .catch((e) => console.warn(`[Bot] respawn reset failed:`, e))
          .finally(() => {
            respawnFixing = false;
          });
      }, 2000);
    }
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

    // Camp breaker: after 3+ deaths inside 5 minutes, the first move on
    // respawn is LEAVING — sprint 25 blocks away from the visible hostile
    // (or just away) before the camper lands its next hit. Runs after spawn
    // safety has placed the bot, since that placement is the kill zone.
    const rapidDeaths = recentDeathTimes.filter((t) => Date.now() - t < 300_000).length;
    if (rapidDeaths >= 3) {
      setTimeout(() => {
        try {
          const HOSTILES = new Set(["zombie", "skeleton", "pillager", "creeper", "spider", "drowned", "husk"]);
          const hostile = bot.nearestEntity((e) => HOSTILES.has(e.name ?? ""));
          const p = bot.entity.position;
          let dx = 25;
          let dz = 0;
          if (hostile && p.distanceTo(hostile.position) < 20) {
            const vx = p.x - hostile.position.x;
            const vz = p.z - hostile.position.z;
            const m = Math.hypot(vx, vz) || 1;
            dx = (vx / m) * 25;
            dz = (vz / m) * 25;
          }
          console.log(
            `[CampBreaker] ${roleConfig.name}: ${rapidDeaths} deaths in 5min — sprinting clear` +
              (hostile ? ` of the ${hostile.name}` : ""),
          );
          bot.pathfinder.setMovements(safeMoves(bot));
          bot.pathfinder.setGoal(new goals.GoalXZ(p.x + dx, p.z + dz));
        } catch (e) {
          console.log(`[CampBreaker] failed: ${(e as Error).message}`);
        }
      }, 2_500);
    }
  });

  // One-time setup on first spawn
  bot.once("spawn", () => {
    console.log("[Bot] Spawned! Starting event-driven brain...");

    // KIT-DELTA LOGGER. Forge assembled a full Nether kit at 00:15 and an hour
    // later held one lump of coal — with keepInventory on, the keep-rule live,
    // and no deposit in sight. Three ground-truth sweeps this week contradicted
    // three inferences about where kit items were; this ends the guessing:
    // every gain/loss of a kit-relevant item logs the moment, the place, and
    // what the bot was doing when it happened.
    // gold_ingot + golden_boots joined the watchlist 2026-09-08: Blade's piglin
    // payroll has now vanished from his pocket three times with three different
    // partial explanations — the next disappearance gets caught on tape.
    const KIT_ITEMS = new Set([
      "bucket",
      "water_bucket",
      "lava_bucket",
      "flint_and_steel",
      "iron_ingot",
      "flint",
      "gold_ingot",
      "golden_boots",
      // Wax On kit (2026-09-11): a crafted copper block, shears and a harvested
      // honeycomb vanished from Forge's pack twice with keepInventory on and
      // no deposit logged; watch them so the next loss names the action.
      "copper_block",
      "honeycomb",
      "shears",
      "campfire",
    ]);
    bot.inventory.on("updateSlot", (slot: number, oldItem: any, newItem: any) => {
      const was = oldItem && KIT_ITEMS.has(oldItem.name) ? `${oldItem.count}x ${oldItem.name}` : null;
      const now = newItem && KIT_ITEMS.has(newItem.name) ? `${newItem.count}x ${newItem.name}` : null;
      if (!was && !now) return;
      if (was === now) return;
      const p = bot.entity?.position?.floored();
      const doing = getActiveSkillName(bot) ?? "no-skill";
      console.log(
        `[Kit] ${roleConfig.name} slot ${slot}: ${was ?? "(empty)"} -> ${now ?? "(empty)"} at ${p?.x},${p?.y},${p?.z} during ${doing}`,
      );
    });

    // Start browser viewer — use unified viewer if available, fall back to per-bot viewer
    if (isUnifiedViewerStarted()) {
      registerViewerBot(roleConfig.name, bot);
    } else {
      startViewer(bot, roleConfig.viewerPort);
    }

    // Pathfinder config
    bot.pathfinder.thinkTimeout = 10000;

    // BOUND THE SEARCH. This is the fourth OOM crash's root cause.
    //
    // mineflayer-pathfinder defaults to searchRadius = -1, documented in the
    // library as "don't limit the search", and nothing here ever set it. A*
    // then expands in every direction with only a timer to stop it, while
    // closedDataSet and openDataMap accumulate for the whole thinkTimeout.
    // gatherWood raises that to 30s, so an unreachable target means 30 seconds
    // of unbounded node growth.
    //
    // That is why raising the heap ceiling from 4GB to 8GB did not help: with no
    // spatial bound the search simply fills whatever memory exists and dies at
    // the new limit. The crash reached 8,185MB of an 8,192MB ceiling.
    //
    // It also explains the profile — heap flat at ~300MB, then instant death.
    // Nothing accumulates until one pathfind targets somewhere unreachable, and
    // that search never converges.
    //
    // 96. The progression here was measured, not guessed:
    //   128  OOMed at 8,184MB within minutes (volume ~8.5M positions)
    //    64  memory solved (heap max 285MB) but starved navigation:
    //        ACTION_SUCCESS_PCT 63 -> 38, "No path to the goal" 15/hr -> 80/hr,
    //        stuck 15/hr -> 166/hr, items 300/hr -> 154/hr
    //    96  ~3.4x the node budget of 64, so roughly 970MB worst case against
    //        an 8GB ceiling, while restoring reach for bots that explore ~119
    //        blocks per hop against a 200-block wood leash.
    //
    // A* only exhausts its bound when the goal is UNREACHABLE,
    // and then it explores the whole permitted volume. Node count scales with
    // the cube of the radius, so 128 blocks is roughly 8.5M candidate positions
    // (~850MB of nodes) per search, times five bots searching at once. That is
    // why searchRadius=128 still OOMed at 8,184MB within minutes.
    //
    // I sized the first bound like a travel distance instead of a memory
    // budget, then over-corrected into one too tight to navigate with. Node
    // count scales with the cube of radius, so the safe window is wide: 96 buys
    // back reach at a fraction of the ceiling.
    // Cast: the bundled @types/mineflayer-pathfinder predates searchRadius, but
    // the runtime reads it (index.js:41 sets the -1 default, :75 consumes it).
    (bot.pathfinder as unknown as { searchRadius: number }).searchRadius = 96;
    console.log(`[Pathfinder] ${roleConfig.name}: searchRadius=96 thinkTimeout=${bot.pathfinder.thinkTimeout}ms`);

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
