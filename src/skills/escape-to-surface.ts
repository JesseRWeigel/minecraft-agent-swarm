import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto } from "../bot/navigation.js";

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
 * The staircase consumes no blocks, so it works for a bot carrying nothing
 * across the whole ~44-block climb through solid stone. Each dig waits as
 * long as the block really takes by hand (deepslate 15s, ores up to 22.5s),
 * because a fixed short timeout silently made every deepslate block
 * unbreakable. Where there is no
 * solid block to step onto — an open cave or a pocket — it falls back to
 * pillaring straight up on a scaffold block from the pack (Atlas and Flora
 * stalled exactly in those open spots).
 */

const SURFACE_Y = 62; // sea level-ish; above this the overworld is open sky here

function feet(bot: Bot) {
  return bot.entity.position.floored();
}

/** Longest bare-hand break we will wait for. Stone is 7.5s, deepslate 15s,
 * deepslate ores 22.5s; obsidian (250s) and bedrock (never) are hopeless. */
const MAX_HAND_DIG_MS = 40_000;
const MAX_DIG_WAIT_MS = 90_000; // a dig in water runs 5x slower; still worth one wait
const DIG_MARGIN_MS = 4_000;
const MIN_DIG_BUDGET_MS = 5_000;

/**
 * How long to wait for one bare-hand dig — or null when the block is not
 * worth trying by hand. `baseMs` is the block's break time standing on solid
 * ground out of water (what decides hopeless: obsidian, bedrock); `actualMs`
 * is the break time in the bot's current situation (in water it is 5x), which
 * sizes the wait.
 *
 * This replaced a fixed 12s timeout that was shorter than deepslate's 15s
 * bare-hand break time: every dig below y=0 was aborted just before the block
 * broke, so a bot in deepslate could never carve a step, never clear a
 * ceiling to pillar into, and reported "all four sides blocked" from a spot
 * that was plain diggable rock (Flora, y=-45, for two hours).
 */
export function digBudgetMs(baseMs: number, actualMs: number = baseMs): number | null {
  if (!Number.isFinite(baseMs) || baseMs > MAX_HAND_DIG_MS) return null;
  const wait = Math.max(MIN_DIG_BUDGET_MS, actualMs + DIG_MARGIN_MS);
  return Math.min(wait, MAX_DIG_WAIT_MS);
}

/** Wait (briefly) for the bot to land. Mineflayer quotes a dig 5x longer
 * while the bot is airborne, and the staircase jumps every step — a dig
 * measured mid-hop read deepslate as a hopeless 75s. */
