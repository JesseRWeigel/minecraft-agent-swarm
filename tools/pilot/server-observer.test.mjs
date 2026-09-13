import assert from "node:assert/strict";
import { test } from "node:test";
import { collectServerObservation, validateRequest } from "./server-observer.mjs";
const req = {
  host: "127.0.0.1",
  port: 25585,
  trialId: "pilot-1",
  actionId: "action-1",
  botId: "Atlas",
  phase: "before",
  snapshotSha256: "a".repeat(64),
  serverVersion: "paper-test",
};
test("only isolated loopback endpoints and bounded identifiers are accepted", () => {
  for (const patch of [
    { port: 25575 },
    { host: "example.com" },
    { botId: "Atlas; op attacker" },
    { trialId: "x".repeat(129) },
    { snapshotSha256: "unknown" },
    { port: 1.2 },
    { phase: "arbitrary" },
    { trialId: 123 },
    { botId: 123 },
  ])
    assert.throws(() => validateRequest({ ...req, ...patch }));
  assert.doesNotThrow(() => validateRequest(req));
});
test("fixed read-only queries produce server-sourced position, not task success", async () => {
  const calls = [];
  const replies = [
    "Atlas has the following entity data: [1.5d, 64.0d, -2.0d]",
    'Atlas has the following entity data: "minecraft:overworld"',
    "Atlas has the following entity data: 20.0f",
    "Atlas has the following entity data: []",
  ];
  const report = await collectServerObservation(req, {
    send: async (command) => {
      calls.push(command);
      return replies.shift();
    },
  });
  assert.deepEqual(calls, [
    "data get entity Atlas Pos",
    "data get entity Atlas Dimension",
    "data get entity Atlas Health",
    "data get entity Atlas Inventory",
  ]);
  assert.deepEqual(report.state.position, { x: 1.5, y: 64, z: -2, dimension: "minecraft:overworld" });
  assert.equal(report.source, "minecraft_server_rcon");
  assert.equal(report.claimsTaskSuccess, false);
  assert.equal(report.rawCaptureComplete, true);
  assert.equal(report.navigationStateAvailable, true);
  assert.equal(report.queries.length, 4);
  assert.equal(report.queries[0].responseSha256.length, 64);
});
test("fluent claims, missing entities, nonfinite coordinates and wrong entity never become observed state", async () => {
  for (const response of [
    "Goal achieved!",
    "No entity was found",
    "Atlas has the following entity data: [1e999d, 64d, 0d]",
    "Other has the following entity data: [0d, 64d, 0d]",
  ]) {
    const report = await collectServerObservation(req, { send: async () => response });
    assert.equal(report.state.position, null);
    assert.equal(report.navigationStateAvailable, false);
    assert.equal(report.claimsTaskSuccess, false);
  }
});
test("oversize, transport failures and timeouts produce incomplete evidence without credentials", async () => {
  for (const send of [
    async () => {
      throw new Error("password-secret");
    },
    async () => "x".repeat(65537),
    () => new Promise(() => {}),
  ]) {
    const report = await collectServerObservation(req, { send }, { timeoutMs: 5 });
    assert.equal(report.rawCaptureComplete, false);
    assert.equal(report.queries.length, 1);
    assert.doesNotMatch(JSON.stringify(report), /password-secret/);
  }
});
test("snapshot identity is only asserted and captures are not atomic", async () => {
  const report = await collectServerObservation(req, { send: async () => "No entity was found" });
  assert.equal(report.identity.snapshotVerified, false);
  assert.equal(report.atomicSnapshot, false);
  assert.equal(report.state.inventoryParsed, false);
  assert.equal(report.claimsLiveBenchmarkResult, false);
});

test("CLI uses private exclusive outputs and fake RCON, preserving prior artifacts", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "observer-cli-"));
  try {
    const script = path.join(root, "server-observer.mjs");
    fs.copyFileSync(new URL("./server-observer.mjs", import.meta.url), script);
    const dep = path.join(root, "node_modules/rcon-client");
    fs.mkdirSync(dep, { recursive: true });
    fs.writeFileSync(path.join(dep, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
    fs.writeFileSync(
      path.join(dep, "index.js"),
      `export class Rcon {socket={destroy(){}};on(){};async connect(){};async send(command){const field=command.split(' ').at(-1);return 'Atlas has the following entity data: '+({Pos:'[0d, 64d, 0d]',Dimension:'"minecraft:overworld"',Health:'20f',Inventory:'[]'}[field]);}}`,
    );
    const output = path.join(root, "capture.json");
    const args = [
      script,
      "--observe",
      "--host",
      "127.0.0.1",
      "--port",
      "25585",
      "--trial",
      "pilot-1",
      "--action",
      "a-1",
      "--bot",
      "Atlas",
      "--phase",
      "before",
      "--snapshot",
      "a".repeat(64),
      "--version",
      "paper-test",
      "--output",
      output,
    ];
    const env = { ...process.env, PILOT_RCON_PASSWORD: "test-secret" };
    const run = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 5000 });
    assert.equal(run.status, 0, run.stderr);
    const original = fs.readFileSync(output);
    const report = JSON.parse(original);
    assert.equal(report.navigationStateAvailable, true);
    assert.equal(report.queries.length, 4);
    assert.doesNotMatch(original.toString(), /test-secret/);
    if (process.platform !== "win32") assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    const duplicate = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 5000 });
    assert.notEqual(duplicate.status, 0);
    assert.deepEqual(fs.readFileSync(output), original);
    const forbidden = path.join(root, "forbidden.json");
    const invalid = args.map((x) => (x === "25585" ? "25575" : x === output ? forbidden : x));
    assert.notEqual(spawnSync(process.execPath, invalid, { env, encoding: "utf8", timeout: 5000 }).status, 0);
    assert.equal(fs.existsSync(forbidden), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
