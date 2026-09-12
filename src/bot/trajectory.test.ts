import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { EpisodeEventRecorder } from "../data/episode-events.js";
import { createTrajectoryRecorder, type TrajectoryEntryInput } from "./trajectory.js";

const ENTRY: TrajectoryEntryInput = {
  schemaVersion: 2,
  bot: "Atlas",
  requestId: "request-1",
  actionId: "action-1",
  decision: { thought: "go", action: "explore", params: {} },
  outcome: {
    actionId: "action-1",
    status: "unknown",
    reasonCode: "unverified_builtin_result",
    resultText: "Arrived.",
    evidenceRefs: [],
  },
  model: {
    origin: "provider",
    provider: "ollama",
    model: "local-model",
    providerModel: null,
    providerRequestId: null,
    durationMs: 12,
    usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null },
  },
  timestamp: "2026-09-12T00:00:00.000Z",
};

test("writes version two outcomes in a separate append-only trajectory directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "trajectory-v2-"));
  const recorder = createTrajectoryRecorder(root, "session-a");
  recorder(ENTRY);

  const line = JSON.parse(readFileSync(path.join(root, "trajectories-v2", "session-a.jsonl"), "utf8").trim());
  assert.equal(line.schemaVersion, 2);
  assert.equal(line.outcome.status, "unknown");
  assert.equal(line.requestId, "request-1");
  assert.equal(line.actionId, "action-1");
  assert.equal(line.success, undefined);
  assert.equal(line.system, undefined);
  assert.equal(line.context, undefined);
});

test("persists the event-store health snapshot after action capture", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "trajectory-health-"));
  const blockedRoot = path.join(scratch, "event-root-is-a-file");
  writeFileSync(blockedRoot, "occupied");
  const eventRecorder = new EpisodeEventRecorder({ rootDir: blockedRoot, runId: "health-run" });
  eventRecorder.record(
    {
      botId: "Atlas",
      episodeId: "health-run:Atlas",
      actionId: "action-1",
      requestId: "request-1",
      kind: "action_finished",
    },
    { outcome: ENTRY.outcome },
  );
  assert.equal(eventRecorder.health.complete, false);

  const recorder = createTrajectoryRecorder(scratch, "session-health", eventRecorder);
  recorder(ENTRY);
  const line = JSON.parse(readFileSync(path.join(scratch, "trajectories-v2", "session-health.jsonl"), "utf8").trim());
  assert.equal(line.telemetry.runId, "health-run");
  assert.equal(line.telemetry.complete, false);
  assert.match(line.telemetry.lastError, /incomplete/);
});

test("a trajectory write failure marks the shared telemetry health incomplete", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "trajectory-write-failure-"));
  const eventRecorder = new EpisodeEventRecorder({
    rootDir: path.join(scratch, "events"),
    runId: "trajectory-failure-run",
  });
  const blockedRoot = path.join(scratch, "trajectory-root-is-a-file");
  writeFileSync(blockedRoot, "occupied");

  const recorder = createTrajectoryRecorder(blockedRoot, "session-failure", eventRecorder);
  assert.doesNotThrow(() => recorder(ENTRY));
  assert.equal(eventRecorder.health.complete, false);
  assert.match(eventRecorder.health.lastError ?? "", /trajectory/i);
});
