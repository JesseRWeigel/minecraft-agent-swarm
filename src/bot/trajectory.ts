/**
 * Versioned trajectory summary for prospective collection.
 *
 * Historical files under logs/trajectories are immutable and retain their
 * original labels. New rows live under logs/trajectories-v2 and refer to the
 * provider request/action IDs recorded by the episode-event store.
 */

import fs from "node:fs";
import path from "node:path";
import {
  currentCollectionContext,
  getEpisodeEventRecorder,
  type ActionOutcome,
  type CollectionContext,
  type EpisodeEventRecorder,
} from "../data/episode-events.js";
import type { ProviderResponseMetadata, ProviderUsage } from "../llm/provider.js";

const SESSION_ID = new Date().toISOString().replace(/[:.]/g, "-");

export interface TrajectoryModelMetadata {
  origin: "provider" | "local_fallback" | "deterministic";
  provider: ProviderResponseMetadata["provider"] | null;
  model: string | null;
  providerModel: string | null;
  providerRequestId: string | null;
  durationMs: number | null;
  usage: ProviderUsage;
}

export interface TrajectoryTelemetry {
  runId: string;
  complete: boolean;
  lastError: string | null;
  collection: CollectionContext;
}

export interface TrajectoryEntryV2 {
  schemaVersion: 2;
  bot: string;
  requestId: string | null;
  actionId: string;
  decision: { thought: string; action: string; params: Record<string, any>; goal?: string };
  outcome: ActionOutcome;
  model: TrajectoryModelMetadata;
  telemetry: TrajectoryTelemetry;
  timestamp: string;
}

export type TrajectoryEntryInput = Omit<TrajectoryEntryV2, "telemetry">;
export type TrajectoryRecorder = (entry: TrajectoryEntryInput) => void;

export function createTrajectoryRecorder(
  logRoot: string,
  sessionId = SESSION_ID,
  injectedEventRecorder?: EpisodeEventRecorder,
): TrajectoryRecorder {
  const file = path.join(
    path.resolve(logRoot),
    "trajectories-v2",
    `${sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}.jsonl`,
  );
  return (entry) => {
    const eventRecorder = injectedEventRecorder ?? getEpisodeEventRecorder();
    const completedEntry: TrajectoryEntryV2 = {
      ...entry,
      telemetry: {
        runId: eventRecorder.runId,
        complete: eventRecorder.health.complete,
        lastError: eventRecorder.health.lastError,
        collection: currentCollectionContext(),
      },
    };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, JSON.stringify(completedEntry) + "\n", { mode: 0o600 });
    } catch (error) {
      const message = `Trajectory write failed: ${(error as Error)?.message ?? String(error)}`;
      eventRecorder.markIncomplete(new Error(message));
    }
  };
}

const defaultRecorder = createTrajectoryRecorder(path.resolve("logs"));

export function recordTrajectory(entry: TrajectoryEntryInput): void {
  defaultRecorder(entry);
}
