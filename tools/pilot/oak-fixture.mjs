import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { OAK_TASK_SHA256 } from "./oak-task.mjs";

import { FIXTURE_SHA256, setupMovementFixture } from "./movement-fixture.mjs";

const ACTOR = "PilotProbe";
const MAX_RESPONSE_BYTES = 65_536;
const MAX_OPERATION_TIMEOUT_MS = 15_000;

export const OAK_FIXTURE_COMMANDS = Object.freeze(
  [
    {
      name: "build_bedrock_floor",
      command: "execute in minecraft:overworld run fill -4 199 -4 4 199 12 minecraft:bedrock",
    },
    {
      name: "build_west_wall",
      command: "execute in minecraft:overworld run fill -4 200 -4 -4 204 12 minecraft:bedrock",
    },
    {
      name: "build_east_wall",
      command: "execute in minecraft:overworld run fill 4 200 -4 4 204 12 minecraft:bedrock",
    },
    {
      name: "build_north_wall",
      command: "execute in minecraft:overworld run fill -4 200 -4 4 204 -4 minecraft:bedrock",
    },
    {
      name: "build_south_wall",
      command: "execute in minecraft:overworld run fill -4 200 12 4 204 12 minecraft:bedrock",
    },
    {
      name: "build_bedrock_roof",
      command: "execute in minecraft:overworld run fill -4 204 -4 4 204 12 minecraft:bedrock",
    },
    { name: "place_oak_log", command: "execute in minecraft:overworld run setblock 0 200 3 minecraft:oak_log" },
  ].map(Object.freeze),
);

export const OAK_FIXTURE_BLOCK_CHECKS = Object.freeze(
  [
    { name: "floor", command: "execute in minecraft:overworld if block -4 199 -4 minecraft:bedrock" },
    { name: "west_wall", command: "execute in minecraft:overworld if block -4 200 -4 minecraft:bedrock" },
    { name: "east_wall", command: "execute in minecraft:overworld if block 4 200 12 minecraft:bedrock" },
    { name: "north_wall", command: "execute in minecraft:overworld if block 4 200 -4 minecraft:bedrock" },
    { name: "south_wall", command: "execute in minecraft:overworld if block 4 200 12 minecraft:bedrock" },
    { name: "roof", command: "execute in minecraft:overworld if block 4 204 12 minecraft:bedrock" },
    { name: "oak_log", command: "execute in minecraft:overworld if block 0 200 3 minecraft:oak_log" },
  ].map(Object.freeze),
);

const FIXTURE_CONTENT = Object.freeze({
  schemaVersion: 1,
  actor: ACTOR,
  parentFixtureSha256: FIXTURE_SHA256,
  commands: OAK_FIXTURE_COMMANDS,
  blockChecks: OAK_FIXTURE_BLOCK_CHECKS,
});

export const OAK_FIXTURE_SHA256 = createHash("sha256").update(JSON.stringify(FIXTURE_CONTENT), "utf8").digest("hex");

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

function bounded(operation, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new FixtureFailure("timeout")), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => clearTimeout(timer));
}

function publicFixture() {
  return {
    schemaVersion: FIXTURE_CONTENT.schemaVersion,
    actor: FIXTURE_CONTENT.actor,
    parentFixtureSha256: FIXTURE_CONTENT.parentFixtureSha256,
    commands: OAK_FIXTURE_COMMANDS.map((entry) => ({ ...entry })),
    blockChecks: OAK_FIXTURE_BLOCK_CHECKS.map((entry) => ({ ...entry })),
    sha256: OAK_FIXTURE_SHA256,
  };
}

function checkedClock(nowMonotonic, previous) {
  const value = nowMonotonic();
  if (typeof value !== "number" || !Number.isFinite(value) || (previous !== null && value < previous))
    throw new FixtureFailure("clock_invalid");
  return value;
}

function commandReceipt(entry, startedMonotonicMs) {
  return {
    name: entry.name,
    outcome: "pending",
    startedMonotonicMs,
    finishedMonotonicMs: null,
    durationMs: null,
    responseType: null,
    responseBytes: null,
  };
}

function validateCommandReply(reply) {
  if (typeof reply !== "string" || reply.length === 0 || Buffer.byteLength(reply, "utf8") > MAX_RESPONSE_BYTES)
    throw new FixtureFailure("invalid_response");
  if (
    /(?:unknown or incomplete command|incorrect argument|no entity was found|cannot find|exception|permission|not allowed|failed)/i.test(
      reply,
    )
  )
    throw new FixtureFailure("command_failed");
}

