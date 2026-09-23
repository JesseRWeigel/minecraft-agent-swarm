import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto } from "../bot/navigation.js";
import { belowRouteCost, routeFloor } from "../bot/route-floor.js";
import { brakeToStop } from "../bot/brake.js";
import { Vec3 } from "vec3";

/**
 * loot_bastion — Those Were the Days (nether/loot_bastion), which fires the
 * first time a bot opens a loot chest inside a bastion remnant.
 *
 * Unlike the fortress — which the server locates 622 blocks out in the
 * lava-locked direction, unreachable from our portal — the bastion sits at
 * nether (320,-304), only ~387 blocks from the portal exit, and we already
 * earned find_bastion by physically entering it. So this is a reachable,
 * concrete target that also drops the goods gating two more advancements:
 * a saddle (This Boat Has Legs) and crying obsidian (Not Quite Nine Lives).
 *
 * The job: cross the village portal, march dig-capable to the bastion, find a
 * chest on-site (the bot's own block search beats any remote scan), open it —
 * which generates the loot and banks the advancement — grab anything useful,
 * and come home.
 */

// The bastion remnant the server locates from our portal, in Nether coords.
const BASTION = { x: 320, z: -304 };
// Loot worth carrying home if the chest holds it.
const PRIZES = new Set([
  "saddle",
  "crying_obsidian",
  "gilded_blackstone",
  "netherite_scrap",
  "ancient_debris",
  "gold_ingot",
  "gold_block",
  "iron_ingot",
  "diamond",
]);

const EDIBLE = /^(bread|baked_potato|cooked_[a-z]+|beef|porkchop|mutton|chicken|cod|salmon|apple|carrot)$/;

/**
 * Run 705: no override runs while a skill holds the bot, and auto-eat is off,
 * so a nine-minute raid ended at 0 hunger. A player eats on the march.
 */
async function eatOnTheMarch(bot: Bot): Promise<void> {
  if ((bot.food ?? 20) >= 10) return;
  const food = bot.inventory.items().find((i) => EDIBLE.test(i.name));
  if (!food) return;
  try {
    await bot.equip(food, "hand");
    await bot.consume();
    console.log(`[Bastion] ${bot.username}: ate ${food.name} on the march, hunger ${bot.food}/20`);
  } catch (e) {
    console.log(`[Bastion] ${bot.username}: meal on the march failed: ${String(e).slice(0, 80)}`);
  }
}

/**
 * March toward a Nether target in waypoints, eating on the way. Run 703: the
 * march took 100-block waypoints, and from a netherrack shelf at (77, 91, -67)
 * and again at (179, 95, -158) the planner answered "No path" or a phantom
 * arrival for the same waypoint three times, which ended the trip 339 and
 * then 133 blocks out. When the straight waypoint has no route, a leg tries
 * a shorter hop and a slant to either side of the bearing before it counts
 * as dry; three dry legs end the march.
 */
/**
 * Run 720: every leg of four separate marches failed instantly at the same
 * spot, 394 blocks from the target, and the logs carried no position, so
 * there was nothing to reason from. Record where the bot stands, what is
 * under and around it, and the shape of the ground toward the target.
 */
function logMarchStall(bot: Bot, target: { x: number; z: number; y?: number }): void {
  try {
    const p = bot.entity.position;
    const name = (dx: number, dy: number, dz: number) => bot.blockAt(p.offset(dx, dy, dz))?.name ?? "unloaded";
    const bearing = Math.atan2(target.z - p.z, target.x - p.x);
    const fx = Math.cos(bearing);
    const fz = Math.sin(bearing);
    const ahead: string[] = [];
    for (const d of [2, 5, 10, 20, 40]) {
      const x = Math.round(p.x + fx * d);
      const z = Math.round(p.z + fz * d);
      let floorY: number | null = null;
      let floorName = "void";
      for (let y = Math.round(p.y) + 4; y >= Math.round(p.y) - 20; y--) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b) continue;
        if (b.boundingBox === "block" || b.name === "lava") {
          floorY = y;
          floorName = b.name;
          break;
        }
      }
      ahead.push(`${d}:${floorY === null ? "?" : floorY}/${floorName}`);
    }
    console.log(
      `[MarchStall] ${bot.username}: at ${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)} gap=${Math.hypot(p.x - target.x, p.z - target.z).toFixed(0)} ` +
        `feet=${name(0, 0, 0)} head=${name(0, 1, 0)} floor=${name(0, -1, 0)} ahead=${ahead.join(" ")} picks=${bot.inventory.items().filter((i) => /_pickaxe$/.test(i.name)).length} ` +
        `canDig=${(bot.pathfinder.movements as unknown as { canDig: boolean }).canDig} scaffold=${(bot.pathfinder.movements as unknown as { scafoldingBlocks: number[] }).scafoldingBlocks.length}`,
    );
  } catch (e) {
    console.log(`[MarchStall] ${bot.username}: read failed: ${String(e).slice(0, 80)}`);
  }
}

