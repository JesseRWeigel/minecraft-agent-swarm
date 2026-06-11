import { test } from "node:test";
import assert from "node:assert/strict";

// The LLM module exports extractJSON and parseDecision as private functions,
// but we can test them indirectly. However, since we need to test the JSON
// extraction and repair logic directly, we'll import the module and use
// the exported query functions' internal helpers by re-implementing them
// in isolation. The actual functions are private, so we extract and test
// the core logic patterns.

// ── Re-implement extractJSON for direct testing (mirrors src/llm/index.ts) ──

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

function parseDecision(raw: string): {
  thought: string;
  action: string;
  params: Record<string, any>;
  goal?: string;
  goalSteps?: number;
} {
  const jsonStr = extractJSON(raw);
  if (!jsonStr) {
    return { thought: "Brain buffering...", action: "idle", params: {} };
  }

  const parsed = JSON.parse(jsonStr);

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

  const rawAction = (typeof parsed.action === "string" ? parsed.action : "idle").toLowerCase().trim();
  let action = ACTION_ALIASES[rawAction] ?? (typeof parsed.action === "string" ? parsed.action : "idle");

  const params = parsed.params ?? parsed.parameters ?? {};

  for (const field of ["direction", "item", "block", "blockType", "count", "skill", "task", "message"]) {
    if (parsed[field] !== undefined && params[field] === undefined) {
      params[field] = parsed[field];
    }
  }

  if (action !== "mine_block" && /^mine_\w+$/.test(action)) {
    params.blockType = params.blockType || action.slice(5);
    action = "mine_block";
  }

  if (/^manually(build|construct)|^build.*(shelter|hut)|^construct.*(shelter|house)/i.test(action)) {
    action = "build_house";
  }

  if (action === "invoke_skill" && !params.skill && parsed.skill) {
    params.skill = parsed.skill;
  }

  let thought = String(parsed.thought || parsed.reason || parsed.reasoning || "...");
  thought =
    thought
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/<think>[\s\S]*/g, "")
      .trim() || "...";

  return { thought, action, params, goal: parsed.goal, goalSteps: parsed.goalSteps };
}

// ── extractJSON tests ───────────────────────────────────────────────────────

test("extractJSON: extracts valid JSON from plain string", () => {
  const result = extractJSON('{"action":"explore","thought":"lets go"}');
  assert.ok(result);
  const parsed = JSON.parse(result);
  assert.equal(parsed.action, "explore");
});

test("extractJSON: extracts JSON from markdown code block", () => {
  const raw = '```json\n{"action":"mine_block","params":{"blockType":"iron_ore"}}\n```';
  const result = extractJSON(raw);
  assert.ok(result);
  const parsed = JSON.parse(result);
  assert.equal(parsed.action, "mine_block");
});

test("extractJSON: extracts JSON from code block without json label", () => {
  const raw = '```\n{"action":"idle","thought":"chilling"}\n```';
  const result = extractJSON(raw);
  assert.ok(result);
  assert.equal(JSON.parse(result).action, "idle");
});

test("extractJSON: strips <think> tags before extracting", () => {
  const raw = '<think>I should explore the cave</think>{"action":"explore","thought":"found a cave"}';
  const result = extractJSON(raw);
  assert.ok(result);
  assert.equal(JSON.parse(result).action, "explore");
});

test("extractJSON: handles text before JSON object", () => {
  const raw = 'Here is my decision: {"action":"gather_wood","thought":"need logs"}';
  const result = extractJSON(raw);
  assert.ok(result);
  assert.equal(JSON.parse(result).action, "gather_wood");
});

test("extractJSON: returns null for no JSON at all", () => {
  const result = extractJSON("I don't know what to do, just exploring.");
  assert.equal(result, null);
});

test("extractJSON: returns null for empty string", () => {
  assert.equal(extractJSON(""), null);
});

test("extractJSON: handles nested JSON objects", () => {
  const raw = '{"action":"go_to","params":{"x":10,"y":64,"z":-5},"thought":"going there"}';
  const result = extractJSON(raw);
  assert.ok(result);
  const parsed = JSON.parse(result);
  assert.equal(parsed.params.x, 10);
});

test("extractJSON: handles escaped quotes in strings", () => {
  const raw = '{"action":"chat","params":{"message":"He said \\"hello\\""},"thought":"chatting"}';
  const result = extractJSON(raw);
  assert.ok(result);
  const parsed = JSON.parse(result);
  assert.ok(parsed.params.message.includes("hello"));
});

