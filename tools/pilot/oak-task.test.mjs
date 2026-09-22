import assert from "node:assert/strict";
import { test } from "node:test";
import { sampleOakTask, scoreOakTask, OAK_QUERIES } from "./oak-task.mjs";
const prefix = "PilotProbe has the following entity data: ";
function adapter({ inventory = "[]", log = true, air = false, override = {} } = {}) {
  const replies = {
    "data get entity PilotProbe Pos": prefix + "[0.5d, 200d, 0.5d]",
    "data get entity PilotProbe Dimension": prefix + '"minecraft:overworld"',
    "data get entity PilotProbe Health": prefix + "20f",
    "data get entity PilotProbe UUID": prefix + "[I; -246738247, 1303722752, -1416835668, -1046535363]",
    list: "There are 1 of a max of 1 players online: PilotProbe",
    "data get entity PilotProbe playerGameType": prefix + "0",
    [OAK_QUERIES.inventory]: prefix + inventory,
    [OAK_QUERIES.log]: log ? "Test passed" : "Test failed",
    [OAK_QUERIES.air]: air ? "Test passed" : "Test failed",
    ...override,
  };
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      const v = replies[command];
      return typeof v === "function" ? v() : v;
    },
  };
}
async function pair() {
  const before = await sampleOakTask({ rcon: adapter(), phase: "before", trialId: "trial-01", actionId: "collect-01" });
  const terminal = await sampleOakTask({
    rcon: adapter({ inventory: '[{Slot: 0b, count: 1, id: "minecraft:oak_log"}]', log: false, air: true }),
    phase: "terminal",
    trialId: "trial-01",
    actionId: "collect-01",
  });
  return { before, terminal, trialId: "trial-01", actionId: "collect-01" };
}
test("fixed queries and valid collected log yield only a task predicate", async () => {
  const p = await pair();
  assert.equal(p.before.status, "sampled");
  assert.equal(p.terminal.status, "sampled");
  const score = scoreOakTask(p);
  assert.equal(score.status, "observed");
  assert.equal(score.acquired, true);
  assert.equal(score.gameplayQualified, false);
  const r = adapter();
  await sampleOakTask({ rcon: r, phase: "before", trialId: "trial-01", actionId: "collect-01" });
  assert.deepEqual(r.calls.slice(-3), Object.values(OAK_QUERIES));
  assert.equal(r.calls.length, 9);
});
test("stationary and broken but uncollected log are observed failures", async () => {
  for (const variant of [{}, { log: false, air: true }]) {
    const p = await pair();
    p.terminal = await sampleOakTask({
      rcon: adapter(variant),
      phase: "terminal",
      trialId: p.trialId,
      actionId: p.actionId,
    });
    assert.deepEqual(scoreOakTask(p), { status: "observed", acquired: false, gameplayQualified: false });
  }
});
test("bad starts, forged parsed state and mismatched provenance fail closed", async () => {
  const p = await pair();
  for (const mutate of [
    (x) => x.before.inventory.push({ slot: 0, id: "minecraft:oak_log", count: 1 }),
    (x) => (x.terminal.inventory[0].count = 2),
    (x) => (x.terminal.taskSha256 = "0".repeat(64)),
    (x) => (x.terminal.actionId = "different"),
    (x) => (x.terminal.actorSample.observations.gameMode = 1),
    (x) => (x.terminal.actorSample.observations.health = 0),
    (x) => x.terminal.actorSample.observations.roster.push("Other"),
    (x) => (x.terminal.actorSample.observations.uuid = "other"),
    (x) => (x.terminal.actorSample.observations.position.y = NaN),
    (x) => (x.terminal.queries[1].reply = "Test passed"),
    (x) => x.terminal.queries.pop(),
    (x) => (x.terminal.actorSample.sample.queryWindows[0].outcome = "timeout"),
    (x) => (x.terminal.sample.finishedMonotonicMs = x.terminal.sample.startedMonotonicMs - 1),
    (x) => (x.terminal.status = "failed"),
    (x) => (x.terminal = null),
  ]) {
    const copy = structuredClone(p);
    mutate(copy);
    assert.equal(scoreOakTask(copy).status, "invalid");
  }
  p.terminal.success = true;
  p.terminal.score = { acquired: true };
  p.terminal.inventory = [];
  assert.equal(scoreOakTask(p).status, "invalid");
});
test("target timeout retains inventory and earlier actor sample without success", async () => {
  const r = adapter({ override: { [OAK_QUERIES.log]: () => new Promise(() => {}) } });
  const d = await sampleOakTask({
    rcon: r,
    phase: "terminal",
    trialId: "trial-01",
    actionId: "collect-01",
    operationTimeoutMs: 40,
  });
  assert.equal(d.status, "failed");
  assert.equal(d.errorCode, "timeout");
  assert.deepEqual(d.inventory, []);
  assert.equal(d.actorSample.status, "sampled");
  assert.equal(d.queries.length, 2);
});
test("unknown block replies, contradictory tests and malformed inventory cannot sample", async () => {
  for (const override of [
    { [OAK_QUERIES.log]: "unknown" },
    { [OAK_QUERIES.air]: "Test passed" },
    { [OAK_QUERIES.inventory]: prefix + '[{Slot: 0b, count: -1, id: "minecraft:oak_log"}]' },
  ]) {
    const d = await sampleOakTask({
      rcon: adapter({ override }),
      phase: "before",
      trialId: "trial-01",
      actionId: "collect-01",
    });
    assert.equal(d.status, "failed");
  }
});
test("invalid identifiers, phases and deadlines issue no queries", async () => {
  for (const change of [
    { phase: "during" },
    { trialId: "bad\n" },
    { operationTimeoutMs: Infinity },
    { operationTimeoutMs: 0 },
  ]) {
    const r = adapter();
    await assert.rejects(
      sampleOakTask({ rcon: r, phase: "before", trialId: "trial-01", actionId: "collect-01", ...change }),
    );
    assert.equal(r.calls.length, 0);
  }
});

