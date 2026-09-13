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

let launchCollectionContext: Readonly<CollectionContext> | null = null;

/** Snapshot once: later environment changes cannot relabel a running process. */
export function currentCollectionContext(): Readonly<CollectionContext> {
  if (launchCollectionContext) return launchCollectionContext;
  launchCollectionContext = Object.freeze({
    operationMode: process.env.DATASET_OPERATION_MODE || null,
    trialId: process.env.DATASET_TRIAL_ID || null,
    gitCommit: process.env.DATASET_GIT_COMMIT || null,
    dirtyDiffHash: process.env.DATASET_DIRTY_DIFF_HASH || null,
    worldSnapshotId: process.env.DATASET_WORLD_SNAPSHOT_ID || null,
  });
  return launchCollectionContext;
}
interface LaunchSourceEvidence {
  status: "captured" | "unavailable" | "invalid";
  capturedAt?: string;
  untrackedRuntimeFileCount?: number;
  untrackedRuntimeSha256?: string;
  manifestSha256?: string;
}

/** Preserve a bounded allowlisted projection of the supervisor assertion.
 * Matching fields identify the launch; they do not verify a world restore. */
export function launchSourceEvidence(
  raw: string | undefined,
  context: Readonly<CollectionContext>,
): LaunchSourceEvidence {
  if (!raw) return { status: "unavailable" };
  if (Buffer.byteLength(raw, "utf8") > 16384) return { status: "invalid" };
  try {
    const value = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.schema_version !== 1 ||
      value.operation_mode !== context.operationMode ||
      value.trial_id !== context.trialId ||
      value.git_commit !== context.gitCommit ||
      value.tracked_dirty_diff_sha256 !== context.dirtyDiffHash ||
      value.world_snapshot_id !== context.worldSnapshotId ||
      typeof value.captured_at_utc !== "string" ||
      value.captured_at_utc.length > 40 ||
      !value.captured_at_utc.endsWith("Z") ||
      !Number.isFinite(Date.parse(value.captured_at_utc)) ||
      !Number.isSafeInteger(value.untracked_runtime_file_count) ||
      value.untracked_runtime_file_count < 0 ||
      typeof value.untracked_runtime_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.untracked_runtime_sha256)
    ) {
      return { status: "invalid" };
    }
    return {
      status: "captured",
      capturedAt: value.captured_at_utc,
      untrackedRuntimeFileCount: value.untracked_runtime_file_count,
      untrackedRuntimeSha256: value.untracked_runtime_sha256,
      manifestSha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    };
  } catch {
    return { status: "invalid" };
  }
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
  "xapikey",
  "xaccesstoken",
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
    if (pending.length) throw new Error("telemetry event log has an unterminated final line");
  } finally {
    fs.closeSync(fd);
  }
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
  return safe || "unknown";
}

function runFileName(runId: string): string {
  const identity = createHash("sha256").update(runId, "utf8").digest("hex");
  return `${safeSegment(runId)}-${identity}.jsonl`;
}

interface PreparedPayload {
  bytes: Buffer;
  serializationError: unknown | null;
}

const UNAVAILABLE_REF = "unavailable:telemetry_incomplete";