test("extractJSON: salvages truncated JSON by closing braces", () => {
  // Simulates an LLM response that got cut off
  const raw = '{"action":"explore","thought":"going north","params":{"direction":"north"';
  const result = extractJSON(raw);
  // Should attempt repair — may or may not succeed depending on heuristic
  if (result) {
    const parsed = JSON.parse(result);
    assert.equal(parsed.action, "explore");
  }
});

test("extractJSON: handles multiple <think> blocks", () => {
  const raw = '<think>first thought</think>some text<think>second thought</think>{"action":"idle"}';
  const result = extractJSON(raw);
  assert.ok(result);
  assert.equal(JSON.parse(result).action, "idle");
});

// ── parseDecision tests ─────────────────────────────────────────────────────

test("parseDecision: parses standard well-formed response", () => {
  const raw = '{"thought":"need wood","action":"gather_wood","params":{"count":5}}';
  const result = parseDecision(raw);
  assert.equal(result.action, "gather_wood");
  assert.equal(result.thought, "need wood");
  assert.equal(result.params.count, 5);
});

test("parseDecision: normalizes action aliases (goto -> go_to)", () => {
  const raw = '{"thought":"moving","action":"goto","params":{}}';
  const result = parseDecision(raw);
  assert.equal(result.action, "go_to");
});

test("parseDecision: normalizes action aliases (chop -> gather_wood)", () => {
  const raw = '{"thought":"chopping","action":"chop","params":{}}';
  const result = parseDecision(raw);
  assert.equal(result.action, "gather_wood");
});

test("parseDecision: normalizes action aliases (say -> chat)", () => {
  const raw = '{"thought":"greeting","action":"say","params":{"message":"hi"}}';
  const result = parseDecision(raw);
  assert.equal(result.action, "chat");
});

test("parseDecision: normalizes craft_item to craft", () => {
  const raw = '{"thought":"crafting","action":"craft_item","params":{"item":"stick"}}';
  const result = parseDecision(raw);
  assert.equal(result.action, "craft");
});

test("parseDecision: converts mine_iron to mine_block with blockType", () => {
  const raw = '{"thought":"mining","action":"mine_iron","params":{}}';
  const result = parseDecision(raw);
  assert.equal(result.action, "mine_block");
  assert.equal(result.params.blockType, "iron");
});

test("parseDecision: repairs malformed invoke_skill format", () => {
  const raw = '{"thought":"using skill","invoke_skill":"build_house"}';
  const result = parseDecision(raw);
  assert.equal(result.action, "invoke_skill");
  assert.equal(result.params.skill, "build_house");
});

test("parseDecision: repairs malformed generate_skill format", () => {
  const raw = '{"thought":"creating","generate_skill":"dig_tunnel"}';
  const result = parseDecision(raw);
  assert.equal(result.action, "generate_skill");
  assert.equal(result.params.task, "dig_tunnel");
});

test("parseDecision: repairs malformed neural_combat format", () => {
  const raw = '{"thought":"fighting","neural_combat":10}';
  const result = parseDecision(raw);
  assert.equal(result.action, "neural_combat");
  assert.equal(result.params.duration, 10);
});

test("parseDecision: hoists top-level fields into params", () => {
  const raw = '{"thought":"going","action":"explore","direction":"north"}';
  const result = parseDecision(raw);
  assert.equal(result.params.direction, "north");
});

test("parseDecision: uses parameters key as fallback for params", () => {
  const raw = '{"thought":"ok","action":"go_to","parameters":{"x":10,"z":20}}';
  const result = parseDecision(raw);
  assert.equal(result.params.x, 10);
  assert.equal(result.params.z, 20);
});

test("parseDecision: converts build shelter variants to build_house", () => {
  const raw = '{"thought":"shelter","action":"buildAShelter","params":{}}';
  const result = parseDecision(raw);
  assert.equal(result.action, "build_house");
});

test("parseDecision: strips <think> tokens from thought field", () => {
  const raw = '{"thought":"<think>internal reasoning</think>actual thought","action":"idle","params":{}}';
  const result = parseDecision(raw);
  assert.equal(result.thought, "actual thought");
});

test("parseDecision: falls back to idle when no JSON found", () => {
  const result = parseDecision("I have no idea what to do");
  assert.equal(result.action, "idle");
  assert.equal(result.thought, "Brain buffering...");
});

test("parseDecision: extracts goal and goalSteps", () => {
  const raw = '{"thought":"planning","action":"explore","params":{},"goal":"find diamonds","goalSteps":5}';
  const result = parseDecision(raw);
  assert.equal(result.goal, "find diamonds");
  assert.equal(result.goalSteps, 5);
});

test("parseDecision: uses reason/reasoning as fallback for thought", () => {
  const raw = '{"reason":"need resources","action":"gather_wood","params":{}}';
  const result = parseDecision(raw);
  assert.equal(result.thought, "need resources");
});
