import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Vec3 } from "vec3";

import { EpisodeEventRecorder, setEpisodeEventRecorderForTests } from "../data/episode-events.js";
import { BotBrain } from "./brain.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup() {
  const actions: Array<{ action: string; result: string }> = [];
  const brain: any = Object.create(BotBrain.prototype);
  brain.bot = {
    username: "Atlas",
    health: 20,
    food: 20,
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [], slots: [] },
    time: { timeOfDay: 1000 },
    pathfinder: { setGoal: () => {} },
    stopDigging: () => {},
    blockAt: () => ({ name: "air" }),
    chat: () => {},
  };
  brain.roleConfig = {
    name: "Atlas",
    allowedActions: ["chat", "explore", "mine_block"],
    allowedSkills: [],
  };
  brain.events = {
    onThought: () => {},
    onAction: (action: string, result: string) => actions.push({ action, result }),
    onChat: () => {},
  };
  brain.memStore = { getDeaths: () => [], getSeasonGoal: () => "", getMemoryContext: () => "" };
  brain.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  brain.paused = false;
  brain.stopped = false;
  brain.activeAction = "";
  brain.currentGoal = "";
  brain.goalStepsLeft = 0;
  brain.lastAction = "";
  brain.lastResult = "";
  brain.lastActionWasSuccess = false;
  brain.recentFailures = new Map();
  brain.failureExpiry = new Map();
  brain.failureCounts = new Map();
  brain.blockCounts = new Map();
  brain.recentStalls = [];
  brain.recentHistory = [];
  brain.repeatCount = 0;
  brain.sameResultCount = 0;
  brain.lastResultSig = "";
  brain.successesSinceLastExpiry = 0;
  brain.lastChatSent = "";
  brain.lastChatSentMs = 0;
  brain.CRITIC_ENABLED = false;
  brain.speechGenerator = async () => null;
  brain.overlayUpdater = () => {};
  brain.skillOutcomeReader = () => undefined;
  brain.actionExecutor = async (_bot: unknown, action: string, params: Record<string, unknown>) =>
    action === "chat" ? `Said: ${params.message}` : "Arrived.";
  brain.interruptionGeneration = 0;
  brain.interruptionHistory = [];
  brain.triggerReplan = () => {};
  brain.resetIdleTimer = () => {};

  const recorder = new EpisodeEventRecorder({
    rootDir: mkdtempSync(path.join(tmpdir(), "brain-events-")),
    runId: "brain-run",
  });
  setEpisodeEventRecorderForTests(recorder);
  return { brain, actions, recorder };
}

