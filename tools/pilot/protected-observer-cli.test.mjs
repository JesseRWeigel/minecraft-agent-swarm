import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { test } from "node:test";
import { runObserverProcess } from "./protected-observer-cli.mjs";

const request = (overrides = {}) =>
  JSON.stringify({
    schema_version: 1,
    phase: "before",
    trial_id: "trial-01",
    action_id: "walk-01",
    password: "rcon-secret",
    ...overrides,
  });
function sink() {
  const stream = new PassThrough();
  stream.setEncoding("utf8");
  let value = "";
  stream.on("data", (chunk) => (value += chunk));
  return { stream, text: () => value };
}
function sampled(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "sampled",
    source: "server_rcon",
    actor: "PilotProbe",
    phase: "before",
    trialId: "trial-01",
    actionId: "walk-01",
    observations: { position: { x: 1, y: 64, z: 2 }, dimension: "minecraft:overworld", health: 20 },
    sample: {},
    ...overrides,
  };
}

test("validates the exact bounded stdin request before connecting", async () => {
  for (const body of [
    "not json",
    request({ extra: true }),
    request({ schema_version: 2 }),
    request({ phase: "other" }),
    request({ trial_id: "../bad" }),
    request({ trial_id: "valid\n" }),
    request({ trial_id: 123 }),
    request({ password: "" }),
    '{"schema_version":1,"phase":"before","trial_id":"trial-01","action_id":"walk-01","password":"first","password":"second"}',
    Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]),
    "x".repeat(4097),
  ]) {
    let connected = false;
    const output = sink();
    const error = sink();
    const code = await runObserverProcess({
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
    assert.equal(error.text(), "observer failed\n");
  }
});

test("connects to only the fixed endpoint, samples, emits one JSON line, and closes", async () => {
  const output = sink();
  const error = sink();
  const calls = [];
  const rcon = { socket: { destroy: () => calls.push("destroy") }, end: async () => calls.push("end") };
  const code = await runObserverProcess({
    input: Readable.from([request({ password: "a" })]),
    output: output.stream,
    error: error.stream,
    connect: async (options) => (calls.push(["connect", options]), rcon),
    sample: async (options) => (calls.push(["sample", options]), sampled()),
  });
  assert.equal(code, 0);
  assert.equal(error.text(), "");
  assert.deepEqual(JSON.parse(output.text()), sampled());
  assert.equal(output.text().split("\n").length, 2);
  assert.deepEqual(calls[0], [
    "connect",
    { host: "127.0.0.1", port: 25595, password: "a", timeout: 5000, maxPending: 1 },
  ]);
  assert.equal(calls[1][0], "sample");
  assert.equal(calls[1][1].rcon, rcon);
  assert.deepEqual(
    { phase: calls[1][1].phase, trialId: calls[1][1].trialId, actionId: calls[1][1].actionId },
    { phase: "before", trialId: "trial-01", actionId: "walk-01" },
  );
  assert.equal(calls[1][1].operationTimeoutMs, 5000);
  assert.deepEqual(calls.slice(2), ["end", "destroy"]);
  assert.doesNotMatch(output.text(), /rcon-secret/);
});

test("awaits stdout completion before returning", async () => {
  let text = "";
  let release;
  const output = {
    write(chunk, callback) {
      text += chunk;
      release = callback;
      return false;
    },
  };
  const running = runObserverProcess({
    input: Readable.from([request()]),
    output,
    error: sink().stream,
    connect: async () => ({ end: async () => {}, socket: { destroy() {} } }),
    sample: async () => sampled(),
  });
  const early = await Promise.race([
    running.then(() => "returned"),
    new Promise((resolve) => setTimeout(() => resolve("waiting"), 5)),
  ]);
  assert.equal(early, "waiting");
  release();
  assert.equal(await running, 0);
  assert.deepEqual(JSON.parse(text), sampled());
});

test("bounds a stalled stdout callback with the overall watchdog", async () => {
  const output = {
    write() {
      return false;
    },
  };
  const error = sink();
  const started = Date.now();
  const code = await runObserverProcess({
    input: Readable.from([request()]),
    output,
    error: error.stream,
    watchdogMs: 5,
    connect: async () => ({ end: async () => {}, socket: { destroy() {} } }),
    sample: async () => sampled(),
  });
  assert.equal(code, 1);
  assert.ok(Date.now() - started < 250);
  assert.equal(error.text(), "observer failed\n");
});

