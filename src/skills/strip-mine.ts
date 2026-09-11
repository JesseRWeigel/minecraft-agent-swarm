import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import { baseMoves, collectNearbyDrops, safeGoto, shedJunk } from "../bot/navigation.js";
import { digDownTo } from "./descend.js";

const TUNNEL_LENGTH = 40;
const TORCH_INTERVAL = 6;
// Y=15: iron's statistical peak is y=16, and tunnels now start 60+ blocks
// from the village (mission rule), so the peak band is fresh rock again.
// The y=8 detour — chosen when tunnels still started inside the mined-out
// village — produced a dozen deep tunnels of copper and no iron.
const TARGET_Y = 15;

export const stripMineSkill: Skill = {
  name: "strip_mine",
  description:
    "Dig a mining tunnel for ores. Staircases down to Y=11 if needed, then mines 30 blocks horizontally with torch lighting. Requires a pickaxe.",
  params: {},
  // The diamond run is a 150s-capped hike plus a ~130-block descent plus the
  // tunnel itself; 240s killed it mid-descent at y=-14 (run 370). Every phase
  // in here carries its own deadline, so the bigger envelope stays bounded.
  timeoutMs: 900_000,

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    // Soft deadline UNDER the 480s watchdog. The phase budget was
    // overcommitted: deposit + withdrawals + 150s hike + 280s descent leaves
    // nothing for a tunnel whose 40 steps each carry a dig plus a 3s pickup
    // sweep — run 382 lost ELEVEN trips as 480s watchdog kills, every one
    // discarding whatever cargo was already pocketed. Ending the tunnel early
    // returns a normal completion report instead.
    const skillStart = Date.now();
    const softExpired = () => Date.now() - skillStart > 840_000;

    // Verify pickaxe — and SELF-SUPPLY one first, the house pattern.
    // Bouncing "use craft_gear first" back to the model lost whole hours:
    // the advice was read, echoed, and wandered away from, and craft_gear
    // was never once invoked in a full run. Run the gear craft inline.
    let pickaxe = bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
    if (!pickaxe) {
      const { craftGearSkill } = await import("./craft-gear.js");
      // 180s cap: runs 383-384 lost 33 trips to watchdog kills that all began
      // inside this call — an unbounded gear-up eats the whole trip envelope.
      await craftGearSkill.execute(bot, { deadlineMs: 180_000 }, signal, onProgress).catch(() => {});
      pickaxe = bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
    }
    if (!pickaxe) {
      // The chest before the forge: thirty wooden and eighteen stone spares
      // sat banked while this gate bounced pickless miners three times in a
      // row — the reclaim preamble lives BELOW this early return and never
      // ran for a bot holding no pick at all.
      try {
        const { withdrawStash } = await import("./stash.js");
        const { STASH_POS: SP0 } = await import("../bot/role.js");
        const nearHome = Math.hypot(bot.entity.position.x - SP0.x, bot.entity.position.z - SP0.z) < 60;
        if (nearHome) {
          for (const want of ["diamond_pickaxe", "iron_pickaxe", "stone_pickaxe", "wooden_pickaxe"]) {
            await Promise.race([
              withdrawStash(bot, SP0, want, 1),
              new Promise<void>((resolve) => setTimeout(resolve, 45_000)),
            ]).catch(() => {});
            pickaxe = bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
            if (pickaxe) break;
          }
        }
      } catch {
        /* stash unavailable — fall through to the honest failure */
      }
    }
    if (!pickaxe) {
      return {
        success: false,
        message: "Need a pickaxe and could not craft one — stash is out of cobblestone or sticks.",
      };
    }
    // The soft deadline only guarded the tunnel loop, but run 383's FIFTEEN
    // watchdog kills all died before the first hike progress line — the
    // inline gear-up (tree chopping, cobble mining, deaths mid-errand) can
    // eat the whole envelope on a bad day. Bail honestly at each phase
    // boundary instead of letting the watchdog discard the trip.
    if (softExpired()) {
      return {
        success: false,
        message: "Trip clock ran out while gearing up — run strip_mine again to continue.",
      };
    }

    // Hard cap on any single stash operation. Run 386 lost 43 trips to 900s
    // watchdog kills all stuck at "(0%)": depositStash/withdrawStash have no
    // internal deadline — 61 chests, per-chest walks and 10s container opens,
    // mob interruptions — and a blocking await is immune to the boundary
    // clocks. The raced-out operation finishes as a short-lived zombie; the
    // nav generation counter keeps its walks from contesting the trip.
    const raced = async <T>(p: Promise<T>, ms: number, label: string): Promise<T | string> =>
      Promise.race([p, new Promise<string>((r) => setTimeout(() => r(`${label} timed out after ${ms / 1000}s`), ms))]);

    let mined = 0;
    let oreChases = 0;
    const oresFound: string[] = [];

    // EMPTY THE PACK before mining: three bots sat at 36 of 36 slots and one
    // at 35 — a full inventory silently rejects every pickup, which is where
    // days of dug ore actually went. The deposit action exists but the model
    // never chooses it, so the mine does its own banking when nearly full.
    {
      const freeSlots = 36 - bot.inventory.items().length;
      const { STASH_POS } = await import("../bot/role.js");
      if (freeSlots < 6 && !signal.aborted) {
        // TOSS mining junk instead of banking it. The stash is 87 chests of
        // accumulated cobblestone/dirt and rejects deposits ("chest_full after
        // 87 chests"), so the pre-mine deposit was losing the VALUABLE ore
        // mixed into the pack — the swarm mined iron for days and stayed naked.
        // A miner that tosses its worthless blocks (like a real player clearing
        // a full inventory) stays light AND retains its ore in-pocket, where
        // the smelt and armour reflexes use it directly — no clogged-stash
        // round-trip. A cobblestone reserve is kept for towering/scaffolding.
        const JUNK = new Set([
          "cobbled_deepslate",
          "dirt",
          "gravel",
          "andesite",
          "diorite",
          "granite",
          "tuff",
          "netherrack",
          "deepslate",
        ]);
        let cobbleKept = 0;
        let tossed = 0;
        for (const it of bot.inventory.items()) {
          if (signal.aborted) break;
          const isCobble = it.name === "cobblestone";
          if (isCobble && cobbleKept < 16) {
            cobbleKept += it.count;
            continue;
          }
          if (!isCobble && !JUNK.has(it.name)) continue;
          await bot.toss(it.type, null, it.count).catch(() => {});
          tossed += it.count;
        }
        console.log(
          `[Skill] strip_mine tossed ${tossed} junk blocks (${freeSlots} slots were free), keeping ore in-pocket`,
        );
        // Only fall back to a stash deposit if tossing junk didn't free enough
        // — e.g. a pack full of surplus ore rather than junk.
        if (36 - bot.inventory.items().length < 6) {
          const { depositStash } = await import("./stash.js");
          const keep = [
            { name: "pickaxe", minCount: 1 },
            { name: "sword", minCount: 1 },
            { name: "bucket", minCount: 1 },
            { name: "torch", minCount: 8 },
            { name: "food", minCount: 4 },
            { name: "cobblestone", minCount: 8 },
            { name: "stick", minCount: 4 },
          ];
          const banked = await raced(
            depositStash(bot, STASH_POS, keep).catch((e) => `deposit failed: ${e.message}`),
            120_000,
            "pre-mine deposit",
          );
          console.log(`[Skill] strip_mine fallback deposit: ${banked}`);
        }
      }
    }

    // Depth follows the mission AND the tools: the portal doorway is plugged
    // with obsidian only a diamond pickaxe clears, and diamonds live far
    // below the iron band this skill was tuned for. A diamond mission digs
    // to the prime band — but only with an iron-or-better pick aboard, since
    // a stone-pick bot can harvest nothing down there and should be mining
    // IRON at y=16 to tier up first. The steering text flips the depth back
    // when the mission moves on.
    // Reclaim a banked upgrade first. The tool-return reflex banks picks that
    // wandered to non-miners (Blade held the team's only iron pick through
    // runs 374-375); a stone-pick miner would otherwise grind iron at y=15
    // while a better pick sits in a chest ten steps away. A WORN iron+ pick
    // counts as missing: run 376's pick died of durability mid-run — dives
    // went from 28-block tunnels at -58 to "never reached ore depth (y=15)"
    // — and an iron pick's 250 uses barely cover one descent plus tunnel.
    const PICK_MAX_DURABILITY: Record<string, number> = {
      iron_pickaxe: 250,
      diamond_pickaxe: 1561,
      netherite_pickaxe: 2031,
    };
    const ironPlusPicks = bot.inventory.items().filter((i) => (PICK_TIER[i.name] ?? 0) >= 2);
    const freshIronPlus = ironPlusPicks.some(
      (i) => (PICK_MAX_DURABILITY[i.name] ?? 250) - (i.durabilityUsed ?? 0) >= 150,
    );
    if (!signal.aborted && !freshIronPlus) {
      const { withdrawStash } = await import("./stash.js");
      const { STASH_POS: SP } = await import("../bot/role.js");
      for (const want of ["diamond_pickaxe", "iron_pickaxe"]) {
        try {
          await raced(withdrawStash(bot, SP, want, 1), 60_000, "pick reclaim");
        } catch {
          /* none banked — craft path below still applies */
        }
        if (bot.inventory.items().some((i) => i.name === want)) break;
      }
      // Nine stone and nine wooden spares sat banked while Forge wandered
      // pickless hunting trees on deforested ground — a broken pick must
      // check the chest before the forest. Any pick beats none; the iron+
      // preference above still upgrades whenever better tools are banked.
      const holdsAnyPick = () => bot.inventory.items().some((i) => i.name.endsWith("_pickaxe"));
      if (!holdsAnyPick()) {
        for (const want of ["stone_pickaxe", "wooden_pickaxe"]) {
          try {
            await raced(withdrawStash(bot, SP, want, 1), 60_000, "pick reclaim");
          } catch {
            /* none banked */
          }
          if (holdsAnyPick()) break;
        }
      }
    }

    // Carry a SPARE iron pick down the diamond dive. An iron pick lasts ~250
    // uses; a descent to y=-58 plus a tunnel routinely outlasts one, and the
    // moment it shatters the diver is on stone at diamond depth — canHarvest
    // rejects diamond ore for a stone pick, so Forge stood inside a
    // deepslate_diamond_ore he could not mine and left it in the wall. A second
    // iron pick means equipBestPickaxe still finds iron-tier after the first
    // breaks. The iron reserve fix now keeps the ingots in his pocket to craft
    // it from.
    if (!signal.aborted) {
      await ensureSparePick(bot, raced).catch(() => {});
    }

    // Pool banked diamonds into this diver's pocket. Halves of the 3-set
    // scattered in chests (a non-miner's returned stone, another diver's
    // banked find) only become the doorway pickaxe once they sit together in
    // a crafter-miner's inventory — the craft override counts pocket only.
    if (!signal.aborted) {
      const diamondsHeld = bot.inventory
        .items()
        .filter((i) => i.name === "diamond")
        .reduce((s, i) => s + i.count, 0);
      if (diamondsHeld < 3) {
        const { withdrawStash } = await import("./stash.js");
        const { STASH_POS: SP } = await import("../bot/role.js");
        try {
          await raced(withdrawStash(bot, SP, "diamond", 3 - diamondsHeld), 60_000, "diamond pool");
        } catch {
          /* none banked yet */
        }
      }
    }

    // ARMOUR BEFORE DIAMONDS: a diamond dive to y=-58 sits BELOW the iron band
    // (iron peaks at y=16, its triangle ends near y=-24), so a deep tunnel
    // yields ~1 iron — Forge dug 29 blocks at y=-60 for a single raw_iron
    // while the whole swarm fought naked. The armour pipeline was starving not
    // for lack of a reflex but because the miners abandoned the iron band the
    // moment they held an iron pick. So an UNARMOURED miner mines iron at
    // y=15 (its abundant peak) regardless of pickaxe, and only a fully armoured
    // one with an iron pick dives for the diamonds the Nether arc still needs.
    // STAY SHALLOW. The old rule sent a fully-armoured iron-pick miner diving
    // to y=-58 for diamonds — but that band is a cave-and-lava gauntlet, and
    // now that Forge is finally armoured it was killing him there (falls into
    // caves at y=-11/-21, "tried to swim in lava"), wrecking the very mining
    // that banks the iron and copper the current goal needs. Enchanting is
    // already earned and no diamond target is live, so mine iron and copper at
    // the shallow band where it is safe and plentiful; the deep dive can return
    // deliberately when a diamond mission actually calls for it.
    const targetY = TARGET_Y;

    // Snap to nearest cardinal direction — but never TOWARD the portal
    // quarry. Bots at the stash face the portal (they commute there), and
    // the gaze-following heading sent tunnel after tunnel up the most
    // excavated corridor on the map: the travel report showed a "fresh
    // rock" tunnel ending four blocks from the portal workings. When the
    // yaw cardinal points that way, pick the cardinal whose 70-block hike
    // lands farthest from the quarry instead.
    // 110, up from 70: a full observed hour of 70-block hikes landed on
    // honeycombed ground — every descent rung out to eighteen blocks hung
    // over the same cave system and every trip ended at y=64-71 with no
    // ore. The tunnels that actually produced iron sat at x=408-417, about
    // 120-130 blocks out; land past the honeycomb instead of on it.
    const HIKE_LEN = 110;
    const QUARRY = { x: 278, z: -243 };
    let forward = getCardinalDirection(bot.entity.yaw);
    {
      const p = bot.entity.position;
      const landing = (d: { x: number; z: number }) =>
        Math.hypot(p.x + d.x * HIKE_LEN - QUARRY.x, p.z + d.z * HIKE_LEN - QUARRY.z);
      const cardinals = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
      // East/west first. The village sits in a north-south squeeze: the portal
      // quarry is ~70 south and the lake starts ~80 north, so both z headings
      // waste the trip — run 362's two full-distance hikes both went north to
      // z=-389/-391 and their tunnels died "hit water at step 0" in the lake
      // shallows. Every iron-bearing tunnel so far ran on the x axis (x=313,
      // x=350, and today's deepest at x=408-417). Prefer x-axis cardinals,
      // then the landing farthest from the quarry.
      const safe = cardinals.filter((c) => landing(c) >= 80);
      const pool = safe.length ? safe : cardinals;
      // Prefer the x-axis (the north lake and south quarry ruin z hikes), but
      // break ties RANDOMLY instead of always taking the landing farthest from
      // the quarry. That deterministic tiebreak sent every diamond dive ~110
      // blocks due east into the x=400+ aquifer, where seven descents in a row
      // this hour flooded or broke into caves ("water 3 below", "shaft would
      // flood", "standing in open water") and none reached diamond depth.
      // Sampling east AND west each run gives a dry column a chance; depth is
      // reachable (a diamond ore sits recorded at x=345, y=-49).
      forward = pool.sort((a, b) => Math.abs(b.x) - Math.abs(a.x) || Math.random() - 0.5)[0];
    }
    console.log(`[Skill] Strip mine direction: ${dirName(forward)}, starting Y=${bot.entity.position.y.toFixed(0)}`);

    // WALK OUT before digging down. The 60-block standoff lived only in
    // advisory mission text, and the inline pick craft walks every miner to
    // the stash first — so tunnels kept starting AT the village and boring
    // back through its honeycomb: two y=16 tunnels this hour found zero ore
    // of any kind. Mechanics over advice, as always: if the start is within
    // 50 of the stash, hike ~70 blocks along the tunnel heading first.
    {
      const { STASH_POS } = await import("../bot/role.js");
      const p = bot.entity.position;
      const nearStash = Math.hypot(p.x - STASH_POS.x, p.z - STASH_POS.z) < 50;
      if (softExpired()) {
        return {
          success: false,
          message: "Trip clock ran out before the hike — run strip_mine again to continue.",
        };
      }
      if (nearStash && !signal.aborted) {
        const tx = Math.floor(p.x + forward.x * HIKE_LEN);
        const tz = Math.floor(p.z + forward.z * HIKE_LEN);
        onProgress({
          skillName: "strip_mine",
          phase: "Hiking out",
          progress: 0.03,
          message: `Walking ${HIKE_LEN} blocks ${dirName(forward)} to fresh rock...`,
          active: true,
        });
        // safeGoto, so the walk survives one-shot external stops. Two attempts:
        // run 360 showed a single try still ends 2-13 blocks out when the bot
        // starts entombed (Mason: [Stuck] with cobblestone on all four sides)
        // or a night flee takes the pathfinder mid-hike. The second attempt
        // walks with canDig so a boxed-in bot mines its way out of the village
        // clutter instead of stalling against it.
        const hikeDist = () => Math.hypot(bot.entity.position.x - STASH_POS.x, bot.entity.position.z - STASH_POS.z);
        // Time-budgeted attempts, up from a fixed two: run 363 lost 27 hikes
        // to "The goal was changed" — each a ~10s flee takeover, and two
        // attempts meant two flees ended the whole trip. Keep re-walking
        // until 150s is spent or the distance is made; a flee burns one
        // attempt, the walk resumes when the bot is free again.
        const hikeDeadline = Date.now() + 150_000;
        for (let attempt = 0; Date.now() < hikeDeadline && !signal.aborted; attempt++) {
          const moves = baseMoves(bot);
          // Fall safety on the horizontal hike — Forge fell to his death four
          // times an hour walking the frontier route, off ravine lips and into
          // cave mouths, because baseMoves lets the pathfinder take fatal drops.
          // The DOWNWARD descent below is intentional and keeps its own moves;
          // here, on flat travel, cap drops and forbid parkour leaps so it
          // routes AROUND the hole instead of stepping into it.
          moves.maxDropDown = 3;
          moves.allowParkour = false;
          if (attempt > 0) {
            moves.canDig = true;
            moves.allow1by1towers = true;
          }
          bot.pathfinder.setMovements(moves);
          try {
            // 12s stall grace: run 377 lost 17 hike attempts to "Stuck" with
            // ZERO goal-change kills — the stall detector fires after 5s of
            // standing still, and computing a dig-enabled 70-block path takes
            // longer than that (thinkTimeout alone is 10s). The grace period
            // exists for exactly this; the hike never used it.
            // Waypoint hops, the quarry march's cure: a full-length
            // dig-enabled GoalXZ blows the pathfinder's compute budget and
            // the walk dies standing still — run 425 logged four hikes that
            // ended 2-7 blocks from the chest with all 150s spent. A
            // 40-block hop computes fast; the attempt loop re-aims until
            // the distance is made.
            const px = bot.entity.position.x;
            const pz = bot.entity.position.z;
            const rem = Math.hypot(tx - px, tz - pz);
            const step = Math.min(40, rem);
            const wx = Math.floor(px + ((tx - px) / (rem || 1)) * step);
            const wz = Math.floor(pz + ((tz - pz) / (rem || 1)) * step);
            await safeGoto(bot, new goals.GoalXZ(wx, wz), 45_000, 12_000);
          } catch (err) {
            console.log(`[Skill] strip_mine hike attempt ${attempt + 1} failed: ${(err as Error).message}`);
            bot.pathfinder.setGoal(null); // synchronous reset; stop() only raises a flag that kills the NEXT walk
          }
          if (hikeDist() >= 80) break;
          await new Promise((r) => setTimeout(r, 2000)); // let a flee finish before rewalking
        }
        console.log(
          `[Skill] strip_mine hiked out to ${bot.entity.position.floored()} (${hikeDist().toFixed(0)} from stash)`,
        );
        // A shaft dug here is a junk shaft: the village underground is
        // honeycombed and every descent shift finds a cave drop (run 360:
        // tunnels of 3-18 blocks at y=67-73, zero at ore depth). Failing
        // honestly beats reporting "complete" on 5 mined blocks.
        if (hikeDist() < 60) {
          // "again to continue" matches the RESUMABLE_PROTOCOL phrasing that
          // marks this a precondition failure, not a skill bug — three of
          // these honest aborts helped push strip_mine onto Forge's permanent
          // broken-skills list in run 377, poisoning the LLM's skill ranking
          // for the one skill the mission runs on.
          return {
            success: false,
            message:
              `Couldn't reach fresh rock — still only ${hikeDist().toFixed(0)} blocks from the stash ` +
              `(blocked in or under attack). No point shafting the mined-out village ground; run strip_mine again to continue.`,
          };
        }
      }
    }

    // --- Phase 1: Descend to targetY (iron/diamond depth) ---
    // The old manual staircase dug blocks but moveToPosition often failed to
    // follow it down, so the bot stayed at the surface (Y~64-90) and tunneled
    // where iron is rare — 12 runs found only coal, 0 iron. Use the pathfinder
    // with digging enabled to ACTUALLY reach depth: it handles the descent and
    // avoids lava/dangerous falls itself.
    const currentY = Math.floor(bot.entity.position.y);
    // Reach targetY from EITHER direction. The old `currentY > targetY + 5`
    // only descended, so an unarmoured miner already stranded deep (y=-59 from
    // a previous diamond dive) skipped this phase and tunnelled for iron where
    // iron is sparse — the depth fix flipped targetY to 15 but the bot never
    // climbed back up to it. GoalY with towering climbs as readily as it digs.
    const goingUp = currentY < targetY - 5;
    if (Math.abs(currentY - targetY) > 5) {
      onProgress({
        skillName: "strip_mine",
        phase: goingUp ? "Climbing up" : "Digging down",
        progress: 0.05,
        message: `${goingUp ? "Climbing up" : "Digging down"} to Y=${targetY} (iron depth)...`,
        active: true,
      });
      const digMoves = baseMoves(bot);
      digMoves.canDig = true;
      digMoves.allow1by1towers = true;
      bot.pathfinder.setMovements(digMoves);
      try {
        await Promise.race([
          bot.pathfinder.goto(new goals.GoalY(targetY)),
          new Promise<void>((_, rej) =>
            setTimeout(() => {
              bot.pathfinder.setGoal(null); // synchronous reset; stop() only raises a flag that kills the NEXT walk
              rej(new Error("descend timeout"));
            }, 60000),
          ),
        ]);
      } catch {
        // The pathfinder could not route a dig path out of this terrain. That
        // is the common case, not the rare one: 12 of 14 runs stalled within a
        // few blocks of the surface while the 2 that worked reached y=16 and
        // y=-33 comfortably. Raising the budget would only re-create the
        // watchdog stall noted below, so fall back to digging straight down,
        // which is what a player does and what safeToDigDown makes survivable.
        // Only when DESCENDING — digDownTo would drive an ascending bot deeper.
        if (!goingUp) {
          const fallback = await digDownTo(bot, targetY);
          console.log(`[Skill] strip_mine pathfinder descent failed; ${fallback}`);
        }
      }
      // Trust ALTITUDE, never the resolver: eight descents in one hour
      // "succeeded" at y=72 with a y=8 goal — goto resolved without moving
      // and the fallback never ran because nothing threw. If the bot is
      // still high after the pathfinder has had its say, dig down by hand —
      // and when ONE column refuses (the village floats over old shafts:
      // "4-block drop below", "no floor in sight"), step sideways and try
      // the next column instead of giving the whole job up, the way a
      // player would. Nine surface tunnels in one hour ended on exactly
      // these single-column refusals.
      // The far rungs are new: run 423's hikes landed over a cavern wider
      // than the six-block ladder — every shift reported "open air below —
      // a shaft, not a dig" and the trip ended at y=71. A cave system spans
      // dozens of blocks; sidestepping eighteen is still cheaper than
      // walking home empty.
      const SHIFTS = [
        [0, 0],
        [6, 0],
        [0, 6],
        [-6, 0],
        [0, -6],
        [12, 0],
        [0, 12],
        [-12, 0],
        [18, 0],
      ];
      // TIME-BOXED: five shifts of walk-plus-dig can total 400+ seconds,
      // which blew straight past the 240s skill watchdog and turned the
      // retry fix into a stall generator (4 strip_mine watchdog kills the
      // hour it shipped). Whatever depth is reached when the box closes,
      // the tunnel runs there. 280s now that the skill envelope is 480s:
      // the iron-pick dive is ~130 blocks (y≈70 to -58) and the 140s box
      // was closing mid-dive; the deeper box still leaves the envelope
      // ~200s for the tunnel and pickups.
      // Also capped against the whole-trip clock: a slow hike plus a full
      // 280s descent left zero tunnel time inside the 480s envelope. The
      // descent yields at least ~60s of tunneling wherever it got to.
      const descentDeadline = Math.min(Date.now() + 280_000, skillStart + 680_000);
      for (const [dx, dz] of SHIFTS) {
        if (Math.floor(bot.entity.position.y) <= targetY + 5 || signal.aborted) break;
        if (Date.now() > descentDeadline) {
          console.log(`[Skill] strip_mine descent time-box closed at y=${Math.floor(bot.entity.position.y)}`);
          break;
        }
        if (dx !== 0 || dz !== 0) {
          const p0 = bot.entity.position.floored();
          try {
            await Promise.race([
              bot.pathfinder.goto(new goals.GoalNear(p0.x + dx, p0.y, p0.z + dz, 2)),
              new Promise<void>((_, rej) => setTimeout(() => rej(new Error("shift timeout")), 12_000)),
            ]);
          } catch {
            bot.pathfinder.setGoal(null); // synchronous reset; stop() only raises a flag that kills the NEXT walk
          }
        }
        const fallback = await digDownTo(bot, targetY);
        console.log(`[Skill] strip_mine descent try at shift ${dx},${dz}; ${fallback}`);
      }
      // Collect anything the descent dropped (ore dug on the way down).
      await shedJunk(bot, 2);
      await collectNearbyDrops(bot, 4, 3000);
      console.log(`[Skill] strip_mine descended to Y=${bot.entity.position.y.toFixed(0)}`);
    }

    // --- Phase 2: Horizontal mining tunnel ---
    // Coordinates in the report: three "fresh rock" hours produced zero ore
    // and tunnels that dug 20 of a possible 80 blocks — mostly air. WHERE
    // the tunnel actually ran is the missing fact.
    const tunnelStart = bot.entity.position.floored();
    onProgress({
      skillName: "strip_mine",
      phase: "Mining tunnel",
      progress: 0.3,
      message: "Mining horizontal tunnel...",
      active: true,
    });

    // A flooded pocket kills every tunnel at step 0 in the SAME heading —
    // Forge's override retried into the same water every four minutes for an
    // hour at y=-59 while three dry walls stood around him. Probe the four
    // cardinals and take the first dry mouth, preferring the chosen heading.
    {
      const p0 = bot.entity.position.floored();
      const mouths = [
        forward,
        new Vec3(-forward.x, 0, -forward.z),
        new Vec3(forward.z, 0, forward.x),
        new Vec3(-forward.z, 0, -forward.x),
      ];
      const wet = (v: Vec3) => {
        const b = bot.blockAt(v);
        return !!b && (b.name === "water" || b.name === "lava");
      };
      for (const cand of mouths) {
        if (!wet(p0.offset(cand.x, 0, cand.z)) && !wet(p0.offset(cand.x, 1, cand.z))) {
          if (cand !== forward) console.log(`[Skill] strip_mine tunnel mouth rotated to ${dirName(cand)} — dry ground`);
          forward = cand;
          break;
        }
      }
    }

    for (let step = 0; step < TUNNEL_LENGTH && !signal.aborted; step++) {
      if (softExpired()) {
        console.log(`[Skill] strip_mine soft deadline at step ${step} — ending tunnel with cargo aboard`);
        break;
      }
      const pos = bot.entity.position.floored();

      // Dig 2 blocks ahead: foot level and head level
      const targets = [pos.offset(forward.x, 0, forward.z), pos.offset(forward.x, 1, forward.z)];

      for (const t of targets) {
        const b = bot.blockAt(t);
        if (!b || b.name === "air") continue;
        if (b.name === "bedrock") {
          return {
            success: true,
            message: `Hit bedrock at step ${step}! Mined ${mined} blocks. ${formatOres(oresFound)}`,
            stats: { blocksMined: mined, oresFound: oresFound.length },
          };
        }
        if (b.name === "lava" || b.name === "water") {
          // Skipping the wet cell used to leave the walk-forward step to
          // wade straight into it — Forge ended the night swimming in his
          // own flooded tunnel one block from iron ore. A breached fluid
          // ends the tunnel with whatever it earned.
          return {
            success: mined > 0,
            message: `Tunnel hit ${b.name} at step ${step} — stopped before wading in. Mined ${mined} blocks. ${formatOres(oresFound)}`,
            stats: { blocksMined: mined, oresFound: oresFound.length },
          };
        }
        if (!canHarvest(bot, b.name)) {
          console.log(`[Skill] strip_mine tunnel skipping ${b.name} — no iron-tier pickaxe to harvest it`);
          continue;
        }

        await equipBestPickaxe(bot);
        try {
          const diamondsBefore = /diamond_ore$/.test(b.name) ? countDiamonds(bot) : -1;
          await digSafe(bot, b);
          mined++;
          if (b.name.includes("ore")) {
            oresFound.push(b.name);
            await shedJunk(bot, 2);
            // Pick the drop up NOW, where it fell: the end-of-tunnel sweep
            // misses early drops, and the first tunnel-struck iron in weeks
            // evaporated exactly this way (found 2x iron_ore, cargo empty).
            await collectNearbyDrops(bot, 4, 3000);
            if (diamondsBefore >= 0) await ensureDiamondPickup(bot, diamondsBefore);
          }
        } catch {
          /* skip */
        }
      }

      // Mine any ore exposed in the surrounding walls/floor/ceiling. The old
      // tunnel only checked the 2 blocks dead ahead, so it walked straight past
      // veins in the walls — which is why nights of mining found "0 ores".
      const exposed = await mineExposedOre(bot, pos);
      mined += exposed.mined;
      oresFound.push(...exposed.ores);

      // SPELUNK when the tunnel is really a cave: half these "tunnels" mine
      // twenty of eighty blocks because the steps pass through open caverns,
      // and the one-block wall scan misses ore sitting in cave walls a few
      // blocks off the line. Caves EXPOSE ore (that is their one gift) — so
      // every few air-steps, sweep ten blocks around for visible ore and go
      // get it, budgeted so the watchdog stays happy.
      if (exposed.mined === 0 && step % 4 === 0 && oreChases < 6) {
        const visible = bot.findBlocks({
          matching: (bk) => bk.name.endsWith("_ore") && canHarvest(bot, bk.name),
          maxDistance: 10,
          count: 3,
        });
        for (const op of visible) {
          if (signal.aborted || oreChases >= 6) break;
          const blk = bot.blockAt(op);
          if (!blk || !blk.name.endsWith("_ore")) continue;
          oreChases++;
          try {
            await Promise.race([
              bot.pathfinder.goto(new goals.GoalNear(op.x, op.y, op.z, 2)),
              new Promise<void>((_, rej) => setTimeout(() => rej(new Error("chase timeout")), 12_000)),
            ]);
          } catch {
            bot.pathfinder.setGoal(null); // synchronous reset; stop() only raises a flag that kills the NEXT walk
            continue;
          }
          await equipBestPickaxe(bot);
          try {
            const diamondsBefore = /diamond_ore$/.test(blk.name) ? countDiamonds(bot) : -1;
            await digSafe(bot, blk);
            mined++;
            oresFound.push(blk.name);
            mined += (await followVein(bot, op, blk.name, oresFound)) as number;
            await shedJunk(bot, 2);
            await collectNearbyDrops(bot, 6, 4000);
            if (diamondsBefore >= 0) await ensureDiamondPickup(bot, diamondsBefore);
          } catch {
            /* next */
          }
        }
      }

      // Walk forward into cleared space
      const targetPos = pos.offset(forward.x, 0, forward.z);
      await moveToPosition(bot, targetPos);

      // Place torch every N blocks
      if (step > 0 && step % TORCH_INTERVAL === 0) {
        await placeTorchOnWall(bot, forward);
      }

      if (step % 5 === 0) {
        onProgress({
          skillName: "strip_mine",
          phase: "Mining tunnel",
          progress: 0.3 + (step / TUNNEL_LENGTH) * 0.7,
          message: `${step}/${TUNNEL_LENGTH} blocks | Mined: ${mined} | Ores: ${oresFound.length}`,
          active: true,
        });
      }
    }

    if (mined === 0) {
      return { success: false, message: "Couldn't mine anything. Pickaxe might have broken." };
    }

    // Sweep the tunnel to pick up the ore we dug — without this, strip_mine
    // reported "Found 8x iron_ore" but left the drops on the ground, so the
    // bot never actually had iron to smelt. Walk back over the tunnel.
    await shedJunk(bot, 2);
    await collectNearbyDrops(bot, 16, 8000);

    // Report the depth actually reached, not the one intended. Nine runs
    // returned "Strip mine complete!" while Forge stayed at y=68: the 60s
    // descent timeout fired, the catch swallowed it, and the skill mined a
    // tunnel at the surface and called it a success. Anything downstream that
    // needs depth -- fill_bucket looking for lava -- was then told to strip_mine
    // again, from the same place, forever.
    const endY = Math.floor(bot.entity.position.y);
    const reachedDepth = endY <= targetY + 5;
    const depthNote = reachedDepth
      ? ` Now at y=${endY}.`
      : ` NOTE: still at y=${endY}, never reached ore depth (y=${targetY}) — the descent was blocked or timed out. Try from an open area or a cave entrance.`;

    return {
      success: true,
      message: `Strip mine complete! Tunnel ${tunnelStart.x},${tunnelStart.y},${tunnelStart.z} -> ${bot.entity.position.floored().x},${endY},${bot.entity.position.floored().z}, mined ${mined} blocks.${depthNote} ${formatOres(oresFound)} Cargo: ${
        bot.inventory
          .items()
          .filter((i) => i.name.startsWith("raw_") || i.name === "coal" || i.name.endsWith("_ore"))
          .map((i) => `${i.count}x ${i.name}`)
          .join(", ") || "no ore items"
      }.`,
      stats: { blocksMined: mined, oresFound: oresFound.length },
    };
  },
};