test("item alone, extra items and wrong item counts cannot establish acquisition", async () => {
  for (const variant of [
    { inventory: '[{Slot:0b,count:1,id:"minecraft:oak_log"}]' },
    { inventory: '[{Slot:0b,count:2,id:"minecraft:oak_log"}]', log: false, air: true },
    { inventory: '[{Slot:0b,count:1,id:"minecraft:oak_planks"}]', log: false, air: true },
    {
      inventory: '[{Slot:0b,count:1,id:"minecraft:oak_log"},{Slot:1b,count:1,id:"minecraft:dirt"}]',
      log: false,
      air: true,
    },
  ]) {
    const p = await pair();
    p.terminal = await sampleOakTask({
      rcon: adapter(variant),
      phase: "terminal",
      trialId: p.trialId,
      actionId: p.actionId,
    });
    assert.equal(scoreOakTask(p).acquired, false);
  }
});
test("realistic bad baseline replies and actor errors never become negative controls", async () => {
  for (const variant of [
    { log: false, air: true },
    { inventory: '[{Slot:0b,count:1,id:"minecraft:dirt"}]' },
    { override: { list: "There are 0 of a max of 1 players online: " } },
  ]) {
    const p = await pair();
    p.before = await sampleOakTask({
      rcon: adapter(variant),
      phase: "before",
      trialId: p.trialId,
      actionId: p.actionId,
    });
    assert.equal(scoreOakTask(p).status, "invalid");
  }
});
test("backwards clocks and expired overall budget reject samples", async () => {
  for (const change of [{ nowMonotonic: () => NaN }, { nowUtc: () => "not a UTC timestamp" }]) {
    const r = adapter();
    const d = await sampleOakTask({ rcon: r, phase: "before", trialId: "trial-01", actionId: "collect-01", ...change });
    assert.equal(d.status, "failed");
    assert.equal(d.errorCode, "clock_invalid");
    assert.equal(r.calls.length, 0);
  }
  const r = adapter();
  let n = 0;
  const d = await sampleOakTask({
    rcon: r,
    phase: "before",
    trialId: "trial-01",
    actionId: "collect-01",
    operationTimeoutMs: 20,
    nowMonotonic: () => (n += 10),
  });
  assert.equal(d.status, "failed");
  assert.equal(d.errorCode, "timeout");
});

test("malformed scorer input cannot throw or produce an observed outcome", () => {
  for (const input of [undefined, null, {}, [], 42, "success", { before: null, terminal: null }])
    assert.deepEqual(scoreOakTask(input), { status: "invalid", acquired: null, gameplayQualified: false });
});

test("time spent preparing a sample reduces the actor-stage budget", async () => {
  const r = adapter();
  let elapsed = 0;
  const result = await sampleOakTask({
    rcon: r,
    phase: "before",
    trialId: "trial-01",
    actionId: "collect-01",
    operationTimeoutMs: 20,
    nowMonotonic: () => elapsed,
    nowUtc: () => {
      elapsed += 10;
      return new Date(Date.parse("2026-09-22T00:00:00.000Z") + elapsed).toISOString();
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "timeout");
  assert.equal(r.calls.length, 0);
});