function validateBlockReply(reply) {
  if (reply === "Test passed") return;
  if (reply === "Test failed") throw new FixtureFailure("block_mismatch");
  throw new FixtureFailure("invalid_response");
}

export async function setupOakFixture({
  rcon,
  nowMonotonic = performance.now.bind(performance),
  operationTimeoutMs = MAX_OPERATION_TIMEOUT_MS,
} = {}) {
  validateOptions({ rcon, nowMonotonic, operationTimeoutMs });
  const result = {
    schemaVersion: 1,
    status: "failed",
    fixture: publicFixture(),
    parentSetup: null,
    commandReceipts: [],
    blockChecks: [],
    durationMs: null,
  };
  let previous = null;
  let started;
  let deadline;
  const clock = () => (previous = checkedClock(nowMonotonic, previous));
  const remaining = () => {
    const available = deadline - clock();
    if (available <= 0) throw new FixtureFailure("timeout");
    return available;
  };
  const finishReceipt = (receipt, startedAt) => {
    const finished = clock();
    receipt.finishedMonotonicMs = finished;
    receipt.durationMs = finished - startedAt;
    return finished;
  };

  try {
    started = clock();
    deadline = started + operationTimeoutMs;
    result.parentSetup = await bounded(
      () => setupMovementFixture({ rcon, operationTimeoutMs: Math.floor(remaining()) }),
      remaining(),
    );
    if (result.parentSetup?.status !== "configured")
      throw new FixtureFailure(result.parentSetup?.errorCode ?? "parent_fixture_failed");

    for (const entry of OAK_FIXTURE_COMMANDS) {
      const startedAt = clock();
      const receipt = commandReceipt(entry, startedAt);
      result.commandReceipts.push(receipt);
      try {
        const reply = await bounded(() => rcon.send(entry.command), remaining());
        receipt.responseType = typeof reply;
        receipt.responseBytes = typeof reply === "string" ? Buffer.byteLength(reply, "utf8") : null;
        validateCommandReply(reply);
        receipt.outcome = "issued";
      } catch (error) {
        receipt.outcome = error instanceof FixtureFailure ? error.code : "command_failed";
        throw error;
      } finally {
        finishReceipt(receipt, startedAt);
      }
      if (clock() >= deadline) throw new FixtureFailure("timeout");
    }

    for (const entry of OAK_FIXTURE_BLOCK_CHECKS) {
      const startedAt = clock();
      const check = {
        name: entry.name,
        status: "pending",
        startedMonotonicMs: startedAt,
        finishedMonotonicMs: null,
        durationMs: null,
      };
      result.blockChecks.push(check);
      try {
        const reply = await bounded(() => rcon.send(entry.command), remaining());
        validateBlockReply(reply);
        check.status = "verified";
      } catch (error) {
        check.status = error instanceof FixtureFailure && error.code === "timeout" ? "timeout" : "failed";
        throw error;
      } finally {
        finishReceipt(check, startedAt);
      }
      if (clock() >= deadline) throw new FixtureFailure("timeout");
    }
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

export function verifyOakFixtureSample(sample) {
  try {
    const observations = sample?.actorSample?.observations;
    if (
      !sample ||
      sample.schemaVersion !== 1 ||
      sample.taskId !== "collect-oak-log-v1" ||
      sample.taskSha256 !== OAK_TASK_SHA256 ||
      sample.trialId !== "collect-oak-log-v1" ||
      sample.actionId !== "collect-01" ||
      sample.actorSample?.phase !== "before" ||
      sample.actorSample?.trialId !== sample.trialId ||
      sample.actorSample?.actionId !== sample.actionId ||
      sample.status !== "sampled" ||
      sample.source !== "server_rcon" ||
      sample.phase !== "before" ||
      !Array.isArray(sample.inventory) ||
      sample.inventory.length !== 0 ||
      sample.targetBlock !== "minecraft:oak_log" ||
      sample.actorSample?.status !== "sampled" ||
      sample.actorSample?.source !== "server_rcon" ||
      sample.actorSample?.actor !== ACTOR ||
      !observations ||
      observations.uuid !== "f14b12b9-4db5-3b00-ab8c-cdacc19f233d" ||
      JSON.stringify(observations.roster) !== JSON.stringify([ACTOR]) ||
      observations.dimension !== "minecraft:overworld" ||
      observations.gameMode !== 0 ||
      observations.health !== 20 ||
      observations.position?.x !== 0.5 ||
      observations.position?.y !== 200 ||
      observations.position?.z !== 0.5
    )
      return { status: "failed", errorCode: "baseline_mismatch" };
    return { status: "verified" };
  } catch {
    return { status: "failed", errorCode: "invalid_sample" };
  }
}
