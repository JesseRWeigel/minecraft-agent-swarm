import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { createModelActionSession } from "./model-action-session.mjs";
function bot() {
  const b = new EventEmitter();
  b.calls = [];
  const point = {
    x: 0.5,
    y: 200,
    z: 0.5,
    clone() {
      return {
        set(x, y, z) {
          return { x, y, z };
        },
      };
    },
  };
  b.entity = { position: point, yaw: 0, pitch: 0 };
  b.health = 20;
  b.inventory = { slots: [] };
  b.block = { name: "oak_log", position: { x: 0, y: 200, z: 3 } };
  b.blockAt = () => b.block;
  b.blockAtCursor = () => b.block;
  b.canDigBlock = () => true;
  b.look = async (...args) => b.calls.push(["look", ...args]);
  b.dig = async (block) => b.calls.push(["dig", block.position]);
  b.setControlState = (...args) => b.calls.push(["control", ...args]);
  b.clearControlStates = () => b.calls.push(["clear"]);
  b.stopDigging = () => b.calls.push(["stopDigging"]);
  b.end = () => b.calls.push(["end"]);
  return b;
}
const req = (sequence, action) =>
  JSON.stringify({ schema_version: 1, trial_id: "collect-oak-log-v1", action_id: "collect-01", sequence, action });
test("ordered observe look dig move finish executes only declared primitives", async () => {
  const b = bot(),
    s = createModelActionSession({ bot: b, sleep: async () => {} });
  try {
    const observation = await s.execute(req(1, { kind: "observe" }));
    assert.equal(observation.observation.source, "participant_bot");
    await s.execute(req(2, { kind: "look", yaw: 0, pitch: 0 }));
    await s.execute(req(3, { kind: "dig", x: 0, y: 200, z: 3 }));
    await s.execute(req(4, { kind: "move", direction: "forward", ticks: 5 }));
    assert.equal((await s.execute(req(5, { kind: "finish" }))).status, "finished");
    assert.equal(s.status, "finished");
    assert.equal(s.transcript.length, 5);
    assert.equal(b.calls.filter((x) => x[0] == "dig").length, 1);
    assert.deepEqual(
      b.calls.find((x) => x[0] == "control"),
      ["control", "forward", true],
    );
    assert.equal(
      b.calls.some((x) => x[0] == "end"),
      false,
    );
    await assert.rejects(s.execute(req(6, { kind: "observe" })));
  } finally {
    s.close();
  }
});
test("wrong sequence or malformed input permanently stops execution", async () => {
  for (const raw of ["bad", req(2, { kind: "observe" })]) {
    const b = bot(),
      s = createModelActionSession({ bot: b });
    await assert.rejects(s.execute(raw));
    assert.equal(s.status, "failed");
    await assert.rejects(s.execute(req(1, { kind: "move", direction: "forward", ticks: 1 })));
    assert.equal(
      b.calls.some((x) => x[0] == "control"),
      false,
    );
    assert.ok(b.calls.some((x) => x[0] == "end"));
    s.close();
  }
});
test("dig rejects unseen, undiggable, distant or stale coordinates before dig", async () => {
  for (const mutate of [
    (b) => (b.blockAtCursor = () => null),
    (b) => (b.canDigBlock = () => false),
    (b) => (b.entity.position.z = -10),
    (b) => (b.block.position.z = 4),
  ]) {
    const b = bot();
    mutate(b);
    const s = createModelActionSession({ bot: b });
    await assert.rejects(s.execute(req(1, { kind: "dig", x: 0, y: 200, z: 3 })));
    assert.equal(
      b.calls.some((x) => x[0] == "dig"),
      false,
    );
    s.close();
  }
});
test("overlapping action cancels pending work and late completion cannot resume", async () => {
  const b = bot();
  let release;
  b.dig = () => new Promise((r) => (release = r));
  const s = createModelActionSession({ bot: b });
  const pending = s.execute(req(1, { kind: "dig", x: 0, y: 200, z: 3 }));
  const rejected = assert.rejects(pending);
  await Promise.resolve();
  await Promise.resolve();
  await assert.rejects(s.execute(req(2, { kind: "move", direction: "forward", ticks: 1 })));
  await rejected;
  release?.();
  await Promise.resolve();
  assert.equal(s.status, "failed");
  assert.equal(
    b.calls.some((x) => x[0] == "control"),
    false,
  );
  s.close();
});
test("deadline and disconnect cancel a pending action", async () => {
  for (const disconnect of [false, true]) {
    const b = bot();
    b.dig = () => new Promise(() => {});
    const s = createModelActionSession({ bot: b, sessionTimeoutMs: 30 });
    const pending = s.execute(req(1, { kind: "dig", x: 0, y: 200, z: 3 }));
    const rejected = assert.rejects(pending);
    if (disconnect) b.emit("end");
    await rejected;
    if (!disconnect) assert.ok(s.transcript[0].finishedMonotonicMs - s.transcript[0].startedMonotonicMs >= 10);
    assert.equal(s.status, "failed");
    assert.ok(b.calls.some((x) => x[0] == "clear"));
    s.close();
  }
});
test("movement stops after its duration and cumulative budget cannot extend", async () => {
  const b = bot();
  let now = 0;
  const s = createModelActionSession({
    bot: b,
    nowMonotonic: () => now,
    sleep: async () => {
      now = 21000;
    },
  });
  await assert.rejects(s.execute(req(1, { kind: "move", direction: "left", ticks: 20 })));
  assert.equal(s.status, "failed");
  assert.equal(b.calls.at(-1)[0], "end");
  s.close();
});
test("request 25 must finish or exhaust the session", async () => {
  const b = bot(),
    s = createModelActionSession({ bot: b });
  for (let i = 1; i < 25; i++) await s.execute(req(i, { kind: "observe" }));
  await assert.rejects(s.execute(req(25, { kind: "observe" })));
  assert.equal(s.status, "failed");
  s.close();
});

test("dig has a six-second cap and records failure time without extending the session", async () => {
  const b = bot();
  let now = 0;
  b.dig = async () => {
    now = 6001;
  };
  const s = createModelActionSession({ bot: b, nowMonotonic: () => now });
  await assert.rejects(s.execute(req(1, { kind: "dig", x: 0, y: 200, z: 3 })));
  assert.equal(s.transcript[0].finishedMonotonicMs, 6001);
  assert.equal(s.transcript[0].status, "failed");
  s.close();
});
test("close cancels pending work and death stops the session", async () => {
  for (const event of ["close", "death"]) {
    const b = bot();
    let release;
    b.dig = () => new Promise((r) => (release = r));
    const s = createModelActionSession({ bot: b });
    const pending = s.execute(req(1, { kind: "dig", x: 0, y: 200, z: 3 }));
    const rejected = assert.rejects(pending);
    await Promise.resolve();
    await Promise.resolve();
    const started = Date.now();
    if (event === "close") s.close();
    else b.emit("death");
    await rejected;
    assert.ok(Date.now() - started < 250, "cancellation must not wait for action deadline");
    release?.();
    await Promise.resolve();
    assert.equal(s.status, event === "close" ? "closed" : "failed");
    assert.equal(
      b.calls.some((x) => x[0] == "control"),
      false,
    );
    s.close();
  }
});
