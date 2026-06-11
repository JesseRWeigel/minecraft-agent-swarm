/**
 * Trajectory logger — training-data capture for local-model fine-tuning.
 *
 * Every strategic decision is appended as one JSONL line: the exact prompt
 * the model saw, the decision it made, and whether the resulting action
 * succeeded. scripts/extract-finetune-dataset.mjs filters successful
 * trajectories into chat-format training data (the approach behind
 * mindcraft's "Andy" models: fine-tune a small local model on the team's
 * own successful action sequences).
 */

import fs from "fs";
import path from "path";

const SESSION_ID = new Date().toISOString().replace(/[:.]/g, "-");
const TRAJ_DIR = path.resolve("logs", "trajectories");
let streamReady = false;

export interface TrajectoryEntry {
  bot: string;
  /** Full system prompt the model saw */
  system: string;
  /** Full user/context message the model saw */
  context: string;
  /** Raw decision the model produced */
  decision: { thought: string; action: string; params: Record<string, any>; goal?: string };
  /** Action result string */
  result: string;
  success: boolean;
  timestamp: string;
}

export function recordTrajectory(entry: TrajectoryEntry): void {
  try {
    if (!streamReady) {
      fs.mkdirSync(TRAJ_DIR, { recursive: true });
      streamReady = true;
    }
    fs.appendFileSync(path.join(TRAJ_DIR, `${SESSION_ID}.jsonl`), JSON.stringify(entry) + "\n");
  } catch {
    /* never let telemetry break the bot */
  }
}
