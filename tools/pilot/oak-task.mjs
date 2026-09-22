// Trusted oak observations for the isolated fixed-client supervisor.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";
import { sampleActor } from "./protected-observer.mjs";
import { parseInventoryReply } from "./oak-inventory.mjs";

export const OAK_QUERIES = Object.freeze({
  inventory: "data get entity PilotProbe Inventory",
  log: "execute in minecraft:overworld if block 0 200 3 minecraft:oak_log",
  air: "execute in minecraft:overworld if block 0 200 3 minecraft:air",
});
const TASK = Object.freeze({
  id: "collect-oak-log-v1",
  schemaVersion: 1,
  queries: OAK_QUERIES,
  start: [0.5, 200, 0.5],
  requiredItem: "minecraft:oak_log",
  requiredCount: 1,
  maxSampleMs: 5000,
});
export const OAK_TASK_SHA256 = createHash("sha256").update(JSON.stringify(TASK)).digest("hex");
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID = "f14b12b9-4db5-3b00-ab8c-cdacc19f233d";
const validId = (x) => typeof x === "string" && ID.test(x) && !x.includes("\n");
const iso = (x) =>
  typeof x === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x) &&
  Number.isFinite(Date.parse(x)) &&
  new Date(x).toISOString() === x;
function blockReply(text) {
  if (text === "Test passed") return true;
  if (text === "Test failed") return false;
  throw new Error("invalid_response");
}
function state(log, air) {
  if (log && air) throw new Error("invalid_response");
  return log ? "minecraft:oak_log" : air ? "minecraft:air" : "other";
}
function same(a, b) {
  return isDeepStrictEqual(a, b);
}

export async function sampleOakTask({
  rcon,
  phase,
  trialId,
  actionId,
  operationTimeoutMs = 5000,
  nowMonotonic = performance.now.bind(performance),
  nowUtc = () => new Date().toISOString(),
} = {}) {
  if (
    !rcon ||
    typeof rcon.send !== "function" ||
    !["before", "during", "terminal"].includes(phase) ||
    !validId(trialId) ||
    !validId(actionId) ||
    !Number.isInteger(operationTimeoutMs) ||
    operationTimeoutMs < 1 ||
    operationTimeoutMs > 5000 ||
    typeof nowMonotonic !== "function" ||
    typeof nowUtc !== "function"
  )
    throw new TypeError("invalid oak observer options");
  const result = {
    schemaVersion: 1,
    taskId: TASK.id,
    taskSha256: OAK_TASK_SHA256,
    source: "server_rcon",
    status: "failed",
    phase,
    trialId,
    actionId,
    actorSample: null,
    inventory: null,
    targetBlock: null,
    queries: [],
    sample: { startedMonotonicMs: null, finishedMonotonicMs: null, startedAtUtc: null, finishedAtUtc: null },
  };
  let last = null,
    lastUtc = null,
    deadline;
  const mono = () => {
    const n = nowMonotonic();
    if (!Number.isFinite(n) || n < 0 || (last !== null && n < last)) throw new Error("clock_invalid");
    last = n;
    return n;
  };
  const utc = () => {
    const t = nowUtc();
    if (!iso(t) || (lastUtc !== null && Date.parse(t) < Date.parse(lastUtc))) throw new Error("clock_invalid");
    lastUtc = t;
    return t;
  };
  try {
    result.sample.startedMonotonicMs = mono();
    result.sample.startedAtUtc = utc();
    deadline = last + operationTimeoutMs;
    const actorBudget = Math.floor(deadline - mono());
    if (actorBudget < 1) throw new Error("timeout");
    result.actorSample = await sampleActor({
      rcon,
      phase,
      trialId,
      actionId,
      operationTimeoutMs: actorBudget,
      nowMonotonic: mono,
      nowUtc: utc,
    });
    if (result.actorSample.status !== "sampled") throw new Error(result.actorSample.errorCode || "actor_failed");
    const flags = {};
    for (const [field, command] of Object.entries(OAK_QUERIES)) {
      const q = {
        field,
        command,
        reply: null,
        outcome: "failed",
        startedMonotonicMs: mono(),
        finishedMonotonicMs: null,
        startedAtUtc: utc(),
        finishedAtUtc: null,
      };
      result.queries.push(q);
      const remaining = deadline - last;
      if (remaining <= 0) {
        q.outcome = "timeout";
        q.finishedMonotonicMs = q.startedMonotonicMs;
        q.finishedAtUtc = q.startedAtUtc;
        throw new Error("timeout");
      }
      let timer;
      try {
        const reply = await Promise.race([
          Promise.resolve().then(() => rcon.send(command)),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), remaining);
          }),
        ]);
        q.finishedMonotonicMs = mono();
        q.finishedAtUtc = utc();
        if (last >= deadline) throw new Error("timeout");
        if (typeof reply !== "string" || Buffer.byteLength(reply) > 65536) throw new Error("invalid_response");
        q.reply = reply;
        if (field === "inventory") result.inventory = parseInventoryReply(reply);
        else flags[field] = blockReply(reply);
        q.outcome = "completed";
      } catch (error) {
        q.outcome = error.message === "timeout" ? "timeout" : "failed";
        if (q.finishedMonotonicMs === null) {
          q.finishedMonotonicMs = mono();
          q.finishedAtUtc = utc();
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    result.targetBlock = state(flags.log, flags.air);
    result.status = "sampled";
  } catch (error) {
    result.errorCode = ["timeout", "clock_invalid", "invalid_response", "actor_failed"].includes(error.message)
      ? error.message
      : "observation_failed";
  }
  try {
    result.sample.finishedMonotonicMs = mono();
    result.sample.finishedAtUtc = utc();
    if (last >= deadline) {
      result.status = "failed";
      result.errorCode = "timeout";
    }
  } catch {
    result.status = "failed";
    result.errorCode = "clock_invalid";
  }
  return result;
}

