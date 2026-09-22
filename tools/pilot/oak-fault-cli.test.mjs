import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";

import { runOakFaultProcess } from "./oak-fault-cli.mjs";

const request = (overrides = {}) =>
  JSON.stringify({
    schema_version: 1,
    mode: "item_only",
    trial_id: "collect-oak-log-v1",
    action_id: "collect-01",
    password: "rcon-secret",
    operation_timeout_ms: 100,
    ...overrides,
  });

function sink() {
  const stream = new PassThrough();
  stream.setEncoding("utf8");
  let value = "";
  stream.on("data", (chunk) => (value += chunk));
  return { stream, text: () => value };
}

test("rejects malformed, extended, and unbounded fault requests before connecting", async () => {
  for (const body of [
    "not-json",
    request({ mode: "anything" }),
    request({ mode: ["item_only"] }),
    request({ trial_id: "other" }),
    request({ operation_timeout_ms: 0 }),
    request({ extra: "give other command" }),
    '{"schema_version":1,"mode":"item_only","mode":"item_and_block","trial_id":"collect-oak-log-v1","action_id":"collect-01","password":"x","operation_timeout_ms":100}',
  ]) {
    let connected = false;
    const output = sink();
    const error = sink();
    const code = await runOakFaultProcess({
      input: Readable.from([body]),
      output: output.stream,
      error: error.stream,
      connect: async () => {
        connected = true;
      },
    });
    assert.equal(code, 1);
    assert.equal(connected, false);
    assert.equal(output.text(), "");
    assert.equal(error.text(), "oak fault failed\n");
  }
});

test("issues only the source-pinned item injection command and emits bounded receipts", async () => {
  const output = sink();
  const error = sink();
  const calls = [];
  const rcon = { end: async () => calls.push("end"), socket: { destroy: () => calls.push("destroy") } };
  const code = await runOakFaultProcess({
    input: Readable.from([request()]),
    output: output.stream,
    error: error.stream,
    connect: async (options) => (calls.push(["connect", options]), rcon),
    nowMonotonic: (() => {
      let n = 0;
      return () => (n += 1);
    })(),
    send: async (connection, command) => (calls.push(["send", connection, command]), "Given 1 [Oak Log] to PilotProbe"),
  });

  assert.equal(code, 0);
  assert.equal(error.text(), "");
  const result = JSON.parse(output.text());
  assert.equal(result.status, "completed");
  assert.equal(result.mode, "item_only");
  assert.deepEqual(result.commands.map(({ command, outcome }) => ({ command, outcome })), [
    { command: "give PilotProbe minecraft:oak_log 1", outcome: "issued" },
  ]);
  assert.ok(result.commands[0].responseBytes > 0);
  assert.equal(JSON.stringify(result).includes("rcon-secret"), false);
  assert.deepEqual(calls[0], [
    "connect",
    { host: "127.0.0.1", port: 25595, password: "rcon-secret", timeout: 5000, maxPending: 1 },
  ]);
  assert.equal(calls[1][2], "give PilotProbe minecraft:oak_log 1");
  assert.deepEqual(calls.slice(-2), ["end", "destroy"]);
});

test("item-and-block mode has exactly the two reviewed commands", async () => {
  const output = sink();
  const sent = [];
  const code = await runOakFaultProcess({
    input: Readable.from([request({ mode: "item_and_block" })]),
    output: output.stream,
    error: sink().stream,
    connect: async () => ({ end: async () => {}, socket: { destroy() {} } }),
    send: async (_rcon, command) => (sent.push(command), "Command completed"),
  });
  assert.equal(code, 0);
  assert.deepEqual(sent, [
    "give PilotProbe minecraft:oak_log 1",
    "execute in minecraft:overworld run setblock 0 200 3 minecraft:air",
  ]);
  assert.deepEqual(JSON.parse(output.text()).commands.map(({ command }) => command), sent);
});

test("times out a stalled RCON command, reports structured failure, and closes the connection", async () => {
  const output = sink();
  const error = sink();
  let closed = 0;
  const code = await runOakFaultProcess({
    input: Readable.from([request({ operation_timeout_ms: 5 })]),
    output: output.stream,
    error: error.stream,
    connect: async () => ({ end: async () => (closed += 1), socket: { destroy: () => (closed += 1) } }),
    send: async () => new Promise(() => {}),
  });
  assert.equal(code, 1);
  const result = JSON.parse(output.text());
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "timeout");
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].outcome, "timeout");
  assert.equal(error.text(), "oak fault failed\n");
  assert.equal(closed, 2);
});
