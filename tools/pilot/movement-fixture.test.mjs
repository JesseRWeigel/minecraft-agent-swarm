import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BASELINE_QUERIES,
  FIXTURE_COMMANDS,
  FIXTURE_SHA256,
  setupMovementFixture,
  verifyFixtureSample,
} from "./movement-fixture.mjs";

const EXPECTED_COMMANDS = [
  { name: "peaceful_difficulty", command: "difficulty peaceful" },
  { name: "disable_mob_spawning", command: "gamerule doMobSpawning false" },
  { name: "disable_daylight_cycle", command: "gamerule doDaylightCycle false" },
  { name: "disable_weather_cycle", command: "gamerule doWeatherCycle false" },
  { name: "fixed_day", command: "time set day" },
  { name: "clear_weather", command: "weather clear" },
  {
    name: "forceload_fixture",
    command: "execute in minecraft:overworld run forceload add -4 -4 4 12",
  },
  {
    name: "clear_fixture_volume",
    command: "execute in minecraft:overworld run fill -4 199 -4 4 204 12 minecraft:air",
  },
  {
    name: "build_stone_floor",
    command: "execute in minecraft:overworld run fill -4 199 -4 4 199 12 minecraft:stone",
  },
  { name: "clear_inventory", command: "clear PilotProbe" },
  { name: "survival_mode", command: "gamemode survival PilotProbe" },
  {
    name: "fixed_spawn",
    command: "execute in minecraft:overworld run teleport PilotProbe 0.5 200 0.5 0 0",
  },
  {
    name: "restore_health",
    command: "effect give PilotProbe minecraft:instant_health 1 255 true",
  },
  {
    name: "restore_food",
    command: "effect give PilotProbe minecraft:saturation 1 255 true",
  },
  { name: "clear_effects", command: "effect clear PilotProbe" },
];

const EXPECTED_QUERIES = [
  { name: "orientation", command: "data get entity PilotProbe Rotation" },
  { name: "inventory", command: "data get entity PilotProbe Inventory" },
  { name: "game_mode", command: "data get entity PilotProbe playerGameType" },
  { name: "food", command: "data get entity PilotProbe foodLevel" },
  { name: "effects", command: "data get entity PilotProbe active_effects" },
];

const QUERY_REPLIES = new Map([
  [EXPECTED_QUERIES[0].command, "PilotProbe has the following entity data: [0.0f, 0.0f]"],
  [EXPECTED_QUERIES[1].command, "PilotProbe has the following entity data: []"],
  [EXPECTED_QUERIES[2].command, "PilotProbe has the following entity data: 0"],
  [EXPECTED_QUERIES[3].command, "PilotProbe has the following entity data: 20"],
  [EXPECTED_QUERIES[4].command, "Found no elements matching active_effects"],
]);

function sampled(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "sampled",
    source: "server_rcon",
    actor: "PilotProbe",
    phase: "before",
    observations: {
      position: { x: 0.5, y: 200, z: 0.5 },
      dimension: "minecraft:overworld",
      health: 20,
    },
    ...overrides,
  };
}

test("setup issues only the reviewed fixed plan and reports its stable fingerprint", async () => {
  const issued = [];
  const result = await setupMovementFixture({
    rcon: {
      send(command) {
        issued.push(command);
        if (command === "clear PilotProbe") return "No items were found on player PilotProbe";
        return QUERY_REPLIES.get(command) ?? "Command completed";
      },
    },
  });

  assert.deepEqual(FIXTURE_COMMANDS, EXPECTED_COMMANDS);
  assert.deepEqual(BASELINE_QUERIES, EXPECTED_QUERIES);
  assert.equal(FIXTURE_SHA256, "3a696ca577186c8d2f308fd07fa31d72a3c2a4d98018beb2e64afacd5b358ac7");
  assert.deepEqual(
    issued,
    [...EXPECTED_COMMANDS, ...EXPECTED_QUERIES].map(({ command }) => command),
  );
  assert.equal(result.status, "configured");
  assert.equal(result.fixture.sha256, FIXTURE_SHA256);
  assert.deepEqual(result.fixture.commands, EXPECTED_COMMANDS);
  assert.deepEqual(
    result.commandWindows.map(({ name, outcome, verification }) => ({ name, outcome, verification })),
    EXPECTED_COMMANDS.map(({ name }) => ({ name, outcome: "issued", verification: "unverified" })),
  );
  assert.deepEqual(
    result.baselineChecks.map(({ name, status }) => ({ name, status })),
    EXPECTED_QUERIES.map(({ name }) => ({ name, status: "verified" })),
  );
  assert.ok(result.baselineChecks.every(({ durationMs }) => durationMs >= 0));
});

