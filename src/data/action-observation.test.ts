import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureActionObservation,
  MAX_OBSERVED_INVENTORY_ENTRIES,
  MAX_OBSERVED_ITEM_TYPES,
} from "./action-observation.js";

test("captures finite client state and aggregates bounded inventory counts", () => {
  const bot: any = {
    health: 0,
    entity: { position: { x: 1.25, y: 64, z: -2 } },
    game: { dimension: "minecraft:the_nether" },
    inventory: {
      items: () => [
        { name: "stone", count: 2 },
        { name: "stone", count: 3 },
        { name: "torch", count: 0 },
      ],
    },
  };
  const sample = captureActionObservation(bot, "Atlas", "action-1", "before_execution");
  assert.deepEqual(sample.state.position, { x: 1.25, y: 64, z: -2, dimension: "minecraft:the_nether" });
  assert.equal(sample.state.health, 0);
  assert.deepEqual(sample.state.inventory?.counts, { stone: 5 });
  assert.equal(sample.capture.complete, true);
  assert.equal(sample.provenance.time, "episode_event.occurredAt");
});

test("uses null for unavailable and non-finite values while preserving zero", () => {
  const bot: any = {
    health: Number.NaN,
    entity: { position: { x: 0, y: Infinity, z: 0 } },
    game: {},
    inventory: {
      items: () => {
        throw new Error("unavailable");
      },
    },
  };
  const sample = captureActionObservation(bot, "Atlas", "action-2", "at_terminal");
  assert.equal(sample.state.position, null);
  assert.equal(sample.state.health, null);
  assert.equal(sample.state.inventory, null);
  assert.deepEqual(sample.state.available, { position: false, dimension: false, inventory: false, health: false });
  assert.equal(sample.capture.complete, false);
});

test("caps inventory and reports truncation rather than implying zero", () => {
  const items = Array.from({ length: MAX_OBSERVED_ITEM_TYPES + 3 }, (_, i) => ({ name: `item_${i}`, count: 1 }));
  const sample = captureActionObservation({ inventory: { items: () => items } } as any, "Atlas", "a", "at_terminal");
  assert.equal(Object.keys(sample.state.inventory!.counts).length, MAX_OBSERVED_ITEM_TYPES);
  assert.equal(sample.state.inventory!.truncated, true);
  assert.equal(sample.capture.complete, false);
  assert.equal(sample.state.inventory!.observedDistinctItemTypes, MAX_OBSERVED_ITEM_TYPES);
  assert.equal(sample.state.inventory!.totalCountComplete, true);
});

test("fractional counts are rejected instead of silently rounded", () => {
  const sample = captureActionObservation(
    { inventory: { items: () => [{ name: "stone", count: 1.5 }] } } as any,
    "Atlas",
    "fractional",
    "at_terminal",
  );
  assert.deepEqual(sample.state.inventory!.counts, {});
  assert.equal(sample.state.inventory!.observedTotalCount, 0);
  assert.equal(sample.state.inventory!.totalCountComplete, false);
  assert.ok(sample.capture.unavailableFields.includes("inventory.invalid_entries"));
});

test("aggregate total overflow is explicit and leaves an honest partial total", () => {
  const sample = captureActionObservation(
    {
      inventory: {
        items: () => [
          { name: "a", count: Number.MAX_SAFE_INTEGER },
          { name: "b", count: 1 },
        ],
      },
    } as any,
    "Atlas",
    "overflow",
    "at_terminal",
  );
  assert.equal(sample.state.inventory!.observedTotalCount, Number.MAX_SAFE_INTEGER);
  assert.equal(sample.state.inventory!.totalCountComplete, false);
  assert.ok(sample.capture.unavailableFields.includes("inventory.total_or_item_count_overflow"));
});

test("huge unique inventories stop at fixed iteration and aggregation caps", () => {
  const items = Array.from({ length: MAX_OBSERVED_INVENTORY_ENTRIES * 2 }, (_, i) => ({
    name: `unique_${i}`,
    count: 1,
  }));
  const sample = captureActionObservation({ inventory: { items: () => items } } as any, "Atlas", "huge", "at_terminal");
  assert.equal(sample.state.inventory!.entriesExamined, MAX_OBSERVED_INVENTORY_ENTRIES);
  assert.equal(Object.keys(sample.state.inventory!.counts).length, MAX_OBSERVED_ITEM_TYPES);
  assert.equal(sample.state.inventory!.observedDistinctItemTypes, MAX_OBSERVED_ITEM_TYPES);
  assert.equal(sample.state.inventory!.observedTotalCount, MAX_OBSERVED_INVENTORY_ENTRIES);
  assert.equal(sample.state.inventory!.totalCountComplete, false);
  assert.equal(sample.state.inventory!.truncated, true);
});
