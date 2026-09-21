import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { createParticipantPipes } from "./participant-pipes.mjs";

const ids = { trialId: "trial-01", actionId: "walk-01" };
const message = (type) => ({ schema_version: 1, type, trial_id: ids.trialId, action_id: ids.actionId });
const line = (type) => `${JSON.stringify(message(type))}\n`;

test("adapts the exact ready/begin/action_finished/finalize exchange", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let written = "";
  output.on("data", (chunk) => (written += chunk));
  const pipes = createParticipantPipes({ input, output, ...ids });

  await pipes.sendMessage(message("ready"));
  const begin = pipes.waitForCommand();
  input.write(line("begin"));
  assert.deepEqual(await begin, message("begin"));
  await pipes.sendMessage(message("action_finished"));
  const finalize = pipes.waitForCommand();
  input.write(line("finalize"));
  assert.deepEqual(await finalize, message("finalize"));
  input.end();
  await pipes.close();
  assert.equal(written, line("ready") + line("action_finished"));
});

test("rejects malformed duplicate-key invalid-UTF8 and oversized input permanently", async () => {
  const badPayloads = [
    '{"schema_version":1,"type":"begin","type":"begin","trial_id":"trial-01","action_id":"walk-01"}\n',
    '{"schema_version":1,"type":"begin","trial_id":"trial-01"}\n',
    Buffer.from([0xff, 0x0a]),
    `${line("begin").replace(":1,", ":1,\v").trimEnd()}\n`,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(line("begin"))]),
    Buffer.alloc(513, 0x78),
  ];
  for (const payload of badPayloads) {
    const input = new PassThrough();
    const pipes = createParticipantPipes({ input, output: new PassThrough(), ...ids });
    await pipes.sendMessage(message("ready"));
    const pending = pipes.waitForCommand();
    input.write(payload);
    await assert.rejects(pending, /participant pipe failed/);
    await assert.rejects(() => pipes.waitForCommand(), /participant pipe failed/);
    await pipes.close().catch(() => {});
  }
});

test("rejects early extra duplicate and wrong-phase commands", async () => {
  for (const payload of [line("begin"), line("begin") + line("begin"), line("finalize")]) {
    const input = new PassThrough();
    const pipes = createParticipantPipes({ input, output: new PassThrough(), ...ids });
    if (payload !== line("begin")) await pipes.sendMessage(message("ready"));
    input.write(payload);
    if (payload === line("begin")) await new Promise((resolve) => setImmediate(resolve));
    else await assert.rejects(pipes.waitForCommand(), /participant pipe failed/);
    if (payload === line("begin"))
      await assert.rejects(() => pipes.sendMessage(message("ready")), /participant pipe failed/);
    await pipes.close().catch(() => {});
  }
});

test("enforces the total byte limit and sticky stream end/error", async () => {
  for (const terminate of [(input) => input.end(), (input) => input.destroy(new Error("secret transport detail"))]) {
    const input = new PassThrough();
    input.on("error", () => {});
    const pipes = createParticipantPipes({ input, output: new PassThrough(), ...ids });
    await pipes.sendMessage(message("ready"));
    const pending = pipes.waitForCommand();
    terminate(input);
    await assert.rejects(pending, /^Error: participant pipe failed$/);
    await pipes.close().catch(() => {});
  }

  const input = new PassThrough();
  const pipes = createParticipantPipes({ input, output: new PassThrough(), ...ids });
  input.write(Buffer.alloc(4090, 0x20));
  input.write(Buffer.alloc(7, 0x20));
  await assert.rejects(() => pipes.sendMessage(message("ready")), /participant pipe failed/);
  await pipes.close().catch(() => {});
});

test("waits for backpressure and treats output errors as sticky", async () => {
  let callback;
  const output = new Writable({
    write(_chunk, _encoding, done) {
      callback = done;
    },
  });
  const pipes = createParticipantPipes({ input: new PassThrough(), output, ...ids });
  let settled = false;
  const pending = pipes.sendMessage(message("ready")).finally(() => (settled = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  callback();
  await pending;
  output.destroy(new Error("secret output detail"));
  output.on("error", () => {});
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => pipes.waitForCommand(), /^Error: participant pipe failed$/);
  await pipes.close().catch(() => {});
});

test("accepts an immediate command response before the output callback", async () => {
  const input = new PassThrough();
  const output = new Writable({
    write(_chunk, _encoding, done) {
      input.write(line("begin"));
      done();
    },
  });
  const pipes = createParticipantPipes({ input, output, ...ids });
  await pipes.sendMessage(message("ready"));
  assert.deepEqual(await pipes.waitForCommand(), message("begin"));
  await pipes.close().catch(() => {});
});

test("rejects trailing data at completion and all use after close", async () => {
  const input = new PassThrough();
  const pipes = createParticipantPipes({ input, output: new PassThrough(), ...ids });
  await pipes.sendMessage(message("ready"));
  input.write(line("begin"));
  await pipes.waitForCommand();
  await pipes.sendMessage(message("action_finished"));
  input.write(line("finalize"));
  await pipes.waitForCommand();
  input.write("{");
  await assert.rejects(() => pipes.close(), /participant pipe failed/);
  await assert.rejects(() => pipes.sendMessage(message("ready")), /participant pipe failed/);
  await assert.rejects(() => pipes.waitForCommand(), /participant pipe failed/);
});
