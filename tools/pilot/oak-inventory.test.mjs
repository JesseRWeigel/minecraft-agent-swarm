import assert from "node:assert/strict";
import { test } from "node:test";

import { parseInventoryReply } from "./oak-inventory.mjs";

const PREFIX = "PilotProbe has the following entity data: ";

test("parses the empty inventory reply", () => {
  assert.deepEqual(parseInventoryReply(`${PREFIX}[]`), []);
});

test("parses ordinary item compounds in arbitrary key order and whitespace", () => {
  assert.deepEqual(
    parseInventoryReply(
      `${PREFIX}[ { id: "minecraft:oak_log", count: 64, Slot: 0b },\n{ Slot: -106b, count: 1, id: "minecraft:oak_sapling" } ]`,
    ),
    [
      { slot: 0, id: "minecraft:oak_log", count: 64 },
      { slot: -106, id: "minecraft:oak_sapling", count: 1 },
    ],
  );
});

test("accepts every allowed inventory slot boundary", () => {
  const slots = [0, 35, 100, 103, -106];
  const text = slots.map((slot, index) => `{Slot:${slot}b,id:"minecraft:oak_log",count:${index + 1}}`).join(",");
  assert.deepEqual(
    parseInventoryReply(`${PREFIX}[${text}]`).map(({ slot }) => slot),
    slots,
  );
});

test("rejects a reply without the exact trusted prefix or trailing data", () => {
  for (const text of ["Other has the following entity data: []", `${PREFIX}[] trailing`, `${PREFIX}[]\nanything`]) {
    assert.throws(() => parseInventoryReply(text));
  }
});

test("rejects duplicate keys, duplicate slots, unknown fields, and component-bearing items", () => {
  for (const body of [
    '[{Slot:0b,Slot:1b,id:"minecraft:oak_log",count:1}]',
    '[{Slot:0b,id:"minecraft:oak_log",count:1},{Slot:0b,id:"minecraft:oak_log",count:1}]',
    '[{Slot:0b,id:"minecraft:oak_log",count:1,foo:2}]',
    '[{Slot:0b,id:"minecraft:oak_log",count:1,components:{}}]',
  ]) {
    assert.throws(() => parseInventoryReply(`${PREFIX}${body}`));
  }
});

test("rejects invalid slot, count, and item-id representations", () => {
  for (const body of [
    '[{Slot:36b,id:"minecraft:oak_log",count:1}]',
    '[{Slot:0,id:"minecraft:oak_log",count:1}]',
    '[{Slot:0.0b,id:"minecraft:oak_log",count:1}]',
    '[{Slot:0b,id:"minecraft:oak_log",count:0}]',
    '[{Slot:0b,id:"minecraft:oak_log",count:-1}]',
    '[{Slot:0b,id:"minecraft:oak_log",count:1.0}]',
    '[{Slot:0b,id:"minecraft:oak_log",count:65}]',
    '[{Slot:0b,id:"oak_log",count:1}]',
    '[{Slot:0b,id:"minecraft:Oak_Log",count:1}]',
    '[{Slot:0b,id:"minecraft:oak_log;drop",count:1}]',
    "[{Slot:0b,id:minecraft:oak_log,count:1}]",
  ]) {
    assert.throws(() => parseInventoryReply(`${PREFIX}${body}`));
  }
});

test("rejects malformed structures, more than 41 entries, and oversized input", () => {
  const item = '{Slot:0b,id:"minecraft:oak_log",count:1}';
  const tooMany = Array.from({ length: 42 }, () => item).join(",");
  for (const text of [
    `${PREFIX}[${item}`,
    `${PREFIX}{Slot:0b,id:"minecraft:oak_log",count:1}`,
    `${PREFIX}[${tooMany}]`,
    `${PREFIX}${" ".repeat(65_537)}`,
  ]) {
    assert.throws(() => parseInventoryReply(text));
  }
});
