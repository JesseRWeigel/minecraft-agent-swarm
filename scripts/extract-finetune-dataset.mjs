/**
 * Extract a fine-tuning dataset from recorded bot trajectories.
 *
 * Reads logs/trajectories/*.jsonl (written by src/bot/trajectory.ts),
 * keeps strategic decisions whose action SUCCEEDED, and emits chat-format
 * training examples to finetune/dataset.jsonl:
 *   {"messages":[{"role":"system",...},{"role":"user",...},{"role":"assistant",...}]}
 *
 * Usage: node scripts/extract-finetune-dataset.mjs [--min-thought-len 10]
 */

import fs from "fs";
import path from "path";

const TRAJ_DIR = path.resolve("logs", "trajectories");
const OUT_DIR = path.resolve("finetune");
const OUT_FILE = path.join(OUT_DIR, "dataset.jsonl");

if (!fs.existsSync(TRAJ_DIR)) {
  console.error(`No trajectories at ${TRAJ_DIR} — run the bots first.`);
  process.exit(1);
}

// Cap any single action's share of the dataset — go_to is >50% of raw
// successes, and an unbalanced dataset teaches "always go_to".
const MAX_PER_ACTION = parseInt(process.argv.find((a) => a.startsWith("--cap="))?.split("=")[1] ?? "350");

let total = 0;
let kept = 0;
const seen = new Set(); // dedupe identical context→decision pairs
const perAction = new Map();
const out = [];

for (const file of fs.readdirSync(TRAJ_DIR).filter((f) => f.endsWith(".jsonl"))) {
  for (const line of fs.readFileSync(path.join(TRAJ_DIR, file), "utf-8").split("\n")) {
    if (!line.trim()) continue;
    total++;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e.success) continue; // only train on what worked
    if (!e.decision?.action || e.decision.action === "idle") continue;

    const assistant = JSON.stringify({
      thought: e.decision.thought,
      action: e.decision.action,
      params: e.decision.params ?? {},
      ...(e.decision.goal ? { goal: e.decision.goal } : {}),
    });

    const key = `${e.context.slice(0, 200)}→${assistant}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const actionCount = perAction.get(e.decision.action) ?? 0;
    if (actionCount >= MAX_PER_ACTION) continue;
    perAction.set(e.decision.action, actionCount + 1);

    out.push(
      JSON.stringify({
        messages: [
          { role: "system", content: e.system },
          { role: "user", content: `${e.context}\n\nWhat should you do next? Respond with JSON.` },
          { role: "assistant", content: assistant },
        ],
      }),
    );
    kept++;
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, out.join("\n") + "\n");
console.log(`Extracted ${kept}/${total} successful trajectories → ${OUT_FILE}`);
console.log("Per-action counts:", Object.fromEntries([...perAction.entries()].sort((a, b) => b[1] - a[1])));
if (kept < 200) {
  console.log("⚠ Fewer than 200 examples — let the bots run longer before fine-tuning.");
}
