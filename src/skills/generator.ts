import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ollama } from "ollama";
import { config } from "../config.js";
import { resolveProjectRoot } from "../project-root.js";
import { getAuthoredSkillNames } from "./dynamic-loader.js";
import { getBuiltInSkillNames } from "./registry.js";
import {
  createGeneratedCandidate,
  readApprovedGeneratedSkill,
  type CandidateProvenance,
  type GeneratedCandidate,
} from "./generated-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export function getGeneratedStoreRoot(): string {
  return config.generatedSkills.storeDir || path.join(resolveProjectRoot(__dirname), "skills/generated/store");
}

const ollama = new Ollama({ host: config.ollama.host });

const GENERATION_PROMPT = `You are writing an isolated Minecraft bot skill in JavaScript.

RULES:
- Write ONE async function named exactly SKILL_NAME that takes a single api parameter
- Works with no arguments other than api. Return nothing (void). Under 60 lines.
- DO NOT use try/catch — let errors throw so the caller can detect failures
- NO markdown, NO backticks, NO explanation — ONLY the JavaScript function
- NO while(true) or any infinite loops — the skill MUST complete and return
- Never use require, import, process, fetch, WebSocket, filesystem, child processes, timers, or bot.chat
- Every operation is an awaited call on the capability object:
  api.observe({ blocks?: string[], includeEntities?: boolean, radius?: number })
  api.navigate({ x: number, y: number, z: number, radius?: number })
  api.mine({ block: string, count?: number })
  api.craft({ item: string, count?: number })
  api.equip({ item: string, destination?: 'hand'|'head'|'torso'|'legs'|'feet'|'off-hand' })
  api.consume({ item: string })
  api.place({ block: string, x: number, y: number, z: number })
  api.look({ x: number, y: number, z: number })
  api.attack({ entityId: number })
  api.wait({ ticks: number })
- observe returns plain JSON: position, health, food, inventory, blocks, and entities
- Keep operations bounded. Never issue more than 20 total calls.

TASK: TASK_DESCRIPTION

Write ONLY the JavaScript function:`;

function trustedSkillNames(): Set<string> {
  return new Set([...getBuiltInSkillNames(), ...getAuthoredSkillNames()]);
}

export async function saveGeneratedSkill(
  name: string,
  code: string,
  options: { root?: string; provenance: CandidateProvenance },
): Promise<GeneratedCandidate> {
  const candidate = await createGeneratedCandidate(options.root ?? getGeneratedStoreRoot(), {
    name,
    code,
    provenance: options.provenance,
    reservedNames: trustedSkillNames(),
  });
  console.log(`[Generator] Quarantined candidate '${name}' at SHA-256 ${candidate.sha256}`);
  return candidate;
}

export async function generateSkill(task: string): Promise<GeneratedCandidate> {
  if (!config.generatedSkills.enabled) {
    throw new Error(
      "Generated skills are disabled; set GENERATED_SKILLS_ENABLED=true to create quarantined candidates",
    );
  }
  const trimmedTask = task.trim();
  if (!trimmedTask) {
    throw new Error("Task description cannot be empty");
  }

  const skillName = trimmedTask
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim()
    .split(/\s+/)
    .map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join("")
    .slice(0, 40);

  if (!skillName) {
    throw new Error("Task description produced an empty skill name (try using letters/numbers)");
  }

  console.log(`[Generator] Writing '${skillName}' for: ${trimmedTask}`);

  const prompt = GENERATION_PROMPT.replaceAll("SKILL_NAME", skillName).replace("TASK_DESCRIPTION", trimmedTask);

  const response = await ollama.chat({
    model: config.ollama.model,
    think: false, // Disable thinking mode — all tokens go to code output
    messages: [{ role: "user", content: prompt }],
    options: { temperature: 0.3, num_predict: 4096 },
  });

  const code = response.message.content
    .trim()
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();

  if (!code.includes(`async function ${skillName}`)) {
    throw new Error(`Generator did not return the required async function '${skillName}'`);
  }

  return saveGeneratedSkill(skillName, code, {
    provenance: { kind: "generation", task: trimmedTask.slice(0, 2_000), model: config.ollama.model },
  });
}

const REFINEMENT_PROMPT = `You are fixing a buggy isolated Minecraft bot skill written in JavaScript.

THE CURRENT CODE:
\`\`\`
CURRENT_CODE
\`\`\`

IT FAILED WITH THIS ERROR:
ERROR_MESSAGE

Fix the bug. Keep the SAME function name and signature (one async function taking only \`api\`).
The only available operations are awaited calls to api.observe, api.navigate, api.mine,
api.craft, api.equip, api.consume, api.place, api.look, api.attack, and api.wait.
Never use require, import, process, fetch, WebSocket, filesystem, child processes, timers,
bot.chat, try/catch, or infinite loops. Keep the function under 60 lines.

NO markdown, NO backticks, NO explanation — output ONLY the fixed JavaScript function:`;

/** Per-session refinement attempt caps — don't burn the GPU re-fixing the same skill. */
const refinementAttempts = new Map<string, number>();
const MAX_REFINEMENTS_PER_SKILL = 2;

/**
 * Voyager-style skill refinement: feed the failing skill's source + error
 * back to the LLM and replace it with the fixed version (old code kept as
 * .bak.N). Returns true when a refined version was installed.
 */
export async function refineSkill(name: string, errorMessage: string): Promise<GeneratedCandidate | false> {
  if (!config.generatedSkills.enabled) return false;
  const attempts = refinementAttempts.get(name) ?? 0;
  if (attempts >= MAX_REFINEMENTS_PER_SKILL) return false;
  refinementAttempts.set(name, attempts + 1);

  let source: string;
  try {
    source = (await readApprovedGeneratedSkill(getGeneratedStoreRoot(), name)).code;
  } catch {
    return false;
  }

  console.log(
    `[Generator] Refining '${name}' (attempt ${attempts + 1}/${MAX_REFINEMENTS_PER_SKILL}): ${errorMessage.slice(0, 120)}`,
  );

  const prompt = REFINEMENT_PROMPT.replace("CURRENT_CODE", source).replace("ERROR_MESSAGE", errorMessage.slice(0, 500));
  const response = await ollama.chat({
    model: config.ollama.model,
    think: false,
    messages: [{ role: "user", content: prompt }],
    options: { temperature: 0.2, num_predict: 4096 },
  });

  const code = response.message.content
    .trim()
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();

  if (!code.includes(`async function ${name}`)) {
    console.warn(`[Generator] Refinement of '${name}' didn't produce a valid function — keeping original`);
    return false;
  }

  const candidate = await saveGeneratedSkill(name, code, {
    provenance: {
      kind: "refinement",
      task: errorMessage.slice(0, 500),
      model: config.ollama.model,
      sourceName: name,
    },
  });
  console.log(`[Generator] Quarantined refinement '${name}' as candidate ${candidate.id}`);
  return candidate;
}
