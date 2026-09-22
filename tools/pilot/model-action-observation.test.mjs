import assert from "node:assert/strict";
import { test } from "node:test";

import { snapshotModelObservation } from "./model-action-observation.mjs";

function bot(overrides = {}) {
  return {
    entity: { position: { x: 0.5, y: 200, z: 0.5 }, yaw: 0, pitch: 0, secret: "entity-secret" },
    health: 20,
    inventory: {
      slots: [null, { name: "oak_log", count: 1, secret: "inventory-secret", nbt: { enormous: "x".repeat(100000) } }],
      items() {
        throw new Error("must not enumerate inventory");
      },
    },
    blockAtCursor(distance) {
      assert.equal(distance, 4.5);
      return { name: "oak_log", position: { x: 0, y: 200, z: 3 }, secret: "block-secret" };
    },
    ...overrides,
  };
}

test("projects only bounded participant-local observation fields", () => {
  const observed = snapshotModelObservation(bot());
  assert.deepEqual(observed, {
    schema_version: 1,
    source: "participant_bot",
    position: { x: 0.5, y: 200, z: 0.5 },
    yaw: 0,
    pitch: 0,
    health: 20,
    inventory: [{ slot: 1, name: "oak_log", count: 1 }],
    visibleBlocks: [{ name: "oak_log", x: 0, y: 200, z: 3 }],
  });
  assert.equal(JSON.stringify(observed).includes("secret"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(observed), "utf8") <= 16384);
});

test("represents no visible cursor block without adding source objects", () => {
  const observed = snapshotModelObservation(bot({ blockAtCursor: () => null }));
  assert.deepEqual(observed.visibleBlocks, []);
  assert.equal(Object.getPrototypeOf(observed), Object.prototype);
  assert.equal(Object.getPrototypeOf(observed.inventory[0]), Object.prototype);
});

test("rejects invalid entity, item, slot, and visible-block values", () => {
  const invalidBots = [
    bot({ entity: { position: { x: Infinity, y: 200, z: 0.5 }, yaw: 0, pitch: 0 } }),
    bot({ health: "20" }),
    bot({ inventory: { slots: Array(47).fill(null) } }),
    bot({ inventory: { slots: [{ name: "minecraft:oak_log", count: 1 }] } }),
    bot({ inventory: { slots: [{ name: "oak_log", count: 65 }] } }),
    bot({ blockAtCursor: () => ({ name: "oak_log", position: { x: 0.5, y: 200, z: 3 } }) }),
  ];
  for (const value of invalidBots) assert.throws(() => snapshotModelObservation(value), /invalid model observation/);
});

test("rejects coercible item and block names before they can enter output", () => {
  const secretName = {
    toString: () => "oak_log",
    toJSON: () => ({ secret: "must-not-serialize" }),
  };
  for (const value of [
    bot({ inventory: { slots: [{ name: ["oak_log"], count: 1 }] } }),
    bot({ inventory: { slots: [{ name: secretName, count: 1 }] } }),
    bot({ blockAtCursor: () => ({ name: ["oak_log"], position: { x: 0, y: 200, z: 3 } }) }),
    bot({ blockAtCursor: () => ({ name: secretName, position: { x: 0, y: 200, z: 3 } }) }),
  ])
    assert.throws(() => snapshotModelObservation(value), /invalid model observation/);
});

test("returns only copied primitive fields", () => {
  const source = bot();
  const observed = snapshotModelObservation(source);
  source.entity.position.x = 123;
  source.inventory.slots[1].name = "dirt";
  assert.deepEqual(observed.position, { x: 0.5, y: 200, z: 0.5 });
  assert.deepEqual(observed.inventory, [{ slot: 1, name: "oak_log", count: 1 }]);
});
