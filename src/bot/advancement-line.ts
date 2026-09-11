// The curriculum, rendered for the strategic prompt.
//
// Deliberately one line and one goal. The frontier can hold a dozen reachable
// advancements; showing all of them recreates the problem the skill menu had,
// where a model given a long list picks the familiar item every time.

import { frontierOf, TOTAL_ADVANCEMENTS } from "./advancement-tree.js";
import { assignFor, feasibleNow } from "./advancement-routing.js";
import { withinReach } from "./advancement-gating.js";
import { hintFor } from "./advancement-hints.js";

/**
 * Who is currently working on what, so five bots pursue five advancements.
 *
 * Keyed by role rather than bot name because a role is what routing decides on,
 * and the roster is one bot per role. Reassigning the same role simply replaces
 * its claim, so a bot that finishes or gives up frees its goal automatically.
 */
const claims = new Map<string, string>();

/** Everything claimed by a role other than this one. */
function claimedByOthers(role: string): Set<string> {
  const out = new Set<string>();
  for (const [r, id] of claims) if (r !== role) out.add(id);
  return out;
}

export function advancementLine(role: string, earned: Set<string>): string {
  // Gate before routing, not after: a dangerous advancement should never win
  // the ranking and then be discarded, because that would leave the bot with
  // nothing while the next-best option was still available.
  const reachable = feasibleNow(frontierOf(earned), earned).filter((a) => withinReach(a.id, earned));

  const target = assignFor(role, reachable, claimedByOthers(role), claims.get(role));
  if (!target) {
    claims.delete(role);
    return "";
  }
  claims.set(role, target.id);

  const desc = target.description ? ` — ${target.description}.` : "";
  // Mojang's description says WHAT, never HOW. Without the route from goal to
  // skill, craft_bucket sat unused in Forge's menu for 3.5 hours while its
  // context read "Fill a Bucket with lava".
  const hint = hintFor(target.id);
  const how = hint ? ` HOW: ${hint}` : "";
  return `ADVANCEMENTS: ${earned.size}/${TOTAL_ADVANCEMENTS} earned. NEXT FOR YOU: "${target.title}" (${target.id})${desc}${how}`;
}

/** Test seam: forget every claim. Not used in production. */
export function resetClaims(): void {
  claims.clear();
}
