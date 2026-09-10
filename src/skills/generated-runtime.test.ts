import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createGeneratedCandidate, promoteGeneratedCandidate, recordGeneratedVerification } from "./generated-store.js";
import { loadApprovedGeneratedSkills, verifyGeneratedCandidate } from "./generated-runtime.js";
import { clearGeneratedSkills, skillRegistry } from "./registry.js";

async function approvedFixture(policyHash = "policy-v1") {
  const root = await mkdtemp(path.join(os.tmpdir(), "swarm-generated-runtime-"));
  const candidate = await createGeneratedCandidate(root, {
    name: "approvedFixture",
    code: "async function approvedFixture(api) { return await api.observe({}); }",
    provenance: { kind: "generation", task: "fixture", model: "fixture-model" },
  });
  await recordGeneratedVerification(root, {
    candidateId: candidate.id,
    sha256: candidate.sha256,
    policyHash,
    passed: true,
    checks: [{ name: "isolated execution", passed: true }],
  });
  await promoteGeneratedCandidate(root, {
    candidateId: candidate.id,
    expectedSha256: candidate.sha256,
    policyHash,
  });
  return { root, candidate };
}

test("approved generated skills stay absent while the feature is disabled", async () => {
  const f = await approvedFixture();
  try {
    const loaded = await loadApprovedGeneratedSkills({
      enabled: false,
      root: f.root,
      policyHash: "policy-v1",
      bwrapPath: "/unused",
      nodePath: "/unused",
    });
    assert.deepEqual(loaded, []);
    assert.equal(skillRegistry.has("approvedFixture"), false);
  } finally {
    clearGeneratedSkills();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("only exact-policy approved skills register and execute through the isolated runner", async () => {
  const f = await approvedFixture();
  let capturedCode = "";
  try {
    const loaded = await loadApprovedGeneratedSkills({
      enabled: true,
      root: f.root,
      policyHash: "policy-v1",
      bwrapPath: "/fixture/bwrap",
      nodePath: "/fixture/node",
      runner: async (options) => {
        capturedCode = options.code.toString();
        return {
          success: true,
          value: "done",
          requests: 1,
          sha256: f.candidate.sha256,
          policyHash: "policy-v1",
        };
      },
    });
    assert.deepEqual(loaded, ["approvedFixture"]);
    const result = await skillRegistry
      .get("approvedFixture")!
      .execute({ entity: { position: { x: 0, y: 64, z: 0 } } } as any, {}, new AbortController().signal, () => {});
    assert.equal(result.success, true);
    assert.match(capturedCode, /api\.observe/);
  } finally {
    clearGeneratedSkills();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("stale-policy approvals fail closed instead of entering the registry", async () => {
  const f = await approvedFixture("old-policy");
  try {
    await assert.rejects(
      loadApprovedGeneratedSkills({
        enabled: true,
        root: f.root,
        policyHash: "new-policy",
        bwrapPath: "/unused",
        nodePath: "/unused",
      }),
      /different sandbox policy/i,
    );
    assert.equal(skillRegistry.has("approvedFixture"), false);
  } finally {
    clearGeneratedSkills();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("verification records the runner policy and exact candidate hash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "swarm-generated-verify-"));
  try {
    const candidate = await createGeneratedCandidate(root, {
      name: "verifyFixture",
      code: "async function verifyFixture() { return 'ok'; }",
      provenance: { kind: "generation", task: "fixture", model: "fixture-model" },
    });
    const verification = await verifyGeneratedCandidate({
      root,
      candidateId: candidate.id,
      bwrapPath: "/fixture/bwrap",
      nodePath: "/fixture/node",
      runner: async () => ({
        success: true,
        value: "ok",
        requests: 0,
        sha256: candidate.sha256,
        policyHash: "current-policy",
      }),
    });
    assert.equal(verification.passed, true);
    assert.equal(verification.sha256, candidate.sha256);
    assert.equal(verification.policyHash, "current-policy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
