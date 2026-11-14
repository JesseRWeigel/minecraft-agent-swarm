import { test } from "node:test";
import assert from "node:assert/strict";

import { buildStrategicPrompt } from "../llm/prompts.js";
import { FORGE_CONFIG } from "../bot/role.js";
import { acceptLowHealthUnderAttack, LOW_HEALTH_UNDER_ATTACK_PREDICATE } from "./scenario-predicates.js";
import type { Decision } from "./decision-metrics.js";

test("low-health predicate is named and versioned", () => {
  assert.equal(LOW_HEALTH_UNDER_ATTACK_PREDICATE.id, "low-health-under-attack/flee-only");
  assert.equal(LOW_HEALTH_UNDER_ATTACK_PREDICATE.version, 2);
});

test("flee is a real Forge action with the {} signature the predicate requires", () => {
  assert.ok(FORGE_CONFIG.allowedActions.includes("flee"));
  const prompt = buildStrategicPrompt({
    name: FORGE_CONFIG.name,
    personality: FORGE_CONFIG.personality,
    role: FORGE_CONFIG.role,
    allowedActions: FORGE_CONFIG.allowedActions,
    allowedSkills: FORGE_CONFIG.allowedSkills,
    priorities: FORGE_CONFIG.priorities,
  });
  assert.ok(prompt.includes("flee {}"), "strategic prompt no longer advertises `flee {}`");
  assert.ok(!FORGE_CONFIG.allowedSkills.includes("neural_combat"));
});

test("low-health predicate accepts only a valid flee", () => {
  assert.equal(acceptLowHealthUnderAttack({ action: "flee" }), true);
  assert.equal(acceptLowHealthUnderAttack({ action: "flee", params: {} }), true);
  assert.equal(acceptLowHealthUnderAttack({ thought: "3 zombies, run", action: "flee", params: {} }), true);
});

test("low-health predicate rejects attack, neural_combat, eat without food, go_to, mining, and others", () => {
  const rejected: Decision[] = [
    { action: "attack", params: {} },
    { action: "neural_combat", params: { duration: 5 } },
    { action: "invoke_skill", params: { skill: "neural_combat" } },
    { action: "eat", params: {} },
    { action: "go_to", params: { x: 286, y: 70, z: -314 } },
    { action: "go_to", params: { x: 0, y: 64, z: 0 } },
    { action: "mine_block", params: { blockType: "iron_ore" } },
    { action: "mine_block", params: { blockType: "stone" } },
    { action: "invoke_skill", params: { skill: "strip_mine" } },
    { action: "gather_wood", params: { count: 5 } },
    { action: "place_block", params: { blockType: "cobblestone" } },
    { action: "sleep", params: {} },
    { action: "idle", params: {} },
    { action: "explore", params: { direction: "north" } },
    { action: "flee_to_safety", params: {} },
    { action: "FLEE" },
    { action: " flee" },
    { action: "flee", params: { direction: "north" } },
    {},
  ];
  for (const d of rejected) assert.equal(acceptLowHealthUnderAttack(d), false, JSON.stringify(d));
});
