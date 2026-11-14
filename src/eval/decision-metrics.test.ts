import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertLocalModelName,
  assessShowResponse,
  assessTagsResponse,
  buildChatRequest,
  canonicalModelTag,
  classifyChatResponse,
  compareModelIdentity,
  getJson,
  recheckModelIdentity,
  resolveModelIdentity,
  findFirstJsonObject,
  MAX_CHAT_REQUESTS,
  parseEvalArgs,
  parseFinalAnswer,
  postJson,
  scoreResponse,
  tally,
  thinkFor,
  validateLoopbackHost,
  verifyLocalModel,
  type FetchLike,
} from "./decision-metrics.js";

const SIX = ["a", "b", "c", "d", "e", "f"];
const OUT = ["--out", "run.jsonl"];
const acceptMine = (d: { action?: string }) => d.action === "mine_block";

function chatBody(over: Record<string, unknown> = {}, message: Record<string, unknown> = {}) {
  return {
    model: "qwen3:8b",
    message: { role: "assistant", content: '{"action":"mine_block","params":{}}', ...message },
    done: true,
    done_reason: "stop",
    eval_count: 40,
    prompt_eval_count: 900,
    total_duration: 3e9,
    load_duration: 2e9,
    prompt_eval_duration: 5e8,
    eval_duration: 5e8,
    ...over,
  };
}

function mockFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fn, calls };
}

// ─── think policy drift guard ───────────────────────────────────────────────

test("thinkFor mirrors the production policy in src/llm/index.ts", () => {
  const src = readFileSync(new URL("../llm/index.ts", import.meta.url), "utf8");
  const m = src.match(/function thinkFor\(model: string\)[^{]*\{\s*([^}]*)\}/);
  assert.ok(m, "production thinkFor() not found — update the eval mirror and docs");
  assert.equal(m[1].trim(), 'return model.includes("gpt-oss") ? "low" : false;');
  assert.equal(thinkFor("gpt-oss:20b"), "low");
  assert.equal(thinkFor("qwen3:8b"), false);
});

// ─── numeric limits ─────────────────────────────────────────────────────────

test("defaults: 1 sample, production num_predict, all scenarios", () => {
  const c = parseEvalArgs(["qwen3:8b", ...OUT], SIX);
  assert.equal(c.samples, 1);
  assert.equal(c.numPredict, 1024);
  assert.equal(c.timeoutMs, 120_000);
  assert.equal(c.chatRequests, 6);
  assert.equal(c.host, "http://127.0.0.1:11434");
});

test("rejects out-of-range or non-integer numeric flags", () => {
  for (const bad of [
    ["--samples", "0"],
    ["--samples", "4"],
    ["--samples", "1.5"],
    ["--samples", "-1"],
    ["--samples", "1e0"],
    ["--num-predict", "127"],
    ["--num-predict", "2049"],
    ["--num-predict", " 512"],
    ["--timeout-ms", "120001"],
    ["--timeout-ms", "999"],
  ]) {
    assert.throws(() => parseEvalArgs(["qwen3:8b", ...OUT, ...bad], SIX), Error, bad.join(" "));
  }
});

test("request cap is enforced before any call", () => {
  assert.throws(() => parseEvalArgs(["qwen3:8b", ...OUT, "--samples", "3"], SIX), /exceeds the hard cap of 12/);
  const c = parseEvalArgs(
    ["qwen3:8b", ...OUT, "--samples", "3", "--scenario", "a", "--scenario", "b", "--scenario", "c", "--scenario", "d"],
    SIX,
  );
  assert.equal(c.chatRequests, MAX_CHAT_REQUESTS);
  assert.deepEqual(c.scenarioNames, ["a", "b", "c", "d"]);
});

test("rejects unknown/duplicate scenarios, unknown flags, missing --out", () => {
  assert.throws(() => parseEvalArgs(["m", ...OUT, "--scenario", "zzz"], SIX), /unknown scenario/);
  assert.throws(() => parseEvalArgs(["m", ...OUT, "--scenario", "a", "--scenario", "a"], SIX), /twice/);
  assert.throws(() => parseEvalArgs(["m", ...OUT, "--samples", "1", "--samples", "2"], SIX), /twice/);
  assert.throws(() => parseEvalArgs(["m", ...OUT, "--pull"], SIX), /unknown argument/);
  assert.throws(() => parseEvalArgs(["m"], SIX), /--out is required/);
  assert.throws(() => parseEvalArgs(["m", "--out", "x.json"], SIX), /\.jsonl/);
  assert.throws(() => parseEvalArgs([], SIX), /usage/);
});

