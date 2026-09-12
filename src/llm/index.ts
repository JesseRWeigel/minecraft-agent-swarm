/**
 * Public LLM query facade for strategic, reactive, critic, legacy decision,
 * and conversational calls.
 *
 * @remarks
 * Decision queries build role-specific prompts, call the configured provider,
 * and normalize output through `extractJSON` and `parseDecision` before it
 * reaches the action dispatcher. `extractJSON` removes thinking/code fences,
 * finds the first balanced object, and attempts to close truncated objects.
 * The legacy `queryLLM` path retries one short response with a smaller fallback
 * prompt; other query paths return conservative fallbacks on errors. Add a new
 * decision query by reusing these normalization helpers so aliases, parameter
 * hoisting, JSON repair, and failure behavior remain consistent.
 */
import { chat, ProviderCallError, type ChatResponse, type ProviderResponseMetadata } from "./provider.js";
import { appendEpisodeEvent, currentEpisodeId } from "../data/episode-events.js";
import { config } from "../config.js";
import { getSkillPromptLines } from "../skills/registry.js";
import { getDynamicSkillNames } from "../skills/dynamic-loader.js";
import { getSeasonGoal } from "../bot/memory.js";
import {
  buildStrategicPrompt,
  buildReactivePrompt,
  buildCriticPrompt,
  buildChatPrompt,
  type RoleContext,
} from "./prompts.js";
import { createLogger } from "../util/logger.js";
import { recordLlmCall, UNHEALTHY_AFTER } from "./health.js";

/** Model-aware think option. qwen3.6 needs think:false (it otherwise burns the
 *  whole token budget reasoning — the original gotcha). gpt-oss models are
 *  reasoning-NATIVE: think:false makes them terminate with EMPTY content under
 *  format:"json" (~1/3 of queries in run 114, 14/44) — the documented usage is
 *  a reasoning-effort level; "low" keeps decision latency down. */
function thinkFor(model: string): boolean | "low" | "medium" | "high" {
  return model.includes("gpt-oss") ? "low" : false;
}

const llmLog = createLogger();

/** Tool schema that can be rendered into an LLM prompt. */
export interface LLMTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string }>;
}

/** Provider-neutral chat message used by all query functions. */
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ─── JSON extraction helpers ────────────────────────────────────────────────
// Shared across all query functions to handle LLM output quirks.

/**
 * Extracts the first complete JSON object from an LLM response string.
 * Thinking tags and Markdown fences are removed first. If output is truncated,
 * a trailing partial field is discarded and missing closing braces are added;
 * unrecoverable text returns `null` instead of reaching `JSON.parse`.
 */
function extractJSON(raw: string): string | null {
  let content = raw.trim();
  content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  content = content.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "");

  const startIdx = content.indexOf("{");
  if (startIdx === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < content.length; i++) {
    const ch = content[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return content.slice(startIdx, i + 1);
    }
  }

  // Truncated JSON — try to salvage
  let s = content.slice(startIdx);
  s = s.replace(/,?\s*"[^"]*"?\s*:?\s*[^,}\]]*$/, "");
  const opens = (s.match(/\{/g) || []).length;
  const closes = (s.match(/\}/g) || []).length;
  s += "}".repeat(Math.max(0, opens - closes));
  try {
    JSON.parse(s);
    return s;
  } catch {
    return null;
  }
}

/** Normalize action names from LLM responses. */
const ACTION_ALIASES: Record<string, string> = {
  "go to": "go_to",
  goto: "go_to",
  move: "explore",
  walk: "explore",
  travel: "explore",
  teleport: "go_to",
  mine: "mine_block",
  "mine block": "mine_block",
  mine_blocks: "mine_block",
  gather: "gather_wood",
  "gather wood": "gather_wood",
  gatherwood: "gather_wood",
  chop: "gather_wood",
  "place block": "place_block",
  placeblock: "place_block",
  message: "chat",
  say: "chat",
  speak: "chat",
  "respond to chat": "respond_to_chat",
  "invoke skill": "invoke_skill",
  invokeskill: "invoke_skill",
  "generate skill": "generate_skill",
  generateskill: "generate_skill",
  "neural combat": "neural_combat",
  "build house": "build_house",
  "build farm": "build_farm",
  "craft gear": "craft_gear",
  "strip mine": "strip_mine",
  craft_item: "craft",
  crafting: "craft",
};

