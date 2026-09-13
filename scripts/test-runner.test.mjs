import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runTestProcess } from "./test-runner.mjs";

const fixture = path.resolve("scripts/fixtures/telemetry-child.test.mjs");

function runFixture(shouldFail, testArgs = []) {
  const parentDatasetDir = mkdtempSync(path.join(tmpdir(), "real-dataset-sentinel-"));
  const sentinel = path.join(parentDatasetDir, "do-not-touch.jsonl");
  const original = "production-like telemetry\n";
  writeFileSync(sentinel, original);

  try {
    const result = runTestProcess({
      testFiles: [fixture],
      testArgs,
      env: {
        ...process.env,
        DATASET_EVENT_DIR: parentDatasetDir,
        DATASET_OPERATION_MODE: "live",
        DATASET_TRIAL_ID: "real-trial",
        DATASET_GIT_COMMIT: "a".repeat(40),
        DATASET_DIRTY_DIFF_HASH: "b".repeat(64),
        DATASET_WORLD_SNAPSHOT_ID: "real-world",
        SWARM_LAUNCH_CONTEXT_JSON: "real-context-must-not-propagate",
        CHILD_EXPECT_PARENT_DATASET_DIR: parentDatasetDir,
        CHILD_SHOULD_FAIL: shouldFail ? "1" : "0",
      },
      stdio: "pipe",
    });

    assert.equal(readFileSync(sentinel, "utf8"), original);
    assert.deepEqual(readdirSync(parentDatasetDir), ["do-not-touch.jsonl"]);
    assert.equal(existsSync(result.scratchDir), false);
    return result;
  } finally {
    rmSync(parentDatasetDir, { recursive: true, force: true });
  }
}

test("isolates default-recorder writes and removes its scratch directory after success", () => {
  const result = runFixture(false);
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
});

test("isolates default-recorder writes and removes its scratch directory after child failure", () => {
  const result = runFixture(true);
  assert.notEqual(result.status, 0);
  assert.equal(result.signal, null);
});

test("forwards Node test options without treating them as file paths", () => {
  const result = runFixture(true, ["--test-name-pattern", "does-not-match-fixture"]);
  assert.equal(result.status, 0);
});