async function settleOnGround(bot: Bot, maxMs = 1_500): Promise<void> {
  const until = Date.now() + maxMs;
  while (!bot.entity.onGround && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Direct bare-handed dig sized to the block's real break time — bypasses the
 * pathfinder tool check. Returns true once the block is gone. */
async function handDig(bot: Bot, x: number, y: number, z: number): Promise<boolean> {
  const { Vec3 } = await import("vec3");
  const pos = new Vec3(x, y, z);
  const b = bot.blockAt(pos);
  if (!b || b.boundingBox !== "block") return true; // already air/liquid — nothing to break
  if (b.name === "bedrock" || b.name === "water" || b.name === "lava") return false; // never dig these
  if (!bot.canDigBlock(b)) return false; // unbreakable for this bot right now
  await settleOnGround(bot);
  const heldType = bot.heldItem?.type ?? null;
  const base = b.digTime(heldType, false, false, false, [], []);
  const expected = bot.digTime(b);
  const budget = digBudgetMs(base, expected);
  if (budget === null) {
    console.log(
      `[EscapeDebug] ${bot.username}: skipping ${b.name} at ${x},${y},${z} — ${Math.round(base / 1000)}s by hand is hopeless`,
    );
    return false;
  }
  const started = Date.now();
  let timedOut = false;
  let digError = "";
  await Promise.race([
    bot.dig(b),
    new Promise<void>((_, rej) =>
      setTimeout(() => {
        timedOut = true;
        rej(new Error("dig timeout"));
      }, budget),
    ),
  ]).catch((err: unknown) => {
    digError = err instanceof Error ? err.message : String(err);
    try {
      bot.stopDigging();
    } catch {
      /* wasn't digging */
    }
  });
  const after = bot.blockAt(pos);
  const gone = !after || after.boundingBox !== "block";
  if (!gone) {
    console.log(
      `[EscapeDebug] ${bot.username}: ${b.name} at ${x},${y},${z} survived a ${Math.round((Date.now() - started) / 1000)}s dig (expected ${Math.round(expected / 1000)}s${timedOut ? ", timed out" : digError ? `, dig threw: ${digError}` : ", dig ended early"})`,
    );
  }
  return gone;
}

/** Full solid blocks a bot can pillar up on — anything a miner or roamer picks
 * up in quantity. Excludes gravel/sand (fall) and non-full blocks. */
const PILLAR_BLOCKS = new Set([
  "cobblestone",
  "cobbled_deepslate",
  "dirt",
  "netherrack",
  "stone",
  "deepslate",
  "andesite",
  "diorite",
  "granite",
  "tuff",
  "blackstone",
  "end_stone",
]);

/**
 * Pillar straight up one push when the staircase is boxed in — an open cave or
 * a pocket with no solid block to step onto. Hand-clears the stone ceiling
 * (bare hands break it), then lets the pathfinder tower up into the cleared
 * air using a scaffold block from the pack. Returns true if it gained height.
 * Needs a placeable block; a bot carrying none can't pillar and stays put.
 */
async function pillarUp(bot: Bot): Promise<boolean> {
  const startY = feet(bot).y;
  const scaffold = bot.inventory.items().find((i) => PILLAR_BLOCKS.has(i.name));
  if (!scaffold) return false;
  const f = feet(bot);
  // Clear the reachable ceiling straight up so there is air to rise into.
  for (const dy of [2, 3, 4]) await handDig(bot, f.x, f.y + dy, f.z);
  try {
    await bot.equip(scaffold, "hand");
  } catch {
    /* equip best-effort */
  }
  const moves = baseMoves(bot);
  moves.canDig = false; // don't fight the tool check — we hand-cleared the shaft
  moves.allow1by1towers = true;
  moves.allowParkour = false;
  bot.pathfinder.setMovements(moves);
  await safeGoto(bot, new goals.GoalY(f.y + 3), 15_000, 6_000).catch(() => {});
  return feet(bot).y > startY;
}

/** How far up the buried check looks for a ceiling. A pocket or cavern can
 * have several blocks of air overhead and still be sealed rock. */
export const BURIED_CEILING_SCAN = 24;

/**
 * True when a bot below the surface band has solid rock somewhere in the
 * column above it. This replaced a check of the single block two above the
 * feet, which read Flora's tall pocket at y=-45 as open sky — and which the
 * pillar fallback itself turned false by hand-clearing that exact block, so a
 * bot that had just been rescued once stopped qualifying for a second push.
 */
export function isBuried(
  blockAt: (x: number, y: number, z: number) => { boundingBox: string } | null,
  feetX: number,
  feetY: number,
  feetZ: number,
): boolean {
  if (feetY >= SURFACE_Y - 7) return false;
  for (let dy = 2; dy <= BURIED_CEILING_SCAN; dy++) {
    const b = blockAt(feetX, feetY + dy, feetZ);
    if (b && b.boundingBox === "block") return true;
  }
  return false;
}

/**
 * Float up through water before digging. Digging while swimming runs 25x
 * slower (5x in water, 5x airborne), so a bot in an aquifer pocket spent whole
 * 240s runs on one block (Forge, y=26, "expected 188s"). Swimming up is free
 * height; take all of it first. Returns the blocks gained.
 */
function inWater(bot: Bot): boolean {
  const b = bot.blockAt(bot.entity.position);
  return !!b && (b.name === "water" || b.name === "flowing_water" || b.name === "bubble_column");
}

async function swimUp(bot: Bot): Promise<number> {
  const startY = feet(bot).y;
  if (!inWater(bot)) return 0;
  let lastY = bot.entity.position.y;
  let stalls = 0;
  bot.setControlState("jump", true);
  try {
    for (let i = 0; i < 40 && inWater(bot); i++) {
      await new Promise((r) => setTimeout(r, 250));
      const y = bot.entity.position.y;
      if (y > lastY + 0.05) {
        lastY = y;
        stalls = 0;
      } else if (++stalls >= 6) break; // ceiling or surface reached
    }
  } finally {
    bot.setControlState("jump", false);
  }
  const gained = feet(bot).y - startY;
  if (gained > 0) console.log(`[EscapeDebug] ${bot.username}: swam up ${gained} blocks to y=${feet(bot).y}`);
  return gained;
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

    // A death mid-climb respawns the bot at its bed or spawn — on the surface,
    // but the escape did not do that. Report it plainly instead of claiming
    // the staircase reached daylight (Flora, shot by a skeleton at y=-32).
    let died = false;
    const onDeath = () => {
      died = true;
    };
    bot.once("death", onDeath);
    const diedResult = (): SkillResult => ({
      success: false,
      message: `Died at y=${lastY} on the way up and respawned; the climb did not finish.`,
      stats: { fromY: startY, toY: lastY, died: 1 },
    });

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
      if (died) return diedResult();
      if (inWater(bot)) {
        const swam = await swimUp(bot);
        if (swam > 0) {
          lastY = Math.max(lastY, feet(bot).y);
          stallCount = 0;
          continue;
        }
      }
      const f = feet(bot);
      if (f.y >= SURFACE_Y || canSeeSky(bot)) {
        bot.removeListener("death", onDeath);
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
          // Tried all four cardinals without gaining a block: no solid step to
          // climb (open cave or a pocket). Fall back to pillaring straight up
          // with a scaffold block. Atlas and Flora stalled exactly here.
          step(`Boxed in at y=${feet(bot).y} — pillaring straight up...`, 0.5);
          const rose = await pillarUp(bot);
          if (died) return diedResult();
          if (!rose) {
            const fy = feet(bot).y;
            bot.removeListener("death", onDeath);
            return {
              success: false,
              message: `Stuck at y=${fy} — no solid step to climb and no scaffold block to pillar with. invoke_skill {"skill":"escape_to_surface"} again to keep trying.`,
            };
          }
          lastY = feet(bot).y;
        }
      }
    }

    bot.removeListener("death", onDeath);
    if (died) return diedResult();
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
