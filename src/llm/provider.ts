// One chat() call the rest of the codebase uses, backed by either Ollama or any
// OpenAI-compatible endpoint. Provider metadata and the exact sent messages are
// captured here, before higher-level parsers transform the response.

import { randomUUID } from "node:crypto";
import { Ollama } from "ollama";
import { config } from "../config.js";
import {
  appendEpisodeEvent,
  currentCollectionContext,
  currentEpisodeId,
  type EpisodeEvent,
} from "../data/episode-events.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Ollama's sampling knobs, as used by the existing call sites. */
export interface ChatOptions {
  temperature?: number;
  repeat_penalty?: number;
  num_predict?: number;
}

export interface ChatTelemetryContext {
  botId: string;
  episodeId?: string;
  source: "strategic" | "reactive" | "critic" | "legacy" | "chat";
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Ollama-only reasoning control. Ignored by OpenAI-compatible endpoints. */
  think?: boolean | "low" | "medium" | "high";
  format?: "json";
  options?: ChatOptions;
  /** Capture correlation only; it is never sent to a provider. */
  telemetry?: ChatTelemetryContext;
}

export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** No price inference is performed in the capture layer. */
  costUsd: null;
}

export interface ProviderResponseMetadata {
  requestId: string;
  provider: "ollama" | "openai";
  model: string;
  providerModel: string | null;
  providerRequestId: string | null;
  durationMs: number;
  usage: ProviderUsage;
  origin: "provider";
}

export interface ChatResponse {
  message: { content: string };
  metadata?: ProviderResponseMetadata;
}

export interface ProviderTransportResult {
  response: ChatResponse;
  /** Parsed provider envelope used only for metadata extraction. */
  raw: unknown;
  /** Bounded wire response captured before JSON parsing, when available. */
  wire?: unknown;
}

export class ProviderCallError extends Error {
  readonly metadata: ProviderResponseMetadata;

  constructor(cause: unknown, metadata: ProviderResponseMetadata) {
    super((cause as Error)?.message ?? String(cause), { cause });
    this.name = "ProviderCallError";
    this.metadata = metadata;
  }
}

class ProviderTransportError extends Error {
  readonly raw: unknown;

  constructor(message: string, raw: unknown, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderTransportError";
    this.raw = raw;
  }
}

const ollama = new Ollama({ host: config.ollama.host });

/** Body for POST {baseUrl}/chat/completions. */
export function toOpenAIRequest(req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
  };
  if (req.format === "json") body.response_format = { type: "json_object" };
  if (req.options?.temperature !== undefined) body.temperature = req.options.temperature;
  if (req.options?.num_predict !== undefined) body.max_tokens = req.options.num_predict;
  return body;
}

/** Pull the assistant text out of an OpenAI chat completion. */
export function fromOpenAIResponse(data: unknown): ChatResponse {
  const choice = (data as { choices?: Array<{ message?: { content?: string | null } }> })?.choices?.[0];
  return { message: { content: choice?.message?.content ?? "" } };
}

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function usageFor(provider: "ollama" | "openai", raw: unknown): ProviderUsage {
  const value = (raw ?? {}) as Record<string, any>;
  const usage = (value.usage ?? {}) as Record<string, unknown>;
  const inputTokens = finiteCount(provider === "openai" ? usage.prompt_tokens : value.prompt_eval_count);
  const outputTokens = finiteCount(provider === "openai" ? usage.completion_tokens : value.eval_count);
  const suppliedTotal = finiteCount(usage.total_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: suppliedTotal ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    costUsd: null,
  };
}

function providerIdentifiers(raw: unknown): { providerModel: string | null; providerRequestId: string | null } {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    providerModel: typeof value.model === "string" ? value.model : null,
    providerRequestId: typeof value.id === "string" ? value.id : null,
  };
}

function recordModelEvent(req: ChatRequest, requestId: string, kind: EpisodeEvent["kind"], payload: unknown): void {
  const botId = req.telemetry?.botId ?? config.bot.name;
  appendEpisodeEvent(
    {
      botId,
      episodeId: req.telemetry?.episodeId ?? currentEpisodeId(botId),
      actionId: null,
      requestId,
      kind,
    },
    payload,
  );
}

/**
 * Capture one provider invocation around an injected transport. Exported so
 * metadata and telemetry can be tested without network calls.
 */