function payloads(recorder: EpisodeEventRecorder) {
  return readFileSync(recorder.eventPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .map((event) => ({
      event,
      payload: JSON.parse(readFileSync(recorder.payloadPath(event.payloadRef), "utf8")),
    }));
}

test("a successful action followed by role denial returns a fresh blocked outcome", async () => {
  const { brain, recorder } = setup();
  const first = await brain.executeDecision({
    thought: "say hello",
    action: "chat",
    params: { message: "hello" },
    metadata: { requestId: "request-success" },
  });
  const rejected = await brain.executeDecision({
    thought: "wrong role",
    action: "attack",
    params: {},
    metadata: { requestId: "request-role" },
  });

  assert.equal(first.status, "succeeded");
  assert.equal(rejected.status, "blocked");
  assert.equal(rejected.reasonCode, "role_denied");
  assert.notEqual(first.actionId, rejected.actionId);
  const rejectedEvent = payloads(recorder).find(
    ({ event }) => event.kind === "action_finished" && event.actionId === rejected.actionId,
  );
  assert.equal(rejectedEvent?.event.actionId, rejected.actionId);
  assert.equal(rejectedEvent?.payload.originalSuccess, undefined);
});

test("a successful action followed by a blacklist rejection cannot inherit success", async () => {
  const { brain } = setup();
  const first = await brain.executeDecision({ thought: "say", action: "chat", params: { message: "one" } });
  brain.recentFailures.set("explore", "failed before");
  brain.failureExpiry.set("explore", Date.now() + 60_000);
  const rejected = await brain.executeDecision({ thought: "walk", action: "explore", params: {} });
  assert.equal(first.status, "succeeded");
  assert.equal(rejected.status, "blocked");
  assert.equal(rejected.reasonCode, "recent_failure_gate");
});

test("duplicate chat and invalid chat parameters are explicit blocked outcomes", async () => {
  const { brain } = setup();
  await brain.executeDecision({ thought: "say", action: "chat", params: { message: "repeat" } });
  const duplicate = await brain.executeDecision({
    thought: "say again",
    action: "chat",
    params: { message: "repeat" },
  });
  const invalid = await brain.executeDecision({ thought: "say nothing", action: "chat", params: {} });
  assert.equal(duplicate.status, "blocked");
  assert.equal(duplicate.reasonCode, "duplicate_chat");
  assert.equal(invalid.status, "blocked");
  assert.equal(invalid.reasonCode, "invalid_params");
});

test("callback exceptions produce one failed terminal outcome", async () => {
  const { brain, recorder } = setup();
  brain.actionExecutor = async () => {
    throw new Error("executor exploded");
  };
  const outcome = await brain.executeDecision({ thought: "try", action: "explore", params: {} });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.reasonCode, "execution_exception");
  assert.match(outcome.resultText, /executor exploded/);
  const terminals = payloads(recorder).filter(({ event }) => event.kind === "action_finished");
  assert.equal(terminals.length, 1);
});

test("concurrent invocations resolving backwards keep request, action, and evidence joins", async () => {
  const { brain, recorder } = setup();
  const first = deferred<string>();
  const second = deferred<string>();
  brain.actionExecutor = async (_bot: unknown, _action: string, params: { order: number }) =>
    params.order === 1 ? first.promise : second.promise;
  const p1 = brain.executeDecision({
    thought: "first",
    action: "explore",
    params: { order: 1 },
    metadata: { requestId: "request-1" },
  });
  const p2 = brain.executeDecision({
    thought: "second",
    action: "mine_block",
    params: { order: 2 },
    metadata: { requestId: "request-2" },
  });
  second.resolve("Unknown second result");
  const out2 = await p2;
  first.resolve("Unknown first result");
  const out1 = await p1;

  assert.notEqual(out1.actionId, out2.actionId);
  const terminals = payloads(recorder).filter(({ event }) => event.kind === "action_finished");
  const firstTerminal = terminals.find(({ event }) => event.actionId === out1.actionId)!;
  const secondTerminal = terminals.find(({ event }) => event.actionId === out2.actionId)!;
  assert.equal(firstTerminal.event.requestId, "request-1");
  assert.equal(secondTerminal.event.requestId, "request-2");
  assert.deepEqual(firstTerminal.payload.outcome.evidenceRefs, out1.evidenceRefs);
  assert.deepEqual(secondTerminal.payload.outcome.evidenceRefs, out2.evidenceRefs);
});

test("pause during an invocation records cancellation and positive prose stays unknown", async () => {
  const { brain } = setup();
  const pending = deferred<string>();
  brain.actionExecutor = async () => pending.promise;
  const running = brain.executeDecision({ thought: "walk", action: "explore", params: {} });
  brain.pause();
  pending.resolve("Arrived.");
  const cancelled = await running;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.reasonCode, "paused_during_action");

  brain.resume();
  brain.resetIdleTimer = () => {};
  brain.actionExecutor = async () => "Arrived.";
  const unknown = await brain.executeDecision({ thought: "walk", action: "explore", params: {} });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.reasonCode, "unverified_builtin_result");
});

