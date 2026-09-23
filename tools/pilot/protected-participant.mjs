import { performance } from "node:perf_hooks";

const HOST = "127.0.0.1";
const PORT = 25585;
const USERNAME = "PilotProbe";
const VERSION = "1.21.4";
const ACTION_MS = 1000;
const DEFAULT_PHASE_TIMEOUT_MS = 30_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 90_000;
const ID_PATTERN = /[A-Za-z0-9][A-Za-z0-9._-]{0,63}/;
const MESSAGE_KEYS = new Set(["schema_version", "type", "trial_id", "action_id"]);

// This is a participant protocol library prerequisite. It does not create a
// namespace, protect an observer, run a model, or produce authoritative task
// evidence. A future trusted supervisor must provide bounded pipe adapters.

function validId(value) {
  return typeof value === "string" && ID_PATTERN.exec(value)?.[0] === value;
}

function bounded(factory, timeoutMs, label) {
  let timer;
  const pending = Promise.resolve().then(factory);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

function destroySocket(bot) {
  for (const socket of [bot?.socket, bot?._client?.socket]) {
    try {
      if (socket && !socket.destroyed) socket.destroy();
    } catch {}
  }
}

async function disposeBot(bot, timeoutMs) {
  if (!bot) return true;
  const detach = [];
  try {
    bot.on?.("error", () => {});
    bot.setControlState?.("forward", false);
    // quit() in the pinned protocol is void: await actual network close instead.
    // Plain socket doubles have no event API; production net.Socket instances do.
    const sockets = [...new Set([bot.socket, bot._client?.socket])].filter((socket) => socket?.once && socket?.off);
    const closed = sockets.map(
      (socket) =>
        new Promise((resolve) => {
          const clean = () => !socket.errored && socket.readableEnded === true && socket.writableFinished === true;
          if (socket.closed) {
            resolve(clean());
            return;
          }
          const onClose = (hadError) => resolve(!hadError && clean());
          const onError = () => resolve(false);
          socket.once("close", onClose);
          socket.once("error", onError);
          detach.push(() => {
            socket.off("close", onClose);
            socket.off("error", onError);
          });
        }),
    );
    if (!(timeoutMs > 0)) return false;
    return await bounded(
      async () => {
        await bot.quit?.("participant protocol complete");
        return (await Promise.all(closed)).every(Boolean);
      },
      timeoutMs,
      "bot close",
    );
  } catch {
    return false;
  } finally {
    for (const remove of detach) remove();
    destroySocket(bot);
  }
}

async function boundedAcquire(factory, timeoutMs, dispose) {
  const pending = Promise.resolve().then(factory);
  try {
    return await bounded(() => pending, timeoutMs, "bot create");
  } catch (error) {
    pending
      .then(
        (lateBot) => dispose(lateBot),
        () => {},
      )
      .catch(() => {});
    throw error;
  }
}

async function waitSpawn(bot, runPhase) {
  if (bot.entity) return;
  let onSpawn, onError, onKicked;
  try {
    await runPhase(
      () =>
        new Promise((resolve, reject) => {
          onSpawn = resolve;
          onError = reject;
          onKicked = () => reject(new Error("bot kicked"));
          bot.once("spawn", onSpawn);
          bot.once("error", onError);
          bot.once("kicked", onKicked);
        }),
      "bot spawn",
    );
  } finally {
    bot.off?.("spawn", onSpawn);
    bot.off?.("error", onError);
    bot.off?.("kicked", onKicked);
  }
}

function outgoing(type, trialId, actionId) {
  return Object.freeze({ schema_version: 1, type, trial_id: trialId, action_id: actionId });
}

function validateCommand(value, expectedType, trialId, actionId) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("invalid supervisor message");
  if (Object.keys(value).length !== MESSAGE_KEYS.size || Object.keys(value).some((key) => !MESSAGE_KEYS.has(key)))
    throw new Error("invalid supervisor message");
  if (
    typeof value.schema_version !== "number" ||
    !Number.isInteger(value.schema_version) ||
    value.schema_version !== 1 ||
    value.type !== expectedType ||
    value.trial_id !== trialId ||
    value.action_id !== actionId
  )
    throw new Error("invalid supervisor message");
}

