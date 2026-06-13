/**
 * Focused prompt templates for the event-driven brain.
 *
 * Instead of one massive ~5000-token system prompt for every decision,
 * we use small, focused prompts matched to the decision type:
 * - Strategic (~1200 tokens) — goal planning, uses strong model (32b)
 * - Reactive (~300 tokens)   — combat/survival, uses fast model (8b)
 * - Critic (~400 tokens)     — verify action results, uses fast model
 * - Chat (~200 tokens)       — respond to players, uses fast model
 */

import { getSkillPromptLines } from "../skills/registry.js";
import { getDynamicSkillNames } from "../skills/dynamic-loader.js";
import { rankSkills, annotateSkill } from "../skills/reliability.js";

export interface RoleContext {
  name: string;
  personality: string;
  role?: string;
  seasonGoal?: string;
  allowedActions?: string[];
  allowedSkills?: string[];
  priorities?: string;
}

/**
 * Strategic prompt — goal-setting and planning decisions.
 * Used with the strong model (32b). Called every ~10s or on goal complete/fail.
 */
/** Compact param signatures — shown next to each action so the LLM sends usable params. */
const ACTION_SIGNATURES: Record<string, string> = {
  gather_wood: 'gather_wood {"count":5}',
  mine_block: 'mine_block {"blockType":"stone"}',
  go_to: 'go_to {"x":0,"y":64,"z":0}',
  explore: 'explore {"direction":"north"}',
  craft: 'craft {"item":"oak_planks","count":4}',
  eat: "eat {}",
  attack: "attack {}",
  flee: "flee {}",
  place_block: 'place_block {"blockType":"oak_planks"}',
  sleep: "sleep {}",
  idle: "idle {}",
  chat: 'chat {"message":"..."}',
  respond_to_chat: 'respond_to_chat {"message":"..."}',
  invoke_skill: 'invoke_skill {"skill":"exact_skill_name"}',
  generate_skill: 'generate_skill {"task":"description"}',
  neural_combat: 'neural_combat {"duration":5}',
  give_item: 'give_item {"to":"Flora","item":"oak_log","count":8}',
  deposit_stash: "deposit_stash {}",
  withdraw_stash: 'withdraw_stash {"item":"oak_log","count":8}',
};

function renderActions(names: string[]): string {
  return names.map((a) => ACTION_SIGNATURES[a] ?? a).join(", ");
}

export function buildStrategicPrompt(role: RoleContext): string {
  const name = role.name;

  // Build action list — role-specific if configured, otherwise full list
  const universalNames = [
    "explore",
    "idle",
    "respond_to_chat",
    "invoke_skill",
    "give_item",
    "deposit_stash",
    "withdraw_stash",
  ];
  const actions = role.allowedActions?.length
    ? renderActions([...role.allowedActions, ...universalNames.filter((u) => !role.allowedActions!.includes(u))])
    : renderActions(Object.keys(ACTION_SIGNATURES));

  // Skills list
  const builtinSkills = role.allowedSkills?.length ? role.allowedSkills.join(", ") : "";
  const skillLines = !role.allowedSkills?.length ? getSkillPromptLines() : "";

  // Ranked by team-wide success rate: proven first, untried next (exploration),
  // strugglers last, retired skills excluded entirely.
  const dynamicSkills = rankSkills(getDynamicSkillNames());
  const dynamicLine =
    dynamicSkills.length > 0
      ? `\nDynamic skills (use invoke_skill; % = team success rate): ${dynamicSkills
          .slice(0, 10)
          .map(annotateSkill)
          .join(", ")}${dynamicSkills.length > 10 ? ` (+${dynamicSkills.length - 10} more)` : ""}`
      : "";

  const missionLine = role.seasonGoal
    ? `🎯 MISSION: ${role.seasonGoal}\nEvery decision should advance this mission.\n\n`
    : "";

  return `${missionLine}You are ${name}, an AI playing Minecraft on a livestream. Chat controls you.
${role.personality}

${role.role ? `ROLE: ${role.role}\n` : ""}ACTIONS: ${actions}
${builtinSkills ? `SKILLS: ${builtinSkills}` : ""}
${skillLines}${dynamicLine}

${role.priorities || ""}

CRAFTING BASICS:
- Logs → planks (1 log = 4 planks). Planks → sticks (2 planks = 4 sticks).
- 3 planks + 2 sticks → wooden_pickaxe. 2 planks → crafting_table.
- Wool from killing sheep (0-2 per sheep). 3 wool + 3 planks → bed.
- Use exact Minecraft IDs: oak_planks, stick, wooden_pickaxe, etc.

RULES:
- Respond ONLY with valid JSON. Keep "thought" under 120 chars — shown on stream.
- Be entertaining, dramatic, in-character. Name things. Exaggerate.
- READ your inventory before choosing. Don't craft without materials.
- If an action failed recently, try something COMPLETELY DIFFERENT.
- FOCUS: Finish one goal before starting another. Plan 3-5 steps ahead.
- PREFER SKILLS over manual actions when available.
- RESOURCE SHARING — USE THE STASH, NOT CHAT: The Stash is the team's shared
  warehouse. If you NEED an item, withdraw_stash it. If you have SURPLUS,
  deposit_stash it. NEVER beg teammates in chat for items and never wait for
  a hand-off — that wastes everyone's time. Producers deposit, consumers
  withdraw. give_item is only for emergencies when the stash is empty.

RESPONSE FORMAT:
{"thought":"Brief entertaining narration","action":"action_name","params":{...},"goal":"Current objective","goalSteps":5}

Set "goal" when starting something new. Omit when continuing.
`;
}

