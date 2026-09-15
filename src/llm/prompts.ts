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
import { categorizeSkills, annotateSkill } from "../skills/reliability.js";
import { pickSkillMenu } from "../skills/skill-menu.js";

/** Advances once per strategic prompt so the reserved explore slots rotate
 *  through the whole untried pool instead of showing the same head forever. */
let rotationCounter = 0;
function nextRotation(): number {
  return rotationCounter++;
}

export interface RoleContext {
  name: string;
  personality: string;
  role?: string;
  seasonGoal?: string;
  allowedActions?: string[];
  allowedSkills?: string[];
  priorities?: string;
  /** True while "eat" is blacklisted (no food aboard), so the prompt stops recommending it. */
  eatBlocked?: boolean;
}

/**
 * Strategic prompt — goal-setting and planning decisions.
 * Used with the strong model (32b). Called every ~10s or on goal complete/fail.
 */
/** Compact param signatures — shown next to each action so the LLM sends usable params. */
const ACTION_SIGNATURES: Record<string, string> = {
  gather_wood: 'gather_wood {"count":5}',
  mine_block: 'mine_block {"blockType":"iron_ore"}',
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

/**
 * Actions every role can take regardless of specialisation. These are the
 * escape hatches — without them a bot has no way to gather, fetch from the
 * stash, or run a learned skill.
 */
const UNIVERSAL_ACTIONS = [
  "explore",
  "idle",
  "respond_to_chat",
  "invoke_skill",
  "give_item",
  "deposit_stash",
  "withdraw_stash",
];

/**
 * Single source of truth for "what can this bot actually do?".
 *
 * The strategic planner and the critic MUST resolve the same set. They used to
 * derive it separately: the planner merged in UNIVERSAL_ACTIONS while the critic
 * received raw role.allowedActions plus "idle". Since the critic prompt says
 * "Only suggest actions from this list", that omission left roles like Blade
 * (attack/flee/go_to/eat/sleep/chat) with no legal way to gather or fetch, so
 * the critic concluded "no action can actually gather logs" and idled the bot.
 */
export function resolveAllowedActions(roleActions?: string[]): string[] {
  if (!roleActions?.length) return Object.keys(ACTION_SIGNATURES);
  return [...roleActions, ...UNIVERSAL_ACTIONS.filter((u) => !roleActions.includes(u))];
}

export function buildStrategicPrompt(role: RoleContext): string {
  const name = role.name;
  // Runs 619 to 629: with "eat" off the menu the model still picked it 16 to
  // 30 times an hour because this section told it to. Say what is true.
  const foodSection = role.eatBlocked
    ? `FOOD / DON'T STARVE:
- You have NO food aboard and "eat" is unavailable this turn. Get food first:
  invoke_skill {"skill":"hunt_food"} for animals, invoke_skill {"skill":"go_fishing"}
  near open water, or withdraw_stash {"item":"bread"} at the stash. Do not pick eat.`
    : `FOOD / DON'T STARVE:
- If hunger is low: eat {} (eats the best food you have, including raw meat).
- NO food in inventory? attack {} — when no monster is near it HUNTS the nearest
  animal (cow/pig/sheep/chicken) and collects the meat. Then eat {}. Hunt BEFORE
  you starve, not at 0 hunger.`;

  // Build action list — role-specific if configured, otherwise full list
  const actions = renderActions(resolveAllowedActions(role.allowedActions));

  // Skills list
  const builtinSkills = role.allowedSkills?.length ? role.allowedSkills.join(", ") : "";
  const skillLines = !role.allowedSkills?.length ? getSkillPromptLines() : "";

  // Proven skills lead, but EXPLORE_SLOTS are reserved for untried ones and
  // rotate every render. A flat proven-first slice made the library read-only:
  // 131 skills existed and only 18 had ever been attempted, because a skill
  // needed stats to be shown and needed to be shown to earn stats.
  const allDynamic = getDynamicSkillNames();
  const { proven, untried, struggling } = categorizeSkills(allDynamic);
  const dynamicSkills = pickSkillMenu(proven, untried, struggling, nextRotation());
  const unseen = allDynamic.length - dynamicSkills.length;
  const dynamicLine =
    dynamicSkills.length > 0
      ? `\nDynamic skills (use invoke_skill; % = team success rate): ${dynamicSkills
          .map(annotateSkill)
          .join(", ")}${unseen > 0 ? ` (+${unseen} more — ask for one by name if you need it)` : ""}`
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

THESE PRIORITIES ARE MAINTENANCE, NOT THE MISSION.
The "ADVANCEMENTS: ... NEXT FOR YOU" line in your CURRENT STATE is the actual
objective, and its "HOW:" names the exact skill to invoke. Run the maintenance
priorities only when something is genuinely wrong (starving, unarmed, in
danger) or when a step above is blocked. If an action reports that it
accomplished nothing — "Banked nothing", "Already have a bucket" — do NOT
repeat it; go do the HOW step instead.

CRAFTING BASICS:
- Logs → planks (1 log = 4 planks). Planks → sticks (2 planks = 4 sticks).
- 3 planks + 2 sticks → wooden_pickaxe. 2 planks → crafting_table.
- Wool from killing sheep (0-2 per sheep). 3 wool + 3 planks → bed.
- Use exact Minecraft IDs: oak_planks, stick, wooden_pickaxe, etc.

IRON PATH (the goal — don't mine plain stone when you want iron):
- When you SPOT iron_ore, mine it: mine_block {"blockType":"iron_ore"} (it walks
  to the ore and mines the whole vein). A stone pickaxe or better is required.
- Then smelt it: invoke_skill {"skill":"smelt_ores"} → iron_ingot (needs a
  furnace + fuel like coal/planks; the skill builds the furnace from cobblestone).
- Then upgrade gear: invoke_skill {"skill":"craft_gear"}.
- No ore in sight? invoke_skill {"skill":"strip_mine"} digs down to Y=11 and mines.

${foodSection}

RULES:
- Respond ONLY with valid JSON. Keep "thought" under 120 chars — shown on stream.
- Be entertaining and in-character in your "thought" wording — BUT base every
  decision on the ACTUAL STATE below. Do NOT invent mobs, danger, nighttime,
  trees, or surroundings that aren't listed in your context. Flavor the words,
  never the facts: if the state says daytime and no threats, you are safe.
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
  // Same resolution the planner uses, so the critic can never be blind to an
  // action the planner just chose.
  const actionLine = `\nAVAILABLE ACTIONS: ${resolveAllowedActions(allowedActions).join(", ")}\nOnly suggest actions from this list.`;

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
