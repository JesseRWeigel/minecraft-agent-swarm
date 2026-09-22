import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough, Writable } from "node:stream";
import { runModelActionChannel } from "./model-action-channel.mjs";
const line = (kind = "observe", sequence = 1) =>
  Buffer.from(
    JSON.stringify({
      schema_version: 1,
      trial_id: "collect-oak-log-v1",
      action_id: "collect-01",
      sequence,
      action: { kind },
    }) + "\n",
  );
function fixture(execute) {
  const input = new PassThrough(),
    output = new PassThrough();
  let closed = 0;
  const calls = [];
  const session = {
    execute: async (raw) => {
      calls.push(Buffer.from(raw));
      if (execute) return execute(raw);
      const x = JSON.parse(raw);
      return { schema_version: 1, sequence: x.sequence, status: x.action.kind === "finish" ? "finished" : "completed" };
    },
    close: () => closed++,
  };
  return {
    input,
    output,
    session,
    calls,
    get closed() {
      return closed;
    },
  };
}
test("fragmented frame and finish EOF produce only action replies", async () => {
  const f = fixture();
  let reply = "";
  f.output.on("data", (x) => (reply += x));
  const done = runModelActionChannel({ ...f, timeoutMs: 200 });
  const raw = line("finish");
  f.input.write(raw.subarray(0, 11));
  f.input.end(raw.subarray(11));
  const result = await done;
  assert.equal(result.status, "finished");
  assert.equal(result.requests, 1);
  assert.equal(f.closed, 0);
  assert.deepEqual(JSON.parse(reply), { schema_version: 1, sequence: 1, status: "finished" });
});
test("rejects oversized frames, multiple pipelined frames and partial EOF", async () => {
  for (const bytes of [Buffer.alloc(4097, 32), Buffer.concat([line(), line("finish", 2)]), Buffer.from("{partial")]) {
    const f = fixture();
    const done = runModelActionChannel({ ...f, timeoutMs: 100 });
    const rejected = assert.rejects(done, /model action channel failed/);
    f.input.end(bytes);
    await rejected;
    assert.equal(f.closed, 1);
  }
});
test("input during a pending action cancels it and late completion writes nothing", async () => {
  let release;
  const f = fixture(() => new Promise((r) => (release = r)));
  let bytes = 0;
  f.output.on("data", (b) => (bytes += b.length));
  const rejected = assert.rejects(runModelActionChannel({ ...f, timeoutMs: 100 }));
  f.input.write(line());
  await Promise.resolve();
  f.input.write(line("finish", 2));
  await rejected;
  release({ schema_version: 1, sequence: 1, status: "completed" });
  await Promise.resolve();
  assert.equal(bytes, 0);
  assert.equal(f.closed, 1);
});
test("one next frame may wait for a reply callback without overlapping execution", async () => {
  const f = fixture();
  let flush;
  let writes = 0;
  const output = new Writable({
    write(chunk, encoding, callback) {
      writes++;
      if (writes === 1) {
        f.input.write(line("finish", 2));
        flush = callback;
      } else callback();
    },
  });
  const done = runModelActionChannel({ ...f, output, timeoutMs: 200 });
  f.input.write(line());
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls.length, 1);
  flush();
  f.input.end();
  assert.equal((await done).requests, 2);
  assert.equal(f.calls.length, 2);
});
test("deadline covers idle input, blocked reply and missing finish EOF", async () => {
  for (const which of ["idle", "write", "eof"]) {
    const f = fixture();
    const output = which === "write" ? new Writable({ write() {} }) : f.output;
    const rejected = assert.rejects(runModelActionChannel({ ...f, output, timeoutMs: 20 }));
    if (which !== "idle") f.input.write(line("finish"));
    await rejected;
    assert.equal(f.closed, 1);
  }
});
test("trailing bytes after finish and stream errors cannot complete", async () => {
  for (const which of ["tail", "input", "output"]) {
    const f = fixture();
    const rejected = assert.rejects(runModelActionChannel({ ...f, timeoutMs: 100 }));
    if (which === "tail") {
      f.output.once("data", () => f.input.end(line("finish", 2)));
      f.input.write(line("finish"));
    } else f[which].emit("error", new Error("secret-detail"));
    await rejected;
    assert.equal(f.closed, 1);
  }
});
test("bad or oversized reply cannot escape the bounded action envelope", async () => {
  for (const response of [
    { schema_version: 1, sequence: 1, status: "completed", secret: "hidden" },
    {
      schema_version: 1,
      sequence: 1,
      status: "completed",
      observation: { source: "participant_bot", text: "x".repeat(21000) },
    },
  ]) {
    const f = fixture(async () => response);
    let bytes = 0;
    f.output.on("data", (b) => (bytes += b.length));
    const rejected = assert.rejects(runModelActionChannel({ ...f, timeoutMs: 100 }));
    f.input.write(line());
    await rejected;
    assert.equal(bytes, 0);
  }
});

