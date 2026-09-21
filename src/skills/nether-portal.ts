// src/skills/nether-portal.ts
//
// Build the frame, light it, step through, and be able to come home.
//
// The return trip is not decoration. The Nether is 8:1, so a bot that walks
// away from its arrival portal cannot navigate back by overworld coordinates,
// and it is carrying the iron the whole plan was spent acquiring.

import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { findSiteFlexible, firstObstacle, type BlockKind } from "./portal-siting.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import type { Skill, SkillResult } from "./types.js";
import { framePositions, interiorPositions, ignitionTarget } from "./portal-geometry.js";
import { acquireObsidian, placeScaffold } from "./obsidian.js";
import { craftFlintAndSteel } from "./flint-and-steel.js";
import { fillBucket, isSourceBlock, LAVA_DEPTH, type Vec3Like } from "./fluid.js";
import { digDownTo } from "./descend.js";
import { baseMoves, safeGoto } from "../bot/navigation.js";
import { persistentSet, persistBlacklist, persistentRecord, persistRecord } from "./blacklists.js";

const REQUIRED = ["bucket", "flint_and_steel"] as const;

export function readinessOf(names: string[]): { ready: boolean; missing: string[] } {
  const has = (want: string) =>
    want === "bucket"
      ? names.some((n) => n === "bucket" || n === "water_bucket" || n === "lava_bucket")
      : names.includes(want);
  const missing = REQUIRED.filter((r) => !has(r));
  return { ready: missing.length === 0, missing: [...missing] };
}

/** Where each bot's portal is, so it can find its way back. */
const portals = new Map<string, { origin: Vec3Like; axis: "x" | "z" }>();

/**
 * The site a bot has already started building on. Without this, every retry
 * sited a fresh frame wherever the bot happened to be standing — the hour's
 * log shows "No clear 4x5 space" alternating with "frame is not complete"
 * as the site moved between attempts, scattering partial frames that could
 * never individually finish. Casting resumes on a remembered site because
 * castInPlace counts already-obsidian positions as done.
 */
const plannedSites = new Map<string, { origin: Vec3Like; axis: "x" | "z" }>(
  Object.entries(persistentRecord<{ origin: Vec3Like; axis: "x" | "z" }>("plannedSites")),
);
const savePlannedSites = () => persistRecord("plannedSites", Object.fromEntries(plannedSites));

/**
 * Frames that hold banked obsidian, keyed by origin, independent of which bot
 * built them. Per-bot plannedSites dies with abandons, overwrites and role
 * churn; the blocks stay in the world. Anyone passing within resume range
 * adopts the nearest banked frame instead of prospecting fresh.
 */
const bankedFrames = persistentRecord<{
  origin: Vec3Like;
  axis: "x" | "z";
  banked?: number;
  lavaStrikes?: number;
  lastStrikeAt?: number;
  lastProgressAt?: number;
}>("bankedFrames");
const saveBankedFrames = () => persistRecord("bankedFrames", bankedFrames);
// A banked frame whose lava keeps proving unreachable is a trap, not an
// asset: the 5-block frame at 392 sat beside a pool sealed under a lake —
// 500+ commute legs funneled the whole swarm into a walk that could never
// end in a pour. Three strikes retire the frame as a commute/adopt target;
// its blocks stay in the world and the registry, but the swarm stops
// pilgrimage to lava that is not there.
const LAVA_STRIKE_LIMIT = 3;
// Recent progress overrides strikes: the strike system benched TWO frames
// that were actively casting — approach failures from 19 and even 100
// blocks out counted the same as the lake-trap's point-blank futility. A
// frame that banked a block in the last six hours has proven its lava
// works; pathing noise cannot retire it. The lake-trap signature (days
// without a single cast) still benches on schedule.
// A day, widened from six hours after the third strike-system misfire: the
// 9/10 frame re-accumulated strikes from failures logged 43 and 111 blocks
// away and was three hours from benching itself. A frame with obsidian
// this fresh is alive; only a full day of zero progress — the lake-trap
// signature — may retire one.
const PROGRESS_SHIELD_MS = 24 * 60 * 60_000;
const frameLavaDead = (e: { lavaStrikes?: number; lastProgressAt?: number }) =>
  (e.lavaStrikes ?? 0) >= LAVA_STRIKE_LIMIT &&
  (!e.lastProgressAt || Date.now() - e.lastProgressAt > PROGRESS_SHIELD_MS);
const RESUME_RANGE = 48;

/**
 * Lava pools the march keeps failing to reach. Atlas burned three runs at a
 * pool guarded by a cavern his sink refused to cross and his walk could not
 * route around — the same nearest-first trap as the drowned ore. Three
 * fell-short endings for the same pool and the next search looks elsewhere.
 */
const lavaFails = new Map<string, number>();
const badLava = persistentSet("badLava");
const lavaKey = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
function recordLavaFellShort(p: { x: number; y: number; z: number }): void {
  const k = lavaKey(p);
  const n = (lavaFails.get(k) ?? 0) + 1;
  lavaFails.set(k, n);
  if (n >= 3) {
    badLava.add(k);
    persistBlacklist("badLava", badLava);
  }
}

export function recordPortal(bot: Bot, origin: Vec3Like, axis: "x" | "z"): void {
  portals.set(bot.username, { origin, axis });
}

export function lastPortal(botName: string): { origin: Vec3Like; axis: "x" | "z" } | undefined {
  return portals.get(botName);
}

/**
 * Place the frame against existing solid blocks. bot.placeBlock needs a
 * REFERENCE block and a face vector to build off, not a target coordinate
 * (src/skills/build-bridge.ts:95), so a position with nothing below it yet
 * cannot be placed on the first pass. Floor first, then jambs bottom-up, then
 * the lintel -- each row gives the next something solid to build against.
 * Run the whole loop twice: the second pass catches whatever the first left
 * behind once earlier rows filled in the missing support.
 */
async function placeFrame(bot: Bot, origin: Vec3Like, axis: "x" | "z"): Promise<void> {
  const frame = framePositions(origin, axis);
  const floor = frame.filter((p) => p.y === origin.y - 1);
  const jambs = frame.filter((p) => p.y >= origin.y && p.y < origin.y + 3).sort((a, b) => a.y - b.y);
  const lintel = frame.filter((p) => p.y === origin.y + 3);
  const ordered = [...floor, ...jambs, ...lintel];

  for (let pass = 0; pass < 2; pass++) {
    for (const pos of ordered) {
      const target = new Vec3(pos.x, pos.y, pos.z);
      if (bot.blockAt(target)?.name === "obsidian") continue;

      const held = bot.inventory.items().find((i) => i.name === "obsidian");
      if (!held) return; // out of obsidian; nothing left to place with

      let below = bot.blockAt(target.offset(0, -1, 0));
      if (!below || below.name === "air") {
        // The lintel spans the interior, so its support cells are air by
        // definition — Atlas stalled at 8/10 with two spare blocks in his
        // pack over exactly this. Borrow the cast's scaffold trick; the
        // interior clear that precedes ignition digs the scaffold back out.
        if (pos.y === origin.y + 3) {
          // One floating support cannot exist — its own below is interior
          // air as well ("no scaffold blocks to support 293,74,-310" with a
          // full pack of dirt). Build the column up from the floor; the
          // interior clear before ignition digs it all back out.
          for (let h = 0; h <= 2; h++) {
            const cell = new Vec3(pos.x, origin.y + h, pos.z);
            const cur = bot.blockAt(cell);
            if (cur && cur.name !== "air" && cur.name !== "cave_air") continue;
            await placeScaffold(bot, { x: cell.x, y: cell.y, z: cell.z });
          }
          below = bot.blockAt(target.offset(0, -1, 0));
        }
        if (!below || below.name === "air") continue; // nothing to build off yet, catch it next pass
      }

      await bot.equip(held, "hand");
      await bot.placeBlock(below, new Vec3(0, 1, 0)).catch(() => {});
    }
  }
}

/**
 * Dig a portal-shaped void out of the rock. Cave geometry beside a lava
 * pocket almost never has a natural 4x5 clearance — two runs arrived at the
 * pool and died on "No clear 4x5 space within 16 blocks". The bot carries a
 * pickaxe and stone is free; carving the frame's volume (plus a standing
 * pocket in front) turns any wall beside the lava into a site. Bounded per
 * dig and overall, best effort — the caller re-probes afterwards.
 */
