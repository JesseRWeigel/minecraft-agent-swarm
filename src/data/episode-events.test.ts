import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { EpisodeEventRecorder, contentReference, type EpisodeEventInput } from "./episode-events.js";

function event(overrides: Partial<EpisodeEventInput> = {}): EpisodeEventInput {
  return {
    botId: "Atlas",
    episodeId: "episode-a",
    actionId: "action-a",
    requestId: "request-a",
    kind: "action_started",
    ...overrides,
  };
}

test("stores a redacted payload by content hash and appends a correlated event", () => {
  const root = mkdtempSync(path.join(tmpdir(), "episode-events-"));
  const recorder = new EpisodeEventRecorder({ rootDir: root, runId: "run-a", clock: () => 1_700_000_000_000 });
  const payload = {
    messages: [{ role: "user", content: "exact sentinel message" }],
    headers: { Authorization: "Bearer test-secret", "x-trace": "kept" },
  };

  const recorded = recorder.record(event(), payload);

  assert.equal(
    recorded.payloadRef,
    contentReference({
      messages: [{ role: "user", content: "exact sentinel message" }],
      headers: { Authorization: "[REDACTED]", "x-trace": "kept" },
    }),
  );
  const blob = readFileSync(recorder.payloadPath(recorded.payloadRef), "utf8");
  assert.match(blob, /exact sentinel message/);
  assert.doesNotMatch(blob, /test-secret/);
  const line = JSON.parse(readFileSync(recorder.eventPath, "utf8").trim());
  assert.equal(line.schemaVersion, 1);
  assert.equal(line.sequence, 1);
  assert.equal(line.actionId, "action-a");
  assert.equal(line.requestId, "request-a");
  assert.equal(line.payloadRef, recorded.payloadRef);
});

test("reverse completion order keeps each terminal event joined to its own action", () => {
  const root = mkdtempSync(path.join(tmpdir(), "episode-events-"));
  let now = 1_700_000_000_000;
  const recorder = new EpisodeEventRecorder({ rootDir: root, runId: "run-b", clock: () => now++ });

  recorder.record(event({ actionId: "action-1", requestId: "request-1" }), { action: "first" });
  recorder.record(event({ actionId: "action-2", requestId: "request-2" }), { action: "second" });
  recorder.record(event({ actionId: "action-2", requestId: "request-2", kind: "action_finished" }), {
    outcome: "second",
  });
  recorder.record(event({ actionId: "action-1", requestId: "request-1", kind: "action_finished" }), {
    outcome: "first",
  });

  const lines = readFileSync(recorder.eventPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map((line) => line.actionId),
    ["action-1", "action-2", "action-2", "action-1"],
  );
  assert.deepEqual(
    lines.map((line) => line.sequence),
    [1, 2, 3, 4],
  );
});

test("recovery appends one explicitly synthesized unknown terminal event", () => {
  const root = mkdtempSync(path.join(tmpdir(), "episode-events-"));
  const first = new EpisodeEventRecorder({ rootDir: root, runId: "run-c", clock: () => 1_700_000_000_000 });
  first.record(event({ actionId: "interrupted", requestId: null }), { action: "mine_block" });

  const recovered = new EpisodeEventRecorder({ rootDir: root, runId: "run-c", clock: () => 1_700_000_001_000 });
  assert.equal(recovered.recoverInterruptedActions(), 1);
  assert.equal(recovered.recoverInterruptedActions(), 0);

  const lines = readFileSync(recovered.eventPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const terminal = lines.at(-1);
  assert.equal(terminal.kind, "action_finished");
  const payload = JSON.parse(readFileSync(recovered.payloadPath(terminal.payloadRef), "utf8"));
  assert.equal(payload.outcome.status, "unknown");
  assert.equal(payload.outcome.reasonCode, "process_interrupted");
  assert.equal(payload.synthesized, true);
});

test("a write failure marks telemetry unhealthy without throwing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "episode-events-"));
  const blockedRoot = path.join(root, "not-a-directory");
  writeFileSync(blockedRoot, "occupied");
  const recorder = new EpisodeEventRecorder({ rootDir: blockedRoot, runId: "run-d" });

  assert.doesNotThrow(() => recorder.record(event(), { action: "idle" }));
  assert.equal(recorder.health.complete, false);
  assert.match(recorder.health.lastError ?? "", /telemetry/i);
});

test("keeps usage token quantities and repeated references while redacting credential fields", () => {
  const root = mkdtempSync(path.join(tmpdir(), "episode-events-"));
  const recorder = new EpisodeEventRecorder({ rootDir: root, runId: "run-usage" });
  const sharedUsage = { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 };
  const recorded = recorder.record(event({ kind: "model_response" }), {
    usage: sharedUsage,
    repeatedUsage: sharedUsage,
    apiKey: "key-secret",
    access_token: "access-secret",
    authorization: "Bearer auth-secret",
  });
  const payload = JSON.parse(readFileSync(recorder.payloadPath(recorded.payloadRef), "utf8"));
  assert.deepEqual(payload.usage, sharedUsage);
  assert.deepEqual(payload.repeatedUsage, sharedUsage);
  assert.equal(payload.apiKey, "[REDACTED]");
  assert.equal(payload.access_token, "[REDACTED]");
  assert.equal(payload.authorization, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(payload), /key-secret|access-secret|auth-secret/);
});