// --- Helpers ---

const PICK_TIER: Record<string, number> = {
  wooden_pickaxe: 0,
  stone_pickaxe: 1,
  golden_pickaxe: 1,
  iron_pickaxe: 2,
  diamond_pickaxe: 3,
  netherite_pickaxe: 4,
};

/**
 * Ensure the diver carries a spare iron+ pickaxe before a deep dive. One iron
 * pick (~250 uses) rarely survives a descent to y=-58 plus a tunnel, and a
 * broken pick strands the diver on stone unable to harvest the diamond ore it
 * finds. Crafts a second iron pick from the iron the reserve now keeps in the
 * pocket (3 iron_ingot + 2 stick at a crafting table). Best-effort: any failure
 * leaves the existing single pick and the dive proceeds.
 */
async function ensureSparePick(
  bot: Bot,
  raced: <T>(p: Promise<T>, ms: number, label: string) => Promise<T | string>,
): Promise<void> {
  const PICK_MAX: Record<string, number> = { iron_pickaxe: 250, diamond_pickaxe: 1561, netherite_pickaxe: 2031 };
  const count = (n: string) =>
    bot.inventory
      .items()
      .filter((i) => i.name === n)
      .reduce((s, i) => s + i.count, 0);
  const usableIronPlus = () =>
    bot.inventory
      .items()
      .filter((i) => (PICK_TIER[i.name] ?? 0) >= 2 && (PICK_MAX[i.name] ?? 250) - (i.durabilityUsed ?? 0) >= 100)
      .length;

  // A diamond pick, or two serviceable iron+ picks, is already enough backup.
  if (bot.inventory.items().some((i) => i.name === "diamond_pickaxe")) return;
  if (usableIronPlus() >= 2) return;

  // Prefer a banked spare over spending iron on a fresh craft.
  try {
    const { withdrawStash } = await import("./stash.js");
    const { STASH_POS: SP } = await import("../bot/role.js");
    if (Math.hypot(bot.entity.position.x - SP.x, bot.entity.position.z - SP.z) < 60) {
      await raced(withdrawStash(bot, SP, "iron_pickaxe", 1), 45_000, "spare pick reclaim");
    }
  } catch {
    /* none banked */
  }
  if (usableIronPlus() >= 2) return;

  // Craft one from held iron. Needs 3 ingots + 2 sticks and a crafting table.
  if (count("iron_ingot") < 3) return;
  const mcDataLoader = (await import("minecraft-data")).default;
  const mcData = mcDataLoader(bot.version);
  if (count("stick") < 2) {
    const stickItem = mcData.itemsByName["stick"];
    const stickRecipe = stickItem && bot.recipesFor(stickItem.id, null, 1, null)[0];
    if (stickRecipe) await bot.craft(stickRecipe, 1, undefined).catch(() => {});
  }
  if (count("stick") < 2) return;
  const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
  if (!table) return;
  try {
    await raced(
      bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2)),
      15_000,
      "walk to table",
    );
  } catch {
    /* try the craft from wherever we are */
  }
  const pickItem = mcData.itemsByName["iron_pickaxe"];
  const recipe = pickItem && bot.recipesFor(pickItem.id, null, 1, table)[0];
  if (recipe) await bot.craft(recipe, 1, table).catch(() => {});
}

