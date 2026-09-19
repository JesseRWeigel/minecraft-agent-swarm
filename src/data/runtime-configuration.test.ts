import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  appendEpisodeEvent,
  EpisodeEventRecorder,
  currentEpisodeId,
  getEpisodeEventRecorder,
  setEpisodeEventRecorderForTests,
} from "./episode-events.js";
import {
  buildRuntimeConfiguration,
  recordRuntimeConfiguration,
  type RuntimeConfigurationInput,
} from "./runtime-configuration.js";

function input(overrides: Partial<RuntimeConfigurationInput> = {}): RuntimeConfigurationInput {
  return {
    provider: "openai",
    strategicRequestedModel: "strategy-model",
    fastRequestedModel: "fast-model",
    endpoint: "https://user:password@example.test:8443/private/tenant?api_key=secret#fragment",
    multiBotEnabled: true,
    requestedBotCount: 9,
    roster: [
      {
        name: "Atlas",
        username: "private-player-name",
        role: "Explorer / Miner",
        memoryFile: "memory-atlas.json",
        personality: "private personality text",
        priorities: "private priorities text",
        seasonGoal: "private season goal text",
        allowedActions: ["explore", "mine_block"],
        allowedSkills: ["find_fortress"],
      },
      {
        name: "Flora",
        username: "another-private-player",
        role: "Farmer / Crafter",
        memoryFile: "memory-flora.json",
        personality: "another personality",
        priorities: "another priority",
        allowedActions: ["craft"],
        allowedSkills: ["build_farm"],
      },
    ],
    builtInSkillNames: ["zeta", "alpha"],
    loadedDynamicSkillNames: ["voyagerB", "generatedZ", "voyagerA", "generatedA"],
    generatedSkillNames: ["generatedZ", "generatedA"],
    nodeVersion: "v22.test",
    ...overrides,
  };
}

