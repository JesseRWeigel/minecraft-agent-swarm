import type { Bot } from "mineflayer";
import pkg from "mineflayer-pathfinder";
import { chooseDrownEscape } from "./drown-escape.js";
const { goals, Movements } = pkg;

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

/** Short blocks a bot can end up standing inside, where the pathfinder stalls. */
const WEDGE_BLOCKS = new Set(["chest", "trapped_chest", "ender_chest", "barrel"]);

/** Last pathfinder result per bot, for the failure diagnostics below. */
const lastPath = new WeakMap<Bot, { status: string; length: number; at: number }>();
const pathTracked = new WeakSet<Bot>();
function trackPaths(bot: Bot): void {
  if (pathTracked.has(bot)) return;
  pathTracked.add(bot);
  bot.on("path_update" as any, (r: any) => {
    lastPath.set(bot, { status: String(r?.status ?? "?"), length: r?.path?.length ?? 0, at: Date.now() });
  });
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
  // What the bot was physically doing: every failure so far had a full path
  // (lastPath=success), so the loss is in execution, and these fields say
  // whether it was moving, what it stood in, and whether a door was in the way.
  const moving = (bot.pathfinder as any)?.isMoving?.() ?? "?";
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
  return `[NavDiag] ${bot.username} ${reason}: goal=${goal?.constructor?.name ?? "?"}(${gx},${gy},${gz}) dist=${dist} lastPath=${lp?.status ?? "-"}/${lp?.length ?? 0} (${age}) moving=${moving} ctrl=${ctrl} vel=${vel} feet=${feet} on=${below}${doorNote}`;
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
      bot.pathfinder.stop();
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
        if (WEDGE_BLOCKS.has(feetName) && unwedges < 2 && stallTicks >= 2) {
          unwedges++;
          console.log(
            `[Nav] ${bot.username} wedged in ${feetName} at ${currentPos.floored()} — hopping out (${unwedges}/2)`,
          );
          bot.setControlState("jump", true);
          bot.setControlState("forward", true);
          setTimeout(() => {
            bot.setControlState("jump", false);
            bot.setControlState("forward", false);
          }, 700);
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
          bot.pathfinder.stop();
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
    const attempt = () => {
      if (settled) return; // outer timeout/stall fired during the retry delay
      bot.pathfinder
        .goto(goal)
        .then(() => {
          if (settled) return;
          settled = true;
          finishTimers();
          resolve();
        })
        .catch((err: any) => {
          if (settled) return;
          // "Path was stopped" / "The goal was changed" are external one-shot
          // interruptions (usually a zombie skill's cleanup), never a verdict
          // on THIS route. Walk again — unless the generation advanced, which
          // means the stop was deliberate and this walk should stay dead.
          const interrupted = /stopped before it could be completed|goal was changed/i.test(err?.message ?? "");
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
export async function shedJunk(bot: Bot, minFree = 2): Promise<number> {
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
  if (tossed > 0) console.log(`[Pocket] ${bot.username} shed ${tossed} junk stacks to make room`);
  return tossed;
}

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
      continue;
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

export async function escapeWaterIfDrowning(bot: Bot): Promise<boolean> {
  const head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
  if (!head || head.name !== "water") return false; // head not submerged → breathing fine

  // When air is actually running out, this reflex must WIN the controls: the
  // pathfinder re-asserts movement every tick, so 1.2s rescue bursts lost the
  // tug-of-war against an underwater goal (Blade drowned 16x in one run
  // mining lake-bed iron — rescued, shoved back down, drowned). Stop the
  // pathfinder + any dig before swimming; the brain re-plans afterwards.
  const air = bot.oxygenLevel ?? 20;
  // <16, up from <12: Mason drowned four times in one night with a shore ONE
  // BLOCK away — at air 15 the pathfinder still owned the controls (an
  // underwater mining goal dragging him along a flooded tunnel), and by the
  // time the old threshold stopped it the ceiling fight was already lost.
  // Surface swimmers bob at ~20 air, so a genuine sub-16 reading while
  // head-submerged means trouble, never a routine lake crossing.
  if (air < 16) {
    try {
      bot.pathfinder.stop();
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

  // Drowning is 32% of all deaths and this rescue leaves no trace, so there is
  // no way to tell which of three things is happening: it never fires, it fires
  // but finds no shore within 8 blocks, or it fires and loses the tug-of-war
  // with the pathfinder (documented above: Blade drowned 16x while being
  // rescued and shoved back under). Logged only when air is actually dropping,
  // since this runs on a 3s timer per bot.
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
    if (escape) {
      try {
        console.log(
          `[Drown] ${bot.username} enclosed at air=${air} — digging ${escape.direction} through ${escape.block.name}`,
        );
        await bot.dig(neighbours[escape.direction]!);
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