/** Floor material a few steps along the bearing: the reason to climb. */
function lavaAhead(bot: Bot, target: { x: number; z: number }): boolean {
  try {
    const p = bot.entity.position;
    const bearing = Math.atan2(target.z - p.z, target.x - p.x);
    for (const d of [3, 6, 10]) {
      const x = Math.round(p.x + Math.cos(bearing) * d);
      const z = Math.round(p.z + Math.sin(bearing) * d);
      for (let y = Math.round(p.y) + 2; y >= Math.round(p.y) - 16; y--) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b) continue;
        if (b.name === "lava") return true;
        if (b.boundingBox === "block") break;
      }
    }
  } catch {
    /* no opinion */
  }
  return false;
}

export async function marchToward(
  bot: Bot,
  target: { x: number; z: number; y?: number },
  budgetMs: number,
  signal: AbortSignal,
  o: {
    label: string;
    progress: (gap: number) => number;
    step: (m: string, p: number) => void;
    stop: () => boolean;
    /** Runs before every hop; the fortress march fights off what is biting. */
    beforeHop?: () => Promise<void>;
  },
): Promise<number> {
  const gap = () => Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z);
  const until = Date.now() + budgetMs;
  let bestGap = gap();
  let stalledLegs = 0;
  let carveAttempts = 0;
  // The march's movement profile, settled by three measured runs against the
  // same 490-block route to the fortress sighting.
  //   715  towers on,  three-block drop : reached 39 blocks out
  //   717  towers off, two-block drop   : stalled at 390
  //   718  towers on,  two-block drop   : stalled at 395
  // So the drop limit is the variable that decides whether this terrain is
  // passable at all, and towers are not. Three blocks is also the height a
  // player takes without damage, so it costs nothing to allow. The falls
  // that killed Mason on the 715 route were twenty-two and forty-seven
  // blocks, which no planner ever chose; they came from walking off a ledge
  // or a pillar top after a walk ended, and those spots are now recorded as
  // fall origins that every bot's routes avoid for a day.
  const marchMoves = baseMoves(bot);
  (marchMoves as unknown as { canDig: boolean }).canDig = true;
  (marchMoves as unknown as { allow1by1towers: boolean }).allow1by1towers = true;
  (marchMoves as unknown as { maxDropDown: number }).maxDropDown = 3;
  (marchMoves as unknown as { allowParkour: boolean }).allowParkour = false;
  // Run 749: all three of Mason's deaths were "tried to swim in lava" at
  // y=27-31, under bricks at y=51, after the march walked him down into a
  // lava basin three blocks at a time. Price depth below route height so the
  // planner prefers the ridge, and so a bot that is already down there finds
  // climbing out cheaper than carrying on.
  if (target.y !== undefined) {
    const floorY = routeFloor(target.y);
    (marchMoves as unknown as { exclusionAreasStep: ((b: never) => number)[] }).exclusionAreasStep.push(((b: {
      position?: Vec3;
    }) => (b?.position ? belowRouteCost(floorY, b.position.y) : 0)) as unknown as (b: never) => number);
  }
  bot.pathfinder.setMovements(marchMoves);
  while (!o.stop() && !signal.aborted && Date.now() < until) {
    const g = gap();
    await eatOnTheMarch(bot);
    o.step(`${o.label} — ${Math.round(g)} blocks out...`, o.progress(g));
    const before = gap();
    const startOfLeg = bot.entity.position.clone();
    // Run 738: the carve now stops safely beside lava instead of opening it,
    // and it leaves the bot where it stopped: Mason sat at y=27, four blocks
    // under the surface of the lake and twenty-five below the bricks. A
    // march that starts that far down spends its budget in caverns. Climbing
    // back to route height is the same problem the perch search already
    // solves, so run it when the bot is well below the target as well.
    const tooLow = target.y !== undefined && bot.entity.position.y < target.y - 8;
    if (gap() > 40 && (stalledLegs >= 2 || lavaAhead(bot, target) || tooLow)) {
      // Run 724: the first climb aimed fourteen blocks straight up and
      // failed, because the cavern roof is at y=60 and that goal sat inside
      // it. Look for a real perch instead: a block with two open cells above
      // it, within twenty-four blocks up and six to the side, nearest first.
      const p = bot.entity.position.floored();
      const open = (v: Vec3) => {
        const n = bot.blockAt(v)?.name;
        return n === "air" || n === "cave_air" || n === "nether_portal";
      };
      const solid = (v: Vec3) => bot.blockAt(v)?.boundingBox === "block";
      let perch: Vec3 | null = null;
      for (let dy = 3; dy <= 24 && !perch; dy++) {
        for (const [dx, dz] of [
          [0, 0],
          [3, 0],
          [-3, 0],
          [0, 3],
          [0, -3],
          [6, 0],
          [-6, 0],
          [0, 6],
          [0, -6],
        ]) {
          const foot = new Vec3(p.x + dx, p.y + dy, p.z + dz);
          if (open(foot) && open(foot.offset(0, 1, 0)) && solid(foot.offset(0, -1, 0))) {
            perch = foot;
            break;
          }
        }
      }
      let stillStuck = true;
      if (perch) {
        // A climb that goes DOWN first is how run 760 ended. The perch search
        // found a ledge at y=68, the walk to it failed, and Mason came out of
        // it at y=31 in a lava basin, where the carve refused to open the
        // pocket and he burned. The floor cost the march already uses answers
        // this exactly: price every step below the height the climb starts
        // from, so a route that dives to get there is the expensive one.
        const climbFloor = Math.floor(p.y) - 2;
        const climbMoves = baseMoves(bot);
        (climbMoves as unknown as { canDig: boolean }).canDig = true;
        (climbMoves as unknown as { allow1by1towers: boolean }).allow1by1towers = true;
        (climbMoves as unknown as { maxDropDown: number }).maxDropDown = 3;
        (climbMoves as unknown as { exclusionAreasStep: ((b: never) => number)[] }).exclusionAreasStep.push(((b: {
          position?: Vec3;
        }) => (b?.position ? belowRouteCost(climbFloor, b.position.y) : 0)) as unknown as (b: never) => number);
        bot.pathfinder.setMovements(climbMoves);
        const climbed = await safeGoto(bot, new goals.GoalBlock(perch.x, perch.y, perch.z), 30_000)
          .then(() => true)
          .catch(() => false);
        await brakeToStop(bot);
        bot.pathfinder.setMovements(marchMoves);
        stillStuck = !climbed;
        const afterY = bot.entity.position.y;
        console.log(
          `[Bastion] ${bot.username}: at y=${p.y} (${stalledLegs} stalled legs, lavaAhead=${lavaAhead(bot, target)}, tooLow=${tooLow}), climbing to the perch at ${perch.x},${perch.y},${perch.z} -> ${climbed ? "arrived" : "failed"}, now y=${afterY.toFixed(0)} (${(afterY - p.y).toFixed(0)} from the start)`,
        );
      } else {
        console.log(
          `[Bastion] ${bot.username}: at y=${p.y} (${stalledLegs} stalled legs, lavaAhead=${lavaAhead(bot, target)}, tooLow=${tooLow}) and no perch within 24 up`,
        );
      }
      // Run 730: the march stalled at the portal exit (51, 42, -56) with
      // walkable netherrack two, five and ten blocks ahead and every one of
      // the nine hops refused, so a perch existing says nothing about being
      // able to reach it. Carve whenever the bot is still stuck: the
      // staircase skill cuts to y=62 with its own guards, and that is out of
      // both the portal chamber and the cavern beyond it.
      // Run 745: the carve finally gained height, 42 to 47, and stopped with
      // "Ran out of time ... invoke_skill escape_to_surface again to
      // continue". Twenty blocks of staircase does not fit in one budget, and
      // the skill is built to resume. Let it, up to three times a march,
      // while it keeps making ground.
      if (carveAttempts < 3 && p.y < 58 && stillStuck) {
        carveAttempts++;
        const yBefore = bot.entity.position.y;
        const { escapeToSurfaceSkill } = await import("./escape-to-surface.js");
        const r = await escapeToSurfaceSkill
          .execute(bot, {}, signal, () => {})
          .catch((e: Error) => ({ success: false, message: String(e).slice(0, 80) }));
        const gained = bot.entity.position.y - yBefore;
        console.log(
          `[Bastion] ${bot.username}: carving a way out (${carveAttempts}/3) -> ${String(r.message).slice(0, 80)} (now y=${bot.entity.position.y.toFixed(0)}, gained ${gained.toFixed(0)})`,
        );
        // A carve that gains nothing is not going to gain anything on a
        // retry either; stop spending the march on it.
        if (gained < 2) carveAttempts = 3;
      }
    }

    const px = bot.entity.position.x;
    const pz = bot.entity.position.z;
    const bearing = Math.atan2(target.z - pz, target.x - px);
    // Run 720: four marches stalled at exactly 394 blocks out, every leg
    // answering "No path to the goal!" instantly, the fifty-block fallbacks
    // included. A twenty-block hop is the shortest step that still makes
    // progress, and it is the one a walker would take along broken ground.
    // Run 721: the diagnostic named the obstacle. Mason stood at Nether
    // (143, 43, -46) on a dirt ledge with lava at y=31 two, five, ten,
    // twenty and forty blocks ahead: a lava sea across the bearing. Every
    // forward hop is correctly refused, and the slanted ones still head
    // into it. The last two legs run along the shore instead, ninety
    // degrees to either side, which is how a walker finds the way round.
    const tries: Array<[number, number, number]> = [
      [100, 0, 45_000],
      [50, 0, 30_000],
      [50, 0.7, 30_000],
      [50, -0.7, 30_000],
      [20, 0, 20_000],
      [20, 0.9, 20_000],
      [20, -0.9, 20_000],
      [60, Math.PI / 2, 30_000],
      [60, -Math.PI / 2, 30_000],
    ];
    for (const [len, slant, budget] of tries) {
      if (signal.aborted || Date.now() >= until) break;
      if (o.beforeHop) await o.beforeHop();
      if (signal.aborted || !bot.entity) break;
      const reach = Math.min(len, g);
      const wx = Math.round(px + Math.cos(bearing + slant) * reach);
      const wz = Math.round(pz + Math.sin(bearing + slant) * reach);
      // Run 714: a GoalNearXZ ignores height, so the approach to the fortress
      // walked Mason down a ravine, y 56 to 37 over four failed legs, and he
      // died in lava at y=31 thirty-seven blocks short. When the target's
      // height is known, each waypoint carries it, moving at most sixteen
      // blocks of height per leg so the route still follows the terrain.
      const wy =
        target.y === undefined
          ? undefined
          : Math.round(bot.entity.position.y + Math.max(-16, Math.min(16, target.y - bot.entity.position.y)));
      const goal = wy === undefined ? new goals.GoalNearXZ(wx, wz, 10) : new goals.GoalNear(wx, wy, wz, 12);
      bot.pathfinder.setMovements(marchMoves);
      const ok = await safeGoto(bot, goal, budget, 12_000)
        .then(() => true)
        .catch(() => false);
      // Run 750: both lava deaths began here, on the tick a leg let go. The
      // fall records read "controls=none pathing=false" with a block of drift
      // in 193ms, which is sprint speed: leftover momentum, not a planned
      // drop. Sneak until it is spent, and the ledge holds.
      const braked = await brakeToStop(bot);
      if (braked >= 3) {
        console.log(`[Bastion] ${bot.username}: braked ${braked} ticks after a leg ended at speed`);
      }
      if (slant !== 0 || len !== 100) {
        console.log(
          `[Bastion] ${bot.username}: fallback hop ${len} at ${slant > 0 ? "+" : ""}${slant.toFixed(1)} rad -> ${ok ? "reached" : "failed"}, gap ${Math.round(gap())}`,
        );
      }
      if (ok || before - gap() >= 8) break;
    }
    // Run 723: with the death zones capped the march still stopped at the
    // same lake edge, standing at Nether (144, 45, -45) on cobblestone it
    // had placed itself, lava at y=31 ahead for forty blocks. An RCON scan
    // of the next 260 blocks of the bearing is solid rock at y=60, so that
    // ledge sits inside a cavern with a roof. The two marches that ever got
    // through, in runs 714 and 715, walked the deck above it at y=64 and
    // y=54. When every lateral leg fails, climb and try again from up
    // there; the march carries scaffolding and is allowed to tower.
    // Run 725: counting movement instead of distance closed hid the stall
    // completely. The shore hops move the bot more than five blocks every
    // leg, so neither the climb nor the diagnostic ever fired while the
    // march wandered the same lake edge for its whole budget. What counts
    // is the closest the march has ever been: a leg that fails to beat it
    // by eight blocks is a stalled leg, however far the bot walked.
    void before;
    void startOfLeg;
    const now = gap();
    if (now <= bestGap - 8) {
      bestGap = now;
      stalledLegs = 0;
    } else {
      stalledLegs++;
      if (stalledLegs === 2 || stalledLegs === 5) logMarchStall(bot, target);
      if (stalledLegs >= 6) break;
    }
  }
  return gap();
}

