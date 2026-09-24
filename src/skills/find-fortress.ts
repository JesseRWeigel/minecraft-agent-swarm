import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto } from "../bot/navigation.js";
import fs from "node:fs";
import { Vec3 } from "vec3";
import { marchToward } from "./loot-bastion.js";
import { type Sighting, parseBank, pickSighting, addSighting, recordApproach, dropSighting } from "./fortress-bank.js";

// Run 711: the east sweep saw nether bricks at (535, 52, -17), Mason died on
// the 100-block approach, and the skill forgot the sighting because it only
// recorded a location on success; the next trip would have swept southeast.
// A sighting is banked the moment it is made, and the next trip marches
// straight to it before sweeping anything.
const SIGHTING_FILE = new URL("../../logs/fortress-sighting.json", import.meta.url).pathname;

function readBank(): Sighting[] {
  try {
    return parseBank(JSON.parse(fs.readFileSync(SIGHTING_FILE, "utf8")));
  } catch {
    return [];
  }
}
function writeBank(all: Sighting[]): void {
  // Study rule: nothing under logs/ is ever deleted. Dropped sightings keep
  // their entry with a droppedAt stamp, so the audit trail holds what was
  // tried as well as what worked.
  try {
    fs.writeFileSync(SIGHTING_FILE, JSON.stringify({ sightings: all }, null, 2));
  } catch {
    /* best effort */
  }
}

/**
 * find_fortress — A Terrible Fortress (nether/find_fortress), the gateway to
 * the whole brewing branch: blaze rods, potions, the zombie-villager cure,
 * and the long-parked trading advancement all sit behind it.
 *
 * The advancement fires on ENTERING the structure, so the job is pure
 * exploration: cross the village portal, sweep a bounded arc for nether
 * bricks (nothing else in the Nether is built from them), walk onto them,
 * record the spot, and come home. Each firing sweeps a different compass
 * heading, so resumable refires compound into a widening search.
 */

const HEADINGS = [
  ["east", 1, 0],
  ["southeast", 0.7, 0.7],
  ["south", 0, 1],
  ["southwest", -0.7, 0.7],
  ["west", -1, 0],
  ["northwest", -0.7, -0.7],
  ["north", 0, -1],
  ["northeast", 0.7, -0.7],
] as const;
// Module-level so refires rotate through headings within a session.
let headingIndex = 0;

/**
 * Run 715: the approach reached thirty-nine blocks with four hundred bricks
 * in view and ended with a twenty-two block fall into lava. Before guessing
 * at the last stretch again, record what is actually between the bot and the
 * bricks: the block under each step of the straight line, and the first drop
 * or lava it crosses.
 */
function logApproachGap(bot: Bot, target: { x: number; y: number; z: number }): void {
  try {
    const p = bot.entity.position;
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const flat = Math.hypot(dx, dz);
    if (flat < 1) return;
    const steps = Math.min(40, Math.round(flat));
    const profile: string[] = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = Math.round(p.x + dx * t);
      const z = Math.round(p.z + dz * t);
      let floorY: number | null = null;
      let floorName = "void";
      for (let y = Math.round(p.y) + 2; y >= Math.round(p.y) - 24; y--) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b) continue;
        if (b.boundingBox === "block" || b.name === "lava") {
          floorY = y;
          floorName = b.name;
          break;
        }
      }
      profile.push(`${floorY === null ? "?" : floorY}${floorName === "lava" ? "L" : floorName === "void" ? "V" : ""}`);
    }
    const lavaAt = profile.findIndex((c) => c.endsWith("L"));
    const voidAt = profile.findIndex((c) => c.endsWith("V") || c.startsWith("?"));
    console.log(
      `[FortressGap] ${bot.username}: from ${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)} to ${target.x},${target.y},${target.z} flat=${flat.toFixed(0)} ` +
        `firstLavaStep=${lavaAt < 0 ? "none" : lavaAt + 1} firstVoidStep=${voidAt < 0 ? "none" : voidAt + 1} floors=${profile.join(",")}`,
    );
  } catch (e) {
    console.log(`[FortressGap] ${bot.username}: profile failed: ${String(e).slice(0, 80)}`);
  }
}

// Zombified piglins are neutral until struck and then come as a pack. Run
// 794's third trip read "zombified_piglin 5.2 away — fighting it off first"
// twice on the walk in, which is a fight the bot cannot win. Leave them be.
const FORTRESS_FOES = new Set(["wither_skeleton", "blaze", "skeleton", "hoglin", "magma_cube"]);

