import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createGeneratedCandidate,
  getGeneratedPaths,
  promoteGeneratedCandidate,
  readApprovedGeneratedSkill,
  readGeneratedCandidate,
  recordGeneratedVerification,
  rollbackGeneratedSkill,
} from "./generated-store.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "swarm-generated-store-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const provenance = { kind: "generation" as const, task: "count supplies", model: "fixture-model" };

test("candidate bytes are immutable, content-addressed, and not installed by name", async () => {
  const f = await fixture();
  try {
    const code = "async function countSupplies(api) { await api.observe({}); }";
    const first = await createGeneratedCandidate(f.root, { name: "countSupplies", code, provenance });
    const second = await createGeneratedCandidate(f.root, { name: "countSupplies", code, provenance });
    const paths = getGeneratedPaths(f.root);

    assert.notEqual(first.id, second.id);
    assert.equal(first.sha256, second.sha256);
    assert.equal(await readFile(path.join(paths.blobs, `${first.sha256}.js`), "utf8"), code);
    await assert.rejects(readFile(path.join(f.root, "countSupplies.js"), "utf8"));
    assert.deepEqual((await readGeneratedCandidate(f.root, first.id)).provenance, provenance);
  } finally {
    await f.cleanup();
  }
});

test("candidate names reject traversal and every trusted-name collision", async () => {
  const f = await fixture();
  try {
    for (const name of ["../escape", "bad-name", "constructor", "build_house"]) {
      await assert.rejects(
        createGeneratedCandidate(f.root, {
          name,
          code: "async function candidate() {}",
          provenance,
          reservedNames: new Set(["build_house"]),
        }),
        /name|reserved/i,
      );
    }
  } finally {
    await f.cleanup();
  }
});

test("promotion requires successful checks for the exact expected candidate hash", async () => {
  const f = await fixture();
  try {
    const candidate = await createGeneratedCandidate(f.root, {
      name: "safeCandidate",
      code: "async function safeCandidate(api) { await api.observe({}); }",
      provenance,
    });
    await assert.rejects(
      promoteGeneratedCandidate(f.root, {
        candidateId: candidate.id,
        expectedSha256: candidate.sha256,
        policyHash: "policy-v1",
      }),
      /verification/i,
    );

    await recordGeneratedVerification(f.root, {
      candidateId: candidate.id,
      sha256: candidate.sha256,
      policyHash: "policy-v1",
      passed: false,
      checks: [{ name: "sandbox execution", passed: false, detail: "candidate threw" }],
    });
    await assert.rejects(
      promoteGeneratedCandidate(f.root, {
        candidateId: candidate.id,
        expectedSha256: candidate.sha256,
        policyHash: "policy-v1",
      }),
      /did not pass/i,
    );

    await assert.rejects(
      promoteGeneratedCandidate(f.root, {
        candidateId: candidate.id,
        expectedSha256: "0".repeat(64),
        policyHash: "policy-v1",
      }),
      /hash/i,
    );
  } finally {
    await f.cleanup();
  }
});

test("promotion rejects bytes changed after verification and loads only hash-matching approved bytes", async () => {
  const f = await fixture();
  try {
    const candidate = await createGeneratedCandidate(f.root, {
      name: "verifiedCandidate",
      code: "async function verifiedCandidate(api) { await api.observe({}); }",
      provenance,
    });
    await recordGeneratedVerification(f.root, {
      candidateId: candidate.id,
      sha256: candidate.sha256,
      policyHash: "policy-v1",
      passed: true,
      checks: [{ name: "sandbox execution", passed: true }],
    });
    const blob = path.join(getGeneratedPaths(f.root).blobs, `${candidate.sha256}.js`);
    await chmod(blob, 0o600);
    await writeFile(blob, "async function verifiedCandidate() { throw new Error('changed'); }");

    await assert.rejects(
      promoteGeneratedCandidate(f.root, {
        candidateId: candidate.id,
        expectedSha256: candidate.sha256,
        policyHash: "policy-v1",
      }),
      /hash/i,
    );
  } finally {
    await f.cleanup();
  }
});

