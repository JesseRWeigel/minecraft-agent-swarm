import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const ACTOR = "PilotProbe";
const MAX_RESPONSE_BYTES = 65_536;
const MAX_OPERATION_TIMEOUT_MS = 15_000;
const SETTLE_MS = 100;

export const FIXTURE_COMMANDS = Object.freeze(
  [
    { name: "peaceful_difficulty", command: "difficulty peaceful" },
    { name: "disable_mob_spawning", command: "gamerule doMobSpawning false" },
    { name: "disable_daylight_cycle", command: "gamerule doDaylightCycle false" },
    { name: "disable_weather_cycle", command: "gamerule doWeatherCycle false" },
    { name: "fixed_day", command: "time set day" },
    { name: "clear_weather", command: "weather clear" },
    {
      name: "forceload_fixture",
      command: "execute in minecraft:overworld run forceload add -4 -4 4 12",
    },
    {
      name: "clear_fixture_volume",
      command: "execute in minecraft:overworld run fill -4 199 -4 4 204 12 minecraft:air",
    },
    {
      name: "build_stone_floor",
      command: "execute in minecraft:overworld run fill -4 199 -4 4 199 12 minecraft:stone",
    },
    { name: "clear_inventory", command: "clear PilotProbe" },
    { name: "survival_mode", command: "gamemode survival PilotProbe" },
    {
      name: "fixed_spawn",
      command: "execute in minecraft:overworld run teleport PilotProbe 0.5 200 0.5 0 0",
    },
    {
      name: "restore_health",
      command: "effect give PilotProbe minecraft:instant_health 1 255 true",
    },
    {
      name: "restore_food",
      command: "effect give PilotProbe minecraft:saturation 1 255 true",
    },
    { name: "clear_effects", command: "effect clear PilotProbe" },
  ].map(Object.freeze),
);

export const BASELINE_QUERIES = Object.freeze(
  [
    { name: "orientation", command: "data get entity PilotProbe Rotation" },
    { name: "inventory", command: "data get entity PilotProbe Inventory" },
    { name: "game_mode", command: "data get entity PilotProbe playerGameType" },
    { name: "food", command: "data get entity PilotProbe foodLevel" },
    { name: "effects", command: "data get entity PilotProbe active_effects" },
  ].map(Object.freeze),
);

const FIXTURE_CONTENT = Object.freeze({
  schemaVersion: 1,
  actor: ACTOR,
  position: Object.freeze({ x: 0.5, y: 200, z: 0.5, yaw: 0, pitch: 0 }),
  settleMs: SETTLE_MS,
  commands: FIXTURE_COMMANDS,
  baselineQueries: BASELINE_QUERIES,
});

export const FIXTURE_SHA256 = createHash("sha256").update(JSON.stringify(FIXTURE_CONTENT), "utf8").digest("hex");

class FixtureFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function validateOptions({ rcon, nowMonotonic, operationTimeoutMs }) {
  if (!rcon || typeof rcon.send !== "function") throw new TypeError("rcon.send is required");
  if (typeof nowMonotonic !== "function") throw new TypeError("nowMonotonic is required");
  if (!Number.isInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > MAX_OPERATION_TIMEOUT_MS)
    throw new RangeError("invalid operationTimeoutMs");
}

function readClock(nowMonotonic, previous) {
  const value = nowMonotonic();
  if (typeof value !== "number" || !Number.isFinite(value) || (previous !== null && value < previous))
    throw new FixtureFailure("clock_invalid");
  return value;
}

function bounded(operation, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new FixtureFailure("timeout")), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => clearTimeout(timer));
}

function validateCommandReply(reply, name) {
  // Paper returns an empty response when the player already has this game mode.
  // The independent playerGameType readback below must still verify survival.
  if (reply === "" && name === "survival_mode") return;
  if (typeof reply !== "string" || reply.length === 0 || Buffer.byteLength(reply, "utf8") > MAX_RESPONSE_BYTES)
    throw new FixtureFailure("invalid_response");
  if (
    /(?:unknown or incomplete command|incorrect argument|no entity was found|cannot find|exception|permission|not allowed|failed)/i.test(
      reply,
    )
  )
    throw new FixtureFailure("command_failed");
}

function parseBaselineReply(name, reply) {
  if (typeof reply !== "string" || Buffer.byteLength(reply, "utf8") > MAX_RESPONSE_BYTES)
    throw new FixtureFailure("invalid_response");
  const prefix = `${ACTOR} has the following entity data: `;
  if (name === "effects" && /^Found no elements matching (?:active_effects|ActiveEffects)$/.test(reply)) return;
  if (!reply.startsWith(prefix)) throw new FixtureFailure("baseline_mismatch");
  const value = reply.slice(prefix.length);
  if (name === "orientation") {
    const match = value.match(/^\[([+-]?(?:\d+(?:\.\d*)?|\.\d+))f?,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))f?\]$/);
    if (!match || +match[1] !== 0 || +match[2] !== 0) throw new FixtureFailure("baseline_mismatch");
    return;
  }
  const expected = { inventory: "[]", game_mode: "0", food: "20", effects: "[]" }[name];
  if (value !== expected) throw new FixtureFailure("baseline_mismatch");
}

