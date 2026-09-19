import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runQualification, writePrivateEvidence } from "./qualification-client.mjs";
function fixture({ move = true, health = 20, dimension = "minecraft:overworld", bad = false } = {}) {
  const calls = [],
    controls = [],
    bot = new EventEmitter();
  bot.entity = { position: { x: 0, y: 64, z: 0 } };
  bot.health = 20;
  bot.game = { dimension };
  bot.waitForTicks = async (ticks) => assert.equal(ticks, 1);
  bot.setControlState = (k, v) => controls.push([k, v]);
  bot.quit = async () => {
    bot.closed = true;
  };
  const reply = (field) =>
    bad
      ? "I moved successfully"
      : field === "Pos"
        ? `PilotProbe has the following entity data: [${bot.entity.position.x}d, ${bot.entity.position.y}d, ${bot.entity.position.z}d]`
        : field === "Dimension"
          ? `PilotProbe has the following entity data: "${dimension}"`
          : `PilotProbe has the following entity data: ${health}f`;
  const rcon = {
    send: async (command) => {
      calls.push(command);
      return reply(command.split(" ").at(-1));
    },
    end: async () => {
      rcon.closed = true;
    },
  };
  let evidence;
  return {
    calls,
    controls,
    bot,
    rcon,
    get evidence() {
      return evidence;
    },
    args: {
      createBot: async (options) => {
        assert.deepEqual(options, {
          host: "127.0.0.1",
          port: 25585,
          username: "PilotProbe",
          auth: "offline",
          version: "1.21.4",
        });
        return bot;
      },
      connectRcon: async (options) => {
        assert.deepEqual(options, { host: "127.0.0.1", port: 25595 });
        return rcon;
      },
      sleep: async (ms) => {
        if (ms === 1000 && move) bot.entity.position.z = 1;
      },
      readyTimeoutMs: 20,
      writeEvidence: async (value) => {
        evidence = value;
      },
    },
  };
}
test("fixed movement qualification passes only independent matching evidence", async () => {
  const f = fixture();
  const r = await runQualification(f.args);
  assert.equal(r.status, "passed");
  assert.equal(r.claimsLiveBenchmarkResult, false);
  assert.equal(r.movementMode, "forward");
  assert.equal(r.minecraftVersion, "1.21.4");
  assert.equal(r.checks.displacement, 1);
  assert.deepEqual(f.calls, [
    "data get entity PilotProbe Pos",
    "data get entity PilotProbe Dimension",
    "data get entity PilotProbe Health",
    "data get entity PilotProbe Pos",
    "data get entity PilotProbe Dimension",
    "data get entity PilotProbe Health",
  ]);
  assert.equal(f.bot.closed, true);
  assert.equal(f.rcon.closed, true);
  assert.deepEqual(f.controls.at(-1), ["forward", false]);
  assert.equal(f.evidence.status, "passed");
});
test("no movement, poor health, and self reports remain failures", async () => {
  for (const opts of [{ move: false }, { health: 0 }, { bad: true }]) {
    const f = fixture(opts);
    const r = await runQualification(f.args);
    assert.equal(r.status, "failed");
    assert.equal(f.evidence.status, "failed");
    assert.equal(f.bot.closed, true);
    if (f.rcon) assert.equal(f.rcon.closed, true);
  }
});
test("bounds and adapter failures fail before unsafe calls", async () => {
  const f = fixture();
  await assert.rejects(() => runQualification({ ...f.args, actionMs: 2001 }), /invalid actionMs/);
  assert.equal(f.calls.length, 0);
  let written;
  const r = await runQualification({
    ...f.args,
    createBot: async () => {
      throw new Error("secret credential");
    },
    writeEvidence: async (x) => (written = x),
  });
  assert.equal(r.status, "failed");
  assert.equal(r.error, "qualification failed");
  assert.doesNotMatch(JSON.stringify(written), /secret credential/);
  assert.equal(written.status, "failed");
});
test("private evidence is exclusive and contains no injected password", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qualify-"));
  const p = path.join(root, "evidence.json");
  try {
    writePrivateEvidence(p, { status: "failed" });
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(p)), { status: "failed" });
    assert.throws(() => writePrivateEvidence(p, { status: "passed" }), /EEXIST/);
    assert.equal(JSON.parse(fs.readFileSync(p)).status, "failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retries the initial RCON connection before the readiness deadline", async () => {
  const f = fixture();
  let attempts = 0;
  const report = await runQualification({
    ...f.args,
    readyTimeoutMs: 100,
    connectRcon: async (options) => {
      attempts += 1;
      if (attempts === 1) throw new Error("not listening yet");
      return f.args.connectRcon(options);
    },
  });
  assert.equal(report.status, "passed");
  assert.equal(attempts, 2);
});

