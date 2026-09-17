import { Vec3 } from "vec3";
import { getBotMemoryStore } from "./memory-registry.js";
import type { Bot } from "mineflayer";
import pkg from "mineflayer-pathfinder";
import type { Move } from "mineflayer-pathfinder";
import { chooseDrownEscape } from "./drown-escape.js";
const { goals, Movements } = pkg;

/**
 * GoalNearXZ that also demands the arrival be at or above `minY`.
 *
 * Plain GoalNearXZ is satisfied by ANY y at the target column, and A* takes
 * the cheapest route there. Run 559: Blade's walk-home march reported "now 6
 * blocks from the village" at (288, 29, -309) — 41 blocks under the stash,
 * inside the cave system, pickless, at 2.6 hp. The escape reflex then spent
 * 20 minutes hand-carving stone to get back up. Requiring y >= minY makes the
 * pathfinder search for a surface route instead; when none exists the walk
 * rejects and the caller's stall guard yields, which beats a cave "arrival".
 * Below the floor the heuristic adds the vertical shortfall so A* climbs.
 */
export class GoalNearXZAbove extends goals.GoalNearXZ {
  constructor(
    x: number,
    z: number,
    range: number,
    public minY: number,
  ) {
    super(x, z, range);
  }
  heuristic(node: Move): number {
    const below = Math.max(0, this.minY - node.y);
    return super.heuristic(node) + below;
  }
  isEnd(node: Move): boolean {
    return node.y >= this.minY && super.isEnd(node);
  }
}

/**
 * Every Movements config in the codebase MUST start here.
 *
 * mineflayer-pathfinder defaults to maxDropDown=4 and allowParkour=true. Four
 * blocks is one block into fall-damage range, so the defaults actively route
 * bots off ledges. Fall damage has been the top death cause for weeks: capping
 * it in safeMoves and explorerMoves only covered 2 of the 22 construction
 * sites, and the other 20 kept walking bots off cliffs. Atlas took 19 of his
 * 22 deaths this way in a single 5h session.
 *
 * Callers layer their own flags on top (canDig, allow1by1towers, and so on).
 * Fall safety is not theirs to opt out of.
 */
export function baseMoves(bot: Bot): InstanceType<typeof Movements> {
  const moves = new Movements(bot);
  moves.maxDropDown = 3; // 3 blocks = no fall damage, 4 = 1.5 hearts
  moves.allowParkour = false;
  // Runs 658-666: Mason stepped off the same Nether ledge at (345, 57, -40)
  // into the lava sea on three days; the fortress sweep's own cap never
  // applied because every walk builds its moves here. In the Nether a
  // drop is a stair or a cliff over lava: two blocks, no more.
  if (String(bot.game?.dimension ?? "").includes("nether")) moves.maxDropDown = 2;
  // The library allows a drop of ANY height when the landing block is water.
  // Run 597: a flooded shaft beside the stash, water at (306, 50, -324) over
  // a 23-block hole to a dry cobblestone floor at y=27, took six deaths in
  // an hour (Blade x3, Mason x2, Atlas): "fell from a high place ... in=water
  // ... pathing=true" every time. A thin water layer over a pit is a trap;
  // drops into water now obey maxDropDown like every other drop.
  (moves as unknown as { infiniteLiquidDropdownDistance: boolean }).infiniteLiquidDropdownDistance = false;
  // Run 643: the cobblestone-roofed water channel at the village, water at
  // (401, 60..61, -312) under cobblestone at y=62, drowned Forge twice in an
  // hour and Blade twice the day before; every walk that dips into roofed
  // water is a drowning. The trade march has priced roofed water at +60
  // since run 583 without breaking its walks; open lakes cost nothing.
  // Every walk now carries the same step cost.
  const roofedWater = (b: { name?: string; position?: Vec3 }) => {
    if (!b?.position || !/^(water|kelp|kelp_plant|seagrass|tall_seagrass|bubble_column)$/.test(b.name ?? "")) return 0;
    for (let dy = 1; dy <= 3; dy++) {
      const a = bot.blockAt(b.position.offset(0, dy, 0));
      if (a && a.boundingBox === "block") return 60;
    }
    return 0;
  };
  // Run 648: Forge died twice at the same surface lava pool at (522, 69,
  // -504) on the village march, "tried to swim in lava". The pathfinder
  // never steps into lava but walks its rim, and a sprint or a knock does
  // the rest. A step whose horizontal neighbours or the block below them
  // hold lava costs +40, so routes keep a block back from the rim.
  const lavaEdge = (b: { name?: string; position?: Vec3 }) => {
    if (!b?.position) return 0;
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      for (const dy of [0, -1]) {
        const n = bot.blockAt(b.position.offset(dx, dy, dz));
        if (n && (n.name === "lava" || n.name === "flowing_lava")) return 40;
      }
    }
    return 0;
  };
  // Run 666: Forge walked back to the same block beside a lake three times
  // in ten minutes and a Drowned killed him there each time; the ledge above
  // repeats the same way. A step within five blocks of a spot where this bot
  // died in the last hour now costs +80, so routes bend around it.
  const recentDeaths = (getBotMemoryStore(bot)?.getDeaths() ?? []).filter((d) => {
    const t = d.timestamp ? Date.parse(d.timestamp) : NaN;
    return Number.isFinite(t) && Date.now() - t < 3_600_000;
  });
  const deathZone = (b: { position?: Vec3 }) => {
    const p = b.position;
    if (!p || recentDeaths.length === 0) return 0;
    for (const d of recentDeaths) {
      if (Math.abs(p.y - d.y) <= 4 && Math.hypot(p.x - d.x, p.z - d.z) <= 5) return 80;
    }
    return 0;
  };
  (moves as unknown as { exclusionAreasStep: ((b: never) => number)[] }).exclusionAreasStep = [
    roofedWater as unknown as (b: never) => number,
    lavaEdge as unknown as (b: never) => number,
    deathZone as unknown as (b: never) => number,
  ];
  // The pathfinder ships with door opening OFF ("causes issues on non-Paper
  // servers"). This is Paper. Three bots stalled 3 blocks from a bed inside
  // a plank house with a 44-node path planned around it (NavDiag, run 503).
  moves.canOpenDoors = true;
  // The lit village portal sits where everyone idles, and any path that
  // clips the doorway teleports the walker into the ghast gallery — Flora
  // and Forge both took that trip by accident within an hour of ignition.
  // Deliberate crossings use manual controls and are unaffected.
  const portalId = bot.registry.blocksByName.nether_portal?.id;
  if (portalId !== undefined) moves.blocksToAvoid.add(portalId);
  // (Tried avoiding chests as walkable blocks on 2026-09-11: in a village
  // carpeted with stash chests that made every route long enough to blow the
  // walk budget, stash failures went from 0 to 17 in ten minutes. Reverted;
  // the stall detector hops a wedged bot out instead.)
  //
  // A bot without a pickaxe never digs on a planned route. Every caller that
  // sets canDig = true (walk-home, explore below y=67, gather_wood below
  // y=63, the flee tunnel) let bare hands punch through dirt into a cave the
  // bot then could not leave: 13 "buried pickless" rescues in run 524 and 8
  // more in the first 15 minutes of run 526, each following one of those
  // walks, with Flora rescued from y=-38. Callers assign canDig after this
  // returns, so the guard is an accessor that keeps reading false.
  // liquidCost stays at the library default. A cost of 15 (cddfb3d, run
  // 588) made A* refuse or time out on ordinary village walks: "No path"
  // rejections went from 75 to 110 an hour to 240, stuck walks from 0 to 8
  // up to 59, the farm walk failed 24 times and the trade march never left
  // the stash. Water avoidance needs a narrower tool than a global cost.

  // Depth floor for everyone but the miner, in the overworld: no step down
  // below y=48. Run 583: Flora, the farmer, walked from the village to
  // (382, -53, -317) and spent the hour between y=-41 and y=-18 with six
  // climb-outs timing out at 240s each; Atlas dives the same way. The bots
  // can still fall, and mining skills run on Forge, who is exempt; the
  // Nether keeps its own depths.
  const inOverworld = /overworld/.test(String(bot.game?.dimension ?? "overworld"));
  if (bot.username !== "Forge" && inOverworld) {
    // 48 -> 56 (run 597/598): nine deaths in two hours at a flooded shaft
    // under the village, entered from a cave at y=50 to 55 that no non-miner
    // has any business in (Atlas: "path held with no keys at (301, 55,
    // -319)", then swept into the hole).
    const DEPTH_FLOOR = 56;
    const origNeighborsDepth = moves.getNeighbors.bind(moves);
    moves.getNeighbors = (node: any) =>
      origNeighborsDepth(node).filter((n: any) => !(n.y < node.y && n.y < DEPTH_FLOOR));
  }

  const pickless = !bot.inventory.items().some((i) => i.name.endsWith("_pickaxe"));
  if (pickless) {
    let wanted = moves.canDig;
    Object.defineProperty(moves, "canDig", {
      get: () => false,
      set: (v: boolean) => {
        wanted = v;
      },
      configurable: true,
      enumerable: true,
    });
    void wanted;
    // ...and never plans a step DOWN into a block the sky does not reach.
    // Cave mouths and the pits under the village are free downhill walking
    // to the planner (drops of 3 cost nothing), so XZ goals routed Flora
    // from the village surface to y=29 in the first minute of a biome roam
    // (run 527). Level and upward moves stay open so houses and bed rooms
    // remain reachable; a bot already underground can still walk out.
    const world = bot.world as unknown as { getSkyLight?: (p: Vec3) => number };
    const origNeighbors = moves.getNeighbors.bind(moves);
    moves.getNeighbors = (node: any) => {
      const out = origNeighbors(node);
      if (typeof world.getSkyLight !== "function") return out;
      return out.filter((n: any) => {
        if (n.y >= node.y) return true;
        try {
          // Only a step from lit ground into darkness is a cave mouth. A
          // bot already in shade (a hillside notch, under leaves) may keep
          // walking downhill: Atlas phantom-arrived thirty times on a hill
          // at y=81 with every downhill step refused (run 548).
          const from = world.getSkyLight!(new Vec3(node.x, node.y + 1, node.z));
          const to = world.getSkyLight!(new Vec3(n.x, n.y + 1, n.z));
          return !(from > 0 && to === 0);
        } catch {
          return true; // unloaded column: no opinion
        }
      });
    };
  }
  return moves;
}

