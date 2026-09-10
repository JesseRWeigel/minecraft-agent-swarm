import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getSandboxPolicyHash, runGeneratedSkillInSandbox } from "./generated-sandbox.js";

test("sandbox fails closed when bubblewrap is unavailable", async () => {
  await assert.rejects(
    runGeneratedSkillInSandbox({
      name: "fixtureSkill",
      code: Buffer.from("async function fixtureSkill() {}"),
      capabilityHandler: async () => ({}),
      bwrapPath: "/definitely/missing/bwrap",
      nodePath: process.execPath,
    }),
    /bubblewrap|ENOENT/i,
  );
});

test("sandbox policy fingerprint binds worker bytes, policy, limits, and schema", async () => {
  const base = await getSandboxPolicyHash({ workerSource: Buffer.from("worker-a") });
  const same = await getSandboxPolicyHash({ workerSource: Buffer.from("worker-a") });
  const workerChanged = await getSandboxPolicyHash({ workerSource: Buffer.from("worker-b") });
  const limitsChanged = await getSandboxPolicyHash({
    workerSource: Buffer.from("worker-a"),
    limits: { wallMs: 12_345 },
  });
  assert.equal(base, same);
  assert.notEqual(base, workerChanged);
  assert.notEqual(base, limitsChanged);

  const directory = await mkdtemp(path.join(os.tmpdir(), "swarm-node-identity-"));
  try {
    const alternateNodePath = path.join(directory, "node");
    await symlink(process.execPath, alternateNodePath);
    const runtimeIdentityChanged = await getSandboxPolicyHash({
      workerSource: Buffer.from("worker-a"),
      nodePath: alternateNodePath,
    });
    assert.notEqual(base, runtimeIdentityChanged);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sandbox rejects a stale expected policy before launcher or capability work", async () => {
  let calls = 0;
  await assert.rejects(
    runGeneratedSkillInSandbox({
      name: "fixtureSkill",
      code: Buffer.from("async function fixtureSkill(api) { await api.observe({}); }"),
      capabilityHandler: async () => {
        calls++;
        return {};
      },
      bwrapPath: "/definitely/missing/bwrap",
      nodePath: process.execPath,
      expectedPolicyHash: "0".repeat(64),
    }),
    /policy/i,
  );
  assert.equal(calls, 0);
});
