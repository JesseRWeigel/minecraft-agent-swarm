// Behaviour tests for who owns the movement keys during a drowning.
//
// Baseline run: the drown reflex held jump at air 8 while the bot bobbed from
// y 61.49 to 62.85, and the DrownKeys trace named the releaser:
//   jump released by bot.clearControlStates <- resetPath <- setGoal (safeGoto attempt)
// The walk's wait gate only read headUnderWater(), which is false at the top
// of a bob, so the waiting walk restarted and reset the path mid-rescue. Its
// stall recovery likewise cleared the keys while the rescue ran.
//
// These drive the real escapeWaterIfDrowning and safeGoto against a fake bot
// whose pathfinder clears the control states on setGoal, exactly as
// mineflayer-pathfinder's resetPath does.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import {
  DROWN_RESCUE_GRACE_MS,
  DROWN_RESCUE_MAX_MS,
  drownRescueActive,
  escapeWaterIfDrowning,
  safeGoto,
} from "./navigation.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function advance(ms: number, step = 50): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    mock.timers.tick(step);
    await flush();
  }
}

function track(p: Promise<unknown>) {
  const o: { state: "pending" | "resolved" | "rejected"; error: unknown } = { state: "pending", error: undefined };
  p.then(
    () => {
      o.state = "resolved";
    },
    (e) => {
      o.state = "rejected";
      o.error = e;
    },
  );
  return o;
}

function goal() {
  return { x: 10, y: 60, z: 10, isEnd: () => true };
}

function fakeWorld() {
  const state = {
    submerged: true,
    explodeBlockAt: false,
    ticks: "hold" as "hold" | "auto",
    onSetGoal: null as null | (() => void),
  };
  const calls = { setGoal: 0, goto: 0 };
  const pendingTicks: Array<() => void> = [];
  const jumpAtStopDigging: boolean[] = [];
  let gotoSettle: { resolve: () => void; reject: (e: Error) => void } | null = null;
  const listeners = new Map<string, Set<(...a: any[]) => void>>();
  const block = (name: string) => ({ name, boundingBox: "empty", getProperties: () => ({}) });

  const bot: any = {
    username: "Tester",
    food: 20,
    health: 20,
    oxygenLevel: 8,
    entity: {
      position: new Vec3(0.5, 61.49, 0.5),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      pitch: 0,
      onGround: false,
      eyeHeight: 1.62,
    },
    controlState: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
    targetDigBlock: null,
    heldItem: null,
    currentWindow: null,
    game: { dimension: "overworld" },
    blockAt(_v: Vec3) {
      if (state.explodeBlockAt) throw new Error("chunk unloaded");
      return block(state.submerged ? "water" : "air");
    },
    findBlock: () => null,
    setControlState(control: string, value: boolean) {
      bot.controlState[control] = value;
    },
    getControlState(control: string) {
      return !!bot.controlState[control];
    },
    // mineflayer releases each key through setControlState.
    clearControlStates() {
      for (const k of Object.keys(bot.controlState)) bot.setControlState(k, false);
    },
    // The takeover calls this right after its path reset, so it sees the
    // keys exactly as the takeover left them, before the swim step.
    stopDigging() {
      jumpAtStopDigging.push(!!bot.controlState.jump);
    },
    async lookAt() {},
    async equip() {},
    waitForTicks() {
      if (state.ticks === "auto") return Promise.resolve();
      return new Promise<void>((resolve) => pendingTicks.push(resolve));
    },
    on(ev: string, fn: (...a: any[]) => void) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(fn);
      return bot;
    },
    removeListener(ev: string, fn: (...a: any[]) => void) {
      listeners.get(ev)?.delete(fn);
      return bot;
    },
    pathfinder: {
      goal: null as unknown,
      searchRadius: 64,
      // resetPath('goal_updated') clears every control state; a live goto
      // rejects with "goal was changed".
      setGoal(g: unknown) {
        calls.setGoal++;
        const prior = gotoSettle;
        gotoSettle = null;
        bot.pathfinder.goal = g;
        prior?.reject(new Error("The goal was changed before it could be completed!"));
        bot.clearControlStates();
        state.onSetGoal?.();
      },
      goto(g: unknown) {
        calls.goto++;
        bot.pathfinder.goal = g;
        return new Promise<void>((resolve, reject) => {
          gotoSettle = {
            resolve: () => {
              bot.pathfinder.goal = null;
              resolve();
            },
            reject,
          };
        });
      },
      isMoving: () => false,
      isMining: () => false,
      isBuilding: () => false,
    },
  };

  return {
    bot,
    asBot: bot as unknown as Bot,
    state,
    calls,
    jumpAtStopDigging,
    releaseTicks() {
      for (const r of pendingTicks.splice(0)) r();
    },
    /** Release only the oldest pending swim wait (the earliest rescue call). */
    releaseOldestTick() {
      pendingTicks.shift()?.();
    },
    finishGoto() {
      const g = gotoSettle;
      gotoSettle = null;
      g?.resolve();
    },
  };
}

