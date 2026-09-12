import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

export type ActionStatus = "succeeded" | "failed" | "blocked" | "cancelled" | "timed_out" | "unknown";

export interface ActionOutcome {
  actionId: string;
  status: ActionStatus;
  reasonCode: string;
  resultText: string;
  evidenceRefs: string[];
}

export interface EpisodeEvent {
  schemaVersion: 1;
  eventId: string;
  runId: string;
  episodeId: string;
  botId: string;
  sequence: number;
  actionId: string | null;
  requestId: string | null;
  occurredAt: string;
  monotonicMs: number;
  kind: "model_request" | "model_response" | "action_started" | "action_finished" | "observation" | "episode_finished";
  payloadRef: string;
}

export type EpisodeEventInput = Pick<EpisodeEvent, "episodeId" | "botId" | "actionId" | "requestId" | "kind">;

export interface CollectionContext {
  operationMode: string | null;
  trialId: string | null;
  gitCommit: string | null;
  dirtyDiffHash: string | null;
  worldSnapshotId: string | null;
}

export function currentCollectionContext(): CollectionContext {
  return {
    operationMode: process.env.DATASET_OPERATION_MODE || null,
    trialId: process.env.DATASET_TRIAL_ID || null,
    gitCommit: process.env.DATASET_GIT_COMMIT || null,
    dirtyDiffHash: process.env.DATASET_DIRTY_DIFF_HASH || null,
    worldSnapshotId: process.env.DATASET_WORLD_SNAPSHOT_ID || null,
  };
}
export interface TelemetryHealth {
  complete: boolean;
  lastError: string | null;
}

export interface EpisodeEventRecorderOptions {
  rootDir: string;
  runId: string;
  clock?: () => number;
  monotonicClock?: () => number;
}

const PRIVATE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "oauthtoken",
  "clientsecret",
  "password",
  "credential",
  "credentials",
]);

function isPrivateKey(key: string): boolean {
  return PRIVATE_KEYS.has(key.replace(/[-_]/g, "").toLowerCase());
}

function sanitize(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[CIRCULAR]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitize(item, ancestors));
    const source = value as Record<string, unknown>;
    const clean: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      clean[key] = isPrivateKey(key) ? "[REDACTED]" : sanitize(item, ancestors);
    }
    return clean;
  } finally {
    ancestors.delete(value);
  }
}

function payloadBytes(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(sanitize(payload)) + "\n", "utf8");
}

export function contentReference(payload: unknown): string {
  return `sha256:${createHash("sha256").update(payloadBytes(payload)).digest("hex")}`;
}

const MAX_EVENT_LINE_BYTES = 2 * 1024 * 1024;

function forEachJsonLine(file: string, visit: (event: EpisodeEvent) => void): void {
  const fd = fs.openSync(file, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let pending = Buffer.alloc(0);
  try {
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      let data = pending.length ? Buffer.concat([pending, chunk.subarray(0, count)]) : chunk.subarray(0, count);
      let newline: number;
      while ((newline = data.indexOf(0x0a)) >= 0) {
        const line = data.subarray(0, newline);
        if (line.length > MAX_EVENT_LINE_BYTES)
          throw new Error(`telemetry event line exceeds ${MAX_EVENT_LINE_BYTES} bytes`);
        if (line.length) visit(JSON.parse(line.toString("utf8")) as EpisodeEvent);
        data = data.subarray(newline + 1);
      }
      if (data.length > MAX_EVENT_LINE_BYTES)
        throw new Error(`telemetry event line exceeds ${MAX_EVENT_LINE_BYTES} bytes`);
      pending = Buffer.from(data);
    }
    if (pending.length) visit(JSON.parse(pending.toString("utf8")) as EpisodeEvent);
  } finally {
    fs.closeSync(fd);
  }
}
function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
  return safe || "unknown";
}

export class EpisodeEventRecorder {
  readonly rootDir: string;
  readonly runId: string;
  readonly eventPath: string;
  readonly health: TelemetryHealth = { complete: true, lastError: null };

  private readonly clock: () => number;
  private readonly monotonicClock: () => number;
  private sequence = 0;

  constructor(options: EpisodeEventRecorderOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.runId = options.runId;
    this.eventPath = path.join(this.rootDir, "events", `${safeSegment(this.runId)}.jsonl`);
    this.clock = options.clock ?? Date.now;
    this.monotonicClock = options.monotonicClock ?? (() => performance.now());
    this.sequence = this.readLastSequence();
  }

  payloadPath(payloadRef: string): string {
    const hash = payloadRef.replace(/^sha256:/, "");
    return path.join(this.rootDir, "payloads", hash.slice(0, 2), `${hash}.json`);
  }

