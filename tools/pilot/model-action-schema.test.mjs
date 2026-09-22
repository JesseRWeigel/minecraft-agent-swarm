import assert from "node:assert/strict";
import { test } from "node:test";

import { parseModelActionRequest } from "./model-action-schema.mjs";

const request = (action, overrides = {}) =>
  JSON.stringify({
    schema_version: 1,
    trial_id: "collect-oak-log-v1",
    action_id: "collect-01",
    sequence: 1,
    action,
    ...overrides,
  });

test("parses each fixed offline action schema", () => {
  assert.deepEqual(parseModelActionRequest(request({ kind: "observe" })), {
    schema_version: 1,
    trial_id: "collect-oak-log-v1",
    action_id: "collect-01",
    sequence: 1,
    action: { kind: "observe" },
  });
  for (const action of [
    { kind: "finish" },
    { kind: "look", yaw: Math.PI, pitch: -Math.PI / 2 },
    { kind: "move", direction: "left", ticks: 20 },
    { kind: "dig", x: 0, y: 200, z: 3 },
  ])
    assert.equal(parseModelActionRequest(request(action)).action.kind, action.kind);
});

test("rejects wrong IDs, coercion, nonfinite JSON numbers, and out-of-budget values", () => {
  for (const body of [
    request({ kind: "observe" }, { trial_id: "other" }),
    request({ kind: "observe" }, { sequence: "1" }),
    request({ kind: "observe" }, { sequence: 0 }),
    request({ kind: "move", direction: "up", ticks: 1 }),
    request({ kind: "move", direction: "forward", ticks: 21 }),
    request({ kind: "look", yaw: 3.15, pitch: 0 }),
    request({ kind: "look", yaw: 1e999, pitch: 0 }),
    request({ kind: "dig", x: 30000001, y: 200, z: 3 }),
    request({ kind: "dig", x: 0, y: 320, z: 3 }),
  ])
    assert.throws(() => parseModelActionRequest(body), /invalid model action request/);
});

test("requires exact root and action keys", () => {
  for (const body of [
    request({ kind: "observe", note: "extra" }),
    request({ kind: "finish" }, { extra: true }),
    request({ kind: "dig", x: 0, y: 200 }),
    request({ kind: "look", yaw: 0, pitch: 0, ticks: 1 }),
    JSON.stringify({ schema_version: 1, trial_id: "collect-oak-log-v1", action_id: "collect-01", sequence: 1, action: [] }),
  ])
    assert.throws(() => parseModelActionRequest(body), /invalid model action request/);
});

test("strictly rejects malformed UTF-8, oversized inputs, and duplicate keys including escaped forms", () => {
  for (const raw of [
    Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]),
    "x".repeat(4097),
    '{"schema_version":1,"schema_version":1,"trial_id":"collect-oak-log-v1","action_id":"collect-01","sequence":1,"action":{"kind":"observe"}}',
    '{"schema_version":1,"trial_id":"collect-oak-log-v1","action_id":"collect-01","sequence":1,"action":{"kind":"observe","k\\u0069nd":"observe"}}',
  ])
    assert.throws(() => parseModelActionRequest(raw), /invalid model action request/);
});

test("rejects an oversized byte array before copying it", () => {
  const oversized = new Uint8Array(4097);
  const original = Buffer.from;
  let copies = 0;
  Buffer.from = (...args) => {
    copies += 1;
    return original(...args);
  };
  try {
    assert.throws(() => parseModelActionRequest(oversized), /invalid model action request/);
  } finally {
    Buffer.from = original;
  }
  assert.equal(copies, 0);
});