/** Create safe movement defaults — no digging, no block placement, just walk/jump */
export function safeMoves(bot: Bot): InstanceType<typeof Movements> {
  const moves = baseMoves(bot);
  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowFreeMotion = false;
  moves.scafoldingBlocks = [];
  // Fall safety for the TEAM-WIDE default movement (go_to + every post-action
  // nav). The explorerMoves-only cap missed this path — bots still fell during
  // go_to, incl. into the mined-out pits around the base. Cap drop height (no
  // fall damage) and forbid parkour leaps so the pathfinder never routes over
  // a dangerous drop. Navigation caution, not a cheat.
  moves.maxDropDown = 3;
  moves.allowParkour = false;
  return moves;
}

/** Movement config for exploring — allows swimming across water (allowFreeMotion=true) */
export function explorerMoves(bot: Bot): InstanceType<typeof Movements> {
  const moves = baseMoves(bot);
  moves.canDig = false;
  moves.allow1by1towers = false;
  // NOT what the old comment claimed ("needed to route through water") — water
  // routing is liquidCost, and allowFreeMotion is only read when the goal has an
  // .entity (pathfinder index.js:421), so it is a no-op for explore's coordinate
  // goals. Where it DOES apply, entity goals, it walks a straight line at the
  // target with no drop check, which would defeat maxDropDown below. Left as-is
  // this round because no observed fall came from an entity goal; the fall
  // instrumentation in bot/index.ts will say whether that changes.
  moves.allowFreeMotion = true;
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
 * One pathfinder per bot, several writers: the active skill, the reactive
 * layer, and — the expensive one — ZOMBIE skills. The executor's 240s watchdog
 * frees the brain by resolving early, but the orphaned skill promise keeps
 * running until its own code notices the abort signal, and its cleanup paths
 * call pathfinder.stop(). Those one-shot stops land on whatever the NEXT skill
 * is doing: run 353 lost 10 of 15 pre-mine stash deposits to "Path was stopped"
 * / "The goal was changed", each within a second of a previous skill's timeout.
 *
 * The generation counter tells the two cases apart. Deliberate takeovers
 * (skill start, watchdog abort, direct-action timeout) bump it; safeGoto only
 * retries an interrupted walk while the generation it started under is still
 * current. A zombie's own goto sees the bumped generation and stays dead.
 */
const navGeneration = new WeakMap<Bot, number>();

/** True when a self-directed move toward `toward` would step into lava,
 *  fire, magma or a drop deeper than four blocks within two blocks of the
 *  bot. The hop and the step-off aim at the goal without a path (Forge:
 *  "tried to swim in lava" at y=-54 right after three 'No path' walks). */
function hazardToward(bot: Bot, toward: Vec3): boolean {
  const here = bot.entity.position;
  const dx = toward.x - here.x;
  const dz = toward.z - here.z;
  const len = Math.hypot(dx, dz) || 1;
  const bad = new Set(["lava", "flowing_lava", "fire", "soul_fire", "magma_block", "campfire", "soul_campfire"]);
  // Run 664: a 700 ms hop covers three blocks at a sprint; Mason walked off
  // the same Nether ledge at (345, 57, -40) twice, 29 blocks into lava, with
  // the drop one block past the old two-block look-ahead.
  for (const step of [1, 2, 3]) {
    const x = Math.floor(here.x + (dx / len) * step);
    const z = Math.floor(here.z + (dz / len) * step);
    const y = Math.floor(here.y);
    for (const dy of [1, 0, -1, -2]) {
      const b = bot.blockAt(new Vec3(x, y + dy, z));
      if (b && bad.has(b.name)) return true;
    }
    let drop = 0;
    for (let dy = -1; dy >= -5; dy--) {
      const b = bot.blockAt(new Vec3(x, y + dy, z));
      if (!b || b.boundingBox !== "empty") break;
      drop++;
    }
    if (drop >= 5) return true;
  }
  return false;
}

/** Blocks bare hands clear quickly, for a bot wedged in a pit or a bush. */
const SOFT_BLOCKS = new Set([
  "dirt",
  "grass_block",
  "coarse_dirt",
  "rooted_dirt",
  "podzol",
  "mud",
  "sand",
  "red_sand",
  "gravel",
  "clay",
  "snow",
  "snow_block",
  "moss_block",
]);
const phantomStreak = new WeakMap<Bot, { key: string; n: number }>();

/** Dig the hand-diggable blocks around a wedged bot: the four neighbours at
 *  feet and head level, and the two blocks overhead. Leaves, saplings and
 *  bushes count too. Bounded to eight blocks; returns how many were cleared. */
async function clearExit(bot: Bot): Promise<number> {
  const f = bot.entity.position.floored();
  const soft = (name: string) =>
    SOFT_BLOCKS.has(name) ||
    name.endsWith("_leaves") ||
    name.endsWith("_sapling") ||
    name.endsWith("_bush") ||
    name === "short_grass" ||
    name === "tall_grass" ||
    name === "fern";
  const targets: Vec3[] = [f.offset(0, 2, 0), f.offset(0, 1, 0)];
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    targets.push(f.offset(dx, 1, dz), f.offset(dx, 0, dz));
  }
  let cleared = 0;
  for (const p of targets) {
    if (cleared >= 8) break;
    const b = bot.blockAt(p);
    if (!b || !soft(b.name) || !bot.canDigBlock(b)) continue;
    try {
      await bot.dig(b);
      cleared++;
    } catch {
      /* next block */
    }
  }
  return cleared;
}

/** Short blocks a bot can end up standing inside, where the pathfinder stalls. */
const WEDGE_BLOCKS = new Set(["chest", "trapped_chest", "ender_chest", "barrel"]);

/** Last pathfinder result per bot, for the failure diagnostics below. */
const lastPath = new WeakMap<Bot, { status: string; length: number; at: number }>();
/** Why the pathfinder last threw its path away, and how often it has done so. */
const lastReset = new WeakMap<Bot, { reason: string; at: number; count: number }>();
/** The pathfinder's other lifecycle events, for the same diagnostics. Run
 *  531: Forge stalled with moving=false two seconds after a 23-node path was
 *  computed and no path_reset for 15 minutes; only a stop flag or a
 *  goal_reached clears a path silently. */
const lastEvents = new WeakMap<Bot, Record<string, { at: number; count: number }>>();
const pathTracked = new WeakSet<Bot>();
function trackPaths(bot: Bot): void {
  if (pathTracked.has(bot)) return;
  pathTracked.add(bot);
  bot.on("path_update" as any, (r: any) => {
    lastPath.set(bot, { status: String(r?.status ?? "?"), length: r?.path?.length ?? 0, at: Date.now() });
  });
  bot.on("path_reset" as any, (reason: any) => {
    const prev = lastReset.get(bot);
    lastReset.set(bot, { reason: String(reason), at: Date.now(), count: (prev?.count ?? 0) + 1 });
  });
  for (const ev of ["path_stop", "goal_updated", "goal_reached"]) {
    bot.on(ev as any, () => {
      const m = lastEvents.get(bot) ?? {};
      m[ev] = { at: Date.now(), count: (m[ev]?.count ?? 0) + 1 };
      lastEvents.set(bot, m);
    });
  }
}

function eventsNote(bot: Bot): string {
  const m = lastEvents.get(bot);
  if (!m) return "";
  return Object.entries(m)
    .map(([k, v]) => ` ${k}=${Math.round((Date.now() - v.at) / 1000)}s/${v.count}`)
    .join("");
}

/** One line naming why a walk failed: how far the goal was and what the
 *  planner last said (noPath / timeout / partial / success). Stash chests and
 *  farm plots a few blocks away were failing 'Navigation timed out' by the
 *  dozen with no way to tell "no path exists" from "too slow". */
