// src/bot/dig-reach.ts
// Is the block close enough to dig?
//
// Run 763: six of twenty-five mine_block calls ended "Action failed: dig
// timeout", and the swarm banked no iron all day, which is what stopped the
// fortress kit. mine_block walks to the ore with GoalNear(2) and then digs
// whatever the walk left it beside. A walk can resolve without arriving: the
// pathfinder reports the goal reached and the nav diagnostic calls it a
// phantom arrival, and the bot is still tens of blocks away. bot.dig on a
// block it cannot touch then hangs until the twelve second guard fires, and
// the brain is told "dig timeout", which says nothing about what went wrong.
//
// A player can reach about 4.5 blocks in survival. Measuring that before
// swinging turns twelve wasted seconds into an answer.

/** Survival reach, from the eyes to the block face, with a little slack. */
export const DIG_REACH_BLOCKS = 4.5;

/** Can a bot at `from` dig the block at `at`? Centres the block. */
export function withinDigReach(
  from: { x: number; y: number; z: number },
  at: { x: number; y: number; z: number },
  reach = DIG_REACH_BLOCKS,
): boolean {
  return distanceToBlock(from, at) <= reach;
}

/** Distance from a standing position to the centre of a block. */
export function distanceToBlock(
  from: { x: number; y: number; z: number },
  at: { x: number; y: number; z: number },
): number {
  // The bot's eyes sit about 1.62 above its feet, and the block's middle is
  // half a block in from its corner. Both matter at this range.
  const dx = from.x - (at.x + 0.5);
  const dy = from.y + 1.62 - (at.y + 0.5);
  const dz = from.z - (at.z + 0.5);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
