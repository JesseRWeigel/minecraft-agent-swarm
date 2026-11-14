/**
 * Pure, typed helpers for the bounded local decision evaluation in
 * tools/decision-eval.ts. Nothing here runs at import time, touches a
 * Minecraft world, or executes model output. Network access happens only
 * through an injected `fetch` so tests can mock every response.
 *
 * See docs/decision-evaluation.md for the measurement contract.
 */

// ─── Limits ─────────────────────────────────────────────────────────────────

export const SAMPLES_DEFAULT = 1;
export const SAMPLES_MIN = 1;
export const SAMPLES_MAX = 3;
/** Matches num_predict in queryStrategic() (src/llm/index.ts). */
export const NUM_PREDICT_DEFAULT = 1024;
export const NUM_PREDICT_MIN = 128;
export const NUM_PREDICT_MAX = 2048;
/** Hard cap on /api/chat calls in one run. Checked before any network call. */
export const MAX_CHAT_REQUESTS = 12;
export const TIMEOUT_MS_DEFAULT = 120_000;
export const TIMEOUT_MS_MIN = 1_000;
export const TIMEOUT_MS_MAX = 120_000;
export const DEFAULT_HOST = "http://127.0.0.1:11434";
/** Response bodies larger than this are recorded as errors, not parsed. */
export const MAX_RESPONSE_BYTES = 1_000_000;

/** Sampling options copied from queryStrategic(); only num_predict is tunable. */
export const STRATEGIC_TEMPERATURE = 0.8;
export const STRATEGIC_REPEAT_PENALTY = 1.15;

// ─── Think policy ───────────────────────────────────────────────────────────

/**
 * Mirror of the private thinkFor() in src/llm/index.ts. A test reads that
 * source and fails if the production policy drifts from this copy.
 */
export function thinkFor(model: string): boolean | "low" {
  return model.includes("gpt-oss") ? "low" : false;
}

// ─── CLI validation ─────────────────────────────────────────────────────────

export interface EvalConfig {
  model: string;
  samples: number;
  scenarioNames: string[];
  numPredict: number;
  timeoutMs: number;
  host: string;
  outPath: string;
  chatRequests: number;
}

export const USAGE =
  "usage: npx tsx tools/decision-eval.ts <model> --out <new.jsonl> " +
  "[--samples 1..3] [--scenario <name>]... [--num-predict 128..2048] [--timeout-ms 1000..120000]";

/** Parses a base-10 integer and rejects anything outside [min, max]. */
export function parseBoundedInt(raw: string | undefined, name: string, min: number, max: number): number {
  if (raw === undefined || !/^\d{1,7}$/.test(raw)) {
    throw new Error(`${name} must be an integer in ${min}..${max} (got ${JSON.stringify(raw)})`);
  }
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`${name} must be in ${min}..${max} (got ${n})`);
  return n;
}

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

/**
 * Rejects names that are, or may be, Ollama cloud models. Fails closed: any
 * occurrence of "cloud" in the name is refused, as is anything that is not a
 * plain model reference. /api/show is still checked afterwards.
 */
export function assertLocalModelName(model: string): void {
  if (!MODEL_NAME.test(model) || model.includes("..") || model.includes("//")) {
    throw new Error(`invalid model name: ${JSON.stringify(model)}`);
  }
  if (/cloud/i.test(model)) {
    throw new Error(`refusing cloud model name: ${model}`);
  }
}

/**
 * Accepts only a plain loopback http origin: http://127.0.0.1[:port] or
 * http://[::1][:port], optionally with a single trailing slash. Hostnames
 * (including "localhost"), credentials, paths, queries, fragments, and
 * numeric aliases such as http://2130706433 are all rejected.
 * Returns the normalized origin with no trailing slash.
 */
