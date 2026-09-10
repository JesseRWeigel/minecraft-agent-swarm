import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runGeneratedSkillInSandbox } from "./generated-sandbox.js";

const bwrapPath =
  process.env.GENERATED_SKILLS_BWRAP || "/home/jesse/Projects/.audit-fixes/sandbox-tools/runtime/usr/bin/bwrap";

const run = (name: string, code: string | Buffer, wallMs = 4_000) =>
  runGeneratedSkillInSandbox({
    name,
    code,
    capabilityHandler: async (method, params) => {
      if (method === "observe") {
        return {
          position: { x: 0, y: 64, z: 0 },
          health: 20,
          food: 20,
          inventory: [],
          blocks: ((params as { blocks?: string[] }).blocks ?? []).map((block) => ({
            name: block,
            position: { x: 1, y: 64, z: 1 },
          })),
          entities: [],
        };
      }
      return { ok: true };
    },
    bwrapPath,
    nodePath: process.execPath,
    limits: { wallMs },
  });

test("qualified sandbox runs exact captured bytes and bounded capability RPC", async () => {
  const bytes = Buffer.from(
    "async function exactBytes(api) { return await api.observe({ blocks: ['oak_log'], radius: 8 }); }",
  );
  const pending = run("exactBytes", bytes);
  bytes.fill(0x78);
  const result = await pending;
  assert.equal(result.success, true);
  assert.equal((result.value as any).blocks[0].name, "oak_log");
  assert.equal(result.requests, 1);
});

test("qualified sandbox denies host files, processes, host loopback, and inherited secrets", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "swarm-sandbox-secret-"));
  const secretPath = path.join(outside, "secret.txt");
  await writeFile(secretPath, "sandbox-must-not-read-this");
  let hostConnections = 0;
  const server = net.createServer((socket) => {
    hostConnections++;
    socket.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.SWARM_SANDBOX_CANARY = "must-not-cross";

  const code = `
    async function denialProbe(api) {
      const proc = api.observe.constructor.constructor("return process")();
      const fs = proc.getBuiltinModule("fs");
      const cp = proc.getBuiltinModule("child_process");
      const net = proc.getBuiltinModule("net");
      let fileError = "";
      try { fs.readFileSync(${JSON.stringify(secretPath)}, "utf8"); } catch (error) { fileError = error.code || error.message; }
      let childError = "";
      try {
        const child = cp.spawnSync("/sandbox/node", ["--version"]);
        childError = child.error && (child.error.code || child.error.message);
      } catch (error) {
        childError = error.code || error.message;
      }
      const networkError = await new Promise((resolve) => {
        const socket = net.connect(${address.port}, "127.0.0.1");
        socket.once("connect", () => { socket.destroy(); resolve("CONNECTED"); });
        socket.once("error", (error) => resolve(error.code || error.message));
      });
      return {
        fileError,
        childError,
        networkError,
        canary: proc.env.SWARM_SANDBOX_CANARY || null
      };
    }
  `;
  try {
    const result = await run("denialProbe", code);
    assert.equal(result.success, true, result.error);
    const value = result.value as any;
    assert.match(String(value.fileError), /ENOENT|ERR_ACCESS_DENIED/);
    assert.match(String(value.childError), /EPERM|permission|ERR_ACCESS_DENIED/i);
    assert.notEqual(value.networkError, "CONNECTED");
    assert.equal(value.canary, null);
    assert.equal(hostConnections, 0);
  } finally {
    delete process.env.SWARM_SANDBOX_CANARY;
    server.close();
    await rm(outside, { recursive: true, force: true });
  }
});