function preparePayload(payload: unknown): PreparedPayload {
  try {
    return { bytes: payloadBytes(payload), serializationError: null };
  } catch (error) {
    return {
      bytes: payloadBytes({
        telemetryCapture: {
          originalPayloadCaptured: false,
          reason: "payload_serialization_failed",
        },
      }),
      serializationError: error,
    };
  }
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
    this.eventPath = path.join(this.rootDir, "events", runFileName(this.runId));
    this.clock = options.clock ?? Date.now;
    this.monotonicClock = options.monotonicClock ?? (() => performance.now());
    this.sequence = this.readLastSequence();
  }

  payloadPath(payloadRef: string): string {
    const match = /^sha256:([a-f0-9]{64})$/.exec(payloadRef);
    if (!match) throw new Error(`telemetry payload reference is unavailable: ${payloadRef}`);
    const hash = match[1];
    return path.join(this.rootDir, "payloads", hash.slice(0, 2), `${hash}.json`);
  }

  record(input: EpisodeEventInput, payload: unknown): EpisodeEvent {
    if (!this.health.complete) return this.unavailableEvent(input);

    const prepared = preparePayload(payload);
    const bytes = prepared.bytes;
    const payloadRef = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const event = this.createEvent(input, payloadRef, ++this.sequence);
    const persisted = this.write(event, bytes);
    if (prepared.serializationError !== null && persisted) {
      this.fail(new Error("payload serialization failed; diagnostic payload stored"));
    }
    return persisted ? event : { ...event, payloadRef: UNAVAILABLE_REF };
  }

  recordEpisodeEvent(event: EpisodeEvent, payload: unknown): EpisodeEvent {
    if (!this.health.complete) return { ...event, payloadRef: UNAVAILABLE_REF };
    if (event.runId !== this.runId) {
      this.fail(new Error(`telemetry event run ID does not match ${this.runId}`));
      return { ...event, payloadRef: "unavailable:run_id_mismatch" };
    }

    const prepared = preparePayload(payload);
    const bytes = prepared.bytes;
    const actualRef = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (prepared.serializationError === null && actualRef !== event.payloadRef) {
      this.fail(new Error(`telemetry payload reference mismatch for ${event.eventId}`));
      return { ...event, payloadRef: "unavailable:payload_reference_mismatch" };
    }
    const recorded = prepared.serializationError === null ? event : { ...event, payloadRef: actualRef };
    const persisted = this.write(recorded, bytes);
    if (persisted) this.sequence = Math.max(this.sequence, recorded.sequence);
    if (prepared.serializationError !== null && persisted) {
      this.fail(new Error("payload serialization failed; diagnostic payload stored"));
    }
    return persisted ? recorded : { ...recorded, payloadRef: UNAVAILABLE_REF };
  }

  recoverInterruptedActions(): number {
    if (!this.health.complete) return 0;
    const active = new Map<string, EpisodeEvent>();
    try {
      forEachJsonLine(this.eventPath, (event) => {
        this.assertMatchingRun(event);
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
        this.assertMatchingRun(event);
        if (typeof event.sequence === "number") last = Math.max(last, event.sequence);
      });
      return last;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.fail(error);
      return 0;
    }
  }

  private createEvent(input: EpisodeEventInput, payloadRef: string, sequence: number): EpisodeEvent {
    return {
      schemaVersion: 1,
      eventId: randomUUID(),
      runId: this.runId,
      episodeId: input.episodeId,
      botId: input.botId,
      sequence,
      actionId: input.actionId,
      requestId: input.requestId,
      occurredAt: new Date(this.clock()).toISOString(),
      monotonicMs: this.monotonicClock(),
      kind: input.kind,
      payloadRef,
    };
  }

  private unavailableEvent(input: EpisodeEventInput): EpisodeEvent {
    return this.createEvent(input, UNAVAILABLE_REF, this.sequence + 1);
  }

  private assertMatchingRun(event: EpisodeEvent): void {
    if (!event || typeof event !== "object" || event.runId !== this.runId) {
      throw new Error(`telemetry event run ID does not match ${this.runId}`);
    }
  }

  private write(event: EpisodeEvent, bytes: Buffer): boolean {
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
      return true;
    } catch (error) {
      this.fail(error);
      return false;
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
    const collection = currentCollectionContext();
    defaultRecorder.record(
      {
        episodeId: `${defaultRecorder.runId}:_collector`,
        botId: "_collector",
        actionId: null,
        requestId: null,
        kind: "observation",
      },
      {
        captureVersion: 1,
        stage: "run_context",
        provenanceSource: "launch_environment",
        launchSource: launchSourceEvidence(process.env.SWARM_LAUNCH_CONTEXT_JSON, collection),
        collection,
        missingFields: Object.entries(collection)
          .filter(([, value]) => value === null)
          .map(([key]) => key),
        claimsControlledTrial: false,
      },
    );
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

export function recordEpisodeEvent(event: EpisodeEvent, payload: unknown): EpisodeEvent {
  return getEpisodeEventRecorder().recordEpisodeEvent(event, payload);
}

export function setEpisodeEventRecorderForTests(recorder: EpisodeEventRecorder | null): void {
  defaultRecorder = recorder;
  launchCollectionContext = null;
}
