import { test } from "node:test";
import assert from "node:assert/strict";
import { plankKindFor } from "./glow-sign.js";

test("a sign needs six planks of one kind", () => {
  assert.equal(plankKindFor([{ name: "oak_planks", count: 6 }]), "oak");
  assert.equal(plankKindFor([{ name: "oak_planks", count: 4 }, { name: "oak_planks", count: 2 }]), "oak");
  assert.equal(plankKindFor([{ name: "oak_planks", count: 3 }, { name: "birch_planks", count: 3 }]), null);
  assert.equal(plankKindFor([{ name: "spruce_planks", count: 17 }, { name: "stick", count: 5 }]), "spruce");
});
