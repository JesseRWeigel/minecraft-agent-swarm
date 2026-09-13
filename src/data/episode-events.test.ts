import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  EpisodeEventRecorder,
  contentReference,
  type EpisodeEventInput,
  currentCollectionContext,
  getEpisodeEventRecorder,
  setEpisodeEventRecorderForTests,
} from "./episode-events.js";

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
    headers: { "x-api-key": "header-key-secret", "x-access-token": "header-access-secret" },
  });
  const payload = JSON.parse(readFileSync(recorder.payloadPath(recorded.payloadRef), "utf8"));
  assert.deepEqual(payload.usage, sharedUsage);
  assert.deepEqual(payload.repeatedUsage, sharedUsage);
  assert.equal(payload.apiKey, "[REDACTED]");
  assert.equal(payload.access_token, "[REDACTED]");
  assert.equal(payload.authorization, "[REDACTED]");
  assert.equal(payload.headers["x-api-key"], "[REDACTED]");
  assert.equal(payload.headers["x-access-token"], "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(payload), /key-secret|access-secret|auth-secret|header-key|header-access/);
});

test("an unterminated valid JSON tail quarantines the run without changing its bytes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "episode-events-tail-"));
  const first = new EpisodeEventRecorder({ rootDir: root, runId: "tail-run" });
  first.record(event(), { one: true });
  const unterminated = readFileSync(first.eventPath, "utf8").trimEnd();
  writeFileSync(first.eventPath, unterminated);

  const resumed = new EpisodeEventRecorder({ rootDir: root, runId: "tail-run" });
  assert.equal(resumed.health.complete, false);
  assert.match(resumed.health.lastError ?? "", /unterminated|newline/i);
  const refused = resumed.record(event({ kind: "action_finished" }), { two: true });
  assert.match(refused.payloadRef, /^unavailable:/);
  assert.equal(resumed.recoverInterruptedActions(), 0);
  assert.equal(readFileSync(first.eventPath, "utf8"), unterminated);
});

test("a malformed tail quarantines the run and refuses subsequent writes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "episode-events-malformed-"));
  const first = new EpisodeEventRecorder({ rootDir: root, runId: "malformed-run" });
  first.record(event(), { one: true });
  appendFileSync(first.eventPath, "{");
  const original = readFileSync(first.eventPath);

  const resumed = new EpisodeEventRecorder({ rootDir: root, runId: "malformed-run" });
  assert.equal(resumed.health.complete, false);
  const refused = resumed.record(event({ kind: "action_finished" }), { two: true });
  assert.match(refused.payloadRef, /^unavailable:/);
  assert.equal(resumed.recoverInterruptedActions(), 0);
  assert.deepEqual(readFileSync(first.eventPath), original);
});

test("a damaged run does not prevent a different run from starting cleanly", () => {
  const root = mkdtempSync(path.join(tmpdir(), "episode-events-new-run-"));
  const damaged = new EpisodeEventRecorder({ rootDir: root, runId: "old/run" });
  damaged.record(event(), { old: true });
  appendFileSync(damaged.eventPath, "{");
  assert.equal(new EpisodeEventRecorder({ rootDir: root, runId: "old/run" }).health.complete, false);

  const fresh = new EpisodeEventRecorder({ rootDir: root, runId: "new?run" });
  const recorded = fresh.record(event({ actionId: "fresh" }), { fresh: true });
  assert.equal(fresh.health.complete, true);
  assert.notEqual(fresh.eventPath, damaged.eventPath);
  assert.match(recorded.payloadRef, /^sha256:[a-f0-9]{64}$/);
});

test("run IDs with the same safe spelling have distinct files and cannot recover each other", () => {
  const root = mkdtempSync(path.join(tmpdir(), "episode-events-run-id-"));
  const slash = new EpisodeEventRecorder({ rootDir: root, runId: "trial/a" });
  slash.record(event({ episodeId: "trial/a:Atlas", actionId: "slash-action" }), { started: true });

  const question = new EpisodeEventRecorder({ rootDir: root, runId: "trial?a" });
  assert.notEqual(question.eventPath, slash.eventPath);
  assert.equal(question.recoverInterruptedActions(), 0);
  assert.equal(question.health.complete, true);
  assert.equal(readFileSync(slash.eventPath, "utf8").trim().split("\n").length, 1);
});

test("recovery rejects events whose embedded run ID does not match the requested run", () => {
  const root = mkdtempSync(path.join(tmpdir(), "episode-events-wrong-run-"));
  const recorder = new EpisodeEventRecorder({ rootDir: root, runId: "expected-run" });
  recorder.record(event(), { started: true });
  const line = JSON.parse(readFileSync(recorder.eventPath, "utf8").trim());
  line.runId = "different-run";
  writeFileSync(recorder.eventPath, JSON.stringify(line) + "\n");
  const original = readFileSync(recorder.eventPath);

  const resumed = new EpisodeEventRecorder({ rootDir: root, runId: "expected-run" });
  assert.equal(resumed.health.complete, false);
  assert.match(resumed.health.lastError ?? "", /run ID/i);
  assert.equal(resumed.recoverInterruptedActions(), 0);
  assert.deepEqual(readFileSync(recorder.eventPath), original);
});