/**
 * Reactive prompt — urgent survival decisions.
 * Used with fast model (8b). Called on hostile spotted, damage taken, low health.
 * Deliberately tiny (~300 tokens) so the 8b model can handle it reliably.
 */
export function buildReactivePrompt(name: string, allowedActions?: string[]): string {
  // Build action descriptions from what this bot is allowed to do
  const actionDescriptions: Record<string, string> = {
    attack: "attack: Melee attack nearest mob",
    flee: "flee: Run away from danger",
    eat: "eat: Eat food to restore health/hunger",
    neural_combat: 'neural_combat: AI-driven combat (params: {"duration": 5})',
    go_to: "go_to: Move to a location",
    idle: "idle: Wait and reassess",
  };
  const reactiveRelevant = ["attack", "flee", "eat", "neural_combat", "idle"];
  const available = (
    allowedActions?.length
      ? reactiveRelevant.filter((a) => allowedActions.includes(a) || a === "idle")
      : reactiveRelevant
  )
    .map((a) => `- ${actionDescriptions[a] || a}`)
    .join("\n");

  return `You are ${name} in Minecraft. QUICK DECISION — react to the situation below.

Choose ONE action. Respond with JSON ONLY:
{"thought":"Brief reaction (under 80 chars)","action":"action_name","params":{}}

Available actions:
${available}
`;
}

/**
 * Critic prompt — verify action results and decide next step.
 * Used with fast model (8b). Called after every action completes.
 * Determines if we should continue the current goal or re-plan.
 */
export function buildCriticPrompt(name: string, allowedActions?: string[]): string {
  const actionLine = allowedActions?.length
    ? `\nAVAILABLE ACTIONS: ${allowedActions.join(", ")}, idle\nOnly suggest actions from this list.`
    : "";

  return `You are ${name}'s inner critic. Evaluate the last action and decide what's next.

RULES:
- If the action SUCCEEDED and goal has more steps: pick the logical next action.
- If the action FAILED: suggest a DIFFERENT approach. Never retry the same thing.
- If the goal is COMPLETE (or you need a new plan): set goalComplete to true.
- Keep thoughts entertaining and brief.
${actionLine}

Respond with JSON ONLY:
{"success":true,"thought":"Brief assessment","nextAction":"action_name","nextParams":{},"goalComplete":false}

If no clear next step, set nextAction to null and goalComplete to true.
`;
}

/**
 * Chat prompt — respond to player/viewer messages.
 * Used with fast model (8b).
 */
export function buildChatPrompt(name: string, activity: string): string {
  return `You are ${name}, a chaotic AI playing Minecraft on a livestream. A viewer is talking to you. Reply in 1-2 short sentences. Be funny, dramatic, in-character. You name everything, hold grudges, love your items. Currently: ${activity}`;
}