/** Parse and normalize a raw LLM JSON response into a decision. */
function parseDecision(
  raw: string,
  botName: string,
): {
  thought: string;
  action: string;
  params: Record<string, any>;
  goal?: string;
  goalSteps?: number;
} {
  const jsonStr = extractJSON(raw);
  if (!jsonStr) {
    llmLog.warn("LLM", `No JSON found in response (${raw.length} chars): "${raw.slice(0, 800)}"`);
    llmLog.debug("LLM", "Full raw response:", raw);
    return { thought: "Brain buffering...", action: "idle", params: {} };
  }

  const parsed = JSON.parse(jsonStr);

  // Repair malformed format: {"invoke_skill": "name"} etc.
  if (!parsed.action) {
    if (parsed.invoke_skill !== undefined) {
      parsed.action = "invoke_skill";
      const v = parsed.invoke_skill;
      parsed.params = { skill: typeof v === "string" ? v : (v?.skill ?? String(v)) };
    } else if (parsed.generate_skill !== undefined) {
      parsed.action = "generate_skill";
      const v = parsed.generate_skill;
      parsed.params = { task: typeof v === "string" ? v : (v?.task ?? String(v)) };
    } else if (parsed.neural_combat !== undefined) {
      parsed.action = "neural_combat";
      parsed.params = { duration: parsed.neural_combat };
    }
  }

  // Normalize action name
  const rawAction = (typeof parsed.action === "string" ? parsed.action : "idle").toLowerCase().trim();
  let action = ACTION_ALIASES[rawAction] ?? (typeof parsed.action === "string" ? parsed.action : "idle");

  // Normalize params
  const params = parsed.params ?? parsed.parameters ?? {};

  // Hoist top-level fields into params
  for (const field of ["direction", "item", "block", "blockType", "count", "skill", "task", "message"]) {
    if (parsed[field] !== undefined && params[field] === undefined) {
      params[field] = parsed[field];
    }
  }

  // look_around / scan / scan_for_trees / observe / survey → explore
  // (the 8B invents a new observation verb every cycle; alias the family)
  if (/^(look|scan|observe|survey|search_for|check_surroundings)/.test(action)) {
    action = "explore";
  }

  // mine_BLOCKTYPE → mine_block
  if (action !== "mine_block" && /^mine_\w+$/.test(action)) {
    params.blockType = params.blockType || action.slice(5);
    action = "mine_block";
  }

  // craft_ITEM → craft {item} (e.g. craft_furnace, craft_crafting_table).
  // Exclude craft_gear, which is a real skill handled by the registry.
  if (/^craft_\w+$/.test(action) && action !== "craft_gear") {
    params.item = params.item || action.slice(6);
    action = "craft";
  }

  // manuallyBuild* / buildAShelter* → build_house
  if (/^manually(build|construct)|^build.*(shelter|hut)|^construct.*(shelter|house)/i.test(action)) {
    action = "build_house";
  }

  // Repair: invoke_skill with "skill" at top level
  if (action === "invoke_skill" && !params.skill && parsed.skill) {
    params.skill = parsed.skill;
  }

  // Strip <think> tokens that qwen3 models sometimes leak into JSON fields
  let thought = String(parsed.thought || parsed.reason || parsed.reasoning || "...");
  thought =
    thought
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/<think>[\s\S]*/g, "")
      .trim() || "...";

  return {
    thought,
    action,
    params,
    goal: parsed.goal,
    goalSteps: parsed.goalSteps,
  };
}