function timeWindow(w) {
  return (
    w &&
    Number.isFinite(w.startedMonotonicMs) &&
    w.startedMonotonicMs >= 0 &&
    Number.isFinite(w.finishedMonotonicMs) &&
    w.finishedMonotonicMs >= w.startedMonotonicMs &&
    w.finishedMonotonicMs - w.startedMonotonicMs < 5000 &&
    iso(w.startedAtUtc) &&
    iso(w.finishedAtUtc) &&
    Date.parse(w.finishedAtUtc) >= Date.parse(w.startedAtUtc)
  );
}
function validateSample(s, phase, trialId, actionId) {
  if (
    !s ||
    s.schemaVersion !== 1 ||
    s.taskId !== TASK.id ||
    s.taskSha256 !== OAK_TASK_SHA256 ||
    s.source !== "server_rcon" ||
    s.status !== "sampled" ||
    s.errorCode ||
    s.phase !== phase ||
    s.trialId !== trialId ||
    s.actionId !== actionId ||
    !timeWindow(s.sample)
  )
    return false;
  const a = s.actorSample,
    o = a?.observations;
  if (
    !a ||
    a.schemaVersion !== 1 ||
    a.status !== "sampled" ||
    a.errorCode ||
    a.source !== "server_rcon" ||
    a.actor !== "PilotProbe" ||
    a.phase !== phase ||
    a.trialId !== trialId ||
    a.actionId !== actionId ||
    !o ||
    o.uuid !== UUID ||
    !same(o.roster, ["PilotProbe"]) ||
    o.dimension !== "minecraft:overworld" ||
    o.gameMode !== 0 ||
    !Number.isFinite(o.health) ||
    o.health <= 0 ||
    o.health > 20 ||
    !o.position ||
    ![o.position.x, o.position.y, o.position.z].every(Number.isFinite) ||
    !timeWindow(a.sample)
  )
    return false;
  if (phase === "before" && (o.health !== 20 || !same([o.position.x, o.position.y, o.position.z], TASK.start)))
    return false;
  const fields = ["Pos", "Dimension", "Health", "UUID", "Roster", "playerGameType"];
  if (!Array.isArray(a.sample.queryWindows) || a.sample.queryWindows.length !== fields.length) return false;
  let prior = s.sample.startedMonotonicMs;
  for (const [i, w] of a.sample.queryWindows.entries()) {
    if (
      w.field !== fields[i] ||
      w.sent !== true ||
      w.outcome !== "completed" ||
      !timeWindow(w) ||
      w.startedMonotonicMs < prior ||
      w.finishedMonotonicMs > a.sample.finishedMonotonicMs
    )
      return false;
    prior = w.finishedMonotonicMs;
  }
  if (
    a.sample.startedMonotonicMs < s.sample.startedMonotonicMs ||
    a.sample.finishedMonotonicMs > s.sample.finishedMonotonicMs
  )
    return false;
  prior = a.sample.finishedMonotonicMs;
  if (!Array.isArray(s.queries) || s.queries.length !== 3) return false;
  for (const [i, [field, command]] of Object.entries(OAK_QUERIES).entries()) {
    const q = s.queries[i];
    if (
      !q ||
      q.field !== field ||
      q.command !== command ||
      q.outcome !== "completed" ||
      !timeWindow(q) ||
      q.startedMonotonicMs < prior ||
      q.finishedMonotonicMs > s.sample.finishedMonotonicMs
    )
      return false;
    prior = q.finishedMonotonicMs;
  }
  const inventory = parseInventoryReply(s.queries[0].reply);
  if (
    !same(inventory, s.inventory) ||
    state(blockReply(s.queries[1].reply), blockReply(s.queries[2].reply)) !== s.targetBlock
  )
    return false;
  return true;
}

// This pure predicate consumes trusted observer evidence, never participant claims.
// It cannot validate fixture setup, elapsed action budget, process isolation or cleanup.
// The future host runner must apply those independent gates before accepting a trial.
export function scoreOakTask(input) {
  const invalid = { status: "invalid", acquired: null, gameplayQualified: false };
  try {
    const { before, terminal, trialId, actionId } = input;
    if (
      !validId(trialId) ||
      !validId(actionId) ||
      !validateSample(before, "before", trialId, actionId) ||
      !validateSample(terminal, "terminal", trialId, actionId)
    )
      return invalid;
    if (
      before.inventory.length !== 0 ||
      before.targetBlock !== "minecraft:oak_log" ||
      Date.parse(terminal.sample.startedAtUtc) < Date.parse(before.sample.finishedAtUtc)
    )
      return invalid;
    return {
      status: "observed",
      acquired:
        terminal.targetBlock === "minecraft:air" &&
        terminal.inventory.length === 1 &&
        terminal.inventory[0].id === "minecraft:oak_log" &&
        terminal.inventory[0].count === 1,
      gameplayQualified: false,
    };
  } catch {
    return invalid;
  }
}
