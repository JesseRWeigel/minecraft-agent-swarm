import type { Skill } from "./types.js";
import { buildHouseSkill } from "./build-house.js";
import { craftGearSkill } from "./craft-gear.js";
import { lightAreaSkill } from "./light-area.js";
import { buildFarmSkill } from "./build-farm.js";
import { stripMineSkill } from "./strip-mine.js";
import { smeltOresSkill } from "./smelt-ores.js";
import { goFishingSkill } from "./go-fishing.js";
import { buildBridgeSkill } from "./build-bridge.js";
import { setupStashSkill } from "./setup-stash.js";
import { craftBucketSkill } from "./craft-bucket.js";
import { fillBucketSkill } from "./fill-bucket.js";
import { setupEnchantingSkill } from "./setup-enchanting.js";
import { breedAnimalsSkill } from "./breed-animals.js";
import { huntLeatherSkill } from "./hunt-leather.js";
import { tameAnimalSkill } from "./tame-animal.js";
import { huntStringSkill } from "./hunt-string.js";
import { shootArrowSkill } from "./shoot-arrow.js";
import { ohShinySkill } from "./oh-shiny.js";
import { findFortressSkill } from "./find-fortress.js";
import { craftFlintAndSteelSkill } from "./flint-and-steel.js";
import { buildNetherPortalSkill, returnFromNetherSkill } from "./nether-portal.js";
import { tradeWithVillagerSkill } from "./trade-with-villager.js";
import { lootBastionSkill } from "./loot-bastion.js";
import { mineFrontierSkill } from "./mine-frontier.js";
import { waxCopperSkill } from "./wax-copper.js";

export const skillRegistry = new Map<string, Skill>();

function register(skill: Skill) {
  skillRegistry.set(skill.name, skill);
}

register(buildHouseSkill);
register(craftGearSkill);
register(lightAreaSkill);
register(buildFarmSkill);
register(stripMineSkill);
register(smeltOresSkill);
register(goFishingSkill);
register(buildBridgeSkill);
register(setupStashSkill);
register(craftBucketSkill);
register(fillBucketSkill);
register(setupEnchantingSkill);
register(breedAnimalsSkill);
register(huntLeatherSkill);
register(tameAnimalSkill);
register(huntStringSkill);
register(shootArrowSkill);
register(ohShinySkill);
register(findFortressSkill);
register(craftFlintAndSteelSkill);
register(buildNetherPortalSkill);
register(returnFromNetherSkill);
register(tradeWithVillagerSkill);
register(lootBastionSkill);
register(mineFrontierSkill);
register(waxCopperSkill);

// Dynamic skills are loaded lazily by calling loadDynamicSkills() from dynamic-loader.ts.
// The import is intentionally kept out of this file to avoid circular module evaluation:
// dynamic-loader.ts imports skillRegistry from this file, so registry.ts must not
// import dynamic-loader.ts at module load time (TDZ / circular ref issue with tsx/Node ESM).

/** Generate the SKILLS section for the LLM system prompt. */
export function getSkillPromptLines(): string {
  const lines: string[] = [];
  for (const skill of skillRegistry.values()) {
    const paramStr =
      Object.keys(skill.params).length > 0
        ? `params: { ${Object.entries(skill.params)
            .map(([k, v]) => `"${k}": ${v.type}`)
            .join(", ")} }`
        : "params: {}";
    lines.push(`- ${skill.name}: [SKILL] ${skill.description} ${paramStr}`);
  }
  return lines.join("\n");
}
