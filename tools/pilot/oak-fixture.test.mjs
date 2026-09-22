import assert from "node:assert/strict";
import { test } from "node:test";

import { OAK_QUERIES, sampleOakTask } from "./oak-task.mjs";
import { OAK_FIXTURE_SHA256, setupOakFixture, verifyOakFixtureSample } from "./oak-fixture.mjs";

const actorPrefix = "PilotProbe has the following entity data: ";
const movementReplies = new Map([
  ["data get entity PilotProbe Rotation", `${actorPrefix}[0.0f, 0.0f]`],
  ["data get entity PilotProbe Inventory", `${actorPrefix}[]`],
  ["data get entity PilotProbe playerGameType", `${actorPrefix}0`],
  ["data get entity PilotProbe foodLevel", `${actorPrefix}20`],
  ["data get entity PilotProbe active_effects", "Found no elements matching active_effects"],
]);

function oakAdapter() {
  const issued = [];
  const replies = {
    "data get entity PilotProbe Pos": `${actorPrefix}[0.5d, 200d, 0.5d]`,
    "data get entity PilotProbe Dimension": `${actorPrefix}\"minecraft:overworld\"`,
    "data get entity PilotProbe Health": `${actorPrefix}20f`,
    "data get entity PilotProbe UUID": `${actorPrefix}[I; -246738247, 1303722752, -1416835668, -1046535363]`,
    list: "There are 1 of a max of 1 players online: PilotProbe",
    [OAK_QUERIES.inventory]: `${actorPrefix}[]`,
    [OAK_QUERIES.log]: "Test passed",
    [OAK_QUERIES.air]: "Test failed",
  };
  return {
    issued,
    rcon: {
      async send(command) {
        issued.push(command);
        if (command.startsWith("execute in minecraft:overworld if block") && command !== OAK_QUERIES.air)
          return "Test passed";
        if (command === "clear PilotProbe") return "No items were found on player PilotProbe";
        return replies[command] ?? movementReplies.get(command) ?? "Command completed";
      },
    },
  };
}

test("oak setup layers a bounded containment fixture over the verified movement fixture", async () => {
  const { rcon, issued } = oakAdapter();
  const result = await setupOakFixture({ rcon });

  assert.equal(result.status, "configured");
  assert.equal(result.fixture.sha256, OAK_FIXTURE_SHA256);
  assert.equal(result.parentSetup.status, "configured");
  assert.deepEqual(
    result.commandReceipts.map(({ name, outcome }) => ({ name, outcome })),
    [
      "build_bedrock_floor",
      "build_west_wall",
      "build_east_wall",
      "build_north_wall",
      "build_south_wall",
      "build_bedrock_roof",
      "place_oak_log",
    ].map((name) => ({ name, outcome: "issued" })),
  );
  assert.deepEqual(
    result.blockChecks.map(({ name, status }) => ({ name, status })),
    ["floor", "west_wall", "east_wall", "north_wall", "south_wall", "roof", "oak_log"].map((name) => ({
      name,
      status: "verified",
    })),
  );
  assert.ok(issued.includes("execute in minecraft:overworld run setblock 0 200 3 minecraft:oak_log"));
  assert.ok(result.durationMs >= 0 && result.durationMs < 15_000);
});

test("oak fixture accepts only a sampled empty-inventory actor at the fixed log start", async () => {
  const { rcon } = oakAdapter();
  const sample = await sampleOakTask({ rcon, phase: "before", trialId: "collect-oak-log-v1", actionId: "collect-01" });
  assert.deepEqual(verifyOakFixtureSample(sample), { status: "verified" });

  for (const alter of [
    (value) => value.inventory.push({ slot: 0, id: "minecraft:oak_log", count: 1 }),
    (value) => (value.targetBlock = "minecraft:air"),
    (value) => (value.actorSample.observations.gameMode = 1),
    (value) => (value.actorSample.observations.position.z = 0.6),
    (value) => (value.actorSample.observations.health = 19),
  ]) {
    const value = structuredClone(sample);
    alter(value);
    assert.equal(verifyOakFixtureSample(value).status, "failed");
  }
});

test("oak setup fails closed on an exact failed block assertion and does not issue later checks", async () => {
  const { rcon, issued } = oakAdapter();
  const baseSend = rcon.send;
  rcon.send = async (command) => {
    if (command === "execute in minecraft:overworld if block -4 199 -4 minecraft:bedrock") return "Test failed";
    return baseSend(command);
  };
  const result = await setupOakFixture({ rcon });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "block_mismatch");
  assert.equal(issued.includes("execute in minecraft:overworld if block -4 200 -4 minecraft:bedrock"), false);
});

test("oak setup shares the fixed fifteen-second budget with its parent fixture", async () => {
  const { rcon } = oakAdapter();
  const result = await setupOakFixture({ rcon, operationTimeoutMs: 15 });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "timeout");
});
