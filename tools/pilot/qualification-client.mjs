import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HOST = "127.0.0.1",
  GAME_PORT = 25585,
  RCON_PORT = 25595,
  USERNAME = "PilotProbe",
  MINECRAFT_VERSION = "1.21.4";
const QUERY_FIELDS = ["Pos", "Dimension", "Health"];
const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));
function finitePos(p) {
  return p && [p.x, p.y, p.z].every(Number.isFinite) ? { x: p.x, y: p.y, z: p.z } : null;
}
function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
function horizontalDistance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
function parseReply(field, text) {
  const prefix = `${USERNAME} has the following entity data: `;
  if (typeof text !== "string" || !text.startsWith(prefix) || Buffer.byteLength(text) > 65536)
    throw new Error("invalid RCON response");
  const v = text.slice(prefix.length),
    n = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
  if (field === "Pos") {
    const m = v.match(new RegExp(`^\\[(${n})d?,\\s*(${n})d?,\\s*(${n})d?\\]$`));
    if (!m) throw new Error("invalid position");
    const p = { x: +m[1], y: +m[2], z: +m[3] };
    if (!finitePos(p)) throw new Error("invalid position");
    return p;
  }
  if (field === "Dimension") {
    const m = v.match(/^"(minecraft:(?:overworld|the_nether|the_end))"$/);
    if (!m) throw new Error("invalid dimension");
    return m[1];
  }
  const m = v.match(new RegExp(`^(${n})f?$`));
  if (!m || !Number.isFinite(+m[1])) throw new Error("invalid health");
  return +m[1];
}
async function bounded(factory, ms, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(factory),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function boundedAcquire(factory, ms, label, dispose) {
  let expired = false;
  const pending = Promise.resolve().then(factory);
  try {
    return await bounded(() => pending, ms, label);
  } catch (error) {
    expired = true;
    pending.then(
      (value) => dispose(value),
      () => {},
    );
    throw error;
  } finally {
    if (!expired) pending.catch(() => {});
  }
}
async function waitSpawn(bot, ms) {
  if (bot.entity) return;
  let onSpawn, onError, onKicked;
  try {
    await bounded(
      () =>
        new Promise((resolve, reject) => {
          onSpawn = resolve;
          onError = reject;
          onKicked = (reason) => reject(new Error(`kicked: ${String(reason).slice(0, 128)}`));
          bot.once("spawn", onSpawn);
          bot.once("error", onError);
          bot.once("kicked", onKicked);
        }),
      ms,
      "bot spawn",
    );
  } finally {
    bot.off("spawn", onSpawn);
    bot.off("error", onError);
    bot.off("kicked", onKicked);
  }
}
function timeLeft(deadlineMs, now, limit) {
  return Math.min(limit, Math.max(0, deadlineMs - now()));
}
async function observe(rcon, { deadlineMs, now, operationTimeoutMs }) {
  const out = {};
  for (const field of QUERY_FIELDS) {
    const remaining = timeLeft(deadlineMs, now, operationTimeoutMs);
    if (remaining < 1) throw new Error("observation timeout");
    const command = `data get entity ${USERNAME} ${field}`;
    out[field] = parseReply(field, await bounded(() => rcon.send(command), remaining, `${field} observation`));
  }
  return { position: out.Pos, dimension: out.Dimension, health: out.Health };
}
async function settleTerminal(rcon, bot, { deadlineMs, now, sleep, operationTimeoutMs }) {
  const startedMs = now();
  let observation,
    mineflayerPosition,
    pollCount = 0;
  while (now() < deadlineMs) {
    try {
      observation = await observe(rcon, { deadlineMs, now, operationTimeoutMs });
      pollCount += 1;
      mineflayerPosition = finitePos(bot.entity?.position);
      if (mineflayerPosition && distance(observation.position, mineflayerPosition) <= 1.5) {
        return {
          observation,
          mineflayerPosition,
          settled: true,
          pollCount,
          elapsedMs: Math.max(0, now() - startedMs),
        };
      }
    } catch {
      break;
    }
    const delay = Math.min(50, Math.max(0, deadlineMs - now()));
    if (delay) await bounded(() => sleep(delay), delay + 1, "terminal poll sleep").catch(() => {});
  }
  return {
    observation,
    mineflayerPosition,
    settled: false,
    pollCount,
    elapsedMs: Math.max(0, now() - startedMs),
  };
}
function destroySocket(value) {
  for (const socket of [value?.socket, value?._client?.socket]) {
    try {
      if (socket && !socket.destroyed) socket.destroy();
    } catch {}
  }
}
async function closeBot(bot) {
  if (!bot) return;
  try {
    await bounded(() => bot.quit?.("qualification complete"), 1000, "bot quit");
  } catch {
  } finally {
    destroySocket(bot);
  }
}
async function closeRcon(rcon) {
  if (!rcon) return;
  try {
    await bounded(() => rcon.end?.(), 1000, "RCON close");
  } catch {
  } finally {
    destroySocket(rcon);
  }
}
async function connectReady(connectRcon, { deadlineMs, now, sleep, operationTimeoutMs }) {
  let last;
  while (now() < deadlineMs) {
    let candidate;
    try {
      const remaining = timeLeft(deadlineMs, now, operationTimeoutMs);
      candidate = await boundedAcquire(
        () => connectRcon({ host: HOST, port: RCON_PORT }),
        remaining,
        "RCON connect",
        closeRcon,
      );
      const observation = await observe(candidate, { deadlineMs, now, operationTimeoutMs });
      return { rcon: candidate, observation };
    } catch (error) {
      last = error;
      await closeRcon(candidate);
      const delay = Math.min(250, Math.max(0, deadlineMs - now()));
      if (delay) await bounded(() => sleep(delay), delay, "readiness retry sleep").catch(() => {});
    }
  }
  throw new Error(`server readiness failed: ${last?.message ?? "timeout"}`);
}
export async function runQualification({
  createBot,
  connectRcon,
  writeEvidence,
  now = () => Date.now(),
  sleep = sleepDefault,
  readyTimeoutMs = 60000,
  actionMs = 1000,
  operationTimeoutMs = 5000,
  movement = "forward",
} = {}) {
  if (typeof createBot !== "function" || typeof connectRcon !== "function" || typeof writeEvidence !== "function")
    throw new TypeError("qualification adapters required");
  for (const [n, v, max] of [
    ["readyTimeoutMs", readyTimeoutMs, 60000],
    ["actionMs", actionMs, 2000],
    ["operationTimeoutMs", operationTimeoutMs, 5000],
  ])
    if (!Number.isInteger(v) || v < 1 || v > max) throw new RangeError(`invalid ${n}`);
  if (movement !== "forward" && movement !== "stationary") throw new RangeError("invalid movement");
  let bot,
    rcon,
    captureComplete = false,
    transportFailed = false,
    report = {
      schemaVersion: 1,
      status: "failed",
      claimsLiveBenchmarkResult: false,
      endpoint: { host: HOST, gamePort: GAME_PORT, rconPort: RCON_PORT },
      username: USERNAME,
      minecraftVersion: MINECRAFT_VERSION,
      movementMode: movement,
    };
  try {
    bot = await boundedAcquire(
      () =>
        createBot({
          host: HOST,
          port: GAME_PORT,
          username: USERNAME,
          auth: "offline",
          version: MINECRAFT_VERSION,
        }),
      operationTimeoutMs,
      "bot create",
      (lateBot) => {
        lateBot?.on?.("error", () => {});
        return closeBot(lateBot);
      },
    );
    const markTransportFailed = () => {
      if (!captureComplete) transportFailed = true;
    };
    bot.on?.("error", markTransportFailed);
    bot.on?.("end", markTransportFailed);
    bot.on?.("kicked", markTransportFailed);
    await waitSpawn(bot, readyTimeoutMs);
    await bounded(() => bot.waitForTicks(1), operationTimeoutMs, "initial physics tick");
    const ready = await connectReady(connectRcon, {
      deadlineMs: now() + readyTimeoutMs,
      now,
      sleep,
      operationTimeoutMs,
    });
    rcon = ready.rcon;
    const before = ready.observation;
    const mineBefore = finitePos(bot.entity?.position);
    if (!mineBefore) throw new Error("Mineflayer position unavailable");
    const initialAgreement = distance(before.position, mineBefore);
    report = {
      ...report,
      before,
      mineflayer: { before: mineBefore },
      checks: { initialRconMineflayerDistance: initialAgreement, initialPositionsAgree: initialAgreement <= 1.5 },
    };
    if (initialAgreement > 1.5) throw new Error("initial positions disagree");
    if (movement === "forward") bot.setControlState("forward", true);
    try {
      await bounded(() => sleep(actionMs), actionMs + operationTimeoutMs, "movement action");
    } finally {
      bot.setControlState("forward", false);
    }
    const terminal = await settleTerminal(rcon, bot, {
      deadlineMs: now() + operationTimeoutMs,
      now,
      sleep,
      operationTimeoutMs,
    });
    const after = terminal.observation;
    const mineAfter = terminal.mineflayerPosition;
    report = {
      ...report,
      ...(after ? { after } : {}),
      mineflayer: { ...report.mineflayer, ...(mineAfter ? { after: mineAfter } : {}) },
      checks: {
        ...report.checks,
        terminalSettled: terminal.settled,
        terminalPollCount: terminal.pollCount,
        terminalElapsedMs: terminal.elapsedMs,
      },
    };
    if (!after || !mineAfter) throw new Error("terminal observation unavailable");
    const transportIntact = !transportFailed;
    captureComplete = true;
    const displacement = horizontalDistance(before.position, after.position),
      displacement3d = distance(before.position, after.position),
      agreement = distance(after.position, mineAfter);
    const passed =
      transportIntact &&
      terminal.settled &&
      displacement >= 0.5 &&
      displacement <= 10 &&
      after.health > 0 &&
      before.dimension === after.dimension &&
      agreement <= 1.5;
    report = {
      ...report,
      status: passed ? "passed" : "failed",
      before,
      after,
      mineflayer: { before: mineBefore, after: mineAfter },
      checks: {
        ...report.checks,
        displacement,
        displacement3d,
        transportIntact,
        rconMineflayerDistance: agreement,
        healthPositive: after.health > 0,
        dimensionUnchanged: before.dimension === after.dimension,
        displacementInBounds: displacement >= 0.5 && displacement <= 10,
        positionsAgree: agreement <= 1.5,
      },
    };
  } catch (e) {
    report = { ...report, status: "failed", error: "qualification failed" };
  } finally {
    try {
      bot?.setControlState?.("forward", false);
    } catch {}
    await closeBot(bot);
    await closeRcon(rcon);
  }
  await writeEvidence(report);
  return report;
}
export function writePrivateEvidence(output, report) {
  const fd = fs.openSync(output, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(report, null, 2) + String.fromCharCode(10));
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(output, 0o600);
}
async function main() {
  const { values } = parseArgs({ options: { output: { type: "string" }, stationary: { type: "boolean" } } });
  if (!values.output) throw new Error("--output is required");
  if (!process.env.PILOT_RCON_PASSWORD) throw new Error("PILOT_RCON_PASSWORD is required");
  const [{ createBot }, { Rcon }] = await Promise.all([import("mineflayer"), import("rcon-client")]);
  const writeEvidence = async (report) => writePrivateEvidence(values.output, report);
  const report = await runQualification({
    createBot,
    connectRcon: () => Rcon.connect({ host: HOST, port: RCON_PORT, password: process.env.PILOT_RCON_PASSWORD }),
    writeEvidence,
    movement: values.stationary ? "stationary" : "forward",
  });
  process.exitCode = report.status === "passed" ? 0 : 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch((e) => {
    console.error(String(e?.message ?? e).slice(0, 256));
    process.exitCode = 1;
  });