/** Fight anything from FORTRESS_FOES that stands within `radius` before the
 *  walk goes on. Runs 791 and 792: two trips in a row ended "slain by Wither
 *  Skeleton" within a few blocks of (492, 54, 40) during the walk to the
 *  middle of the fortress, while the skill held a sword and never swung it,
 *  and every death there drops the golden boots, the armour and the gold.
 *  Returns how many foes were engaged. */
// When the bot last lost health, so a neutral mob standing on top of it can
// be told from one passing by. Runs 797 and 798: three marches ended "slain
// by Enderman" with no line before the death, because endermen are neutral
// until looked at, the walk looks where it goes, and the foe list left them
// alone while they hit for seven a swing.
const lastHurtAt = new WeakMap<Bot, number>();
function watchHurt(bot: Bot): void {
  if (lastHurtAt.has(bot)) return;
  lastHurtAt.set(bot, 0);
  let last = bot.health;
  bot.on("health", () => {
    if (bot.health < last) lastHurtAt.set(bot, Date.now());
    last = bot.health;
  });
}

async function fendOff(bot: Bot, signal: AbortSignal, radius = 6, budgetMs = 20_000): Promise<number> {
  let engaged = 0;
  const bitten = () => Date.now() - (lastHurtAt.get(bot) ?? 0) < 4_000;
  const until = Date.now() + budgetMs;
  const sword = bot.inventory.items().find((i) => i.name.endsWith("_sword"));
  if (sword && bot.heldItem?.name !== sword.name) await bot.equip(sword, "hand").catch(() => {});
  // Run 817: Mason walked in at 12:1xZ with a crossbow and 24 arrows, this
  // guard met a blaze 3.5 blocks off, chased it with the sword and he was
  // "burned to a crisp while fighting Blaze". With ranged kit aboard, a
  // blaze belongs to the hunt, which shoots from where he stands.
  const ranged =
    bot.inventory.items().some((i) => i.name === "crossbow") &&
    bot.inventory.items().some((i) => i.name === "arrow");
  while (Date.now() < until && !signal.aborted && bot.entity) {
    const me = bot.entity.position;
    const foe = Object.values(bot.entities)
      .filter((e) => {
        if (!e.isValid) return false;
        if (ranged && e.name === "blaze") return false;
        const d = e.position.distanceTo(me);
        if (FORTRESS_FOES.has(e.name ?? "")) return d <= radius;
        // An enderman within arm's reach while health is dropping is the one
        // hitting us; one further off is left alone so it stays neutral.
        return e.name === "enderman" && d <= 3.5 && bitten();
      })
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
    if (!foe) break;
    engaged++;
    console.log(
      `[Fortress] ${bot.username}: ${foe.name} ${foe.position.distanceTo(me).toFixed(1)} away — fighting it off first`,
    );
    const fightUntil = Math.min(until, Date.now() + 12_000);
    const pvp = (bot as unknown as { swordpvp?: { attack: (e: unknown) => void; stop: () => void } }).swordpvp;
    if (pvp) pvp.attack(foe);
    while (foe.isValid && Date.now() < fightUntil && !signal.aborted && bot.entity) {
      const gap = foe.position.distanceTo(bot.entity.position);
      if (!pvp) {
        if (gap <= 3.2) {
          await bot.lookAt(foe.position.offset(0, 1.2, 0), true).catch(() => {});
          bot.attack(foe);
        } else {
          await safeGoto(bot, new goals.GoalNear(foe.position.x, foe.position.y, foe.position.z, 2), 4_000).catch(
            () => {},
          );
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (pvp) pvp.stop();
  }
  return engaged;
}

/** The nearest dropped blaze rod within `radius`, read through the entity's
 *  dropped-item accessor rather than raw metadata. */
function nearestRodDrop(bot: Bot, radius: number): { position: Vec3 } | undefined {
  const me = bot.entity?.position;
  if (!me) return undefined;
  return Object.values(bot.entities)
    .filter((e) => {
      if (e.name !== "item" || !e.isValid || e.position.distanceTo(me) > radius) return false;
      const item = (e as unknown as { getDroppedItem?: () => { name?: string } | null }).getDroppedItem?.();
      return item?.name === "blaze_rod";
    })
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
}

/** Fight blazes within reach of the fortress bricks and pick up their rods.
 *  Bounded to four minutes and six blazes; returns the rods held afterwards. */
async function huntBlazes(
  bot: Bot,
  signal: AbortSignal,
  step: (message: string, progress: number) => void,
): Promise<number> {
  const rodsHeld = () =>
    bot.inventory
      .items()
      .filter((i) => i.name === "blaze_rod")
      .reduce((n, i) => n + i.count, 0);
  const deadline = Date.now() + 240_000;
  let fought = 0;
  const sword = bot.inventory.items().find((i) => i.name.endsWith("_sword"));
  if (sword) await bot.equip(sword, "hand").catch(() => {});
  const crossbow = () => bot.inventory.items().find((i) => i.name === "crossbow");
  const arrows = () =>
    bot.inventory
      .items()
      .filter((i) => i.name === "arrow")
      .reduce((n, i) => n + i.count, 0);
  // One loaded crossbow shot at a blaze; the load-and-fire sequence is the
  // one shoot_arrow uses. Resolves true when the blaze was hurt.
  const shootOnce = async (blaze: { position: Vec3; height?: number; id: number }): Promise<boolean> => {
    const xb = crossbow();
    if (!xb) return false;
    if (bot.heldItem?.name !== "crossbow") await bot.equip(xb, "hand").catch(() => {});
    const aim = () => bot.lookAt(blaze.position.offset(0, (blaze.height ?? 1.8) * 0.7, 0), true).catch(() => {});
    const hurt = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        bot.removeListener("entityHurt" as never, onHurt as never);
        resolve(false);
      }, 4_000);
      const onHurt = (e: { id: number }) => {
        if (e.id === blaze.id) {
          clearTimeout(timer);
          bot.removeListener("entityHurt" as never, onHurt as never);
          resolve(true);
        }
      };
      bot.on("entityHurt" as never, onHurt as never);
    });
    await aim();
    bot.activateItem();
    await new Promise((r) => setTimeout(r, 1_500));
    bot.deactivateItem();
    await new Promise((r) => setTimeout(r, 300));
    await aim();
    bot.activateItem();
    await new Promise((r) => setTimeout(r, 250));
    bot.deactivateItem();
    return hurt;
  };
  while (Date.now() < deadline && !signal.aborted && fought < 6 && bot.entity) {
    // A blaze fight at half health is a death in the Nether with no way home.
    if (bot.health < 8) {
      console.log(`[Fortress] ${bot.username}: health ${bot.health.toFixed(0)}, ending the blaze hunt`);
      break;
    }
    await fendOff(bot, signal);
    if (!bot.entity) break;
    const me = bot.entity.position;
    const blaze = Object.values(bot.entities)
      .filter((e) => e.name === "blaze" && e.isValid && e.position.distanceTo(me) < 40)
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
    if (!blaze) {
      // Rods on the floor count as much as a blaze in the air.
      const drop = nearestRodDrop(bot, 24);
      if (drop) {
        await safeGoto(bot, new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1), 15_000).catch(
          () => {},
        );
        continue;
      }
      step(`In the fortress, no blaze within 40 blocks, holding ${rodsHeld()} rods...`, 0.85);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    fought++;
    step(`Fighting blaze ${fought} at ${blaze.position.floored()}...`, 0.85);
    console.log(
      `[Fortress] ${bot.username}: blaze ${fought} at ${blaze.position.floored()}, ${blaze.position.distanceTo(me).toFixed(0)} away`,
    );
    const fightUntil = Date.now() + 45_000;
    let shots = 0;
    let hits = 0;
    // Run 795: two blazes went "down" (2 hits of 5, then 1 of 2) and no rod
    // was ever seen on the floor. "Down" only means the entity stopped being
    // valid, which a kill and a despawn both do. Record which, and where.
    let fate = "still up";
    let lastSeen = blaze.position.clone();
    const onDead = (e: { id: number }) => {
      if (e.id === blaze.id) fate = "killed";
    };
    const onGone = (e: { id: number }) => {
      if (e.id === blaze.id && fate === "still up") fate = "gone";
    };
    bot.on("entityDead" as never, onDead as never);
    bot.on("entityGone" as never, onGone as never);
    while (blaze.isValid && Date.now() < fightUntil && !signal.aborted && bot.entity && bot.health >= 8) {
      const gap = blaze.position.distanceTo(bot.entity.position);
      if (crossbow() && arrows() > 0) {
        // Stand off and shoot. Run 810: the first blaze was 20 blocks off,
        // the walk to sixteen went over a bridge edge into lava, and no bolt
        // was fired. A crossbow reaches well past twenty, so shoot from where
        // he stands and only close in on a blaze further out than that.
        if (gap > 24) {
          await safeGoto(
            bot,
            new goals.GoalNear(blaze.position.x, blaze.position.y, blaze.position.z, 10),
            8_000,
          ).catch(() => {});
          continue;
        }
        shots++;
        const before = arrows();
        const hitNow = await shootOnce(blaze);
        if (hitNow) hits++;
        console.log(
          `[Fortress] ${bot.username}: shot ${shots} at blaze ${gap.toFixed(1)} away (dy ${(blaze.position.y - bot.entity.position.y).toFixed(1)}): ${hitNow ? "hit" : "no hit seen"}, arrows ${before} -> ${arrows()}`,
        );
        continue;
      }
      if (gap > 3.5) {
        await safeGoto(bot, new goals.GoalNear(blaze.position.x, blaze.position.y, blaze.position.z, 2), 6_000).catch(
          () => {},
        );
      } else {
        await bot.lookAt(blaze.position.offset(0, 1, 0), true).catch(() => {});
        bot.attack(blaze);
        await new Promise((r) => setTimeout(r, 600));
      }
    }
    bot.removeListener("entityDead" as never, onDead as never);
    bot.removeListener("entityGone" as never, onGone as never);
    if (blaze.isValid) lastSeen = blaze.position.clone();
    console.log(
      `[Fortress] ${bot.username}: blaze ${fought} ${blaze.isValid ? "still up" : fate} after ${shots} shots (${hits} hits), last seen ${lastSeen.floored()}, health ${bot.health.toFixed(0)}, arrows ${arrows()}`,
    );
    if (!blaze.isValid && bot.entity) {
      // Everything lying on the floor within 32 blocks, named through the
      // item accessor, so a rod that is there and unread shows up as unread.
      const me = bot.entity.position;
      const drops = Object.values(bot.entities)
        .filter((e) => e.name === "item" && e.isValid && e.position.distanceTo(me) <= 32)
        .map((e) => {
          const item = (e as unknown as { getDroppedItem?: () => { name?: string } | null }).getDroppedItem?.();
          return `${item?.name ?? "unread"}@${e.position.distanceTo(me).toFixed(0)}`;
        });
      console.log(`[Fortress] ${bot.username}: ${drops.length} drops within 32: ${drops.join(" ") || "none"}`);
      if (fate === "killed" && lastSeen.distanceTo(me) <= 20 && !nearestRodDrop(bot, 24)) {
        // Rods land where the blaze died; walk there before giving up.
        await safeGoto(bot, new goals.GoalNear(lastSeen.x, lastSeen.y, lastSeen.z, 2), 12_000).catch(() => {});
      }
    }
    // Run 794, 05:39Z: a blaze went down after ten bolts and the rod was
    // never picked up, because the old search read the item name out of raw
    // metadata and found nothing. Sweep for the rod before the next blaze.
    if (!blaze.isValid) {
      const sweepUntil = Date.now() + 20_000;
      while (Date.now() < sweepUntil && !signal.aborted && bot.entity) {
        const rod = nearestRodDrop(bot, 24);
        if (!rod) break;
        console.log(`[Fortress] ${bot.username}: blaze rod on the floor at ${rod.position.floored()}, fetching it`);
        await safeGoto(bot, new goals.GoalNear(rod.position.x, rod.position.y, rod.position.z, 1), 12_000).catch(
          () => {},
        );
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    // Let the rod drop and land before looking for it.
    await new Promise((r) => setTimeout(r, 1500));
  }
  return rodsHeld();
}

function inNether(bot: Bot): boolean {
  return String(bot.game.dimension).includes("nether");
}

export const findFortressSkill: Skill = {
  name: "find_fortress",
  description:
    "Cross the nether portal and sweep for a nether fortress (nether bricks). Walking into one earns A Terrible Fortress and unlocks the blaze-rod chain. Records the location for later trips.",
  params: {},
  // Run 790, 01:54Z: the trip spent 309 seconds at the stash and the portal
  // (armour check, packing stone, golden boots, crossing) and then marched
  // 504 to 203 blocks out in ninety seconds, the fastest leg of the study,
  // when the 480 second budget ran out and the executor aborted it with the
  // bricks 203 blocks away. The march below is allowed 360 seconds of its
  // own, so the whole trip needs the preflight plus that plus a sweep.
  timeoutMs: 900_000,

  estimateMaterials(): Record<string, number> {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    watchHurt(bot);
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "find_fortress", phase: "Hunt", progress, message, active: true });
    const resumable = (msg: string) => `${msg} invoke_skill {"skill":"find_fortress"} again to continue.`;
    // Dig-capable sweep: the outbound legs now reach 400 blocks per heading,
    // and cautious moves snagged on Nether walls and lava long before that.
    // A bulldozer profile actually tiles the wider search disk instead of
    // stalling on the first ridge. The searchRadius cap bounds it.
    const sweepMoves = baseMoves(bot);
    (sweepMoves as unknown as { canDig: boolean; allow1by1towers: boolean }).canDig = true;
    (sweepMoves as unknown as { canDig: boolean; allow1by1towers: boolean }).allow1by1towers = true;
    // Run 664: the sweep's default four-block drop let Mason step off a
    // Nether ledge into lava at the same spot two days running. Two is a
    // stair, four is a cliff over lava.
    (sweepMoves as unknown as { maxDropDown: number }).maxDropDown = 2;
    // Run 810: Mason left a fortress bridge edge at 0.33 blocks a tick with
    // no key held and fell 22 blocks into lava, seconds into a blaze fight.
    // A sprinting bot carries past the node the planner stopped on, and the
    // bridges have no rails. Walk the whole trip.
    (sweepMoves as unknown as { allowSprinting: boolean }).allowSprinting = false;
    bot.pathfinder.setMovements(sweepMoves);

    // --- Cross over (proven routine) ---
    if (!inNether(bot)) {
      // Run 696: Mason crossed, swept seven legs east and was killed by a
      // piglin at (71, 73, -39) wearing an iron chestplate and no gold.
      // Piglins leave a player alone who wears any one gold piece, and the
      // stash holds a pair of golden boots from the bastion trip. Wear gold
      // before crossing, fetching the boots from the stash when needed.
      const { wearGoldForPiglins, armourUpForNether } = await import("./piglin-gold.js");
      // Hoglins ignore gold, and three of them killed Mason in one hour
      // while he crossed in boots and nothing else. Put a set on first.
      await armourUpForNether(bot, "Fortress", (m) => step(m, 0.04)).catch(() => 0);
      // Run 793, 04:2xZ: the first blaze hunt walked Mason toward a blaze
      // eight blocks off with a sword and its fireballs killed him two blocks
      // below the walkway. A blaze hovers and burns; the armoury holds four
      // crossbows and seventy arrows. Pack them.
      const held = (name: string) =>
        bot.inventory
          .items()
          .filter((i) => i.name === name)
          .reduce((n, i) => n + i.count, 0);
      const { STASH_POS } = await import("../bot/role.js");
      const { withdrawStash } = await import("./stash.js");
      if (held("crossbow") < 1) {
        step("Fetching a crossbow for the blazes...", 0.045);
        await withdrawStash(bot, STASH_POS, "crossbow", 1, 45_000).catch(() => {});
      }
      // Run 809: Mason reached the fortress at 23:4xZ with a crossbow and no
      // arrows and died at sword range to blazes, while the ledger held 58
      // arrows in two chests updated that hour. The withdraw's answer was
      // thrown away, so say it, and try once more when the first walk fails.
      const arrowNotes: string[] = [];
      for (let attempt = 0; attempt < 2 && held("arrow") < 16; attempt++) {
        const r = await withdrawStash(bot, STASH_POS, "arrow", 24, 45_000).catch((e) => String(e?.message ?? e));
        arrowNotes.push(String(r).slice(0, 80));
      }
      console.log(
        `[Fortress] ${bot.username}: ranged kit -> crossbow=${held("crossbow")} arrows=${held("arrow")}${arrowNotes.length ? ` (arrow withdraw: ${arrowNotes.join(" | ")})` : ""}`,
      );
      if (!(await wearGoldForPiglins(bot, "Fortress", (m) => step(m, 0.05)))) {
        return {
          success: false,
          message: resumable(
            "No gold to wear: piglins kill a bot without a gold piece. Bank a golden_boots (4 gold ingots at a crafting table) in the stash first.",
          ),
        };
      }
      step("Stepping through the portal...", 0.1);
      const portal = bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 64 });
      if (!portal)
        return { success: false, message: resumable("No portal within 64 blocks — walk to the village first.") };
      const { crossPortal } = await import("./nether-portal.js");
      const crossed = await crossPortal(bot, portal.position, 30_000, (d) => d.includes("nether"));
      // Run 715: crossPortal sets its own movements and never restores them,
      // so every leg after the crossing ran on the default three-block drop
      // instead of the sweep's two. Mason walked off a lip at y=49 and fell
      // twenty-two blocks into lava thirty-six blocks short of the bricks.
      bot.pathfinder.setMovements(sweepMoves);
      if (!crossed) return { success: false, message: resumable("Couldn't cross the portal this trip.") };
    }

    const homePortal = bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 32 });

    // --- Already visible? ---
    const findBricks = () => bot.findBlock({ matching: (b) => b.name === "nether_bricks", maxDistance: 128 });
    let bricks = findBricks();

    // --- A banked sighting: march there first ---
    const bank = readBank();
    const sighting = pickSighting(bank, bot.entity.position);
    if (!bricks && sighting) {
      const gapTo = () => Math.hypot(bot.entity.position.x - sighting.x, bot.entity.position.z - sighting.z);
      step(`Bricks were seen at (${sighting.x}, ${sighting.y}, ${sighting.z}) — marching there...`, 0.3);
      console.log(
        `[Fortress] ${bot.username}: marching to the banked sighting at ${sighting.x},${sighting.y},${sighting.z} (${Math.round(gapTo())} away)`,
      );
      const reached = await marchToward(bot, sighting, 360_000, signal, {
        beforeHop: async () => {
          await fendOff(bot, signal);
        },
        label: "Marching to the sighted bricks",
        progress: () => 0.4,
        step,
        stop: () => {
          bricks = findBricks();
          return !!bricks || gapTo() <= 40;
        },
      });
      bricks = findBricks();
      // Remember how close this march came. A sighting that has been reached
      // to 84 blocks outranks one that has never beaten 464, and that ranking
      // is the whole point of keeping more than one.
      let updated = recordApproach(bank, sighting, Math.min(reached, gapTo()));
      if (!bricks && gapTo() <= 40) {
        console.log(`[Fortress] ${bot.username}: no bricks within 128 of the sighting; dropping it`);
        updated = dropSighting(updated, sighting);
      }
      writeBank(updated);
    }

    // --- Sweep one heading, scanning as we go ---
    if (!bricks) {
      const [label, dx, dz] = HEADINGS[headingIndex % HEADINGS.length];
      headingIndex++;
      const start = bot.entity.position.clone();
      step(`No fortress in sight — sweeping ${label}...`, 0.3);
      const legDeadline = Date.now() + 300_000;
      for (let leg = 1; leg <= 8 && !bricks && !signal.aborted && Date.now() < legDeadline; leg++) {
        await safeGoto(
          bot,
          new goals.GoalNearXZ(start.x + dx * 50 * leg, start.z + dz * 50 * leg, 8),
          45_000,
          12_000,
        ).catch(() => {});
        bricks = bot.findBlock({ matching: (b) => b.name === "nether_bricks", maxDistance: 128 });
        step(`Sweeping ${label} — leg ${leg}/8, no bricks yet...`, 0.3 + leg * 0.08);
      }
    }

    let entered = false;
    if (bricks) {
      const seen = bricks.position;
      writeBank(
        addSighting(readBank(), {
          x: seen.x,
          y: seen.y,
          z: seen.z,
          seenAt: new Date().toISOString(),
          by: bot.username,
        }),
      );
      step(`NETHER BRICKS at ${seen} — walking into the fortress...`, 0.7);
      // The approach was one 45-second walk repeated for two minutes; the
      // bricks sit up to 128 blocks off. March in hops like the bastion raid.
      const brickGap = () => Math.hypot(bot.entity.position.x - seen.x, bot.entity.position.z - seen.z);
      await marchToward(bot, { x: seen.x, y: seen.y, z: seen.z }, 240_000, signal, {
        beforeHop: async () => {
          await fendOff(bot, signal);
        },
        label: "Walking to the bricks",
        progress: () => 0.75,
        step,
        stop: () => brickGap() <= 6,
      });
      await safeGoto(bot, new goals.GoalNear(seen.x, seen.y + 1, seen.z, 2), 45_000, 12_000).catch(() => {});
      // A Terrible Fortress fires inside the structure's bounds, and the
      // first brick seen is its outer edge. Walk on to the brick nearest the
      // middle of the cluster in view.
      const cluster = bot.findBlocks({ matching: (b) => b.name === "nether_bricks", maxDistance: 48, count: 400 });
      if (cluster.length > 8 && !signal.aborted) {
        const cx = cluster.reduce((n, v) => n + v.x, 0) / cluster.length;
        const cz = cluster.reduce((n, v) => n + v.z, 0) / cluster.length;
        const cy = cluster.reduce((n, v) => n + v.y, 0) / cluster.length;
        let inner = cluster[0];
        let best = Infinity;
        for (const v of cluster) {
          const d = Math.hypot(v.x - cx, v.y - cy, v.z - cz);
          if (d < best) {
            best = d;
            inner = v;
          }
        }
        console.log(
          `[Fortress] ${bot.username}: ${cluster.length} bricks in view, walking to the middle at ${inner.x},${inner.y},${inner.z}`,
        );
        // Walk in short legs and fight off what stands in the way between
        // them, because the whole walk used to run blind for ninety seconds.
        const middleUntil = Date.now() + 90_000;
        while (Date.now() < middleUntil && !signal.aborted && bot.entity) {
          await fendOff(bot, signal);
          if (!bot.entity || bot.entity.position.distanceTo(new Vec3(inner.x, inner.y + 1, inner.z)) <= 3) break;
          await safeGoto(bot, new goals.GoalNear(inner.x, inner.y + 1, inner.z, 2), 15_000, 12_000).catch(() => {});
        }
      }
      const nearBrick = bot.findBlock({ matching: (b) => b.name === "nether_bricks", maxDistance: 4 });
      entered = !!nearBrick;
      if (!entered) logApproachGap(bot, seen);
      const p = bot.entity.position.floored();
      console.log(`[FortressDebug] ${bot.username}: bricks=${seen} stoodAt=${p.x},${p.y},${p.z} entered=${entered}`);
      // Run 791, 02:56Z: A Terrible Fortress landed with Mason among four
      // hundred bricks, and a wither skeleton killed him four seconds later.
      // The next point behind that door is a blaze rod, and nothing in the
      // swarm hunted one, so the trip now does while it is inside.
      if (entered && !signal.aborted) {
        const rods = await huntBlazes(bot, signal, step);
        console.log(`[Fortress] ${bot.username}: blaze hunt done, holding ${rods} blaze rods`);
      }
    }

    // --- Always walk home ---
    // Run 658: Mason died in Nether lava, respawned at the village bed ten
    // blocks from the portal, and this leg then walked him straight back
    // through it; three Nether deaths in five minutes. A death aborts the
    // skill, so honour the signal here, and never "return" through a portal
    // from the Overworld side.
    if (signal.aborted) {
      return {
        success: false,
        message: "Fortress hunt aborted (death or interruption); not walking back through the portal.",
      };
    }
    step("Heading back through the portal...", 0.9);
    if (homePortal && inNether(bot)) {
      await safeGoto(
        bot,
        new goals.GoalNear(homePortal.position.x, homePortal.position.y, homePortal.position.z, 2),
        90_000,
      ).catch(() => {});
      const { crossPortal } = await import("./nether-portal.js");
      await crossPortal(bot, homePortal.position, 30_000, (d) => !d.includes("nether")).catch(() => false);
    }

    if (entered && bricks) {
      return {
        success: true,
        message: `Walked the fortress bricks at ${bricks.position.x},${bricks.position.y},${bricks.position.z} — A Terrible Fortress should be banked (files confirm). Location recorded.`,
        stats: { fortressX: bricks.position.x, fortressY: bricks.position.y, fortressZ: bricks.position.z },
      };
    }
    if (bricks) {
      return {
        success: false,
        message: resumable(
          `Saw nether bricks at ${bricks.position.x},${bricks.position.y},${bricks.position.z} but couldn't reach them this trip.`,
        ),
      };
    }
    return { success: false, message: resumable("No fortress on this heading — next firing sweeps the next one.") };
  },
};