function withClock(fn: () => Promise<void>) {
  return async () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
    try {
      await fn();
    } finally {
      mock.timers.reset();
    }
  };
}

test(
  "a walk waiting on a drown rescue does not reset the path when the head bobs above water",
  withClock(async () => {
    const w = fakeWorld();
    const rescue = escapeWaterIfDrowning(w.asBot);
    await flush();
    assert.equal(w.bot.controlState.jump, true, "the rescue holds jump");
    assert.equal(drownRescueActive(w.asBot), true);

    const walk = safeGoto(w.asBot, goal(), 15_000);
    const outcome = track(walk);
    await flush();
    assert.equal(w.calls.setGoal, 0);

    // Top of the bob: eye and head in air, air still 8, rescue still running.
    w.state.submerged = false;
    await advance(1_000);
    assert.equal(w.calls.setGoal, 0, "the walk must not reset the path while the rescue owns the keys");
    assert.equal(w.calls.goto, 0, "the walk must not hand the keys back to the pathfinder mid-rescue");
    assert.equal(w.bot.controlState.jump, true, "jump must survive the bob");

    // The rescue's period ends with the head out; it releases its own keys.
    w.releaseTicks();
    assert.equal(await rescue, true);
    assert.equal(drownRescueActive(w.asBot), true, "air 8 is still short: grace until the next reflex tick");
    await advance(1_000);
    assert.equal(w.calls.goto, 0, "the walk keeps waiting while air is short");

    // Breathing again: the claim lets go and the walk resumes on its own.
    w.bot.oxygenLevel = 20;
    await advance(600);
    assert.equal(drownRescueActive(w.asBot), false);
    assert.equal(w.calls.setGoal, 1);
    assert.equal(w.calls.goto, 1, "the walk resumes once the bot breathes");
    w.finishGoto();
    await walk;
    assert.equal(outcome.state, "resolved");
    assert.equal(drownRescueActive(w.asBot), false, "nothing is left claimed after a successful rescue");
  }),
);

test(
  "stall recovery and the walk timeout do not clear the keys while the rescue owns them",
  withClock(async () => {
    const w = fakeWorld();
    const rescue = escapeWaterIfDrowning(w.asBot);
    await flush();

    const outcome = track(safeGoto(w.asBot, goal(), 15_000));
    // The bot is pinned in place: before the fix the stall check reached its
    // 5s verdict here and called setGoal(null), releasing jump.
    await advance(7_000);
    assert.equal(outcome.state, "pending", "a walk waiting out a rescue is not stalled");
    assert.equal(w.calls.setGoal, 0);
    assert.equal(w.bot.controlState.jump, true);

    // Cancellation still works: the walk times out on schedule.
    await advance(8_500);
    assert.equal(outcome.state, "rejected");
    assert.match(String((outcome.error as Error)?.message), /Navigation timed out/);
    assert.equal(w.calls.setGoal, 0, "the timeout must not reset a path the walk does not own");
    assert.equal(w.bot.controlState.jump, true, "the timeout must not release the rescue's jump");

    // The rescue finishes with the head still under: it keeps swimming.
    w.state.ticks = "auto";
    w.releaseTicks();
    assert.equal(await rescue, true);
    assert.equal(w.bot.controlState.jump, true);
    assert.equal(drownRescueActive(w.asBot), true, "still under with short air: grace");
    await advance(DROWN_RESCUE_GRACE_MS + 100);
    assert.equal(drownRescueActive(w.asBot), false, "the grace is capped in time even while still under");
  }),
);