test("fragmented next frame survives the prior reply callback", async () => {
  const f = fixture();
  let flush,
    writes = 0;
  const next = line("finish", 2);
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (++writes === 1) {
        f.input.write(next.subarray(0, 15));
        flush = callback;
      } else callback();
    },
  });
  const done = runModelActionChannel({ ...f, output, timeoutMs: 200 });
  f.input.write(line());
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls.length, 1);
  flush();
  assert.equal(f.calls.length, 1);
  f.input.end(next.subarray(15));
  assert.equal((await done).requests, 2);
});

test("real subprocess pipes carry a complete session and reject lifecycle input", { timeout: 10000 }, async () => {
  const { spawn } = await import("node:child_process");
  const { createInterface } = await import("node:readline");
  const channelUrl = new URL("./model-action-channel.mjs", import.meta.url).href;
  const sessionUrl = new URL("./model-action-session.mjs", import.meta.url).href;
  const source = `
 import {EventEmitter} from 'node:events';
 import {runModelActionChannel} from ${JSON.stringify(channelUrl)};
 import {createModelActionSession} from ${JSON.stringify(sessionUrl)};
 const b=new EventEmitter();
 b.entity={position:{x:0.5,y:200,z:0.5,clone(){return {set(x,y,z){return {x,y,z};}};}},yaw:0,pitch:0};
 b.health=20;b.inventory={slots:[]};
 const block={name:'oak_log',position:{x:0,y:200,z:3}};
 b.blockAt=b.blockAtCursor=()=>block;b.canDigBlock=()=>true;
 b.look=b.dig=async()=>{};b.setControlState=b.clearControlStates=b.stopDigging=b.end=()=>{};
 const session=createModelActionSession({bot:b});
 try {await runModelActionChannel({input:process.stdin,output:process.stdout,session,timeoutMs:3000});}
 catch {process.exitCode=2;} finally {session.close();process.stdin.destroy();}
 `;
  for (const invalid of [false, true]) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["pipe", "pipe", "pipe"] });
    const exit = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 4500);
    let stderr = "";
    child.stderr.on("data", (b) => {
      stderr += b;
      if (stderr.length > 4096) child.kill("SIGKILL");
    });
    child.stdin.on("error", () => {});
    const rl = createInterface({ input: child.stdout });
    const replies = [];
    const actions = [
      { kind: "observe" },
      { kind: "look", yaw: 0, pitch: 0 },
      { kind: "dig", x: 0, y: 200, z: 3 },
      { kind: "move", direction: "forward", ticks: 1 },
      { kind: "finish" },
    ];
    const send = () =>
      child.stdin.write(
        JSON.stringify({
          schema_version: 1,
          trial_id: "collect-oak-log-v1",
          action_id: "collect-01",
          sequence: replies.length + 1,
          action: actions[replies.length],
        }) + "\n",
      );
    try {
      if (invalid) child.stdin.end('{"type":"begin"}\n');
      else send();
      for await (const raw of rl) {
        assert.ok(raw.length <= 20480);
        const reply = JSON.parse(raw);
        replies.push(reply);
        assert.equal(reply.sequence, replies.length);
        if (replies.length === actions.length) child.stdin.end();
        else send();
      }
      assert.deepEqual(await exit, { code: invalid ? 2 : 0, signal: null });
      assert.equal(stderr, "");
      assert.equal(replies.length, invalid ? 0 : 5);
      if (!invalid) {
        assert.equal(replies[0].observation.source, "participant_bot");
        assert.equal(replies.at(-1).status, "finished");
      }
    } finally {
      clearTimeout(watchdog);
      rl.close();
      if (child.exitCode === null) child.kill("SIGKILL");
      await exit;
    }
  }
});

test("outer cancellation rejects idle channel and suppresses subsequent input", async () => {
  const f = fixture(),
    controller = new AbortController();
  let bytes = 0;
  f.output.on("data", (b) => (bytes += b.length));
  const rejected = assert.rejects(runModelActionChannel({ ...f, signal: controller.signal }));
  controller.abort();
  assert.equal(f.closed, 1);
  await rejected;
  f.input.end(line("finish"));
  assert.equal(bytes, 0);
  assert.equal(f.closed, 1);
  assert.equal(f.calls.length, 0);
  const g = fixture();
  await assert.rejects(runModelActionChannel({ ...g, signal: controller.signal }));
  assert.equal(g.closed, 1);
});
