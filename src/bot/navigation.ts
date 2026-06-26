import type { Bot } from "mineflayer";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;

/** Create safe movement defaults — no digging, no block placement, just walk/jump */
export function safeMoves(bot: Bot): InstanceType<typeof Movements> {
  const moves = new Movements(bot);
  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowFreeMotion = false;
  moves.scafoldingBlocks = [];
  return moves;
}

/** Movement config for exploring — allows swimming across water (allowFreeMotion=true) */
export function explorerMoves(bot: Bot): InstanceType<typeof Movements> {
  const moves = new Movements(bot);
  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowFreeMotion = true; // needed for pathfinder to route through water
  moves.scafoldingBlocks = [];
  // Fall safety: Atlas the explorer was 25 of 31 fall deaths over the week,
  // roaming off cliffs/ledges. Cap how far the pathfinder will drop (default
  // lets it take 4-block fall-damage drops) and forbid parkour leaps across
  // gaps — both routinely walked him off high terrain. Navigation caution,
  // not a cheat.
  moves.maxDropDown = 3; // 3 blocks = no fall damage
  moves.allowParkour = false;
  return moves;
}

/**
 * Wraps pathfinder.goto with a timeout and stall detection.
 * - Times out after `timeoutMs` (default 15s)
 * - Cancels if bot hasn't moved more than 0.3 blocks in 5 seconds AFTER movement begins
 * - `stallStartDelayMs`: grace period before stall detection activates (use when thinkTimeout is high)
 */
export async function safeGoto(bot: Bot, goal: any, timeoutMs = 15000, stallStartDelayMs = 0): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let lastPos = bot.entity.position.clone();
    let stallTicks = 0;
    let stallActive = stallStartDelayMs === 0;
    const STALL_CHECK_MS = 1000;
    const STALL_THRESHOLD = 5; // 5 checks of 1s = 5 seconds without progress

    // Delay stall detection to let pathfinder finish computing the path first
    const stallDelayTimer =
      stallStartDelayMs > 0
        ? setTimeout(() => {
            stallActive = true;
            lastPos = bot.entity.position.clone(); // fresh baseline after think phase
            stallTicks = 0;
          }, stallStartDelayMs)
        : null;

    const timeout = setTimeout(() => {
      clearInterval(stallCheck);
      if (stallDelayTimer) clearTimeout(stallDelayTimer);
      bot.pathfinder.stop();
      reject(new Error("Navigation timed out — goal may be unreachable."));
    }, timeoutMs);

    const stallCheck = setInterval(() => {
      if (!stallActive) return;
      const currentPos = bot.entity.position;
      const moved = currentPos.distanceTo(lastPos);
      if (moved < 0.3) {
        stallTicks++;
        if (stallTicks >= STALL_THRESHOLD) {
          clearTimeout(timeout);
          clearInterval(stallCheck);
          if (stallDelayTimer) clearTimeout(stallDelayTimer);
          bot.pathfinder.stop();
          reject(new Error("Stuck — not making progress toward goal."));
        }
      } else {
        stallTicks = 0;
      }
      lastPos = currentPos.clone();
    }, STALL_CHECK_MS);

    bot.pathfinder
      .goto(goal)
      .then(() => {
        clearTimeout(timeout);
        clearInterval(stallCheck);
        if (stallDelayTimer) clearTimeout(stallDelayTimer);
        resolve();
      })
      .catch((err: any) => {
        clearTimeout(timeout);
        clearInterval(stallCheck);
        if (stallDelayTimer) clearTimeout(stallDelayTimer);
        reject(err);
      });
  });
}

/**
 * Walk over nearby dropped items so they enter the inventory. Digging a block
 * only spawns a drop — without this, bots "gather" wood that stays on the
 * ground (the root cause of phantom inventory reports).
 */