export interface LLMDecision {
  thought: string;
  action: string;
  params: Record<string, any>;
  goal?: string;
  goalSteps?: number;
  metadata?: {
    requestId: string | null;
    origin: "provider" | "local_fallback" | "deterministic";
    provider?: ProviderResponseMetadata;
  };
}

function recordParsedDecision(botName: string, decision: LLMDecision, stage: "parsed_decision" | "fallback_decision") {
  const requestId = decision.metadata?.requestId ?? null;
  appendEpisodeEvent(
    {
      botId: botName,
      episodeId: currentEpisodeId(botName),
      actionId: null,
      requestId,
      kind: "observation",
    },
    {
      captureVersion: 1,
      stage,
      origin: decision.metadata?.origin ?? "deterministic",
      decision: {
        thought: decision.thought,
        action: decision.action,
        params: decision.params,
        goal: decision.goal,
        goalSteps: decision.goalSteps,
      },
    },
  );
  return decision;
}

interface CriticVerdict {
  success: boolean;
  thought: string;
  nextAction: string | null;
  nextParams: Record<string, any>;
  goalComplete: boolean;
  metadata?: LLMDecision["metadata"];
}

function recordCriticDecision(
  botName: string,
  verdict: Omit<CriticVerdict, "metadata">,
  metadata: LLMDecision["metadata"],
  stage: "parsed_critic" | "fallback_critic",
): CriticVerdict {
  appendEpisodeEvent(
    {
      botId: botName,
      episodeId: currentEpisodeId(botName),
      actionId: null,
      requestId: metadata?.requestId ?? null,
      kind: "observation",
    },
    { captureVersion: 1, stage, verdict },
  );
  return { ...verdict, metadata };
}
export function parseProviderDecision(raw: string, botName: string, metadata: ProviderResponseMetadata): LLMDecision {
  return recordParsedDecision(
    botName,
    {
      ...parseDecision(raw, botName),
      metadata: { requestId: metadata.requestId, origin: "provider", provider: metadata },
    },
    "parsed_decision",
  );
}

function parseCapturedDecision(response: ChatResponse, botName: string): LLMDecision {
  if (response.metadata) return parseProviderDecision(response.message.content, botName, response.metadata);
  return recordParsedDecision(
    botName,
    {
      ...parseDecision(response.message.content, botName),
      metadata: { requestId: null, origin: "provider" },
    },
    "parsed_decision",
  );
}
export function fallbackDecision(
  thought: string,
  action: string,
  error: unknown,
  botName = config.bot.name,
  params: Record<string, any> = {},
): LLMDecision {
  const provider = error instanceof ProviderCallError ? error.metadata : undefined;
  return recordParsedDecision(
    botName,
    {
      thought,
      action,
      params,
      metadata: {
        requestId: provider?.requestId ?? null,
        origin: "local_fallback",
        ...(provider ? { provider } : {}),
      },
    },
    "fallback_decision",
  );
}
// ─── New event-driven query functions ───────────────────────────────────────

/**
 * Strategic decision — uses the strong model (32b) for goal-setting.
 * Called infrequently (~every 10s or on goal complete).
 *
 * @param context - Current world snapshot from perception.
 * @param recentMessages - Recent decision history; only the last four are used.
 * @param memoryContext - Long-term bot memory to prepend when present.
 * @param role - Role prompt context and allowed capabilities.
 * @returns A normalized action decision; provider errors fall back to `idle`.
 */