async function carveSite(bot: Bot, origin: Vec3Like, axis: "x" | "z"): Promise<void> {
  const pick = bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
  if (!pick) return;
  await bot.equip(pick, "hand").catch(() => {});

  const cells = [...framePositions(origin, axis), ...interiorPositions(origin, axis)];
  // A standing pocket in front of the frame so the caster can work it.
  const front = interiorPositions(origin, axis).map((c) =>
    axis === "x" ? { x: c.x, y: c.y, z: c.z + 1 } : { x: c.x + 1, y: c.y, z: c.z },
  );
  const deadline = Date.now() + 90_000;
  for (const cell of [...cells, ...front]) {
    if (Date.now() > deadline) return;
    const b = bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
    if (!b || b.name === "air" || b.name === "cave_air" || b.name === "water" || b.name === "lava") continue;
    if (b.name === "obsidian" || b.name === "bedrock") continue;
    // Step toward cells outside the ~4.5 dig reach. The first wild carve left
    // a floor cell solid ("carve left: frame cell ... is solid") because the
    // digger swung from one standing spot and far cells failed silently.
    if (bot.entity.position.distanceTo(b.position) > 4.3) {
      try {
        await safeGoto(bot, new goals.GoalNear(cell.x, cell.y, cell.z, 2), 10_000);
      } catch {
        /* the dig below will fail fast if still out of reach */
      }
    }
    try {
      await Promise.race([
        bot.dig(b),
        new Promise((_, rej) => setTimeout(() => rej(new Error("dig timeout")), 12_000)),
      ]);
    } catch {
      bot.stopDigging();
    }
  }
}

// Walk INTO a lit portal and stand through the four-second transition. The
// pathfinder refuses to path into portal blocks and village mobs interrupt
// the approach, so this is a time-budgeted loop in the walk-armor pattern:
// re-approach after a hijack, walk the last step on manual controls, stand
// still inside until the dimension flips.
/**
 * Is the bot close enough to the standing spot for a four second walk to carry
 * it into the portal?
 *
 * Run 756: every trip that hour ended "Couldn't cross the portal this trip",
 * and the geometry line says why. The cells sit at y=56 and 57, and Mason was
 * at "290.7,50.0,-309.3", six blocks below and seven away, with dirt ahead of
 * him. The approach walk had failed, its error was swallowed, and the code
 * pressed forward anyway, which from down there is walking into the hillside
 * under the frame. Holding the key for longer cannot fix a bot that is not
 * beside the door.
 */
export function readyToStepIn(distance: number, dy: number): boolean {
  return distance <= 2.5 && Math.abs(dy) <= 1;
}

/**
 * Run 712: twenty-three crossing attempts ended with inPortal=false at 1.2 to
 * 2.1 blocks from the doorway centre, and three earlier fixes aimed at the
 * walk itself. Before a fourth, record what the bot is actually standing in,
 * which portal cells exist, which side of the plane it is on, and whether the
 * four-second walk moved it at all.
 */
function logPortalGeometry(bot: Bot, doorway: Vec3, centre: Vec3, walkFrom: Vec3): void {
  try {
    const p = bot.entity.position;
    const cells = bot.findBlocks({ matching: (b) => b.name === "nether_portal", maxDistance: 8, count: 40 });
    const xs = cells.map((c) => c.x);
    const zs = cells.map((c) => c.z);
    const ys = cells.map((c) => c.y);
    const span = (v: number[]) => (v.length ? `${Math.min(...v)}..${Math.max(...v)}` : "none");
    const axis = cells.length > 1 && Math.max(...xs) - Math.min(...xs) > Math.max(...zs) - Math.min(...zs) ? "x" : "z";
    let nearest: { x: number; y: number; z: number } | null = null;
    let nd = Infinity;
    for (const c of cells) {
      const d = Math.hypot(c.x + 0.5 - p.x, c.y - p.y, c.z + 0.5 - p.z);
      if (d < nd) {
        nd = d;
        nearest = c;
      }
    }
    const nameAt = (dx: number, dy: number, dz: number) => bot.blockAt(p.offset(dx, dy, dz))?.name ?? "unloaded";
    const yaw = bot.entity.yaw;
    const fx = -Math.sin(yaw);
    const fz = Math.cos(yaw);
    const wantYaw = Math.atan2(-(centre.x - p.x), centre.z - p.z);
    const moved = p.distanceTo(walkFrom);
    console.log(
      `[PortalDebug] ${bot.username}: at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} feet=${nameAt(0, 0, 0)} head=${nameAt(0, 1, 0)} ` +
        `ahead=${nameAt(Math.round(fx), 0, Math.round(fz))} aheadHead=${nameAt(Math.round(fx), 1, Math.round(fz))} ` +
        `cells=${cells.length} axis=${axis} x[${span(xs)}] y[${span(ys)}] z[${span(zs)}] ` +
        `doorway=${doorway.x},${doorway.y},${doorway.z} nearestCell=${nearest ? `${nearest.x},${nearest.y},${nearest.z}` : "none"} nearDist=${nd.toFixed(2)} ` +
        `yaw=${yaw.toFixed(2)} wantYaw=${wantYaw.toFixed(2)} movedInWalk=${moved.toFixed(2)} onGround=${bot.entity.onGround}`,
    );
  } catch (e) {
    console.log(`[PortalDebug] ${bot.username}: geometry read failed: ${String(e).slice(0, 80)}`);
  }
}

/**
 * Pick a portal cell the bot can actually walk into, and the spot to walk
 * from. Run 713 instrumentation: Mason stood at (287.7, 58, -311.5) facing
 * the right way with the portal one block ahead and moved 0.02 blocks in
 * four seconds, because the cell ahead of him was the TOP row of a 3-high
 * portal and his head was against the obsidian lintel. The only floor on
 * that side sits one block too high; the same portal is walkable from the
 * far side at y=57. So choose the cell whose head space is also portal, and
 * a standing spot beside it with a floor, rather than whatever findBlock
 * returned first.
 */