// ─── host validation ────────────────────────────────────────────────────────

test("accepts only literal loopback http origins", () => {
  assert.equal(validateLoopbackHost("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(validateLoopbackHost("http://127.0.0.1:11434/"), "http://127.0.0.1:11434");
  assert.equal(validateLoopbackHost("http://[::1]:11434"), "http://[::1]:11434");
  for (const bad of [
    "https://127.0.0.1:11434",
    "http://localhost:11434",
    "http://0.0.0.0:11434",
    "http://192.168.1.5:11434",
    "http://2130706433:11434",
    "http://0x7f.1:11434",
    "http://127.1:11434",
    "http://user:pw@127.0.0.1:11434",
    "http://127.0.0.1@evil.example:11434",
    "http://127.0.0.1.evil.example",
    "http://127.0.0.1:11434/api",
    "http://127.0.0.1:11434?x=1",
    "http://127.0.0.1:11434#f",
    "http://127.0.0.1:0",
    "http://127.0.0.1:99999",
    "http:\\\\127.0.0.1:11434",
    " http://127.0.0.1:11434",
    "http://ollama.com",
  ]) {
    assert.throws(() => validateLoopbackHost(bad), Error, bad);
  }
  assert.throws(() => parseEvalArgs(["m", ...OUT], SIX, { OLLAMA_HOST: "http://ollama.com" }), /OLLAMA_HOST/);
});

// ─── cloud rejection ────────────────────────────────────────────────────────

test("rejects cloud and malformed model names", () => {
  for (const bad of ["gpt-oss:120b-cloud", "glm-4.6:cloud", "CLOUD/model", "x;rm", "-m", "a//b", "../x", ""]) {
    assert.throws(() => assertLocalModelName(bad), Error, bad);
  }
  assert.doesNotThrow(() => assertLocalModelName("qwen3:8b"));
  assert.doesNotThrow(() => assertLocalModelName("hf.co/org/model:Q4_K_M"));
  assert.throws(() => parseEvalArgs(["gpt-oss:20b-cloud", ...OUT], SIX), /cloud/);
});

test("/api/show fails closed on remote fields, errors, or missing details", () => {
  const details = { format: "gguf", family: "qwen3", parameter_size: "8B" };
  assert.deepEqual(assessShowResponse({ details }).details, details);
  assert.throws(() => assessShowResponse({ details, remote_host: "https://ollama.com:443" }), /remote/);
  assert.throws(() => assessShowResponse({ details, remote_model: "gpt-oss:120b" }), /remote/);
  assert.throws(() => assessShowResponse({ details, remote_host: null }), /remote/);
  assert.throws(() => assessShowResponse({ error: "model not found" }), /not found/);
  assert.throws(() => assessShowResponse({}), /details/);
  assert.throws(() => assessShowResponse({ details: {} }), /GGUF/);
  assert.throws(() => assessShowResponse([]), /non-object/);
});

test("verifyLocalModel posts only to /api/show with redirect:error and a timeout", async () => {
  const { fn, calls } = mockFetch(() => new Response(JSON.stringify({ details: { format: "gguf", family: "x" } })));
  await verifyLocalModel(fn, "http://127.0.0.1:11434", "qwen3:8b", 5000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:11434/api/show");
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { model: "qwen3:8b" });

  const remote = mockFetch(() => new Response(JSON.stringify({ details: {}, remote_host: "https://ollama.com" })));
  await assert.rejects(verifyLocalModel(remote.fn, "http://127.0.0.1:11434", "m", 5000), /remote/);
  const missing = mockFetch(() => new Response('{"error":"model \'m\' not found"}', { status: 404 }));
  await assert.rejects(verifyLocalModel(missing.fn, "http://127.0.0.1:11434", "m", 5000), /http_error/);
});

// ─── model identity via /api/tags ───────────────────────────────────────────

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const tags = (...models: unknown[]) => ({ models });
const entry = (name: string, digest: unknown = HEX_A, extra: Record<string, unknown> = {}) => ({
  name,
  model: name,
  digest,
  ...extra,
});

test("canonicalModelTag makes the implicit :latest explicit", () => {
  assert.equal(canonicalModelTag("qwen3"), "qwen3:latest");
  assert.equal(canonicalModelTag("qwen3:8b"), "qwen3:8b");
  assert.equal(canonicalModelTag("hf.co/org/model"), "hf.co/org/model:latest");
  assert.equal(canonicalModelTag("hf.co/org/model:Q4_K_M"), "hf.co/org/model:Q4_K_M");
  assert.equal(canonicalModelTag("host:5000/m"), "host:5000/m:latest");
  assert.throws(() => canonicalModelTag("qwen3:"), /empty tag/);
});

test("tags: exact match records canonical tag and normalized sha256 digest", () => {
  const body = tags(entry("qwen3:8b"), entry("qwen3:8b-q8", HEX_B), entry("qwen3:latest", HEX_B));
  assert.deepEqual(assessTagsResponse(body, "qwen3:8b"), { canonical_tag: "qwen3:8b", digest: `sha256:${HEX_A}` });
  assert.deepEqual(assessTagsResponse(tags(entry("m:1", `sha256:${HEX_B}`)), "m:1").digest, `sha256:${HEX_B}`);
});

test("tags: untagged request matches :latest, not other tags", () => {
  const body = tags(entry("qwen3:8b", HEX_B), entry("qwen3:latest"));
  assert.deepEqual(assessTagsResponse(body, "qwen3"), { canonical_tag: "qwen3:latest", digest: `sha256:${HEX_A}` });
  assert.throws(() => assessTagsResponse(tags(entry("qwen3:8b")), "qwen3"), /not installed/);
  assert.throws(() => assessTagsResponse(tags(entry("qwen3:latest")), "qwen3:8b"), /not installed/);
});

test("tags: match is exact (no prefix or case folding)", () => {
  assert.throws(() => assessTagsResponse(tags(entry("qwen3:8b-instruct")), "qwen3:8b"), /not installed/);
  assert.throws(() => assessTagsResponse(tags(entry("Qwen3:8b")), "qwen3:8b"), /not installed/);
});

test("tags: malformed bodies and entries fail closed", () => {
  for (const body of [null, [], "x", {}, { models: {} }, { models: null }, tags(null), tags({ digest: HEX_A })]) {
    assert.throws(() => assessTagsResponse(body, "qwen3:8b"), /malformed/, JSON.stringify(body));
  }
  const badDigests = [
    "",
    "abc",
    HEX_A.toUpperCase(),
    `sha512:${HEX_A}`,
    `${HEX_A}0`,
    7,
    null,
    `sha256:${"g".repeat(64)}`,
  ];
  for (const digest of badDigests) {
    assert.throws(() => assessTagsResponse(tags(entry("m:1", digest)), "m:1"), /sha256 digest/, String(digest));
  }
  assert.throws(() => assessTagsResponse(tags({ name: "m:1" }), "m:1"), /sha256 digest/);
  assert.throws(() => assessTagsResponse(tags(entry("m:1", HEX_A, { model: "other:1" })), "m:1"), /inconsistent/);
  assert.throws(() => assessTagsResponse(tags(entry("m:1", HEX_A, { remote_host: "https://x" })), "m:1"), /remote/);
});

test("tags: missing and ambiguous models are refused", () => {
  assert.throws(() => assessTagsResponse(tags(), "qwen3:8b"), /not installed/);
  assert.throws(() => assessTagsResponse(tags(entry("qwen3:latest"), entry("qwen3", HEX_B)), "qwen3"), /ambiguous/);
  assert.throws(() => assessTagsResponse(tags(entry("m:1"), entry("m:1")), "m:1"), /ambiguous/);
});

test("resolveModelIdentity GETs only /api/tags with redirect:error, a timeout, and no body", async () => {
  const { fn, calls } = mockFetch(() => new Response(JSON.stringify(tags(entry("qwen3:8b")))));
  const id = await resolveModelIdentity(fn, "http://127.0.0.1:11434", "qwen3:8b", 5000);
  assert.equal(id.digest, `sha256:${HEX_A}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:11434/api/tags");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].init.signal instanceof AbortSignal);

  const down = mockFetch(() => new Response("boom", { status: 500 }));
  await assert.rejects(resolveModelIdentity(down.fn, "http://127.0.0.1:11434", "m:1", 5000), /http_error/);
  const big = mockFetch(() => new Response("x".repeat(1_000_001)));
  assert.equal(((await getJson(big.fn, "u", 1000)) as { kind: string }).kind, "bad_body");
});

test("identity recheck: unchanged, changed, unknown", async () => {
  const start = { canonical_tag: "qwen3:8b", digest: `sha256:${HEX_A}` };
  assert.deepEqual(compareModelIdentity(start, { ...start }), {
    status: "unchanged",
    end: start,
    error: null,
    identity_snapshots_match: true,
  });

  const host = "http://127.0.0.1:11434";
  const same = mockFetch(() => new Response(JSON.stringify(tags(entry("qwen3:8b")))));
  assert.equal((await recheckModelIdentity(same.fn, host, "qwen3:8b", start, 5000)).status, "unchanged");

  const retagged = mockFetch(() => new Response(JSON.stringify(tags(entry("qwen3:8b", HEX_B)))));
  const changed = await recheckModelIdentity(retagged.fn, host, "qwen3:8b", start, 5000);
  assert.equal(changed.status, "changed");
  assert.equal(changed.identity_snapshots_match, false);
  assert.equal(changed.end?.digest, `sha256:${HEX_B}`);

  for (const respond of [
    () => new Response(JSON.stringify(tags())),
    () => new Response("{}"),
    () => Promise.reject(new DOMException("timed out", "TimeoutError")),
  ]) {
    const r = await recheckModelIdentity(mockFetch(respond).fn, host, "qwen3:8b", start, 5000);
    assert.equal(r.status, "unknown");
    assert.equal(r.identity_snapshots_match, false);
    assert.equal(r.end, null);
    assert.ok(r.error);
  }
});

// ─── transport ──────────────────────────────────────────────────────────────

test("postJson classifies timeouts, redirects, HTTP errors, and bad bodies", async () => {
  const timeout = mockFetch(() => Promise.reject(new DOMException("timed out", "TimeoutError")));
  assert.equal(((await postJson(timeout.fn, "u", {}, 1000)) as { kind: string }).kind, "timeout");
  const redirect = mockFetch(() => Promise.reject(new TypeError("fetch failed: redirect mode is set to error")));
  assert.equal(((await postJson(redirect.fn, "u", {}, 1000)) as { kind: string }).kind, "transport_error");
  const http = mockFetch(() => new Response("boom", { status: 500 }));
  assert.equal(((await postJson(http.fn, "u", {}, 1000)) as { kind: string }).kind, "http_error");
  const html = mockFetch(() => new Response("<html>"));
  assert.equal(((await postJson(html.fn, "u", {}, 1000)) as { kind: string }).kind, "bad_body");
});

test("chat request mirrors strategic options and unloads with keep_alive 0", () => {
  const r = buildChatRequest("qwen3:8b", "SYS", "USER", 512);
  assert.equal(r.keep_alive, 0);
  assert.equal(r.stream, false);
  assert.equal(r.format, "json");
  assert.equal(r.think, false);
  assert.deepEqual(r.options, { temperature: 0.8, repeat_penalty: 1.15, num_predict: 512 });
  assert.equal(buildChatRequest("gpt-oss:20b", "S", "U", 1024).think, "low");
});

// ─── parsing ────────────────────────────────────────────────────────────────

test("JSON scan ignores braces and escaped quotes inside strings", () => {
  const raw = '{"thought":"use {x} and \\"}\\" here","action":"idle"} trailing {';
  assert.equal(findFirstJsonObject(raw), '{"thought":"use {x} and \\"}\\" here","action":"idle"}');
  assert.equal(parseFinalAnswer(raw).status, "valid");
  assert.equal(parseFinalAnswer('{"thought":"}}}","action":"eat"}').decision?.action, "eat");
});

test("final answer: empty, malformed, valid", () => {
  assert.equal(parseFinalAnswer("").status, "empty");
  assert.equal(parseFinalAnswer("  \n").status, "empty");
  assert.equal(parseFinalAnswer("<think>hmm</think>").status, "empty");
  assert.equal(parseFinalAnswer('{"action":"mine_block","params":{"blockType":"st').status, "malformed");
  assert.equal(parseFinalAnswer("{'action':'idle'}").status, "malformed");
  assert.equal(parseFinalAnswer('{"thought":"no action"}').status, "malformed");
  assert.equal(parseFinalAnswer('{"action":""}').status, "malformed");
  assert.equal(parseFinalAnswer('{"action":"idle","params":[1]}').status, "malformed");
  assert.equal(parseFinalAnswer("[1,2]").status, "malformed");
  assert.equal(parseFinalAnswer('```json\n{"action":"idle"}\n```').status, "valid");
});

// ─── classification + scoring with mocked chat responses ────────────────────

test("reasoning-only response: empty content, reasoning kept separately, not scored", () => {
  const c = classifyChatResponse(chatBody({}, { content: "", thinking: "I should mine {stone}" }), 1024);
  assert.equal(c.answer.status, "empty");
  assert.equal(c.reasoning, "I should mine {stone}");
  assert.equal(c.content, "");
  assert.deepEqual(scoreResponse(c, acceptMine), { scenario_accepts: null, counted_success: false });
});

test("length-exhausted response with truncated JSON is malformed and budget_exhausted", () => {
  const c = classifyChatResponse(
    chatBody({ done_reason: "length", eval_count: 1024 }, { content: '{"action":"mine_block","par' }),
    1024,
  );
  assert.equal(c.answer.status, "malformed");
  assert.equal(c.budget_exhausted, true);
  assert.equal(scoreResponse(c, acceptMine).counted_success, false);
});

test("budget-exhausted but valid, acceptable JSON is never a counted success", () => {
  const viaReason = classifyChatResponse(chatBody({ done_reason: "length" }), 1024);
  const viaCount = classifyChatResponse(chatBody({ eval_count: 256 }), 256);
  for (const c of [viaReason, viaCount]) {
    assert.equal(c.answer.status, "valid");
    assert.equal(c.budget_exhausted, true);
    assert.deepEqual(scoreResponse(c, acceptMine), { scenario_accepts: true, counted_success: false });
  }
});

test("valid stop response: correctness separate from validity", () => {
  const c = classifyChatResponse(chatBody(), 1024);
  assert.equal(c.answer.status, "valid");
  assert.equal(c.budget_exhausted, false);
  assert.deepEqual(c.metrics, {
    done_reason: "stop",
    eval_count: 40,
    prompt_eval_count: 900,
    total_duration_ns: 3e9,
    load_duration_ns: 2e9,
    prompt_eval_duration_ns: 5e8,
    eval_duration_ns: 5e8,
  });
  assert.deepEqual(scoreResponse(c, acceptMine), { scenario_accepts: true, counted_success: true });
  assert.deepEqual(
    scoreResponse(c, () => false),
    { scenario_accepts: false, counted_success: false },
  );
  const throwing = () => {
    throw new Error("x");
  };
  assert.deepEqual(scoreResponse(c, throwing), { scenario_accepts: false, counted_success: false });
});

test("missing done_reason is not counted as success", () => {
  const c = classifyChatResponse(chatBody({ done_reason: undefined }), 1024);
  assert.equal(scoreResponse(c, acceptMine).counted_success, false);
});

test("garbage bodies classify without throwing", () => {
  for (const body of [null, 42, "x", [], { message: "x" }, { message: { content: 7 } }]) {
    const c = classifyChatResponse(body, 1024);
    assert.equal(c.answer.status, "empty");
    assert.equal(c.metrics.done_reason, null);
  }
});

test("tally reports raw counts per scenario", () => {
  const t = tally([
    {
      scenario: "a",
      transport: "ok",
      answer_status: "valid",
      budget_exhausted: false,
      scenario_accepts: true,
      counted_success: true,
    },
    {
      scenario: "a",
      transport: "ok",
      answer_status: "valid",
      budget_exhausted: true,
      scenario_accepts: true,
      counted_success: false,
    },
    {
      scenario: "a",
      transport: "timeout",
      answer_status: null,
      budget_exhausted: null,
      scenario_accepts: null,
      counted_success: false,
    },
    {
      scenario: "b",
      transport: "ok",
      answer_status: "empty",
      budget_exhausted: false,
      scenario_accepts: null,
      counted_success: false,
    },
  ]);
  assert.deepEqual(t.a, {
    requests: 3,
    transport_errors: 1,
    empty: 0,
    malformed: 0,
    valid: 2,
    budget_exhausted: 1,
    scenario_accepts: 2,
    counted_success: 1,
  });
  assert.equal(t.b.empty, 1);
});
