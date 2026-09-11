import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, explorerMoves, safeGoto } from "../bot/navigation.js";

/**
 * wax_copper — Wax On (husbandry/wax_on), which fires the first time a bot
 * applies honeycomb to a copper block.
 *
 * No piglin wall, no Nether, no distant village — everything it needs is
 * reachable from home. Copper the frontier miners pull in quantity; the bee
 * hive the roamers already reach at (472,71,-445) is full (honey_level 5) and
 * gives honeycomb to a shear; and a copper block plus the honeycomb is the
 * whole recipe. So this skill crafts a copper block and shears from ore in
 * pocket, walks to the hive, shears out a honeycomb, places the block, and
 * waxes it.
 */

import { knownNests, nearestNest } from "../bot/nests.js";
export { nearestNest };

export type NestCandidate = { x: number; y: number; z: number; level: number | null; dist: number };

/**
 * Which nest to walk to: the nearest one that reads full; else the nearest
 * whose level is unknown (chunk not loaded yet, so go look); else null when
 * every nest is loaded and below full — nothing to harvest anywhere.
 */
export function chooseNest(cands: NestCandidate[]): NestCandidate | null {
  const byDist = [...cands].sort((a, b) => a.dist - b.dist);
  return byDist.find((c) => c.level !== null && c.level >= FULL_HONEY) ?? byDist.find((c) => c.level === null) ?? null;
}

function count(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((s, i) => s + i.count, 0);
}

/** A crafting table within reach — placing one from pocket if none is nearby. */
async function ensureTable(bot: Bot): Promise<Block | null> {
  const near = () => bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 5 });
  let table = near();
  if (table) return table;
  // Walk to an existing table first (nearest three within 48): the wax run
  // fired with Forge standing in a pond, where there is no dry floor to place
  // a table on, while the village tables sat well within walking range.
  const known = bot
    .findBlocks({ matching: (b) => b.name === "crafting_table", maxDistance: 48, count: 3 })
    .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
  for (const tp of known) {
    await safeGoto(bot, new goals.GoalNear(tp.x, tp.y, tp.z, 2), 20_000, 8_000).catch(() => {});
    table = near();
    if (table) return table;
  }
  // No table walkable: get onto dry ground before placing our own.
  const feetBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0));
  if (!feetBlock || feetBlock.boundingBox !== "block") {
    const f = bot.entity.position.floored();
    let dry: { x: number; y: number; z: number } | null = null;
    outer: for (let r = 1; r <= 10; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          for (let dy = -2; dy <= 2; dy++) {
            const ground = bot.blockAt(f.offset(dx, dy - 1, dz));
            const stand = bot.blockAt(f.offset(dx, dy, dz));
            const head = bot.blockAt(f.offset(dx, dy + 1, dz));
            if (
              ground &&
              ground.boundingBox === "block" &&
              ground.name !== "water" &&
              stand &&
              (stand.name === "air" || stand.name === "cave_air") &&
              head &&
              (head.name === "air" || head.name === "cave_air")
            ) {
              dry = f.offset(dx, dy, dz);
              break outer;
            }
          }
        }
      }
    }
    if (dry) {
      await safeGoto(bot, new goals.GoalBlock(dry.x, dry.y, dry.z), 15_000, 6_000).catch(() => {});
    } else {
      console.log(`[WaxDebug] ${bot.username}: standing on ${feetBlock?.name} and no dry ground within 10 blocks`);
    }
  }
  const mcData = (await import("minecraft-data")).default(bot.version);
  const planksHeld = bot.inventory
    .items()
    .filter((i) => i.name.endsWith("_planks"))
    .reduce((s, i) => s + i.count, 0);
  // Get a table item in pocket — craft one from planks (or logs) if needed.
  if (!bot.inventory.items().some((i) => i.name === "crafting_table")) {
    if (planksHeld < 4) {
      // Convert a log to planks first if the bot is out of planks.
      const log = bot.inventory.items().find((i) => i.name.endsWith("_log"));
      if (log) {
        const plankName = log.name.replace("_log", "_planks");
        const pdef = mcData.itemsByName[plankName];
        const prec = pdef ? bot.recipesFor(pdef.id, null, 1, null)[0] : null;
        if (prec) await bot.craft(prec, 1).catch(() => {});
      }
    }
    const rec = bot.recipesFor(mcData.itemsByName.crafting_table.id, null, 1, null)[0];
    if (rec) await bot.craft(rec, 1).catch(() => {});
  }
  const tableItem = bot.inventory.items().find((i) => i.name === "crafting_table");
  if (!tableItem) {
    console.log(`[WaxDebug] ${bot.username}: no crafting table and only ${planksHeld} planks to craft one`);
    return null;
  }
  await bot.equip(tableItem, "hand").catch(() => {});
  // Try to place on any solid block with air above it, all 8 neighbours plus
  // the block directly under the bot's feet (step off it after).
  const { Vec3 } = await import("vec3");
  const dirs: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  for (const [dx, dz] of dirs) {
    const floor = bot.blockAt(bot.entity.position.offset(dx, -1, dz));
    const spot = bot.blockAt(bot.entity.position.offset(dx, 0, dz));
    if (floor && floor.boundingBox === "block" && spot && (spot.name === "air" || spot.name === "cave_air")) {
      try {
        await bot.placeBlock(floor, new Vec3(0, 1, 0));
        table = near();
        if (table) return table;
      } catch {
        /* try the next side */
      }
    }
  }
  if (!near()) {
    const feet = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    console.log(
      `[WaxDebug] ${bot.username}: couldn't place a table at ${bot.entity.position.floored()} ` +
        `(standing on ${feet?.name}, ${planksHeld} planks) — terrain too tight`,
    );
  }
  return near();
}