function findPortalEntry(bot: Bot, near: Vec3): { cell: Vec3; stand: Vec3 } | null {
  // Run 744: four crossings failed with "cells=0 ... nearDist=Infinity" while
  // Mason stood at (290, 42, -322), nineteen blocks below the doorway and in
  // a flooded cave. Twenty-four blocks is not far enough to see the portal
  // he arrived by.
  const cells = bot.findBlocks({ matching: (b) => b.name === "nether_portal", maxDistance: 48, count: 80 });
  if (cells.length === 0) return null;
  const passable = (v: Vec3) => {
    const n = bot.blockAt(v)?.name;
    return n === "air" || n === "nether_portal" || n === "cave_air";
  };
  const solid = (v: Vec3) => {
    const b = bot.blockAt(v);
    return !!b && b.boundingBox === "block";
  };
  // Cells varying in z sit in a plane whose normal runs along x, and the
  // other way round; step out along the normal to stand.
  const xs = cells.map((c) => c.x);
  const zs = cells.map((c) => c.z);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanZ = Math.max(...zs) - Math.min(...zs);
  const normals: Vec3[] =
    spanZ >= spanX ? [new Vec3(1, 0, 0), new Vec3(-1, 0, 0)] : [new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
  let best: { cell: Vec3; stand: Vec3; score: number } | null = null;
  for (const c of cells) {
    const cell = new Vec3(c.x, c.y, c.z);
    // Head room: the bot is two blocks tall, so the cell above must be open.
    if (!passable(cell.offset(0, 1, 0))) continue;
    for (const n of normals) {
      const stand = cell.plus(n);
      if (!passable(stand) || !passable(stand.offset(0, 1, 0))) continue;
      if (!solid(stand.offset(0, -1, 0))) continue;
      const score = bot.entity.position.distanceTo(stand) + (cell.y - Math.min(...cells.map((k) => k.y))) * 0.5;
      if (!best || score < best.score) best = { cell, stand, score };
    }
  }
  if (!best) return null;
  console.log(
    `[Portal] ${bot.username}: entry cell ${best.cell.x},${best.cell.y},${best.cell.z} from ${best.stand.x},${best.stand.y},${best.stand.z} (${cells.length} cells, doorway hint ${near.x},${near.y},${near.z})`,
  );
  return { cell: best.cell, stand: best.stand };
}

export async function crossPortal(
  bot: Bot,
  doorway: Vec3,
  budgetMs: number,
  arrived: (dim: string) => boolean = isNether,
): Promise<boolean> {
  const inPortal = () => bot.blockAt(bot.entity.position)?.name === "nether_portal";
  const deadline = Date.now() + Math.max(20_000, budgetMs);
  let entry = findPortalEntry(bot, doorway);
  let centre = entry
    ? new Vec3(entry.cell.x + 0.5, entry.cell.y + 0.5, entry.cell.z + 0.5)
    : new Vec3(doorway.x + 0.5, doorway.y + 0.5, doorway.z + 0.5);
  while (Date.now() < deadline) {
    if (arrived(dimensionOf(bot))) return true;
    if (!inPortal()) {
      // Re-read the geometry each lap: a respawn or a rejoin can leave the
      // bot on the other side of the frame, where a different cell works.
      entry = findPortalEntry(bot, doorway) ?? entry;
      if (entry) centre = new Vec3(entry.cell.x + 0.5, entry.cell.y + 0.5, entry.cell.z + 0.5);
    }
    const stand = entry?.stand;
    if (stand && bot.entity.position.distanceTo(stand.offset(0.5, 0, 0.5)) > 1.2 && !inPortal()) {
      bot.pathfinder.setMovements(baseMoves(bot));
      await safeGoto(bot, new goals.GoalBlock(stand.x, stand.y, stand.z), 20_000).catch(() => {});
    } else if (!stand && bot.entity.position.distanceTo(centre) > 2.5 && !inPortal()) {
      // With no cell in sight the bot has wandered off the doorway, often
      // down a cave. Walking back needs a real budget and a little slack,
      // not the twenty seconds and one-block goal that was here: run 744
      // spent twenty-three attempts pressing forward from nineteen blocks
      // below the frame.
      const far = bot.entity.position.distanceTo(centre) > 8;
      bot.pathfinder.setMovements(baseMoves(bot));
      if (far) {
        console.log(
          `[Portal] ${bot.username}: no portal cell in sight, walking back to the doorway at ${doorway.x},${doorway.y},${doorway.z} from ${bot.entity.position.distanceTo(centre).toFixed(0)} away`,
        );
      }
      await safeGoto(
        bot,
        new goals.GoalNear(doorway.x, doorway.y, doorway.z, far ? 3 : 1),
        far ? 45_000 : 20_000,
      ).catch(() => {});
    }
    // A second try at a looser goal. GoalBlock demands that exact block, and
    // the one beside a portal is often taken by the frame, a slab or another
    // bot; GoalNear lets the planner stand anywhere adjacent, which is all the
    // step needs.
    if (stand && !inPortal()) {
      const gap = () => bot.entity.position.distanceTo(stand.offset(0.5, 0, 0.5));
      if (!readyToStepIn(gap(), bot.entity.position.y - stand.y)) {
        await safeGoto(bot, new goals.GoalNear(stand.x, stand.y, stand.z, 2), 30_000).catch(() => {});
      }
      const dy = bot.entity.position.y - stand.y;
      if (!readyToStepIn(gap(), dy)) {
        console.log(
          `[Portal] ${bot.username}: approach ended ${gap().toFixed(1)} blocks from the stand at ${stand.x},${stand.y},${stand.z} (dy=${dy.toFixed(1)}); not walking blind`,
        );
        logPortalGeometry(bot, doorway, centre, bot.entity.position.clone());
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
    }
    bot.pathfinder.setGoal(null);
    await bot.lookAt(centre, true).catch(() => {});
    const walkFrom = bot.entity.position.clone();
    bot.setControlState("forward", true);
    const walkStart = Date.now();
    while (Date.now() - walkStart < 4_000 && !inPortal()) {
      await new Promise((r) => setTimeout(r, 250));
    }
    bot.setControlState("forward", false);
    const standStart = Date.now();
    while (Date.now() - standStart < 7_000) {
      if (arrived(dimensionOf(bot))) return true;
      if (!inPortal()) break; // knocked out — the outer loop re-approaches
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(
      `[Portal] ${bot.username}: crossing attempt — inPortal=${inPortal()}, dist=${bot.entity.position.distanceTo(centre).toFixed(1)}, dim=${dimensionOf(bot)}`,
    );
    logPortalGeometry(bot, doorway, centre, walkFrom);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return arrived(dimensionOf(bot));
}

export async function buildNetherPortal(bot: Bot): Promise<string> {
  // Own the clock. The executor's 240s watchdog killed eight runs in one
  // hour once the chain grew to water-charge + descent + closures + carve +
  // cast — and a watchdog kill returns no resumable hand-back, so the
  // auto-continue never fires and the model has to rediscover the plan. A
  // run that ends ITSELF ends with progress banked and the protocol marker.
  // 420s, up from 200: Mason reached the frame, mined the doorway obsidian
  // (Ice Bucket Challenge, run 392), and then the clock ended his visit
  // before the scaffold, cast, and ignition — every return trip re-spends
  // ~90 commute blocks. One long visit finishes; the skill self-returns
  // with banked progress, so the envelope stays resumable.
  const runDeadline = Date.now() + 420_000;
  const timeLeft = () => runDeadline - Date.now();
  const outOfTime = (doing: string) => {
    const p = bot.entity.position.floored();
    return `Out of run time while ${doing} (at ${p.x},${p.y},${p.z}) — progress is banked. invoke_skill {"skill":"build_nether_portal"} again to continue from here.`;
  };

  // CROSS FIRST. With a lit portal standing nearby, every other leg is
  // noise — the advancement wants a bot in the doorway, and the last three
  // runs reached the entry step with the clock spent and mobs biting. The
  // crossing gets the front of the window here rather than the leftovers.
  // Already on the far side? Come home before anything else — the rest of
  // this skill assumes overworld coordinates and an overworld stash.
  if (isNether(dimensionOf(bot))) {
    return await returnThroughPortal(bot);
  }

  // With the breach earned, an overworld bot beside the lit portal has
  // nothing left to do here. The first version of this leg crossed
  // unconditionally, and Forge fell into a death loop: respawn at the
  // village, auto-cross, ghast fireball, repeat — three deaths in forty
  // seconds and a diamond pickaxe lost to the lava. Crossing on purpose
  // becomes its own expedition skill someday; this one only builds.
  {
    const litPortal = bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 48 });
    if (litPortal && isOverworld(dimensionOf(bot))) {
      return `The portal stands lit at ${litPortal.position.x},${litPortal.position.y},${litPortal.position.z} — the Nether breach is complete. Nothing to build.`;
    }
  }

  // Reclaim banked obsidian first. The self-cannibalization bug demolished
  // the finished frame and the pre-mine deposits banked the pieces — up to
  // 10 obsidian sit in the stash. Placing from inventory rebuilds in one
  // visit; casting from lava takes days. Raced so a jammed chest cannot eat
  // the trip (the stash-errand doctrine).
  {
    const obsidianHeld = bot.inventory
      .items()
      .filter((i) => i.name === "obsidian")
      .reduce((s, i) => s + i.count, 0);
    if (obsidianHeld < 10) {
      try {
        const { withdrawStash } = await import("./stash.js");
        const { STASH_POS } = await import("../bot/role.js");
        const near = Math.hypot(bot.entity.position.x - STASH_POS.x, bot.entity.position.z - STASH_POS.z) < 60;
        if (near) {
          await Promise.race([
            withdrawStash(bot, STASH_POS, "obsidian", 10 - obsidianHeld),
            new Promise<void>((r) => setTimeout(r, 60_000)),
          ]);
        }
      } catch {
        /* none banked or unreachable — the cast path still exists */
      }
    }
  }

  // QUARRY THE STUBS. The frame demolition scattered its obsidian into
  // despawned drops, so the stash rebuild fund is empty — but the old
  // one-to-five-block stub frames from the casting era still stand in the
  // world, deregistered and therefore legitimately minable. Harvest them
  // toward the 10 the village placement needs. Entries self-retire when a
  // visit finds nothing left.
  {
    const heldObs = () =>
      bot.inventory
        .items()
        .filter((i) => i.name === "obsidian")
        .reduce((s, i) => s + i.count, 0);
    // Diamond pick required: without one the mine at the far end must fail,
    // and Atlas (pickless PORTAL KEEPER) spent run 396's first minutes on a
    // 107-block commute toward exactly that failure.
    const hasDoorwayPick = bot.inventory
      .items()
      .some((i) => i.name === "diamond_pickaxe" || i.name === "netherite_pickaxe");
    if (heldObs() < 10 && hasDoorwayPick) {
      const quarries = persistentRecord<{ x: number; y: number; z: number }>("obsidianQuarries");
      const here0 = bot.entity.position;
      const entries = Object.entries(quarries).sort(
        (a, b) =>
          Math.hypot(a[1].x - here0.x, a[1].y - here0.y, a[1].z - here0.z) -
          Math.hypot(b[1].x - here0.x, b[1].y - here0.y, b[1].z - here0.z),
      );
      if (entries.length > 0) {
        const [qKey, q] = entries[0];
        const dist = () => bot.entity.position.distanceTo(new Vec3(q.x, q.y, q.z));
        if (dist() > 26) {
          // Surface first, then dig straight down — the strip-mine recipe.
          // A GoalNear on a target encased in rock at y=19 defeated the
          // direct walk completely: Mason looped "still 33 blocks away"
          // for a full window with zero progress. The XZ column overhead is
          // always walkable, and digDownTo is the proven descent.
          console.log(`[Portal] ${bot.username}: quarrying stub frame at ${qKey} (${dist().toFixed(0)} away)`);
          const xzGap = () => Math.hypot(bot.entity.position.x - q.x, bot.entity.position.z - q.z);
          // DIRECT approach first, dig-enabled and time-budgeted: the 388/392
          // stubs sit under an underground lake — run 402's overhead shafts
          // all flooded ("standing in open water with no shore within 24").
          // The stubs were BUILT from caves beside that water, so a cave path
          // exists; the pathfinder with digging can thread it where a
          // vertical shaft cannot.
          // Near targets only: the direct leg exists to thread caves the
          // last stretch. For the mountain stub 142 blocks out it burned its
          // whole budget on goal-changed flee noise before the surface walk
          // even started (run 404).
          if (dist() < 60) {
            const directDeadline = Date.now() + 90_000;
            while (Date.now() < directDeadline && dist() > 26) {
              if (timeLeft() < 90_000) return outOfTime("approaching the obsidian quarry");
              const dm = baseMoves(bot);
              dm.canDig = true;
              bot.pathfinder.setMovements(dm);
              await safeGoto(bot, new goals.GoalNear(q.x, q.y, q.z, 8), 45_000, 12_000).catch((e) => {
                console.log(`[Portal] ${bot.username}: quarry direct leg failed: ${(e as Error).message}`);
              });
              if (dist() > 26) await new Promise((r) => setTimeout(r, 2000));
            }
          }
          // TIME budget, the full hike pattern: run 401's instrumentation
          // showed every fixed-count leg dying to "The goal was changed" —
          // three flee hijacks ended the whole trip. Interruptions now pause
          // the march (2s) and it resumes until 150s is spent or arrival;
          // digging enables from the second attempt for bot-built clutter.
          const qWalkDeadline = Date.now() + 150_000;
          for (let leg = 0; Date.now() < qWalkDeadline && xzGap() > 6; leg++) {
            if (timeLeft() < 90_000) return outOfTime("commuting to the obsidian quarry");
            const mv = baseMoves(bot);
            if (leg > 0) {
              mv.canDig = true;
              mv.allow1by1towers = true;
            }
            bot.pathfinder.setMovements(mv);
            await safeGoto(bot, new goals.GoalXZ(q.x, q.z), 45_000, 12_000).catch((e) => {
              console.log(`[Portal] ${bot.username}: quarry walk leg ${leg + 1} failed: ${(e as Error).message}`);
            });
            if (xzGap() > 6) await new Promise((r) => setTimeout(r, 2000));
          }
          if (xzGap() <= 6 && bot.entity.position.y > q.y + 4) {
            // Lateral shifts on refusal, the strip-mine pattern: Forge looped
            // "4-block drop below — too far to fall" a dozen times from one
            // spot — a cave under his column. A shaft four blocks over
            // usually has a floor.
            const SHIFTS: Array<[number, number]> = [
              [0, 0],
              [4, 0],
              [0, 4],
              [-4, 0],
              [0, -4],
            ];
            for (const [sx, sz] of SHIFTS) {
              if (bot.entity.position.y <= q.y + 4) break;
              if (timeLeft() < 70_000) return outOfTime("descending to the quarry");
              if (sx !== 0 || sz !== 0) {
                const p0 = bot.entity.position;
                await safeGoto(bot, new goals.GoalXZ(Math.floor(p0.x) + sx, Math.floor(p0.z) + sz), 15_000).catch(
                  () => {},
                );
              }
              const dug = await digDownTo(bot, q.y, 80, Math.min(90_000, Math.max(25_000, timeLeft() - 70_000)));
              console.log(`[Portal] ${bot.username}: quarry descent (shift ${sx},${sz}): ${dug}`);
            }
          }
          if (dist() > 26) {
            return `Commuting to the obsidian quarry at ${qKey} — still ${dist().toFixed(0)} blocks away. invoke_skill {"skill":"build_nether_portal"} again to continue from here.`;
          }
        }
        const { mineObsidian } = await import("./obsidian.js");
        const res = await mineObsidian(bot, 10 - heldObs());
        console.log(`[Portal] ${bot.username}: quarry ${qKey}: ${res}`);
        if (res.startsWith("Cannot find")) {
          delete quarries[qKey];
          persistRecord("obsidianQuarries", quarries);
        }
        if (heldObs() < 10 && Object.keys(quarries).length > 0) {
          return `Quarried to ${heldObs()}/10 obsidian at ${qKey}. invoke_skill {"skill":"build_nether_portal"} again to continue from here.`;
        }
      }
    }
  }

  const names = bot.inventory.items().map((i) => i.name);
  let { ready, missing } = readinessOf(names);

  // Make the prerequisites rather than asking the model to chain skills across
  // decisions. That advice has failed three times now: craft_bucket sat unused
  // until its goal named it, fill_bucket ran from the surface after strip_mine
  // had already descended, and craft_flint_and_steel is registered, in Forge's
  // menu, and named by nothing. A skill that needs a thing should make it.
  // The stash first: before the kit-retention rule (2545cec) every deposit
  // trip donated buckets and igniters to the chest, so the cheapest kit is
  // usually sitting there already — withdrawing beats re-grinding four iron.
  if (!ready) {
    const { withdrawStash } = await import("./stash.js");
    const { STASH_POS } = await import("../bot/role.js");
    for (const item of missing) {
      await withdrawStash(bot, STASH_POS, item, 1).catch(() => {});
    }
    ({ ready, missing } = readinessOf(bot.inventory.items().map((i) => i.name)));
  }

  // The bucket, self-supplied too. "Missing bucket. Craft those first." has
  // been the igniter-holders' wall for three cycles — craft_bucket refuses
  // without three ingots on hand, and nobody delivers them. The igniter's
  // proven one-ingot chain runs up to twice per attempt; ingots persist in
  // the inventory, so successive runs accumulate to three and then craft.
  if (!ready && missing.includes("bucket")) {
    const { craftBucket } = await import("./craft-bucket.js");
    const { obtainOneIron } = await import("./flint-and-steel.js");
    const ingots = () =>
      bot.inventory
        .items()
        .filter((i) => i.name === "iron_ingot")
        .reduce((n, i) => n + i.count, 0);
    for (let round = 0; round < 2 && ingots() < 3 && timeLeft() > 60_000; round++) {
      const got = await obtainOneIron(bot, Math.min(120_000, timeLeft() - 50_000));
      console.log(`[Bucket] ${bot.username} iron (${ingots()}/3): ${got}`);
      if (!/withdrew|mined and smelted|picked up/.test(got)) break; // no progress — stop burning budget
    }
    if (ingots() >= 3) {
      const bucketMsg = await craftBucket(bot);
      console.log(`[Bucket] ${bot.username}: ${bucketMsg}`);
    }
    ({ ready, missing } = readinessOf(bot.inventory.items().map((i) => i.name)));
  }

  if (!ready && missing.includes("flint_and_steel")) {
    // The igniter chain (ore walk, dig, smelt, fuel hunt) is the single
    // longest readiness stage; twenty watchdog kills in one hour traced to
    // pre-clock stages like this one running the window dry.
    if (timeLeft() < 60_000) return outOfTime("assembling the igniter");
    const igniter = await craftFlintAndSteel(bot, timeLeft() - 45_000);
    ({ ready, missing } = readinessOf(bot.inventory.items().map((i) => i.name)));
    if (!ready) return `Not ready for a portal: missing ${missing.join(", ")}. ${igniter}`;
  }
  if (!ready)
    return `Not ready for a portal: missing ${missing.join(", ")}. Keep re-invoking — each run banks iron toward the bucket.`;

  const p = bot.entity.position;
  let axis: "x" | "z" = "x";

  // Siting used to be "two blocks east of wherever the bot stands", unchecked.
  // A portal is a 4x5 volume; two east of a bot on a ridge is a frame that
  // cannot be placed, and each obsidian block costs a round trip to a lava pool.
  // Probe the world instead and refuse to start rather than burn ten trips.
  const probe = (q: Vec3Like): BlockKind => {
    const b = bot.blockAt(new Vec3(q.x, q.y, q.z));
    if (!b) return "unknown"; // unloaded chunk — never assume it is clear
    if (b.name === "obsidian") return "obsidian";
    if (b.name === "water" || b.name === "lava") return "liquid";
    if (b.name === "air" || b.name === "cave_air" || b.name === "void_air") return "air";
    return "solid";
  };

  // Resume a half-built frame before siting a new one.
  let prior = plannedSites.get(bot.username);
  // No site of our own in range? Adopt any TEAM frame that already banked
  // obsidian. Two 1-block frames sat unvisited for days because per-bot site
  // memory died with abandons and overwrites while the blocks stood in the
  // world — the registry outlives both the bot's plans and the process.
  if (!prior || Math.hypot(prior.origin.x - p.x, prior.origin.y - p.y, prior.origin.z - p.z) > RESUME_RANGE) {
    for (const entry of Object.values(bankedFrames)) {
      if (frameLavaDead(entry)) continue;
      if (Math.hypot(entry.origin.x - p.x, entry.origin.y - p.y, entry.origin.z - p.z) <= RESUME_RANGE) {
        console.log(
          `[Portal] ${bot.username}: adopting team frame with banked obsidian at ${entry.origin.x},${entry.origin.y},${entry.origin.z}`,
        );
        prior = entry;
        break;
      }
    }
  }
  let origin: Vec3Like | null = null;
  if (prior && Math.hypot(prior.origin.x - p.x, prior.origin.y - p.y, prior.origin.z - p.z) <= RESUME_RANGE) {
    origin = prior.origin;
    axis = prior.axis;
    try {
      await safeGoto(bot, new goals.GoalNear(origin.x, origin.y, origin.z, 3), 30000);
    } catch {
      // Casting re-checks reach per block; being short of the site is survivable.
    }
  } else {
    // Carry the water DOWN. Three runs in a row reached the cast phase and
    // died trying to tunnel to a buried aquifer at y=-3 — at lava depth,
    // water is rare and encased, but the village lake is thirty seconds away
    // on the surface. One carried charge becomes the site's station (the
    // cast pours it on a neighbour cell and re-scoops it), so fill BEFORE
    // descending, while water is cheap. Best effort: a failed surface fill
    // just falls back to hunting water at depth like before.
    // Four watchdog kills came back within a day of the run clock landing:
    // readiness (stash trips, the iron accumulator, fuel gathering) is not
    // clock-checked and can eat most of the window before the first check in
    // the march loop ever runs. Guard the expensive early stages too.
    if (timeLeft() < 70_000) return outOfTime("after gathering the kit");

    // PLACEMENT MODE — Jesse's directive after the self-cannibalization
    // incident: build close to spawn so commutes stop taxing every visit.
    // Holding a full frame's obsidian makes lava irrelevant: site beside the
    // BOT (bots idle at the village), place the ten blocks, register the
    // frame (registration also puts it on the mine-protection list), and
    // hand off to the adoption path that already knows how to clear and
    // ignite a standing frame.
    // This check runs FIRST in the branch: Atlas stood at the village with a
    // complete frame in his pack while the banked-frame commute below
    // returned early every invocation, dragging him toward a 5/10 frame at
    // y=-53 he could never reach. A full pocket outranks every other lead.
    {
      const obsidianAboard = bot.inventory
        .items()
        .filter((i) => i.name === "obsidian")
        .reduce((s, i) => s + i.count, 0);
      if (obsidianAboard >= 10) {
        // VILLAGE-GATED: a full pocket at the lava mint must walk home
        // first, or the portal gets built beside the lava — the exact
        // outcome Jesse's directive exists to prevent.
        const { STASH_POS: SPV } = await import("../bot/role.js");
        const homeGap = () => Math.hypot(bot.entity.position.x - SPV.x, bot.entity.position.z - SPV.z);
        if (homeGap() > 60) {
          const homeDeadline = Date.now() + 150_000;
          bot.pathfinder.setMovements(baseMoves(bot));
          while (Date.now() < homeDeadline && homeGap() > 60) {
            if (timeLeft() < 90_000) return outOfTime("carrying the frame home");
            await safeGoto(bot, new goals.GoalXZ(SPV.x, SPV.z), 45_000, 12_000).catch(() => {});
            if (homeGap() > 60) await new Promise((r) => setTimeout(r, 2000));
          }
          if (homeGap() > 60) {
            return `Carrying ${obsidianAboard} obsidian home to build — still ${homeGap().toFixed(0)} blocks from the village. invoke_skill {"skill":"build_nether_portal"} again to continue from here.`;
          }
        }
        const here = bot.entity.position;
        const centre: Vec3Like = { x: Math.floor(here.x) + 2, y: Math.floor(here.y) + 1, z: Math.floor(here.z) };
        let site = findSiteFlexible(centre, probe, 16);
        if (!site) {
          if (timeLeft() < 40_000) return outOfTime("about to carve a placement site");
          await carveSite(bot, centre, "z");
          site = findSiteFlexible(centre, probe, 16);
        }
        if (site) {
          console.log(
            `[Portal] ${bot.username}: PLACING frame from ${obsidianAboard} carried obsidian at ${site.origin.x},${site.origin.y},${site.origin.z} (${site.axis})`,
          );
          await carveSite(bot, site.origin, site.axis);
          await placeFrame(bot, site.origin, site.axis);
          const placedCount = framePositions(site.origin, site.axis).filter(
            (p) => bot.blockAt(new Vec3(p.x, p.y, p.z))?.name === "obsidian",
          ).length;
          const key = `${site.origin.x},${site.origin.y},${site.origin.z}`;
          bankedFrames[key] = {
            origin: site.origin,
            axis: site.axis,
            banked: placedCount,
            lastProgressAt: Date.now(),
          };
          saveBankedFrames();
          plannedSites.set(bot.username, { origin: site.origin, axis: site.axis });
          savePlannedSites();
          return `Placed ${placedCount}/10 frame blocks at ${key} from carried obsidian. invoke_skill {"skill":"build_nether_portal"} again to continue from here.`;
        }
        console.log(`[Portal] ${bot.username}: placement mode found no site within 16 — falling through to cast path`);
      }
    }

    const hasFluid = () => bot.inventory.items().some((i) => i.name === "water_bucket" || i.name === "lava_bucket");
    if (!hasFluid() && bot.entity.position.y > LAVA_DEPTH) {
      const surfaceWater = await fillBucket(bot, "water");
      console.log(`[Portal] ${bot.username} surface water charge: ${surfaceWater}`);
    }

    // Site the frame beside the lava it will drink from, not beside the bot.
    // A surface site over deep lava charges every one of ten casts a full
    // descent round trip — the run that exposed this filled its bucket at
    // depth and then could not climb back within budget ("Could not get
    // within pouring range... the path back is blocked"). Ten of those can
    // never fit one watchdog window; ten five-block hops can. As a bonus,
    // the wrong-fluid dump in fillBucket lands its water near the site,
    // becoming the refill station for the cast's water half.
    const findLava = () =>
      bot.findBlock({
        // b.position is NULL for section-scanned blocks inside findBlock's
        // matching callback — six runs crashed on it. Judge the blacklist only
        // when a position exists (the trap the playbook warned about, form 2).
        matching: (b) => b.name === "lava" && isSourceBlock(b) && (!b.position || !badLava.has(lavaKey(b.position))),
        maxDistance: 96,
      });
    let lava = findLava();

    // No lava in range means the bot is invoking from the surface. Telling
    // the model "strip_mine down, then retry" asked it to hold a two-step
    // plan across separate decisions — the same shape that stranded
    // craft_bucket and the igniter. The skill descends itself with the
    // proven bounded digger, then looks again.
    // Known frames outrank blind prospecting. With banked obsidian standing
    // in the world, "no lava within 96" at the deforested village means
    // COMMUTE — and leaving that walk to model attention lost whole nights
    // of runs to descents into terrain the refusals mapped out days ago.
    // A WELL-BUILT frame outranks local prospecting too: run 301's first
    // hour went entirely to a village descent toward virgin deep lava (five
    // "ran out of time" legs toward y=-60) while the 3/10 frame with proven
    // lava sat one commute away — the descent would only have smeared an
    // eighth frame across the map. With 3+ blocks banked at a healthy frame
    // in range, commute even though lava is findable here; thin frames (1-2
    // blocks) still lose to lava in hand.
    {
      const q0 = bot.entity.position;
      // Most-built frame wins; distance only breaks ties. Nearest-first sent
      // the whole swarm to a one-block frame with a jammed approach while the
      // four-block frame at the proven pool got no visitors.
      let nearest: { origin: Vec3Like; d: number; banked: number } | null = null;
      for (const e of Object.values(bankedFrames)) {
        if (frameLavaDead(e)) continue;
        const d = Math.hypot(e.origin.x - q0.x, e.origin.y - q0.y, e.origin.z - q0.z);
        if (d > 220) continue;
        const b = e.banked ?? 1;
        if (!nearest || b > nearest.banked || (b === nearest.banked && d < nearest.d)) {
          nearest = { origin: e.origin, d, banked: b };
        }
      }
      if (nearest && nearest.d > RESUME_RANGE && (!lava || nearest.banked >= 3)) {
        console.log(
          `[Portal] ${bot.username}: ${lava ? "well-built frame outranks local lava" : "no local lava"} — commuting to banked frame at ${nearest.origin.x},${nearest.origin.y},${nearest.origin.z} (${nearest.d.toFixed(0)} away)`,
        );
        bot.pathfinder.setMovements(baseMoves(bot));
        for (let leg = 0; leg < 2; leg++) {
          if (timeLeft() < 60_000) return outOfTime("commuting to the banked frame");
          try {
            // 12s stall grace, same medicine as the mining hike: the frame
            // sits at y=14 so the path is a dig-down whose computation alone
            // exceeds the 5s stall alarm — run 391's commute banked ~7 blocks
            // per invocation because every leg died to "Stuck" seconds in.
            await safeGoto(
              bot,
              new goals.GoalNear(nearest.origin.x, nearest.origin.y, nearest.origin.z, 8),
              45_000,
              12_000,
            );
          } catch {
            /* legs bank distance */
          }
          if (
            bot.entity.position.distanceTo(new Vec3(nearest.origin.x, nearest.origin.y, nearest.origin.z)) <=
            RESUME_RANGE
          )
            break;
        }
        const dNow = bot.entity.position.distanceTo(new Vec3(nearest.origin.x, nearest.origin.y, nearest.origin.z));
        // Hand back on ARRIVAL as well as mid-march: continuing in-run from
        // here would site a fresh frame beside whatever lava is local — the
        // exact move that minted the 388 one-block stubs two cells from the
        // real frame. The re-invocation lands in the adoption path instead,
        // which resumes the registered origin.
        return `Commuting to the banked frame at ${nearest.origin.x},${nearest.origin.y},${nearest.origin.z} — ${dNow <= RESUME_RANGE ? "arrived in adoption range" : `still ${dNow.toFixed(0)} blocks away`}. invoke_skill {"skill":"build_nether_portal"} again to continue from here.`;
      }
    }

    if (!lava && bot.entity.position.y > LAVA_DEPTH) {
      console.log(`[Portal] ${bot.username}: no lava within 96 — descending first`);
      // fill_bucket's proven shape: a refused shaft ("open air below — a
      // shaft, not a dig", an aquifer) is a LOCAL verdict, not proof there is
      // no way down — two runs in a row ended at the same y=67 ledge. Step
      // aside and sink a fresh hole, all inside one budget so the executor's
      // watchdog never kills the descent mid-dig.
      if (timeLeft() < 60_000) return outOfTime("before the descent");
      const deadline = Date.now() + Math.min(100_000, timeLeft() - 30_000);
      for (let attempt = 0; attempt < 2 && !lava; attempt++) {
        const left = deadline - Date.now();
        if (left < 15_000) break;
        const dug = await digDownTo(bot, -40, 80, left);
        console.log(`[Portal] ${bot.username} descent: ${dug}`);
        lava = findLava();
        if (lava || bot.entity.position.y <= LAVA_DEPTH) break;
        try {
          const q = bot.entity.position;
          await safeGoto(bot, new goals.GoalNear(q.x + 6, q.y, q.z + 6, 1), 12_000);
        } catch {
          break; // boxed in — stop rather than spin
        }
      }
    }
    if (!lava) {
      return `No lava source within 96 blocks even at y=${Math.floor(bot.entity.position.y)}. Explore sideways through caves, then invoke_skill {"skill":"build_nether_portal"} again.`;
    }

    // Keep walking while the gap is closing. A single 60s leg once ended the
    // run "still 40 blocks away" with ~170s of watchdog budget unused, and
    // the model wandered off instead of re-invoking. Two more bounded legs
    // fit comfortably under the 240s watchdog even after a 100s descent.
    bot.pathfinder.setMovements(baseMoves(bot));
    for (let leg = 0; leg < 3; leg++) {
      if (timeLeft() < 55_000) return outOfTime("marching to lava");
      const gap = bot.entity.position.distanceTo(lava.position);
      if (gap <= 10) break;
      try {
        await safeGoto(bot, new goals.GoalNear(lava.position.x, lava.position.y, lava.position.z, 5), 45000);
      } catch {
        /* measured below */
      }
      const now = bot.entity.position.distanceTo(lava.position);
      if (now >= gap - 2) {
        // Not closing. Four runs reported the same "75 blocks away" from a
        // pool at y=-4: the gap was almost entirely VERTICAL, and the
        // pathfinder cannot plan a 70-block dig column — digDownTo can
        // execute exactly that. Sink toward the pool's level and try the
        // walk again from depth.
        const drop = bot.entity.position.y - lava.position.y;
        if (now > 15 && drop > 15) {
          if (timeLeft() < 45_000) return outOfTime("sinking toward the pool");
          const dug = await digDownTo(bot, Math.floor(lava.position.y) + 2, 80, Math.min(90_000, timeLeft() - 25_000));
          console.log(`[Portal] ${bot.username} vertical closure: ${dug}`);
          // A shaft refused at its very first swing (water/void below, open
          // water underfoot) will be refused identically from the same cell
          // forever — Atlas logged nine "water 3 block(s) below" from one
          // spot across three legs and three encores. Sidestep before the
          // next attempt, the same medicine the initial descent takes.
          if (/Dug down 0|cannot start here|kept breaking/.test(dug)) {
            const p = bot.entity.position;
            await safeGoto(bot, new goals.GoalNear(p.x + 6, p.y, p.z + 6, 2), 15_000).catch(() => {});
          }
          continue;
        }
        break; // genuinely blocked laterally
      }
    }

    // Do NOT plan a frame the walk never reached. "Site wherever we got to"
    // re-created the doomed surface frame: lava was findable 90 blocks below
    // the village, the walk fell short, and the surface site it committed was
    // then resumed all run. Better to end this run partway down — the next
    // invocation continues from here.
    const lavaGap = bot.entity.position.distanceTo(lava.position);
    if (lavaGap > 15) {
      recordLavaFellShort(lava.position);
      console.log(`[Portal] ${bot.username}: walk fell short — ${lavaGap.toFixed(0)} blocks from lava`);
      return `Walking to lava at ${lava.position.x},${lava.position.y},${lava.position.z} — still ${lavaGap.toFixed(0)} blocks away. invoke_skill {"skill":"build_nether_portal"} again to continue from here.`;
    }

    // MINT MODE — cast-and-carry, the quarry gap-filler. With the stub
    // quarries exhausted (252 mined bare, the wet cluster lake-locked) and a
    // diamond pick aboard, blocks get minted HERE at the lava as a loose row
    // and mined immediately — unregistered cells carry no protection — then
    // hauled home for the village build. Skipping the frame-siting below
    // keeps deep frames from ever being born again.
    {
      const heldObsNow = () =>
        bot.inventory
          .items()
          .filter((i) => i.name === "obsidian")
          .reduce((s, i) => s + i.count, 0);
      const mintPick = bot.inventory
        .items()
        .some((i) => i.name === "diamond_pickaxe" || i.name === "netherite_pickaxe");
      if (mintPick && heldObsNow() < 10) {
        const need = 10 - heldObsNow();
        const base = bot.entity.position.floored();
        // A row of cells on the shore beside the bot — solid ground below,
        // air at the cell, never inside the lava itself.
        const mintCells: Vec3Like[] = [];
        for (let d = 1; d <= 8 && mintCells.length < need; d++) {
          for (const [dx, dz] of [
            [d, 0],
            [-d, 0],
            [0, d],
            [0, -d],
          ]) {
            if (mintCells.length >= need) break;
            const c = { x: base.x + dx, y: base.y, z: base.z + dz };
            const at = bot.blockAt(new Vec3(c.x, c.y, c.z));
            const below = bot.blockAt(new Vec3(c.x, c.y - 1, c.z));
            if (
              at?.name === "air" &&
              below &&
              below.name !== "air" &&
              below.name !== "lava" &&
              below.name !== "water"
            ) {
              mintCells.push(c);
            }
          }
        }
        if (mintCells.length > 0) {
          console.log(`[Portal] ${bot.username}: MINT MODE — casting ${mintCells.length} loose blocks by the lava`);
          const castRes = await acquireObsidian(bot, mintCells, runDeadline - 30_000, []);
          console.log(`[Portal] ${bot.username}: mint cast: ${castRes}`);
          const { mineObsidian } = await import("./obsidian.js");
          const mineRes = await mineObsidian(bot, 10 - heldObsNow());
          console.log(`[Portal] ${bot.username}: mint mine: ${mineRes}`);
          return `Minted and pocketed to ${heldObsNow()}/10 obsidian at the lava. invoke_skill {"skill":"build_nether_portal"} again to continue from here.`;
        }
      }
    }

    // VILLAGE-GATED SITING — the hole that birthed the deep frames, closed.
    // Bots that fell through to here at lava depth (no diamond pick, so mint
    // never intercepted) sited fresh frames beside the pool and registered
    // them; once one banked 3+, the commute leg above dragged the whole
    // swarm into hopeless 109-block treks. Jesse's rule: frames get built
    // at the village from carried obsidian, so far from home this run ends
    // with an honest handoff.
    {
      const { STASH_POS: SPH } = await import("../bot/role.js");
      const gapHome = Math.hypot(bot.entity.position.x - SPH.x, bot.entity.position.z - SPH.z);
      if (gapHome > 60) {
        return `Holding off on building here, ${gapHome.toFixed(0)} blocks from the village — frames are built at home from carried obsidian. Mint with a diamond pickaxe or haul what you hold, then invoke_skill {"skill":"build_nether_portal"} again.`;
      }
    }

    // Start one above the bot's feet: the frame's floor row rests ON the
    // ground, so the interior begins a block higher.
    const here = bot.entity.position;
    const centre: Vec3Like = { x: Math.floor(here.x) + 2, y: Math.floor(here.y) + 1, z: Math.floor(here.z) };
    let site = findSiteFlexible(centre, probe, 16);
    if (!site) {
      // No natural void beside the pool — carve one out of the rock and
      // re-probe. Stone is free and the pickaxe is already in the pack.
      console.log(`[Portal] ${bot.username}: no natural site — carving one at ${centre.x},${centre.y},${centre.z}`);
      if (timeLeft() < 40_000) return outOfTime("about to carve a site");
      await carveSite(bot, centre, axis);
      site = findSiteFlexible(centre, probe, 16);
      if (!site) {
        const obstacle = firstObstacle(centre, axis, probe) ?? "no obstacle at centre?";
        console.log(`[Portal] ${bot.username} carve left: ${obstacle}`);
        // The chronic ending — ten carves finished ONE cell short of a site
        // and the run walked away. When the re-probe names a single solid
        // cell, spend one focused trip on exactly that cell instead of
        // hoping a future carve budget reaches it.
        const m = /cell (-?\d+),(-?\d+),(-?\d+) is (?:solid|unknown)/.exec(obstacle);
        if (m && timeLeft() > 30_000) {
          const cellV = new Vec3(+m[1], +m[2], +m[3]);
          const b = bot.blockAt(cellV);
          if (b && b.name !== "bedrock" && b.name !== "obsidian" && b.name !== "air") {
            try {
              await safeGoto(bot, new goals.GoalNear(cellV.x, cellV.y, cellV.z, 2), 15_000);
            } catch {
              /* dig below fails fast if still out of reach */
            }
            bot.pathfinder.setGoal(null);
            const pick = bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
            if (pick) await bot.equip(pick, "hand").catch(() => {});
            try {
              await Promise.race([
                bot.dig(b),
                new Promise((_, rej) => setTimeout(() => rej(new Error("dig timeout")), 12_000)),
              ]);
            } catch {
              bot.stopDigging();
            }
            site = findSiteFlexible(centre, probe, 16);
            if (site) console.log(`[Portal] ${bot.username}: focused dig finished the carve`);
          }
        }
      }
    }
    if (site) {
      ({ origin, axis } = site);
      plannedSites.set(bot.username, { origin, axis });
      savePlannedSites();
    }
  }
  if (!origin)
    return "No clear 4x5 space for a portal within 16 blocks even after carving. Move somewhere open and retry.";

  if (timeLeft() < 60_000) return outOfTime("reaching the casting step");
  const frame = framePositions(origin, axis);

  // Scaffold for the cast, self-supplied: Blade reached a banked frame and
  // stalled on "no scaffold blocks (carry cobblestone or dirt)" — sealing
  // aquifers and capping shafts spend the cobble long before the lintel
  // needs it. Stone and dirt are everywhere; dig up to four blocks nearby
  // first, never touching the frame's own volume or its floor support.
  if (timeLeft() > 90_000) {
    // Count ONLY what the pathfinder can tower with. The broad stone family
    // satisfies the cast's own scaffold placer, but pillaring out of a pit
    // accepts dirt and cobblestone alone — a bot passed this check holding
    // granite and still reported towers=0 at the pour walk-back. Same rule
    // for what to dig: stone and dirt drop tower-usable items; andesite,
    // diorite, granite and deepslate drop items the pathfinder ignores.
    const SCAFF = new Set(["cobblestone", "dirt"]);
    const scaffCount = () =>
      bot.inventory
        .items()
        .filter((i) => SCAFF.has(i.name))
        .reduce((n, i) => n + i.count, 0);
    const DIGGABLE = new Set(["stone", "dirt", "grass_block"]);
    const protectedCells = new Set(
      [...frame, ...interiorPositions(origin, axis)].flatMap((p) => [
        `${p.x},${p.y},${p.z}`,
        `${p.x},${p.y - 1},${p.z}`,
      ]),
    );
    // Eight, doubled from four: the census caught Atlas stranded at the pool
    // with a full lava bucket and ZERO tower blocks — the walk back up the
    // cave chimney at the 252 site needs pathfinder pillars, and the frame
    // supports had eaten his four. The pour trip spends scaffold the lintel
    // math never budgeted.
    for (let s = 0; s < 8 && scaffCount() < 8; s++) {
      const blk = bot.findBlock({
        matching: (b) =>
          DIGGABLE.has(b.name) &&
          (!b.position || !protectedCells.has(`${b.position.x},${b.position.y},${b.position.z}`)),
        maxDistance: 8,
      });
      if (!blk) break;
      try {
        await Promise.race([
          bot.dig(blk),
          new Promise((_, rej) => setTimeout(() => rej(new Error("dig timeout")), 10_000)),
        ]);
        await new Promise((r) => setTimeout(r, 800));
      } catch {
        bot.stopDigging();
        break;
      }
    }
    if (scaffCount() < 8) {
      console.log(`[Portal] ${bot.username}: scaffold short (${scaffCount()}/8) — the cast may stop at the lintel`);
    }
  }

  // Seat carried obsidian into the frame before hunting for more. The
  // village placement left Atlas adopting his own 5/10 frame with five
  // blocks still in his pack, and acquireObsidian only knows how to mine
  // (diamond pick) or cast (lava) — at the village he has neither.
  // placeFrame skips cells that are already obsidian and stops when the
  // pack runs dry, so this is safe on every visit.
  const heldObs = bot.inventory
    .items()
    .filter((i) => i.name === "obsidian")
    .reduce((s, i) => s + i.count, 0);
  if (heldObs > 0) {
    console.log(`[Portal] ${bot.username}: seating ${heldObs} carried obsidian into the frame first`);
    await placeFrame(bot, origin, axis);
  }

  const got = await acquireObsidian(bot, frame, runDeadline - 15_000, interiorPositions(origin, axis));
  console.log(`[Portal] ${bot.username} obsidian step: ${got}`);

  // Any obsidian in the frame makes it team property worth returning to.
  const frameKey = `${origin.x},${origin.y},${origin.z}`;
  {
    const bankedNow = frame.filter((pos) => bot.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name === "obsidian").length;
    const before = bankedFrames[frameKey];
    if (bankedNow > 0 && before?.banked !== bankedNow) {
      // Fresh obsidian in the ring is proof the lava here still pours —
      // clear any strikes along with recording the new count.
      const grew = bankedNow > (before?.banked ?? 0);
      bankedFrames[frameKey] = {
        origin,
        axis,
        banked: bankedNow,
        lavaStrikes: grew ? 0 : (before?.lavaStrikes ?? 0),
        lastStrikeAt: grew ? undefined : before?.lastStrikeAt,
        lastProgressAt: grew ? Date.now() : before?.lastProgressAt,
      };
      saveBankedFrames();
    }
  }
  if (!got.startsWith("Cast") && !got.startsWith("Mined") && !got.startsWith("Already")) {
    // A site whose lava cannot be reached is a trap, not an asset: the
    // planned-site resume walked Atlas back to the same doomed frame twice in
    // an hour ("could not get closer than 13/25 blocks"). If NOTHING has been
    // banked in the frame yet, abandon it and let the next run site fresh
    // beside lava it can actually drink from. A frame holding any obsidian
    // stays — banked blocks are worth walking back to.
    const banked = frame.filter((pos) => bot.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name === "obsidian").length;
    if (
      banked === 0 &&
      /could not get closer|could not get within pouring range|Cannot find a lava source/i.test(got)
    ) {
      plannedSites.delete(bot.username);
      savePlannedSites();
      // Strike the POOL, not just the site: Atlas abandoned a frame and then
      // re-sited two blocks away against the same unreachable lava, carving
      // and abandoning again. The fell-short counter already retires pools
      // the walk cannot reach; a cast that proved the rim undrinkable is the
      // same evidence, so it casts the same vote.
      const src = /at (-?\d+),(-?\d+),(-?\d+)/.exec(got);
      if (src) recordLavaFellShort({ x: +src[1], y: +src[2], z: +src[3] });
      console.log(
        `[Portal] ${bot.username} abandoned empty site at ${origin.x},${origin.y},${origin.z} — lava unreachable from it`,
      );
      return `Portal stalled getting obsidian: ${got} Site abandoned; the next attempt sites a fresh frame beside reachable lava.`;
    }
    // A BANKED frame that cannot reach its lava earns a strike. Pour-range
    // failures are excluded on purpose: those mean the lava filled the
    // bucket fine and only the walk back to the ring jammed — the 252 frame
    // reached 3/10 through exactly that noise. Only "the lava itself is out
    // of reach" evidence retires a frame.
    // Two more exclusions, learned when three routine misses retired the
    // healthiest frame in the registry within one hour of it CASTING a
    // block: a miss that voted its cell out ("that cell is blacklisted") is
    // the rotation self-healing, so it never strikes; and strikes are
    // rate-limited to one per frame per half hour, so only sustained
    // futility across hours — the 392 lake-trap signature — reaches the
    // limit, while a healthy site's bad stretch cannot outrun its own
    // progress resets.
    if (
      banked > 0 &&
      /could not get closer|Cannot find a lava source/i.test(got) &&
      !/that cell is blacklisted/i.test(got)
    ) {
      const entry = bankedFrames[frameKey];
      const rested = !entry?.lastStrikeAt || Date.now() - entry.lastStrikeAt > 30 * 60_000;
      if (entry && rested) {
        entry.lavaStrikes = (entry.lavaStrikes ?? 0) + 1;
        entry.lastStrikeAt = Date.now();
        saveBankedFrames();
        if (frameLavaDead(entry)) {
          console.log(
            `[Portal] ${bot.username}: frame at ${frameKey} has dead local lava (${entry.lavaStrikes} strikes) — retired as a commute target`,
          );
        }
      }
    }
    return `Portal stalled getting obsidian: ${got}`;
  }

  // Placed-block route: if obsidian ended up in inventory (the mine route, or
  // any leftover from casting), set the frame by hand. Casting already writes
  // obsidian directly into the world at each position, so this is a no-op
  // there beyond the already-obsidian check inside placeFrame.
  if (bot.inventory.items().some((i) => i.name === "obsidian")) {
    await placeFrame(bot, origin, axis);
  }

  const frameComplete = frame.every((pos) => bot.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name === "obsidian");
  if (!frameComplete) return `Frame unfinished so far (${got}) — retry to continue this same frame.`;

  // Clear the interior so the portal has room to form. Stray casts left
  // OBSIDIAN inside the doorway, and a bare bot.dig on obsidian below
  // diamond tier runs past the skill watchdog without ever dropping the
  // block — clearing must skip what the pick in hand cannot break and say
  // so, instead of hanging on it.
  const hasDiamondPick = bot.inventory
    .items()
    .some((i) => i.name === "diamond_pickaxe" || i.name === "netherite_pickaxe");
  let pluggedByObsidian = 0;
  let clearFailures = 0;
  for (const pos of interiorPositions(origin, axis)) {
    const b = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (!b || b.name === "air" || b.name === "nether_portal") continue;
    if (b.name === "obsidian" && !hasDiamondPick) {
      pluggedByObsidian++;
      continue;
    }
    // Two "did not light" runs in a row cleared nothing while the doorway
    // stood full of scaffold dirt: every dig failed in silence, most likely
    // from out of reach after a shrugged-off approach. Walk into reach and
    // say what actually goes wrong.
    if (bot.entity.position.distanceTo(new Vec3(pos.x, pos.y, pos.z)) > 4) {
      await safeGoto(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 2), 20_000).catch(() => {});
    }
    try {
      await Promise.race([
        bot.dig(b),
        new Promise((_, rej) => setTimeout(() => rej(new Error("dig timeout")), 20_000)),
      ]);
    } catch (e) {
      bot.stopDigging();
      clearFailures++;
      console.log(
        `[Portal] ${bot.username}: interior clear failed at ${pos.x},${pos.y},${pos.z} (${b.name}, dist ${bot.entity.position.distanceTo(new Vec3(pos.x, pos.y, pos.z)).toFixed(1)}): ${(e as Error).message}`,
      );
    }
  }
  if (clearFailures > 0) {
    return `Frame complete (10/10) but ${clearFailures} doorway blocks resisted clearing — see the log. invoke_skill {"skill":"build_nether_portal"} again to continue from here.`;
  }
  if (pluggedByObsidian > 0) {
    return `Frame complete (10/10) but the doorway holds ${pluggedByObsidian} stray obsidian only a DIAMOND pickaxe can clear. Bring one and invoke_skill build_nether_portal again to continue.`;
  }

  const igniter = bot.inventory.items().find((i) => i.name === "flint_and_steel");
  if (!igniter) return "Frame built but no flint_and_steel to light it.";
  await bot.equip(igniter, "hand");

  const t = ignitionTarget(origin, axis);
  const below = bot.blockAt(new Vec3(t.x, t.y - 1, t.z));
  if (below) await bot.activateBlock(below).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));

  const lit = interiorPositions(origin, axis).some(
    (pos) => bot.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name === "nether_portal",
  );
  if (!lit) return "Frame built but the portal did not light. Check the frame is complete.";

  recordPortal(bot, origin, axis);
  plannedSites.delete(bot.username);
  savePlannedSites();

  // The advancement is earned by STANDING in the doorway — lighting alone
  // scores nothing, and no other machinery ever walks in. Step through,
  // wait out the transition, and come straight home so the bot is never
  // stranded on the far side.
  const doorway = interiorPositions(origin, axis)[0];
  const crossed = await crossPortal(
    bot,
    new Vec3(doorway.x, doorway.y, doorway.z),
    Math.min(90_000, Math.max(20_000, timeLeft() - 30_000)),
  );
  if (crossed) {
    console.log(`[Portal] ${bot.username}: crossed into the Nether!`);
    const back = await returnThroughPortal(bot);
    return `Portal built and lit at ${origin.x},${origin.y},${origin.z} — stepped through to the Nether. ${back}`;
  }
  return `Portal built and lit at ${origin.x},${origin.y},${origin.z} — the crossing kept getting interrupted. invoke_skill {"skill":"build_nether_portal"} again to continue from here.`;
}