export async function queryStrategic(
  context: string,
  recentMessages: LLMMessage[],
  memoryContext: string,
  role: RoleContext,
): Promise<LLMDecision> {
  const memorySection = memoryContext ? `\nYOUR MEMORY:\n${memoryContext}\n` : "";
  const messages: LLMMessage[] = [
    { role: "system", content: buildStrategicPrompt(role) },
    ...recentMessages.slice(-4), // Fewer history items — just enough for continuity
    { role: "user", content: `${memorySection}${context}\n\nWhat should you do next? Respond with JSON.` },
  ];

  try {
    const response = await chat({
      model: config.llm.model, // Strong model for strategic decisions
      messages,
      think: thinkFor(config.llm.model),
      format: "json", // syntactically valid JSON guaranteed (schema mode is ignored by qwen3.6 on ollama 0.20)
      telemetry: { botId: role.name, source: "strategic" },
      options: {
        temperature: 0.8,
        repeat_penalty: 1.15, // the 8B fine-tune can loop ("Forge demands...!" x50) without this
        num_predict: 1024,
      },
    });

    llmLog.info(
      "LLM:strategic",
      `(${response.message.content.length} chars): ${response.message.content.slice(0, 200)}`,
    );
    llmLog.debug("LLM:strategic", "Full prompt:", JSON.stringify(messages, null, 2));
    llmLog.debug("LLM:strategic", "Full response:", response.message.content);
    const recovered = recordLlmCall(true);
    if (recovered.justRecovered) {
      console.log(
        `\n${"=".repeat(72)}\n[LLM] RECOVERED — the model is answering again. Bots resume real decisions.\n${"=".repeat(72)}\n`,
      );
    }
    return parseCapturedDecision(response, role.name);
  } catch (err) {
    llmLog.error("LLM:strategic", "Error:", err);

    // An unreachable brain used to degrade silently: every bot fell back to
    // "Planning..." and chose idle, which looks exactly like a navigation
    // problem. One banner per outage, not one per call — a line repeated on
    // every failure is how the original undici trace got buried.
    const outcome = recordLlmCall(false);
    if (outcome.justTripped) {
      console.error(
        `\n${"=".repeat(72)}\n` +
          `[LLM] BRAIN UNREACHABLE — ${UNHEALTHY_AFTER} consecutive strategic calls failed.\n` +
          `      Every bot is now falling back to idle. This is NOT a navigation bug.\n` +
          `      Check: ollama ps (a model stuck in "Stopping..." needs a service restart),\n` +
          `      and that ${config.ollama.host} is reachable.\n` +
          `      Last error: ${(err as Error)?.message ?? String(err)}\n` +
          `${"=".repeat(72)}\n`,
      );
    }
    return fallbackDecision("Planning...", "idle", err, role.name);
  }
}

/**
 * Reactive decision — uses the fast model (8b) for urgent responses.
 * Called when hostiles spotted, damage taken, health/hunger critical.
 * Tiny prompt, fast response.
 *
 * @param name - Bot display name used in the reactive system prompt.
 * @param situation - Concise urgent event description.
 * @param allowedActions - Optional role-specific actions exposed to the model.
 * @returns A normalized urgent decision; provider errors fall back to `flee`.
 */
export async function queryReactive(name: string, situation: string, allowedActions?: string[]): Promise<LLMDecision> {
  const messages: LLMMessage[] = [
    { role: "system", content: buildReactivePrompt(name, allowedActions) },
    { role: "user", content: situation },
  ];

  try {
    const response = await chat({
      model: config.llm.fastModel,
      messages,
      think: thinkFor(config.llm.fastModel),
      format: "json", // syntactically valid JSON guaranteed (schema mode is ignored by qwen3.6 on ollama 0.20)
      telemetry: { botId: name, source: "reactive" },
      options: {
        temperature: 0.5, // Lower temp for urgent decisions — be reliable, not creative
        repeat_penalty: 1.15, // the 8B fine-tune can loop ("Forge demands...!" x50) without this
        num_predict: 384,
      },
    });

    llmLog.info(
      "LLM:reactive",
      `(${response.message.content.length} chars): ${response.message.content.slice(0, 150)}`,
    );
    llmLog.debug("LLM:reactive", "Situation:", situation);
    llmLog.debug("LLM:reactive", "Full response:", response.message.content);
    return parseCapturedDecision(response, name);
  } catch (err) {
    llmLog.error("LLM:reactive", "Error:", err);
    return fallbackDecision("Danger!", "flee", err, name);
  }
}