test("paused, timed-out, and death-interrupted invocations get distinct terminal reasons", async () => {
  const pausedSetup = setup();
  pausedSetup.brain.pause();
  const paused = await pausedSetup.brain.executeDecision({ thought: "wait", action: "explore", params: {} });
  assert.equal(paused.status, "cancelled");
  assert.equal(paused.reasonCode, "brain_paused");

  const timeoutSetup = setup();
  timeoutSetup.brain.actionExecutor = async () => 'Action "explore" timed out after 150s — aborted to free the brain.';
  const timedOut = await timeoutSetup.brain.executeDecision({ thought: "walk", action: "explore", params: {} });
  assert.equal(timedOut.status, "timed_out");
  assert.equal(timedOut.reasonCode, "action_timeout");

  const deathSetup = setup();
  const pending = deferred<string>();
  deathSetup.brain.actionExecutor = async () => pending.promise;
  const running = deathSetup.brain.executeDecision({ thought: "mine", action: "mine_block", params: {} });
  deathSetup.brain.markDeathInterruption();
  pending.resolve("Mined 1 stone.");
  const interrupted = await running;
  assert.equal(interrupted.status, "cancelled");
  assert.equal(interrupted.reasonCode, "death_interrupted");
});

test("deterministic override execution is captured without a provider request", async () => {
  const { brain, recorder } = setup();
  brain.actionExecutor = async () => "Unknown deterministic result";
  const result = await brain.executeActionUnlessPaused("explore", { direction: "north" });
  assert.equal(result, "Unknown deterministic result");
  const records = payloads(recorder);
  const started = records.find(({ event }) => event.kind === "action_started")!;
  const finished = records.find(({ event }) => event.kind === "action_finished")!;
  assert.equal(started.event.requestId, null);
  assert.equal(started.payload.origin, "deterministic");
  assert.equal(finished.payload.outcome.status, "unknown");
});

test("the normalized chat event contains the message actually sent", async () => {
  const { brain, recorder } = setup();
  await brain.executeDecision({ thought: "say", action: "chat", params: { message: "sentinel chat" } });
  const normalized = payloads(recorder).find(({ payload }) => payload.stage === "normalized_decision")!;
  assert.equal(normalized.payload.params.message, "sentinel chat");
});

test("stopped brains and the drowning guard produce explicit non-execution outcomes", async () => {
  const stoppedSetup = setup();
  let stoppedExecuted = false;
  stoppedSetup.brain.actionExecutor = async () => {
    stoppedExecuted = true;
    return "Arrived.";
  };
  stoppedSetup.brain.stop();
  const stopped = await stoppedSetup.brain.executeDecision({ thought: "walk", action: "explore", params: {} });
  assert.equal(stopped.status, "cancelled");
  assert.equal(stopped.reasonCode, "brain_stopped");
  assert.equal(stoppedExecuted, false);

  const drowningSetup = setup();
  drowningSetup.brain.bot.oxygenLevel = 8;
  drowningSetup.brain.bot.blockAt = () => ({ name: "water", getProperties: () => ({}) });
  let drowningExecuted = false;
  drowningSetup.brain.actionExecutor = async () => {
    drowningExecuted = true;
    return "Arrived.";
  };
  const drowning = await drowningSetup.brain.executeDecision({ thought: "walk", action: "explore", params: {} });
  assert.equal(drowning.status, "blocked");
  assert.equal(drowning.reasonCode, "drowning_safety_gate");
  assert.equal(drowningExecuted, false);
});

test("pre-execution callback failures still produce exactly one terminal event", async () => {
  const { brain, recorder } = setup();
  let executed = false;
  brain.events.onThought = () => {
    throw new Error("overlay event bus unavailable");
  };
  brain.actionExecutor = async () => {
    executed = true;
    return "Arrived.";
  };
  const outcome = await brain.executeDecision({ thought: "walk", action: "explore", params: {} });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.reasonCode, "decision_pipeline_exception");
  assert.equal(executed, false);
  const terminals = payloads(recorder).filter(({ event }) => event.kind === "action_finished");
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].event.actionId, outcome.actionId);
});

