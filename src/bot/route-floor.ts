// src/bot/route-floor.ts
// A price on walking far below the altitude a route belongs at.
//
// Run 749: Mason marched toward nether bricks at y=51 and spent the march at
// y=27-31 inside a lava basin, where the perch search reported "no perch
// within 24 up" and the carve refused to open the lava pockets around him.
// All three of his deaths that run were "tried to swim in lava" down there.
// Nothing planned that descent: a three-block drop limit lets the planner walk
// down a slope forever, three blocks at a time, and the recovery that notices
// the bot is too low only runs once it is already in the hole.
//
// The cost grows with depth on purpose. A flat price makes every depth below
// the floor equally bad, so once the bot is under it nothing pulls it back up;
// a graded one makes climbing toward route height the cheapest way out. It
// stays a price rather than a wall so a route that genuinely has to dip still
// exists — the planner just has to prefer everything else first.

/** How far below the target a march may drift before steps start costing. */
export const ROUTE_FLOOR_SLACK = 8;
/** Ceiling on the price, near the death-zone cost so neither drowns the other. */
export const MAX_BELOW_ROUTE_COST = 80;
/** Price per block of depth under the floor. */
const COST_PER_BLOCK = 8;

/** The altitude a march toward `targetY` should try to stay above. */
export function routeFloor(targetY: number): number {
  return targetY - ROUTE_FLOOR_SLACK;
}

/** Step cost for standing at `y` when the route belongs at or above `floorY`. */
export function belowRouteCost(floorY: number, y: number): number {
  const below = floorY - y;
  if (below <= 0) return 0;
  return Math.min(MAX_BELOW_ROUTE_COST, below * COST_PER_BLOCK);
}