test("an unserializable payload records an explicit diagnostic and fails soft", () => {
  const root = mkdtempSync(path.join(tmpdir(), "episode-events-bigint-"));
  const recorder = new EpisodeEventRecorder({ rootDir: root, runId: "bigint-run" });

  let recorded!: ReturnType<EpisodeEventRecorder["record"]>;
  assert.doesNotThrow(() => {
    recorded = recorder.record(event(), { impossible: 1n });
  });
  assert.equal(recorder.health.complete, false);
  assert.match(recorded.payloadRef, /^sha256:[a-f0-9]{64}$/);
  const diagnostic = JSON.parse(readFileSync(recorder.payloadPath(recorded.payloadRef), "utf8"));
  assert.deepEqual(diagnostic.telemetryCapture, {
    originalPayloadCaptured: false,
    reason: "payload_serialization_failed",
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /impossible/);
});

test("recordEpisodeEvent replaces an unserializable claimed payload with a diagnostic reference", () => {
  const root = mkdtempSync(path.join(tmpdir(), "episode-events-public-bigint-"));
  const recorder = new EpisodeEventRecorder({ rootDir: root, runId: "public-bigint-run" });
  const claimed = recorder.record(event(), { serializable: true });
  const external = {
    ...claimed,
    eventId: "external-event",
    sequence: 2,
    payloadRef: contentReference({ claimed: "different payload" }),
  };

  let recorded!: typeof external;
  assert.doesNotThrow(() => {
    recorded = recorder.recordEpisodeEvent(external, { impossible: 1n });
  });
  assert.equal(recorder.health.complete, false);
  assert.notEqual(recorded.payloadRef, external.payloadRef);
  const lines = readFileSync(recorder.eventPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const persisted = lines[lines.length - 1];
  assert.equal(persisted.payloadRef, recorded.payloadRef);
  const diagnostic = JSON.parse(readFileSync(recorder.payloadPath(recorded.payloadRef), "utf8"));
  assert.equal(diagnostic.telemetryCapture.originalPayloadCaptured, false);
});

test("recordEpisodeEvent rejects a foreign run ID without changing the current run", () => {
  const root = mkdtempSync(path.join(tmpdir(), "episode-events-foreign-run-"));
  const recorder = new EpisodeEventRecorder({ rootDir: root, runId: "run-a" });
  const first = recorder.record(event(), { first: true });
  const original = readFileSync(recorder.eventPath);
  const foreignPayload = { foreign: true };
  const foreign = {
    ...first,
    eventId: "foreign-event",
    runId: "run-b",
    sequence: 2,
    payloadRef: contentReference(foreignPayload),
  };

  const refused = recorder.recordEpisodeEvent(foreign, foreignPayload);

  assert.equal(recorder.health.complete, false);
  assert.match(recorder.health.lastError ?? "", /run ID/i);
  assert.equal(refused.payloadRef, "unavailable:run_id_mismatch");
  assert.deepEqual(readFileSync(recorder.eventPath), original);
});

test("a throwing payload getter becomes a diagnostic instead of escaping capture", () => {
  const root = mkdtempSync(path.join(tmpdir(), "episode-events-getter-"));
  const recorder = new EpisodeEventRecorder({ rootDir: root, runId: "getter-run" });
  const payload = Object.defineProperty({}, "unsafe", {
    enumerable: true,
    get() {
      throw new Error("getter exploded");
    },
  });

  let recorded!: ReturnType<EpisodeEventRecorder["record"]>;
  assert.doesNotThrow(() => {
    recorded = recorder.record(event(), payload);
  });
  assert.equal(recorder.health.complete, false);
  const diagnostic = JSON.parse(readFileSync(recorder.payloadPath(recorded.payloadRef), "utf8"));
  assert.equal(diagnostic.telemetryCapture.originalPayloadCaptured, false);
});

test("default recorder preserves launch context once, before any action, without inventing trial provenance", () => {
  const keys = [
    "DATASET_OPERATION_MODE",
    "DATASET_TRIAL_ID",
    "DATASET_GIT_COMMIT",
    "DATASET_DIRTY_DIFF_HASH",
    "DATASET_WORLD_SNAPSHOT_ID",
    "DATASET_EVENT_DIR",
  ];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.DATASET_OPERATION_MODE = "live";
    process.env.DATASET_GIT_COMMIT = "a".repeat(40);
    process.env.DATASET_DIRTY_DIFF_HASH = "b".repeat(64);
    process.env.DATASET_EVENT_DIR = mkdtempSync(path.join(tmpdir(), "run-context-"));
    setEpisodeEventRecorderForTests(null);
    const recorder = getEpisodeEventRecorder();
    const context = currentCollectionContext();
    process.env.DATASET_OPERATION_MODE = "evaluation";
    process.env.DATASET_TRIAL_ID = "changed-after-launch";
    assert.deepEqual(currentCollectionContext(), context);
    assert.equal(Object.isFrozen(context), true);
    assert.equal(getEpisodeEventRecorder(), recorder);
    const lines = readFileSync(recorder.eventPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].kind, "observation");
    assert.equal(lines[0].actionId, null);
    assert.equal(lines[0].episodeId, `${recorder.runId}:_collector`);
    const payload = JSON.parse(readFileSync(recorder.payloadPath(lines[0].payloadRef), "utf8"));
    assert.equal(payload.stage, "run_context");
    assert.equal(payload.collection.operationMode, "live");
    assert.equal(payload.collection.trialId, null);
    assert.equal(payload.collection.worldSnapshotId, null);
    assert.deepEqual(payload.missingFields, ["trialId", "worldSnapshotId"]);
    assert.equal(payload.claimsControlledTrial, false);
    assert.equal(payload.provenanceSource, "launch_environment");
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    setEpisodeEventRecorderForTests(null);
  }
});
