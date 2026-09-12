import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EpisodeEventRecorder, setEpisodeEventRecorderForTests } from "../data/episode-events.js";

import { ProviderCallError, type ProviderResponseMetadata } from "./provider.js";
import { fallbackDecision, parseProviderDecision, queryCritic, queryReactive, setChatClientForTests } from "./index.js";

setEpisodeEventRecorderForTests(
  new EpisodeEventRecorder({ rootDir: mkdtempSync(path.join(tmpdir(), "decision-events-")), runId: "decision-run" }),
);

const metadata: ProviderResponseMetadata = {
  requestId: "request-metadata",
  provider: "ollama",
  model: "requested-model",
  providerModel: "served-model",
  providerRequestId: null,
  durationMs: 25,
  usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null },
  origin: "provider",
};

test("a non-JSON provider response remains linked to its request metadata", () => {
  const decision = parseProviderDecision("plain prose", "Atlas", metadata);
  assert.equal(decision.action, "idle");
  assert.equal(decision.metadata?.requestId, "request-metadata");
  assert.equal(decision.metadata?.origin, "local_fallback");
  assert.equal(decision.metadata?.provider?.providerModel, "served-model");
});

test("a local fallback records its origin and the failed provider request without invented usage", () => {
  const error = new ProviderCallError(new Error("offline"), metadata);
  const decision = fallbackDecision("Planning...", "idle", error);
  assert.equal(decision.metadata?.origin, "local_fallback");
  assert.equal(decision.metadata?.requestId, "request-metadata");
  assert.deepEqual(decision.metadata?.provider?.usage, {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
  });
});

function response(content: string): { message: { content: string }; metadata: ProviderResponseMetadata } {
  return { message: { content }, metadata };
}

test("public decision queries preserve provider provenance on synthesized parse fallbacks", async () => {
  const cases = [
    { content: "plain prose", expectedAction: "idle" },
    { content: '{"thought":"x","action": nope}', expectedAction: "flee" },
    { content: '{"thought":"wait","params":{}}', expectedAction: "idle" },
  ];
  for (const current of cases) {
    setChatClientForTests(async () => response(current.content));
    const decision = await queryReactive("Atlas", "danger");
    assert.equal(decision.action, current.expectedAction);
    assert.equal(decision.metadata?.origin, "local_fallback");
    assert.equal(decision.metadata?.requestId, "request-metadata");
    assert.equal(decision.metadata?.provider?.usage, metadata.usage);
  }
  setChatClientForTests(null);
});

test("critic parse fallbacks retain the response request and are not provider verdicts", async () => {
  for (const content of ["plain prose", '{"success": nope}']) {
    setChatClientForTests(async () => response(content));
    const verdict = await queryCritic("Atlas", "action result");
    assert.equal(verdict.metadata?.origin, "local_fallback");
    assert.equal(verdict.metadata?.requestId, "request-metadata");
    assert.equal(verdict.metadata?.provider?.usage, metadata.usage);
  }
  setChatClientForTests(null);
});