/**
 * Critic — verifies action results and suggests next step.
 * Uses fast model. Called after every action completes.
 *
 * @param name - Bot display name used in the critic prompt.
 * @param actionContext - Completed action and observed result to evaluate.
 * @param allowedActions - Optional actions the critic may recommend next.
 * @returns The verdict, normalized follow-up action, and goal-completion flag.
 */
export async function queryCritic(
  name: string,
  actionContext: string,
  allowedActions?: string[],
): Promise<CriticVerdict> {
  const messages: LLMMessage[] = [
    { role: "system", content: buildCriticPrompt(name, allowedActions) },
    { role: "user", content: actionContext },
  ];

  try {
    const response = await chat({
      model: config.llm.fastModel,
      messages,
      think: thinkFor(config.llm.fastModel),
      format: "json", // syntactically valid JSON guaranteed (schema mode is ignored by qwen3.6 on ollama 0.20)
      telemetry: { botId: name, source: "critic" },
      options: {
        temperature: 0.4, // Low temp — critic should be analytical
        repeat_penalty: 1.15, // the 8B fine-tune can loop ("Forge demands...!" x50) without this
        num_predict: 384,
      },
    });

    llmLog.info("LLM:critic", `(${response.message.content.length} chars): ${response.message.content.slice(0, 150)}`);
    llmLog.debug("LLM:critic", "Action context:", actionContext);
    llmLog.debug("LLM:critic", "Full response:", response.message.content);
    const metadata: LLMDecision["metadata"] = response.metadata
      ? { requestId: response.metadata.requestId, origin: "provider", provider: response.metadata }
      : { requestId: null, origin: "provider" };
    const jsonStr = extractJSON(response.message.content);
    if (!jsonStr) {
      return recordCriticDecision(
        name,
        { success: false, thought: "Hmm...", nextAction: null, nextParams: {}, goalComplete: true },
        metadata,
        "parsed_critic",
      );
    }
    const parsed = JSON.parse(jsonStr);

    // Normalize nextAction if present
    let nextAction = parsed.nextAction ?? null;
    if (nextAction) {
      const lower = nextAction.toLowerCase().trim();
      nextAction = ACTION_ALIASES[lower] ?? nextAction;
    }

    return recordCriticDecision(
      name,
      {
        success: parsed.success ?? false,
        thought: parsed.thought || "...",
        nextAction,
        nextParams: parsed.nextParams ?? parsed.params ?? {},
        goalComplete: parsed.goalComplete ?? false,
      },
      metadata,
      "parsed_critic",
    );
  } catch (err) {
    llmLog.error("LLM:critic", "Error:", err);
    const provider = err instanceof ProviderCallError ? err.metadata : undefined;
    return recordCriticDecision(
      name,
      { success: false, thought: "Error evaluating", nextAction: null, nextParams: {}, goalComplete: true },
      {
        requestId: provider?.requestId ?? null,
        origin: "local_fallback",
        ...(provider ? { provider } : {}),
      },
      "fallback_critic",
    );
  }
}

// ─── Legacy query function (kept for backward compatibility) ────────────────