test("setup rejects malformed and explicit failure replies without leaking them", async () => {
  for (const reply of [undefined, "", "Unknown or incomplete command: secret-value"]) {
    const result = await setupMovementFixture({ rcon: { send: async () => reply } });
    assert.equal(result.status, "failed");
    assert.ok(["invalid_response", "command_failed"].includes(result.errorCode));
    assert.equal(JSON.stringify(result).includes("secret-value"), false);
  }
});

test("setup bounds a stalled adapter and does not issue later commands", async () => {
  const issued = [];
  const started = Date.now();
  const result = await setupMovementFixture({
    rcon: {
      send(command) {
        issued.push(command);
        return new Promise(() => {});
      },
    },
    operationTimeoutMs: 15,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "timeout");
  assert.equal(issued.length, 1);
  assert.ok(Date.now() - started < 250);
});

test("setup treats a response completing after the overall deadline as timeout", async () => {
  const issued = [];
  const result = await setupMovementFixture({
    rcon: {
      async send(command) {
        issued.push(command);
        await new Promise((resolve) => setTimeout(resolve, 30));
        return "Command completed";
      },
    },
    operationTimeoutMs: 10,
  });

  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "timeout");
  assert.equal(issued.length, 1);
});

test("setup enforces the monotonic overall deadline between commands", async () => {
  const issued = [];
  const clock = [0, 1, 15_000, 15_000, 15_000];
  const result = await setupMovementFixture({
    rcon: { send: async (command) => (issued.push(command), "Command completed") },
    nowMonotonic: () => clock.shift() ?? 15_000,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "timeout");
  assert.equal(issued.length, 1);
});

test("baseline verifier accepts the authoritative fixed position within tolerance", () => {
  assert.deepEqual(
    verifyFixtureSample(
      sampled({
        observations: {
          position: { x: 0.55, y: 199.95, z: 0.45 },
          dimension: "minecraft:overworld",
          health: 20,
        },
      }),
    ),
    { status: "verified" },
  );
});

test("baseline verifier rejects dead, displaced, wrong-dimension, and unauthoritative samples", () => {
  const cases = [
    sampled({ observations: { position: { x: 0.5, y: 200, z: 0.5 }, dimension: "minecraft:overworld", health: 0 } }),
    sampled({ observations: { position: { x: 0.551, y: 200, z: 0.5 }, dimension: "minecraft:overworld", health: 20 } }),
    sampled({ observations: { position: { x: 0.5, y: 200, z: 0.5 }, dimension: "minecraft:the_nether", health: 20 } }),
    sampled({ source: "participant" }),
    sampled({ status: "failed" }),
  ];

  for (const sample of cases) {
    const result = verifyFixtureSample(sample);
    assert.equal(result.status, "failed");
    assert.equal(typeof result.errorCode, "string");
  }
});

test("setup validates trusted adapter and fixed timeout bounds", async () => {
  await assert.rejects(() => setupMovementFixture(), /rcon\.send/);
  await assert.rejects(
    () => setupMovementFixture({ rcon: { send() {} }, operationTimeoutMs: 15_001 }),
    /operationTimeoutMs/,
  );
});

test("empty gamemode no-op is accepted only with verified survival readback", async () => {
  for (const mode of ["0", "1"]) {
    const result = await setupMovementFixture({
      rcon: {
        send(command) {
          if (command === "gamemode survival PilotProbe") return "";
          if (command === "data get entity PilotProbe playerGameType")
            return `PilotProbe has the following entity data: ${mode}`;
          return QUERY_REPLIES.get(command) ?? "Command completed";
        },
      },
    });
    assert.equal(result.status, mode === "0" ? "configured" : "failed");
  }
});
