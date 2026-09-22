import assert from "node:assert/strict";
import { test } from "node:test";
import { sampleActor } from "./protected-observer.mjs";

function clocks() {
  let monotonic = 10;
  let utc = Date.parse("2026-09-19T12:00:00.000Z");
  return {
    nowMonotonic: () => monotonic++,
    nowUtc: () => new Date(utc++).toISOString(),
    setMonotonic(value) {
      monotonic = value;
    },
  };
}

function monotonicSequence(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function fixture(overrides = {}) {
  const calls = [];
  const replies = {
    Pos: "PilotProbe has the following entity data: [1.5d, 64d, -2.25d]",
    Dimension: 'PilotProbe has the following entity data: "minecraft:overworld"',
    Health: "PilotProbe has the following entity data: 20f",
    UUID: "PilotProbe has the following entity data: [I; -246738247, 1303722752, -1416835668, -1046535363]",
    Roster: "There are 1 of a max of 1 players online: PilotProbe",
    playerGameType: "PilotProbe has the following entity data: 0",
    ...overrides,
  };
  return {
    calls,
    rcon: {
      async send(command) {
        calls.push(command);
        return replies[command === "list" ? "Roster" : command.split(" ").at(-1)];
      },
    },
  };
}

test("samples only the fixed actor and query whitelist with explicit skew windows", async () => {
  const f = fixture();
  const clock = clocks();
  const result = await sampleActor({
    rcon: f.rcon,
    phase: "before",
    trialId: "trial-01",
    actionId: "walk-01",
    ...clock,
  });
  assert.equal(result.status, "sampled");
  assert.equal(result.phase, "before");
  assert.equal(result.trialId, "trial-01");
  assert.equal(result.actionId, "walk-01");
  assert.equal("success" in result, false);
  assert.equal("claimsLiveBenchmarkResult" in result, false);
  assert.deepEqual(f.calls, [
    "data get entity PilotProbe Pos",
    "data get entity PilotProbe Dimension",
    "data get entity PilotProbe Health",
    "data get entity PilotProbe UUID",
    "list",
    "data get entity PilotProbe playerGameType",
  ]);
  assert.deepEqual(result.observations, {
    position: { x: 1.5, y: 64, z: -2.25 },
    dimension: "minecraft:overworld",
    health: 20,
    uuid: "f14b12b9-4db5-3b00-ab8c-cdacc19f233d",
    roster: ["PilotProbe"],
    gameMode: 0,
  });
  assert.deepEqual(
    result.sample.queryWindows.map(({ field, outcome }) => ({ field, outcome })),
    [
      { field: "Pos", outcome: "completed" },
      { field: "Dimension", outcome: "completed" },
      { field: "Health", outcome: "completed" },
      { field: "UUID", outcome: "completed" },
      { field: "Roster", outcome: "completed" },
      { field: "playerGameType", outcome: "completed" },
    ],
  );
  for (const window of result.sample.queryWindows) {
    assert.equal(typeof window.startedAtUtc, "string");
    assert.equal(typeof window.finishedAtUtc, "string");
    assert.ok(window.durationMs >= 0);
  }
  assert.ok(result.sample.durationMs >= 0);
});

test("terminal phase and supervisor IDs are retained without participant selectors", async () => {
  const result = await sampleActor({
    rcon: fixture().rcon,
    phase: "terminal",
    trialId: "trial_A.2",
    actionId: "action-9",
    ...clocks(),
  });
  assert.equal(result.status, "sampled");
  assert.equal(result.phase, "terminal");
  assert.equal(result.actor, "PilotProbe");
  assert.equal(result.trialId, "trial_A.2");
  assert.equal(result.actionId, "action-9");
});

test("preserves completed partial observations and never exposes raw replies", async () => {
  const secret = "credential-do-not-copy";
  const f = fixture({ Dimension: `${secret}: invalid` });
  const result = await sampleActor({
    rcon: f.rcon,
    phase: "terminal",
    trialId: "trial-01",
    actionId: "walk-01",
    ...clocks(),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "invalid_response");
  assert.deepEqual(result.observations, { position: { x: 1.5, y: 64, z: -2.25 } });
  assert.equal(result.sample.queryWindows[1].outcome, "invalid");
  assert.doesNotMatch(JSON.stringify(result), /credential-do-not-copy/);
  assert.equal(f.calls.length, 2);
});

test("rejects malformed positions, dimensions, health, prefixes, and oversized responses", async () => {
  const bad = [
    { Pos: "PilotProbe has the following entity data: [NaN, 2d, 3d]" },
    { Pos: "PilotProbe has the following entity data: [30000001d, 2d, 3d]" },
    { Dimension: 'PilotProbe has the following entity data: "minecraft:custom"' },
    { Health: "PilotProbe has the following entity data: -1f" },
    { Health: "PilotProbe has the following entity data: 999999f" },
    { Health: "another actor: 20f" },
    { Pos: "x".repeat(65537) },
    { UUID: "PilotProbe has the following entity data: [I; 0, 0, 0, 0]" },
    { Roster: "There are 2 of a max of 1 players online: PilotProbe, Other" },
    { Roster: "There are 1 of a max of 1 players online: Other" },
  ];
  for (const override of bad) {
    const result = await sampleActor({
      rcon: fixture(override).rcon,
      phase: "before",
      trialId: "trial-01",
      actionId: "walk-01",
      ...clocks(),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "invalid_response");
  }
});

test("retains zero health as a sampled death observation without judging success", async () => {
  const result = await sampleActor({
    rcon: fixture({ Health: "PilotProbe has the following entity data: 0f" }).rcon,
    phase: "terminal",
    trialId: "trial-01",
    actionId: "walk-01",
    ...clocks(),
  });
  assert.equal(result.status, "sampled");
  assert.equal(result.observations.health, 0);
  assert.equal("success" in result, false);
  assert.equal("alive" in result, false);
});

test("enforces one overall deadline and marks replies completed after it as late", async () => {
  const clock = clocks();
  const f = fixture();
  let count = 0;
  f.rcon.send = async (command) => {
    f.calls.push(command);
    count += 1;
    if (count === 2) clock.setMonotonic(100);
    return fixture().rcon.send(command);
  };
  const result = await sampleActor({
    rcon: f.rcon,
    phase: "terminal",
    trialId: "trial-01",
    actionId: "walk-01",
    operationTimeoutMs: 10,
    ...clock,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "timeout");
  assert.deepEqual(Object.keys(result.observations), ["position"]);
});

test("fails at the exact query deadline and when final timestamp consumes the budget", async () => {
  const atQueryDeadline = await sampleActor({
    rcon: fixture().rcon,
    phase: "before",
    trialId: "trial-01",
    actionId: "walk-01",
    operationTimeoutMs: 10,
    nowMonotonic: monotonicSequence([0, 1, 10, 11]),
  });
  assert.equal(atQueryDeadline.status, "failed");
  assert.equal(atQueryDeadline.errorCode, "timeout");
  assert.equal(atQueryDeadline.sample.queryWindows[0].outcome, "timeout");

  const finalAtDeadline = await sampleActor({
    rcon: fixture().rcon,
    phase: "terminal",
    trialId: "trial-01",
    actionId: "walk-01",
    operationTimeoutMs: 20,
    nowMonotonic: monotonicSequence([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 20]),
  });
  assert.equal(finalAtDeadline.status, "failed");
  assert.equal(finalAtDeadline.errorCode, "timeout");
  assert.equal(finalAtDeadline.sample.durationMs, 20);
  assert.equal(
    finalAtDeadline.sample.queryWindows.every(({ outcome }) => outcome === "completed"),
    true,
  );
});

test("does not send a query whose window starts at the overall deadline", async () => {
  const f = fixture();
  const result = await sampleActor({
    rcon: f.rcon,
    phase: "before",
    trialId: "trial-01",
    actionId: "walk-01",
    operationTimeoutMs: 10,
    nowMonotonic: monotonicSequence([0, 1, 2, 10, 11]),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "timeout");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(Object.keys(result.observations), ["position"]);
  const unsent = result.sample.queryWindows[1];
  assert.equal(unsent.field, "Dimension");
  assert.equal(unsent.sent, false);
  assert.equal(unsent.outcome, "timeout");
  assert.equal(unsent.finishedMonotonicMs, unsent.startedMonotonicMs);
  assert.equal(unsent.finishedAtUtc, unsent.startedAtUtc);
  assert.equal(unsent.durationMs, 0);
});

test("timeout and late rejection do not create an unhandled rejection", async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const result = await sampleActor({
      rcon: { send: () => new Promise((_, reject) => setTimeout(() => reject(new Error("raw secret")), 20)) },
      phase: "before",
      trialId: "trial-01",
      actionId: "walk-01",
      operationTimeoutMs: 5,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "timeout");
    assert.equal(result.sample.queryWindows[0].outcome, "timeout");
    assert.doesNotMatch(JSON.stringify(result), /raw secret/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("synchronous adapter failure is generic and does not leak its message", async () => {
  const result = await sampleActor({
    rcon: {
      send() {
        throw new Error("password=should-not-leak");
      },
    },
    phase: "before",
    trialId: "trial-01",
    actionId: "walk-01",
    ...clocks(),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "query_failed");
  assert.equal(result.sample.queryWindows[0].outcome, "query_failed");
  assert.equal(typeof result.sample.queryWindows[0].finishedAtUtc, "string");
  assert.equal(typeof result.sample.queryWindows[0].finishedMonotonicMs, "number");
  assert.equal(typeof result.sample.queryWindows[0].durationMs, "number");
  assert.doesNotMatch(JSON.stringify(result), /should-not-leak/);
});

test("invalid and nonmonotonic clocks return generic structured failure", async () => {
  for (const nowMonotonic of [
    () => Number.NaN,
    (() => {
      let n = 1;
      return () => n--;
    })(),
  ]) {
    const result = await sampleActor({
      rcon: fixture().rcon,
      phase: "before",
      trialId: "trial-01",
      actionId: "walk-01",
      nowMonotonic,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "clock_invalid");
  }
  for (const invalidUtc of ["not-an-iso-time", "2026-02-31T12:00:00.000Z"]) {
    const result = await sampleActor({
      rcon: fixture().rcon,
      phase: "before",
      trialId: "trial-01",
      actionId: "walk-01",
      nowUtc: () => invalidUtc,
    });
    assert.equal(result.errorCode, "clock_invalid");
  }
});

test("rejects invalid API inputs before querying", async () => {
  const valid = { rcon: fixture().rcon, phase: "before", trialId: "trial-01", actionId: "walk-01" };
  await assert.rejects(() => sampleActor({ ...valid, phase: "other" }), /phase/);
  await assert.rejects(() => sampleActor({ ...valid, trialId: "../escape" }), /supervisor ID/);
  await assert.rejects(() => sampleActor({ ...valid, trialId: "trial\nforged" }), /supervisor ID/);
  await assert.rejects(() => sampleActor({ ...valid, trialId: "trial-forged\n" }), /supervisor ID/);
  await assert.rejects(() => sampleActor({ ...valid, actionId: "action-forged\r" }), /supervisor ID/);
  await assert.rejects(() => sampleActor({ ...valid, actionId: "action\tforged" }), /supervisor ID/);
  await assert.rejects(() => sampleActor({ ...valid, trialId: 123 }), /supervisor ID/);
  await assert.rejects(() => sampleActor({ ...valid, actionId: undefined }), /supervisor ID/);
  await assert.rejects(() => sampleActor({ ...valid, actionId: "x".repeat(65) }), /supervisor ID/);
  await assert.rejects(() => sampleActor({ ...valid, operationTimeoutMs: 5001 }), /operationTimeoutMs/);
  await assert.rejects(() => sampleActor({ ...valid, rcon: {} }), /rcon.send/);
});

 test("retains every valid game mode for independent scoring and rejects malformed modes", async () => {
  for (const mode of [0, 1, 2, 3]) {
    const result = await sampleActor({ rcon: fixture({ playerGameType: `PilotProbe has the following entity data: ${mode}` }).rcon, phase: "terminal", trialId: "trial-01", actionId: "walk-01", ...clocks() });
    assert.equal(result.status, "sampled");
    assert.equal(result.observations.gameMode, mode);
  }
  for (const mode of ["4", "-1", "0f", "00", "false", "0\n"]) {
    const result = await sampleActor({ rcon: fixture({ playerGameType: `PilotProbe has the following entity data: ${mode}` }).rcon, phase: "terminal", trialId: "trial-01", actionId: "walk-01", ...clocks() });
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "invalid_response");
  }
});