  record(input: EpisodeEventInput, payload: unknown): EpisodeEvent {
    const bytes = payloadBytes(payload);
    const payloadRef = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const event: EpisodeEvent = {
      schemaVersion: 1,
      eventId: randomUUID(),
      runId: this.runId,
      episodeId: input.episodeId,
      botId: input.botId,
      sequence: ++this.sequence,
      actionId: input.actionId,
      requestId: input.requestId,
      occurredAt: new Date(this.clock()).toISOString(),
      monotonicMs: this.monotonicClock(),
      kind: input.kind,
      payloadRef,
    };
    this.write(event, bytes);
    return event;
  }

  recordEpisodeEvent(event: EpisodeEvent, payload: unknown): void {
    const bytes = payloadBytes(payload);
    const actualRef = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (actualRef !== event.payloadRef) {
      this.fail(new Error(`telemetry payload reference mismatch for ${event.eventId}`));
      return;
    }
    this.sequence = Math.max(this.sequence, event.sequence);
    this.write(event, bytes);
  }

  recoverInterruptedActions(): number {
    const active = new Map<string, EpisodeEvent>();
    try {
      forEachJsonLine(this.eventPath, (event) => {
        if (!event.actionId) return;
        if (event.kind === "action_started") active.set(event.actionId, event);
        if (event.kind === "action_finished") active.delete(event.actionId);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      this.fail(new Error(`telemetry event log is unreadable: ${(error as Error).message}`));
      return 0;
    }

    for (const start of active.values()) {
      const outcome: ActionOutcome = {
        actionId: start.actionId!,
        status: "unknown",
        reasonCode: "process_interrupted",
        resultText: "No terminal event was observed before process recovery.",
        evidenceRefs: [],
      };
      this.record(
        {
          episodeId: start.episodeId,
          botId: start.botId,
          actionId: start.actionId,
          requestId: start.requestId,
          kind: "action_finished",
        },
        { outcome, synthesized: true, synthesisReason: "unmatched_action_started" },
      );
    }
    return active.size;
  }

  private readLastSequence(): number {
    try {
      let last = 0;
      forEachJsonLine(this.eventPath, (event) => {
        if (typeof event.sequence === "number") last = Math.max(last, event.sequence);
      });
      return last;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.fail(error);
      return 0;
    }
  }

  private write(event: EpisodeEvent, bytes: Buffer): void {
    try {
      const blobPath = this.payloadPath(event.payloadRef);
      fs.mkdirSync(path.dirname(blobPath), { recursive: true, mode: 0o700 });
      try {
        fs.writeFileSync(blobPath, bytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!fs.readFileSync(blobPath).equals(bytes))
          throw new Error(`payload hash collision at ${blobPath}`, { cause: error });
      }
      fs.mkdirSync(path.dirname(this.eventPath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.eventPath, JSON.stringify(event) + "\n", { mode: 0o600 });
    } catch (error) {
      this.fail(error);
    }
  }

  markIncomplete(error: unknown): void {
    this.fail(error);
  }

  private fail(error: unknown): void {
    const message = `Episode telemetry incomplete: ${(error as Error)?.message ?? String(error)}`;
    this.health.complete = false;
    this.health.lastError = message;
    console.error(`[Telemetry] ${message}`);
  }
}

const DEFAULT_RUN_ID =
  process.env.DATASET_RUN_ID || `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomUUID()}`;
let defaultRecorder: EpisodeEventRecorder | null = null;

export function getEpisodeEventRecorder(): EpisodeEventRecorder {
  if (!defaultRecorder) {
    defaultRecorder = new EpisodeEventRecorder({
      rootDir: process.env.DATASET_EVENT_DIR || path.resolve("logs", "episode-events-v1"),
      runId: DEFAULT_RUN_ID,
    });
    defaultRecorder.recoverInterruptedActions();
  }
  return defaultRecorder;
}

export function currentRunId(): string {
  return getEpisodeEventRecorder().runId;
}

export function currentEpisodeId(botId: string): string {
  return `${currentRunId()}:${safeSegment(botId)}`;
}

export function appendEpisodeEvent(input: EpisodeEventInput, payload: unknown): EpisodeEvent {
  return getEpisodeEventRecorder().record(input, payload);
}

export function recordEpisodeEvent(event: EpisodeEvent, payload: unknown): void {
  getEpisodeEventRecorder().recordEpisodeEvent(event, payload);
}

export function setEpisodeEventRecorderForTests(recorder: EpisodeEventRecorder | null): void {
  defaultRecorder = recorder;
}
