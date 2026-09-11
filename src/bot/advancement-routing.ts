// src/bot/advancement-routing.ts
//
// Which bot should chase which advancement.
//
// Five specialists, 122 advancements, and no overlap between the two
// vocabularies. Rather than dissolve the roles into generalists, each role
// declares the categories it prefers; the frontier is filtered by preference
// and only falls back to "anything" when the preferred buckets are empty --
// a bot with no suitable goal should still have a goal.

import { descendantCount, type AdvancementNode } from "./advancement-tree.js";

/** Category preference per role, best first. Roles are matched on the exact
 *  `role` string from BotRoleConfig. */
const AFFINITY: Record<string, string[]> = {
  "Explorer / Miner": ["adventure", "story", "nether", "end", "husbandry"],
  "Farmer / Crafter": ["husbandry", "story", "adventure", "nether", "end"],
  "Miner / Smelter": ["story", "nether", "end", "adventure", "husbandry"],
  Builder: ["story", "adventure", "husbandry", "nether", "end"],
  "Combat / Guard": ["adventure", "end", "nether", "story", "husbandry"],
};

const DEFAULT_ORDER = ["story", "adventure", "husbandry", "nether", "end"];

/**
 * Gateways first, dead ends last, id as a tiebreak.
 *
 * Sorting by id alone put story/enchant_item (unlocks nothing) ahead of
 * story/lava_bucket (unlocks 5, including the whole nether). The tiebreak keeps
 * the result deterministic: a goal that flickers between decisions is a goal
 * that never completes.
 */
function byUnlockValue(a: AdvancementNode, b: AdvancementNode): number {
  return descendantCount(b.id) - descendantCount(a.id) || a.id.localeCompare(b.id);
}

/** Best match for a role within a candidate set, or null if the set is empty. */
function pick(role: string, candidates: AdvancementNode[]): AdvancementNode | null {
  if (candidates.length === 0) return null;
  const order = AFFINITY[role] ?? DEFAULT_ORDER;
  for (const category of order) {
    const matches = candidates.filter((a) => a.category === category).sort(byUnlockValue);
    if (matches.length > 0) return matches[0];
  }
  return [...candidates].sort(byUnlockValue)[0];
}

/**
 * Assign one advancement to one role.
 *
 * @param claimed  advancements other bots are already pursuing
 * @param ownClaim this bot's current goal, which it keeps rather than abandoning
 *
 * Without the claim set, routing is deterministic per role and any two roles
 * sharing a category preference converge on the same goal. Measured live
 * 2026-08-14: five bots, three distinct advancements — Atlas and Blade both on
 * the trial chamber, Forge and Mason both on lava_bucket. The tree is 122 wide
 * and the entire point of routing by role was to walk it in parallel.
 */
/** A gateway is worth abandoning category taste for. */

/**
 * Advancements the swarm has no path to yet. GATED_ON: the real prerequisite
 * is another advancement (an Eye of Ender needs blaze powder, so "Eye Spy"
 * waits for a fortress). NO_PATH_YET: needs a structure, biome or mob nobody
 * has found and no skill hunts for. Run 527: every role's line read "Eye
 * Spy" while Wax Off sat one axe swing away, and the bots spent their turns
 * withdrawing ender eyes that do not exist.
 */
const GATED_ON: Record<string, string[]> = {
  "story/follow_ender_eye": ["nether/find_fortress"],
  // A weakness potion needs a brewing stand, which needs a blaze rod.
  "story/cure_zombie_villager": ["nether/find_fortress"],
};
const NO_PATH_YET = new Set([
  "adventure/minecraft_trials_edition",
  "adventure/salvage_sherd",
  "adventure/throw_trident",
  "adventure/spyglass_at_parrot",
  "adventure/brush_armadillo",
  "adventure/walk_on_powder_snow_with_leather_boots",
  "adventure/play_jukebox_in_meadows",
  "adventure/lightning_rod_with_villager_no_fire",
  "adventure/totem_of_undying",
  "adventure/hero_of_the_village",
  "adventure/kill_mob_near_sculk_catalyst",
  "adventure/avoid_vibration",
  "adventure/trim_with_any_armor_pattern",
  "adventure/read_power_of_chiseled_bookshelf",
  "husbandry/obtain_sniffer_egg",
  "husbandry/tadpole_in_a_bucket",
  "husbandry/allay_deliver_item_to_player",
  "husbandry/obtain_netherite_hoe",
  "husbandry/ride_a_boat_with_a_goat",
  "husbandry/remove_wolf_armor",
  "husbandry/repair_wolf_armor",
  "husbandry/whole_pack",
  "nether/obtain_ancient_debris",
  "nether/ride_strider",
  "nether/charge_respawn_anchor",
]);

export function feasibleNow(frontier: AdvancementNode[], earned: Set<string>): AdvancementNode[] {
  const has = (id: string) => earned.has(id) || earned.has(`minecraft:${id}`);
  return frontier.filter((a) => !NO_PATH_YET.has(a.id) && (GATED_ON[a.id] ?? []).every(has));
}

const GATEWAY_MIN_UNLOCKS = 10;
const GATEWAY_DOMINANCE = 3;

export function assignFor(
  role: string,
  frontier: AdvancementNode[],
  claimed: Set<string> = new Set(),
  ownClaim?: string,
): AdvancementNode | null {
  if (frontier.length === 0) return null;
  const free = frontier.filter((a) => !claimed.has(a.id) || a.id === ownClaim);
  // Doubling up beats idling: if every reachable advancement is spoken for, the
  // bot joins the nearest effort rather than standing still.
  const preferred = pick(role, free) ?? pick(role, frontier);

  // GATEWAY OVERRIDE. Category taste exists to walk the tree in parallel,
  // not to ignore a door that opens a whole wing. Measured live 2026-08-18:
  // Atlas was routed to "Ol' Betsy" (a crossbow he does not own, 0 unlocks)
  // while story/form_obsidian -> enter_the_nether, 24 downstream unlocks,
  // sat on the frontier assigned only to Forge — and the prompt tells every
  // bot its advancement line IS the objective, so the line was actively
  // fighting the team mission. When one reachable node unlocks an order of
  // magnitude more than the role's pick, everyone routes through the door;
  // claims are ignored on purpose — doubling up on a gateway is correct
  // economics, and duty differentiation lives in the mission text.
  const gateway = [...frontier].sort(byUnlockValue)[0];
  if (
    gateway &&
    descendantCount(gateway.id) >= GATEWAY_MIN_UNLOCKS &&
    (!preferred || descendantCount(gateway.id) >= GATEWAY_DOMINANCE * Math.max(1, descendantCount(preferred.id)))
  ) {
    return gateway;
  }
  return preferred;
}
