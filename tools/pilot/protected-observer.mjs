import { performance } from "node:perf_hooks";

// This library bounds how long it awaits a query, but cannot cancel an adapter
// transport. The future supervisor remains responsible for closing/destroying
// the RCON connection after every sample, including timeout and failure paths.
// Health zero is retained as an authoritative death observation. This sampler
// records state and does not decide whether the actor is alive or successful.

const ACTOR = "PilotProbe";
const FIELDS = ["Pos", "Dimension", "Health", "UUID", "Roster", "playerGameType"];
const ID_PATTERN = /[A-Za-z0-9][A-Za-z0-9._-]{0,63}/;
const MAX_RESPONSE_BYTES = 65536;
const MAX_COORDINATE = 30_000_000;
const MAX_HEALTH = 2048;

class SampleFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function validateOptions({ rcon, phase, trialId, actionId, nowMonotonic, nowUtc, operationTimeoutMs }) {
  if (!rcon || typeof rcon.send !== "function") throw new TypeError("rcon.send is required");
  if (phase !== "before" && phase !== "terminal") throw new RangeError("invalid observer phase");
  if (
    typeof trialId !== "string" ||
    typeof actionId !== "string" ||
    ID_PATTERN.exec(trialId)?.[0] !== trialId ||
    ID_PATTERN.exec(actionId)?.[0] !== actionId
  )
    throw new RangeError("invalid supervisor ID");
  if (typeof nowMonotonic !== "function" || typeof nowUtc !== "function")
    throw new TypeError("observer clocks required");
  if (!Number.isInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 5000)
    throw new RangeError("invalid operationTimeoutMs");
}

function parseReply(field, text) {
  if (field === "Roster") {
    if (text !== "There are 1 of a max of 1 players online: PilotProbe")
      throw new SampleFailure("invalid_response");
    return [ACTOR];
  }
  const prefix = `${ACTOR} has the following entity data: `;
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_RESPONSE_BYTES || !text.startsWith(prefix))
    throw new SampleFailure("invalid_response");
  const value = text.slice(prefix.length);
  if (field === "playerGameType") {
    if (!["0", "1", "2", "3"].includes(value)) throw new SampleFailure("invalid_response");
    return Number(value);
  }
  if (field === "UUID") {
    const match = value.match(/^\[I;\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\]$/);
    const expected = [-246738247, 1303722752, -1416835668, -1046535363];
    if (!match || !expected.every((n, i) => Number(match[i + 1]) === n))
      throw new SampleFailure("invalid_response");
    return "f14b12b9-4db5-3b00-ab8c-cdacc19f233d";
  }
  const number = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
  if (field === "Pos") {
    const match = value.match(new RegExp(`^\\[(${number})d?,\\s*(${number})d?,\\s*(${number})d?\\]$`));
    if (!match) throw new SampleFailure("invalid_response");
    const position = { x: +match[1], y: +match[2], z: +match[3] };
    if (!Object.values(position).every((item) => Number.isFinite(item) && Math.abs(item) <= MAX_COORDINATE))
      throw new SampleFailure("invalid_response");
    return position;
  }
  if (field === "Dimension") {
    const match = value.match(/^"(minecraft:(?:overworld|the_nether|the_end))"$/);
    if (!match) throw new SampleFailure("invalid_response");
    return match[1];
  }
  const match = value.match(new RegExp(`^(${number})f?$`));
  const health = match ? +match[1] : Number.NaN;
  if (!Number.isFinite(health) || health < 0 || health > MAX_HEALTH) throw new SampleFailure("invalid_response");
  return health;
}

function boundedSend(rcon, command, timeoutMs) {
  let timer;
  const pending = Promise.resolve().then(() => rcon.send(command));
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SampleFailure("timeout")), timeoutMs);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