function navDiag(bot: Bot, goal: any, reason: string): string {
  const p = bot.entity.position;
  const gx = goal?.x,
    gy = goal?.y,
    gz = goal?.z;
  const dist =
    Number.isFinite(gx) && Number.isFinite(gz)
      ? Math.hypot(p.x - gx, Number.isFinite(gy) ? p.y - gy : 0, p.z - gz).toFixed(1)
      : "?";
  const lp = lastPath.get(bot);
  const age = lp ? `${Math.round((Date.now() - lp.at) / 1000)}s ago` : "none";
  const lr = lastReset.get(bot);
  const evNote = eventsNote(bot);
  const resetNote = lr
    ? ` lastReset=${lr.reason}(${Math.round((Date.now() - lr.at) / 1000)}s ago, ${lr.count} total)`
    : " lastReset=none";
  // What the bot was physically doing: every failure so far had a full path
  // (lastPath=success), so the loss is in execution, and these fields say
  // whether it was moving, what it stood in, and whether a door was in the way.
  const pf = bot.pathfinder as any;
  const moving = pf?.isMoving?.() ?? "?";
  // The pathfinder holds a path yet sets no keys: name which of its internal
  // states (mining, building, a dig in flight, busy hands) is holding it.
  const pfState = `mining=${pf?.isMining?.() ?? "?"} building=${pf?.isBuilding?.() ?? "?"} digTarget=${bot.targetDigBlock ? "yes" : "no"} onGround=${bot.entity.onGround} y=${bot.entity.position.y.toFixed(2)} held=${bot.heldItem?.name ?? "none"} window=${bot.currentWindow?.type ?? "none"}`;
  const ctrl =
    Object.entries(bot.controlState ?? {})
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join("+") || "none";
  const vel = bot.entity.velocity ? Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z).toFixed(2) : "?";
  const feet = bot.blockAt(p)?.name ?? "?";
  const below = bot.blockAt(p.offset(0, -1, 0))?.name ?? "?";
  const door = bot.findBlock({
    matching: (b) => b.name.endsWith("_door") || b.name.endsWith("_trapdoor"),
    maxDistance: 3,
  });
  const doorNote = door ? ` door=${door.name}@${door.position.x},${door.position.y},${door.position.z}` : "";
  return `[NavDiag] ${bot.username} ${reason}: goal=${goal?.constructor?.name ?? "?"}(${gx},${gy},${gz}) dist=${dist} lastPath=${lp?.status ?? "-"}/${lp?.length ?? 0} (${age}) moving=${moving}${resetNote} ${pfState} ctrl=${ctrl} vel=${vel} feet=${feet} on=${below}${doorNote}${evNote}`;
}
export function bumpNavGeneration(bot: Bot): void {
  navGeneration.set(bot, (navGeneration.get(bot) ?? 0) + 1);
}
function getNavGeneration(bot: Bot): number {
  return navGeneration.get(bot) ?? 0;
}

/**
 * Wraps pathfinder.goto with a timeout and stall detection.
 * - Times out after `timeoutMs` (default 15s)
 * - Cancels if bot hasn't moved more than 0.3 blocks in 5 seconds AFTER movement begins
 * - Retries (max 2) when an external one-shot stop kills the walk, unless the
 *   nav generation advanced (meaning the stop was a deliberate takeover)
 * - `stallStartDelayMs`: grace period before stall detection activates (use when thinkTimeout is high)
 */
