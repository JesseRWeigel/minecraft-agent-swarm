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
test("expected dig rejections preserve session and dispatch no dig", async () => {
  for (const [mutate, code] of [
    [(b) => (b.blockAt = () => null), "target_missing"],
    [(b) => (b.block.name = "air"), "target_missing"],
    [(b) => (b.blockAtCursor = () => null), "target_not_visible"],
    [(b) => (b.canDigBlock = () => false), "target_not_diggable"],
    [(b) => (b.entity.position.z = -10), "target_out_of_reach"],
    [(b) => (b.block.position.z = 4), "target_missing"],
  ]) {
    const b = bot();
    mutate(b);
    const s = createModelActionSession({ bot: b });
    try {
      assert.deepEqual(await s.execute(req(1, { kind: "dig", x: 0, y: 200, z: 3 })), {
        schema_version: 1,
        sequence: 1,
        status: "rejected",
        error: { code, recoverable: true },
      });
      assert.equal(s.status, "active");
      assert.equal(s.transcript[0].status, "rejected");
      assert.equal(
        b.calls.some((x) => x[0] === "dig" || x[0] === "end"),
        false,
      );
      assert.equal((await s.execute(req(2, { kind: "finish" }))).status, "finished");
    } finally {
      s.close();
    }
  }
});
test("unexpected dig exceptions and malformed coordinates remain fatal", async () => {
  for (const mutate of [
    (b) => {
      b.blockAt = () => {
        throw new Error("unexpected");
      };
    },
    (b) => {
      b.dig = async () => {
        throw new Error("unexpected");
      };
    },
    (b) => {
      b.canDigBlock = () => undefined;
    },
  ]) {
    const b = bot();
    mutate(b);
    const s = createModelActionSession({ bot: b });
    await assert.rejects(s.execute(req(1, { kind: "dig", x: 0, y: 200, z: 3 })));
    assert.equal(s.status, "failed");
    s.close();
  }
  const b = bot(),
    s = createModelActionSession({ bot: b });
  await assert.rejects(s.execute(req(1, { kind: "dig", x: 0, y: 500, z: 3 })));
  assert.equal(s.status, "failed");
  assert.equal(
    b.calls.some((x) => x[0] === "dig"),
    false,
  );
  s.close();
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

test("cancelled movement does not touch bot when its sleep resolves later", async () => {
  const b = bot();
  let release;
  const s = createModelActionSession({ bot: b, sleep: () => new Promise((r) => (release = r)) });
  const pending = s.execute(req(1, { kind: "move", direction: "forward", ticks: 1 }));
  const rejected = assert.rejects(pending);
  await new Promise((r) => setImmediate(r));
  s.close();
  await rejected;
  const count = b.calls.length;
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(b.calls.length, count);
});
test("finished session may relinquish shutdown to the trusted lifecycle owner", async () => {
  const b = bot(),
    s = createModelActionSession({ bot: b });
  await s.execute(req(1, { kind: "finish" }));
  s.close({ disconnect: false });
  b.emit("end");
  assert.equal(s.status, "closed");
  assert.equal(
    b.calls.some((x) => x[0] === "end"),
    false,
  );
  const c = bot(),
    active = createModelActionSession({ bot: c });
  assert.throws(() => active.close({ disconnect: false }));
  active.close();
});

test("look_at faces arbitrary block centers from current standing eyes only", async () => {
  for (const [x, y, z] of [
    [0, 200, 3],
    [4, 202, 0],
    [-3, 197, 2],
    [0, 205, 0],
  ]) {
    const b = bot(),
      s = createModelActionSession({ bot: b });
    try {
      await s.execute(req(1, { kind: "look_at", x, y, z }));
      const calls = b.calls.filter((c) => c[0] === "look");
      assert.equal(calls.length, 1);
      const [, yaw, pitch, force] = calls[0];
      const dx = x,
        dy = y + 0.5 - 201.62,
        dz = z;
      assert.ok(Math.abs(yaw - Math.atan2(-dx, -dz)) < 1e-12);
      assert.ok(Math.abs(pitch - Math.atan2(dy, Math.hypot(dx, dz))) < 1e-12);
      assert.equal(force, true);
      assert.equal(
        b.calls.some((c) => c[0] === "dig" || c[0] === "control"),
        false,
      );
      assert.deepEqual(
        { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z },
        { x: 0.5, y: 200, z: 0.5 },
      );
    } finally {
      s.close();
    }
  }
});
test("look_at rejects invalid bot position without issuing look", async () => {
  const b = bot();
  b.entity.position.x = NaN;
  const s = createModelActionSession({ bot: b });
  try {
    await assert.rejects(s.execute(req(1, { kind: "look_at", x: 1, y: 200, z: 2 })));
    assert.equal(
      b.calls.some((c) => c[0] === "look"),
      false,
    );
  } finally {
    s.close();
  }
});

function navigationBot() {
  const b = bot();
  b.entity.onGround = true;
  b.entity.velocity = { x: 0, y: 0, z: 0 };
  b.blockAt = (p) =>
    p.y === 199
      ? { name: "stone", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]] }
      : { name: "air", boundingBox: "empty" };
  b.look = async (yaw, pitch, force) => {
    b.calls.push(["look", yaw, pitch, force]);
    b.entity.yaw = yaw;
  };
  return b;
}
const moveTo = (x, z, ticks = 20, y = 200) => ({ kind: "move_to", x, y, z, ticks });
test("move_to arrives by bounded ground steering without jump dig or place", async () => {
  const b = navigationBot();
  let sleeps = 0;
  const s = createModelActionSession({
    bot: b,
    sleep: async (ms) => {
      assert.equal(ms, 50);
      sleeps++;
      b.entity.position.x -= Math.sin(b.entity.yaw) * 0.2;
      b.entity.position.z -= Math.cos(b.entity.yaw) * 0.2;
    },
  });
  try {
    assert.equal((await s.execute(req(1, moveTo(1.5, 1.5)))).status, "completed");
    assert.ok(Math.hypot(b.entity.position.x - 1.5, b.entity.position.z - 1.5) <= 0.3);
    assert.ok(sleeps <= 20);
    assert.ok(b.calls.filter((c) => c[0] === "control").every((c) => c[1] === "forward"));
    assert.equal(
      b.calls.some((c) => c[0] === "dig"),
      false,
    );
    assert.equal(b.calls.at(-1)[0], "clear");
  } finally {
    s.close();
  }
});
test("move_to rejects out of local range or height without moving", async () => {
  for (const action of [moveTo(5, 0), moveTo(1, 1, 20, 201)]) {
    const b = navigationBot(),
      s = createModelActionSession({ bot: b });
    try {
      const result = await s.execute(req(1, action));
      assert.equal(result.error.code, "navigation_out_of_range");
      assert.equal(
        b.calls.some((c) => c[0] === "control"),
        false,
      );
      assert.equal(s.status, "active");
    } finally {
      s.close();
    }
  }
});
test("move_to blocks walls gaps hazards and side footprint cliffs before movement", async () => {
  for (const obstacle of ["wall", "gap", "lava", "slab", "side"]) {
    const b = navigationBot(),
      original = b.blockAt;
    b.blockAt = (p) => {
      if (obstacle === "wall" && p.y === 201) return { name: "stone", boundingBox: "block" };
      if (obstacle === "gap" && p.y === 199) return null;
      if (obstacle === "lava" && p.y === 200) return { name: "lava", boundingBox: "empty" };
      if (obstacle === "slab" && p.y === 199)
        return { name: "stone_slab", boundingBox: "block", shapes: [[0, 0, 0, 1, 0.5, 1]] };
      if (obstacle === "side" && p.x === -1) return null;
      return original(p);
    };
    const s = createModelActionSession({ bot: b });
    try {
      const result = await s.execute(req(1, moveTo(obstacle === "side" ? 0.1 : 1.5, 0.5)));
      assert.equal(result.error.code, "navigation_blocked", obstacle);
      assert.equal(
        b.calls.some((c) => c[0] === "control"),
        false,
      );
    } finally {
      s.close();
    }
  }
});
test("move_to no-progress and tick-cap produce bounded recoverable replies", async () => {
  for (const [ticks, code, count] of [
    [20, "no_progress", 4],
    [2, "not_arrived", 2],
  ]) {
    const b = navigationBot();
    let calls = 0;
    const s = createModelActionSession({
      bot: b,
      sleep: async () => {
        calls++;
      },
    });
    try {
      const result = await s.execute(req(1, moveTo(1.5, 0.5, ticks)));
      assert.equal(result.error.code, code);
      assert.equal(calls, count);
      assert.equal(b.calls.at(-1)[0], "clear");
    } finally {
      s.close();
    }
  }
});
test("move_to cancellation stops controls and late sleep cannot resume", async () => {
  const b = navigationBot();
  let resolveSleep;
  const s = createModelActionSession({ bot: b, sleep: () => new Promise((r) => (resolveSleep = r)) });
  const pending = s.execute(req(1, moveTo(1.5, 0.5)));
  await new Promise((r) => setImmediate(r));
  s.close();
  await assert.rejects(pending);
  const count = b.calls.length;
  resolveSleep();
  await new Promise((r) => setImmediate(r));
  assert.equal(b.calls.length, count);
  assert.ok(b.calls.some((c) => c[0] === "clear"));
});
test("move_to unexpected vertical displacement remains fatal", async () => {
  const b = navigationBot();
  const s = createModelActionSession({
    bot: b,
    sleep: async () => {
      b.entity.position.y = 190;
    },
  });
  try {
    await assert.rejects(s.execute(req(1, moveTo(1.5, 0.5, 1))));
    assert.equal(s.status, "failed");
  } finally {
    s.close();
  }
});

