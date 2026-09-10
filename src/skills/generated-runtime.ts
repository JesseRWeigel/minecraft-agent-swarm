import type { Skill } from "./types.js";
import {
  listApprovedGeneratedSkills,
  readGeneratedCandidateArtifact,
  recordGeneratedVerification,
  type GeneratedVerification,
} from "./generated-store.js";
import {
  getSandboxPolicyHash,
  runGeneratedSkillInSandbox,
  type GeneratedCapabilityHandler,
  type SandboxResult,
} from "./generated-sandbox.js";
import { createGeneratedCapabilityHandler } from "./generated-capabilities.js";
import { clearGeneratedSkills, registerGeneratedSkill } from "./registry.js";

type SandboxRunner = typeof runGeneratedSkillInSandbox;

function verificationCapabilities(): GeneratedCapabilityHandler {
  return async (method, rawParams) => {
    const params = rawParams as Record<string, unknown>;
    if (method === "observe") {
      const blocks = Array.isArray(params.blocks)
        ? params.blocks.map((name) => ({ name, position: { x: 1, y: 64, z: 1 } }))
        : [];
      return {
        position: { x: 0, y: 64, z: 0 },
        health: 20,
        food: 20,
        inventory: [
          { name: "oak_log", count: 16 },
          { name: "oak_planks", count: 64 },
          { name: "apple", count: 8 },
        ],
        blocks,
        entities: [{ id: 1, name: "zombie", type: "mob", position: { x: 2, y: 64, z: 2 } }],
      };
    }
    return { ok: true };
  };
}

export async function verifyGeneratedCandidate(options: {
  root: string;
  candidateId: string;
  bwrapPath: string;
  nodePath: string;
  runner?: SandboxRunner;
}): Promise<GeneratedVerification> {
  const runner = options.runner ?? runGeneratedSkillInSandbox;
  const artifact = await readGeneratedCandidateArtifact(options.root, options.candidateId);
  let result: SandboxResult;
  try {
    result = await runner({
      name: artifact.candidate.name,
      code: artifact.code,
      capabilityHandler: verificationCapabilities(),
      bwrapPath: options.bwrapPath,
      nodePath: options.nodePath,
    });
  } catch (error) {
    const policyHash = await getSandboxPolicyHash();
    return recordGeneratedVerification(options.root, {
      candidateId: artifact.candidate.id,
      sha256: artifact.candidate.sha256,
      policyHash,
      passed: false,
      checks: [{ name: "isolated execution", passed: false, detail: (error as Error).message.slice(0, 1000) }],
    });
  }
  const checks = [
    {
      name: "exact candidate hash",
      passed: result.sha256 === artifact.candidate.sha256,
      detail:
        result.sha256 === artifact.candidate.sha256
          ? undefined
          : `worker ran ${result.sha256}, expected ${artifact.candidate.sha256}`,
    },
    {
      name: "isolated execution",
      passed: result.success,
      detail: result.success ? undefined : result.error,
    },
  ];
  return recordGeneratedVerification(options.root, {
    candidateId: artifact.candidate.id,
    sha256: artifact.candidate.sha256,
    policyHash: result.policyHash,
    passed: checks.every((check) => check.passed),
    checks,
  });
}

function generatedSkill(
  artifact: Awaited<ReturnType<typeof listApprovedGeneratedSkills>>[number],
  options: {
    policyHash: string;
    bwrapPath: string;
    nodePath: string;
    runner: SandboxRunner;
  },
): Skill {
  const code = Buffer.from(artifact.code);
  return {
    name: artifact.name,
    description: `Approved isolated generated skill: ${artifact.name}`,
    params: {},
    estimateMaterials: () => ({}),
    timeoutMs: 75_000,
    async execute(bot, _params, signal, onProgress) {
      onProgress({
        skillName: artifact.name,
        phase: "Isolated execution",
        progress: 0,
        message: `Running approved SHA-256 ${artifact.sha256.slice(0, 12)}…`,
        active: true,
      });
      try {
        const result = await options.runner({
          name: artifact.name,
          code,
          capabilityHandler: createGeneratedCapabilityHandler(bot, { signal }),
          bwrapPath: options.bwrapPath,
          nodePath: options.nodePath,
          signal,
        });
        if (result.sha256 !== artifact.sha256 || result.policyHash !== options.policyHash) {
          return { success: false, message: `${artifact.name} failed runtime hash verification.` };
        }
        if (!result.success) {
          return { success: false, message: `${artifact.name} failed: ${result.error ?? "isolated worker failed"}` };
        }
        const detail = typeof result.value === "string" ? result.value.slice(0, 300) : "completed";
        return { success: true, message: `${artifact.name} ${detail}.` };
      } catch (error) {
        return { success: false, message: `${artifact.name} isolated worker failed: ${(error as Error).message}` };
      }
    },
  };
}

export async function loadApprovedGeneratedSkills(options: {
  enabled: boolean;
  root: string;
  policyHash: string;
  bwrapPath: string;
  nodePath: string;
  runner?: SandboxRunner;
}): Promise<string[]> {
  clearGeneratedSkills();
  if (!options.enabled) return [];
  const artifacts = await listApprovedGeneratedSkills(options.root, options.policyHash);
  const runner = options.runner ?? runGeneratedSkillInSandbox;
  for (const artifact of artifacts) {
    registerGeneratedSkill(
      generatedSkill(artifact, {
        policyHash: options.policyHash,
        bwrapPath: options.bwrapPath,
        nodePath: options.nodePath,
        runner,
      }),
    );
  }
  return artifacts.map((artifact) => artifact.name);
}