// Read behind a function call so tsc does not narrow bot.game.dimension to a
// single literal across the awaits below — the whole point of re-checking it
// after walking and waiting is that it CAN change out from under us.
function dimensionOf(bot: Bot): string {
  return bot.game.dimension;
}

function isNether(dim: string): boolean {
  return dim === "the_nether" || dim === "minecraft:the_nether";
}

function isOverworld(dim: string): boolean {
  return dim === "overworld" || dim === "minecraft:overworld";
}

export async function returnThroughPortal(bot: Bot): Promise<string> {
  if (!isNether(dimensionOf(bot))) {
    return "Not in the Nether — nothing to return from.";
  }
  const findPortalBlock = () => bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 64 });
  let portal = findPortalBlock();
  if (!portal) {
    // Forge's panicked flights carried him ~250 blocks from the arrival
    // portal, far beyond this search. The village frame's registry entry
    // names the nether-side address by the 8:1 coordinate rule — march
    // toward it on the walk-armor pattern until the doorway shows up.
    const frames = Object.values(bankedFrames);
    if (frames.length === 0) return "Cannot find a nether_portal within 64 blocks and no frame is registered.";
    const target = { x: Math.floor(frames[0].origin.x / 8), z: Math.floor(frames[0].origin.z / 8) };
    const gap = () => Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z);
    console.log(
      `[Portal] ${bot.username}: no portal in sight — marching to the home doorway's nether side at ${target.x},~,${target.z} (${gap().toFixed(0)} away)`,
    );
    const marchDeadline = Date.now() + 240_000;
    // DIG-CAPABLE march, the lesson walk-home paid for: baseMoves cannot dig
    // or swim, so Nether terrain (walls, lava lakes, ravines) pinned Atlas
    // 168 blocks from the doorway for two cycles — he only escaped by dying.
    // A bulldozer profile bores through and bridges, bounded by the standing
    // searchRadius cap. Waypoint hops keep the goal inside that radius.
    const digMoves = baseMoves(bot);
    (digMoves as unknown as { canDig: boolean; allow1by1towers: boolean }).canDig = true;
    (digMoves as unknown as { canDig: boolean; allow1by1towers: boolean }).allow1by1towers = true;
    bot.pathfinder.setMovements(digMoves);
    while (Date.now() < marchDeadline && !portal) {
      const p = bot.entity.position;
      const g = Math.hypot(p.x - target.x, p.z - target.z);
      const frac = Math.min(1, 100 / Math.max(1, g));
      const wx = Math.round(p.x + (target.x - p.x) * frac);
      const wz = Math.round(p.z + (target.z - p.z) * frac);
      await safeGoto(bot, new goals.GoalXZ(wx, wz), 45_000, 12_000).catch(() => {});
      portal = findPortalBlock();
      if (!portal) await new Promise((r) => setTimeout(r, 1500));
    }
    if (!portal) {
      return `Marching home through the Nether — still ${gap().toFixed(0)} blocks from the doorway at ${target.x},~,${target.z}. invoke_skill {"skill":"build_nether_portal"} again to continue from here.`;
    }
  }

  // Same doorway physics as the outbound trip: the pathfinder refuses to
  // path INTO a portal block, so the manual crossing loop does the walking.
  // Forge earned the breach and then stood stranded on this exact line.
  const home = await crossPortal(bot, portal.position, 90_000, isOverworld);
  return home ? "Returned to the overworld." : "Stood at the portal but the return kept getting interrupted.";
}

export const buildNetherPortalSkill: Skill = {
  name: "build_nether_portal",
  description:
    "Build and light a Nether portal near your current position. Casts obsidian from lava and water, crafts an igniter if you lack one, lights the portal, and records its location for return_from_nether. Needs a bucket.",
  params: {},
  // Matches the 420s internal runDeadline (+60s slack): the internal clock
  // self-returns with banked progress, so the watchdog stays a hang-catcher.
  timeoutMs: 480_000,

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, _params, _signal, _onProgress): Promise<SkillResult> {
    const message = await buildNetherPortal(bot);
    const success = message.startsWith("Portal built and lit");
    return { success, message };
  },
};

export const returnFromNetherSkill: Skill = {
  name: "return_from_nether",
  description:
    "Walk to the nearest nether_portal and step through to return to the overworld. Use after build_nether_portal has taken you to the Nether.",
  params: {},

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, _params, _signal, _onProgress): Promise<SkillResult> {
    const message = await returnThroughPortal(bot);
    const success = message === "Returned to the overworld.";
    return { success, message };
  },
};
