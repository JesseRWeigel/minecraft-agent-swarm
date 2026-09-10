import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getGeneratedPaths, readGeneratedCandidate } from "./generated-store.js";
import { saveGeneratedSkill } from "./generator.js";

test("saveGeneratedSkill quarantines exact bytes with provenance instead of installing name.js", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "swarm-generator-"));
  try {
    const code = "async function myTestSkill(api) { await api.observe({}); }";
    const candidate = await saveGeneratedSkill("myTestSkill", code, {
      root,
      provenance: { kind: "generation", task: "test task", model: "fixture-model" },
    });

    assert.equal(candidate.name, "myTestSkill");
    assert.equal((await readGeneratedCandidate(root, candidate.id)).sha256, candidate.sha256);
    assert.equal(await readFile(path.join(getGeneratedPaths(root).blobs, `${candidate.sha256}.js`), "utf8"), code);
    await assert.rejects(readFile(path.join(root, "myTestSkill.js"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saveGeneratedSkill refuses to shadow any trusted built-in or Voyager name", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "swarm-generator-"));
  try {
    await assert.rejects(
      saveGeneratedSkill("build_house", "async function build_house() {}", {
        root,
        provenance: { kind: "generation", task: "shadow built in", model: "fixture-model" },
      }),
      /reserved/i,
    );
    await assert.rejects(
      saveGeneratedSkill("craftWoodenPickaxe", "async function craftWoodenPickaxe() {}", {
        root,
        provenance: { kind: "generation", task: "shadow Voyager", model: "fixture-model" },
      }),
      /reserved/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