export async function safeGoto(bot: Bot, goal: any, timeoutMs = 15000, stallStartDelayMs = 0): Promise<void> {
  // CLAMP the search for height-only goals at the one chokepoint every walk
  // passes through. GoalY asks A* for "any block at that height" — a frontier
  // that is the whole map — and with dig-enabled movements the successor
  // branching is worst-case. Heap crash #5 fired seconds after an
  // underground-ascent GoalY(70): the water-escape wrap from crash #3 only
  // covered one of seven GoalY call sites. A vertical trip never legitimately
  // needs more than a few dozen blocks of search.
  const isGoalY = goal && goal.constructor && goal.constructor.name === "GoalY";
  const pf = bot.pathfinder as unknown as { searchRadius: number } | undefined;
  const priorRadius = isGoalY && pf ? pf.searchRadius : null;
  if (isGoalY && pf) pf.searchRadius = 48;
  const restoreRadius = () => {
    if (priorRadius !== null && pf) pf.searchRadius = priorRadius;
  };
  return new Promise<void>((resolve, reject) => {
    let lastPos = bot.entity.position.clone();
    let stallTicks = 0;
    let settled = false;
    let retries = 0;
    let unwedges = 0;
    // A hop-out in flight: set by the stall check before it stops the
    // pathfinder, consumed by the goto rejection handler, which performs the
    // hop once the pathfinder has actually let go of the controls.
    let hopPending: { aim: Vec3 | null } | null = null;
    // True while a pathfinder.goto() is outstanding. During the 3s retry
    // delay there is none, so a hop requested then has no rejection to ride
    // on (run 520: Mason floated in a water pocket at 403,61,-302 through
    // six hop requests, none of which ran).
    let gotoActive = false;
    // Every new walk is a new generation. Without this, a walk interrupted
    // by the caller's next walk retried itself 3s later with the OLD goal,
    // cancelling the new walk, which then retried too: 324 'interrupted
    // externally' lines for Blade in one hour while it stepped through the
    // stash chests, and every farm walk in the same boat.
    bumpNavGeneration(bot);
    trackPaths(bot);
    const genAtStart = getNavGeneration(bot);
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

    const onTimeout = () => {
      settled = true;
      clearInterval(stallCheck);
      if (stallDelayTimer) clearTimeout(stallDelayTimer);
      console.log(navDiag(bot, goal, "timed out")); // before stop(): stop clears the keys
      offPath();
      bot.pathfinder.setGoal(null);
      reject(new Error("Navigation timed out — goal may be unreachable."));
    };
    let timeout = setTimeout(onTimeout, timeoutMs);
    // Budget follows the plan: a 47-node path needs 10s+ of plain walking, and
    // stash and farm walks were being cut off at 15s with a valid path in
    // hand. When the planner reports a path, extend the timeout to cover it
    // (0.8s per node, capped at 60s), once per walk.
    let extended = false;
    const onPath = (r: any) => {
      if (settled || extended || r?.status !== "success" || !Array.isArray(r.path)) return;
      const need = Math.min(60_000, r.path.length * 800);
      if (need > timeoutMs) {
        extended = true;
        clearTimeout(timeout);
        timeout = setTimeout(onTimeout, need);
      }
    };
    bot.on("path_update" as any, onPath);
    const offPath = () => bot.removeListener("path_update" as any, onPath);

    const stallCheck = setInterval(() => {
      if (!stallActive) return;
      // Digging IS progress. The pathfinder stands still while it breaks each
      // block of a dig-through route, so a stall detector that only watches
      // position aborts every path that has to tunnel — which is why every
      // buried water/lava pool read as "path there is blocked" while canDig
      // was enabled the whole time.
      if (bot.targetDigBlock) {
        stallTicks = 0;
        lastPos = bot.entity.position.clone();
        return;
      }
      const currentPos = bot.entity.position;
      const moved = currentPos.distanceTo(lastPos);
      if (moved < 0.3) {
        stallTicks++;
        // Standing inside a chest (or similar short block): the pathfinder
        // cannot step the bot out, so hop it out ourselves and let the walk
        // resume. Two hops, then the stall is real.
        const feetName = bot.blockAt(currentPos)?.name ?? "";
        // The pathfinder's own dead loop (run 514, lastReset=stuck x28): it
        // looks at the next node, runs its physics simulation, and when
        // neither the straight-line nor the walk-jump simulation reaches
        // the node it RELEASES the forward key, stands still for 3.5s,
        // declares "stuck", re-plans the same path and repeats. On a chest
        // top or in water that is a silent standstill with no keys held.
        // Give it the step it will not take: forward and jump the way it is
        // already facing, three times at most per walk.
        const pfAny = bot.pathfinder as any;
        const keysHeld = Object.values(bot.controlState ?? {}).some(Boolean);
        const pfIdle =
          !!pfAny?.isMoving?.() && !pfAny?.isMining?.() && !pfAny?.isBuilding?.() && !keysHeld && !bot.targetDigBlock;
        if ((WEDGE_BLOCKS.has(feetName) || pfIdle) && unwedges < 3 && stallTicks >= 2) {
          if (!gotoActive) {
            stallTicks = 0; // a retry is about to start a fresh walk
            return;
          }
          unwedges++;
          console.log(
            `[Nav] ${bot.username} ${WEDGE_BLOCKS.has(feetName) ? `wedged in ${feetName}` : "path held with no keys"} at ${currentPos.floored()} — nudging along (${unwedges}/3)`,
          );
          // Aim the hop at a neighbour the bot can stand on (air at its level
          // or one step up, solid beneath) rather than wherever it faces:
          // twenty facing-direction hops left Mason on the same chest top.
          const f = currentPos.floored();
          // Collision shapes, not just boundingBox: a fence or wall is a
          // 'block' whose shape rises 1.5, so it is neither a floor nor an
          // empty foot space (run 521: five hops toward blocks beside the
          // chest at 289,70,-314 with the bot never moving).
          const topOf = (b: { shapes?: number[][] } | null) =>
            b?.shapes && b.shapes.length ? Math.max(...b.shapes.map((sh) => sh[4])) : 0;
          const clear = (b: ReturnType<typeof bot.blockAt>) => !!b && (b.boundingBox === "empty" || topOf(b) === 0);
          const standable = (x: number, y: number, z: number) => {
            const feetB = bot.blockAt(new Vec3(x, y, z));
            const headB = bot.blockAt(new Vec3(x, y + 1, z));
            const floorB = bot.blockAt(new Vec3(x, y - 1, z));
            return (
              clear(feetB) &&
              clear(headB) &&
              !!floorB &&
              floorB.boundingBox === "block" &&
              topOf(floorB) <= 1.0 &&
              !WEDGE_BLOCKS.has(floorB.name)
            );
          };
          // Candidates: the eight neighbours one step up, level, or one step
          // down (a chest pile is left by stepping DOWN off it; the level-only
          // scan found nothing at 289,70,-314 with solid walls either side).
          // Pick the one nearest the goal so the hop makes progress instead
          // of bouncing between two chest tops (run 517: 41 hops between
          // 281,69,-323 and 282,69,-323).
          const g = goal as unknown as { x?: number; y?: number; z?: number };
          const goalPos = typeof g?.x === "number" && typeof g?.z === "number" ? new Vec3(g.x, g.y ?? f.y, g.z) : null;
          let aim: Vec3 | null = null;
          let best = Infinity;
          for (const dy of [0, -1, 1]) {
            for (const [dx, dz] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
              [1, 1],
              [1, -1],
              [-1, 1],
              [-1, -1],
            ] as const) {
              if (!standable(f.x + dx, f.y + dy, f.z + dz)) continue;
              const c = new Vec3(f.x + dx + 0.5, f.y + dy, f.z + dz + 0.5);
              const score = goalPos ? c.distanceTo(goalPos) : Math.abs(dy) * 10;
              if (score < best) {
                best = score;
                aim = c;
              }
            }
          }
          // Take the controls away from the pathfinder first. Its monitor
          // runs every physics tick and, in the branch that stalled us, sets
          // forward and jump OFF, so a hop issued underneath it is overwritten
          // twenty times a second (66 nudges in run 516, Mason still in a
          // one-block trench at 206,68,-327). stop() takes effect on the NEXT
          // physics tick, where resetPath('stop') calls clearControlStates()
          // and rejects this walk with 'Path was stopped'. A hop issued on a
          // fixed 60ms timer raced that tick and lost (run 517: 60 hops, same
          // chest top before and after). So the hop is performed by the
          // rejection handler below, once the pathfinder has let go.
          hopPending = { aim };
          try {
            bot.pathfinder.setGoal(null);
          } catch {
            /* no path */
          }
          stallTicks = 0;
          lastPos = currentPos.clone();
          return;
        }
        if (stallTicks >= STALL_THRESHOLD) {
          clearTimeout(timeout);
          clearInterval(stallCheck);
          if (stallDelayTimer) clearTimeout(stallDelayTimer);
          console.log(navDiag(bot, goal, "stalled")); // before stop(): stop clears the keys
          offPath();
          bot.pathfinder.setGoal(null);
          // Where, and wedged in what.
          //
          // One bot produced 154 of 156 stuck events in a single hour while the
          // other four produced two between them, and mining went to zero ore.
          // He could still `explore` (82 blocks in one hop) but every targeted
          // navigation stalled, so the unstick rescue never fired: it keys on
          // real immobility and he was moving. Nothing recorded WHERE he was or
          // what surrounded him, which is the same gap that made the fall and
          // deposit investigations take days longer than they needed to.
          const sp = bot.entity.position;
          const around = [
            [1, 0, 0],
            [-1, 0, 0],
            [0, 0, 1],
            [0, 0, -1],
            [0, 1, 0],
            [0, -1, 0],
          ]
            .map(([dx, dy, dz]) => bot.blockAt(sp.offset(dx, dy, dz))?.name ?? "?")
            .join("/");
          console.log(
            `[Stuck] ${bot.username} at ${sp.x.toFixed(0)},${sp.y.toFixed(0)},${sp.z.toFixed(0)} ` +
              `sides=${around} onGround=${bot.entity.onGround}`,
          );
          settled = true;
          reject(new Error("Stuck — not making progress toward goal."));
        }
      } else {
        stallTicks = 0;
      }
      lastPos = currentPos.clone();
    }, STALL_CHECK_MS);

    const finishTimers = () => {
      clearTimeout(timeout);
      clearInterval(stallCheck);
      if (stallDelayTimer) clearTimeout(stallDelayTimer);
      offPath();
    };
    let rescueWaitLogged = false;
    const attempt = () => {
      if (settled) return; // outer timeout/stall fired during the retry delay
      // Run 631: 377 of 437 jump releases during drown rescues came from the
      // pathfinder walking a path that a retry here (or a skill) had set
      // while the reflex held the keys. A walk does not start or restart
      // while the bot's head is under water with short air; it waits for
      // the rescue and the outer timeout still bounds it.
      // < 16 matches the reflex's takeover threshold: run 633 still logged
      // 15 attempts setting goals at air 13 to 15 while the rescue ran.
      if (headUnderWater(bot) && (bot.oxygenLevel ?? 20) < 16) {
        if (!rescueWaitLogged) {
          rescueWaitLogged = true;
          console.log(`[Nav] ${bot.username} walk waits for the drown rescue (air ${bot.oxygenLevel})`);
        }
        setTimeout(attempt, 500); // attempt() returns at once if the walk settled meanwhile
        return;
      }
      // pathfinder.stop() only raises a flag; the library acts on it at the
      // next node arrival or path reset, and a flag raised during a stall
      // (never arriving) lands on the NEXT walk, whose first path reset then
      // emits path_stop and kills it ("Path was stopped" x13 per planting
      // pass in run 519). setGoal(null) resets synchronously and consumes any
      // lingering flag, so every walk starts clean. That is also why the
      // stall handlers above use setGoal(null) rather than stop().
      bot.pathfinder.setGoal(null);
      gotoActive = true;
      bot.pathfinder
        .goto(goal)
        .then(() => {
          gotoActive = false;
          if (settled) return;
          // Phantom arrival: the library resolves an EMPTY path as success
          // (goto.js checks path.length === 0 before status), which is what
          // a bot with no valid start node gets: sealed in stone (Flora,
          // 363,62,-281) or standing inside a short block in a pit (Blade,
          // 207,65,-310). Every walk "arrived" instantly and nothing ever
          // stalled. Verify the goal, jump once toward it, and fail loudly.
          const g = goal as unknown as { x?: number; y?: number; z?: number; isEnd?: (p: Vec3) => boolean };
          const here = bot.entity.position;
          const flat =
            typeof g?.x === "number" && typeof g?.z === "number" ? Math.hypot(here.x - g.x, here.z - g.z) : 0;
          const reached = typeof g?.isEnd === "function" ? g.isEnd(here.floored()) : true;
          if (!reached && flat > 4) {
            console.log(
              `[Nav] ${bot.username} phantom arrival at ${here.floored()}: goal ${flat.toFixed(0)} blocks away, no route from here`,
            );
            if (typeof g.x === "number" && typeof g.z === "number") {
              bot.lookAt(new Vec3(g.x, here.y + 1.6, g.z), true).catch(() => {});
            }
            // Third phantom in a row at the same spot: the hop is not enough
            // (Blade, 46 phantoms in a sapling pit with dirt on four sides
            // and leaves overhead, run 541). Clear the soft blocks around
            // head and feet by hand, then hop.
            const key = here.floored().toString();
            const ph = phantomStreak.get(bot);
            const streak = ph && ph.key === key ? ph.n + 1 : 1;
            phantomStreak.set(bot, { key, n: streak });
            const finish = () => {
              bot.setControlState("jump", true);
              bot.setControlState("forward", true);
              setTimeout(() => {
                bot.setControlState("jump", false);
                bot.setControlState("forward", false);
                settled = true;
                finishTimers();
                reject(
                  new Error("No route from here — the pathfinder found no valid start (sealed in or inside a block)."),
                );
              }, 700);
            };
            // Sixth phantom at the same spot with nothing soft to dig (Atlas,
            // 41 phantoms on a stone peak at 565,107,-838, run 551): a healthy
            // bot walks off the edge toward the goal instead. A drop of ten
            // costs three and a half hearts; a peak costs the whole night.
            const goalVec = typeof g.x === "number" && typeof g.z === "number" ? new Vec3(g.x, here.y, g.z) : null;
            if (streak >= 6 && streak % 3 === 0 && bot.health >= 8 && goalVec && !hazardToward(bot, goalVec)) {
              console.log(
                `[Nav] ${bot.username} stepping off toward the goal from ${here.floored()} (phantom streak ${streak})`,
              );
              bot.setControlState("forward", true);
              setTimeout(() => {
                bot.setControlState("forward", false);
                settled = true;
                finishTimers();
                reject(new Error("No route from here — stepped off the ledge toward the goal."));
              }, 1_500);
              return;
            }
            if (streak >= 3 && streak % 3 === 0) {
              clearExit(bot)
                .then((n) => {
                  if (n > 0)
                    console.log(`[Nav] ${bot.username} cleared ${n} soft blocks around ${here.floored()} to get out`);
                })
                .catch(() => {})
                .finally(finish);
            } else {
              finish();
            }
            return;
          }
          settled = true;
          finishTimers();
          resolve();
        })
        .catch((err: any) => {
          gotoActive = false;
          if (settled) return;
          // "Path was stopped" / "The goal was changed" are external one-shot
          // interruptions (usually a zombie skill's cleanup), never a verdict
          // on THIS route. Walk again — unless the generation advanced, which
          // means the stop was deliberate and this walk should stay dead.
          const interrupted = /stopped before it could be completed|goal was changed/i.test(err?.message ?? "");
          if (interrupted && hopPending && getNavGeneration(bot) === genAtStart) {
            // Our own stall hop: the pathfinder has released the controls, so
            // the keys we set now stick. Re-assert them every tick for the
            // hop's duration in case anything else clears them, then re-plan
            // from wherever the bot landed. Hops are budgeted by unwedges,
            // never by the interruption retries (run 517: three hops spent
            // both retries and the walk surfaced 'Path was stopped' to the
            // planting loop, 1 of 17 plots planted).
            const { aim } = hopPending;
            hopPending = null;
            // Run 658: a hop "toward facing" carried Mason off a Nether ledge,
            // 28 blocks into lava. With no aim, check the way the bot faces
            // (mineflayer's yaw: forward is -sin(yaw), -cos(yaw)).
            const yaw = bot.entity.yaw;
            const facingAim = aim ?? bot.entity.position.offset(-Math.sin(yaw) * 2, 0, -Math.cos(yaw) * 2);
            if (hazardToward(bot, facingAim)) {
              console.log(
                `[Nav] ${bot.username} hop toward ${aim ? aim.floored() : "facing"} skipped: lava, fire or a drop ahead`,
              );
              setTimeout(attempt, 3000);
              return;
            }
            const inWater = (bot.blockAt(bot.entity.position)?.name ?? "") === "water";
            // Climbing out of water onto a block takes longer than a dry hop.
            const holdMs = inWater ? 1300 : 700;
            console.log(
              `[Nav] ${bot.username} hop from ${bot.entity.position.floored()} toward ${aim ? aim.floored() : "facing"}${inWater ? " (in water)" : ""}`,
            );
            const from = bot.entity.position.clone();
            if (aim) bot.lookAt(aim, true).catch(() => {});
            const hold = setInterval(() => {
              bot.setControlState("jump", true);
              bot.setControlState("forward", true);
            }, 50);
            // Instrumented (third fix on this hop): what the body did mid-hop.
            setTimeout(
              () => {
                const e = bot.entity;
                console.log(
                  `[HopDebug] ${bot.username} mid-hop: yaw=${e.yaw.toFixed(2)} vel=${e.velocity.x.toFixed(2)},${e.velocity.y.toFixed(2)},${e.velocity.z.toFixed(2)} onGround=${e.onGround} ctrl=${Object.entries(
                    bot.controlState ?? {},
                  )
                    .filter(([, v]) => v)
                    .map(([k]) => k)
                    .join(
                      ",",
                    )} pfMoving=${!!(bot.pathfinder as any)?.isMoving?.()} goal=${(bot.pathfinder as any)?.goal ? "set" : "none"}`,
                );
              },
              Math.floor(holdMs / 2),
            );
            setTimeout(() => {
              clearInterval(hold);
              bot.setControlState("jump", false);
              bot.setControlState("forward", false);
              const moved = bot.entity.position.distanceTo(from);
              console.log(
                `[HopDebug] ${bot.username} hop end: moved ${moved.toFixed(2)} to ${bot.entity.position.floored()}`,
              );
              lastPos = bot.entity.position.clone();
              setTimeout(attempt, 400);
            }, holdMs);
            return;
          }
          if (interrupted && retries < 2 && getNavGeneration(bot) === genAtStart) {
            retries++;
            console.log(`[Nav] ${bot.username} goto interrupted externally — retry ${retries}/2`);
            // 3s, up from 1: interruption tug-of-wars produced retry storms
            // that each spawn a fresh A* context — the storm rate is what
            // stacked pathfinder allocations into the heap crashes.
            setTimeout(attempt, 3000);
            return;
          }
          settled = true;
          finishTimers();
          if (!interrupted)
            console.log(`[Nav] ${bot.username} goto rejected: ${String(err?.message ?? err).slice(0, 90)}`);
          reject(err);
        });
    };
    attempt();
  }).finally(restoreRadius);
}

