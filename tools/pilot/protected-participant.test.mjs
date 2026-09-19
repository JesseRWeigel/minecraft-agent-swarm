import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { runParticipant } from "./protected-participant.mjs";

function command(type, extra = {}) {
  return { schema_version: 1, type, trial_id: "trial-01", action_id: "walk-01", ...extra };
}

function fixture({ movement = "forward", commands = [command("begin"), command("finalize")] } = {}) {
  const events = [];
  const bot = new EventEmitter();
  bot.entity = { position: { x: 0, y: 64, z: 0 } };
  bot._client = {
    socket: {
      destroyed: false,
      destroy() {
        this.destroyed = true;
        events.push("socket:destroy");
      },
    },
    write(name, payload) {
      assert.equal(name, "player_loaded");
      assert.deepEqual(payload, {});
      events.push("handshake");
    },
  };
  bot.waitForTicks = async (ticks) => {
    assert.equal(ticks, 1);
    events.push("physicsTick");
  };
  bot.setControlState = (key, value) => events.push(`${key}:${value}`);
  bot.quit = async () => {
    events.push("quit");
    bot.emit("end", "quit");
  };
  const sent = [];
  let commandIndex = 0;
  const args = {
    trialId: "trial-01",
    actionId: "walk-01",
    movement,
    createBot: async (options) => {
      assert.deepEqual(options, {
        host: "127.0.0.1",
        port: 25585,
        username: "PilotProbe",
        auth: "offline",
        version: "1.21.4",
        respawn: false,
      });
      events.push("create");
      return bot;
    },
    sendMessage: async (message) => {
      sent.push(message);
      events.push(`send:${message.type}`);
    },
    waitForCommand: async () => {
      const value = commands[commandIndex++];
      events.push(`receive:${value?.type}`);
      return value;
    },
    sleep: async (ms) => {
      assert.equal(ms, 1000);
      events.push("action:wait");
    },
    phaseTimeoutMs: 50,
    totalTimeoutMs: 500,
  };
  return { args, bot, events, sent };
}

test("completes only the fixed protocol phases and quits after finalize", async () => {
  const f = fixture();
  const result = await runParticipant({
    ...f.args,
    waitForCommand: async () => {
      const next = f.sent.length === 1 ? command("begin") : command("finalize");
      if (next.type === "finalize") assert.equal(f.events.includes("quit"), false);
      f.events.push(`receive:${next.type}`);
      return next;
    },
  });
  assert.equal(result.status, "protocol_completed");
  assert.equal("success" in result, false);
  assert.deepEqual(f.sent, [command("ready"), command("action_finished")]);
  assert.deepEqual(f.events.slice(0, 10), [
    "create",
    "physicsTick",
    "handshake",
    "send:ready",
    "receive:begin",
    "forward:true",
    "action:wait",
    "forward:false",
    "send:action_finished",
    "receive:finalize",
  ]);
  assert.ok(f.events.indexOf("quit") > f.events.indexOf("receive:finalize"));
  assert.equal(f.bot._client.socket.destroyed, true);
});

test("stationary mode never enables forward", async () => {
  const f = fixture({ movement: "stationary" });
  const result = await runParticipant(f.args);
  assert.equal(result.status, "protocol_completed");
  assert.equal(f.events.includes("forward:true"), false);
  assert.equal(f.events.includes("action:wait"), true);
});

test("rejects malformed duplicate wrong-phase and wrong-ID supervisor messages", async () => {
  const cases = [
    { ...command("begin"), extra: true },
    command("begin", { schema_version: true }),
    command("finalize"),
    command("begin", { trial_id: "other" }),
    command("begin", { action_id: "other" }),
    [command("begin")],
    null,
  ];
  for (const first of cases) {
    const f = fixture({ commands: [first] });
    const result = await runParticipant(f.args);
    assert.deepEqual(result, { schema_version: 1, status: "failed" });
    assert.equal(f.sent.length, 1);
    assert.equal(f.events.includes("forward:true"), false);
  }
  const duplicate = fixture({ commands: [command("begin"), command("begin")] });
  assert.equal((await runParticipant(duplicate.args)).status, "failed");
  assert.equal(duplicate.sent.length, 2);
});

