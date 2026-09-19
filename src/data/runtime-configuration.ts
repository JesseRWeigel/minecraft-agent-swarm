import { createHash } from "node:crypto";
import path from "node:path";

import {
  currentCollectionContext,
  getEpisodeEventRecorder,
  type EpisodeEvent,
  type EpisodeEventRecorder,
} from "./episode-events.js";

export interface RuntimeRoleInput {
  name: string;
  username?: string;
  role: string;
  memoryFile: string;
  personality: string;
  priorities: string;
  seasonGoal?: string;
  allowedActions: string[];
  allowedSkills: string[];
}

export interface RuntimeConfigurationInput {
  provider: "ollama" | "openai";
  strategicRequestedModel: string;
  fastRequestedModel: string;
  endpoint: string;
  multiBotEnabled: boolean;
  requestedBotCount: number;
  roster: RuntimeRoleInput[];
  builtInSkillNames: Iterable<string>;
  authoredSkillNames: Iterable<string>;
  generatedSkillNames: Iterable<string>;
  nodeVersion?: string;
}

interface EndpointIdentity {
  status: "captured" | "invalid";
  scheme?: string;
  hostname?: string;
  port?: string;
  pathSha256?: string;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalSha256(value: unknown): string {
  return sha256(JSON.stringify(canonicalValue(value)));
}

function endpointIdentity(raw: string): EndpointIdentity {
  try {
    const url = new URL(raw);
    if (!url.protocol || !url.hostname) return { status: "invalid" };
    return {
      status: "captured",
      scheme: url.protocol.replace(/:$/, "").toLowerCase(),
      hostname: url.hostname.toLowerCase(),
      port: url.port,
      pathSha256: sha256(url.pathname),
    };
  } catch {
    return { status: "invalid" };
  }
}

function effectiveRoster(input: RuntimeConfigurationInput): RuntimeRoleInput[] {
  if (!input.multiBotEnabled) return input.roster.slice(0, 1);
  if (!Number.isSafeInteger(input.requestedBotCount) || input.requestedBotCount <= 0) return [];
  return input.roster.slice(0, Math.min(input.requestedBotCount, input.roster.length));
}

function textHash(value: string | undefined): string | null {
  return value === undefined ? null : sha256(value);
}

export function buildRuntimeConfiguration(input: RuntimeConfigurationInput) {
  const orderedRoles = effectiveRoster(input).map((role) => ({
    name: role.name,
    role: role.role,
    memoryFile: path.posix.basename(role.memoryFile.replaceAll("\\", "/")),
    allowedActions: [...role.allowedActions],
    allowedSkills: [...role.allowedSkills],
    personalitySha256: sha256(role.personality),
    prioritiesSha256: sha256(role.priorities),
    seasonGoalSha256: textHash(role.seasonGoal),
  }));
  const skills = {
    builtInNames: [...input.builtInSkillNames].sort(),
    authoredNames: [...input.authoredSkillNames].sort(),
    generatedNames: [...input.generatedSkillNames].sort(),
  };
  const roleProjectionSha256 = canonicalSha256(orderedRoles);
  const inventorySha256 = canonicalSha256(skills);

  return {
    captureVersion: 1,
    stage: "runtime_configuration",
    provenanceSource: "resolved_process_configuration",
    collection: currentCollectionContext(),
    llm: {
      provider: input.provider,
      strategicRequestedModel: input.strategicRequestedModel,
      fastRequestedModel: input.fastRequestedModel,
      endpoint: endpointIdentity(input.endpoint),
      immutableModelIdentity: {
        status: "not_captured" as const,
        reason: "requires_separate_offline_model_manifest",
      },
    },
    team: {
      multiBotEnabled: input.multiBotEnabled,
      requestedCount: Number.isSafeInteger(input.requestedBotCount) ? input.requestedBotCount : null,
      effectiveCount: orderedRoles.length,
      orderedRoles,
    },
    skills: {
      ...skills,
      inventorySha256,
    },
    promptProvenance: {
      roleProjectionSha256,
      skillInventorySha256: inventorySha256,
      actualRenderedPromptEvidence: "model_request.payloadRef",
    },
    runtime: {
      nodeVersion: input.nodeVersion ?? process.version,
    },
  };
}

const recordedByRecorder = new WeakMap<EpisodeEventRecorder, EpisodeEvent>();

export function recordRuntimeConfiguration(
  input: RuntimeConfigurationInput,
  recorder: EpisodeEventRecorder = getEpisodeEventRecorder(),
): EpisodeEvent {
  const existing = recordedByRecorder.get(recorder);
  if (existing) return existing;

  const event = recorder.record(
    {
      episodeId: `${recorder.runId}:_collector`,
      botId: "_collector",
      actionId: null,
      requestId: null,
      kind: "observation",
    },
    buildRuntimeConfiguration(input),
  );
  recordedByRecorder.set(recorder, event);
  return event;
}
