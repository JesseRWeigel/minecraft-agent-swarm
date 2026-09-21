import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runParticipantProcess } from "./protected-participant-cli.mjs";

const argv = ["--trial-id", "trial-01", "--action-id", "walk-01", "--movement", "stationary"];
const protocolLine = (type) =>
  `${JSON.stringify({ schema_version: 1, type, trial_id: "trial-01", action_id: "walk-01" })}\n`;

test("validates arguments before loading mineflayer", async () => {
  for (const bad of [
    [],
    argv.slice(0, -1),
    [...argv, "extra"],
    [...argv.slice(0, -1), "sideways"],
    ["--trial-id", "../bad", ...argv.slice(2)],
  ]) {
    let loaded = false;
    const error = new PassThrough();
    error.setEncoding("utf8");
    let diagnostic = "";
    error.on("data", (chunk) => (diagnostic += chunk));
    const code = await runParticipantProcess({
      argv: bad,
      input: new PassThrough(),
      output: new PassThrough(),
      error,
      loadMineflayer: async () => {
        loaded = true;
      },
    });
    assert.equal(code, 1);
    assert.equal(loaded, false);
    assert.equal(diagnostic, "participant failed\n");
  }
});

test("integrates streams with an injected participant runner", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let stdout = "";
  output.on("data", (chunk) => (stdout += chunk));
  let lines = 0;
  output.on("data", () => {
    lines += 1;
    input.write(lines === 1 ? protocolLine("begin") : protocolLine("finalize"));
    if (lines === 2) input.end();
  });
  let loaded = 0;
  const code = await runParticipantProcess({
    argv,
    input,
    output,
    error: new PassThrough(),
    loadMineflayer: async () => ({ createBot: () => assert.fail("fake runner must own bot behavior") }),
    run: async ({ sendMessage, waitForCommand, trialId, actionId, movement, createBot }) => {
      loaded += 1;
      assert.equal(typeof createBot, "function");
      assert.deepEqual(
        { trialId, actionId, movement },
        { trialId: "trial-01", actionId: "walk-01", movement: "stationary" },
      );
      await sendMessage(JSON.parse(protocolLine("ready")));
      assert.equal((await waitForCommand()).type, "begin");
      await sendMessage(JSON.parse(protocolLine("action_finished")));
      assert.equal((await waitForCommand()).type, "finalize");
      return { schema_version: 1, status: "protocol_completed" };
    },
  });
  assert.equal(code, 0);
  assert.equal(loaded, 1);
  assert.equal(stdout, protocolLine("ready") + protocolLine("action_finished"));
});

test("returns nonzero with generic stderr when participant or pipes fail", async () => {
  for (const run of [
    async () => ({ schema_version: 1, status: "failed", detail: "secret" }),
    async () => {
      throw new Error("credential secret");
    },
  ]) {
    const error = new PassThrough();
    error.setEncoding("utf8");
    let diagnostic = "";
    error.on("data", (chunk) => (diagnostic += chunk));
    const code = await runParticipantProcess({
      argv,
      input: new PassThrough(),
      output: new PassThrough(),
      error,
      loadMineflayer: async () => ({ createBot() {} }),
      run,
    });
    assert.equal(code, 1);
    assert.equal(diagnostic, "participant failed\n");
  }
});

test("real CLI process reserves stdout and rejects arguments before dependency loading", async () => {
  const child = spawn(
    process.execPath,
    [
      new URL("./protected-participant-cli.mjs", import.meta.url).pathname,
      "--trial-id",
      "bad/id",
      "--action-id",
      "walk-01",
      "--movement",
      "forward",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 1);
  assert.equal(Buffer.concat(stdout).toString(), "");
  assert.equal(Buffer.concat(stderr).toString(), "participant failed\n");
});

test("watchdog bounds dependency loading", async () => {
  const error = new PassThrough();
  error.setEncoding("utf8");
  let diagnostic = "";
  error.on("data", (chunk) => (diagnostic += chunk));
  const started = Date.now();
  const code = await runParticipantProcess({
    argv,
    input: new PassThrough(),
    output: new PassThrough(),
    error,
    watchdogMs: 5,
    loadMineflayer: () => new Promise(() => {}),
  });
  assert.equal(code, 1);
  assert.ok(Date.now() - started < 250);
  assert.equal(diagnostic, "participant failed\n");
});