export async function chatWithTransport(
  req: ChatRequest,
  provider: "ollama" | "openai",
  transport: (request: ChatRequest) => Promise<ProviderTransportResult>,
): Promise<ChatResponse> {
  const requestId = randomUUID();
  const started = performance.now();
  recordModelEvent(req, requestId, "model_request", {
    captureVersion: 1,
    transformationVersion: provider === "openai" ? "openai-chat-request-v1" : "ollama-chat-request-v1",
    source: req.telemetry?.source ?? "legacy",
    model: req.model,
    request: provider === "openai" ? toOpenAIRequest(req) : { ...req, telemetry: undefined, stream: false },
    collection: currentCollectionContext(),
  });

  try {
    const result = await transport(req);
    const durationMs = performance.now() - started;
    const ids = providerIdentifiers(result.raw);
    const metadata: ProviderResponseMetadata = {
      requestId,
      provider,
      model: req.model,
      ...ids,
      durationMs,
      usage: usageFor(provider, result.raw),
      origin: "provider",
    };
    recordModelEvent(req, requestId, "model_response", {
      captureVersion: 1,
      ok: true,
      raw: result.wire ?? result.raw,
      metadata,
    });
    return { ...result.response, metadata };
  } catch (error) {
    const metadata: ProviderResponseMetadata = {
      requestId,
      provider,
      model: req.model,
      providerModel: null,
      providerRequestId: null,
      durationMs: performance.now() - started,
      usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null },
      origin: "provider",
    };
    recordModelEvent(req, requestId, "model_response", {
      captureVersion: 1,
      ok: false,
      error: { name: (error as Error)?.name ?? "Error", message: (error as Error)?.message ?? String(error) },
      raw: error instanceof ProviderTransportError ? error.raw : null,
      metadata,
    });
    throw new ProviderCallError(error, metadata);
  }
}

const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

async function readBoundedResponse(response: Response): Promise<{ bodyText: string; truncated: boolean }> {
  if (!response.body) return { bodyText: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bodyText: Buffer.concat(chunks).toString("utf8"), truncated: false };
    if (!value) continue;
    const remaining = MAX_PROVIDER_RESPONSE_BYTES - bytes;
    if (value.byteLength > remaining) {
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      void reader.cancel().catch(() => {});
      return { bodyText: Buffer.concat(chunks).toString("utf8"), truncated: true };
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
}

export async function openAITransport(
  req: ChatRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderTransportResult> {
  const { baseUrl, apiKey } = config.openai;
  const res = await fetchImpl(baseUrl.replace(/\/+$/, "") + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify(toOpenAIRequest(req)),
  });
  const wire = await readBoundedResponse(res);
  const rawResponse = {
    status: res.status,
    statusText: res.statusText,
    bodyText: wire.bodyText,
    truncated: wire.truncated,
  };

  if (wire.truncated) {
    throw new ProviderTransportError("OpenAI response exceeded " + MAX_PROVIDER_RESPONSE_BYTES + " bytes", rawResponse);
  }
  if (!res.ok) {
    throw new ProviderTransportError("OpenAI request failed: " + res.status + " " + res.statusText, rawResponse);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(wire.bodyText);
  } catch (error) {
    throw new ProviderTransportError("OpenAI response was not valid JSON", rawResponse, { cause: error });
  }
  return { response: fromOpenAIResponse(raw), raw, wire: rawResponse };
}

async function ollamaTransport(req: ChatRequest): Promise<ProviderTransportResult> {
  const { telemetry: _telemetry, ...providerRequest } = req;
  const raw = await ollama.chat({ ...providerRequest, stream: false });
  return { response: raw as ChatResponse, raw };
}

/** Send a chat request to whichever provider is configured. */
export async function chat(req: ChatRequest): Promise<ChatResponse> {
  if (config.llm.provider === "openai") return chatWithTransport(req, "openai", openAITransport);
  return chatWithTransport(req, "ollama", ollamaTransport);
}

/** Fail at startup, not on the first decision. */
export function assertProviderConfigured(): void {
  if (config.llm.provider !== "openai") return;
  if (!config.openai.apiKey) {
    throw new Error(
      "LLM_PROVIDER=openai but OPENAI_API_KEY is not set. " +
        "Add it to .env, or unset LLM_PROVIDER to use local Ollama.",
    );
  }
  if (!config.openai.model) {
    throw new Error(
      "LLM_PROVIDER=openai but OPENAI_MODEL is not set. " +
        "Model IDs change often, so pick a current one from your provider " +
        `(OpenAI: curl ${config.openai.baseUrl}/models -H "Authorization: Bearer $OPENAI_API_KEY"). ` +
        "See the OpenAI section of the README for examples.",
    );
  }
}
