import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";

/**
 * escape_to_surface — free a bot that has softlocked underground.
 *
 * The failure this fixes: a miner whose pickaxe broke ends up stranded below
 * ground, surrounded by stone it cannot break (a pickless bot fails the
 * pathfinder's tool check, so canDig can't tunnel and walk-home stalls
 * instantly), with no wood down there to craft a new pick and too far from the
 * stash to withdraw one. Forge, Atlas and Flora were all stuck this way at
 * once, dropping the swarm to 7% action success.
 *
 * The escape uses the one thing that still works with no tools: bare hands.
 * A player with empty hands can still BREAK stone (it just drops nothing), so
 * this carves a staircase straight up to daylight by hand — dig the two blocks
 * ahead-and-up, keep the one below as the step, jump onto it, repeat — until
 * the bot can see sky. Then the normal walk-home/mining reflexes take over
 * from the surface, where wood and the stash are reachable again.
 *
 * No blocks are consumed (unlike pillaring, which would run out of cobble long
 * before the ~44-block climb), so it works even for a bot carrying nothing.
 */

const SURFACE_Y = 62; // sea level-ish; above this the overworld is open sky here

function feet(bot: Bot) {
  return bot.entity.position.floored();
}

/** Direct bare-handed dig with a timeout — bypasses the pathfinder tool check. */
async function handDig(bot: Bot, x: number, y: number, z: number): Promise<void> {
  const { Vec3 } = await import("vec3");
  const b = bot.blockAt(new Vec3(x, y, z));
  if (!b || b.boundingBox !== "block") return; // already air/liquid — nothing to break
  if (b.name === "bedrock" || b.name === "water" || b.name === "lava") return; // never dig these
  if (!bot.canDigBlock(b)) return; // unbreakable for this bot right now
  await Promise.race([
    bot.dig(b),
    new Promise<void>((_, rej) => setTimeout(() => rej(new Error("dig timeout")), 12_000)),
  ]).catch(() => {
    try {
      bot.stopDigging();
    } catch {
      /* wasn't digging */
    }
  });
}

/** True once the column straight above the bot is clear to the sky. */
function canSeeSky(bot: Bot): boolean {
  const f = feet(bot);
  if (f.y >= SURFACE_Y) return true;
  for (let dy = 2; dy <= 6; dy++) {
    const b = bot.blockAt(f.offset(0, dy, 0));
    if (b && b.boundingBox === "block") return false;
  }
  // reachable ceiling is clear and we're near the surface band
  return f.y >= SURFACE_Y - 4;
}

export const escapeToSurfaceSkill: Skill = {
  name: "escape_to_surface",
  description:
    "Hand-dig a staircase straight up to daylight when stranded underground with no pickaxe. The unstick for a softlocked miner.",
  params: {},
  timeoutMs: 240_000,

  estimateMaterials(): Record<string, number> {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "escape_to_surface", phase: "Escape", progress, message, active: true });

    // Stop any pathfinder goal fighting us for the controls.
    try {
      bot.pathfinder.stop();
    } catch {
      /* no goal */
    }

    const startY = feet(bot).y;
    if (startY >= SURFACE_Y) {
      return { success: true, message: "Already at the surface." };
    }

    // March the staircase toward the four cardinals in turn, so a wall on one
    // side just makes it turn rather than jam. Prefer heading roughly toward
    // the village (west/north here) but any direction that ascends is a win.
    const dirs: [number, number][] = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ];
    let dirIdx = 0;

    const deadline = Date.now() + 220_000;
    let lastY = startY;
    let stallCount = 0;

    while (!signal.aborted && Date.now() < deadline) {
      const f = feet(bot);
      if (f.y >= SURFACE_Y || canSeeSky(bot)) {
        return {
          success: true,
          message: `Climbed out to y=${f.y} — back on the surface.`,
          stats: { fromY: startY, toY: f.y },
        };
      }
      step(
        `Carving a staircase up — y=${f.y}, ${SURFACE_Y - f.y} to go...`,
        Math.min(0.95, (f.y - startY) / (SURFACE_Y - startY)),
      );

      const [dx, dz] = dirs[dirIdx];
      // One staircase step in this direction ends with the bot standing on the
      // block at (f+dir), one higher. Clear the two air blocks the bot will
      // occupy there, plus the block above its own head so it can rise.
      await handDig(bot, f.x + dx, f.y + 1, f.z + dz); // new feet
      await handDig(bot, f.x + dx, f.y + 2, f.z + dz); // new head
      await handDig(bot, f.x, f.y + 2, f.z); // own head clearance for the hop

      // The step block itself must be solid to stand on. If it's a hole, carve
      // it level for this move (walk forward flat) rather than stepping up.
      const { Vec3 } = await import("vec3");
      const stepBlock = bot.blockAt(new Vec3(f.x + dx, f.y, f.z + dz));
      const steppingUp = !!stepBlock && stepBlock.boundingBox === "block";
      if (!steppingUp) {
        // clear the forward block at foot level so we can at least advance
        await handDig(bot, f.x + dx, f.y, f.z + dz);
      }

      // Jump-and-forward onto the carved step (manual physics — no pathfinder,
      // which refuses to path pickless through stone).
      try {
        await bot.lookAt(new Vec3(f.x + dx + 0.5, f.y + 1, f.z + dz + 0.5), true);
      } catch {
        /* look best-effort */
      }
      bot.setControlState("forward", true);
      if (steppingUp) bot.setControlState("jump", true);
      await new Promise((r) => setTimeout(r, 600));
      bot.setControlState("jump", false);
      bot.setControlState("forward", false);
      await new Promise((r) => setTimeout(r, 200));

      const nowY = feet(bot).y;
      if (nowY > lastY) {
        lastY = nowY;
        stallCount = 0;
      } else if (++stallCount >= 3) {
        // this heading isn't ascending — turn to the next cardinal
        dirIdx = (dirIdx + 1) % dirs.length;
        stallCount = 0;
        if (dirIdx === 0) {
          // tried all four without gaining a block — genuinely boxed
          const fy = feet(bot).y;
          if (fy <= lastY) {
            return {
              success: false,
              message: `Stuck at y=${fy} — couldn't carve a staircase up (all four sides blocked). invoke_skill {"skill":"escape_to_surface"} again to keep trying.`,
            };
          }
        }
      }
    }

    const endY = feet(bot).y;
    return {
      success: endY >= SURFACE_Y,
      message:
        endY >= SURFACE_Y
          ? `Reached the surface at y=${endY}.`
          : `Ran out of time at y=${endY} (started ${startY}). invoke_skill {"skill":"escape_to_surface"} again to continue.`,
      stats: { fromY: startY, toY: endY },
    };
  },
};