async function craftItem(bot: Bot, name: string): Promise<boolean> {
  const mcData = (await import("minecraft-data")).default(bot.version);
  const item = mcData.itemsByName[name];
  if (!item) return false;
  const table = await ensureTable(bot);
  const recipe = bot.recipesFor(item.id, null, 1, table ?? null)[0];
  if (!recipe) return false;
  try {
    await bot.craft(recipe, 1, table ?? undefined);
    return true;
  } catch {
    return false;
  }
}

/** How far the campfire step will walk for logs. The nest's own tree is gone. */
const CAMPFIRE_LOG_RADIUS = 64;

/** Honey level a nest must reach before shearing yields a honeycomb. */
export const FULL_HONEY = 5;

/** The nest's honey level from its block state, or null if unreadable. */
export function honeyLevel(props: Record<string, unknown> | undefined): number | null {
  const raw = props?.honey_level;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Where a campfire can go under the hive: the first solid block within 5
 * below it (air between it and the hive, since it is the first solid). Returns
 * the y of the block to place ON, or null when the hive hangs over open air.
 */
export function campfireSeatY(
  blockAt: (x: number, y: number, z: number) => { name: string; boundingBox: string } | null,
  hx: number,
  hy: number,
  hz: number,
): number | null {
  for (let dy = 2; dy <= 5; dy++) {
    const seat = blockAt(hx, hy - dy, hz);
    if (seat && seat.boundingBox === "block") return hy - dy;
  }
  return null;
}

/**
 * A lit campfire under the hive keeps the bees calm when the comb is taken.
 * Without it every harvest angers the colony, the bees sting and die, and the
 * nest stops refilling — the hive at 472,71,-445 was down to one bee and
 * honey level 0 after four bare shears. Crafts the campfire from pocket coal
 * and sticks plus three logs chopped nearby, and seats it below the nest.
 */
async function ensureCampfire(bot: Bot, hive: Block): Promise<string | null> {
  const { Vec3 } = await import("vec3");
  const at = (x: number, y: number, z: number) => bot.blockAt(new Vec3(x, y, z));
  const hx = hive.position.x;
  const hy = hive.position.y;
  const hz = hive.position.z;
  for (let dy = 1; dy <= 5; dy++) {
    if (at(hx, hy - dy, hz)?.name === "campfire") return null; // already protected
  }
  const seatY = campfireSeatY(at, hx, hy, hz);
  if (seatY === null) return "no clear spot for a campfire under the hive";
  if (count(bot, "campfire") < 1) {
    // 3 logs + 3 sticks + 1 coal/charcoal. The campfire recipe takes any log
    // or wood block. The nest's own tree is gone (air under the nest — the
    // bots cut it for planks), so look 64 blocks out and walk to the tree.
    const isLog = (n: string) =>
      n.endsWith("_log") || n.endsWith("_wood") || n.endsWith("_stem") || n.endsWith("_hyphae");
    const logsHeld = () =>
      bot.inventory
        .items()
        .filter((i) => isLog(i.name))
        .reduce((s, i) => s + i.count, 0);
    for (let tries = 0; logsHeld() < 3 && tries < 8; tries++) {
      const log = bot.findBlock({ matching: (b) => isLog(b.name), maxDistance: CAMPFIRE_LOG_RADIUS });
      if (!log) break;
      await safeGoto(bot, new goals.GoalNear(log.position.x, log.position.y, log.position.z, 2), 40_000, 12_000).catch(
        () => {},
      );
      const again = bot.blockAt(log.position);
      if (again && isLog(again.name) && bot.canDigBlock(again)) {
        await bot.dig(again).catch(() => {});
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    if (logsHeld() < 3) {
      await safeGoto(bot, new goals.GoalNear(hx, hy, hz, 3), 40_000, 12_000).catch(() => {});
      return `need 3 logs for a campfire, have ${logsHeld()} and no tree within ${CAMPFIRE_LOG_RADIUS} blocks`;
    }
    // Back to the nest with the logs before crafting and placing.
    await safeGoto(bot, new goals.GoalNear(hx, hy, hz, 3), 40_000, 12_000).catch(() => {});
    if (count(bot, "stick") < 3) {
      const planks = bot.inventory.items().find((i) => i.name.endsWith("_planks"));
      if (planks) await craftItem(bot, "stick").catch(() => {});
    }
    if (count(bot, "coal") + count(bot, "charcoal") < 1) return "need coal or charcoal for a campfire";
    if (!(await craftItem(bot, "campfire"))) return "couldn't craft a campfire (table or recipe)";
  }
  const campfire = bot.inventory.items().find((i) => i.name === "campfire");
  if (!campfire) return "campfire missing after crafting";
  const seat = at(hx, seatY, hz);
  if (!seat) return "campfire seat block unloaded";
  await safeGoto(bot, new goals.GoalNear(hx, seatY + 1, hz, 2), 20_000, 8_000).catch(() => {});
  await bot.equip(campfire, "hand").catch(() => {});
  try {
    await bot.placeBlock(seat, new Vec3(0, 1, 0));
  } catch (err) {
    return `couldn't place the campfire: ${err instanceof Error ? err.message : String(err)}`;
  }
  await new Promise((r) => setTimeout(r, 500));
  return at(hx, seatY + 1, hz)?.name === "campfire" ? null : "campfire didn't land under the hive";
}

/** Walk over any honeycomb item lying near the hive and pick it up. */
async function collectDroppedHoneycomb(
  bot: Bot,
  near: { x: number; y: number; z: number },
  budgetMs: number,
): Promise<void> {
  const until = Date.now() + budgetMs;
  const nearby = () =>
    Object.values(bot.entities).filter((e) => {
      if (e.name !== "item" || !e.position) return false;
      const dropped = e.getDroppedItem?.();
      return !!dropped && dropped.name === "honeycomb" && e.position.distanceTo(bot.entity.position) < 16;
    });
  while (Date.now() < until && count(bot, "honeycomb") < 1) {
    const drops = nearby();
    if (drops.length === 0) {
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    const d = drops[0].position;
    console.log(`[WaxDebug] ${bot.username}: honeycomb on the ground at ${d.floored()} — collecting`);
    await safeGoto(bot, new goals.GoalNear(Math.floor(d.x), Math.floor(d.y), Math.floor(d.z), 1), 12_000, 5_000).catch(
      () => {},
    );
    await new Promise((r) => setTimeout(r, 900));
    if (count(bot, "honeycomb") < 1 && bot.entity.position.distanceTo(d) < 2.5) {
      // standing beside it and still nothing: nudge through it
      bot.setControlState("forward", true);
      await new Promise((r) => setTimeout(r, 400));
      bot.setControlState("forward", false);
    }
  }
  if (count(bot, "honeycomb") < 1 && Math.hypot(bot.entity.position.x - near.x, bot.entity.position.z - near.z) > 6) {
    await safeGoto(bot, new goals.GoalNear(near.x, near.y, near.z, 3), 10_000, 5_000).catch(() => {});
  }
}

export const waxCopperSkill: Skill = {
  name: "wax_copper",
  description:
    "Craft a copper block and shears, shear a honeycomb from the bee hive, and wax the block. Earns Wax On — no Nether, no piglins.",
  params: {},
  timeoutMs: 300_000,

  // NO precondition. mineflayer's client inventory goes stale after a death —
  // a Forge holding 26 copper (confirmed from an opened window) reads as 1 to
  // the count-based precondition, which then blocks the skill from ever
  // running. The skill resyncs and checks its own materials below instead.
  estimateMaterials(): Record<string, number> {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "wax_copper", phase: "Wax", progress, message, active: true });
    const resumable = (msg: string) => `${msg} invoke_skill {"skill":"wax_copper"} again to continue.`;

    // --- Resync the client inventory first ---
    // Post-death, the bot's own view of its pack drifts stale (it read 1
    // copper while a freshly opened window showed 26). Opening any container
    // makes the server resend the full inventory, so do that before trusting
    // any count below. A failed open still triggers the resend.
    step("Refreshing inventory...", 0.03);
    const resyncBlock = bot.findBlock({
      matching: (b) => b.name === "chest" || b.name === "trapped_chest",
      maxDistance: 10,
    });
    if (resyncBlock) {
      try {
        const w = await bot.openContainer(resyncBlock);
        await new Promise((r) => setTimeout(r, 400));
        w.close();
      } catch {
        /* even a failed open resends the inventory window */
      }
    }

    // --- Ensure a copper block ---
    step("Checking materials...", 0.05);
    if (count(bot, "copper_block") < 1) {
      if (count(bot, "copper_ingot") < 9) {
        return {
          success: false,
          message: resumable(`Only ${count(bot, "copper_ingot")} copper — need 9 for a block.`),
        };
      }
      if (!(await craftItem(bot, "copper_block"))) {
        return { success: false, message: resumable("Couldn't craft the copper block (no table in reach?).") };
      }
    }

    // --- Ensure shears (honeycomb needs a shear) ---
    if (count(bot, "shears") < 1) {
      if (count(bot, "iron_ingot") < 2) {
        return { success: false, message: resumable(`Only ${count(bot, "iron_ingot")} iron — need 2 for shears.`) };
      }
      if (!(await craftItem(bot, "shears"))) {
        return { success: false, message: resumable("Couldn't craft shears.") };
      }
    }

    // A comb already in the pack means the hive work is done: go straight to
    // waxing. The first collected comb was thrown away because the retry
    // re-read the (now empty) nest and stood down before looking in the pack.
    // A comb from the last harvest may be lying right here: pick it up before
    // any nest logic, or a retry reads the emptied nest and stands down with
    // the comb three blocks away (06:44Z, comb at 452,70,-364).
    if (count(bot, "honeycomb") < 1) await collectDroppedHoneycomb(bot, bot.entity.position, 12_000);
    if (count(bot, "honeycomb") < 1) {
      // --- Walk to the hive: hybrid surface-then-dig, like the frontier ferry ---
      // A plain surface walk stalled 409 blocks out on a ridge (the wax reflex
      // fires from wherever Forge banked his copper, often far from the hive),
      // and at that range the hive chunk isn't even loaded — blockAt returned
      // undefined. So walk on the surface by default and dig through when a hop
      // stalls, on a generous budget, until the hive column is close enough to
      // load and read.
      const surfaceWalk = explorerMoves(bot);
      const digWalk = baseMoves(bot);
      (digWalk as unknown as { canDig: boolean; allow1by1towers: boolean; maxDropDown: number }).canDig = true;
      (digWalk as unknown as { canDig: boolean; allow1by1towers: boolean; maxDropDown: number }).allow1by1towers = true;
      (digWalk as unknown as { canDig: boolean; allow1by1towers: boolean; maxDropDown: number }).maxDropDown = 3;
      const { Vec3: V3 } = await import("vec3");
      const cands: NestCandidate[] = knownNests().map((n) => {
        const b = bot.blockAt(new V3(n.x, n.y, n.z));
        const isNest = !!b && (b.name === "bee_nest" || b.name === "beehive");
        const level = isNest ? honeyLevel(b!.getProperties() as Record<string, unknown>) : null;
        return { ...n, level, dist: Math.hypot(bot.entity.position.x - n.x, bot.entity.position.z - n.z) };
      });
      let HIVE = chooseNest(cands);
      if (!HIVE) {
        // Every known nest is loaded and below full. If one is refilling (level
        // above zero) and we are standing at it, wait here and poll: a bee adds
        // a level every few minutes, and walking away costs the trip back.
        const best = [...cands].sort((a, b) => (b.level ?? 0) - (a.level ?? 0) || a.dist - b.dist)[0];
        if (best && (best.level ?? 0) >= 1 && best.dist <= 8) {
          const until = Date.now() + 180_000;
          let level = best.level ?? 0;
          while (Date.now() < until && !signal.aborted && level < FULL_HONEY) {
            step(`Nest at honey ${level}/${FULL_HONEY} — waiting beside it for the bees...`, 0.6);
            await new Promise((r) => setTimeout(r, 10_000));
            const b = bot.blockAt(new V3(best.x, best.y, best.z));
            level = (b && honeyLevel(b.getProperties() as Record<string, unknown>)) ?? level;
          }
          if (level >= FULL_HONEY) {
            HIVE = { ...best, level };
          } else {
            return {
              success: false,
              message: resumable(
                `Nest at ${best.x},${best.y},${best.z} is at honey ${level}/${FULL_HONEY} — refilling. Stay near; come back shortly.`,
              ),
              stats: { bestHoney: level },
            };
          }
        } else {
          const report = cands.map((c) => `${c.x},${c.y},${c.z} at ${c.level}/${FULL_HONEY}`).join("; ");
          return {
            success: false,
            message: resumable(`No nest is full yet (${report}). Let the bees work; come back later.`),
            stats: { bestHoney: Math.max(...cands.map((c) => c.level ?? 0)) },
          };
        }
      }
      // Arrival is THREE-dimensional: Forge once stood at y=12 directly under
      // the nest at y=72, the XZ gap read 7, the walk stopped and the shear
      // clicked sixty blocks of rock.
      const gapXZ = () => Math.hypot(bot.entity.position.x - HIVE.x, bot.entity.position.z - HIVE.z);
      const gap = () =>
        Math.hypot(bot.entity.position.x - HIVE.x, bot.entity.position.y - HIVE.y, bot.entity.position.z - HIVE.z);
      const walkUntil = Date.now() + 240_000;
      let guard = 0;
      let digging = false;
      while (gap() > 4 && !signal.aborted && Date.now() < walkUntil) {
        const g = gap();
        step(
          `Walking to the bee hive — ${Math.round(g)} blocks out${digging ? " (digging through)" : ""}...`,
          0.2 + Math.min(0.4, (400 - g) / 1000),
        );
        bot.pathfinder.setMovements(digging ? digWalk : surfaceWalk);
        const before = gap();
        // Step toward a waypoint ~100 blocks ahead, NOT a goal hundreds of blocks
        // out. The frontier ferry closes ground reliably for exactly this reason:
        // a near goal is a small pathfinder search it can solve, while a distant
        // GoalNear makes it search an enormous space, give up, and barely move —
        // which is why this walk sat at 358 blocks out closing nothing. Only aim
        // the GoalNear at the hive block itself on the final approach.
        if (gapXZ() > 24) {
          const t = Math.min(1, 100 / gapXZ());
          const wx = Math.round(bot.entity.position.x + (HIVE.x - bot.entity.position.x) * t);
          const wz = Math.round(bot.entity.position.z + (HIVE.z - bot.entity.position.z) * t);
          await safeGoto(bot, new goals.GoalNearXZ(wx, wz, 10), 45_000, 12_000).catch(() => {});
        } else {
          await safeGoto(bot, new goals.GoalNear(HIVE.x, HIVE.y, HIVE.z, 3), 45_000, 12_000).catch(() => {});
        }
        if (before - gap() >= 6) {
          guard = 0;
          digging = false;
        } else if (++guard >= 3) {
          if (!digging) {
            digging = true;
            guard = 0;
          } else break;
        }
      }
      if (gap() > 8) {
        const dy = Math.round(HIVE.y - bot.entity.position.y);
        return {
          success: false,
          message: resumable(
            `Couldn't reach the hive — still ${Math.round(gap())} blocks out${Math.abs(dy) > 4 ? ` (${Math.abs(dy)} blocks ${dy > 0 ? "below" : "above"} it)` : ""}.`,
          ),
        };
      }
      const hive = bot.blockAt(new (await import("vec3")).Vec3(HIVE.x, HIVE.y, HIVE.z));
      if (!hive || (hive.name !== "bee_nest" && hive.name !== "beehive")) {
        return {
          success: false,
          message: resumable(`No hive at ${HIVE.x},${HIVE.y},${HIVE.z} (found ${hive?.name}).`),
        };
      }

      // --- Shear a honeycomb out of the full hive ---
      // A comb from an earlier harvest may still be lying here (they last 5 min).
      if (count(bot, "honeycomb") < 1) await collectDroppedHoneycomb(bot, hive.position, 6_000);
      if (count(bot, "honeycomb") < 1) {
        // Shearing does nothing below honey level 5, and the bees only refill
        // the nest while alive — so read the level first instead of clicking.
        const level = honeyLevel(hive.getProperties() as Record<string, unknown>);
        if (level !== null && level < FULL_HONEY) {
          return {
            success: false,
            message: resumable(
              `Hive is at honey ${level}/${FULL_HONEY} — not full yet. Let the bee work; come back later.`,
            ),
            stats: { honeyLevel: level },
          };
        }
        step("Seating a campfire under the hive so the bees stay calm...", 0.65);
        const fireProblem = await ensureCampfire(bot, hive);
        if (fireProblem) {
          // Best effort only. The second nest sits in a treeless meadow (an RCON
          // scan found no log within 64 blocks), so refusing here would leave a
          // full nest and a ready copper block unused forever. Harvest anyway
          // and say so: the colony may sting and die, and later honey work will
          // need one of the other bees in the world.
          console.log(`[WaxDebug] ${bot.username}: harvesting WITHOUT a campfire (${fireProblem}) — bees may be lost`);
          step("No campfire possible here — harvesting anyway...", 0.68);
        }
        step("Shearing honeycomb from the hive...", 0.7);
        const shears = bot.inventory.items().find((i) => i.name === "shears");
        if (shears) await bot.equip(shears, "hand").catch(() => {});
        await bot.activateBlock(hive).catch(() => {});
        await new Promise((r) => setTimeout(r, 800));
        // Shearing pops the combs out as ITEM ENTITIES; nothing lands in the
        // pack by itself. The first live harvest (02:41Z, 2026-09-11) emptied
        // the nest 5→0 and left the honeycomb on the grass while the bot
        // walked off to mine; it despawned. Walk over the drops.
        await collectDroppedHoneycomb(bot, hive.position, 30_000);
        if (count(bot, "honeycomb") < 1) {
          return {
            success: false,
            message: resumable("Sheared the hive but got no honeycomb — it may not be full yet."),
          };
        }
      }
    }

    // --- Place the copper block and wax it ---
    // Reference the FLOOR UNDER THE TARGET and place on its top face. The old
    // code placed against the block under the bot's own feet on its east face,
    // which is the solid ground one level down beside it, so nothing was ever
    // placed and the comb went to waste.
    step("Placing the copper block to wax...", 0.85);
    const { Vec3: PV } = await import("vec3");
    let placedAt: Block | null = null;
    const copperItem = bot.inventory.items().find((i) => i.name === "copper_block");
    if (copperItem) {
      await bot.equip(copperItem, "hand").catch(() => {});
      const feetPos = bot.entity.position.floored();
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const floor = bot.blockAt(feetPos.offset(dx, -1, dz));
        const spot = bot.blockAt(feetPos.offset(dx, 0, dz));
        if (!floor || floor.boundingBox !== "block" || !spot || (spot.name !== "air" && spot.name !== "cave_air"))
          continue;
        try {
          await bot.placeBlock(floor, new PV(0, 1, 0));
          const now = bot.blockAt(feetPos.offset(dx, 0, dz));
          if (now && now.name.includes("copper")) {
            placedAt = now;
            break;
          }
        } catch (err) {
          console.log(
            `[WaxDebug] ${bot.username}: place at ${feetPos.offset(dx, 0, dz)} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    const copperBlock =
      placedAt && placedAt.name.includes("copper")
        ? placedAt
        : bot.findBlock({ matching: (b) => b.name === "copper_block", maxDistance: 4 });
    if (!copperBlock) {
      return { success: false, message: resumable("Couldn't place the copper block to wax.") };
    }

    step("Waxing the copper with honeycomb...", 0.95);
    const comb = bot.inventory.items().find((i) => i.name === "honeycomb");
    if (comb) await bot.equip(comb, "hand").catch(() => {});
    await bot.activateBlock(copperBlock).catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));

    const waxed = bot.blockAt(copperBlock.position);
    const success = !!waxed && waxed.name.startsWith("waxed_");
    return {
      success,
      message: success
        ? "Waxed a copper block with honeycomb — Wax On should be banked."
        : resumable("Applied the honeycomb but the block didn't read as waxed — retry."),
      stats: { waxedX: copperBlock.position.x, waxedZ: copperBlock.position.z },
    };
  },
};
