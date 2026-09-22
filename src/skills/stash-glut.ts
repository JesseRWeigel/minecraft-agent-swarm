// src/skills/stash-glut.ts
// What the stash already has too much of.
//
// On 2026-09-22 the stash held 4,875 item stacks across 178 chests, against a
// capacity of 4,806, so every deposit bounced and the expansion kept adding
// chests. The contents were mining spoil: 16,420 cobblestone, 9,594 cobbled
// deepslate, 4,192 coal, 3,306 andesite, 2,771 diorite, 2,727 granite and
// 2,091 dirt, about forty thousand items of rubble. Meanwhile a withdrawal
// for two iron ingots reported "No iron_ingot in the stash", because two
// ingots in a hundred and seventy-eight chests of gravel are not findable,
// and the village filled with chests until the bots could not path through
// their own base.
//
// Bulk that the team will never spend has a cap. Past it a bot keeps what it
// is carrying rather than banking it, the chests stop growing, and the
// lookups have somewhere smaller to search.

/** Blocks a mining swarm produces faster than it can ever use them. */
const BULK = [
  "cobblestone",
  "cobbled_deepslate",
  "deepslate",
  "andesite",
  "diorite",
  "granite",
  "dirt",
  "gravel",
  "netherrack",
  "tuff",
  "stone",
  "sand",
  "coal",
];

/** How much of one bulk block is worth keeping banked. Eight stacks builds a lot. */
export const BULK_CAP = 512;

/** Is this one of the blocks that arrives by the thousand? */
export function isBulk(name: string): boolean {
  return BULK.includes(name);
}

/**
 * Should this item be banked, given how much of it the stash already holds?
 *
 * Anything that is not bulk is always welcome: ores, ingots, food, tools and
 * the rest are what the stash is for.
 */
export function worthBanking(name: string, alreadyBanked: number, cap = BULK_CAP): boolean {
  if (!isBulk(name)) return true;
  return alreadyBanked < cap;
}
