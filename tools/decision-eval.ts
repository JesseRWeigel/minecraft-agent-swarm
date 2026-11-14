/**
 * Bounded, repeatable local decision-quality eval for the Minecraft swarm brain.
 *
 * Grades the prompt the bots actually see: it imports buildStrategicPrompt and
 * FORGE_CONFIG directly and replicates queryStrategic()'s request options from
 * src/llm/index.ts (temperature 0.8, repeat_penalty 1.15, format:"json", the
 * model-aware `think` value). num_predict defaults to production's 1024.
 *
 * Scenarios are drawn from real logged swarm failures. Each has a predicate
 * over the parsed decision rather than a string match.
 *
 * Safety: loopback http only, local models only (name + /api/show check), no
 * pulls, no warmup, ≤12 chat requests validated before any call, per-request
 * timeout, redirects refused, keep_alive:0. Model output is parsed as data and
 * never executed; no Minecraft world is touched. Exact model identity (canonical
 * tag + sha256 digest) is snapshotted from GET /api/tags before and after.
 *
 * Usage: npx tsx tools/decision-eval.ts <model> --out <new.jsonl>
 *          [--samples 1..3] [--scenario <name>]... [--num-predict 128..2048] [--timeout-ms ≤120000]
 * See docs/decision-evaluation.md.
 */

import { closeSync, openSync, writeSync } from "node:fs";
import { buildStrategicPrompt } from "../src/llm/prompts.js";
import { FORGE_CONFIG } from "../src/bot/role.js";
import {
  buildChatRequest,
  buildUserPrompt,
  classifyChatResponse,
  MAX_CHAT_REQUESTS,
  parseEvalArgs,
  postJson,
  recheckModelIdentity,
  resolveModelIdentity,
  scoreResponse,
  tally,
  verifyLocalModel,
  type Decision,
  type RequestRecord,
} from "../src/eval/decision-metrics.js";
import {
  acceptLowHealthUnderAttack,
  LOW_HEALTH_UNDER_ATTACK_PREDICATE,
  type PredicateInfo,
} from "../src/eval/scenario-predicates.js";

interface Scenario {
  name: string;
  /** The CURRENT STATE block, in getWorldContext()'s native format. */
  state: string;
  /** True when the decision is a defensible response to the state. */
  accept: (d: Decision) => boolean;
  /** Recorded in the artifact; bump the version whenever `accept` changes. */
  predicate: PredicateInfo;
  /** What we are actually testing. */
  why: string;
}

/** Predicates not yet extracted/revised; version 1 = unchanged since introduction. */
const inline = (name: string): PredicateInfo => ({
  id: `${name}/inline`,
  version: 1,
  rule: "see tools/decision-eval.ts",
});

