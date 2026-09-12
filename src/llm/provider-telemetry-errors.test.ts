import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { EpisodeEventRecorder, setEpisodeEventRecorderForTests } from "../data/episode-events.js";
import { chatWithTransport } from "./provider.js";

test("a successful provider response survives an unserializable telemetry envelope", async () => {
  const recorder = new EpisodeEventRecorder({
    rootDir: mkdtempSync(path.join(tmpdir(), "provider-telemetry-errors-")),
    runId: "provider-bigint-run",
  });
  setEpisodeEventRecorderForTests(recorder);
  try {
    const response = await chatWithTransport(
      {
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        telemetry: { botId: "Atlas", episodeId: "provider-episode", source: "chat" },
      },
      "ollama",
      async () => ({
        response: { message: { content: "valid provider response" } },
        raw: { model: "test-model", impossible: 1n },
      }),
    );

    assert.equal(response.message.content, "valid provider response");
    assert.equal(response.metadata?.providerModel, "test-model");
    assert.equal(recorder.health.complete, false);
    const rows = readFileSync(recorder.eventPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      rows.map((row) => row.kind),
      ["model_request", "model_response"],
    );
    const diagnostic = JSON.parse(readFileSync(recorder.payloadPath(rows[1].payloadRef), "utf8"));
    assert.deepEqual(diagnostic.telemetryCapture, {
      originalPayloadCaptured: false,
      reason: "payload_serialization_failed",
    });
  } finally {
    setEpisodeEventRecorderForTests(null);
  }
});
