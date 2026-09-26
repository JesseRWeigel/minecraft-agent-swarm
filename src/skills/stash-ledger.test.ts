import { test } from "node:test";
import assert from "node:assert/strict";
import { stashItemMatches } from "./stash-ledger.js";

test("run 848: a food request for cod or salmon skips the fish buckets", () => {
  assert.equal(stashItemMatches("cod_bucket", "cod"), false);
  assert.equal(stashItemMatches("salmon_bucket", "salmon"), false);
  assert.equal(stashItemMatches("cod", "cod"), true);
  assert.equal(stashItemMatches("cooked_cod", "cod"), true);
});

test("a bucket request still finds every bucket", () => {
  assert.equal(stashItemMatches("water_bucket", "water_bucket"), true);
  assert.equal(stashItemMatches("water_bucket", "bucket"), true);
  assert.equal(stashItemMatches("bucket", "bucket"), true);
});

test("poisonous potatoes stay out of a potato request", () => {
  assert.equal(stashItemMatches("poisonous_potato", "potato"), false);
  assert.equal(stashItemMatches("baked_potato", "potato"), true);
});