test("writes a near-limit fixture result without truncation", async () => {
  const output = sink();
  const error = sink();
  const setup = { status: "configured", fixture: { detail: "x".repeat(63000) } };
  const baseline = sampled();
  const verification = { status: "verified" };
  const code = await runObserverProcess({
    input: Readable.from([request({ phase: "fixture" })]),
    output: output.stream,
    error: error.stream,
    connect: async () => ({ end: async () => {}, socket: { destroy() {} } }),
    setupFixture: async () => setup,
    sample: async () => baseline,
    verifyFixture: () => verification,
  });
  assert.equal(code, 0);
  assert.equal(error.text(), "");
  const line = output.text();
  assert.ok(Buffer.byteLength(line) < 65536);
  assert.deepEqual(JSON.parse(line), {
    schema_version: 1,
    phase: "fixture",
    setup,
    baseline,
    baselineVerification: verification,
  });
});

test("closes an injected connection that arrives after timeout without emitting", async () => {
  const output = sink();
  const error = sink();
  let resolveConnect;
  let ended = 0;
  let destroyed = 0;
  const connection = {
    end: async () => {
      ended += 1;
    },
    socket: {
      destroy() {
        destroyed += 1;
      },
    },
  };
  const code = await runObserverProcess({
    input: Readable.from([request()]),
    output: output.stream,
    error: error.stream,
    connect: () =>
      new Promise((resolve) => {
        resolveConnect = resolve;
      }),
    watchdogMs: 5,
  });
  assert.equal(code, 1);
  resolveConnect(connection);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(output.text(), "");
  assert.equal(ended, 1);
  assert.equal(destroyed, 1);
});

test("preserves a structured sample failure on stdout while exiting nonzero", async () => {
  const output = sink();
  const error = sink();
  const failure = sampled({ status: "failed", errorCode: "timeout", observations: {} });
  const code = await runObserverProcess({
    input: Readable.from([request({ phase: "terminal" })]),
    output: output.stream,
    error: error.stream,
    connect: async () => ({ end: async () => {}, socket: { destroy() {} } }),
    sample: async () => failure,
  });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(output.text()), failure);
  assert.equal(error.text(), "observer failed\n");
});

test("fixture phase reports issued setup and independently verified baseline", async () => {
  const output = sink();
  const error = sink();
  const rcon = { end: async () => {}, socket: { destroy() {} } };
  const setup = {
    status: "configured",
    fixture: { sha256: "abc", commands: [] },
    commandWindows: [],
    baselineChecks: {},
  };
  const baseline = sampled();
  const verification = { status: "verified" };
  const calls = [];
  const code = await runObserverProcess({
    input: Readable.from([request({ phase: "fixture" })]),
    output: output.stream,
    error: error.stream,
    connect: async () => rcon,
    setupFixture: async (options) => (calls.push(["setup", options]), setup),
    sample: async (options) => (calls.push(["sample", options]), baseline),
    verifyFixture: (value) => (calls.push(["verify", value]), verification),
  });
  assert.equal(code, 0);
  assert.equal(error.text(), "");
  assert.deepEqual(JSON.parse(output.text()), {
    schema_version: 1,
    phase: "fixture",
    setup,
    baseline,
    baselineVerification: verification,
  });
  assert.equal(calls[0][0], "setup");
  assert.equal(calls[0][1].rcon, rcon);
  assert.equal(calls[0][1].operationTimeoutMs, 15000);
  assert.equal(calls[1][1].phase, "before");
  assert.equal(calls[2][1], baseline);
});

test("watchdog bounds a stalled connection and never exposes raw errors or passwords", async () => {
  const output = sink();
  const error = sink();
  const started = Date.now();
  const code = await runObserverProcess({
    input: Readable.from([request()]),
    output: output.stream,
    error: error.stream,
    connect: () => new Promise(() => {}),
    watchdogMs: 5,
  });
  assert.equal(code, 1);
  assert.ok(Date.now() - started < 250);
  assert.equal(output.text(), "");
  assert.equal(error.text(), "observer failed\n");
  assert.doesNotMatch(error.text(), /rcon-secret/);
});

test("trusted terminal stall phase selects only the fixed fault endpoint", async () => {
  let port, phase;
  const output = sink();
  const code = await runObserverProcess({ input: Readable.from([request({phase: "terminal_rcon_stall"})]),
    output: output.stream, error: sink().stream,
    connect: async options => { port = options.port; return {end() {}, socket: {destroy() {}}}; },
    sample: async options => {phase = options.phase; return sampled({phase: "terminal"});}
  });
  assert.equal(code, 0);
  assert.equal(port, 25596);
  assert.equal(phase, "terminal");
});
