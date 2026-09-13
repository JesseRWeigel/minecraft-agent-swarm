import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { currentCollectionContext, getEpisodeEventRecorder } from "../../src/data/episode-events.js";

test("default telemetry recorder uses the test runner scratch directory", () => {
  const isolatedDir = path.resolve(process.env.DATASET_EVENT_DIR ?? "");
  const parentDir = path.resolve(process.env.CHILD_EXPECT_PARENT_DATASET_DIR ?? "");
  assert.notEqual(isolatedDir, parentDir);

  const recorder = getEpisodeEventRecorder();
  recorder.record(
    {
      episodeId: "test-runner-fixture",
      botId: "fixture",
      actionId: null,
      requestId: null,
      kind: "observation",
    },
    { fixture: true },
  );

  assert.equal(recorder.rootDir, isolatedDir);
  assert.deepEqual(currentCollectionContext(), {
    operationMode: "test",
    trialId: null,
    gitCommit: null,
    dirtyDiffHash: null,
    worldSnapshotId: null,
  });
  assert.equal(existsSync(recorder.eventPath), true);
  assert.ok(readdirSync(isolatedDir, { recursive: true }).length > 0);

  if (process.env.CHILD_SHOULD_FAIL === "1") {
    assert.fail("intentional child failure after telemetry write");
  }
});