/** Count diamonds in the pack — the campaign's scarcest currency. */
function countDiamonds(bot: Bot): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === "diamond")
    .reduce((s, i) => s + i.count, 0);
}

/** A mined diamond ore whose drop bounces into a crevice is a dive wasted —
 *  at least three tunnels reported "Found: 1x deepslate_diamond_ore! Cargo:
 *  no ore items", losing exactly the diamonds the enchanting table needs.
 *  After digging a diamond ore, verify the diamond actually landed in the
 *  pack; if it did not, sweep again wider and longer before walking away. */
async function ensureDiamondPickup(bot: Bot, before: number): Promise<void> {
  if (countDiamonds(bot) > before) return;
  await collectNearbyDrops(bot, 8, 8000).catch(() => {});
  if (countDiamonds(bot) <= before) {
    console.log(`[Skill] strip_mine dug a diamond ore but the drop never reached the pack — swept twice, giving up`);
  }
}

async function equipBestPickaxe(bot: Bot): Promise<void> {
  // BEST means best: the old find() grabbed the first pickaxe in the pack,
  // so a bot carrying stone and iron could mine with stone.
  const picks = bot.inventory.items().filter((i) => i.name.endsWith("_pickaxe"));
  const pick = picks.sort((a, b) => (PICK_TIER[b.name] ?? 0) - (PICK_TIER[a.name] ?? 0))[0];
  if (pick) await bot.equip(pick, "hand");
}

