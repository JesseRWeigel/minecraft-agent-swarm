import { test } from "node:test";
import assert from "node:assert/strict";
import { bedExplodesHere } from "./bed-safety.js";

test("bed safety: the nether and the end detonate beds", () => {
  for (const dim of ["minecraft:the_nether", "the_nether", "nether", "minecraft:the_end", "the_end"]) {
    assert.strictEqual(bedExplodesHere(dim), true, `${dim} should be refused`);
  }
});

test("bed safety: the overworld sleeps normally", () => {
  for (const dim of ["minecraft:overworld", "overworld"]) {
    assert.strictEqual(bedExplodesHere(dim), false, `${dim} should still allow sleep`);
  }
});

test("bed safety: an unknown dimension keeps the nights working", () => {
  // Refusing on a string we do not recognise would cost every bot its sleep.
  assert.strictEqual(bedExplodesHere(undefined), false);
  assert.strictEqual(bedExplodesHere(null), false);
  assert.strictEqual(bedExplodesHere(""), false);
});
