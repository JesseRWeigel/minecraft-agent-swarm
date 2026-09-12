import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EpisodeEventRecorder, setEpisodeEventRecorderForTests } from "../data/episode-events.js";
import { BotBrain } from "./brain.js";

setEpisodeEventRecorderForTests(
  new EpisodeEventRecorder({ rootDir: mkdtempSync(path.join(tmpdir(), "brain-pause-events-")), runId: "pause-run" }),
);

function bareBrain() {
  const calls: string[] = [];
  const brain: any = Object.create(BotBrain.prototype);
  brain.bot = { username: "Atlas" };
  brain.roleConfig = { name: "Atlas" };
  brain.paused = false;
  brain.stopped = false;
  brain.processing = false;
  brain.eventQueue = [{ type: "strategic" }];
  brain.idleTimer = null;
  brain.currentGoal = "mine diamonds";
  brain.activeAction = "";
  brain.lastAction = "explore";
  brain.memStore = { getSeasonGoal: () => "season goal" };
  brain.resetIdleTimer = () => calls.push("timer");
  brain.triggerReplan = () => calls.push("replan");
  return { brain, calls };
}

test("pause drops queued work and rejects new events", () => {
  const { brain } = bareBrain();
  brain.pause();
  assert.equal(brain.getStatus().paused, true);
  assert.deepEqual(brain.eventQueue, []);
  brain.pushEvent({ type: "strategic", priority: 5, timestamp: Date.now() });
  assert.deepEqual(brain.eventQueue, []);
});

test("status reports an action while it is executing", () => {
  const { brain } = bareBrain();
  brain.processing = true;
  brain.activeAction = "go_to";
  assert.equal(brain.getStatus().action, "go_to");
});

test("a decision completed after pause cannot start an action", async () => {
  const { brain } = bareBrain();
  brain.pause();
  await brain.executeDecision({ thought: "continue", action: "explore", params: {} });
  assert.equal(brain.lastAction, "explore");
});

test("resume restarts planning once and cannot revive a stopped brain", () => {
  const active = bareBrain();
  active.brain.pause();
  active.brain.resume();
  assert.equal(active.brain.getStatus().paused, false);
  assert.deepEqual(active.calls, ["timer", "replan"]);
  active.brain.resume();
  assert.deepEqual(active.calls, ["timer", "replan"]);

  const stopped = bareBrain();
  stopped.brain.pause();
  stopped.brain.stopped = true;
  stopped.brain.resume();
  assert.equal(stopped.brain.getStatus().paused, true);
  assert.deepEqual(stopped.calls, []);
});
