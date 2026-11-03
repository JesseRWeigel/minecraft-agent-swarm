import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveMinecraftProtocolVersion } from "./minecraft-compat.js";

test("retains the previously configured native 1.21.4 protocol", () => {
  assert.equal(resolveMinecraftProtocolVersion("1.21.4"), "1.21.4");
});

test("Paper 26.3 requires an explicit 26.1 ViaBackwards bridge", () => {
  assert.throws(() => resolveMinecraftProtocolVersion("26.3"), /ViaVersion \+ ViaBackwards/);
  assert.throws(() => resolveMinecraftProtocolVersion("26.3", "26.1"), /MC_VIABACKWARDS=true/);
  assert.equal(resolveMinecraftProtocolVersion("26.3", "26.1", true), "26.1");
});

test("rejects unsupported native versions and undocumented protocol mismatches", () => {
  assert.throws(() => resolveMinecraftProtocolVersion("26.4"), /unsupported/);
  assert.throws(() => resolveMinecraftProtocolVersion("1.21.4", "26.1", true), /may differ/);
});
