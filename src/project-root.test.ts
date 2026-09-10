import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveProjectRoot } from "./project-root.js";

test("project root resolves from source and bundled module directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "swarm-root-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "minecraft-agent-swarm" }));
    await Promise.all([
      mkdir(path.join(root, "src", "skills"), { recursive: true }),
      mkdir(path.join(root, "dist"), { recursive: true }),
    ]);
    assert.equal(resolveProjectRoot(path.join(root, "src", "skills"), "/unrelated"), root);
    assert.equal(resolveProjectRoot(path.join(root, "dist"), "/unrelated"), root);
    assert.equal(resolveProjectRoot("/unrelated/module", root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project root resolution fails closed outside this package", () => {
  assert.throws(() => resolveProjectRoot("/definitely/not/a/project", "/also/not/a/project"), /Could not locate/);
});