/**
 * Walk over nearby dropped items so they enter the inventory. Digging a block
 * only spawns a drop — without this, bots "gather" wood that stays on the
 * ground (the root cause of phantom inventory reports).
 */
/** Toss bulk junk until at least `minFree` slots are open. A full pocket
 *  refuses ground pickups AND chest withdrawals silently — the bug that ate
 *  a week of leather and ten gold ore. Call before any pickup that matters. */
/** Food item names a hungry bot must always have room for. */
export const FOOD_DROP =
  /porkchop|beef|mutton|chicken|rabbit|^cod$|salmon|bread|potato|carrot|apple|cooked_|melon_slice|sweet_berries/;

// Run 655: Mason stood on a porkchop at 0.4 blocks with zero free slots and
// gained nothing; the junk list below found nothing to toss in a builder's
// pack of planks, sand and seeds. With allowBulk a caller that needs room
// for food may also drop the biggest stack of cheap bulk.
const BULK = new Set([
  "sand",
  "red_sand",
  "sandstone",
  "wheat_seeds",
  "beetroot_seeds",
  "melon_seeds",
  "pumpkin_seeds",
  "oak_sapling",
  "birch_sapling",
  "spruce_sapling",
  "oak_leaves",
  "birch_leaves",
  "spruce_leaves",
  "oak_planks",
  "birch_planks",
  "spruce_planks",
  "oak_log",
  "birch_log",
  "spruce_log",
  "stick",
  "white_wool",
  "clay_ball",
  "flint",
  "feather",
  "rotten_flesh",
  "bone",
  "string",
  "kelp",
  "seagrass",
  "short_grass",
  "snowball",
  "mossy_cobblestone",
  "stone",
  "deepslate",
  "calcite",
  "moss_block",
  "mud",
]);

export async function shedJunk(bot: Bot, minFree = 2, allowBulk = false): Promise<number> {
  if (bot.inventory.emptySlotCount() >= minFree) return 0;
  const JUNK = new Set([
    "cobblestone",
    "cobbled_deepslate",
    "dirt",
    "gravel",
    "andesite",
    "diorite",
    "granite",
    "tuff",
    "netherrack",
    "blackstone",
  ]);
  let tossed = 0;
  for (const it of bot.inventory.items()) {
    if (bot.inventory.emptySlotCount() >= minFree) break;
    if (JUNK.has(it.name)) {
      await bot.toss(it.type, null, it.count).catch(() => {});
      tossed++;
    }
  }
  if (allowBulk && bot.inventory.emptySlotCount() < minFree) {
    const bulk = bot.inventory
      .items()
      .filter((it) => BULK.has(it.name) && !FOOD_DROP.test(it.name))
      .sort((x, y) => y.count - x.count);
    for (const it of bulk) {
      if (bot.inventory.emptySlotCount() >= minFree) break;
      await bot.toss(it.type, null, it.count).catch(() => {});
      tossed++;
      console.log(`[Pocket] ${bot.username} dropped ${it.count} ${it.name} to make room for food`);
    }
  }
  if (tossed > 0) console.log(`[Pocket] ${bot.username} shed ${tossed} stacks to make room`);
  return tossed;
}

function logDrop(
  bot: Bot,
  drop: { id: number; position: Vec3; isValid?: boolean },
  itemName: string,
  startGap: number,
  walkNote: string,
  countBefore: number,
): void {
  const gained = bot.inventory.items().reduce((n, i) => n + i.count, 0) - countBefore;
  const still = bot.entities[drop.id];
  const endGap = still ? still.position.distanceTo(bot.entity.position) : NaN;
  console.log(
    `[DropDetail] ${bot.username}: ${itemName} ${startGap.toFixed(1)} blocks away -> ${walkNote}, now ${still ? `${endGap.toFixed(1)} blocks away, entity still listed` : "entity gone"}, pack ${gained >= 0 ? "+" : ""}${gained}, bot at ${bot.entity.position.floored()}, free slots ${bot.inventory.emptySlotCount()}`,
  );
}

