// src/bot/mine-budget.ts
// How long a bot may spend travelling to a block it intends to mine.
//
// mineBlock searches for ore up to 64 blocks away and then called safeGoto with
// no timeout argument, taking the 15 second default, while tunnelling through
// solid stone with canDig=true. Sixty-four blocks of digging cannot happen in
// fifteen seconds, so the search radius and the travel budget disagreed by
// roughly an order of magnitude.
//
// Measured in one 1h48m session: 39 "Navigation timed out" and 28 "dig timeout"
// against 8 iron mined. Meanwhile bots called withdraw_stash 84 times and got
// "No iron_ingot in the stash" 86 times, because nothing was filling it.
//
// Budget scales with distance. A block underfoot still fails fast; a vein 60
// blocks down gets time to actually be reached.

/** Seconds of travel allowed per block of distance, when digging is involved. */
const MS_PER_BLOCK = 900;
export const MIN_TRAVEL_MS = 10_000;
export const MAX_TRAVEL_MS = 60_000;

/** Travel budget for reaching a mining target `distance` blocks away.
 *
 *  Capped so a single mine_block can never eat the 150s action watchdog, and
 *  floored so a nearby block is not given an absurdly small window. */
export function travelBudgetMs(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return MIN_TRAVEL_MS;
  return Math.min(MAX_TRAVEL_MS, Math.max(MIN_TRAVEL_MS, Math.round(distance * MS_PER_BLOCK)));
}

// Runs 788 and 789: gold ore sits 50 to 70 blocks under the village and every
// walk to it ended "stopped 32 blocks short", "stopped 49 blocks short" or
// timed out, because one leg of at most sixty seconds cannot tunnel ninety
// blocks of stone. A leg that ends closer than it began is worth another,
// up to this many and this long in all, which still leaves room for the
// look-at retry and the dig inside the 150 second action watchdog.
export const DEEP_TRAVEL_MS = 110_000;
export const MAX_TRAVEL_LEGS = 4;
export const LOOKAT_RETRY_MS = 15_000;

/** True when a walk leg closed the gap enough to deserve another. */
export function legWorthContinuing(gapBefore: number, gapAfter: number, minGain = 4): boolean {
  if (!Number.isFinite(gapBefore) || !Number.isFinite(gapAfter)) return false;
  return gapBefore - gapAfter >= minGain;
}