test(
  "a rescue that throws after the takeover still ends its claim",
  withClock(async () => {
    const w = fakeWorld();
    w.bot.pathfinder.goal = goal(); // a skill's walk is live when the reflex fires
    w.state.onSetGoal = () => {
      w.state.explodeBlockAt = true; // the shore scan throws next
    };
    await assert.rejects(escapeWaterIfDrowning(w.asBot), /chunk unloaded/);
    w.state.explodeBlockAt = false;
    w.state.onSetGoal = null;
    assert.equal(drownRescueActive(w.asBot), true, "short air: grace after the abort");
    await advance(DROWN_RESCUE_GRACE_MS);
    assert.equal(drownRescueActive(w.asBot), false, "an aborted rescue cannot hold the keys");
  }),
);

test(
  "a rescue that never returns cannot lock walks out for good",
  withClock(async () => {
    const w = fakeWorld();
    void escapeWaterIfDrowning(w.asBot); // hangs in its swim wait forever
    await flush();
    w.state.submerged = false;
    w.bot.oxygenLevel = 20;

    const walk = safeGoto(w.asBot, goal(), 60_000);
    const outcome = track(walk);
    await advance(DROWN_RESCUE_MAX_MS - 1_000);
    assert.equal(w.calls.goto, 0, "within the cap the rescue still owns the keys");
    await advance(1_500);
    assert.equal(drownRescueActive(w.asBot), false);
    assert.equal(w.calls.goto, 1, "past the cap the walk proceeds");
    w.finishGoto();
    await walk;
    assert.equal(outcome.state, "resolved");
  }),
);

test(
  "a reflex call that returns early (head dry) does not release a rescue still running",
  withClock(async () => {
    const w = fakeWorld();
    const first = escapeWaterIfDrowning(w.asBot);
    await flush();
    assert.equal(drownRescueActive(w.asBot), true);

    // Top of the bob with air refilled: a second call returns at once.
    w.state.submerged = false;
    w.bot.oxygenLevel = 20;
    assert.equal(await escapeWaterIfDrowning(w.asBot), false, "head dry: nothing to rescue");
    assert.equal(drownRescueActive(w.asBot), true, "a call that never claimed must not settle the running rescue");

    const walk = track(safeGoto(w.asBot, goal(), 15_000));
    await advance(1_000);
    assert.equal(w.calls.goto, 0, "the walk still waits on the running rescue");

    // The rescue that did claim settles its own claim.
    w.releaseTicks();
    assert.equal(await first, true);
    assert.equal(drownRescueActive(w.asBot), false, "breathing: the owner's settlement releases it");
    await advance(600);
    assert.equal(w.calls.goto, 1);
    w.finishGoto();
    await advance(50);
    assert.equal(walk.state, "resolved");
  }),
);

test(
  "an older rescue finishing late does not settle a newer rescue's claim",
  withClock(async () => {
    const w = fakeWorld();
    const older = escapeWaterIfDrowning(w.asBot);
    await flush();
    const newer = escapeWaterIfDrowning(w.asBot); // overlaps: takes its own claim
    await flush();
    assert.equal(drownRescueActive(w.asBot), true);

    // Breathing, so a wrong settlement would delete the claim outright.
    w.state.submerged = false;
    w.bot.oxygenLevel = 20;
    assert.equal(w.bot.controlState.jump, true, "the newer rescue holds jump");
    w.bot.controlState.forward = true; // and a heading, as a shore swim would
    w.releaseOldestTick();
    assert.equal(await older, true);
    assert.equal(drownRescueActive(w.asBot), true, "the newer rescue still owns the keys");
    assert.equal(w.bot.controlState.jump, true, "a superseded call must not release the owner's jump");
    assert.equal(w.bot.controlState.forward, true, "a superseded call must not release the owner's heading");

    w.releaseTicks();
    assert.equal(await newer, true);
    assert.equal(drownRescueActive(w.asBot), false, "the newer rescue settles its own claim");
    assert.equal(w.bot.controlState.jump, false, "the owner's own head-dry cleanup still releases jump");
    assert.equal(w.bot.controlState.forward, false, "and the heading");
    assert.equal(w.bot.controlState.sprint, false);
  }),
);