function publicFixture() {
  return {
    schemaVersion: FIXTURE_CONTENT.schemaVersion,
    actor: FIXTURE_CONTENT.actor,
    position: { ...FIXTURE_CONTENT.position },
    settleMs: FIXTURE_CONTENT.settleMs,
    commands: FIXTURE_COMMANDS.map((entry) => ({ ...entry })),
    baselineQueries: BASELINE_QUERIES.map((entry) => ({ ...entry })),
    sha256: FIXTURE_SHA256,
  };
}

export async function setupMovementFixture({
  rcon,
  nowMonotonic = performance.now.bind(performance),
  operationTimeoutMs = MAX_OPERATION_TIMEOUT_MS,
} = {}) {
  validateOptions({ rcon, nowMonotonic, operationTimeoutMs });
  const result = {
    schemaVersion: 1,
    status: "failed",
    fixture: publicFixture(),
    commandWindows: [],
    baselineChecks: [],
    durationMs: null,
  };
  let last = null;
  let started;
  let deadline;

  const clock = () => (last = readClock(nowMonotonic, last));
  const remaining = () => {
    const current = clock();
    const available = deadline - current;
    if (available <= 0) throw new FixtureFailure("timeout");
    return { current, available };
  };

  try {
    started = clock();
    deadline = started + operationTimeoutMs;
    for (const entry of FIXTURE_COMMANDS) {
      const { current, available } = remaining();
      const window = {
        name: entry.name,
        outcome: "pending",
        verification: "unverified",
        startedMonotonicMs: current,
        finishedMonotonicMs: null,
        durationMs: null,
      };
      result.commandWindows.push(window);
      let reply;
      try {
        reply = await bounded(() => rcon.send(entry.command), available);
        window.responseType = typeof reply;
        window.responseBytes = typeof reply === "string" ? Buffer.byteLength(reply, "utf8") : null;
        validateCommandReply(reply, entry.name);
        window.outcome = "issued";
      } catch (error) {
        window.outcome = error instanceof FixtureFailure ? error.code : "command_failed";
        throw error;
      } finally {
        const finished = clock();
        window.finishedMonotonicMs = finished;
        window.durationMs = finished - current;
        if (finished >= deadline) window.outcome = "timeout";
      }
      if (window.outcome === "timeout") throw new FixtureFailure("timeout");
    }

    const settle = remaining();
    await bounded(() => new Promise((resolve) => setTimeout(resolve, SETTLE_MS)), settle.available);

    for (const query of BASELINE_QUERIES) {
      const { current, available } = remaining();
      const check = {
        name: query.name,
        status: "pending",
        startedMonotonicMs: current,
        finishedMonotonicMs: null,
        durationMs: null,
      };
      result.baselineChecks.push(check);
      let reply;
      try {
        reply = await bounded(() => rcon.send(query.command), available);
        parseBaselineReply(query.name, reply);
        check.status = "verified";
      } catch (error) {
        check.status = "failed";
        throw error;
      } finally {
        const finished = clock();
        check.finishedMonotonicMs = finished;
        check.durationMs = finished - current;
        if (finished >= deadline) check.status = "timeout";
      }
      if (check.status === "timeout") throw new FixtureFailure("timeout");
    }
    if (clock() >= deadline) throw new FixtureFailure("timeout");
    result.status = "configured";
  } catch (error) {
    result.errorCode = error instanceof FixtureFailure ? error.code : "fixture_setup_failed";
  } finally {
    try {
      const finished = clock();
      result.durationMs = started === undefined ? null : finished - started;
      if (deadline !== undefined && finished >= deadline) {
        result.status = "failed";
        result.errorCode = "timeout";
      }
    } catch {
      result.status = "failed";
      result.errorCode = "clock_invalid";
    }
  }
  return result;
}

export function verifyFixtureSample(sample) {
  if (
    !sample ||
    sample.status !== "sampled" ||
    sample.source !== "server_rcon" ||
    sample.actor !== ACTOR ||
    !sample.observations ||
    sample.observations.dimension !== "minecraft:overworld"
  )
    return { status: "failed", errorCode: "invalid_sample" };
  const { position, health } = sample.observations;
  const withinTolerance = (actual, expected) =>
    Math.abs(actual - expected) <= 0.05 + Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected));
  if (
    !position ||
    ![position.x, position.y, position.z, health].every(Number.isFinite) ||
    !withinTolerance(position.x, 0.5) ||
    !withinTolerance(position.y, 200) ||
    !withinTolerance(position.z, 0.5) ||
    health !== 20
  )
    return { status: "failed", errorCode: "baseline_mismatch" };
  return { status: "verified" };
}
