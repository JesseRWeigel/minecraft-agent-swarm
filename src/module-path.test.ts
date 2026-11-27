import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolveModulePath } from "./module-path.js";

test("module-relative paths decode a checkout directory that contains a space", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm module path-"));
  try {
    const moduleUrl = pathToFileURL(path.join(root, "src", "skills", "find-fortress.ts"));
    const sightingFile = resolveModulePath(moduleUrl, "../../logs/fortress-sighting.json");
    assert.equal(sightingFile, path.join(root, "logs", "fortress-sighting.json"));
    fs.mkdirSync(path.dirname(sightingFile), { recursive: true });
    fs.writeFileSync(sightingFile, "{}");
    assert.equal(fs.readFileSync(sightingFile, "utf8"), "{}");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