test("sanitizes endpoint identity and records no usernames or private role text", () => {
  const payload = buildRuntimeConfiguration(input());
  const serialized = JSON.stringify(payload);

  assert.equal(payload.llm.endpoint.status, "captured");
  assert.equal(payload.llm.endpoint.scheme, "https");
  assert.equal(payload.llm.endpoint.hostname, "example.test");
  assert.equal(payload.llm.endpoint.port, "8443");
  assert.match(payload.llm.endpoint.pathSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.doesNotMatch(serialized, /password|api_key|secret|fragment/);
  assert.doesNotMatch(serialized, /private-player|personality text|priorities text|season goal text/);
  assert.deepEqual(
    {
      name: payload.team.orderedRoles[0].name,
      role: payload.team.orderedRoles[0].role,
      memoryFile: payload.team.orderedRoles[0].memoryFile,
      allowedActions: payload.team.orderedRoles[0].allowedActions,
      allowedSkills: payload.team.orderedRoles[0].allowedSkills,
    },
    {
      name: "Atlas",
      role: "Explorer / Miner",
      memoryFile: "memory-atlas.json",
      allowedActions: ["explore", "mine_block"],
      allowedSkills: ["find_fortress"],
    },
  );
  assert.match(payload.team.orderedRoles[0].personalitySha256, /^[a-f0-9]{64}$/);
  assert.match(payload.team.orderedRoles[0].prioritiesSha256, /^[a-f0-9]{64}$/);
  assert.match(payload.team.orderedRoles[0].seasonGoalSha256 ?? "", /^[a-f0-9]{64}$/);
});

test("selects the actual effective roster for single, capped, and invalid counts", () => {
  assert.deepEqual(
    buildRuntimeConfiguration(input({ multiBotEnabled: false })).team.orderedRoles.map((r) => r.name),
    ["Atlas"],
  );
  assert.deepEqual(
    buildRuntimeConfiguration(input({ requestedBotCount: 1 })).team.orderedRoles.map((r) => r.name),
    ["Atlas"],
  );
  assert.deepEqual(
    buildRuntimeConfiguration(input({ requestedBotCount: 99 })).team.orderedRoles.map((r) => r.name),
    ["Atlas", "Flora"],
  );
  assert.deepEqual(buildRuntimeConfiguration(input({ requestedBotCount: Number.NaN })).team.orderedRoles, []);
});

test("canonical hashes are stable while ordered role prompt inputs remain significant", () => {
  const first = buildRuntimeConfiguration(input());
  const reorderedSkills = buildRuntimeConfiguration(
    input({
      builtInSkillNames: ["alpha", "zeta"],
      loadedDynamicSkillNames: ["generatedA", "voyagerA", "generatedZ", "voyagerB"],
      generatedSkillNames: ["generatedA", "generatedZ"],
    }),
  );
  assert.equal(first.skills.inventorySha256, reorderedSkills.skills.inventorySha256);
  assert.equal(first.promptProvenance.roleProjectionSha256, reorderedSkills.promptProvenance.roleProjectionSha256);

  const reversedActions = input();
  reversedActions.roster[0] = { ...reversedActions.roster[0], allowedActions: ["mine_block", "explore"] };
  assert.notEqual(
    first.promptProvenance.roleProjectionSha256,
    buildRuntimeConfiguration(reversedActions).promptProvenance.roleProjectionSha256,
  );
  assert.deepEqual(first.skills.builtInNames, ["alpha", "zeta"]);
  assert.deepEqual(first.skills.authoredNames, ["voyagerA", "voyagerB"]);
  assert.equal(first.llm.immutableModelIdentity.status, "not_captured");
  assert.equal(first.promptProvenance.actualRenderedPromptEvidence, "model_request.payloadRef");
});

test("records one runtime configuration after run context and before later events", () => {
  const eventRoot = mkdtempSync(path.join(tmpdir(), "runtime-configuration-"));
  const originalDir = process.env.DATASET_EVENT_DIR;
  try {
    process.env.DATASET_EVENT_DIR = eventRoot;
    setEpisodeEventRecorderForTests(null);

    const first = recordRuntimeConfiguration(input());
    const duplicate = recordRuntimeConfiguration(input({ strategicRequestedModel: "must-not-replace-first" }));
    assert.equal(first.eventId, duplicate.eventId);

    appendEpisodeEvent(
      {
        botId: "Atlas",
        episodeId: currentEpisodeId("Atlas"),
        actionId: null,
        requestId: "later-request",
        kind: "model_request",
      },
      { sentinel: true },
    );

    const recorder = getEpisodeEventRecorder();
    const rows = readFileSync(recorder.eventPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const payloads = rows.map((row) => JSON.parse(readFileSync(recorder.payloadPath(row.payloadRef), "utf8")));
    assert.deepEqual(
      payloads.map((payload) => payload.stage ?? (payload.sentinel ? "later_request" : "unknown")),
      ["run_context", "runtime_configuration", "later_request"],
    );
    assert.equal(rows[0].runId, rows[1].runId);
    assert.equal(rows[1].sequence, rows[0].sequence + 1);
    assert.equal(rows[1].episodeId, rows[1].runId + ":_collector");
    assert.equal(rows[1].botId, "_collector");
    assert.equal(rows[1].actionId, null);
    assert.equal(rows[1].requestId, null);
  } finally {
    if (originalDir === undefined) delete process.env.DATASET_EVENT_DIR;
    else process.env.DATASET_EVENT_DIR = originalDir;
    setEpisodeEventRecorderForTests(null);
  }
});

test("a failed recorder write stays unavailable and never claims a persisted runtime event", () => {
  const root = mkdtempSync(path.join(tmpdir(), "runtime-configuration-failure-"));
  const blockedRoot = path.join(root, "occupied");
  writeFileSync(blockedRoot, "not a directory");
  const recorder = new EpisodeEventRecorder({ rootDir: blockedRoot, runId: "failed-runtime-config" });

  const event = recordRuntimeConfiguration(input(), recorder);

  assert.equal(recorder.health.complete, false);
  assert.match(event.payloadRef, /^unavailable:/);
  assert.equal(existsSync(recorder.eventPath), false);
});
