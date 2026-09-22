// src/bot/immobile-watchdog.ts
// A bot that has not moved in minutes is stuck, whatever it believes it is doing.
//
// Run 783: "[Stuck] Forge at 324,-15,-320 sides=dirt/water/water/water" fifty-six
// times in one hour, with a live goal at the village stash ninety-three blocks
// away and eighty-five blocks up, and the planner resetting on block_updated
// 277 times as the water flowed around him. The escape that exists for exactly
// this is gated on `!isSkillRunning`, so a bot wedged inside a long skill can
// never reach it, and 150 navigation attempts failed that hour.
//
// Position over time is the one signal that does not depend on any of that.

export interface StuckState {
  /** Where the bot was when it last counted as having moved. */
  x: number;
  y: number;
  z: number;
  /** When it was last seen there. */
  since: number;
}

/** Moving less than this counts as standing still. */
export const MOVED_BLOCKS = 3;
/** How long a bot may stand still before it is treated as trapped. */
export const IMMOBILE_MS = 240_000;
/** Above this height a motionless bot is idling rather than entombed. */
export const DEEP_Y = 45;

/** Update the record, returning the state to keep for next time. */
export function trackPosition(
  prev: StuckState | null,
  pos: { x: number; y: number; z: number },
  now: number,
): StuckState {
  if (!prev) return { x: pos.x, y: pos.y, z: pos.z, since: now };
  const moved = Math.hypot(pos.x - prev.x, pos.y - prev.y, pos.z - prev.z);
  if (moved > MOVED_BLOCKS) return { x: pos.x, y: pos.y, z: pos.z, since: now };
  return prev;
}

/**
 * Has this bot been pinned in one place while it was trying to get somewhere?
 *
 * Depth alone was the wrong test. Run 784: Atlas reported stuck at
 * (357, 55, -309) fifteen times and the watchdog ignored every one, because
 * 55 sits above the y=45 line drawn to protect a bot idling at the village.
 * The village floor is around y=70, so the line excluded exactly the middle
 * ground where a bot gets wedged.
 *
 * What separates a trapped bot from a resting one is whether it is trying.
 * A bot inside a skill, or with the planner still walking it somewhere, has
 * work in hand: four motionless minutes with work in hand is a trap at any
 * height. With nothing in hand, the old depth rule still applies, so a bot
 * standing about on the surface is left alone.
 */
export function isPinned(state: StuckState | null, now: number, y: number, working = false): boolean {
  if (!state) return false;
  if (now - state.since < IMMOBILE_MS) return false;
  return working || y <= DEEP_Y;
}
