import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { runParticipant } from "./oak-participant.mjs";

const ids = Object.freeze({ trialId: "collect-oak-log-v1", actionId: "collect-01" });
const message = (type) => ({ schema_version: 1, type, trial_id: ids.trialId, action_id: ids.actionId });

function fixture({
  movement = "forward",
  commands = [message("begin"), message("finalize")],
  inventory = [],
  collectOnSleep = false,
} = {}) {
  const events = [];
  const bot = new EventEmitter();
  const vector = (x, y, z) => ({
    x,
    y,
    z,
    clone: () => vector(x, y, z),
    set: (nextX, nextY, nextZ) => vector(nextX, nextY, nextZ),
  });
  const position = vector(0, 64, 0);
  bot.entity = { position };
  bot._client = {
    socket: {
      destroyed: false,
      destroy() {
        this.destroyed = true;
        events.push("socket:destroy");
      },
    },
    write: () => events.push("handshake"),
  };
  bot.waitForTicks = async () => events.push("physics");
  bot.setControlState = (key, value) => events.push(`${key}:${value}`);
  bot.lookAt = async (target) => events.push(`look:${target.x},${target.y},${target.z}`);
  bot.blockAt = (target) => {
    events.push(`block:${target.x},${target.y},${target.z}`);
    return { name: "oak_log", position: target };
  };
  bot.dig = async (block) => events.push(`dig:${block.name}`);
  bot.inventory = { items: () => inventory };
  bot.quit = async () => {
    events.push("quit");
    bot.emit("end", "quit");
  };
  let index = 0;
  const sent = [];
  return {
    bot,
    events,
    sent,
    args: {
      ...ids,
      movement,
      createBot: async () => bot,
      sendMessage: async (value) => {
        sent.push(value);
        events.push(`send:${value.type}`);
      },
      waitForCommand: async () => commands[index++],
      sleep: async () => {
        events.push("sleep");
        if (collectOnSleep && !inventory.length) inventory.push({ name: "oak_log", count: 1 });
      },
      phaseTimeoutMs: 50,
      totalTimeoutMs: 500,
    },
  };
}

test("stationary mode sends protocol messages without a mining action", async () => {
  const f = fixture({ movement: "stationary" });
  const result = await runParticipant(f.args);
  assert.equal(result.status, "protocol_completed");
  assert.deepEqual(f.sent, [message("ready"), message("action_finished")]);
  assert.equal(
    f.events.some((event) => event.startsWith("dig:")),
    false,
  );
  assert.equal(f.events.includes("forward:true"), false);
  assert.ok(f.events.indexOf("quit") > f.events.indexOf("send:action_finished"));
});

test("forward mode mines the fixed oak log and only then moves toward its drop", async () => {
  const f = fixture({ collectOnSleep: true });
  const result = await runParticipant(f.args);
  assert.equal(result.status, "protocol_completed");
  assert.ok(f.events.indexOf("send:ready") < f.events.indexOf("block:0,200,3"));
  assert.ok(f.events.indexOf("dig:oak_log") < f.events.indexOf("look:0.5,201.62,10"));
  assert.ok(f.events.indexOf("look:0.5,201.62,10") < f.events.indexOf("forward:true"));
  assert.equal(f.events.includes("forward:false"), true);
});

test("forward mode does not walk after the inventory already contains the oak log", async () => {
  const f = fixture({ inventory: [{ name: "oak_log", count: 1 }] });
  assert.equal((await runParticipant(f.args)).status, "protocol_completed");
  assert.equal(f.events.includes("forward:true"), false);
});

test("protocol failure cleans up and never mines before begin", async () => {
  const f = fixture({ commands: [message("finalize")] });
  const result = await runParticipant(f.args);
  assert.deepEqual(result, { schema_version: 1, status: "failed" });
  assert.equal(
    f.events.some((event) => event.startsWith("dig:")),
    false,
  );
  assert.equal(f.events.includes("forward:true"), false);
  assert.equal(f.bot._client.socket.destroyed, true);
});

test("a dig that resolves after the action timeout cannot mutate controls after cleanup", async () => {
  const f = fixture();
  let resolveDig;
  f.bot.dig = () =>
    new Promise((resolve) => {
      resolveDig = resolve;
    });
  const resultPromise = runParticipant({ ...f.args, phaseTimeoutMs: 5, totalTimeoutMs: 50 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await resultPromise).status, "failed");
  const eventCountAfterCleanup = f.events.length;
  resolveDig();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.events.includes("forward:true"), false);
  assert.equal(f.events.length, eventCountAfterCleanup);
});

test("mine-only breaks target but does not start collection movement",async()=>{
 const f=fixture({movement:"mine_only"});const result=await runParticipant(f.args);
 assert.equal(result.status,"protocol_completed");assert.ok(f.events.includes("dig:oak_log"));assert.equal(f.events.includes("forward:true"),false);
});
test("blocked control walks toward verified bedrock without mining through it",async()=>{
 const f=fixture({movement:"blocked"});f.bot.blockAtCursor=()=>({name:"bedrock"});f.bot.canDigBlock=()=>false;
 const result=await runParticipant(f.args);assert.equal(result.status,"protocol_completed");assert.ok(f.events.includes("forward:true"));assert.equal(f.events.some(x=>x.startsWith("dig:")),false);
});
test("blocked control rejects a missing or diggable barrier",async()=>{
 for(const block of [null,{name:"oak_log"},{name:"bedrock"}]){
 const f=fixture({movement:"blocked"});f.bot.blockAtCursor=()=>block;f.bot.canDigBlock=()=>true;
 assert.equal((await runParticipant(f.args)).status,"failed");assert.equal(f.events.some(x=>x.startsWith("dig:")),false);}
});