test("bounds readiness observations and closes failed RCON candidates", async () => {
  const f = fixture();
  const socket = {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
  const stalled = { send: () => new Promise(() => {}), end: async () => {}, socket };
  const started = Date.now();
  const report = await runQualification({
    ...f.args,
    connectRcon: async () => stalled,
    readyTimeoutMs: 20,
    operationTimeoutMs: 5,
  });
  assert.equal(report.status, "failed");
  assert.ok(Date.now() - started < 500);
  assert.equal(socket.destroyed, true);
});

test("disposes bot resources that resolve after acquisition timeout", async () => {
  const f = fixture();
  let resolveBot;
  const pendingBot = new Promise((resolve) => {
    resolveBot = resolve;
  });
  const result = runQualification({ ...f.args, createBot: () => pendingBot, operationTimeoutMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  resolveBot(f.bot);
  assert.equal((await result).status, "failed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.bot.closed, true);
});

test("keeps late bot errors handled and removes timed-out spawn listeners", async () => {
  const f = fixture();
  delete f.bot.entity;
  const report = await runQualification({ ...f.args, readyTimeoutMs: 5 });
  assert.equal(report.status, "failed");
  assert.equal(f.bot.listenerCount("spawn"), 0);
  assert.equal(f.bot.listenerCount("kicked"), 1);
  assert.equal(f.bot.listenerCount("end"), 1);
  assert.doesNotThrow(() => f.bot.emit("error", new Error("late transport error")));
});

test("destroys the RCON socket when graceful close fails", async () => {
  const f = fixture();
  const socket = {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
  f.rcon.socket = socket;
  f.rcon.end = async () => {
    throw new Error("close failed");
  };
  const report = await runQualification(f.args);
  assert.equal(report.status, "passed");
  assert.equal(socket.destroyed, true);
});

test("disposes RCON resources that resolve after connection timeout", async () => {
  const f = fixture();
  let resolveRcon;
  const lateSocket = {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
  const lateRcon = { ...f.rcon, socket: lateSocket };
  let attempts = 0;
  const reportPromise = runQualification({
    ...f.args,
    readyTimeoutMs: 100,
    operationTimeoutMs: 5,
    connectRcon: async (options) => {
      attempts += 1;
      if (attempts === 1)
        return new Promise((resolve) => {
          resolveRcon = resolve;
        });
      return f.args.connectRcon(options);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  resolveRcon(lateRcon);
  assert.equal((await reportPromise).status, "passed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lateSocket.destroyed, true);
});

test("stationary control never enables forward and cannot pass without displacement", async () => {
  const f = fixture({ move: false });
  const report = await runQualification({ ...f.args, movement: "stationary" });
  assert.equal(report.status, "failed");
  assert.equal(report.movementMode, "stationary");
  assert.equal(
    f.controls.some(([key, value]) => key === "forward" && value === true),
    false,
  );
  assert.equal(report.checks.displacement, 0);
});

test("vertical falling does not satisfy the forward movement predicate", async () => {
  const f = fixture({ move: false });
  const report = await runQualification({
    ...f.args,
    sleep: async (ms) => {
      if (ms === 1000) f.bot.entity.position.y -= 4;
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.checks.displacement, 0);
  assert.equal(report.checks.displacement3d, 4);
  assert.equal(report.checks.displacementInBounds, false);
});

test("post-spawn transport failures invalidate an otherwise passing capture", async () => {
  for (const [event, payload] of [
    ["error", new Error("connection reset")],
    ["end", "socketClosed"],
    ["kicked", "server stopped"],
  ]) {
    const f = fixture();
    const report = await runQualification({
      ...f.args,
      sleep: async (ms) => {
        if (ms === 1000) {
          f.bot.entity.position.z = 1;
          f.bot.emit(event, payload);
        }
      },
    });
    assert.equal(report.status, "failed", event);
    assert.equal(report.checks.transportIntact, false, event);
    assert.equal(report.checks.displacementInBounds, true, event);
  }
});

test("transport events caused by cleanup do not invalidate a completed capture", async () => {
  const f = fixture();
  f.bot.quit = async () => {
    f.bot.emit("end", "quit");
    f.bot.emit("error", new Error("late cleanup error"));
    f.bot.closed = true;
  };
  const report = await runQualification(f.args);
  assert.equal(report.status, "passed");
  assert.equal(report.checks.transportIntact, true);
});

test("waits for an initial physics tick before querying readiness", async () => {
  const f = fixture();
  let releaseTick;
  f.bot.waitForTicks = () =>
    new Promise((resolve) => {
      releaseTick = resolve;
    });
  const result = runQualification(f.args);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.calls.length, 0);
  releaseTick();
  assert.equal((await result).status, "passed");
});

test("retains the last server observation when terminal convergence times out", async () => {
  const f = fixture();
  let positionQueries = 0;
  const report = await runQualification({
    ...f.args,
    operationTimeoutMs: 10,
    sleep: async (ms) => {
      if (ms === 1000) f.bot.entity.position.z = 3;
    },
    connectRcon: async () => ({
      end: f.rcon.end,
      send: async (command) => {
        if (command.endsWith(" Pos")) {
          positionQueries += 1;
          if (positionQueries > 1) return "PilotProbe has the following entity data: [0d, 64d, 0d]";
        }
        return f.rcon.send(command);
      },
    }),
  });
  assert.equal(report.status, "failed");
  assert.deepEqual(report.after.position, { x: 0, y: 64, z: 0 });
  assert.equal(report.checks.terminalSettled, false);
  assert.ok(report.checks.terminalPollCount >= 1);
  assert.ok(report.checks.terminalElapsedMs >= 0);
});

test("a server correction can settle while the movement predicate still fails", async () => {
  const f = fixture();
  let positionQueries = 0;
  const report = await runQualification({
    ...f.args,
    connectRcon: async () => ({
      end: f.rcon.end,
      send: async (command) => {
        if (command.endsWith(" Pos")) {
          positionQueries += 1;
          if (positionQueries > 1) {
            f.bot.entity.position.z = 0;
            return "PilotProbe has the following entity data: [0d, 64d, 0d]";
          }
        }
        return f.rcon.send(command);
      },
    }),
  });
  assert.equal(report.status, "failed");
  assert.equal(report.checks.terminalSettled, true);
  assert.equal(report.checks.displacement, 0);
  assert.equal(report.checks.displacementInBounds, false);
});

test("retains initial evidence when the action later fails", async () => {
  const f = fixture({ move: false });
  const report = await runQualification({
    ...f.args,
    sleep: async (ms) => {
      if (ms === 1000) throw new Error("action failed");
    },
  });
  assert.equal(report.status, "failed");
  assert.deepEqual(report.before.position, { x: 0, y: 64, z: 0 });
  assert.deepEqual(report.mineflayer.before, { x: 0, y: 64, z: 0 });
  assert.equal(report.checks.initialPositionsAgree, true);
  assert.equal("after" in report, false);
});