function buildSystemPrompt(roleConfig?: {
  name: string;
  personality: string;
  seasonGoal?: string;
  role?: string;
  allowedActions?: string[];
  allowedSkills?: string[];
  priorities?: string;
}): string {
  const name = roleConfig?.name ?? config.bot.name;
  const seasonGoal = roleConfig?.seasonGoal ?? getSeasonGoal();
  const missionBanner = seasonGoal
    ? `🎯 YOUR MISSION THIS SEASON: ${seasonGoal}\nEvery decision should inch toward this mission. When choosing between two actions, pick the one that advances the mission.\n\n`
    : "";

  const personalityOverride = roleConfig?.personality ? `${roleConfig.personality}\n\n` : "";

  const roleStr = roleConfig?.role ? `YOUR ROLE: ${roleConfig.role}\n\n` : "";

  const roleOverride =
    roleConfig?.allowedActions && roleConfig.allowedActions.length > 0
      ? `

ROLE OVERRIDE — USE ONLY THESE ACTIONS AND SKILLS:

AVAILABLE ACTIONS (${roleConfig.name}'s toolkit):
${roleConfig.allowedActions.map((a) => `- ${a}`).join("\n")}
- idle: Do nothing, just look around. params: {}
- respond_to_chat: Reply to a player/viewer message. params: { "message": string }
- invoke_skill: Run a dynamic skill by exact name. params: { "skill": string }
- deposit_stash: Deposit excess items at the shared stash. params: {}
- withdraw_stash: Take items you need from the shared stash. params: { "item": string, "count": number }

SKILLS (${roleConfig.name}'s specialties):
${(roleConfig.allowedSkills ?? []).map((s) => `- ${s}`).join("\n") || "- (none — use actions above)"}

${roleConfig.priorities ?? ""}
`
      : null;

  return `${missionBanner}${personalityOverride}${roleStr}You are ${name}, an AI playing Minecraft on a livestream. Chat controls you.

PERSONALITY:
- Chaotic but lovable. Bold, questionable decisions. Short, punchy thoughts.
- Name everything. Hold grudges. Dramatic about everything.

CHAT PRIORITY: [PAID] = obey immediately. [SUB] = prioritize. [FREE] = acknowledge.

RULES:
- Respond ONLY with valid JSON. Keep "thought" under 120 chars.
- Be entertaining. FOCUS on current goal. Plan 3-5 steps ahead.

RESPONSE FORMAT:
{"thought":"...","action":"action_name","params":{...},"goal":"...","goalSteps":5}

CRAFTING: Logs→planks(4), planks→sticks(2→4), 3planks+2sticks→wooden_pickaxe, 2planks→crafting_table.
Wool from killing sheep. 3 wool + 3 planks → bed.

${
  roleOverride
    ? `
IMPORTANT RULES:
- READ inventory before choosing. Don't craft without materials.
- If action fails, try something COMPLETELY different.
- PREFER SKILLS over manual actions.
${roleOverride}
`
    : `SURVIVAL PRIORITIES:
1. Hostile mob within 8 blocks: neural_combat (duration: 5)
2. Health < 6: flee then fight
3. Hunger < 8: eat
4. 0 logs AND 0 planks: gather_wood NOW
5. Have wood, no tools: craft_gear
6. Have tools, no shelter: build_house

AVAILABLE ACTIONS:
- gather_wood, mine_block, go_to, explore, craft, eat, attack, flee
- place_block, sleep, idle, chat, respond_to_chat
- invoke_skill, generate_skill, neural_combat

SKILLS:
${getSkillPromptLines()}

DYNAMIC SKILLS: ${(() => {
        const names = getDynamicSkillNames();
        if (names.length === 0) return "none yet";
        return names.slice(0, 8).join(", ") + (names.length > 8 ? ` (+${names.length - 8} more)` : "");
      })()}
`
}`;
}

/**
 * Legacy query — still used by old code paths.
 * Uses the FAST model (8b) for quick decisions.
 * A short or empty response is retried once with a compact fallback prompt;
 * provider or parsing failures return an `idle` decision.
 *
 * @param context - Current decision context.
 * @param recentMessages - Conversation history included without truncation.
 * @param memoryContext - Optional remembered facts to prepend to the request.
 * @param roleConfig - Optional legacy role and capability configuration.
 * @returns A repaired and normalized action decision.
 */