function inNether(bot: Bot): boolean {
  return String(bot.game.dimension).includes("nether");
}

export const lootBastionSkill: Skill = {
  name: "loot_bastion",
  description:
    "Cross the nether portal and march to the bastion remnant, then open a loot chest inside it. Opening it earns Those Were the Days and can yield a saddle or crying obsidian.",
  params: {},
  timeoutMs: 900_000,

  estimateMaterials(): Record<string, number> {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "loot_bastion", phase: "Loot", progress, message, active: true });
    const resumable = (msg: string) => `${msg} invoke_skill {"skill":"loot_bastion"} again to continue.`;

    // Dig-and-tower moves: the same bulldozer profile the fortress sweep uses,
    // so Nether walls and ridges don't pin the march short of the bastion.
    const marchMoves = baseMoves(bot);
    (marchMoves as unknown as { canDig: boolean; allow1by1towers: boolean }).canDig = true;
    (marchMoves as unknown as { canDig: boolean; allow1by1towers: boolean }).allow1by1towers = true;
    // Two is a stair, four is a cliff over lava: the same drop limit the
    // fortress sweep took after Mason's ledge falls.
    (marchMoves as unknown as { maxDropDown: number }).maxDropDown = 2;
    bot.pathfinder.setMovements(marchMoves);

    // --- Cross over (proven routine) ---
    if (!inNether(bot)) {
      // Piglins shot armoured Forge dead at the bastion twice; one worn gold
      // piece keeps them neutral. Wear it before the crossing, like the sweep.
      const { wearGoldForPiglins } = await import("./piglin-gold.js");
      if (!(await wearGoldForPiglins(bot, "Bastion", (m) => step(m, 0.05)))) {
        return {
          success: false,
          message: resumable(
            "No gold to wear: piglins kill a bot without a gold piece. Bank a golden_boots in the stash first.",
          ),
        };
      }
      // Run 705: both pickaxes wore out on the march and the raid ended
      // pickless above the chest, at 0 hunger, in a one-wide shaft. Carry a
      // second pick and a few meals when the stash has them; best effort.
      const picks = () => bot.inventory.items().filter((i) => /_pickaxe$/.test(i.name)).length;
      const edibleAboard = () => bot.inventory.items().some((i) => EDIBLE.test(i.name));
      if (picks() < 2 || !edibleAboard()) {
        const { withdrawStash } = await import("./stash.js");
        const { STASH_POS } = await import("../bot/role.js");
        if (picks() < 2) {
          for (const name of ["iron_pickaxe", "stone_pickaxe"]) {
            await withdrawStash(bot, STASH_POS, name, 1, 60_000).catch(() => {});
            if (picks() >= 2) break;
          }
        }
        if (!edibleAboard()) {
          for (const name of ["bread", "baked_potato", "cooked_beef", "cooked_porkchop", "cooked_mutton"]) {
            await withdrawStash(bot, STASH_POS, name, 4, 60_000).catch(() => {});
            if (edibleAboard()) break;
          }
        }
        console.log(`[Bastion] ${bot.username}: packed for the raid — picks ${picks()}, food aboard ${edibleAboard()}`);
      }
      step("Stepping through the portal...", 0.1);
      const portal = bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 64 });
      if (!portal)
        return { success: false, message: resumable("No portal within 64 blocks — walk to the village first.") };
      const { crossPortal } = await import("./nether-portal.js");
      const crossed = await crossPortal(bot, portal.position, 30_000, (d) => d.includes("nether"));
      if (!crossed) return { success: false, message: resumable("Couldn't cross the portal this trip.") };
    }

    // Belt-and-suspenders: crossPortal has resolved true while the bot was
    // still in the overworld (a dimension-event race), and the chest search
    // below then matched a BASE chest at the village — Forge "opened a bastion
    // chest at 285,69,-322", an overworld chest by the stash, and of course
    // Those Were the Days never fired. Only loot when genuinely in the Nether.
    if (!inNether(bot)) {
      return { success: false, message: resumable("Cross reported success but I'm still overworld — retry.") };
    }

    const homePortal = bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 32 });

    // --- March to the bastion in ~100-block hops (inside the searchRadius cap) ---
    const gap = () => Math.hypot(bot.entity.position.x - BASTION.x, bot.entity.position.z - BASTION.z);
    const findChest = () =>
      bot.findBlock({ matching: (b) => b.name === "chest" || b.name === "trapped_chest", maxDistance: 48 });
    let chest = findChest();
    await marchToward(bot, BASTION, 300_000, signal, {
      label: "Marching to the bastion",
      progress: (g) => 0.2 + Math.min(0.4, (387 - g) / 967),
      step,
      stop: () => {
        chest = findChest();
        return !!chest || gap() <= 24;
      },
    });

    // Widen the search once we're in the neighbourhood — bastion chests sit in
    // ramparts and treasure rooms, not always dead-centre.
    if (!chest && gap() <= 64) {
      chest = bot.findBlock({ matching: (b) => b.name === "chest" || b.name === "trapped_chest", maxDistance: 96 });
    }
    if (!chest) {
      return {
        success: false,
        message: resumable(
          gap() > 64
            ? `Couldn't reach the bastion this trip — still ${Math.round(gap())} blocks out.`
            : "At the bastion but no chest in view yet — it may be walled off or already looted.",
        ),
      };
    }

    // --- Approach and open the chest (opening banks the advancement) ---
    step(`Chest at ${chest.position} — walking over to open it...`, 0.7);
    const approachUntil = Date.now() + 90_000;
    while (!signal.aborted && Date.now() < approachUntil && bot.entity.position.distanceTo(chest.position) > 2.5) {
      await safeGoto(
        bot,
        new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2),
        30_000,
        10_000,
      ).catch(() => {});
      if (bot.entity.position.distanceTo(chest.position) > 2.5) await new Promise((r) => setTimeout(r, 800));
    }
    if (bot.entity.position.distanceTo(chest.position) > 3.5) {
      return {
        success: false,
        message: resumable(`Reached the bastion but couldn't get to the chest at ${chest.position}.`),
      };
    }

    const took: string[] = [];
    try {
      const container = await bot.openContainer(chest);
      // The open itself generates the loot and fires Those Were the Days.
      for (const item of container.containerItems()) {
        if (PRIZES.has(item.name)) {
          await container.withdraw(item.type, item.metadata ?? null, item.count).catch(() => {});
          took.push(`${item.count} ${item.name}`);
        }
      }
      await container.close();
    } catch (e) {
      return { success: false, message: resumable(`Found the chest but couldn't open it (${String(e)}).`) };
    }

    // --- Walk home ---
    // Run 710: the walk home was one 90-second walk over 387 blocks, and
    // Mason died on that leg three times today (fire, a chimney, lava while
    // fleeing a ghast) once the stranded rescue took over with 100-block
    // hops. March home the way the march out works, hop by hop with the
    // fallbacks, then step through.
    step("Heading back through the portal...", 0.9);
    if (homePortal) {
      const home = { x: homePortal.position.x, z: homePortal.position.z };
      const homeGap = () => Math.hypot(bot.entity.position.x - home.x, bot.entity.position.z - home.z);
      await marchToward(bot, home, 300_000, signal, {
        label: "Marching home to the portal",
        progress: () => 0.9,
        step,
        stop: () => homeGap() <= 24,
      });
      await safeGoto(
        bot,
        new goals.GoalNear(homePortal.position.x, homePortal.position.y, homePortal.position.z, 2),
        90_000,
      ).catch(() => {});
      const { crossPortal } = await import("./nether-portal.js");
      await crossPortal(bot, homePortal.position, 30_000, (d) => !d.includes("nether")).catch(() => false);
    }

    return {
      success: true,
      message:
        `Opened a bastion chest at ${chest.position.x},${chest.position.y},${chest.position.z} — Those Were the Days should be banked` +
        (took.length ? `; carried out ${took.join(", ")}.` : "."),
      stats: { bastionX: BASTION.x, bastionZ: BASTION.z },
    };
  },
};
