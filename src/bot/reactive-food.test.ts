import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Vec3 } from "vec3";
import { EpisodeEventRecorder, setEpisodeEventRecorderForTests } from "../data/episode-events.js";
import { setChatClientForTests } from "../llm/index.js";
import type { ProviderResponseMetadata } from "../llm/provider.js";
import { BotBrain } from "./brain.js";
import { drownRescueActive, escapeWaterIfDrowning } from "./navigation.js";

setEpisodeEventRecorderForTests(
  new EpisodeEventRecorder({ rootDir: mkdtempSync(path.join(tmpdir(), "reactive-food-events-")), runId: "food-run" }),
);

const metadata: ProviderResponseMetadata = {
  requestId: "reactive-food",
  provider: "ollama",
  model: "fast",
  providerModel: "fast",
  providerRequestId: null,
  durationMs: 1,
  usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null },
  origin: "provider",
};

afterEach(() => setChatClientForTests(null));

type Opts = { food?: boolean; hostile?: boolean; allowed?: string[]; skill?: boolean; health?: number };

/** A handler-level brain: real handleReactive, fake world, recorded effects. */
function reactiveBrain(opts: Opts = {}) {
  const items = opts.food ? [{ name: "bread", count: 3 }] : [{ name: "rabbit_hide", count: 1 }];
  const zombie = { name: "zombie", position: new Vec3(4, 64, 0) };
  const world = { hostile: opts.hostile ?? false };
  const executed: Array<{ action: string; params: unknown }> = [];
  const aborted: string[] = [];
  const brain: any = Object.create(BotBrain.prototype);
  brain.bot = {
    username: "Atlas",
    health: opts.health ?? 5,
    food: 4,
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => items },
    nearestEntity: (pred: (e: unknown) => boolean) => (world.hostile && pred(zombie) ? zombie : null),
  };
  brain.roleConfig = { name: "Atlas", allowedActions: opts.allowed ?? ["attack", "flee", "eat", "go_to"] };
  brain.paused = false;
  brain.stopped = false;
  brain.recentFailures = new Map();
  brain.failureExpiry = new Map();
  brain.failureCounts = new Map();
  brain.log = { info() {}, debug() {}, warn() {}, error() {} };
  brain.skillRunning = () => opts.skill ?? false;
  brain.skillAborter = () => aborted.push("abort");
  brain.executeDecision = async (d: { action: string; params: unknown }) => {
    executed.push({ action: d.action, params: d.params });
  };
  return { brain, items, world, zombie, executed, aborted };
}

/** Model replies `action`; `during` runs while the query is pending. */
function model(action: string, during: () => void = () => {}) {
  const seen: { system: string; user: string }[] = [];
  setChatClientForTests((async (req: { messages: Array<{ content: string }> }) => {
    seen.push({ system: req.messages[0].content, user: req.messages[1].content });
    during();
    return { message: { content: JSON.stringify({ thought: "t", action, params: {} }) }, metadata };
  }) as any);
  return seen;
}

const lowHealth = { type: "reactive", priority: 0, data: { reason: "low_health", health: 5 }, timestamp: 0 };

test("no food: eat leaves the menu, the prompt says so, and a hallucinated eat never executes", async () => {
  const w = reactiveBrain({ hostile: true });
  const seen = model("eat");
  await w.brain.handleReactive(lowHealth);
  assert.doesNotMatch(seen[0].system, /- eat:/);
  assert.match(seen[0].user, /Food available: NONE/);
  assert.deepEqual(w.executed, [{ action: "flee", params: {} }]);
});

test("no food: no menu fallback reinserts eat", async () => {
  // Every other role action recently failed: the old fallback re-offered the full role list.
  const failed = reactiveBrain({ allowed: ["eat", "flee"] });
  failed.brain.recentFailures.set("flee", "no path");
  const seen = model("eat");
  await failed.brain.handleReactive({ ...lowHealth, data: { reason: "took_damage" } });
  assert.doesNotMatch(seen[0].system, /- eat:/);
  assert.match(seen[0].system, /- flee:/);
  assert.match(seen[0].user, /Food available: NONE/);
  assert.deepEqual(failed.executed, [{ action: "idle", params: {} }]);

  // A role whose only action is eat: an empty menu would show the full default list.
  const eatOnly = reactiveBrain({ allowed: ["eat"] });
  const seen2 = model("eat");
  await eatOnly.brain.handleReactive(lowHealth);
  assert.doesNotMatch(seen2[0].system, /- eat:/);
  assert.match(seen2[0].system, /- idle:/);
  assert.deepEqual(eatOnly.executed, [{ action: "idle", params: {} }]);
});