export async function collectNearbyDrops(bot: Bot, radius = 8, maxMs = 8000): Promise<void> {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 800)); // let drops finish falling
  const tried = new Set<number>();
  while (Date.now() - start < maxMs) {
    const drop = Object.values(bot.entities)
      .filter((e) => e.name === "item" && !tried.has(e.id) && e.position.distanceTo(bot.entity.position) < radius)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (!drop) break;
    tried.add(drop.id);
    try {
      // Stand exactly on the drop's block — GoalNear(r=1) can stop just outside
      // the pickup radius. An unreachable drop falls through to the next one.
      const p = drop.position.floored();
      await safeGoto(bot, new goals.GoalBlock(p.x, p.y, p.z), 6000);
      await new Promise((r) => setTimeout(r, 400)); // pickup tick
    } catch {
      continue; // stuck in leaves or a hole — try the next drop
    }
  }
}

/**
 * Self-extract from a hole the bot dug itself into. Bots with non-digging
 * movement get boxed into 1-wide pits (4 walls at head height) and soft-lock.
 * This is NOT a teleport cheat — the bot digs its own staircase out with its
 * hands, exactly like a player would. Returns true if it attempted an escape.
 */
export async function digOutIfStuck(bot: Bot): Promise<boolean> {
  const pos = bot.entity.position;
  const dirs: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  let walls = 0;
  for (const [dx, dz] of dirs) {
    const head = bot.blockAt(pos.offset(dx, 1, dz));
    if (head && head.boundingBox === "block") walls++;
  }
  if (walls < 3) return false; // not boxed in — nothing to do

  // Dig a staircase up and out using digging-capable movement (the bot's own
  // pickaxe/hands), then walk clear. Targets ~3 blocks up to clear the pit rim.
  const moves = new Movements(bot);
  moves.canDig = true;
  moves.allow1by1towers = true;
  bot.pathfinder.setMovements(moves);
  try {
    await safeGoto(bot, new goals.GoalY(Math.floor(pos.y) + 3), 15000);
    // then move laterally onto open ground away from the pit
    await safeGoto(bot, new goals.GoalNear(Math.floor(pos.x) + 5, Math.floor(pos.y) + 3, Math.floor(pos.z), 2), 15000);
  } catch {
    /* best effort — try again next cycle */
  } finally {
    bot.pathfinder.setMovements(safeMoves(bot));
  }
  return true;
}

/**
 * Anti-drown self-rescue. ~90% of all deaths were bots drowning in a water pit
 * by the stash: they path in, can't climb out, and drown. When the bot's HEAD
 * is submerged, swim up (jump) for air and head for the nearest dry shore. This
 * is the bot's own swimming — self-preservation, not a cheat. Called on a fast
 * timer from the brain. Returns true if it took rescue action.
 */
export async function escapeWaterIfDrowning(bot: Bot): Promise<boolean> {
  const head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
  if (!head || head.name !== "water") return false; // head not submerged → breathing fine

  // Find the nearest dry shore: a solid block with air above, scanned over fixed
  // offset rings (NOT a findBlock predicate that calls blockAt — that silently
  // matches nothing). Prefer the closest.
  const base = bot.entity.position.floored();
  let shore = null as ReturnType<typeof bot.blockAt> | null;
  for (let r = 1; r <= 8 && !shore; r++) {
    for (let dx = -r; dx <= r && !shore; dx++) {
      for (let dz = -r; dz <= r && !shore; dz++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue; // ring perimeter only
        for (let dy = -1; dy <= 1; dy++) {
          const b = bot.blockAt(base.offset(dx, dy, dz));
          const above = bot.blockAt(base.offset(dx, dy + 1, dz));
          if (b && b.boundingBox === "block" && b.name !== "water" && above && above.name === "air") {
            shore = b;
            break;
          }
        }
      }
    }
  }

  try {
    bot.setControlState("jump", true); // swim upward toward the surface for air
    if (shore && shore.position) {
      await bot.lookAt(shore.position.offset(0.5, 1.5, 0.5));
      bot.setControlState("forward", true);
    }
    await bot.waitForTicks(24); // ~1.2s of swimming up/out; the timer re-runs if still under
  } catch {
    /* best effort — timer retries */
  } finally {
    bot.setControlState("forward", false);
    bot.setControlState("jump", false);
  }
  return true;
}