export async function collectNearbyDrops(bot: Bot, radius = 8, maxMs = 8000): Promise<void> {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 800)); // let drops finish falling
  const tried = new Set<number>();
  // Run 651: Flora killed four chickens at 1.4 blocks and "picked up no
  // meat". Count what the client can see and what the pack gained.
  const seenAtStart = Object.values(bot.entities).filter(
    (e) => e.name === "item" && e.position.distanceTo(bot.entity.position) < radius,
  ).length;
  const slotsBefore = bot.inventory.items().reduce((n, i) => n + i.count, 0);
  while (Date.now() - start < maxMs) {
    const drop = Object.values(bot.entities)
      .filter((e) => e.name === "item" && !tried.has(e.id) && e.position.distanceTo(bot.entity.position) < radius)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (!drop) break;
    tried.add(drop.id);
    // Run 654: Flora walked onto the drops of six sheep and six pigs and
    // gained nothing while Atlas and Mason pick up fine. Name each drop and
    // what happened at it, so the gap has a shape.
    const itemName = (() => {
      try {
        return (drop as unknown as { getDroppedItem?: () => { name?: string } | null }).getDroppedItem?.()?.name ?? "?";
      } catch {
        return "?";
      }
    })();
    const startGap = drop.position.distanceTo(bot.entity.position);
    if (bot.inventory.emptySlotCount() === 0 && FOOD_DROP.test(itemName)) {
      await shedJunk(bot, 1, true).catch(() => {});
    }
    const countBefore = bot.inventory.items().reduce((n, i) => n + i.count, 0);
    let walkNote = "arrived";
    try {
      // Stand exactly on the drop's block — GoalNear(r=1) can stop just outside
      // the pickup radius. An unreachable drop falls through to the next one.
      const p = drop.position.floored();
      await safeGoto(bot, new goals.GoalBlock(p.x, p.y, p.z), 6000);
      await new Promise((r) => setTimeout(r, 400)); // pickup tick
    } catch (e) {
      walkNote = `walk failed: ${((e as Error)?.message ?? String(e)).slice(0, 50)}`;
      // Drop lodged in the canopy? Punch out the leaf it rests on/in so it
      // falls to walkable ground, then allow one retry. Leaf-lodged drops were
      // the top wood-loss cause (78% of chopped logs never collected).
      try {
        const at = bot.blockAt(drop.position.floored());
        const under = bot.blockAt(drop.position.floored().offset(0, -1, 0));
        const leaf = [at, under].find((b) => b && b.name.includes("leaves"));
        if (leaf && bot.entity.position.distanceTo(leaf.position) < 5) {
          await Promise.race([
            bot.dig(leaf),
            new Promise<void>((_, rej) =>
              setTimeout(() => {
                try {
                  bot.stopDigging();
                } catch {
                  /* not digging */
                }
                rej(new Error("leaf dig timeout"));
              }, 5000),
            ),
          ]);
          tried.delete(drop.id); // it can fall now — retry on a later pass
          await new Promise((r) => setTimeout(r, 600)); // let it fall
        }
      } catch {
        /* leaf out of reach — leave the drop */
      }
      logDrop(bot, drop, itemName, startGap, walkNote, countBefore);
      continue;
    }
    logDrop(bot, drop, itemName, startGap, walkNote, countBefore);
  }
  const gained = bot.inventory.items().reduce((n, i) => n + i.count, 0) - slotsBefore;
  console.log(
    `[Drops] ${bot.username}: ${seenAtStart} item entities within ${radius} at start, walked to ${tried.size}, pack +${gained} items`,
  );
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
  // Digging-capable, but still fall-capped: this runs when a bot is stuck in a
  // mined-out pit, which is exactly where the big drops are.
  const moves = baseMoves(bot);
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
/**
 * Blocks the drowning escape must never dig through.
 *
 * The first time the dig-out fired it logged "digging up through chest": a bot
 * destroyed team storage to save itself, scattering whatever was banked in it.
 * A drowning costs one respawn; a broken stash chest can scatter hundreds of
 * items the team spent hours gathering. Bedrock is here because it cannot be
 * broken at all and the attempt just wastes the remaining air.
 */
const PRECIOUS_BLOCKS = [
  "chest",
  "barrel",
  "shulker",
  "furnace",
  "smoker",
  "blast_furnace",
  "crafting_table",
  "brewing_stand",
  "enchanting_table",
  "anvil",
  "bed",
  "hopper",
  "dispenser",
  "dropper",
  "beacon",
  "bedrock",
  "spawner",
];

export function isPreciousBlock(name: string): boolean {
  return PRECIOUS_BLOCKS.some((p) => name.includes(p));
}

/**
 * Is the bot's head under water the way the SERVER measures it: at eye
 * height, counting water-logged blocks (kelp, seagrass, bubble columns)?
 * The old check read the block one above the feet. With a fractional y
 * above ~0.38 (any swimmer) that is a different block from the eye block,
 * and run 561 had Mason at air -1 with the reflex reporting "not in water".
 */