test("transport failure remains fatal even when a command wait resolves", async () => {
  for (const event of ["error", "end", "kicked"]) {
    const f = fixture();
    const result = await runParticipant({
      ...f.args,
      waitForCommand: async () => {
        f.bot.emit(event, event === "error" ? new Error("secret") : "closed");
        return command("begin");
      },
    });
    assert.deepEqual(result, { schema_version: 1, status: "failed" });
    assert.equal(f.events.includes("forward:true"), false);
  }
});

test("death is not a transport failure and automatic respawn is unavailable", async () => {
  const f = fixture();
  const result = await runParticipant({
    ...f.args,
    sleep: async (ms) => {
      assert.equal(ms, 1000);
      f.bot.emit("death");
    },
    respawn: () => assert.fail("arbitrary respawn adapter must not be used"),
  });
  assert.equal(result.status, "protocol_completed");
});

test("never receiving begin or finalize is bounded and cleaned up", async () => {
  const never = () => new Promise(() => {});
  const noBegin = fixture();
  let started = Date.now();
  let result = await runParticipant({ ...noBegin.args, waitForCommand: never, phaseTimeoutMs: 5, totalTimeoutMs: 30 });
  assert.equal(result.status, "failed");
  assert.ok(Date.now() - started < 250);
  assert.equal(noBegin.bot._client.socket.destroyed, true);

  const noFinalize = fixture();
  let calls = 0;
  started = Date.now();
  result = await runParticipant({
    ...noFinalize.args,
    phaseTimeoutMs: 5,
    totalTimeoutMs: 30,
    waitForCommand: () => (++calls === 1 ? command("begin") : never()),
  });
  assert.equal(result.status, "failed");
  assert.ok(Date.now() - started < 250);
  assert.equal(noFinalize.sent.length, 2);
  assert.equal(noFinalize.bot._client.socket.destroyed, true);
});

test("late bot acquisition is disposed without running the protocol", async () => {
  const f = fixture();
  let resolveBot;
  const pending = new Promise((resolve) => {
    resolveBot = resolve;
  });
  const resultPromise = runParticipant({
    ...f.args,
    createBot: () => pending,
    phaseTimeoutMs: 5,
    totalTimeoutMs: 30,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  resolveBot(f.bot);
  assert.equal((await resultPromise).status, "failed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.events.includes("quit"), true);
  assert.equal(f.bot._client.socket.destroyed, true);
  assert.deepEqual(f.sent, []);
});

test("failure always disables forward and uses only generic diagnostic output", async () => {
  const f = fixture();
  const result = await runParticipant({
    ...f.args,
    sleep: async () => {
      throw new Error("model or credential secret");
    },
  });
  assert.deepEqual(result, { schema_version: 1, status: "failed" });
  assert.equal(f.events.includes("forward:true"), true);
  assert.ok(f.events.lastIndexOf("forward:false") > f.events.indexOf("forward:true"));
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("API exposes no RCON, evidence, endpoint, command, or model adapter", async () => {
  const f = fixture();
  const result = await runParticipant({
    ...f.args,
    rcon: { send: () => assert.fail("must not be used") },
    evidencePath: "/forbidden",
    host: "example.com",
    port: 1,
    command: ["arbitrary"],
    model: "forbidden",
  });
  assert.equal(result.status, "protocol_completed");
  for (const message of f.sent)
    assert.deepEqual(Object.keys(message), ["schema_version", "type", "trial_id", "action_id"]);
});

test("rejects unsafe IDs and timeout overrides outside fixed bounds", async () => {
  const f = fixture();
  for (const trialId of ["", "../trial", "trial\nforged", "trial-forged\n", 123])
    await assert.rejects(() => runParticipant({ ...f.args, trialId }), /supervisor ID/);
  await assert.rejects(() => runParticipant({ ...f.args, phaseTimeoutMs: 0 }), /phaseTimeoutMs/);
  await assert.rejects(() => runParticipant({ ...f.args, phaseTimeoutMs: 30_001 }), /phaseTimeoutMs/);
  await assert.rejects(() => runParticipant({ ...f.args, totalTimeoutMs: 90_001 }), /totalTimeoutMs/);
});

test("invalid and backwards runtime clocks fail generically", async () => {
  for (const nowMonotonic of [
    () => Number.NaN,
    (() => {
      let value = 1;
      return () => value--;
    })(),
  ]) {
    const f = fixture();
    const result = await runParticipant({ ...f.args, nowMonotonic });
    assert.deepEqual(result, { schema_version: 1, status: "failed" });
  }
});
