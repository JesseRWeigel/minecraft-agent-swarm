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
    nearbyDroppedItems: [],
    nearbyDroppedItemsTruncated: false,
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

function dropped(name = "oak_log", count = 1, x = 0.5, y = 200, z = 1) {
  return {
    position: { x, y, z, secret: "private" },
    secret: "entity-private",
    getDroppedItem() {
      assert.equal(this.secret, "entity-private");
      return { name, count, nbt: { private: "do not expose" }, displayName: "private display", secret: "item-private" };
    },
  };
}

test("dropped items use entity API and expose only copied name count position", () => {
  const entity = dropped();
  const result = snapshotModelObservation(bot({ entities: { 1: entity } }));
  assert.deepEqual(result.nearbyDroppedItems, [{ name: "oak_log", count: 1, position: { x: 0.5, y: 200, z: 1 } }]);
  assert.equal(result.nearbyDroppedItemsTruncated, false);
  assert.equal(JSON.stringify(result).includes("private"), false);
  entity.position.z = 99;
  assert.equal(result.nearbyDroppedItems[0].position.z, 1);
});

test("nearby items sorted by distance then deterministic name and coordinates", () => {
  const entities = {
    a: dropped("z_item", 1, 0.5, 200, 2),
    b: dropped("a_item", 2, 0.5, 200, -1),
    c: dropped("near_item", 1, 0.5, 200, 0.6),
    d: dropped("far_item", 1, 0.5, 200, 8.5001),
    e: dropped("edge_item", 1, 0.5, 200, 8.5),
  };
  const result = snapshotModelObservation(bot({ entities }));
  assert.deepEqual(
    result.nearbyDroppedItems.map((x) => x.name),
    ["near_item", "a_item", "z_item", "edge_item"],
  );
  assert.deepEqual(
    result.nearbyDroppedItems,
    snapshotModelObservation(bot({ entities: Object.fromEntries(Object.entries(entities).reverse()) }))
      .nearbyDroppedItems,
  );
});

test("malformed optional entities are skipped without leaking or breaking core fields", () => {
  const entities = {
    a: null,
    b: {},
    c: dropped("bad name"),
    d: dropped("oak_log", 65),
    e: dropped("oak_log", 1, Infinity),
    f: {
      position: { x: 0, y: 200, z: 0 },
      getDroppedItem() {
        throw Error("private");
      },
    },
    g: dropped(["oak_log"]),
    h: dropped("oak_log", true),
    valid: dropped(),
  };
  Object.defineProperty(entities, "throws", {
    enumerable: true,
    get() {
      throw Error("private");
    },
  });
  assert.equal(snapshotModelObservation(bot({ entities })).nearbyDroppedItems.length, 1);
  for (const map of [undefined, null, [], 42, Object.create({ inherited: dropped() })])
    assert.deepEqual(snapshotModelObservation(bot({ entities: map })).nearbyDroppedItems, []);
});

test("nearby item output capped at sixteen with explicit truncation", () => {
  const entities = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [i, dropped("oak_log", 1, 0.5, 200, 0.5 + i / 10)]),
  );
  const result = snapshotModelObservation(bot({ entities }));
  assert.equal(result.nearbyDroppedItems.length, 16);
  assert.equal(result.nearbyDroppedItemsTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16384);
});

test("entity scan reads at most 256 own entries and signals unseen remainder", () => {
  let reads = 0;
  const entities = {};
  for (let i = 0; i < 257; i++)
    Object.defineProperty(entities, String(i), {
      enumerable: true,
      get() {
        reads++;
        return null;
      },
    });
  const result = snapshotModelObservation(bot({ entities }));
  assert.equal(reads, 256);
  assert.equal(result.nearbyDroppedItemsTruncated, true);
  assert.deepEqual(result.nearbyDroppedItems, []);
  delete entities.missing;
});

test("exactly 256 invalid entries do not claim scan truncation", () => {
  const entities = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [i, null]));
  assert.equal(snapshotModelObservation(bot({ entities })).nearbyDroppedItemsTruncated, false);
});
