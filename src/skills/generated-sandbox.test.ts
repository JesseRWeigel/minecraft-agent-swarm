import assert from "node:assert/strict";
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
});