export async function runParticipant({
  createBot,
  sendMessage,
  waitForCommand,
  trialId,
  actionId,
  movement = "forward",
  commandProbe = "none",
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowMonotonic = performance.now.bind(performance),
  phaseTimeoutMs = DEFAULT_PHASE_TIMEOUT_MS,
  totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
} = {}) {
  if (typeof createBot !== "function" || typeof sendMessage !== "function" || typeof waitForCommand !== "function")
    throw new TypeError("participant adapters required");
  if (!validId(trialId) || !validId(actionId)) throw new RangeError("invalid supervisor ID");
  if (movement !== "forward" && movement !== "stationary") throw new RangeError("invalid movement");
  if (!["none", "permissions"].includes(commandProbe) || (commandProbe !== "none" && movement !== "stationary"))
    throw new RangeError("invalid command probe");
  if (typeof sleep !== "function" || typeof nowMonotonic !== "function")
    throw new TypeError("participant clocks required");
  if (!Number.isInteger(phaseTimeoutMs) || phaseTimeoutMs < 1 || phaseTimeoutMs > DEFAULT_PHASE_TIMEOUT_MS)
    throw new RangeError("invalid phaseTimeoutMs");
  if (!Number.isInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > DEFAULT_TOTAL_TIMEOUT_MS)
    throw new RangeError("invalid totalTimeoutMs");

  let lastNow;
  const now = () => {
    const value = nowMonotonic();
    if (typeof value !== "number" || !Number.isFinite(value) || (lastNow !== undefined && value < lastNow))
      throw new Error("invalid monotonic clock");
    lastNow = value;
    return value;
  };
  let started;
  try {
    started = now();
  } catch {
    return { schema_version: 1, status: "failed" };
  }
  const deadline = started + totalTimeoutMs;
  const remaining = () => Math.max(0, deadline - now());
  let bot;
  let transportFailed = false;
  let protocolCompleted = false;
  const runPhase = async (factory, label) => {
    const phaseStarted = now();
    const phaseDeadline = Math.min(deadline, phaseStarted + phaseTimeoutMs);
    const allowance = phaseDeadline - phaseStarted;
    if (allowance <= 0) throw new Error("participant total timeout");
    const value = await bounded(factory, allowance, label);
    if (now() >= phaseDeadline) throw new Error("participant phase timeout");
    if (transportFailed) throw new Error("participant transport failed");
    return value;
  };

  let result = { schema_version: 1, status: "failed" };
  try {
    const acquisitionStarted = now();
    const acquisitionDeadline = Math.min(deadline, acquisitionStarted + phaseTimeoutMs);
    const acquisitionAllowance = acquisitionDeadline - acquisitionStarted;
    if (acquisitionAllowance <= 0) throw new Error("participant total timeout");
    bot = await boundedAcquire(
      () =>
        createBot({
          host: HOST,
          port: PORT,
          username: USERNAME,
          auth: "offline",
          version: VERSION,
          respawn: false,
        }),
      acquisitionAllowance,
      (lateBot) => disposeBot(lateBot, 1000),
    );
    if (now() >= acquisitionDeadline) throw new Error("bot create timeout");
    const markTransportFailure = () => {
      if (!protocolCompleted) transportFailed = true;
    };
    bot.on?.("error", markTransportFailure);
    bot.on?.("end", markTransportFailure);
    bot.on?.("kicked", markTransportFailure);
    await waitSpawn(bot, runPhase);
    await runPhase(() => bot.waitForTicks(1), "initial physics tick");
    bot._client.write("player_loaded", {});
    if (transportFailed) throw new Error("participant transport failed");
    await runPhase(() => sendMessage(outgoing("ready", trialId, actionId)), "send ready");
    const begin = await runPhase(() => waitForCommand(), "wait begin");
    validateCommand(begin, "begin", trialId, actionId);
    if (commandProbe === "permissions") {
      for (const text of ["/op PilotProbe", "/gamemode creative"]) {
        await runPhase(() => bot.chat(text), "fixed permission command");
        await runPhase(() => sleep(ACTION_MS), "command settle");
      }
    }
    if (movement === "forward") bot.setControlState("forward", true);
    try {
      await runPhase(() => sleep(ACTION_MS), "fixed action");
    } finally {
      bot.setControlState("forward", false);
    }
    await runPhase(() => sendMessage(outgoing("action_finished", trialId, actionId)), "send action finished");
    const finalize = await runPhase(() => waitForCommand(), "wait finalize");
    validateCommand(finalize, "finalize", trialId, actionId);
    protocolCompleted = true;
    result = {
      schema_version: 1,
      status: "protocol_completed",
      trial_id: trialId,
      action_id: actionId,
      movement_mode: movement,
    };
  } catch {
    result = { schema_version: 1, status: "failed" };
  } finally {
    let cleanupRemaining = 0;
    try {
      cleanupRemaining = Math.min(1000, remaining());
    } catch {}
    const cleanClose = await disposeBot(bot, cleanupRemaining);
    if (!cleanClose) result = { schema_version: 1, status: "failed" };
  }
  try {
    if (now() >= deadline) return { schema_version: 1, status: "failed" };
  } catch {
    return { schema_version: 1, status: "failed" };
  }
  return result;
}
