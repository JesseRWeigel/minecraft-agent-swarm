// src/bot/brake.ts
// Stopping a walk without sliding off the ledge it ended on.
//
// Run 750, both of Mason's lava deaths, from the fall records:
//   "Fell 17.5 blocks from y=46 (airborne 4.5s, controls=none pathing=false
//    vel=-0.16 at=84,46,-39 in=air on=air) [stood controls=none pathing=false
//    vel=-0.08 at=83,46,-39 in=air on=netherrack 193ms before leaving]"
// No control was held and no path was running, yet the bot crossed a whole
// block in 193ms, which is about sprinting speed, and went over the edge. The
// planner never chose that drop; it had already let go. What walked him off
// was the momentum left over from the leg that had just timed out.
//
// Sneaking is the fix Minecraft itself uses. While a player sneaks on the
// ground, any step that would leave no block underneath is clamped to zero,
// and prismarine-physics implements that same clamp, so holding sneak while
// the leftover speed decays keeps the bot on the block it stopped on. It is
// also the safe thing to hold: sneak alone never moves the bot anywhere.

/** The parts of a bot this needs, so the braking rule can be tested directly. */
export interface BrakeBot {
  entity: { velocity: { x: number; z: number } };
  clearControlStates(): void;
  setControlState(control: string, state: boolean): void;
  waitForTicks(ticks: number): Promise<void>;
}

/** Below this horizontal speed the bot can no longer walk itself off an edge. */
export const BRAKE_STOPPED_SPEED = 0.03;
/** Ground friction kills a sprint in about four ticks; this is the safety net. */
export const BRAKE_MAX_TICKS = 12;

function horizontalSpeed(bot: BrakeBot): number {
  const v = bot.entity?.velocity;
  if (!v) return 0;
  return Math.hypot(v.x ?? 0, v.z ?? 0);
}

/**
 * Hold the bot still until its leftover speed is gone.
 *
 * Returns the number of ticks spent braking, which is 0 when the bot was
 * already stopped, so a caller can log how often a walk ended in motion.
 */
export async function brakeToStop(bot: BrakeBot, maxTicks = BRAKE_MAX_TICKS): Promise<number> {
  bot.clearControlStates();
  bot.setControlState("sneak", true);
  let ticks = 0;
  try {
    while (ticks < maxTicks && horizontalSpeed(bot) > BRAKE_STOPPED_SPEED) {
      await bot.waitForTicks(1);
      ticks++;
    }
  } finally {
    // Release only once the slide is over: sneak is what holds the edge.
    bot.setControlState("sneak", false);
  }
  return ticks;
}