test("food lost while the query was pending: the stale eat is replaced", async () => {
  const w = reactiveBrain({ food: true });
  const seen = model("eat", () => w.items.splice(0, w.items.length));
  await w.brain.handleReactive(lowHealth);
  assert.match(seen[0].system, /- eat:/, "eat was a real option when asked");
  assert.match(seen[0].user, /Food available: yes/);
  assert.deepEqual(w.executed, [{ action: "idle", params: {} }]);
});

test("food still aboard: eat runs normally", async () => {
  const w = reactiveBrain({ food: true, hostile: true });
  model("eat");
  await w.brain.handleReactive(lowHealth);
  assert.deepEqual(w.executed, [{ action: "eat", params: {} }]);
});

test("no hostile nearby: an impossible eat idles instead of fleeing", async () => {
  const w = reactiveBrain({ hostile: false });
  model("eat");
  await w.brain.handleReactive(lowHealth);
  assert.deepEqual(w.executed, [{ action: "idle", params: {} }]);
});

test("a role that may not flee idles even with a hostile near", async () => {
  const w = reactiveBrain({ hostile: true, allowed: ["attack", "eat"] });
  model("eat");
  await w.brain.handleReactive(lowHealth);
  assert.deepEqual(w.executed, [{ action: "idle", params: {} }]);
});

test("a stale hostile event is not critical: the skill is kept; a live hostile still aborts it", async () => {
  const stale = reactiveBrain({ hostile: false, skill: true, health: 4 });
  model("flee");
  await stale.brain.handleReactive({
    type: "reactive",
    priority: 1,
    data: { reason: "hostile_nearby", entities: [stale.zombie] },
    timestamp: 0,
  });
  assert.deepEqual(stale.aborted, []);
  assert.deepEqual(stale.executed, []);

  const live = reactiveBrain({ hostile: true, skill: true, health: 4 });
  model("flee");
  await live.brain.handleReactive(lowHealth);
  assert.deepEqual(live.aborted, ["abort"]);
  assert.deepEqual(live.executed, [{ action: "flee", params: {} }]);
});

test("paused or stopped while the query was pending: no action starts", async () => {
  for (const flag of ["paused", "stopped"]) {
    const w = reactiveBrain({ food: true, hostile: true });
    model("flee", () => (w.brain[flag] = true));
    await w.brain.handleReactive(lowHealth);
    assert.deepEqual(w.executed, [], flag);
  }
});

test("a live drowning rescue retains controls when a model reply arrives", async () => {
  const w = reactiveBrain({ hostile: true, skill: true });
  let wet = true;
  let release: (() => void) | undefined;
  Object.assign(w.brain.bot, {
    oxygenLevel: 7,
    controlState: {},
    blockAt: (p: Vec3) => ({ name: wet ? "water" : "air", boundingBox: "empty", position: p }),
    pathfinder: { goal: null, isMoving: () => false },
    setControlState(this: any, key: string, value: boolean) {
      this.controlState[key] = value;
    },
    getControlState(this: any, key: string) {
      return this.controlState[key] ?? false;
    },
    clearControlStates() {},
    stopDigging() {},
    on() {},
    removeListener() {},
    lookAt: async () => {},
    canDigBlock: () => false,
    waitForTicks: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });
  w.brain.bot.entity.height = 1.62;
  w.brain.bot.entity.velocity = new Vec3(0, 0, 0);
  const rescue = escapeWaterIfDrowning(w.brain.bot);
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    assert.equal(drownRescueActive(w.brain.bot), true);
    model("eat");
    await w.brain.handleReactive(lowHealth);
    assert.deepEqual(w.executed, []);
    assert.deepEqual(w.aborted, []);
    assert.equal(w.brain.bot.controlState.jump, true);
  } finally {
    wet = false;
    w.brain.bot.oxygenLevel = 20;
    release?.();
    await rescue;
  }
});