// Ore mined below its tool tier drops NOTHING — the ore is destroyed
// forever. Diamond, gold, emerald and redstone need iron-or-better; iron,
// lapis and copper need stone-or-better (a wooden pick shatters them — six
// "Found: 1x iron_ore" tunnels banked zero raw iron before this guard
// covered them). Underleveled digs leave the vein in the wall for the
// properly equipped trip.
const IRON_TIER_ORES = /(diamond|emerald|gold|redstone)_ore$/;
const STONE_TIER_ORES = /(iron|lapis|copper)_ore$/;
function canHarvest(bot: Bot, name: string): boolean {
  const best = bot.inventory.items().reduce((m, i) => Math.max(m, PICK_TIER[i.name] ?? -1), -1);
  if (IRON_TIER_ORES.test(name)) return best >= 2;
  if (STONE_TIER_ORES.test(name)) return best >= 1;
  return true;
}

/**
 * bot.dig with a hard timeout. A bare bot.dig can hang indefinitely if the
 * block can't be reached/broken — this (plus an over-long descent timeout) made
 * strip_mine run to the 240s skill watchdog repeatedly, stalling the miner.
 * Fail fast (12s) and move on instead.
 */
async function digSafe(bot: Bot, b: import("prismarine-block").Block): Promise<void> {
  await Promise.race([
    bot.dig(b),
    new Promise<void>((_, rej) =>
      setTimeout(() => {
        try {
          bot.stopDigging();
        } catch {
          /* not digging */
        }
        rej(new Error("dig timeout"));
      }, 12000),
    ),
  ]);
}