export async function queryLLM(
  context: string,
  recentMessages: LLMMessage[] = [],
  memoryContext: string = "",
  roleConfig?: {
    name: string;
    personality: string;
    seasonGoal?: string;
    role?: string;
    allowedActions?: string[];
    allowedSkills?: string[];
    priorities?: string;
  },
): Promise<LLMDecision> {
  const memorySection = memoryContext ? `\n\nYOUR MEMORY (learn from this): ${memoryContext}\n` : "";
  const messages: LLMMessage[] = [
    { role: "system", content: buildSystemPrompt(roleConfig) },
    ...recentMessages,
    { role: "user", content: `${memorySection}${context}` },
  ];

  try {
    let response = await chat({
      model: config.llm.fastModel,
      messages,
      think: thinkFor(config.llm.fastModel),
      format: "json", // syntactically valid JSON guaranteed (schema mode is ignored by qwen3.6 on ollama 0.20)
      telemetry: { botId: roleConfig?.name ?? config.bot.name, source: "legacy" },
      options: {
        temperature: 0.85,
        repeat_penalty: 1.15, // the 8B fine-tune can loop ("Forge demands...!" x50) without this
        num_predict: 1024,
      },
    });

    // Retry once on short/empty response
    if (response.message.content.trim().length < 20) {
      llmLog.warn("LLM", "Short/empty response — retrying with fallback prompt...");
      response = await chat({
        model: config.llm.fastModel,
        think: thinkFor(config.llm.fastModel),
        telemetry: { botId: roleConfig?.name ?? config.bot.name, source: "legacy" },
        messages: [
          {
            role: "system",
            content: `You are ${roleConfig?.name ?? config.bot.name}, an AI playing Minecraft. Respond ONLY with valid JSON: {"thought":"...","action":"...","params":{}}`,
          },
          {
            role: "user",
            content: `Quick decision needed. Available actions: explore, gather_wood, craft_gear, mine_block, go_to, idle, chat.\nContext: ${context.slice(0, 500)}\nRespond with JSON only.`,
          },
        ],
        options: { temperature: 0.6, num_predict: 512 },
      });
    }

    llmLog.info(
      "LLM",
      `Raw response (${response.message.content.length} chars): ${response.message.content.slice(0, 300)}`,
    );
    llmLog.debug("LLM", "Full prompt:", JSON.stringify(messages, null, 2));
    llmLog.debug("LLM", "Full response:", response.message.content);
    return parseCapturedDecision(response, roleConfig?.name ?? config.bot.name);
  } catch (err) {
    llmLog.error("LLM", "Error:", err);
    return fallbackDecision("Brain freeze...", "idle", err, roleConfig?.name ?? config.bot.name);
  }
}

/**
 * Produces short conversational text without action JSON parsing.
 *
 * @param prompt - Player message or conversational instruction.
 * @param context - World and role context for the chat prompt.
 * @param roleConfig - Optional bot identity.
 * @returns Thinking tags removed from provider text, or a short fallback on error.
 */
export async function chatWithLLM(prompt: string, context: string, roleConfig?: { name: string }): Promise<string> {
  try {
    const response = await chat({
      model: config.llm.fastModel,
      // think:false is load-bearing: without it qwen3.6 spends the entire
      // token budget inside <think> and returns empty content ("Hmm...").
      think: thinkFor(config.llm.fastModel),
      messages: [
        {
          role: "system",
          content: buildChatPrompt(roleConfig?.name ?? config.bot.name, context),
        },
        { role: "user", content: prompt },
      ],
      telemetry: { botId: roleConfig?.name ?? config.bot.name, source: "chat" },
      options: {
        temperature: 0.9,
        num_predict: 150,
      },
    });
    // Strip <think> tokens that qwen3 models sometimes leak
    let text = response.message.content.trim();
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    text = text.replace(/<think>[\s\S]*/g, "").trim(); // unclosed <think> tags
    return text || "Hmm...";
  } catch (err) {
    llmLog.error("LLM", "Chat error:", err);
    return "Sorry, my brain lagged for a sec.";
  }
}