export function headUnderWater(bot: Bot): boolean {
  const eye = bot.blockAt(bot.entity.position.offset(0, (bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62, 0));
  const head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
  const watery = (b: ReturnType<typeof bot.blockAt>) => {
    if (!b) return false;
    if (b.name === "water" || b.name === "bubble_column" || /kelp|seagrass/.test(b.name)) return true;
    try {
      return (b.getProperties() as { waterlogged?: string | boolean }).waterlogged === true;
    } catch {
      return false;
    }
  };
  return watery(eye) || (watery(head) && (bot.oxygenLevel ?? 20) < 20);
}

const swimTraceActive = new WeakMap<Bot, boolean>();
/**
 * Where each bot last had its head in air. Run 634: Atlas and Blade each
 * drowned "pinned" a few blocks inside roofed water, digging bare-handed
 * digs of 19 to 188 s with under 12 s of air, when the way they swam in
 * was still open behind them.
 */
const lastAirPos = new WeakMap<Bot, Vec3>();
/** Where the last retreat period started, to tell a pinned retreat from a moving one. */
const lastRetreatFrom = new WeakMap<Bot, Vec3>();
/** When each bot's head went under, for an elapsed-time air estimate. */
const submergedSince = new WeakMap<Bot, number>();
const lastAirLagLog = new WeakMap<Bot, number>();
/** Last server air value seen and when it last changed, to tell a stale reading from a breathing bot. */
const lastServerAir = new WeakMap<Bot, { value: number; changedAt: number }>();
/** Last time the server reported air under 6; a bot whose air has stayed at 6
 *  or more for twenty seconds of submersion is breathing between bobs. */
const lastLowAirAt = new WeakMap<Bot, number>();
/** Until when the drown reflex is running a dig it means to finish. */
const rescueDigUntil = new WeakMap<Bot, number>();
export function rescueDigging(bot: Bot): boolean {
  return (rescueDigUntil.get(bot) ?? 0) > Date.now();
}
/** Bots whose control-key setters already carry the drown key trace. */
const keyTraceInstalled = new WeakSet<Bot>();
/**
 * Run 630: Forge reached air -1 five times with air one jump away, and the
 * swim trace showed jump held at t=5 and gone by t=15 with the reflex still
 * running. Something else owns the keys mid-rescue. Log who releases jump
 * or clears the keys while a rescue trace is live.
 */
function installDrownKeyTrace(bot: Bot): void {
  if (keyTraceInstalled.has(bot)) return;
  keyTraceInstalled.add(bot);
  const caller = () =>
    (new Error().stack ?? "")
      .split("\n")
      .slice(3, 6)
      .map((l) => l.trim().replace(/^at /, ""))
      .join(" <- ");
  const origSet = bot.setControlState.bind(bot);
  bot.setControlState = (control, state) => {
    if (control === "jump" && !state && swimTraceActive.get(bot) && bot.getControlState("jump")) {
      console.log(`[DrownKeys] ${bot.username} jump released by ${caller()}`);
    }
    return origSet(control, state);
  };
  const origClear = bot.clearControlStates.bind(bot);
  bot.clearControlStates = () => {
    if (swimTraceActive.get(bot) && bot.getControlState("jump")) {
      console.log(`[DrownKeys] ${bot.username} keys cleared by ${caller()}`);
    }
    return origClear();
  };
}
const lastDrownPos = new WeakMap<Bot, Vec3>();
const lastShoreGap = new WeakMap<Bot, number>();

const lastSwimYieldLog = new WeakMap<Bot, number>();
export async function escapeWaterIfDrowning(bot: Bot): Promise<boolean> {
  if (!headUnderWater(bot)) {
    lastAirPos.set(bot, bot.entity.position.clone());
    submergedSince.delete(bot);
    return false; // head not submerged → breathing fine
  }
  if (!submergedSince.has(bot)) submergedSince.set(bot, Date.now());

  // When air is actually running out, this reflex must WIN the controls: the
  // pathfinder re-asserts movement every tick, so 1.2s rescue bursts lost the
  // tug-of-war against an underwater goal (Blade drowned 16x in one run
  // mining lake-bed iron — rescued, shoved back down, drowned). Stop the
  // pathfinder + any dig before swimming; the brain re-plans afterwards.
  // Run 641: Blade's trace read air 17 at t=30 and 0 at t=50, one second
  // apart, under gravel; the client's air value arrives late, so every
  // threshold here fired with the air already gone. Air drains one point
  // a second under water, so take the lower of the server's value and an
  // estimate from the time the head has been under.
  const serverAir = bot.oxygenLevel ?? 20;
  const localAir = 20 - Math.floor((Date.now() - (submergedSince.get(bot) ?? Date.now())) / 1000);
  // Run 642: the estimate alone over-fired 44 times an hour ("server 20,
  // elapsed-based 14") on bots bobbing at the surface, whose air the server
  // was refilling. A server value that has not moved for three seconds
  // while the head is under is the stale case; only then does the estimate
  // take over.
  const prev = lastServerAir.get(bot);
  if (!prev || prev.value !== serverAir) lastServerAir.set(bot, { value: serverAir, changedAt: Date.now() });
  const serverStale = !!prev && prev.value === serverAir && Date.now() - prev.changedAt > 3_000;
  // Run 668: Forge sat in a sealed one-block water column for an hour with
  // the server's air held at 7 to 15 the whole time; he was breathing at the
  // top of it. The elapsed estimate read -247 and every dig through the cap
  // was aborted at a budget built from that number. A server value that has
  // held above 5 for twenty seconds is a bot that breathes; trust it.
  // Run 669: his air bobbed 20 -> 7 -> 20, so "unchanged for twenty seconds"
  // never held. Breathing is air that has stayed at 6 or more for twenty
  // seconds of submersion, whatever it does in between.
  if (serverAir < 6) lastLowAirAt.set(bot, Date.now());
  const submergedMs = Date.now() - (submergedSince.get(bot) ?? Date.now());
  const breathing = serverAir >= 6 && submergedMs > 20_000 && Date.now() - (lastLowAirAt.get(bot) ?? 0) > 20_000;
  const air = breathing ? serverAir : serverStale ? Math.min(serverAir, localAir) : serverAir;
  if (serverStale && serverAir - localAir >= 5 && Date.now() - (lastAirLagLog.get(bot) ?? 0) > 15_000) {
    lastAirLagLog.set(bot, Date.now());
    console.log(`[Drown] ${bot.username} air reading stale: server ${serverAir} unchanged, elapsed-based ${localAir}`);
  }
  // <16, up from <12: Mason drowned four times in one night with a shore ONE
  // BLOCK away — at air 15 the pathfinder still owned the controls (an
  // underwater mining goal dragging him along a flooded tunnel), and by the
  // time the old threshold stopped it the ceiling fight was already lost.
  // Surface swimmers bob at ~20 air, so a genuine sub-16 reading while
  // head-submerged means trouble, never a routine lake crossing.
  // Run 602: the setGoal trace named this reflex as the goal-setter that
  // killed three march legs in a row at the open lake at (396, 61, -370):
  // a surface swimmer with the pathfinder holding jump reads air 10 as his
  // head bobs, the reflex cleared the goal every three seconds, and the leg
  // loop re-issued it, so the crossing never finished ("enclosed at air=10,
  // no diggable route — up=air" is that same swimmer). A live goal in open
  // water near the surface with air to spare is a swim, and the pathfinder
  // keeps it. The takeover below still runs under a roof, without a goal,
  // or once air falls under 8.
  {
    const feet = bot.entity.position.floored();
    const above = [1, 2, 3].map((dy) => bot.blockAt(feet.offset(0, dy, 0)));
    const roofed = above.some((b) => !!b && b.boundingBox === "block");
    const nearSurface = above.slice(1).some((b) => !!b && b.name === "air");
    let moving = false;
    try {
      moving = !!bot.pathfinder.goal && bot.pathfinder.isMoving();
    } catch {
      moving = false;
    }
    if (!roofed && nearSurface && moving && air >= 8) {
      const last = lastSwimYieldLog.get(bot) ?? 0;
      if (Date.now() - last > 15_000) {
        lastSwimYieldLog.set(bot, Date.now());
        console.log(
          `[Drown] ${bot.username} open-water swim with a live goal at air=${air} — leaving the keys to the pathfinder`,
        );
      }
      return false;
    }
  }

  if (air < 16) {
    // Deliberate takeover: without the bump, safeGoto reads this stop as an
    // external one-shot and re-plans the same walk 3s later, dragging the
    // bot back under. Run 560: Atlas (air=7, surface one block up), Forge x3
    // and Flora all drowned inside "goto interrupted externally — retry 1/2".
    bumpNavGeneration(bot);
    // Swim from the first instant. Run 576's trace: Forge sank for a whole
    // three-second period with no keys held, because setGoal(null) below
    // runs resetPath, which clears every control state, and the keys only
    // came back after the shore scan and the dig race. Reset only when a
    // goal is actually set, and hold jump before anything else.
    bot.setControlState("jump", true);
    try {
      if (bot.pathfinder.goal) bot.pathfinder.setGoal(null);
    } catch {
      /* best effort */
    }
    try {
      bot.stopDigging();
    } catch {
      /* wasn't digging */
    }
  }

  // Find the nearest dry shore: a solid block with air above, scanned over fixed
  // offset rings (NOT a findBlock predicate that calls blockAt — that silently
  // matches nothing). Prefer the closest.
  const base = bot.entity.position.floored();
  // Pinned: the body did not move since the last period. Run 576: Blade and
  // Mason sat in one-block water pockets under a ceiling at velocity zero
  // with keys held, and the dig was skipped for exceeding the air budget.
  // With nowhere to swim, a slow dig is the only move left.
  const lastPos = lastDrownPos.get(bot);
  // 0.6, up from 0.3: Mason (run 581) drifted 0.05 blocks per five ticks
  // against a wall under stone, about 0.4 per period, and never qualified.
  // A swimming bot covers 1.5 to 3 blocks per period.
  let pinned = !!lastPos && lastPos.distanceTo(bot.entity.position) < 0.6;
  lastDrownPos.set(bot, bot.entity.position.clone());
  let shore = null as ReturnType<typeof bot.blockAt> | null;
  let swimTo: Vec3 | null = null; // set when a hopeless dig turns into a retreat toward known air
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

  // Drowning is 32% of all deaths and this rescue leaves no trace, so there is
  // no way to tell which of three things is happening: it never fires, it fires
  // but finds no shore within 8 blocks, or it fires and loses the tug-of-war
  // with the pathfinder (documented above: Blade drowned 16x while being
  // rescued and shoved back under). Logged only when air is actually dropping,
  // since this runs on a 3s timer per bot.
  // No progress toward the shore since the last period counts as pinned
  // too: run 587's drownings drifted 0.03 blocks a tick along a wall under
  // stone, never nearer the shore, and the dig waited until the air was gone.
  if (shore?.position) {
    const gapNow = shore.position.distanceTo(bot.entity.position);
    const gapLast = lastShoreGap.get(bot);
    if (gapLast !== undefined && gapLast - gapNow < 0.5) pinned = true;
    lastShoreGap.set(bot, gapNow);
  } else {
    lastShoreGap.delete(bot);
  }

  if (air < 16) {
    const s = shore?.position;
    console.log(
      `[Drown] ${bot.username} air=${air} at (${base.x},${base.y},${base.z}) ` +
        `shore=${s ? `${s.x},${s.y},${s.z}` : "NONE"} pathfinderStopped=${air < 16}`,
    );
  }

  // DIG OUT when enclosed. Instrumentation showed the rescue firing correctly,
  // finding a shore every time, stopping the pathfinder, and the bot drowning
  // anyway: air 8 -> 9 -> 5 -> 0 while its position moved one block, at y=15.
  //
  // That is a flooded cave passage, not a lake. The shore scan accepts any
  // solid block with air above within 8 blocks and never checks reachability,
  // so it picked a spot 4 blocks away THROUGH SOLID ROCK. Swimming and jumping
  // at a stone ceiling does nothing, which is why the rescue could work exactly
  // as written and still be useless.
  //
  // A player in that spot digs up. The bots carry pickaxes, so give them the
  // same move once air is genuinely short.
  //
  // It only ever looked UP. When that block was precious it logged "will not dig
  // it" and gave up, and the bot drowned against the ceiling with three
  // untouched stone walls beside it — Mason 5 times and Atlas 4 times in one
  // hour, all a few blocks from the stash, all under a chest. Refusing to dig
  // the chest is still right; refusing to look anywhere else is what killed them.
  // <13, up from <10: digging through a wall takes seconds and the old
  // threshold started it with three hearts of air left.
  if (air < 13) {
    const p = bot.entity.position;
    const neighbours = {
      up: bot.blockAt(p.offset(0, 2, 0)),
      north: bot.blockAt(p.offset(0, 1, -1)),
      south: bot.blockAt(p.offset(0, 1, 1)),
      east: bot.blockAt(p.offset(1, 1, 0)),
      west: bot.blockAt(p.offset(-1, 1, 0)),
    };
    const escape = chooseDrownEscape(neighbours);
    // Digging while afloat in water is 25x slower (5x submerged, 5x off the
    // ground): stone with a stone pick is ~29s, and an oxygen unit lasts
    // 0.75s. Forge dug "up through stone" at air=11 three times in run 560
    // and drowned inside the dig every time, with a shore two blocks away.
    // Only dig when mineflayer's own estimate fits the air left (plus the
    // seconds drowning damage buys), or when there is nowhere to swim.
    // "up" counts: a water column overhead IS the swim route. Run 561: Blade
    // at the foot of a 14-block shaft started a 187s dig north instead.
    const swimRoute = Object.values(neighbours).some((b) => b && (b.name === "water" || b.name === "air"));
    const budgetMs = Math.max(0, air) * 750 + Math.max(0, bot.health - 2) * 500;
    // Run 639: Forge's "dig up through stone needs 187.5s" was a bare-hand
    // figure measured with the sword or torch he happened to hold, while a
    // stone pickaxe sat in his pack. digTime and bot.dig both use the held
    // item, so put the best pick in hand before either.
    if (escape) {
      const pick =
        bot.inventory.items().find((i) => i.name === "diamond_pickaxe") ??
        bot.inventory.items().find((i) => i.name === "iron_pickaxe") ??
        bot.inventory.items().find((i) => i.name === "stone_pickaxe") ??
        bot.inventory.items().find((i) => i.name === "wooden_pickaxe");
      if (pick && bot.heldItem?.name !== pick.name) {
        await bot.equip(pick, "hand").catch(() => {});
      }
    }
    const needMs = escape ? bot.digTime(neighbours[escape.direction]!) : 0;
    const retreat = lastAirPos.get(bot);
    // Run 628: Blade stood on the bottom of two-deep water at (359, 61, -314)
    // with air two blocks up, counted as pinned because the shore gap never
    // closed, and the reflex dug north through cobblestone with 1 air left.
    // A breath is one held jump away whenever the block above the head is
    // air; the dig must yield to that whatever the pinned flag says.
    const airAbove = !!neighbours.up && neighbours.up.name === "air";
    if (escape && airAbove) {
      console.log(
        `[Drown] ${bot.username} air two blocks up at air=${air} — jumping for a breath instead of digging ${escape.direction}`,
      );
    } else if (escape && needMs > budgetMs && retreat && retreat.distanceTo(bot.entity.position) <= 24) {
      // Run 638: Forge died twice pinned under stone with the straight-line
      // retreat pressing forward+jump into rock, 3 and 22 blocks from air.
      // When a retreat period moved the bot under half a block, hand the
      // route to the pathfinder, which can go around the rock; the swim
      // step keeps re-asserting jump underneath it.
      const from = lastRetreatFrom.get(bot);
      const pinnedRetreat = !!from && from.distanceTo(bot.entity.position) < 0.5;
      lastRetreatFrom.set(bot, bot.entity.position.clone());
      if (pinnedRetreat) {
        console.log(
          `[Drown] ${bot.username} retreat toward ${retreat.floored()} is pinned — pathing there instead (air ${air})`,
        );
        try {
          bot.pathfinder.setGoal(new goals.GoalNear(retreat.x, retreat.y, retreat.z, 1));
        } catch {
          /* no path — the swim step still holds jump */
        }
      } else {
        swimTo = retreat;
      }
      console.log(
        `[Drown] ${bot.username} dig ${escape.direction} through ${escape.block.name} needs ${(needMs / 1000).toFixed(1)}s > ${(budgetMs / 1000).toFixed(1)}s of air — retreating toward last air at ${retreat.floored()} (${retreat.distanceTo(bot.entity.position).toFixed(1)} blocks)`,
      );
    } else if (escape && needMs > budgetMs && swimRoute && !pinned) {
      console.log(
        `[Drown] ${bot.username} skipping ${escape.direction} dig through ${escape.block.name}: ` +
          `${(needMs / 1000).toFixed(1)}s > ${(budgetMs / 1000).toFixed(1)}s of air — swimming for the shore`,
      );
    } else if (escape) {
      try {
        console.log(
          `[Drown] ${bot.username} enclosed at air=${air}${pinned ? " and pinned" : ""} — digging ${escape.direction} through ${escape.block.name} (${(needMs / 1000).toFixed(1)}s)`,
        );
        // Bound the dig by the air budget: a dig that overruns it must not
        // hold the reflex (and its swim) hostage until the bot is dead.
        let timer: NodeJS.Timeout | undefined;
        // A breathing bot in a sealed column can afford the whole dig; an
        // abort at the budget throws the server's progress away every time.
        const digWindowMs = breathing ? needMs + 10_000 : Math.max(1000, budgetMs);
        if (breathing && needMs > budgetMs) {
          console.log(
            `[Drown] ${bot.username} breathing at air ${air} in a sealed column — finishing the ${escape.direction} dig through ${escape.block.name} (${(needMs / 1000).toFixed(0)}s)`,
          );
        }
        if (breathing) rescueDigUntil.set(bot, Date.now() + digWindowMs);
        await Promise.race([
          bot.dig(neighbours[escape.direction]!),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              try {
                bot.stopDigging();
              } catch {
                /* not digging */
              }
              resolve();
            }, digWindowMs);
          }),
        ]).finally(() => {
          clearTimeout(timer);
          rescueDigUntil.set(bot, 0);
        });
      } catch {
        /* couldn't dig (no tool, or interrupted) — fall through to swimming */
      }
    } else {
      // Every route water, unloaded, or too valuable to break. Name them, so
      // the next look at this knows which of those three it was.
      const seen = Object.entries(neighbours)
        .map(([d, b]) => `${d}=${b?.name ?? "?"}`)
        .join(" ");
      console.log(`[Drown] ${bot.username} enclosed at air=${air}, no diggable route — ${seen}`);
    }
  }

  // Swim trace (drowning is past three fixes; instrument before patching
  // again). Run 575: Forge sat at (361, 23, -301) with the shore reported one
  // block away at (360, 23, -302) for 70 seconds of "swimming for the shore"
  // and drowned. Every fifth tick for three seconds: where the body is, how
  // it moves, what keys are down, what the eye and feet are in.
  if (air < 12 && !swimTraceActive.get(bot)) {
    installDrownKeyTrace(bot);
    swimTraceActive.set(bot, true);
    let ticks = 0;
    const target = shore?.position;
    const onTick = () => {
      ticks++;
      if (ticks % 5 === 0) {
        const e = bot.entity;
        const b = (dy: number) => bot.blockAt(e.position.offset(0, dy, 0))?.name ?? "?";
        const keys = ["forward", "back", "left", "right", "jump", "sprint"]
          .filter((k) => bot.getControlState(k as "forward"))
          .join("+");
        console.log(
          `[DrownTrace] ${bot.username} t=${ticks} air=${bot.oxygenLevel} pos=${e.position.x.toFixed(2)},${e.position.y.toFixed(2)},${e.position.z.toFixed(2)} vel=${e.velocity.x.toFixed(2)},${e.velocity.y.toFixed(2)},${e.velocity.z.toFixed(2)} keys=${keys || "none"} ground=${e.onGround} feet=${b(0)} head=${b(1)} eye=${bot.blockAt(e.position.offset(0, (e as { eyeHeight?: number }).eyeHeight ?? 1.62, 0))?.name ?? "?"} above=${b(2)} yaw=${e.yaw.toFixed(2)} pitch=${e.pitch.toFixed(2)} shore=${target ? `${target.x},${target.y},${target.z}` : "none"} goal=${bot.pathfinder.goal ? "set" : "none"}`,
        );
      }
      if (ticks >= 60) {
        bot.removeListener("physicsTick", onTick);
        swimTraceActive.set(bot, false);
      }
    };
    bot.on("physicsTick", onTick);
  }

  try {
    const swimTarget = swimTo ?? shore?.position ?? null;
    // Run 665: Blade and Forge drowned pressing forward+jump into a stone
    // ceiling for fifty ticks, looking steeply at an air point 4 blocks up
    // (Blade) or 22 blocks down (Forge). Under a roof, look level so the
    // keys carry the bot sideways out from under it, and let it sink toward
    // an air point that is well below instead of holding jump into the rock.
    const roofBlock = bot.blockAt(bot.entity.position.offset(0, 2, 0));
    const roofed = !!roofBlock && roofBlock.boundingBox === "block";
    const dyTarget = swimTarget ? swimTarget.y - bot.entity.position.y : 0;
    const wantJump = !(roofed && dyTarget < -3);
    bot.setControlState("jump", wantJump); // swim upward toward the surface for air
    if (swimTarget) {
      if (roofed) {
        await bot.lookAt(new Vec3(swimTarget.x + 0.5, bot.entity.position.y + 1.6, swimTarget.z + 0.5));
        if (Date.now() - (lastAirLagLog.get(bot) ?? 0) > 3000) {
          lastAirLagLog.set(bot, Date.now());
          console.log(
            `[Drown] ${bot.username} roofed by ${roofBlock?.name}: swimming level toward ${swimTarget.floored()} (dy ${dyTarget.toFixed(1)}, jump ${wantJump ? "held" : "released"})`,
          );
        }
      } else {
        await bot.lookAt(swimTarget.offset(0.5, 1.5, 0.5));
      }
      bot.setControlState("forward", true);
      // No sprint: sprinting in water puts the player in the swimming pose,
      // whose eye height is 0.4, so a bobbing bot breathes only at the top
      // of each bob (run 576: Forge on the lake surface, air stuck at 5).
      bot.setControlState("sprint", false);
    }
    // Run 636: Forge sank from y=39 to 31 with air 12 -> 4 holding forward
    // only; a strip_mine setGoal, a walk retry and this reflex's own reset
    // had each cleared the jump key inside this two-second wait. Re-assert
    // the keys every five ticks while the head is still under.
    for (let i = 0; i < 8; i++) {
      await bot.waitForTicks(5);
      if (!headUnderWater(bot)) break;
      if (wantJump && !bot.getControlState("jump")) bot.setControlState("jump", true);
      if (swimTarget && !bot.getControlState("forward")) bot.setControlState("forward", true);
    }
  } catch {
    /* best effort — timer retries */
  } finally {
    // Keep swimming while the head is still under: clearing the keys for the
    // last second of every 3s period let the bot sink back each time.
    if (!headUnderWater(bot)) {
      bot.setControlState("forward", false);
      bot.setControlState("jump", false);
      bot.setControlState("sprint", false);
    }
  }
  return true;
}