test("benign prose containing failure words remains unverified", async () => {
  for (const result of ["No dangers found.", "Completed despite an earlier timed out route."]) {
    const { brain } = setup();
    brain.actionExecutor = async () => result;
    const outcome = await brain.executeDecision({ thought: "look", action: "explore", params: {} });
    assert.equal(outcome.status, "unknown");
    assert.equal(outcome.reasonCode, "unverified_builtin_result");
  }
});

test("skill-reported success is retained as unverified evidence, not mission success", async () => {
  const { brain, recorder } = setup();
  brain.roleConfig.allowedSkills = ["build_house"];
  brain.actionExecutor = async () => "Skill build_house completed.";
  brain.skillOutcomeReader = () => true;
  const outcome = await brain.executeDecision({ thought: "build", action: "build_house", params: {} });
  assert.equal(outcome.status, "unknown");
  assert.equal(outcome.reasonCode, "skill_reported_success_unverified");
  const terminal = payloads(recorder).find(({ event }) => event.kind === "action_finished")!;
  assert.equal(terminal.payload.reportedSuccess, true);
  assert.equal(terminal.payload.verifiedMissionProgress, null);
});

test("a same-skill concurrency rejection cannot consume a stale reported success", async () => {
  const { brain } = setup();
  brain.roleConfig.allowedSkills = ["build_house"];
  brain.actionExecutor = async () => 'Already running skill "build_house". Wait for it to finish.';
  brain.skillOutcomeReader = () => true;
  const outcome = await brain.executeDecision({ thought: "build twice", action: "build_house", params: {} });
  assert.equal(outcome.status, "blocked");
  assert.equal(outcome.reasonCode, "skill_already_running");
});

test("pause attribution survives resume for both fulfillment and rejection", async () => {
  const fulfilledSetup = setup();
  const fulfillment = deferred<string>();
  fulfilledSetup.brain.actionExecutor = async () => fulfillment.promise;
  const fulfilling = fulfilledSetup.brain.executeDecision({ thought: "walk", action: "explore", params: {} });
  fulfilledSetup.brain.pause();
  fulfilledSetup.brain.resume();
  fulfillment.resolve("Arrived.");
  const fulfilled = await fulfilling;
  assert.equal(fulfilled.status, "cancelled");
  assert.equal(fulfilled.reasonCode, "paused_during_action");

  const rejectedSetup = setup();
  let rejectAction!: (error: Error) => void;
  const rejection = new Promise<string>((_resolve, reject) => {
    rejectAction = reject;
  });
  rejectedSetup.brain.actionExecutor = async () => rejection;
  const rejecting = rejectedSetup.brain.executeDecision({ thought: "walk", action: "explore", params: {} });
  rejectedSetup.brain.pause();
  rejectedSetup.brain.resume();
  rejectAction(new Error("late path rejection"));
  const rejected = await rejecting;
  assert.equal(rejected.status, "cancelled");
  assert.equal(rejected.reasonCode, "paused_during_action");
  assert.match(rejected.resultText, /late path rejection/);
});

test("ungated deterministic reflexes preserve their direct action behavior and are captured", async () => {
  const { brain, recorder } = setup();
  let executed = false;
  brain.paused = true;
  brain.actionExecutor = async () => {
    executed = true;
    return "Fled 12 blocks.";
  };
  const result = await brain.executeDeterministicAction("flee", {}, "Respawn hostile reflex");
  assert.equal(result, "Fled 12 blocks.");
  assert.equal(executed, true);
  const records = payloads(recorder);
  const start = records.find(({ event }) => event.kind === "action_started")!;
  const terminal = records.find(({ event }) => event.kind === "action_finished")!;
  assert.equal(start.event.requestId, null);
  assert.equal(start.payload.proposedDecision.thought, "Respawn hostile reflex");
  assert.equal(terminal.event.actionId, start.event.actionId);
  assert.equal(terminal.payload.outcome.status, "unknown");
});
