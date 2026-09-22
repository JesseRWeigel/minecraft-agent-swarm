import { performance } from "node:perf_hooks";

const HOST = "127.0.0.1";
const PORT = 25585;
const USERNAME = "PilotProbe";
const VERSION = "1.21.4";
const TRIAL_ID = "collect-oak-log-v1";
const ACTION_ID = "collect-01";
const PHASE_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 90_000;
const ACTION_TIMEOUT_MS = 15_000;
const COLLECTION_TIMEOUT_MS = 3_000;
const MESSAGE_KEYS = new Set(["schema_version", "type", "trial_id", "action_id"]);

function bounded(factory, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve().then(factory),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function destroySocket(bot) {
  for (const socket of [bot?.socket, bot?._client?.socket]) {
    try {
      if (socket && !socket.destroyed) socket.destroy();
    } catch {}
  }
}

async function disposeBot(bot, timeoutMs) {
  if (!bot) return;
  try {
    try {
      bot.on?.("error", () => {});
    } catch {}
    try {
      bot.setControlState?.("forward", false);
    } catch {}
    try {
      if (timeoutMs > 0) await bounded(() => bot.quit?.("oak participant complete"), timeoutMs, "bot quit");
    } catch {}
  } finally {
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

function outgoing(type) {
  return Object.freeze({ schema_version: 1, type, trial_id: TRIAL_ID, action_id: ACTION_ID });
}

function validateCommand(value, expectedType) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("invalid supervisor message");
  if (Object.keys(value).length !== MESSAGE_KEYS.size || Object.keys(value).some((key) => !MESSAGE_KEYS.has(key)))
    throw new Error("invalid supervisor message");
  if (
    value.schema_version !== 1 ||
    value.type !== expectedType ||
    value.trial_id !== TRIAL_ID ||
    value.action_id !== ACTION_ID
  )
    throw new Error("invalid supervisor message");
}

function hasOakLog(bot) {
  return (
    bot.inventory
      ?.items?.()
      .some((item) => item?.name === "oak_log" && Number.isFinite(item.count) && item.count >= 1) === true
  );
}

async function collectOakLog(bot, sleep, now, runPhase, isCancelled, mineOnly = false) {
  const target = bot.entity.position.clone().set(0, 200, 3);
  const block = bot.blockAt(target);
  if (!block || block.name !== "oak_log") throw new Error("fixed oak log unavailable");
  if (isCancelled()) throw new Error("oak action cancelled");
  await runPhase(() => bot.lookAt(target.clone().set(0.5, 200.5, 3.5)), "look at oak log");
  if (isCancelled()) throw new Error("oak action cancelled");
  await runPhase(() => bot.dig(block), "dig oak log");
  if (isCancelled()) throw new Error("oak action cancelled");
  if (mineOnly) return;
  await runPhase(() => bot.lookAt(target.clone().set(0.5, 201.62, 10)), "look toward oak drop");
  if (isCancelled()) throw new Error("oak action cancelled");
  if (hasOakLog(bot)) return;
  const deadline = now() + COLLECTION_TIMEOUT_MS;
  if (isCancelled()) throw new Error("oak action cancelled");
  bot.setControlState("forward", true);
  try {
    while (!hasOakLog(bot) && now() < deadline) {
      if (isCancelled()) throw new Error("oak action cancelled");
      await runPhase(() => sleep(100), "collect oak log");
      if (isCancelled()) throw new Error("oak action cancelled");
    }
  } finally {
    if (!isCancelled()) bot.setControlState("forward", false);
  }
}

export async function runParticipant({
  createBot,
  sendMessage,
  waitForCommand,
  trialId = TRIAL_ID,
  actionId = ACTION_ID,
  movement = "forward",
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowMonotonic = performance.now.bind(performance),
  phaseTimeoutMs = PHASE_TIMEOUT_MS,
  totalTimeoutMs = TOTAL_TIMEOUT_MS,
} = {}) {
  if (typeof createBot !== "function" || typeof sendMessage !== "function" || typeof waitForCommand !== "function")
    throw new TypeError("participant adapters required");
  if (trialId !== TRIAL_ID || actionId !== ACTION_ID) throw new RangeError("fixed supervisor IDs required");
  if (!["forward", "stationary", "mine_only", "blocked"].includes(movement)) throw new RangeError("invalid movement");
  if (typeof sleep !== "function" || typeof nowMonotonic !== "function")
    throw new TypeError("participant clocks required");
  if (!Number.isInteger(phaseTimeoutMs) || phaseTimeoutMs < 1 || phaseTimeoutMs > PHASE_TIMEOUT_MS)
    throw new RangeError("invalid phaseTimeoutMs");
  if (!Number.isInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > TOTAL_TIMEOUT_MS)
    throw new RangeError("invalid totalTimeoutMs");

  let lastNow;
  const now = () => {
    const value = nowMonotonic();
    if (!Number.isFinite(value) || (lastNow !== undefined && value < lastNow))
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
  let bot,
    transportFailed = false,
    protocolCompleted = false,
    cancelled = false;
  const runPhase = async (factory, label, cap = phaseTimeoutMs) => {
    const phaseStarted = now();
    const allowance = Math.min(deadline, phaseStarted + Math.min(phaseTimeoutMs, cap)) - phaseStarted;
    if (allowance <= 0) throw new Error("participant total timeout");
    const value = await bounded(factory, allowance, label);
    if (now() >= phaseStarted + allowance || transportFailed) throw new Error("participant phase failure");
    return value;
  };
  let result = { schema_version: 1, status: "failed" };
  try {
    const acquisitionStarted = now();
    const allowance = Math.min(deadline, acquisitionStarted + phaseTimeoutMs) - acquisitionStarted;
    if (allowance <= 0) throw new Error("participant total timeout");
    bot = await boundedAcquire(
      () =>
        createBot({ host: HOST, port: PORT, username: USERNAME, auth: "offline", version: VERSION, respawn: false }),
      allowance,
      (lateBot) => disposeBot(lateBot, 1000),
    );
    if (now() >= acquisitionStarted + allowance) throw new Error("bot create timeout");
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
    await runPhase(() => sendMessage(outgoing("ready")), "send ready");
    validateCommand(await runPhase(() => waitForCommand(), "wait begin"), "begin");
    if (movement === "forward" || movement === "mine_only")
      await runPhase(
        () => collectOakLog(bot, sleep, now, runPhase, () => cancelled, movement === "mine_only"),
        "fixed oak action",
        ACTION_TIMEOUT_MS,
      );
    if (movement === "blocked") {
      await runPhase(() => bot.lookAt(bot.entity.position.clone().set(0.5, 200.5, 3.5)), "look at barrier");
      if (cancelled) throw new Error("cancelled");
      const barrier = bot.blockAtCursor(4.5);
      if (!barrier || barrier.name !== "bedrock" || bot.canDigBlock(barrier)) throw new Error("barrier not verified");
      bot.setControlState("forward", true);
      try { await runPhase(() => sleep(1000), "blocked approach"); }
      finally { if (!cancelled) bot.setControlState("forward", false); }
    }
    await runPhase(() => sendMessage(outgoing("action_finished")), "send action finished");
    validateCommand(await runPhase(() => waitForCommand(), "wait finalize"), "finalize");
    protocolCompleted = true;
    result = {
      schema_version: 1,
      status: "protocol_completed",
      trial_id: TRIAL_ID,
      action_id: ACTION_ID,
      movement_mode: movement,
    };
  } catch {
    cancelled = true;
    result = { schema_version: 1, status: "failed" };
  } finally {
    cancelled = true;
    let cleanupRemaining = 0;
    try {
      cleanupRemaining = Math.min(1000, remaining());
    } catch {}
    await disposeBot(bot, cleanupRemaining);
  }
  try {
    return now() >= deadline ? { schema_version: 1, status: "failed" } : result;
  } catch {
    return { schema_version: 1, status: "failed" };
  }
}