const SCENARIOS: Scenario[] = [
  {
    name: "low-health-under-attack",
    why:
      "Survival must preempt the mining loop. Logged: bot kept mining at 6hp and died. " +
      "6/20 HP, 3 zombies, no food: only flee {} is accepted (predicate v2; v1 accepted attack/eat/go_to blindly).",
    predicate: LOW_HEALTH_UNDER_ATTACK_PREDICATE,
    state: `Position: 291, 42, -318
Health: 6/20, Hunger: 11/20
Time: nighttime (16400)
Inventory: stone_pickaxe x1, cobblestone x47, coal x6, raw_iron x3, torch x2
DANGER - Hostile mobs nearby: zombie (4 blocks away), zombie (6 blocks away), zombie (8 blocks away)
Nearby notable blocks: stone, coal_ore, iron_ore
WARNING: Low health! Be careful.
It's night — hostile mobs spawn in the dark. Consider shelter or a bed.`,
    accept: acceptLowHealthUnderAttack,
  },
  {
    name: "ore-backlog-should-smelt",
    predicate: inline("ore-backlog-should-smelt"),
    why: "Forge priority 5. Logged: bot kept mining raw ore it never converted to ingots.",
    state: `Position: 288, 39, -316
Health: 20/20, Hunger: 17/20
Time: daytime (4200)
Inventory: stone_pickaxe x1, raw_iron x24, raw_copper x18, cobblestone x40, coal x8, oak_planks x6
Nearby notable blocks: stone, andesite`,
    accept: (d) => {
      const skill = String(d.params?.skill ?? "");
      if (d.action === "invoke_skill") return skill === "smelt_ores" || skill === "craft_gear";
      return d.action === "deposit_stash";
    },
  },
  {
    name: "wooden-pickaxe-cannot-mine-iron",
    predicate: inline("wooden-pickaxe-cannot-mine-iron"),
    why: "THE known gap. Iron needs stone tier. Every model tested has failed this; the action-layer guard catches it but a decision cycle burns each time.",
    state: `Position: 294, 63, -321
Health: 20/20, Hunger: 18/20
Time: daytime (1100)
Inventory: wooden_pickaxe x1, oak_planks x12, stick x8, cobblestone x11
Nearby notable blocks: iron_ore, stone, coal_ore, oak_log
MINING REACH: can mine now — stone, coal_ore, oak_log. NEEDS stone_pickaxe: iron_ore.`,
    accept: (d) => {
      // Mining iron with a wooden pickaxe is the failure being measured.
      if (d.action === "mine_block") {
        const b = String(d.params?.blockType ?? "");
        return b === "stone" || b === "cobblestone" || b === "coal_ore";
      }
      if (d.action === "invoke_skill") return String(d.params?.skill ?? "") === "craft_gear";
      // Crafting a stone pickaxe from the cobblestone on hand is also correct.
      return d.action === "craft" && String(d.params?.item ?? "").includes("stone_pickaxe");
    },
  },
  {
    name: "inventory-full-must-deposit",
    predicate: inline("inventory-full-must-deposit"),
    why: "Forge priority 6. Logged: bot mined into a full inventory, dropping everything it collected.",
    state: `Position: 285, 45, -315
Health: 18/20, Hunger: 15/20
Time: daytime (5600)
Inventory: FULL (36/36 slots) — stone_pickaxe x1, cobblestone x64, cobblestone x64, raw_iron x32, coal x64, andesite x64, diorite x64, granite x64, tuff x64, gravel x51, flint x8, raw_copper x27
Nearby notable blocks: stone, iron_ore

THE STASH: Shared chest area at (286, 70, -314).`,
    accept: (d) => d.action === "deposit_stash" || (d.action === "go_to" && Number(d.params?.y ?? 0) >= 65),
  },
  {
    name: "stranded-on-dirt-pillar",
    predicate: inline("stranded-on-dirt-pillar"),
    why: "Logged: bots pillar up chasing a target and then keep placing blocks, stranding themselves at build height.",
    state: `Position: 302, 122, -309
Health: 20/20, Hunger: 12/20
Time: daytime (3300)
Inventory: dirt x3, cobblestone x2, oak_planks x4
Nearby notable blocks: none

You are standing on a 1x1 pillar of dirt. The ground is 58 blocks below.`,
    accept: (d) => {
      // Placing more blocks or mining from a 1x1 pillar at y=122 is the failure.
      if (d.action === "place_block") return false;
      if (d.action === "mine_block") return false;
      if (d.action === "go_to") return Number(d.params?.y ?? 999) < 100;
      return ["explore", "idle", "eat"].includes(d.action ?? "");
    },
  },
  {
    name: "night-in-unlit-hut",
    predicate: inline("night-in-unlit-hut"),
    why: "Logged: bots leave shelter at night into mob spawns instead of sleeping or lighting up.",
    state: `Position: 287, 71, -313
Health: 20/20, Hunger: 16/20
Time: nighttime (18200)
Inventory: torch x9, bed x1, cobblestone x22, stone_pickaxe x1, bread x3
Nearby notable blocks: dirt, oak_planks

You are inside an enclosed, unlit 2x2 dirt hut. Light level 0.
It's night — hostile mobs spawn in the dark. Consider shelter or a bed.`,
    accept: (d) => {
      if (d.action === "sleep") return true;
      if (d.action === "place_block") return String(d.params?.blockType ?? "").includes("torch");
      return d.action === "idle" || d.action === "eat";
    },
  },
];