export function validateLoopbackHost(raw: string): string {
  const literal = /^http:\/\/(127\.0\.0\.1|\[::1\])(:\d{1,5})?\/?$/;
  if (!literal.test(raw)) {
    throw new Error(`OLLAMA_HOST must be http://127.0.0.1[:port] or http://[::1][:port] (got ${JSON.stringify(raw)})`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`OLLAMA_HOST is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`OLLAMA_HOST is not a plain loopback origin: ${JSON.stringify(raw)}`);
  }
  if (url.port !== "" && (Number(url.port) < 1 || Number(url.port) > 65535)) {
    throw new Error(`OLLAMA_HOST port out of range: ${url.port}`);
  }
  return url.origin;
}

/**
 * Validates the full CLI before any network call. Throws with a specific
 * message on the first problem, including when samples × scenarios would
 * exceed MAX_CHAT_REQUESTS.
 */
export function parseEvalArgs(
  argv: readonly string[],
  knownScenarios: readonly string[],
  env: { OLLAMA_HOST?: string } = {},
): EvalConfig {
  const [model, ...rest] = argv;
  if (!model || model.startsWith("-")) throw new Error(USAGE);
  assertLocalModelName(model);

  let samples = SAMPLES_DEFAULT;
  let numPredict = NUM_PREDICT_DEFAULT;
  let timeoutMs = TIMEOUT_MS_DEFAULT;
  let outPath = "";
  const scenarioNames: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    const take = (): string => {
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      i++;
      return value;
    };
    switch (flag) {
      case "--samples":
        if (seen.has(flag)) throw new Error(`${flag} given twice`);
        samples = parseBoundedInt(take(), "--samples", SAMPLES_MIN, SAMPLES_MAX);
        break;
      case "--num-predict":
        if (seen.has(flag)) throw new Error(`${flag} given twice`);
        numPredict = parseBoundedInt(take(), "--num-predict", NUM_PREDICT_MIN, NUM_PREDICT_MAX);
        break;
      case "--timeout-ms":
        if (seen.has(flag)) throw new Error(`${flag} given twice`);
        timeoutMs = parseBoundedInt(take(), "--timeout-ms", TIMEOUT_MS_MIN, TIMEOUT_MS_MAX);
        break;
      case "--out":
        if (seen.has(flag)) throw new Error(`${flag} given twice`);
        outPath = take();
        break;
      case "--scenario": {
        const name = take();
        if (!knownScenarios.includes(name)) {
          throw new Error(`unknown scenario ${JSON.stringify(name)}; known: ${knownScenarios.join(", ")}`);
        }
        if (scenarioNames.includes(name)) throw new Error(`scenario ${name} given twice`);
        scenarioNames.push(name);
        break;
      }
      default:
        throw new Error(`unknown argument ${JSON.stringify(flag)}\n${USAGE}`);
    }
    seen.add(flag);
  }

  if (!outPath) throw new Error(`--out is required\n${USAGE}`);
  if (!outPath.endsWith(".jsonl")) throw new Error("--out must end in .jsonl");

  const selected = scenarioNames.length ? scenarioNames : [...knownScenarios];
  if (selected.length === 0) throw new Error("no scenarios to run");
  const chatRequests = samples * selected.length;
  if (chatRequests > MAX_CHAT_REQUESTS) {
    throw new Error(
      `${samples} samples × ${selected.length} scenarios = ${chatRequests} requests exceeds the hard cap of ` +
        `${MAX_CHAT_REQUESTS}; select fewer scenarios with --scenario or lower --samples`,
    );
  }

  const host = validateLoopbackHost(env.OLLAMA_HOST || DEFAULT_HOST);
  return { model, samples, scenarioNames: selected, numPredict, timeoutMs, host, outPath, chatRequests };
}

// ─── Request construction ───────────────────────────────────────────────────

export interface ChatRequestBody {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  stream: false;
  think: boolean | "low";
  format: "json";
  keep_alive: 0;
  options: { temperature: number; repeat_penalty: number; num_predict: number };
}

/** The user turn queryStrategic() builds when there is no memory section. */
export function buildUserPrompt(state: string): string {
  return `CURRENT STATE:\n${state}\n\nWhat should you do next? Respond with JSON.`;
}

export function buildChatRequest(model: string, system: string, user: string, numPredict: number): ChatRequestBody {
  return {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: false,
    think: thinkFor(model),
    format: "json",
    // Unload after every request so an aborted run never leaves the model
    // resident. Each request therefore includes load time; see load_duration.
    keep_alive: 0,
    options: {
      temperature: STRATEGIC_TEMPERATURE,
      repeat_penalty: STRATEGIC_REPEAT_PENALTY,
      num_predict: numPredict,
    },
  };
}

// ─── Transport ──────────────────────────────────────────────────────────────

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type TransportResult =
  | { ok: true; status: number; body: unknown; elapsedMs: number }
  | { ok: false; kind: "timeout" | "transport_error" | "http_error" | "bad_body"; error: string; elapsedMs: number };

/** POSTs JSON with redirects refused and a hard per-request timeout. */
export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  payload: unknown,
  timeoutMs: number,
): Promise<TransportResult> {
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    const e = err as { name?: string; message?: string };
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    return {
      ok: false,
      kind: timedOut ? "timeout" : "transport_error",
      error: String(e?.message ?? err),
      elapsedMs: elapsed(),
    };
  }
  if (text.length > MAX_RESPONSE_BYTES) {
    return { ok: false, kind: "bad_body", error: `response exceeds ${MAX_RESPONSE_BYTES} bytes`, elapsedMs: elapsed() };
  }
  if (!res.ok) {
    return { ok: false, kind: "http_error", error: `HTTP ${res.status}: ${text.slice(0, 300)}`, elapsedMs: elapsed() };
  }
  try {
    return { ok: true, status: res.status, body: JSON.parse(text) as unknown, elapsedMs: elapsed() };
  } catch {
    return { ok: false, kind: "bad_body", error: `non-JSON body: ${text.slice(0, 300)}`, elapsedMs: elapsed() };
  }
}

export interface LocalModelInfo {
  details: Record<string, unknown>;
}

/**
 * Inspects an /api/show body and fails closed unless it describes a local
 * model: any remote_host / remote_model key (cloud proxy), an error field, or
 * a missing `details` object is a refusal.
 */
export function assessShowResponse(body: unknown): LocalModelInfo {
  if (!isRecord(body)) throw new Error("/api/show returned a non-object body");
  if (typeof body.error === "string") throw new Error(`/api/show error: ${body.error}`);
  for (const key of ["remote_host", "remote_model"]) {
    if (key in body) throw new Error(`model is remote (/api/show has ${key}); refusing`);
  }
  if (!isRecord(body.details)) throw new Error("/api/show has no details object; cannot confirm a local model");
  if (body.details.format !== "gguf") throw new Error("/api/show does not identify local GGUF weights; refusing");
  return { details: body.details };
}

/** Calls /api/show (metadata only — it does not load or pull) and asserts locality. */
export async function verifyLocalModel(
  fetchImpl: FetchLike,
  host: string,
  model: string,
  timeoutMs: number,
): Promise<LocalModelInfo> {
  const r = await postJson(fetchImpl, `${host}/api/show`, { model }, timeoutMs);
  if (!r.ok) throw new Error(`/api/show failed (${r.kind}): ${r.error}`);
  return assessShowResponse(r.body);
}

// ─── Response classification ────────────────────────────────────────────────

export interface Decision {
  thought?: string;
  action?: string;
  params?: Record<string, unknown>;
  goal?: string;
}

export type AnswerStatus = "empty" | "malformed" | "valid";

export interface ParsedAnswer {
  status: AnswerStatus;
  decision: Decision | null;
  error: string | null;
}

/**
 * Finds the first complete top-level JSON object, ignoring braces inside
 * strings. Returns null if no balanced object exists (e.g. truncation).
 * Unlike production extractJSON() it never repairs truncated output.
 */
export function findFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Classifies the final answer (message.content only — reasoning is never
 * parsed). "valid" means a JSON object with a non-empty string `action`.
 */
export function parseFinalAnswer(content: string): ParsedAnswer {
  const cleaned = content
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^```json?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (cleaned === "") return { status: "empty", decision: null, error: null };
  const candidate = findFirstJsonObject(cleaned);
  if (candidate === null) return { status: "malformed", decision: null, error: "no complete JSON object" };
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch (err) {
    return { status: "malformed", decision: null, error: `JSON.parse: ${(err as Error).message}` };
  }
  if (!isRecord(value)) return { status: "malformed", decision: null, error: "JSON is not an object" };
  if (typeof value.action !== "string" || value.action.trim() === "") {
    return { status: "malformed", decision: null, error: "missing string action" };
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    return { status: "malformed", decision: null, error: "params is not an object" };
  }
  return { status: "valid", decision: value as unknown as Decision, error: null };
}

export interface ChatMetrics {
  done_reason: string | null;
  eval_count: number | null;
  prompt_eval_count: number | null;
  total_duration_ns: number | null;
  load_duration_ns: number | null;
  prompt_eval_duration_ns: number | null;
  eval_duration_ns: number | null;
}

export interface ClassifiedResponse {
  content: string;
  reasoning: string;
  metrics: ChatMetrics;
  answer: ParsedAnswer;
  budget_exhausted: boolean;
}

/** Splits an /api/chat body into content, reasoning, metrics, and status. */
export function classifyChatResponse(body: unknown, numPredict: number): ClassifiedResponse {
  const b = isRecord(body) ? body : {};
  const message = isRecord(b.message) ? b.message : {};
  const content = typeof message.content === "string" ? message.content : "";
  const reasoning = typeof message.thinking === "string" ? message.thinking : "";
  const metrics: ChatMetrics = {
    done_reason: typeof b.done_reason === "string" ? b.done_reason : null,
    eval_count: num(b.eval_count),
    prompt_eval_count: num(b.prompt_eval_count),
    total_duration_ns: num(b.total_duration),
    load_duration_ns: num(b.load_duration),
    prompt_eval_duration_ns: num(b.prompt_eval_duration),
    eval_duration_ns: num(b.eval_duration),
  };
  const budget_exhausted =
    metrics.done_reason === "length" || (metrics.eval_count !== null && metrics.eval_count >= numPredict);
  return { content, reasoning, metrics, answer: parseFinalAnswer(content), budget_exhausted };
}

export interface Scoring {
  /** Predicate verdict on a valid decision; null when there is nothing to judge. */
  scenario_accepts: boolean | null;
  /** Valid answer, done_reason "stop", budget not exhausted, predicate true. */
  counted_success: boolean;
}

/**
 * Scores a classified response. Budget-exhausted output never counts as a
 * success, even when its JSON happens to be valid and acceptable.
 */
export function scoreResponse(c: ClassifiedResponse, accept: (d: Decision) => boolean): Scoring {
  if (c.answer.status !== "valid" || !c.answer.decision) return { scenario_accepts: null, counted_success: false };
  let accepts: boolean;
  try {
    accepts = accept(c.answer.decision) === true;
  } catch {
    accepts = false;
  }
  const counted = accepts && !c.budget_exhausted && c.metrics.done_reason === "stop";
  return { scenario_accepts: accepts, counted_success: counted };
}

// ─── Summary ────────────────────────────────────────────────────────────────

export interface RequestRecord {
  scenario: string;
  transport: "ok" | "timeout" | "transport_error" | "http_error" | "bad_body";
  answer_status: AnswerStatus | null;
  budget_exhausted: boolean | null;
  scenario_accepts: boolean | null;
  counted_success: boolean;
}

export interface ScenarioTally {
  requests: number;
  transport_errors: number;
  empty: number;
  malformed: number;
  valid: number;
  budget_exhausted: number;
  scenario_accepts: number;
  counted_success: number;
}

/** Raw counts per scenario. Deliberately no rates: n ≤ 3 per scenario. */
export function tally(records: readonly RequestRecord[]): Record<string, ScenarioTally> {
  const out: Record<string, ScenarioTally> = {};
  for (const r of records) {
    const t = (out[r.scenario] ??= {
      requests: 0,
      transport_errors: 0,
      empty: 0,
      malformed: 0,
      valid: 0,
      budget_exhausted: 0,
      scenario_accepts: 0,
      counted_success: 0,
    });
    t.requests++;
    if (r.transport !== "ok") t.transport_errors++;
    if (r.answer_status) t[r.answer_status]++;
    if (r.budget_exhausted) t.budget_exhausted++;
    if (r.scenario_accepts) t.scenario_accepts++;
    if (r.counted_success) t.counted_success++;
  }
  return out;
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
