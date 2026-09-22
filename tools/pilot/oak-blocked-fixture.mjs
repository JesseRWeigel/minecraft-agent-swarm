import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { OAK_FIXTURE_SHA256, setupOakFixture } from "./oak-fixture.mjs";

const MAX_RESPONSE_BYTES = 65_536;
const MAX_OPERATION_TIMEOUT_MS = 15_000;

export const OAK_BLOCKED_FIXTURE_COMMANDS = Object.freeze(
  [
    { name: "north", command: "execute in minecraft:overworld run setblock 0 200 2 minecraft:bedrock" },
    { name: "south", command: "execute in minecraft:overworld run setblock 0 200 4 minecraft:bedrock" },
    { name: "west", command: "execute in minecraft:overworld run setblock -1 200 3 minecraft:bedrock" },
    { name: "east", command: "execute in minecraft:overworld run setblock 1 200 3 minecraft:bedrock" },
    { name: "above", command: "execute in minecraft:overworld run setblock 0 201 3 minecraft:bedrock" },
  ].map(Object.freeze),
);

export const OAK_BLOCKED_FIXTURE_BLOCK_CHECKS = Object.freeze(
  [
    { name: "north", command: "execute in minecraft:overworld if block 0 200 2 minecraft:bedrock" },
    { name: "south", command: "execute in minecraft:overworld if block 0 200 4 minecraft:bedrock" },
    { name: "west", command: "execute in minecraft:overworld if block -1 200 3 minecraft:bedrock" },
    { name: "east", command: "execute in minecraft:overworld if block 1 200 3 minecraft:bedrock" },
    { name: "above", command: "execute in minecraft:overworld if block 0 201 3 minecraft:bedrock" },
    { name: "floor", command: "execute in minecraft:overworld if block 0 199 3 minecraft:bedrock" },
  ].map(Object.freeze),
);

const FIXTURE_CONTENT = Object.freeze({
  schemaVersion: 1,
  parentFixtureSha256: OAK_FIXTURE_SHA256,
  commands: OAK_BLOCKED_FIXTURE_COMMANDS,
  blockChecks: OAK_BLOCKED_FIXTURE_BLOCK_CHECKS,
});

export const OAK_BLOCKED_FIXTURE_SHA256 = createHash("sha256")
  .update(JSON.stringify(FIXTURE_CONTENT), "utf8")
  .digest("hex");

class FixtureFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function bounded(operation, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new FixtureFailure("timeout")), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => clearTimeout(timer));
}

function validateOptions({ rcon, nowMonotonic, operationTimeoutMs }) {
  if (!rcon || typeof rcon.send !== "function") throw new TypeError("rcon.send is required");
  if (typeof nowMonotonic !== "function") throw new TypeError("nowMonotonic is required");
  if (!Number.isInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > MAX_OPERATION_TIMEOUT_MS)
    throw new RangeError("invalid operationTimeoutMs");
}

function publicFixture() {
  return {
    schemaVersion: FIXTURE_CONTENT.schemaVersion,
    parentFixtureSha256: FIXTURE_CONTENT.parentFixtureSha256,
    commands: OAK_BLOCKED_FIXTURE_COMMANDS.map((entry) => ({ ...entry })),
    blockChecks: OAK_BLOCKED_FIXTURE_BLOCK_CHECKS.map((entry) => ({ ...entry })),
    sha256: OAK_BLOCKED_FIXTURE_SHA256,
  };
}

function validateCommandReply(reply) {
  if (typeof reply !== "string" || reply.length === 0 || Buffer.byteLength(reply, "utf8") > MAX_RESPONSE_BYTES)
    throw new FixtureFailure("invalid_response");
  if (/(?:unknown or incomplete command|incorrect argument|no entity was found|cannot find|exception|permission|not allowed|failed)/i.test(reply))
    throw new FixtureFailure("command_failed");
}

function validateBlockReply(reply) {
  if (reply === "Test passed") return;
  if (reply === "Test failed") throw new FixtureFailure("block_mismatch");
  throw new FixtureFailure("invalid_response");
}

export async function setupOakBlockedFixture({
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
  const clock = () => {
    const value = nowMonotonic();
    if (typeof value !== "number" || !Number.isFinite(value) || (previous !== null && value < previous))
      throw new FixtureFailure("clock_invalid");
    previous = value;
    return value;
  };
  const remaining = () => {
    const value = deadline - clock();
    if (value <= 0) throw new FixtureFailure("timeout");
    return value;
  };
  const finish = (record, startedAt) => {
    const finished = clock();
    record.finishedMonotonicMs = finished;
    record.durationMs = finished - startedAt;
  };

  try {
    started = clock();
    deadline = started + operationTimeoutMs;
    result.parentSetup = await bounded(
      () => setupOakFixture({ rcon, operationTimeoutMs: Math.floor(remaining()) }),
      remaining(),
    );
    if (result.parentSetup?.status !== "configured")
      throw new FixtureFailure(result.parentSetup?.errorCode ?? "parent_fixture_failed");

    for (const entry of OAK_BLOCKED_FIXTURE_COMMANDS) {
      const startedAt = clock();
      const receipt = {
        name: entry.name,
        outcome: "pending",
        startedMonotonicMs: startedAt,
        finishedMonotonicMs: null,
        durationMs: null,
        responseType: null,
        responseBytes: null,
      };
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
        finish(receipt, startedAt);
      }
    }

    for (const entry of OAK_BLOCKED_FIXTURE_BLOCK_CHECKS) {
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
        validateBlockReply(await bounded(() => rcon.send(entry.command), remaining()));
        check.status = "verified";
      } catch (error) {
        check.status = error instanceof FixtureFailure && error.code === "timeout" ? "timeout" : "failed";
        throw error;
      } finally {
        finish(check, startedAt);
      }
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
