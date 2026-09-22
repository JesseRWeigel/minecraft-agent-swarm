import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runParticipant } from "./oak-participant.mjs";
const msg = (type) => ({ schema_version: 1, type, trial_id: "collect-oak-log-v1", action_id: "collect-01" });
const request = (sequence, action) => JSON.stringify({ ...msg(undefined), sequence, action }) + "\n";
const tick = () => new Promise((r) => setImmediate(r));
function fixture() {
  const bot = new EventEmitter(),
    events = [],
    sent = [],
    input = new PassThrough(),
    output = new PassThrough();
  bot.entity = { position: { x: 0.5, y: 200, z: 0.5 }, yaw: 0, pitch: 0 };
  bot.health = 20;
  bot.inventory = { slots: [] };
  bot._client = {
    write: () => {},
    socket: {
      destroy() {
        events.push("destroy");
      },
    },
  };
  bot.waitForTicks = async () => {};
  bot.look = async () => events.push("look");
  bot.dig = async () => events.push("dig");
  bot.blockAt = bot.blockAtCursor = () => null;
  bot.canDigBlock = () => false;
  bot.setControlState = () => events.push("move");
  bot.clearControlStates = () => events.push("clear");
  bot.stopDigging = () => events.push("stop");
  bot.end = () => {
    events.push("end");
    bot.emit("end");
  };
  bot.quit = async () => {
    events.push("quit");
    bot.emit("end");
  };
  const commands = [];
  let waiter;
  const command = (value) => {
    if (waiter) {
      const r = waiter;
      waiter = null;
      r(value);
    } else commands.push(value);
  };
  return {
    bot,
    events,
    sent,
    input,
    output,
    command,
    args: {
      movement: "model",
      actionInput: input,
      actionOutput: output,
      createBot: () => bot,
      sendMessage: async (v) => sent.push(v.type),
      waitForCommand: () => (commands.length ? Promise.resolve(commands.shift()) : new Promise((r) => (waiter = r))),
      phaseTimeoutMs: 200,
      totalTimeoutMs: 1000,
    },
  };
}
test("model actions wait for begin and finish/EOF precedes lifecycle completion", async () => {
  const f = fixture(),
    replies = [];
  f.output.on("data", (b) => replies.push(JSON.parse(b)));
  const done = runParticipant(f.args);
  f.input.write(request(1, { kind: "look", yaw: 0, pitch: 0 }));
  await tick();
  assert.deepEqual(f.sent, ["ready"]);
  assert.equal(f.events.includes("look"), false);
  f.command(msg("begin"));
  await tick();
  assert.equal(f.events.includes("look"), true);
  assert.equal(replies.length, 1);
  f.input.write(request(2, { kind: "finish" }));
  await tick();
  assert.deepEqual(f.sent, ["ready"]);
  f.input.end();
  await tick();
  assert.deepEqual(f.sent, ["ready", "action_finished"]);
  assert.equal(f.events.includes("end"), false);
  assert.equal(f.events.includes("quit"), false);
  f.command(msg("finalize"));
  assert.equal((await done).status, "protocol_completed");
  assert.ok(f.events.includes("quit"));
});
test("malformed action and lifecycle text on action stream fail without action_finished", async () => {
  for (const raw of ["bad\n", JSON.stringify(msg("finalize")) + "\n"]) {
    const f = fixture();
    f.command(msg("begin"));
    f.input.end(raw);
    assert.equal((await runParticipant(f.args)).status, "failed");
    assert.deepEqual(f.sent, ["ready"]);
    assert.ok(f.events.includes("end"));
  }
});
test("lifecycle timeout cancels pending action and late completion emits nothing", async () => {
  const f = fixture();
  let resolveLook;
  f.bot.look = () => new Promise((r) => (resolveLook = r));
  let bytes = 0;
  f.output.on("data", (b) => (bytes += b.length));
  f.command(msg("begin"));
  f.input.write(request(1, { kind: "look", yaw: 0, pitch: 0 }));
  assert.equal((await runParticipant({ ...f.args, phaseTimeoutMs: 20 })).status, "failed");
  assert.deepEqual(f.sent, ["ready"]);
  resolveLook();
  await tick();
  assert.equal(bytes, 0);
  assert.ok(f.events.includes("end"));
});
test("finish cannot mask disconnect before trusted finalize", async () => {
  const f = fixture();
  f.command(msg("begin"));
  f.input.end(request(1, { kind: "finish" }));
  const done = runParticipant(f.args);
  await tick();
  assert.deepEqual(f.sent, ["ready", "action_finished"]);
  f.bot.emit("end");
  f.command(msg("finalize"));
  assert.equal((await done).status, "failed");
});
test("action streams cannot be attached to a fixed-action mode", async () => {
  const f = fixture();
  await assert.rejects(runParticipant({ ...f.args, movement: "forward" }));
  assert.deepEqual(f.events, []);
});
