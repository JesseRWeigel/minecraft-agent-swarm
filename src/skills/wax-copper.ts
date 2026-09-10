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

const HIVE = { x: 472, y: 71, z: -445 };

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
    // 3 logs + 3 sticks + 1 coal/charcoal. Chop logs from the trees around the hive.
    const logsHeld = () =>
      bot.inventory
        .items()
        .filter((i) => i.name.endsWith("_log"))
        .reduce((s, i) => s + i.count, 0);
    for (let tries = 0; logsHeld() < 3 && tries < 6; tries++) {
      const log = bot.findBlock({ matching: (b) => b.name.endsWith("_log"), maxDistance: 16 });
      if (!log) break;
      await safeGoto(bot, new goals.GoalNear(log.position.x, log.position.y, log.position.z, 2), 20_000, 8_000).catch(
        () => {},
      );
      await bot.dig(log).catch(() => {});
      await new Promise((r) => setTimeout(r, 800));
    }
    if (logsHeld() < 3) return `need 3 logs for a campfire, have ${logsHeld()} and no tree within 16 blocks`;
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
    const gap = () => Math.hypot(bot.entity.position.x - HIVE.x, bot.entity.position.z - HIVE.z);
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
      if (g > 24) {
        const t = Math.min(1, 100 / g);
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
      return { success: false, message: resumable(`Couldn't reach the hive — still ${Math.round(gap())} blocks out.`) };
    }
    const hive = bot.blockAt(new (await import("vec3")).Vec3(HIVE.x, HIVE.y, HIVE.z));
    if (!hive || (hive.name !== "bee_nest" && hive.name !== "beehive")) {
      return { success: false, message: resumable(`No hive at ${HIVE.x},${HIVE.y},${HIVE.z} (found ${hive?.name}).`) };
    }

    // --- Shear a honeycomb out of the full hive ---
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
        console.log(`[WaxDebug] ${bot.username}: ${fireProblem}`);
        return {
          success: false,
          message: resumable(
            `Won't harvest without a campfire under the hive (${fireProblem}) — it would kill the last bee.`,
          ),
        };
      }
      step("Shearing honeycomb from the hive...", 0.7);
      const shears = bot.inventory.items().find((i) => i.name === "shears");
      if (shears) await bot.equip(shears, "hand").catch(() => {});
      await bot.activateBlock(hive).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      if (count(bot, "honeycomb") < 1) {
        return {
          success: false,
          message: resumable("Sheared the hive but got no honeycomb — it may not be full yet."),
        };
      }
    }

    // --- Place the copper block and wax it ---
    step("Placing the copper block to wax...", 0.85);
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    const target = bot.blockAt(bot.entity.position.offset(1, 0, 0));
    let placedAt: Block | null = null;
    if (below && target && target.name === "air") {
      const copperItem = bot.inventory.items().find((i) => i.name === "copper_block");
      if (copperItem) {
        await bot.equip(copperItem, "hand").catch(() => {});
        try {
          await bot.placeBlock(below, new (await import("vec3")).Vec3(1, 0, 0));
          placedAt = bot.blockAt(bot.entity.position.offset(1, 0, 0));
        } catch {
          /* placement failed — try activating any copper block in reach below */
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
      stats: { hiveX: HIVE.x, hiveZ: HIVE.z },
    };
  },
};