test(
  "an unclaimed high-air call finishing late does not release a later low-air rescue's keys",
  withClock(async () => {
    const w = fakeWorld();
    // Head under at full air: no takeover, no claim, but it still swims.
    w.bot.oxygenLevel = 20;
    const unclaimed = escapeWaterIfDrowning(w.asBot);
    await flush();
    assert.equal(drownRescueActive(w.asBot), false, "air 20 takes no claim");

    // Air drops while that call is still in its swim wait: a new call claims.
    w.bot.oxygenLevel = 8;
    const claimed = escapeWaterIfDrowning(w.asBot);
    await flush();
    assert.equal(drownRescueActive(w.asBot), true);
    w.bot.controlState.forward = true; // the owner's heading

    // Head dry and breathing, so a wrong cleanup or settlement would show.
    w.state.submerged = false;
    w.bot.oxygenLevel = 20;
    w.releaseOldestTick();
    assert.equal(await unclaimed, true);
    assert.equal(w.bot.controlState.jump, true, "an unclaimed call must not release the owner's jump");
    assert.equal(w.bot.controlState.forward, true, "nor the owner's heading");
    assert.equal(drownRescueActive(w.asBot), true, "nor settle the owner's claim");

    w.releaseTicks();
    assert.equal(await claimed, true);
    assert.equal(drownRescueActive(w.asBot), false, "the owner settles its own claim");
    assert.equal(w.bot.controlState.jump, false, "the owner's head-dry cleanup releases jump");
    assert.equal(w.bot.controlState.forward, false);

    // With no live owner, an unclaimed call cleans up as it always did.
    w.state.submerged = true;
    const lone = escapeWaterIfDrowning(w.asBot);
    await flush();
    assert.equal(drownRescueActive(w.asBot), false);
    assert.equal(w.bot.controlState.jump, true, "the lone call swims");
    w.state.submerged = false;
    w.releaseTicks();
    assert.equal(await lone, true);
    assert.equal(w.bot.controlState.jump, false, "no rival owner: normal head-dry cleanup");
  }),
);

test(
  "the takeover presses jump after resetting a live goal, not before",
  withClock(async () => {
    const w = fakeWorld();
    w.bot.pathfinder.goal = goal(); // a skill's walk holds the pathfinder
    void escapeWaterIfDrowning(w.asBot);
    await flush();
    assert.equal(w.calls.setGoal, 1, "the takeover still resets the live goal");
    assert.deepEqual(w.jumpAtStopDigging, [true], "jump held from the takeover, not only the swim step");
    assert.equal(w.bot.controlState.jump, true);
  }),
);

test(
  "with no rescue running, stall recovery and timeout still stop the pathfinder",
  withClock(async () => {
    const stalled = fakeWorld();
    stalled.state.submerged = false;
    stalled.bot.oxygenLevel = 20;
    const s = track(safeGoto(stalled.asBot, goal(), 15_000));
    await flush();
    assert.equal(stalled.calls.goto, 1);
    stalled.bot.controlState.forward = true; // the pathfinder's keys
    await advance(5_500);
    assert.equal(s.state, "rejected");
    assert.match(String((s.error as Error)?.message), /Stuck/);
    assert.equal(stalled.calls.setGoal, 2, "the stall verdict resets the path");
    assert.equal(stalled.bot.controlState.forward, false);

    const timed = fakeWorld();
    timed.state.submerged = false;
    timed.bot.oxygenLevel = 20;
    const t = track(safeGoto(timed.asBot, goal(), 3_000, 10_000));
    await advance(3_500);
    assert.equal(t.state, "rejected");
    assert.match(String((t.error as Error)?.message), /Navigation timed out/);
    assert.equal(timed.calls.setGoal, 2, "the timeout resets the path");
  }),
);