/**
 * Mine any ore block exposed in the 3x3x3 shell around `pos` (the bot's cell),
 * then follow each vein a few blocks. This is what turns a blind tunnel into an
 * actually-productive one — ores in the walls used to be ignored entirely.
 */
async function mineExposedOre(bot: Bot, pos: Vec3): Promise<{ mined: number; ores: string[] }> {
  let mined = 0;
  const ores: string[] = [];
  const toCheck: Vec3[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0 && (dy === 0 || dy === 1)) continue; // skip the cleared path itself
        toCheck.push(pos.offset(dx, dy, dz));
      }
    }
  }
  for (const t of toCheck) {
    const b = bot.blockAt(t);
    if (!b || !b.name.endsWith("_ore")) continue;
    if (!canHarvest(bot, b.name)) {
      console.log(`[Skill] strip_mine leaving ${b.name} in the wall — no iron-tier pickaxe to harvest it`);
      continue;
    }
    const minedBefore = mined;
    const diamondsBefore = /diamond_ore$/.test(b.name) ? countDiamonds(bot) : -1;
    try {
      await equipBestPickaxe(bot);
      await digSafe(bot, b);
      mined++;
      ores.push(b.name);
      // Follow the vein a little so we don't leave most of it in the wall.
      mined += await followVein(bot, t, b.name, ores);
    } catch {
      /* out of reach or interrupted — skip */
    } finally {
      // POCKET THE DROPS, even when the vein-follow was interrupted. The
      // sweep used to sit inside the try, and run 430's diamond strike dug
      // clean and then vanished — one flee between the dig and the sweep
      // left the stone on the floor to despawn.
      if (mined > minedBefore) {
        await shedJunk(bot, 2);
        await collectNearbyDrops(bot, 5, 3000).catch(() => {});
        if (diamondsBefore >= 0) await ensureDiamondPickup(bot, diamondsBefore);
      }
    }
  }
  return { mined, ores };
}

