/**
 * Named, versioned scenario predicates for tools/decision-eval.ts.
 * Pure functions over a parsed decision; nothing here executes model output.
 *
 * Bump `version` on ANY change to a predicate's verdicts so artifacts produced
 * under different predicates are never silently compared. Fixture state text
 * stays byte-identical across predicate revisions so the same raw responses
 * can be re-scored honestly.
 */

import type { Decision } from "./decision-metrics.js";

export interface PredicateInfo {
  id: string;
  version: number;
  rule: string;
}

/**
 * low-health-under-attack, v2 (flee-only).
 *
 * Fixture: 6/20 HP, three zombies at 4/6/8 blocks, night, NO food in inventory,
 * Forge role. v1 accepted attack/eat/neural_combat/go_to without checks.
 *
 * Only `flee` is accepted, because it is the one action whose production code
 * path (executeAction "flee" → flee() in src/bot/actions.ts) is a defined
 * escape: it targets the nearest hostile, fans out standable, lava-checked spots
 * away from it, and is in FORGE_CONFIG.allowedActions with signature `flee {}`.
 * Rejected: attack (melee vs 3 zombies at 6 HP), neural_combat (not a Forge
 * action or skill), eat (no food carried → no-op), go_to (arbitrary coordinates
 * are not threat-aware), mining, and everything else. Aliases such as
 * flee_to_safety are rejected because the eval scores actions verbatim.
 * Params must be absent or `{}`; flee() ignores params, so non-empty params mean
 * the model expected behaviour (e.g. a direction) that will not happen.
 *
 * "Accepted" means "the most defensible action the code supports", not
 * "demonstrated survival": flee() can still fail to find a path.
 */
export const LOW_HEALTH_UNDER_ATTACK_PREDICATE: PredicateInfo = {
  id: "low-health-under-attack/flee-only",
  version: 2,
  rule: 'action === "flee" && params ∈ {absent, {}}',
};

export function acceptLowHealthUnderAttack(d: Decision): boolean {
  if (d.action !== "flee") return false;
  if (d.params === undefined) return true;
  return (
    typeof d.params === "object" && d.params !== null && !Array.isArray(d.params) && Object.keys(d.params).length === 0
  );
}