export async function sampleActor({
  rcon,
  phase,
  trialId,
  actionId,
  nowMonotonic = performance.now.bind(performance),
  nowUtc = () => new Date().toISOString(),
  operationTimeoutMs = 5000,
} = {}) {
  validateOptions({ rcon, phase, trialId, actionId, nowMonotonic, nowUtc, operationTimeoutMs });
  let lastMonotonic = null;
  let lastUtcMs = null;
  let lastUtc = null;
  const monotonic = () => {
    const value = nowMonotonic();
    if (typeof value !== "number" || !Number.isFinite(value) || (lastMonotonic !== null && value < lastMonotonic))
      throw new SampleFailure("clock_invalid");
    lastMonotonic = value;
    return value;
  };
  const utc = () => {
    const value = nowUtc();
    const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(parsed) ||
      new Date(parsed).toISOString() !== value ||
      (lastUtcMs !== null && parsed < lastUtcMs)
    )
      throw new SampleFailure("clock_invalid");
    lastUtcMs = parsed;
    lastUtc = value;
    return value;
  };

  const result = {
    schemaVersion: 1,
    status: "failed",
    source: "server_rcon",
    actor: ACTOR,
    phase,
    trialId,
    actionId,
    observations: {},
    sample: {
      startedAtUtc: null,
      finishedAtUtc: null,
      startedMonotonicMs: null,
      finishedMonotonicMs: null,
      durationMs: null,
      queryWindows: [],
    },
  };

  let started;
  let deadline;
  try {
    started = monotonic();
    result.sample.startedMonotonicMs = started;
    result.sample.startedAtUtc = utc();
    deadline = started + operationTimeoutMs;
    for (const field of FIELDS) {
      const window = {
        field,
        sent: false,
        startedAtUtc: null,
        finishedAtUtc: null,
        startedMonotonicMs: null,
        finishedMonotonicMs: null,
        durationMs: null,
        outcome: "failed",
      };
      result.sample.queryWindows.push(window);
      const queryStarted = monotonic();
      window.startedMonotonicMs = queryStarted;
      window.startedAtUtc = utc();
      const remaining = deadline - queryStarted;
      if (remaining <= 0) {
        window.finishedMonotonicMs = queryStarted;
        window.finishedAtUtc = window.startedAtUtc;
        window.durationMs = 0;
        window.outcome = "timeout";
        throw new SampleFailure("timeout");
      }
      let reply;
      let sendFailure;
      try {
        window.sent = true;
        reply = await boundedSend(rcon, field === "Roster" ? "list" : `data get entity ${ACTOR} ${field}`, remaining);
      } catch (error) {
        sendFailure = error instanceof SampleFailure ? error : new SampleFailure("query_failed");
        window.outcome = sendFailure.code;
      }
      let queryFinished;
      try {
        queryFinished = monotonic();
        window.finishedMonotonicMs = queryFinished;
        window.durationMs = queryFinished - queryStarted;
        window.finishedAtUtc = utc();
      } catch (error) {
        window.outcome = "clock_invalid";
        throw error;
      }
      if (queryFinished >= deadline) {
        window.outcome = "timeout";
        throw new SampleFailure("timeout");
      }
      if (sendFailure) throw sendFailure;
      try {
        const parsed = parseReply(field, reply);
        if (field === "Pos") result.observations.position = parsed;
        else if (field === "Dimension") result.observations.dimension = parsed;
        else if (field === "Health") result.observations.health = parsed;
        else if (field === "UUID") result.observations.uuid = parsed;
        else if (field === "Roster") result.observations.roster = parsed;
        else result.observations.gameMode = parsed;
      } catch (error) {
        window.outcome = "invalid";
        throw error;
      }
      window.outcome = "completed";
    }
    result.status = "sampled";
  } catch (error) {
    result.errorCode = error instanceof SampleFailure ? error.code : "observer_failure";
  }

  try {
    const finished = monotonic();
    result.sample.finishedMonotonicMs = finished;
    result.sample.durationMs = started === undefined ? null : finished - started;
    result.sample.finishedAtUtc = utc();
    if (result.status === "sampled" && deadline !== undefined && finished >= deadline) {
      result.status = "failed";
      result.errorCode = "timeout";
    }
  } catch {
    result.status = "failed";
    result.errorCode = "clock_invalid";
    result.sample.finishedMonotonicMs = lastMonotonic;
    result.sample.finishedAtUtc = lastUtc;
    result.sample.durationMs = started === undefined || lastMonotonic === null ? null : lastMonotonic - started;
  }
  return result;
}