async function followVein(bot: Bot, start: Vec3, oreName: string, ores: string[], cap = 8): Promise<number> {
  const seen = new Set<string>([start.toString()]);
  const queue: Vec3[] = [start];
  let extra = 0;
  while (queue.length && extra < cap) {
    const cur = queue.shift()!;
    for (const d of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ] as const) {
      const p = cur.offset(d[0], d[1], d[2]);
      if (seen.has(p.toString())) continue;
      seen.add(p.toString());
      const b = bot.blockAt(p);
      if (!b || b.name !== oreName) continue;
      if (bot.entity.position.distanceTo(p) > 4.3) continue; // only what we can reach without re-pathing
      try {
        await equipBestPickaxe(bot);
        await digSafe(bot, b);
        extra++;
        ores.push(b.name);
        queue.push(p);
      } catch {
        /* skip */
      }
    }
  }
  return extra;
}

async function moveToPosition(bot: Bot, targetPos: Vec3): Promise<void> {
  try {
    const moves = baseMoves(bot);
    moves.canDig = false;
    bot.pathfinder.setMovements(moves);
    // Bounded: an unreachable GoalBlock here hung strip_mine (and the whole
    // bot) for ~13h. Race against a timeout that stops the pathfinder.
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalBlock(targetPos.x, targetPos.y, targetPos.z)),
      new Promise<void>((_, rej) =>
        setTimeout(() => {
          bot.pathfinder.setGoal(null); // synchronous reset; stop() only raises a flag that kills the NEXT walk
          rej(new Error("moveToPosition timeout"));
        }, 8000),
      ),
    ]);
  } catch {
    // Fallback: manual walk
    try {
      await bot.lookAt(targetPos.offset(0.5, 1, 0.5));
      bot.setControlState("forward", true);
      await bot.waitForTicks(8);
      bot.setControlState("forward", false);
    } catch {
      /* ok */
    }
  }
}

