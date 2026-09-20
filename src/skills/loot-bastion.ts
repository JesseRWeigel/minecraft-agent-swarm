import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto } from "../bot/navigation.js";
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

export async function marchToward(
  bot: Bot,
  target: { x: number; z: number; y?: number },
  budgetMs: number,
  signal: AbortSignal,
  o: { label: string; progress: (gap: number) => number; step: (m: string, p: number) => void; stop: () => boolean },
): Promise<number> {
  const gap = () => Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z);
  const until = Date.now() + budgetMs;
  let guard = 0;
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
  bot.pathfinder.setMovements(marchMoves);
  while (!o.stop() && !signal.aborted && Date.now() < until) {
    const g = gap();
    await eatOnTheMarch(bot);
    o.step(`${o.label} — ${Math.round(g)} blocks out...`, o.progress(g));
    const before = gap();
    const startOfLeg = bot.entity.position.clone();
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
    if (gap() > 40 && bot.entity.position.distanceTo(startOfLeg) < 5) {
      const p = bot.entity.position;
      const up = Math.round(p.y) + 14;
      const climbed = await safeGoto(bot, new goals.GoalNear(Math.round(p.x), up, Math.round(p.z), 3), 25_000)
        .then(() => true)
        .catch(() => false);
      console.log(
        `[Bastion] ${bot.username}: blocked at y=${p.y.toFixed(0)} with lava ahead, climbing to y=${up} -> ${climbed ? `now y=${bot.entity.position.y.toFixed(0)}` : "failed"}`,
      );
    }

    // A shore walk gains nothing toward the target and is still progress,
    // so count movement, not distance closed. Six such legs end the march.
    const moved = bot.entity.position.distanceTo(startOfLeg);
    if (before - gap() < 8 && moved < 5) {
      logMarchStall(bot, target);
      if (++guard >= 6) break;
    } else guard = 0;
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