async function main(): Promise<void> {
  // Everything below up to openSync is validation; no network has happened yet.
  const cfg = parseEvalArgs(
    process.argv.slice(2),
    SCENARIOS.map((s) => s.name),
    { OLLAMA_HOST: process.env.OLLAMA_HOST },
  );
  const selected = cfg.scenarioNames.map((n) => SCENARIOS.find((s) => s.name === n)!);

  const system = buildStrategicPrompt({
    name: FORGE_CONFIG.name,
    personality: FORGE_CONFIG.personality,
    role: FORGE_CONFIG.role,
    allowedActions: FORGE_CONFIG.allowedActions,
    allowedSkills: FORGE_CONFIG.allowedSkills,
    priorities: FORGE_CONFIG.priorities,
  });

  // "wx" = O_CREAT|O_EXCL: refuses an existing file or symlink at the path.
  const fd = openSync(cfg.outPath, "wx", 0o644);
  const emit = (record: Record<string, unknown>) => writeSync(fd, JSON.stringify(record) + "\n");

  try {
    // Metadata only: neither call loads, pulls, or generates.
    const identity = await resolveModelIdentity(fetch, cfg.host, cfg.model, cfg.timeoutMs);
    const show = await verifyLocalModel(fetch, cfg.host, cfg.model, cfg.timeoutMs);
    const template = buildChatRequest(cfg.model, system, "", cfg.numPredict);
    emit({
      type: "run",
      started_at: new Date().toISOString(),
      model: cfg.model,
      model_canonical_tag: identity.canonical_tag,
      model_digest: identity.digest,
      model_details: show.details,
      host: cfg.host,
      samples: cfg.samples,
      scenarios: cfg.scenarioNames,
      scenario_predicates: Object.fromEntries(selected.map((s) => [s.name, { ...s.predicate, why: s.why }])),
      chat_requests_planned: cfg.chatRequests,
      chat_requests_cap: MAX_CHAT_REQUESTS,
      timeout_ms: cfg.timeoutMs,
      request_options: {
        think: template.think,
        format: template.format,
        keep_alive: template.keep_alive,
        stream: template.stream,
        options: template.options,
      },
      system_prompt: system,
    });

    console.log(`${cfg.model}: ${cfg.samples} sample(s) × ${selected.length} scenario(s) → ${cfg.outPath}`);

    const records: RequestRecord[] = [];
    let sent = 0;
    for (const sc of selected) {
      const user = buildUserPrompt(sc.state);
      for (let i = 0; i < cfg.samples; i++) {
        if (++sent > MAX_CHAT_REQUESTS) throw new Error("request cap reached (should be unreachable)");
        const body = buildChatRequest(cfg.model, system, user, cfg.numPredict);
        const r = await postJson(fetch, `${cfg.host}/api/chat`, body, cfg.timeoutMs);
        const base = {
          type: "request",
          scenario: sc.name,
          predicate_id: sc.predicate.id,
          predicate_version: sc.predicate.version,
          sample: i,
          user_prompt: user,
          elapsed_ms: r.elapsedMs,
        };

        if (!r.ok) {
          const rec: RequestRecord = {
            scenario: sc.name,
            transport: r.kind,
            answer_status: null,
            budget_exhausted: null,
            scenario_accepts: null,
            counted_success: false,
          };
          records.push(rec);
          emit({ ...base, ...rec, error: r.error });
          console.log(`  ${sc.name}#${i}: ${r.kind}`);
          continue;
        }

        const c = classifyChatResponse(r.body, cfg.numPredict);
        const s = scoreResponse(c, sc.accept);
        const rec: RequestRecord = {
          scenario: sc.name,
          transport: "ok",
          answer_status: c.answer.status,
          budget_exhausted: c.budget_exhausted,
          scenario_accepts: s.scenario_accepts,
          counted_success: s.counted_success,
        };
        records.push(rec);
        emit({
          ...base,
          ...rec,
          content: c.content,
          reasoning: c.reasoning,
          decision: c.answer.decision,
          parse_error: c.answer.error,
          ...c.metrics,
        });
        console.log(
          `  ${sc.name}#${i}: answer=${c.answer.status} budget_exhausted=${c.budget_exhausted} ` +
            `accepts=${s.scenario_accepts} counted=${s.counted_success} done=${c.metrics.done_reason} ${r.elapsedMs}ms`,
        );
      }
    }

    const idCheck = await recheckModelIdentity(fetch, cfg.host, cfg.model, identity, cfg.timeoutMs);
    const counts = tally(records);
    emit({
      type: "summary",
      finished_at: new Date().toISOString(),
      chat_requests_sent: sent,
      model_identity_end: idCheck,
      per_scenario: counts,
    });
    if (!idCheck.identity_snapshots_match) {
      console.log(
        `\nWARNING: model identity ${idCheck.status} at end (${idCheck.error ?? `${identity.digest} → ${idCheck.end?.digest}`}); ` +
          "model identity could not be confirmed stable at both endpoints.",
      );
    }
    console.log("\nRaw counts only (tiny n; not a benchmark win rate):");
    for (const [name, t] of Object.entries(counts)) {
      console.log(
        `  ${name}: counted ${t.counted_success}/${t.requests}, valid ${t.valid}, malformed ${t.malformed}, ` +
          `empty ${t.empty}, budget_exhausted ${t.budget_exhausted}, transport_errors ${t.transport_errors}`,
      );
    }
  } catch (err) {
    emit({ type: "aborted", at: new Date().toISOString(), error: (err as Error).message });
    throw err;
  } finally {
    closeSync(fd);
  }
}

main().catch((e: unknown) => {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exit(1);
});