async function placeTorchOnWall(bot: Bot, forward: Vec3): Promise<void> {
  const torch = bot.inventory.items().find((i) => i.name === "torch");
  if (!torch) return;

  // Left wall = 90 degrees from forward
  const wallDir = new Vec3(-forward.z, 0, forward.x);
  const wallBlock = bot.blockAt(bot.entity.position.floored().offset(wallDir.x, 1, wallDir.z));
  if (wallBlock && wallBlock.name !== "air" && wallBlock.name !== "water") {
    try {
      await bot.equip(torch, "hand");
      await bot.placeBlock(wallBlock, new Vec3(-wallDir.x, 0, -wallDir.z));
    } catch {
      /* ok */
    }
  }
}

function formatOres(ores: string[]): string {
  if (ores.length === 0) return "No ores this time — try a different direction!";
  const counts: Record<string, number> = {};
  for (const o of ores) counts[o] = (counts[o] || 0) + 1;
  return (
    "Found: " +
    Object.entries(counts)
      .map(([k, v]) => `${v}x ${k}`)
      .join(", ") +
    "!"
  );
}

/** Snap yaw to nearest cardinal direction vector. */
function getCardinalDirection(yaw: number): Vec3 {
  // Mineflayer: 0 = south (+Z), pi/2 = west (-X), pi = north (-Z), 3pi/2 = east (+X)
  const n = ((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (n >= Math.PI * 0.25 && n < Math.PI * 0.75) return new Vec3(-1, 0, 0); // west
  if (n >= Math.PI * 0.75 && n < Math.PI * 1.25) return new Vec3(0, 0, -1); // north
  if (n >= Math.PI * 1.25 && n < Math.PI * 1.75) return new Vec3(1, 0, 0); // east
  return new Vec3(0, 0, 1); // south
}

function dirName(dir: Vec3): string {
  if (dir.z === -1) return "north";
  if (dir.z === 1) return "south";
  if (dir.x === -1) return "west";
  return "east";
}
