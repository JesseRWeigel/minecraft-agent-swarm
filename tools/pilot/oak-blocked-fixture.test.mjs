import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OAK_BLOCKED_FIXTURE_SHA256,
  setupOakBlockedFixture,
} from "./oak-blocked-fixture.mjs";

const prefix = "PilotProbe has the following entity data: ";
const movementReplies = new Map([
  ["data get entity PilotProbe Rotation", `${prefix}[0.0f, 0.0f]`],
  ["data get entity PilotProbe Inventory", `${prefix}[]`],
  ["data get entity PilotProbe playerGameType", `${prefix}0`],
  ["data get entity PilotProbe foodLevel", `${prefix}20`],
  ["data get entity PilotProbe active_effects", "Found no elements matching active_effects"],
]);

function adapter() {
  const issued = [];
  return {
    issued,
    rcon: {
      async send(command) {
        issued.push(command);
        if (command.startsWith("execute in minecraft:overworld if block")) return "Test passed";
        if (command === "clear PilotProbe") return "No items were found on player PilotProbe";
        return movementReplies.get(command) ?? "Command completed";
      },
    },
  };
}

test("blocked fixture adds only five bedrock neighbors to the configured oak fixture", async () => {
  const { rcon, issued } = adapter();
  const result = await setupOakBlockedFixture({ rcon });

  assert.equal(result.status, "configured");
  assert.equal(result.fixture.sha256, OAK_BLOCKED_FIXTURE_SHA256);
  assert.equal(result.parentSetup.status, "configured");
  assert.deepEqual(
    result.commandReceipts.map(({ name, outcome }) => ({ name, outcome })),
    ["north", "south", "west", "east", "above"].map((name) => ({ name, outcome: "issued" })),
  );
  assert.deepEqual(
    result.blockChecks.map(({ name, status }) => ({ name, status })),
    ["north", "south", "west", "east", "above", "floor"].map((name) => ({ name, status: "verified" })),
  );
  assert.deepEqual(
    issued.filter((command) => command.includes("setblock 0 200 2 minecraft:bedrock")),
    ["execute in minecraft:overworld run setblock 0 200 2 minecraft:bedrock"],
  );
  assert.equal(result.commandReceipts.length, 5);
  assert.equal(result.blockChecks.length, 6);
});

test("blocked fixture fails closed on an exact failed readback", async () => {
  const { rcon, issued } = adapter();
  const send = rcon.send;
  rcon.send = async (command) => {
    if (command === "execute in minecraft:overworld if block 0 200 2 minecraft:bedrock") return "Test failed";
    return send(command);
  };
  const result = await setupOakBlockedFixture({ rcon });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "block_mismatch");
  assert.equal(issued.includes("execute in minecraft:overworld if block 0 200 4 minecraft:bedrock"), false);
});

test("blocked fixture enforces the single fifteen-second budget including base setup", async () => {
  const { rcon } = adapter();
  const result = await setupOakBlockedFixture({ rcon, operationTimeoutMs: 15 });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "timeout");
});