test("move_to refuses slippery or slowing floors and excessive momentum", async () => {
  for (const floor of ["ice", "packed_ice", "blue_ice", "slime_block", "honey_block", "soul_sand", "soul_soil"]) {
    const b = navigationBot(),
      original = b.blockAt;
    b.blockAt = (p) =>
      p.y === 199 ? { name: floor, boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]] } : original(p);
    const s = createModelActionSession({ bot: b });
    try {
      assert.equal((await s.execute(req(1, moveTo(1.5, 0.5)))).error.code, "navigation_blocked");
      assert.equal(
        b.calls.some((c) => c[0] === "control"),
        false,
      );
    } finally {
      s.close();
    }
  }
  for (const mutate of [
    (b) => {
      b.entity.onGround = false;
    },
    (b) => {
      b.entity.velocity.x = 0.5;
    },
    (b) => {
      delete b.entity.velocity;
    },
  ]) {
    const b = navigationBot();
    mutate(b);
    const s = createModelActionSession({ bot: b });
    try {
      assert.equal((await s.execute(req(1, moveTo(1.5, 0.5)))).error.code, "navigation_blocked");
      assert.equal(
        b.calls.some((c) => c[0] === "control"),
        false,
      );
    } finally {
      s.close();
    }
  }
});

test("move_to final tick cannot report arrival after footing disappears", async () => {
  for (const change of ["airborne", "missing_ground"]) {
    const b = navigationBot();
    const original = b.blockAt;
    const s = createModelActionSession({
      bot: b,
      sleep: async () => {
        b.entity.position.x = 1.3;
        if (change === "airborne") b.entity.onGround = false;
        else b.blockAt = (p) => (p.y === 199 ? null : original(p));
      },
    });
    try {
      const result = await s.execute(req(1, moveTo(1.5, 0.5, 1)));
      assert.equal(result.status, "rejected", change);
      assert.equal(result.error.code, "navigation_blocked", change);
      assert.equal(s.status, "active");
      assert.equal(b.calls.at(-1)[0], "clear");
    } finally {
      s.close();
    }
  }
});
