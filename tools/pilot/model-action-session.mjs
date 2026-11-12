import { performance } from "node:perf_hooks";
import { parseModelActionRequest } from "./model-action-schema.mjs";
import { snapshotModelObservation } from "./model-action-observation.mjs";

const failure = () => new Error("model action session failed");
const rejected = (code) => ({ error: { code, recoverable: true } });
const samePoint = (p, a) => p && p.x === a.x && p.y === a.y && p.z === a.z;

// Owns an already connected, isolated bot. It does not launch a process, run a
// model, or certify gameplay. The protected supervisor must still score/close it.
export function createModelActionSession({
  bot,
  sessionTimeoutMs = 20000,
  nowMonotonic = performance.now.bind(performance),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (
    !bot ||
    ![
      "on",
      "look",
      "dig",
      "blockAt",
      "blockAtCursor",
      "canDigBlock",
      "setControlState",
      "clearControlStates",
      "stopDigging",
      "end",
    ].every((k) => typeof bot[k] === "function") ||
    !Number.isInteger(sessionTimeoutMs) ||
    sessionTimeoutMs < 1 ||
    sessionTimeoutMs > 20000 ||
    typeof nowMonotonic !== "function" ||
    typeof sleep !== "function"
  )
    throw failure();
  let state = "active",
    expected = 1,
    busy = false,
    rejectPending = null,
    last = null,
    sessionTimer = null;
  const records = [];
  const clock = () => {
    const t = nowMonotonic();
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || (last !== null && t < last)) throw failure();
    last = t;
    return t;
  };
  const started = clock(),
    deadline = started + sessionTimeoutMs;
  const safely = (fn) => {
    try {
      const p = fn();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {}
  };
  const stop = () => {
    safely(() => bot.clearControlStates());
    safely(() => bot.stopDigging());
  };
  const fail = () => {
    if (state === "failed" || state === "closed") return;
    state = "failed";
    clearTimeout(sessionTimer);
    stop();
    rejectPending?.(failure());
    safely(() => bot.end());
  };
  const disconnected = () => fail();
  // Retain the error listener for late shutdown errors on this owned bot.
  for (const event of ["end", "kicked", "error", "death"]) bot.on(event, disconnected);
  sessionTimer = setTimeout(fail, sessionTimeoutMs);
  const active = () => {
    if (state !== "active" || clock() >= deadline) throw failure();
  };
  async function perform(action) {
    active();
    if (action.kind === "observe") return { observation: snapshotModelObservation(bot) };
    if (action.kind === "look") {
      await bot.look(action.yaw, action.pitch, true);
      return {};
    }
    if (action.kind === "look_at") {
      const p = bot.entity?.position;
      if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) throw failure();
      // Same fixed standing-eye convention as dig; no movement or target selection.
      const dx = action.x + 0.5 - p.x;
      const dy = action.y + 0.5 - (p.y + 1.62);
      const dz = action.z + 0.5 - p.z;
      const horizontal = Math.hypot(dx, dz);
      if (!Number.isFinite(horizontal) || !Number.isFinite(dy) || Math.hypot(horizontal, dy) === 0) throw failure();
      const yaw = Math.atan2(-dx, -dz);
      const pitch = Math.atan2(dy, horizontal);
      await bot.look(yaw, pitch, true);
      return {};
    }
    if (action.kind === "move_to") {
      const position = () => {
        const p = bot.entity?.position;
        if (!p || ![p.x, p.y, p.z].every(Number.isFinite) || typeof p.clone !== "function") throw failure();
        return p;
      };
      const grounded = () => {
        const v = bot.entity?.velocity;
        return (
          bot.entity?.onGround === true &&
          v &&
          [v.x, v.y, v.z].every(Number.isFinite) &&
          Math.hypot(v.x, v.z) <= 0.25 &&
          Math.abs(v.y) <= 0.1
        );
      };
      const initial = position();
      const start = { x: initial.x, y: initial.y, z: initial.z };
      const distance = (p) => Math.hypot(action.x - p.x, action.z - p.z);
      const checkedPosition = () => {
        const p = position();
        if (Math.abs(p.y - start.y) > 0.25 || Math.hypot(p.x - start.x, p.z - start.z) > 4.5) throw failure();
        return p;
      };
      // Straight-line, level, standing-only movement. No jumps, block edits or pathfinding.
      const safeFootprint = (x, y, z) => {
        const p = position(),
          floor = Math.floor(y);
        if (Math.abs(y - floor) > 0.05) return false;
        for (const dx of [-0.3, 0.3])
          for (const dz of [-0.3, 0.3]) {
            const at = (level) => bot.blockAt(p.clone().set(Math.floor(x + dx), level, Math.floor(z + dz)));
            const ground = at(floor - 1),
              feet = at(floor),
              head = at(floor + 1);
            if (
              !ground ||
              typeof ground.name !== "string" ||
              [
                "magma_block",
                "cactus",
                "campfire",
                "soul_campfire",
                "ice",
                "packed_ice",
                "blue_ice",
                "slime_block",
                "honey_block",
                "soul_sand",
                "soul_soil",
              ].includes(ground.name) ||
              ground.boundingBox !== "block" ||
              !Array.isArray(ground.shapes) ||
              ground.shapes.length !== 1 ||
              !Array.isArray(ground.shapes[0]) ||
              ground.shapes[0].length !== 6 ||
              !ground.shapes[0].every((n, i) => n === [0, 0, 0, 1, 1, 1][i])
            )
              return false;
            if (
              ![feet, head].every(
                (b) => b && ["air", "cave_air", "void_air"].includes(b.name) && b.boundingBox === "empty",
              )
            )
              return false;
          }
        return true;
      };
      try {
        if (!grounded()) return rejected("navigation_blocked");
        if (distance(initial) > 4 || Math.abs(action.y - start.y) > 0.25) return rejected("navigation_out_of_range");
        if (!safeFootprint(action.x, start.y, action.z)) return rejected("navigation_blocked");
        let previous = distance(initial),
          stagnant = 0;
        for (let tick = 0; tick < action.ticks; tick++) {
          active();
          if (!grounded()) return rejected("navigation_blocked");
          const p = checkedPosition(),
            remaining = distance(p);
          if (remaining <= 0.3) return {};
          const dx = (action.x - p.x) / remaining,
            dz = (action.z - p.z) / remaining;
          // Probe present footprint and a conservative 0.45-block step before movement.
          if (
            !safeFootprint(p.x, p.y, p.z) ||
            !safeFootprint(p.x + dx * Math.min(0.45, remaining), p.y, p.z + dz * Math.min(0.45, remaining))
          )
            return rejected("navigation_blocked");
          bot.clearControlStates();
          await bot.look(Math.atan2(-dx, -dz), 0, true);
          active();
          const fresh = checkedPosition();
          if (
            !grounded() ||
            !safeFootprint(fresh.x, fresh.y, fresh.z) ||
            !safeFootprint(fresh.x + dx * Math.min(0.45, remaining), fresh.y, fresh.z + dz * Math.min(0.45, remaining))
          )
            return rejected("navigation_blocked");
          bot.setControlState("forward", true);
          await sleep(50);
          active();
          bot.clearControlStates();
          const after = checkedPosition();
          if (!grounded() || !safeFootprint(after.x, after.y, after.z)) return rejected("navigation_blocked");
          const now = distance(after);
          stagnant = previous - now < 0.03 ? stagnant + 1 : 0;
          previous = now;
          if (stagnant >= 4) return rejected("no_progress");
        }
        const final = checkedPosition();
        if (!grounded() || !safeFootprint(final.x, final.y, final.z)) return rejected("navigation_blocked");
        return distance(final) <= 0.3 ? {} : rejected("not_arrived");
      } finally {
        if (state === "active") safely(() => bot.clearControlStates());
      }
    }
    if (action.kind === "move") {
      bot.setControlState(action.direction, true);
      try {
        await sleep(action.ticks * 50);
      } finally {
        if (state === "active") safely(() => bot.clearControlStates());
      }
      return {};
    }
    if (action.kind === "dig") {
      const p = bot.entity?.position;
      if (!p || ![p.x, p.y, p.z].every(Number.isFinite) || typeof p.clone !== "function") throw failure();
      // The initial adapter supports the fixed standing survival actor; alternate
      // poses need separately qualified eye-height handling before this is reused.
      const distance = Math.hypot(action.x + 0.5 - p.x, action.y + 0.5 - (p.y + 1.62), action.z + 0.5 - p.z);
      if (!Number.isFinite(distance)) throw failure();
      if (distance > 4.5) return rejected("target_out_of_reach");
      const block = bot.blockAt(p.clone().set(action.x, action.y, action.z));
      if (!block || !samePoint(block.position, action) || ["air", "cave_air", "void_air"].includes(block.name))
        return rejected("target_missing");
      if (typeof block.name !== "string" || !block.name) throw failure();
      const visible = bot.blockAtCursor(4.5);
      if (!samePoint(visible?.position, action) || block.name !== visible.name) return rejected("target_not_visible");
      const diggable = bot.canDigBlock(block);
      if (diggable === false) return rejected("target_not_diggable");
      if (diggable !== true) throw failure();
      await bot.dig(block);
      return {};
    }
    if (action.kind === "finish") {
      bot.clearControlStates();
      return {};
    }
    throw failure();
  }
  return Object.freeze({
    get status() {
      return state;
    },
    get transcript() {
      return structuredClone(records);
    },
    async execute(raw) {
      if (state !== "active") throw failure();
      if (busy) {
        fail();
        throw failure();
      }
      busy = true;
      let timer, record;
      try {
        active();
        const request = parseModelActionRequest(raw);
        if (request.sequence !== expected || (expected === 25 && request.action.kind !== "finish")) throw failure();
        const began = clock();
        record = {
          sequence: expected,
          action: { ...request.action },
          status: "running",
          startedMonotonicMs: began,
          finishedMonotonicMs: null,
        };
        records.push(record);
        expected++;
        const cap = Math.min(request.action.kind === "dig" ? 6000 : 2000, deadline - began);
        const cancelled = new Promise((_, reject) => {
          rejectPending = reject;
        });
        timer = setTimeout(fail, Math.max(1, cap));
        const value = await Promise.race([Promise.resolve().then(() => perform(request.action)), cancelled]);
        active();
        const ended = clock();
        if (ended - began >= cap) throw failure();
        record.status = value.error ? "rejected" : "completed";
        if (value.error) record.error = { ...value.error };
        record.finishedMonotonicMs = ended;
        if (request.action.kind === "finish") {
          state = "finished";
          clearTimeout(sessionTimer);
        }
        return {
          schema_version: 1,
          sequence: request.sequence,
          status: state === "finished" ? "finished" : value.error ? "rejected" : "completed",
          ...value,
        };
      } catch {
        if (record) {
          record.status = "failed";
          try {
            record.finishedMonotonicMs = clock();
          } catch {
            record.finishedMonotonicMs = null;
          }
        }
        fail();
        throw failure();
      } finally {
        clearTimeout(timer);
        rejectPending = null;
        busy = false;
      }
    },
    close({ disconnect = true } = {}) {
      if (state === "closed") return;
      if (typeof disconnect !== "boolean" || (!disconnect && state !== "finished")) throw failure();
      if (busy) rejectPending?.(failure());
      state = "closed";
      clearTimeout(sessionTimer);
      stop();
      if (disconnect) safely(() => bot.end());
    },
  });
}
