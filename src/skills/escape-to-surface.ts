import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto, headUnderWater, rescueDigging } from "../bot/navigation.js";

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
const PICK_RANK = ["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe"];
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
  // A bot that DOES hold a pickaxe (sent here from a flooded shaft by another
  // skill) digs with it: stone in water goes from 188s bare-handed to ~29s.
  const pick = bot.inventory
    .items()
    .filter((i) => i.name.endsWith("_pickaxe"))
    .sort((a, b) => PICK_RANK.indexOf(b.name) - PICK_RANK.indexOf(a.name))[0];
  if (pick && bot.heldItem?.name !== pick.name) await bot.equip(pick, "hand").catch(() => {});
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
  // Swimming sinks the bot mid-dig and the server aborts the dig ("Digging
  // aborted" at 416,13,-312, seven times). Float at the surface while digging.
  // Run 631: this dig released the jump key 15 times while the drown reflex
  // was holding it. With short air the reflex owns the keys; skip the dig.
  if (headUnderWater(bot) && (bot.oxygenLevel ?? 20) < 13) {
    console.log(`[EscapeDebug] ${bot.username}: dig skipped, drown rescue owns the keys (air ${bot.oxygenLevel})`);
    return false;
  }
  // Run 669: this dig aborted the reflex's 250 s cap dig every few seconds
  // while Forge breathed in a sealed column. A rescue dig runs to its end.
  if (rescueDigging(bot)) {
    console.log(`[EscapeDebug] ${bot.username}: dig skipped, drown rescue is finishing its own dig`);
    return false;
  }
  const floating = inWater(bot);
  if (floating) bot.setControlState("jump", true);
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
  if (floating) bot.setControlState("jump", false);
  const after = bot.blockAt(pos);
  const gone = !after || after.boundingBox !== "block";
  if (!gone) {
    console.log(
      `[EscapeDebug] ${bot.username}: ${b.name} at ${x},${y},${z} survived a ${Math.round((Date.now() - started) / 1000)}s dig (expected ${Math.round(expected / 1000)}s${timedOut ? ", timed out" : digError ? `, dig threw: ${digError}` : ", dig ended early"}; goal=${(bot.pathfinder as { goal?: unknown }).goal ? "set" : "none"}, floating=${floating})`,
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
  scan: number = BURIED_CEILING_SCAN,
): boolean {
  // Deep down, any roof means buried. Near the surface the old rule was
  // "never buried", which spared bots under trees and house roofs but also
  // left Flora sealed in a two-block pocket at y=62 under ten blocks of
  // stone for hours (run 537, pickless, 363,62,-281). Up here, count the
  // solid blocks overhead: a canopy or a roof is one to three, a hillside
  // is many.
  const deep = feetY < SURFACE_Y - 7;
  let solid = 0;
  for (let dy = 2; dy <= scan; dy++) {
    const b = blockAt(feetX, feetY + dy, feetZ);
    if (b && b.boundingBox === "block") {
      solid++;
      if (deep || solid >= 4) return true;
    }
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
  // Lava counts too: the Nether has no water and the same shaft logic must
  // back away from a molten pocket (run 736).
  return (
    !!b &&
    (b.name === "water" ||
      b.name === "flowing_water" ||
      b.name === "bubble_column" ||
      b.name === "lava" ||
      b.name === "flowing_lava")
  );
}

/** True when carving the next stair step toward (dx, dz) from feet (x, y, z)
 *  would open a cell that touches water: the new feet, the new head, the
 *  bot's own head clearance, the step block, and their side and top
 *  neighbours. */
function wouldFlood(bot: Bot, x: number, y: number, z: number, dx: number, dz: number): boolean {
  const cells: [number, number, number][] = [
    [x + dx, y + 1, z + dz],
    [x + dx, y + 2, z + dz],
    [x, y + 2, z],
    [x + dx, y, z + dz],
  ];
  // Run 736: this guard knew only water, and Mason carved three staircases
  // in the Nether that ended "tried to swim in lava" at y=70. Up there the
  // pocket the stair opens is lava, and it pours down the shaft it just
  // cut. A fluid is a fluid; treat lava the same and turn away from it.
  const isFluid = (bx: number, by: number, bz: number) => {
    const b = bot.blockAt(new Vec3(bx, by, bz));
    return (
      !!b &&
      (b.name === "water" ||
        b.name === "flowing_water" ||
        b.name === "bubble_column" ||
        b.name === "lava" ||
        b.name === "flowing_lava")
    );
  };
  const isWater = isFluid;
  const sides: [number, number, number][] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  for (const [cx, cy, cz] of cells) {
    if (isWater(cx, cy, cz)) return true;
    for (const [nx, ny, nz] of sides) if (isWater(cx + nx, cy + ny, cz + nz)) return true;
  }
  return false;
}

/** The horizontal direction with the fewest fluid blocks within three of
 *  the cell it leads to, for backing away from a flooded or molten pocket. */
function driestDirection(bot: Bot, x: number, y: number, z: number, dirs: [number, number][]): [number, number] {
  let best: [number, number] = dirs[0];
  let bestWet = Infinity;
  for (const [dx, dz] of dirs) {
    const cx = x + dx * 3;
    const cz = z + dz * 3;
    let wet = 0;
    for (let ox = -3; ox <= 3; ox++)
      for (let oy = -1; oy <= 2; oy++)
        for (let oz = -3; oz <= 3; oz++) {
          const b = bot.blockAt(new Vec3(cx + ox, y + oy, cz + oz));
          if (b && (b.name === "water" || b.name === "flowing_water")) wet++;
        }
    if (wet < bestWet) {
      bestWet = wet;
      best = [dx, dz];
    }
  }
  return best;
}

/** True when the bot's head is already above the water: nothing more to gain by swimming. */
function headAboveWater(bot: Bot): boolean {
  const head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
  return !!head && head.name !== "water" && head.name !== "flowing_water" && head.name !== "bubble_column";
}

async function swimUp(bot: Bot): Promise<number> {
  const startY = feet(bot).y;
  if (!inWater(bot) || headAboveWater(bot)) return 0; // at the surface: bobbing reads as +1 forever
  let lastY = bot.entity.position.y;
  let stalls = 0;
  bot.setControlState("jump", true);
  try {
    for (let i = 0; i < 40 && inWater(bot) && !headAboveWater(bot); i++) {
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
  // A sealed pocket at surface height is still a pocket: the reflex that
  // invoked us just counted four or more solid blocks overhead (run 538:
  // "Already at the surface" for Flora at y=62 under ten blocks of stone).
  // Sky light at the head near the surface settles it: a notch on a hill
  // or the ground under a one-wide pillar is lit, a sealed pocket is not.
  // Direct sky is light level 15 exactly; 1 to 14 is light leaking in from
  // an opening the bot cannot necessarily walk to. Run 562: Flora's pocket at
  // (488, 59, -355) sat under eight solid blocks with a lit cave mouth to the
  // east, so "sky > 0" declared her on the surface 23 times in an hour while
  // the reflex kept firing her back. Anything under 15 falls through to the
  // block scan, which sees the roof.
  // Run 605: Forge sat two hours in a sealed pocket at (653, 150, -466)
  // under three stone and two snow, and this function said "surface" 25
  // times: the sky-light read came back 15 in that mountain section, and
  // the SURFACE_Y shortcut below never looked up. A solid block within six
  // above the feet is a roof, whatever the light says and however high up.
  for (let dy = 2; dy <= 6; dy++) {
    const b = bot.blockAt(f.offset(0, dy, 0));
    if (b && b.boundingBox === "block") return false;
  }
  if (f.y >= SURFACE_Y - 7) {
    try {
      const sky = (bot.world as unknown as { getSkyLight: (p: Vec3) => number }).getSkyLight(f.offset(0, 1, 0));
      if (sky >= 15) return true;
    } catch {
      /* unloaded: fall through to the block scan */
    }
  }
  if (isBuried((x, y, z) => bot.blockAt(new Vec3(x, y, z)), f.x, f.y, f.z, 64)) return false;
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

    // Run 636: the two goal resets below cleared the drown reflex's jump key
    // while Forge was sinking; check the air before touching the pathfinder.
    if (headUnderWater(bot) && (bot.oxygenLevel ?? 20) < 16) {
      return {
        success: false,
        message: "Drowning — the drown reflex has the keys. Try escape_to_surface again once breathing.",
      };
    }
    // Stop any pathfinder goal fighting us for the controls. stop() alone
    // leaves the goal set, and the pathfinder tick cancels foreign digs while
    // a goal exists ("survived a 0s dig, Digging aborted" in a flooded shaft).
    try {
      bot.pathfinder.setGoal(null);
      bot.pathfinder.setGoal(null); // synchronous reset; stop() only raises a flag that kills the NEXT walk
    } catch {
      /* no goal */
    }

    const startY = feet(bot).y;
    // Height alone is not the surface: Flora sat at y=62 under ten blocks
    // of stone through runs 537 to 540 while this line sent her back.
    if (startY >= SURFACE_Y && canSeeSky(bot)) {
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
    let wetTurns = 0;
    let retreats = 0;

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
      // Sky, not height: Flora at y=62 under ten blocks of stone and Atlas
      // at y=61 "1 to go" both ended here with rock still overhead (run 541).
      if (canSeeSky(bot)) {
        bot.removeListener("death", onDeath);
        return {
          success: true,
          message: `Climbed out to y=${f.y} — back on the surface.`,
          stats: { fromY: startY, toY: f.y },
        };
      }
      step(
        `Carving a staircase up — y=${f.y}, ${Math.max(1, SURFACE_Y - f.y)} to go...`,
        Math.min(0.95, Math.max(0, f.y - startY) / Math.max(1, SURFACE_Y - startY)),
      );

      const [dx, dz] = dirs[dirIdx];
      // Run 687: two of the hour's three drownings were this staircase
      // opening a wall into a water pocket (Forge at y=48, Blade at y=43;
      // a 188 s dig with 0 air followed). Look at the cells about to be dug
      // and every block touching them; water there floods the stair, so
      // turn instead. Four wet turns in a row means boxed in by water.
      if (wouldFlood(bot, f.x, f.y, f.z, dx, dz)) {
        wetTurns++;
        // Run 737: the guard counts lava now, and this message still said
        // "water", which made a molten pocket read as a wet one in the log.
        // Name what is actually there, and where.
        const lavaHere = !!bot.findBlock({
          matching: (b) => b.name === "lava" || b.name === "flowing_lava",
          maxDistance: 4,
        });
        console.log(
          `[Escape] ${bot.username}: ${lavaHere ? "LAVA" : "water"} beside the stair toward (${dx}, ${dz}) at ${f.x},${f.y},${f.z}; turning (${wetTurns}/4)`,
        );
        // A wet pocket is survivable and a molten one is not: run 737 killed
        // Mason four times carving out of the portal chamber, every death
        // "tried to swim in lava". Tunnelling three blocks level to find
        // drier ground is what a bot should do beside water; beside lava it
        // is how the lake gets opened. Stop and let the march walk instead.
        if (lavaHere && wetTurns >= 2) {
          bot.removeListener("death", onDeath);
          return {
            success: false,
            message: `Lava pocket beside the stair at ${f.x},${f.y},${f.z}; stopped carving rather than opening it.`,
          };
        }
        dirIdx = (dirIdx + 1) % dirs.length;
        stallCount = 0;
        if (wetTurns >= 4) {
          // Runs 692-693: "boxed in" fired 75 and 28 times an hour because
          // the buried override re-invoked the climb from the same wet spot.
          // Before giving up, tunnel three blocks level along the driest
          // direction (fewest water blocks within three), then try again;
          // two such retreats per climb.
          if (retreats < 2) {
            retreats++;
            const dry = driestDirection(bot, f.x, f.y, f.z, dirs);
            console.log(
              `[Escape] ${bot.username}: boxed by water at y=${f.y}; tunnelling 3 blocks toward (${dry[0]}, ${dry[1]}) to dry ground (retreat ${retreats}/2)`,
            );
            for (let k = 1; k <= 3 && !signal.aborted; k++) {
              const cx = f.x + dry[0] * k;
              const cz = f.z + dry[1] * k;
              if (wouldFlood(bot, cx - dry[0], f.y, cz - dry[1], dry[0], dry[1]) && k > 1) break;
              await handDig(bot, cx, f.y, cz);
              await handDig(bot, cx, f.y + 1, cz);
              // Run 694: two bots "suffocated in a wall" right after this
              // retreat. A dig the server has not confirmed comes back on the
              // client 1.5 s later, and the walk had already pushed the bot
              // into it. Wait for the cells to read as air before stepping.
              await new Promise((r) => setTimeout(r, 800));
              const feetCell = bot.blockAt(new Vec3(cx, f.y, cz));
              const headCell = bot.blockAt(new Vec3(cx, f.y + 1, cz));
              if (!feetCell || !headCell || feetCell.boundingBox === "block" || headCell.boundingBox === "block") {
                console.log(
                  `[Escape] ${bot.username}: retreat cell at (${cx}, ${f.y}, ${cz}) still ${feetCell?.name ?? "?"}/${headCell?.name ?? "?"}; stopping the retreat`,
                );
                break;
              }
              try {
                await bot.lookAt(new Vec3(cx + 0.5, f.y + 1, cz + 0.5), true);
              } catch {
                /* look best-effort */
              }
              bot.setControlState("forward", true);
              await new Promise((r) => setTimeout(r, 700));
              bot.setControlState("forward", false);
            }
            wetTurns = 0;
            continue;
          }
          bot.removeListener("death", onDeath);
          return {
            success: false,
            message: `Boxed in by water at y=${f.y}: every stair direction opens into a water pocket. Move a few blocks along the cave and invoke_skill {"skill":"escape_to_surface"} again.`,
            stats: { fromY: startY, toY: f.y },
          };
        }
        continue;
      }
      wetTurns = 0;
      // One staircase step in this direction ends with the bot standing on the
      // block at (f+dir), one higher. Clear the two air blocks the bot will
      // occupy there, plus the block above its own head so it can rise.
      await handDig(bot, f.x + dx, f.y + 1, f.z + dz); // new feet
      await handDig(bot, f.x + dx, f.y + 2, f.z + dz); // new head
      await handDig(bot, f.x, f.y + 2, f.z); // own head clearance for the hop

      // The step block itself must be solid to stand on. If it's a hole, carve
      // it level for this move (walk forward flat) rather than stepping up.
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
      success: endY >= SURFACE_Y && canSeeSky(bot),
      message:
        endY >= SURFACE_Y
          ? `Reached the surface at y=${endY}.`
          : `Ran out of time at y=${endY} (started ${startY}). invoke_skill {"skill":"escape_to_surface"} again to continue.`,
      stats: { fromY: startY, toY: endY },
    };
  },
};