test("promotion is exclusive, preserves history, and rollback restores the previous verified hash", async () => {
  const f = await fixture();
  try {
    const make = async (body: string) => {
      const candidate = await createGeneratedCandidate(f.root, {
        name: "evolvingSkill",
        code: `async function evolvingSkill(api) { ${body} }`,
        provenance,
      });
      await recordGeneratedVerification(f.root, {
        candidateId: candidate.id,
        sha256: candidate.sha256,
        policyHash: "policy-v1",
        passed: true,
        checks: [{ name: "sandbox execution", passed: true }],
      });
      return candidate;
    };
    const first = await make("await api.observe({});");
    const second = await make("await api.wait({ ticks: 1 });");

    await promoteGeneratedCandidate(f.root, {
      candidateId: first.id,
      expectedSha256: first.sha256,
      policyHash: "policy-v1",
    });
    await promoteGeneratedCandidate(f.root, {
      candidateId: second.id,
      expectedSha256: second.sha256,
      policyHash: "policy-v1",
    });
    assert.equal((await readApprovedGeneratedSkill(f.root, "evolvingSkill", "policy-v1")).sha256, second.sha256);
    await assert.rejects(readApprovedGeneratedSkill(f.root, "evolvingSkill", "policy-v2"), /different sandbox policy/);

    await assert.rejects(rollbackGeneratedSkill(f.root, "evolvingSkill", "policy-v2"), /different sandbox policy/);
    await rollbackGeneratedSkill(f.root, "evolvingSkill", "policy-v1");
    const restored = await readApprovedGeneratedSkill(f.root, "evolvingSkill", "policy-v1");
    assert.equal(restored.sha256, first.sha256);
    assert.match(restored.code, /observe/);
  } finally {
    await f.cleanup();
  }
});

async function verifiedVersion(root: string, body: string) {
  const candidate = await createGeneratedCandidate(root, {
    name: "reviewedSkill",
    code: `async function reviewedSkill(api) { ${body} }`,
    provenance,
  });
  await recordGeneratedVerification(root, {
    candidateId: candidate.id,
    sha256: candidate.sha256,
    policyHash: "review-policy",
    passed: true,
    checks: [{ name: "isolated execution", passed: true }],
  });
  await promoteGeneratedCandidate(root, {
    candidateId: candidate.id,
    expectedSha256: candidate.sha256,
    policyHash: "review-policy",
  });
  return candidate;
}

test("failed re-verification revokes loading and rollback without changing the manifest", async () => {
  const f = await fixture();
  try {
    const first = await verifiedVersion(f.root, "await api.observe({});");
    await recordGeneratedVerification(f.root, {
      candidateId: first.id,
      sha256: first.sha256,
      policyHash: "review-policy",
      passed: false,
      checks: [{ name: "isolated execution", passed: false }],
    });
    await assert.rejects(readApprovedGeneratedSkill(f.root, "reviewedSkill", "review-policy"), /verification/i);
    const second = await verifiedVersion(f.root, "await api.wait({ ticks: 1 });");
    const before = await readFile(getGeneratedPaths(f.root).manifest, "utf8");
    await assert.rejects(rollbackGeneratedSkill(f.root, "reviewedSkill", "review-policy"), /verification/i);
    assert.equal(await readFile(getGeneratedPaths(f.root).manifest, "utf8"), before);
    assert.equal((await readApprovedGeneratedSkill(f.root, "reviewedSkill", "review-policy")).sha256, second.sha256);
  } finally {
    await f.cleanup();
  }
});

test("approved loading checks candidate name and verification linkage", async () => {
  const f = await fixture();
  try {
    const candidate = await verifiedVersion(f.root, "await api.observe({});");
    const paths = getGeneratedPaths(f.root);
    const candidatePath = path.join(paths.candidates, `${candidate.id}.json`);
    await writeFile(candidatePath, JSON.stringify({ ...candidate, name: "otherSkill" }));
    await assert.rejects(readApprovedGeneratedSkill(f.root, "reviewedSkill", "review-policy"), /candidate|name/i);
    await writeFile(candidatePath, JSON.stringify(candidate));
    const recordPath = path.join(paths.verifications, `${candidate.id}.json`);
    const original = JSON.parse(await readFile(recordPath, "utf8"));
    for (const change of [
      { version: 2 },
      { candidateId: "wrong" },
      { sha256: "0".repeat(64) },
      { policyHash: "old-policy" },
      { passed: "true" },
      { checks: [{ name: "check", passed: "true" }] },
    ]) {
      await writeFile(recordPath, JSON.stringify({ ...original, ...change }));
      await assert.rejects(readApprovedGeneratedSkill(f.root, "reviewedSkill", "review-policy"), /verification/i);
    }
  } finally {
    await f.cleanup();
  }
});

test("approved loading rejects oversized blob files", async () => {
  const f = await fixture();
  try {
    const candidate = await verifiedVersion(f.root, "await api.observe({});");
    const blob = path.join(getGeneratedPaths(f.root).blobs, `${candidate.sha256}.js`);
    await chmod(blob, 0o600);
    await writeFile(blob, Buffer.alloc(65537, 32));
    await assert.rejects(readApprovedGeneratedSkill(f.root, "reviewedSkill", "review-policy"), /exceeds/);
  } finally {
    await f.cleanup();
  }
});
