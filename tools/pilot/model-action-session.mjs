import { performance } from "node:perf_hooks";
import { parseModelActionRequest } from "./model-action-schema.mjs";
import { snapshotModelObservation } from "./model-action-observation.mjs";

const failure = () => new Error("model action session failed");
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
      if (distance > 4.5) throw failure();
      const block = bot.blockAt(p.clone().set(action.x, action.y, action.z));
      const visible = bot.blockAtCursor(4.5);
      if (
        !samePoint(block?.position, action) ||
        !samePoint(visible?.position, action) ||
        block.name !== visible.name ||
        bot.canDigBlock(block) !== true
      )
        throw failure();
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
        record.status = "completed";
        record.finishedMonotonicMs = ended;
        if (request.action.kind === "finish") {
          state = "finished";
          clearTimeout(sessionTimer);
        }
        return {
          schema_version: 1,
          sequence: request.sequence,
          status: state === "finished" ? "finished" : "completed",
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
