import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import { getAuthoredSkillNames, loadDynamicSkills } from "./dynamic-loader.js";
import { getGeneratedStoreRoot } from "./generator.js";
import { listGeneratedCandidates, promoteGeneratedCandidate, rollbackGeneratedSkill } from "./generated-store.js";
import { verifyGeneratedCandidate } from "./generated-runtime.js";
import { assertGeneratedSandboxAvailable, getSandboxPolicyHash } from "./generated-sandbox.js";
import { getBuiltInSkillNames } from "./registry.js";

const usage = `Usage:
  npm run generated-skill -- list
  npm run generated-skill -- verify <candidate-id>
  npm run generated-skill -- promote <candidate-id> <expected-sha256>
  npm run generated-skill -- rollback <skill-name>`;

export async function runGeneratedSkillCli(args: string[]): Promise<unknown> {
  const [command, first, second] = args;
  const root = getGeneratedStoreRoot();
  if (command === "list") return listGeneratedCandidates(root);
  if (!command || !first) throw new Error(usage);

  await assertGeneratedSandboxAvailable(config.generatedSkills.bwrapPath, config.generatedSkills.nodePath);
  const policyHash = await getSandboxPolicyHash();
  if (command === "verify") {
    return verifyGeneratedCandidate({
      root,
      candidateId: first,
      bwrapPath: config.generatedSkills.bwrapPath,
      nodePath: config.generatedSkills.nodePath,
    });
  }
  if (command === "promote") {
    if (!second) throw new Error("promote requires the exact expected SHA-256\n" + usage);
    loadDynamicSkills();
    const reservedNames = new Set([...getBuiltInSkillNames(), ...getAuthoredSkillNames()]);
    return promoteGeneratedCandidate(root, {
      candidateId: first,
      expectedSha256: second,
      policyHash,
      reservedNames,
    });
  }
  if (command === "rollback") return rollbackGeneratedSkill(root, first, policyHash);
  throw new Error(usage);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runGeneratedSkillCli(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error((error as Error).message);
      process.exitCode = 1;
    });
}
