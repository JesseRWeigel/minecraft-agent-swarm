// src/bot/bed-safety.ts
// Where a bed is a bed, and where it is a bomb.
//
// Run 751: "Mason was killed by [Intentional Game Design]" at Nether
// (44, 43, -50), by the portal exit, on a fortress trip, and his chestplate
// went with him. Using a bed in the Nether or the End detonates it; that
// death message is Minecraft's own joke about it.
//
// The sleep action already had guards against bad places to sleep, and every
// one of them was written "if in the overworld ... refuse", so outside the
// overworld they all stood down and the bed went ahead. The dimension is the
// first question to ask, before the bed search and well before placing one.

/**
 * Does a bed explode instead of letting a bot sleep in this dimension?
 *
 * An unknown or missing dimension reads as the overworld on purpose. Blocking
 * every bed on a bad string would cost the swarm its nights, while letting one
 * through costs a single death, and `bot.game.dimension` is only ever empty
 * before the first spawn packet.
 */
export function bedExplodesHere(dimension: string | undefined | null): boolean {
  const d = String(dimension ?? "").toLowerCase();
  if (d === "" || /overworld/.test(d)) return false;
  return /nether|end/.test(d);
}

/** What to tell a bot that asked to sleep somewhere a bed would explode. */
export const BED_EXPLODES_MESSAGE =
  "A bed explodes here. Beds only work in the overworld, so go back through the portal before sleeping.";

/** How far from the village a bed may be and still set the respawn point.
 *  Runs 803 and 804: Forge slept in a bed at the plains village 650 blocks
 *  east during a trade trip, the sleep failed but the click set his spawn,
 *  and every death after that put him back among the village's night mobs:
 *  sixteen deaths in two hours at 534..615,-441..-495, an iron pickaxe lost
 *  each time, and never home to mine the gold the fortress trip waits on. */
export const BED_HOME_RADIUS = 150;

export function bedTooFarFromHome(
  bed: { x: number; z: number },
  home: { x: number; z: number } | undefined,
  radius = BED_HOME_RADIUS,
): boolean {
  if (!home) return false;
  return Math.hypot(bed.x - home.x, bed.z - home.z) > radius;
}

export const bedTooFarMessage = (dist: number) =>
  `Not sleeping here: this bed is ${Math.round(dist)} blocks from the village, and using it would move the respawn point out there. Sleep at the village bed.`;
