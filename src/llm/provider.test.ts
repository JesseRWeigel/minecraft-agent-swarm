import { test } from "node:test";
import assert from "node:assert/strict";

import { toOpenAIRequest, fromOpenAIResponse, type ChatRequest } from "./provider.js";

const BASE: ChatRequest = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "hi" }],
};

test("carries model and messages through unchanged", () => {
  const body = toOpenAIRequest(BASE);
  assert.equal(body.model, "gpt-4o-mini");
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

// Every decision path sends format:"json" and then parses the reply. Losing this
// in translation would turn valid decisions into parse failures.
test("json format becomes response_format", () => {
  const body = toOpenAIRequest({ ...BASE, format: "json" });
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("no response_format when json was not requested", () => {
  assert.equal(toOpenAIRequest(BASE).response_format, undefined);
});

test("num_predict maps to max_tokens", () => {
  const body = toOpenAIRequest({ ...BASE, options: { num_predict: 384 } });
  assert.equal(body.max_tokens, 384);
  assert.equal(body.num_predict, undefined, "ollama's name must not leak through");
});

test("temperature passes through, including zero", () => {
  assert.equal(toOpenAIRequest({ ...BASE, options: { temperature: 0.4 } }).temperature, 0.4);
  // 0 is falsy — a truthiness check here would silently drop a deliberate 0.
  assert.equal(toOpenAIRequest({ ...BASE, options: { temperature: 0 } }).temperature, 0);
});

// These two have no honest OpenAI equivalent. Dropping them is deliberate;
// approximating them would silently change sampling behaviour.
test("ollama-only parameters are dropped, not guessed at", () => {
  const body = toOpenAIRequest({
    ...BASE,
    think: "low",
    options: { repeat_penalty: 1.15, temperature: 0.8 },
  });
  assert.equal(body.think, undefined);
  assert.equal(body.repeat_penalty, undefined);
  assert.equal(body.frequency_penalty, undefined, "1.15 multiplicative is not 1.15 additive");
  assert.equal(body.temperature, 0.8, "the mappable option still survives");
});

test("reads the assistant text out of a completion", () => {
  const res = fromOpenAIResponse({ choices: [{ message: { role: "assistant", content: '{"action":"idle"}' } }] });
  assert.equal(res.message.content, '{"action":"idle"}');
});

// Callers do .trim()/.slice() on the result. undefined would throw several
// frames from the cause; an empty string reaches the existing "empty response"
// handling that every decision path already has.
test("a refusal or malformed reply yields empty string, never undefined", () => {
  assert.equal(fromOpenAIResponse({ choices: [{ message: { content: null } }] }).message.content, "");
  assert.equal(fromOpenAIResponse({ choices: [] }).message.content, "");
  assert.equal(fromOpenAIResponse({}).message.content, "");
  assert.equal(fromOpenAIResponse(null).message.content, "");
});

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EpisodeEventRecorder, setEpisodeEventRecorderForTests } from "../data/episode-events.js";
import { chatWithTransport, openAITransport, type ProviderTransportResult } from "./provider.js";

function recordedPayloads(recorder: EpisodeEventRecorder) {
  return readFileSync(recorder.eventPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .map((event) => ({
      event,
      payload: JSON.parse(readFileSync(recorder.payloadPath(event.payloadRef), "utf8")),
    }));
}

test("provider boundary records the exact sent messages and returned usage", async () => {
  const recorder = new EpisodeEventRecorder({
    rootDir: mkdtempSync(path.join(tmpdir(), "provider-events-")),
    runId: "provider-run",
  });
  setEpisodeEventRecorderForTests(recorder);
  const request: ChatRequest = {
    ...BASE,
    messages: [
      { role: "system", content: "system sentinel" },
      { role: "assistant", content: "history sentinel" },
      { role: "user", content: "actual final context" },
    ],
    telemetry: { botId: "Atlas", episodeId: "episode-provider", source: "strategic" },
  };

  const response = await chatWithTransport(request, "ollama", async () => ({
    response: { message: { content: '{"action":"idle"}' } },
    raw: {
      message: { content: '{"action":"idle"}' },
      prompt_eval_count: 41,
      eval_count: 7,
      total_duration: 123_000_000,
    },
  }));

  assert.equal(response.metadata?.provider, "ollama");
  assert.equal(response.metadata?.usage.inputTokens, 41);
  assert.equal(response.metadata?.usage.outputTokens, 7);
  assert.equal(response.metadata?.usage.totalTokens, 48);
  assert.equal(response.metadata?.usage.costUsd, null);
  const records = recordedPayloads(recorder);
  assert.deepEqual(
    records.map(({ event }) => event.kind),
    ["model_request", "model_response"],
  );
  assert.deepEqual(records[0].payload.request.messages, request.messages);
  assert.equal(records[0].event.requestId, response.metadata?.requestId);
  assert.equal(records[1].event.requestId, response.metadata?.requestId);
  assert.equal(records[1].payload.raw.message.content, '{"action":"idle"}');
  setEpisodeEventRecorderForTests(null);
});

test("missing provider usage remains null instead of being estimated", async () => {
  const recorder = new EpisodeEventRecorder({
    rootDir: mkdtempSync(path.join(tmpdir(), "provider-events-")),
    runId: "provider-run-unknown",
  });
  setEpisodeEventRecorderForTests(recorder);
  const response = await chatWithTransport(
    { ...BASE, telemetry: { botId: "Flora", episodeId: "episode-unknown", source: "reactive" } },
    "openai",
    async (): Promise<ProviderTransportResult> => ({
      response: { message: { content: "not json" } },
      raw: { choices: [{ message: { content: "not json" } }] },
    }),
  );
  assert.deepEqual(response.metadata?.usage, {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
  });
  setEpisodeEventRecorderForTests(null);
});

test("provider errors emit a correlated response event and retain request metadata", async () => {
  const recorder = new EpisodeEventRecorder({
    rootDir: mkdtempSync(path.join(tmpdir(), "provider-events-")),
    runId: "provider-run-error",
  });
  setEpisodeEventRecorderForTests(recorder);
  await assert.rejects(
    chatWithTransport(
      { ...BASE, telemetry: { botId: "Forge", episodeId: "episode-error", source: "critic" } },
      "openai",
      async () => {
        throw new Error("provider unavailable");
      },
    ),
    /provider unavailable/,
  );
  const records = recordedPayloads(recorder);
  assert.deepEqual(
    records.map(({ event }) => event.kind),
    ["model_request", "model_response"],
  );
  assert.equal(records[0].event.requestId, records[1].event.requestId);
  assert.equal(records[1].payload.ok, false);
  assert.equal(records[1].payload.error.message, "provider unavailable");
  setEpisodeEventRecorderForTests(null);
});

test("malformed successful OpenAI response is captured before JSON parsing fails", async () => {
  const recorder = new EpisodeEventRecorder({
    rootDir: mkdtempSync(path.join(tmpdir(), "provider-events-")),
    runId: "provider-run-malformed",
  });
  setEpisodeEventRecorderForTests(recorder);
  await assert.rejects(
    chatWithTransport(
      { ...BASE, telemetry: { botId: "Atlas", episodeId: "episode-malformed", source: "strategic" } },
      "openai",
      (request) =>
        openAITransport(
          request,
          async () => new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } }),
        ),
    ),
    /valid JSON/i,
  );
  const records = recordedPayloads(recorder);
  assert.equal(records[1].payload.ok, false);
  assert.equal(records[1].payload.raw.status, 200);
  assert.equal(records[1].payload.raw.bodyText, "{not-json");
  setEpisodeEventRecorderForTests(null);
});