test("qualified sandbox kills CPU and memory exhaustion without poisoning the next worker", async () => {
  await assert.rejects(
    run("cpuLoop", "async function cpuLoop() { while (true) {} }", 3_000),
    /exited|signal|timed out/i,
  );
  try {
    const memory = await run(
      "memoryLoop",
      `async function memoryLoop(api) {
          const proc = api.observe.constructor.constructor("return process")();
          const chunks = [];
          while (true) chunks.push(proc.getBuiltinModule("buffer").Buffer.alloc(8 * 1024 * 1024, 1));
        }`,
      4_000,
    );
    assert.equal(memory.success, false);
    assert.match(memory.error ?? "", /alloc|memory|buffer/i);
  } catch (error) {
    assert.match((error as Error).message, /alloc|memory|heap|exited|signal/i);
  }
  assert.equal((await run("stillHealthy", "async function stillHealthy() { return 'ok'; }")).value, "ok");
});

test("qualified sandbox rejects forged completion and success followed by a crash", async () => {
  await assert.rejects(
    run(
      "forgedCompletion",
      `async function forgedCompletion(api) {
        const proc = api.observe.constructor.constructor("return process")();
        proc.stdout.write('{"type":"result","success":true,"value":"forged"}\\n');
        proc.exit(0);
      }`,
    ),
    /protocol|result|token|exited/i,
  );
  await assert.rejects(
    run(
      "doneThenCrash",
      `async function doneThenCrash(api) {
        const proc = api.observe.constructor.constructor("return process")();
        proc.exitCode = 9;
        return "claimed success";
      }`,
    ),
    /exited|code=9/i,
  );
});

test("qualified sandbox admits a bounded queue and performs no capability work after termination", async () => {
  const calls: string[] = [];
  const code = `async function queuedCalls(api) {
    const proc = api.observe.constructor.constructor("return process")();
    proc.stdout.write(
      Array.from({ length: 100 }, (_, index) =>
        JSON.stringify({ type: "request", id: 1000 + index, method: "observe", params: {} })
      ).join("\\n") + "\\n"
    );
    await new Promise(() => {});
  }`;
  await assert.rejects(
    runGeneratedSkillInSandbox({
      name: "queuedCalls",
      code,
      capabilityHandler: async (method) => {
        calls.push(method);
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {};
      },
      bwrapPath,
      nodePath: process.execPath,
      limits: { wallMs: 200, maxRequests: 2 },
    }),
    /quota|protocol|timed out/i,
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(calls.length <= 1, `capability work continued after termination: ${calls.length} calls`);
});

test("qualified sandbox bounds stderr output and rejects protocol messages after a result", async () => {
  await assert.rejects(
    runGeneratedSkillInSandbox({
      name: "stderrFlood",
      code: `async function stderrFlood(api) {
        const proc = api.observe.constructor.constructor("return process")();
        while (true) proc.stderr.write("x".repeat(65536));
      }`,
      capabilityHandler: async () => ({}),
      bwrapPath,
      nodePath: process.execPath,
      limits: { wallMs: 3_000, maxMessageBytes: 4_096 },
    }),
    /stderr output limit/i,
  );

  const token = "a".repeat(64);
  const maliciousWorker = Buffer.from(`
    process.stdout.write(JSON.stringify({ type: "ready", token: "${token}" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", token: "${token}", success: true }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "request", id: 1, method: "observe", params: {} }) + "\\n");
  `);
  let calls = 0;
  await assert.rejects(
    runGeneratedSkillInSandbox({
      name: "messageAfterResult",
      code: "async function messageAfterResult() {}",
      capabilityHandler: async () => {
        calls++;
        return {};
      },
      bwrapPath,
      nodePath: process.execPath,
      workerSource: maliciousWorker,
    }),
    /after its terminal result/i,
  );
  assert.equal(calls, 0);
});

test("qualified sandbox applies the task limit inside its user namespace", async () => {
  const result = await run(
    "taskLimit",
    `async function taskLimit(api) {
      const proc = api.observe.constructor.constructor("return process")();
      return proc.report.getReport().userLimits.max_user_processes;
    }`,
  );
  assert.equal(result.success, true, result.error);
  assert.deepEqual(result.value, { soft: 64, hard: 64 });
  assert.equal(
    (await run("healthyAfterTaskLimit", "async function healthyAfterTaskLimit() { return 'ok'; }")).value,
    "ok",
  );
});
