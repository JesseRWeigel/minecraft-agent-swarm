import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runParticipantProcess } from "./oak-participant-cli.mjs";

const argv = ["--trial-id", "collect-oak-log-v1", "--action-id", "collect-01", "--movement", "stationary"];
const line = (type) =>
  `${JSON.stringify({ schema_version: 1, type, trial_id: "collect-oak-log-v1", action_id: "collect-01" })}\n`;

test("accepts only the fixed oak IDs and forwards stationary mode to its runner", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  let sent = 0;
  output.on("data", () => input.write(line(++sent === 1 ? "begin" : "finalize")));
  let options;
  const code = await runParticipantProcess({
    argv,
    input,
    output,
    error,
    loadMineflayer: async () => ({ createBot() {} }),
    run: async (value) => {
      options = value;
      await value.sendMessage(JSON.parse(line("ready")));
      await value.waitForCommand();
      await value.sendMessage(JSON.parse(line("action_finished")));
      await value.waitForCommand();
      return { schema_version: 1, status: "protocol_completed" };
    },
  });
  assert.equal(code, 0);
  assert.equal(options.movement, "stationary");
});

test("rejects non-oak IDs and arguments before dependency loading", async () => {
  let loaded = false;
  const error = new PassThrough();
  error.setEncoding("utf8");
  let diagnostic = "";
  error.on("data", (chunk) => (diagnostic += chunk));
  const code = await runParticipantProcess({
    argv: [...argv.slice(0, 1), "other", ...argv.slice(2)],
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
});
