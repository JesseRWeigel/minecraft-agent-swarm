import assert from "node:assert/strict";
import { test } from "node:test";
import { BotBrain } from "./brain.js";

type IntervalHandle = ReturnType<typeof setInterval>;

interface IntervalRecord {
  handle: IntervalHandle;
  delay: number | undefined;
  createdBy: string;
}

/**
 * The brain's start() reaches the server only through the timers' callbacks,
 * so the brain can be built from the prototype with the heavy collaborators
 * replaced. Everything start() touches directly is listed here.
 */
function bareBrain() {
  const brain: any = Object.create(BotBrain.prototype);
  brain.bot = {
    username: "Atlas",
    entity: { position: { x: 0, y: 0, z: 0 }, eyeHeight: 1.62 },
    game: { dimension: "minecraft:overworld" },
    entities: {},
    on: () => {},
  };
  brain.roleConfig = { name: "Atlas" };
  brain.log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
  brain.paused = false;
  brain.stopped = false;
  brain.processing = false;
  brain.eventQueue = [];
  brain.interruptionGeneration = 0;
  brain.interruptionHistory = [];
  brain.IDLE_INTERVAL_MS = 10_000;
  brain.idleTimer = null;
  brain.hostileScanner = null;
  brain.overlayInterval = null;
  // Interactions with the world and with the event loop are not what this file
  // measures; the interval bookkeeping is.
  brain.equipBestArmor = async () => {};
  brain.resetIdleTimer = () => {};
  brain.pushEvent = () => {};
  return brain;
}

/** Record every call site that creates an interval, so a leak names its timer. */
function startRecordingIntervals() {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const created: IntervalRecord[] = [];
  const cleared = new Set<IntervalHandle>();

  globalThis.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    const handle = realSetInterval(callback, delay, ...args) as unknown as IntervalHandle;
    const frame = new Error().stack
      ?.split("\n")
      .map((line) => line.replace(/\\/g, "/"))
      .find((line) => line.includes("src/bot/brain.ts"))
      ?.trim();
    created.push({ handle, delay, createdBy: `${delay}ms ${frame ?? "(call site not in brain.ts)"}` });
    return handle;
  }) as unknown as typeof setInterval;

  globalThis.clearInterval = ((handle?: IntervalHandle) => {
    if (handle) cleared.add(handle);
    return realClearInterval(handle);
  }) as typeof clearInterval;

  return {
    created,
    cleared,
    restore: () => {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      // A leaked interval keeps running for the rest of the file otherwise.
      for (const record of created) if (!cleared.has(record.handle)) realClearInterval(record.handle);
    },
  };
}

test("stop() clears every interval that start() created", () => {
  const brain = bareBrain();
  const recorder = startRecordingIntervals();
  try {
    brain.start();
    brain.stop();
  } finally {
    recorder.restore();
  }

  const outstanding = recorder.created.filter((record) => !recorder.cleared.has(record.handle));
  assert.deepEqual(
    outstanding.map((record) => record.createdBy),
    [],
    `stop() left ${outstanding.length} of ${recorder.created.length} intervals running`,
  );
  assert.ok(
    recorder.created.length >= 7,
    `expected start() to create the brain's timers, created ${recorder.created.length}`,
  );
});

test("stop() without a start() clears nothing and does not throw", () => {
  const brain = bareBrain();
  const recorder = startRecordingIntervals();
  try {
    brain.stop();
  } finally {
    recorder.restore();
  }

  assert.deepEqual(recorder.created, []);
  assert.equal(brain.stopped, true);
});

test("spawn safety completion cannot start a brain that has been stopped", async () => {
  const brain = bareBrain();
  const recorder = startRecordingIntervals();
  let armorCalls = 0;
  let listeners = 0;
  let finishSpawnSafety!: () => void;
  const spawnSafety = new Promise<void>((resolve) => {
    finishSpawnSafety = resolve;
  });
  const delayedStart = spawnSafety.then(() => brain.start());
  brain.equipBestArmor = async () => {
    armorCalls++;
  };
  brain.bot.on = () => {
    listeners++;
  };

  try {
    brain.stop();
    finishSpawnSafety();
    await delayedStart;
  } finally {
    recorder.restore();
  }

  assert.equal(recorder.created.length, 0, "a stopped brain must not schedule intervals");
  assert.equal(listeners, 0, "a stopped brain must not register listeners");
  assert.equal(armorCalls, 0, "a stopped brain must not attempt to equip armor");
});
