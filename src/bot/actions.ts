/**
 * Built-in action dispatch for decisions produced by the LLM.
 *
 * @remarks
 * `executeAction` is the public boundary. It applies the direct-action
 * watchdog, delegates registered skills to the skill executor, and converts
 * runtime failures into short strings the brain can reason about. To add a
 * built-in action, add a case to `executeActionInner`, validate/default its
 * parameters there, expose its name through the appropriate role's
 * `allowedActions`, and cover the result in `actions.test.ts`. Multi-step work
 * that needs material gathering, progress, or cancellation belongs in a
 * `Skill` instead of this dispatcher.
 */
import type { Bot } from "mineflayer";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import { Vec3 } from "vec3";
import { isHostile } from "./perception.js";
import { travelBudgetMs } from "./mine-budget.js";
import { canHarvest, harvestAdvice } from "./tool-tier.js";
import { tooHighForFurniture, furnitureRefusal } from "./place-guard.js";
import { getGeneratedSkillNames, skillRegistry } from "../skills/registry.js";
import { runSkill } from "../skills/executor.js";
import { checkRetiredWithParole, getSkillStats } from "../skills/reliability.js";
import { runNeuralCombat } from "../neural/combat.js";
import { LOG_TYPES } from "../skills/materials.js";
import { depositStash, withdrawStash } from "../skills/stash.js";
import { RESUMABLE_PROTOCOL } from "./memory.js";
import { config } from "../config.js";

import { STASH_POS } from "./role.js";
import { baseMoves, safeMoves, explorerMoves, safeGoto, collectNearbyDrops, bumpNavGeneration } from "./navigation.js";
/** Re-exported navigation helpers used by actions and skill implementations. */
export { safeMoves, explorerMoves, safeGoto, collectNearbyDrops };

/** Hard cap for a single DIRECT action. Longer than any legit action (gather
 *  several trees, navigate far) but far short of a brain-freeze. Skills are
 *  exempt — they route through runSkill's own 240s watchdog. */
const DIRECT_ACTION_TIMEOUT_MS = 150_000;

/**
 * Executes one built-in action or registered skill and returns a message for
 * the decision loop.
 *
 * Direct actions (mine_block,
 * go_to, gather_wood, eat, …) call unbounded `bot.dig`/`goto`/`consume` that can
 * block a bot's ENTIRE brain loop forever if the server never responds — Forge
 * froze 50 min mid-`mine_block` (its `bot.dig` never returned) because, unlike
 * skills, direct actions had NO timeout backstop. Race the dispatch against a
 * hard timeout that stops movement + digging so the brain always recovers.
 * invoke_skill / registered-skill names are left to runSkill's own 240s watchdog
 * (double-bounding would preempt legit long skills like build_house).
 *
 * @param bot - The Mineflayer bot that owns the action and navigation state.
 * @param action - A built-in action name, `invoke_skill`, or registered skill name.
 * @param params - LLM-supplied action parameters; each action validates its own fields.
 * @returns A user-facing success, refusal, timeout, or failure message. Expected
 * failures are represented as strings rather than thrown into the brain loop.
 */
export async function executeAction(bot: Bot, action: string, params: Record<string, any>): Promise<string> {
  const delegatesToSkill = action === "invoke_skill" || skillRegistry.get(action) !== undefined;
  if (delegatesToSkill) {
    return executeActionInner(bot, action, params);
  }

  // Direct actions here run concurrently with skills only when they're the
  // brain's survival reflexes (flee, eat) — reactive events deliberately
  // interrupt skills. Claim pathfinder ownership up front: without this bump
  // the interrupted skill walk retried against the flee's goal in a 1s-cadence
  // tug-of-war (2,750 retry lines in one 2h run).
  bumpNavGeneration(bot);

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      // Deliberate takeover: the timed-out action's walk must not retry itself.
      bumpNavGeneration(bot);
      try {
        bot.pathfinder.stop();
      } catch {
        /* best effort */
      }
      try {
        bot.stopDigging();
      } catch {
        /* best effort */
      }
      resolve(`Action "${action}" timed out after ${DIRECT_ACTION_TIMEOUT_MS / 1000}s — aborted to free the brain.`);
    }, DIRECT_ACTION_TIMEOUT_MS);
    timer.unref?.();
  });

  try {
    return await Promise.race([executeActionInner(bot, action, params), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function executeActionInner(bot: Bot, action: string, params: Record<string, any>): Promise<string> {
  try {
    switch (action) {
      case "gather_wood":
        return await gatherWood(bot, params.count || 5);
      case "mine_block":
        return await mineBlock(
          bot,
          params.blockType || params.block || params.item || DEFAULT_MINE_TARGET,
          params.protectPos,
        );
      case "go_to":
      case "navigate":
      case "navigate_to":
      case "navigate_to_coordinates": {
        // LLM often sends [x, z] (2 elements) or [x, y, z] — handle both
        const coords = params.coordinates;
        const nx = params.x ?? (coords && coords[0]);
        // If only 2 coords given, treat as [x, z] and use bot's current Y
        const ny = params.y ?? (coords && (coords.length >= 3 ? coords[1] : bot.entity.position.y));
        const nz = params.z ?? (coords && (coords.length >= 3 ? coords[2] : coords[1]));
        return await goTo(bot, nx, ny, nz);
      }
      case "explore": {
        const dirs = ["north", "south", "east", "west"] as const;
        const randomDir = dirs[Math.floor(Math.random() * dirs.length)];
        return await explore(bot, params.direction || randomDir);
      }
      case "craft":
        return await craftItem(bot, params.item, params.count || 1);
      case "eat":
        return await eat(bot);
      case "attack":
        return await attackNearest(bot);
      case "flee":
      case "flee_to_safety":
      case "prioritize_survival":
      case "navigate_to_safe_location":
        return await flee(bot);
      case "build_shelter":
        return await buildShelter(bot);
      case "place_block":
        return await placeBlock(bot, params.blockType || params.block || params.item);
      case "sleep":
      case "sleep_in_bed": // common LLM aliases for sleep
      case "use_bed":
      case "use_item":
      case "place_bed":
      case "build_bed":
      case "equip_bed":
      case "equipWhiteBed":
      case "equipBed":
        return await sleepInBed(bot);
      case "idle":
        return "Just vibing.";
      case "chat": {
        const msg = typeof params.message === "string" ? params.message.trim() : "";
        if (!msg) return "chat needs a 'message' param — nothing was said.";
        // The bots are server ops for spawn-safety plumbing, which made the
        // chat action a command console: the model typed "/give @p obsidian
        // 1", the server obeyed, and a story advancement got conjured out of
        // thin air (revoked, item cleared). Model-authored chat is TALK ONLY.
        if (msg.startsWith("/")) return "Commands are not allowed in chat — say it in words instead.";
        bot.chat(msg);
        return `Said: ${msg}`;
      }
      case "respond_to_chat": {
        const msg = typeof params.message === "string" ? params.message.trim() : "";
        if (!msg) return "respond_to_chat needs a 'message' param — nothing was said.";
        if (msg.startsWith("/")) return "Commands are not allowed in chat — say it in words instead.";
        bot.chat(msg);
        return `Replied: ${msg}`;
      }
      case "generate_skill": {
        if (!params.task || !String(params.task).trim()) return "generate_skill needs a non-empty 'task' param.";
        if (!config.generatedSkills.enabled) {
          return "Generated skills are disabled. An operator must explicitly enable the isolated candidate workflow.";
        }
        const { generateSkill } = await import("../skills/generator.js");
        const candidate = await generateSkill(params.task as string);
        return `Quarantined candidate '${candidate.name}' (${candidate.id}, SHA-256 ${candidate.sha256}). It cannot run until an operator verifies and promotes this exact hash.`;
      }
      case "invoke_skill": {
        const name = params.skill as string;
        if (!name) return "invoke_skill needs a 'skill' param.";
        if (checkRetiredWithParole(name)) {
          const st = getSkillStats(name);
          return `Skill '${name}' is RETIRED (${st?.successes}/${st?.attempts} success rate — it doesn't work). Use generate_skill to create a better version, or do it with basic actions.`;
        }
        const skill = skillRegistry.get(name);
        if (!skill) {
          // Fallback: if the skill name is actually a built-in action, execute it directly
          const BUILTIN_ACTIONS = new Set([
            "gather_wood",
            "mine_block",
            "go_to",
            "explore",
            "craft",
            "eat",
            "attack",
            "flee",
            "build_shelter",
            "place_block",
            "sleep",
            "idle",
            "chat",
          ]);
          if (BUILTIN_ACTIONS.has(name)) {
            return await executeAction(bot, name, params);
          }
          return `Skill '${name}' not found. Try generate_skill to create it.`;
        }
        let skillResult = await runSkill(bot, skill, params);
        // AUTO-CONTINUE. Skills that bank progress return "…again to continue"
        // and depend on the model re-invoking promptly. It doesn't: Forge
        // closed 75→50 blocks toward the lava, then wandered onto a mountain
        // for an hour. When a skill explicitly asks for its own continuation,
        // granting it is the bot following its own plan — the same class as
        // the deterministic overrides in brain.ts, not a decision taken away
        // from the model. Bounded, and only while the skill keeps asking.
        // 8 for the portal (up from 3 for everything else): the 142-block
        // quarry trek covers huge ground per invocation (run 405: 146→31 in
        // one march) but three continuations end one short of arrival, the
        // bot yo-yos home on village chores, and the next attempt restarts
        // from scratch. Each continuation only fires while the skill itself
        // keeps asking, so the bound stays honest.
        const contLimit = name === "build_nether_portal" ? 8 : 3;
        for (let cont = 0; cont < contLimit && RESUMABLE_PROTOCOL.test(skillResult); cont++) {
          console.log(`[Skill] auto-continue ${cont + 1}/${contLimit} for "${name}"`);
          skillResult = await runSkill(bot, skill, params);
        }
        // Voyager-style refinement: a dynamic skill that failed with a CODE
        // error (not a precondition) gets its source + error fed back to the
        // LLM for a fix. Fire-and-forget — the bot keeps playing meanwhile.
        const looksLikeCodeBug =
          /is not a function|Cannot read|ReferenceError|TypeError|is not defined|timed out after/i.test(skillResult);
        const looksLikePrecondition = /need|missing|not enough|no trees|no water|gather|explore first/i.test(
          skillResult,
        );
        if (looksLikeCodeBug && !looksLikePrecondition && getGeneratedSkillNames().includes(name)) {
          import("../skills/generator.js")
            .then(({ refineSkill }) => refineSkill(name, skillResult))
            .catch((e) => console.warn(`[Refine] ${name}:`, e.message));
        }
        return skillResult;
      }
      case "neural_combat":
      case "neural_navigation": {
        const duration = (params.duration as number) || 5;
        return await runNeuralCombat(bot, duration);
      }
      case "give_item": {
        return await giveItem(bot, params.to, params.item, params.count || 1);
      }
      case "deposit_stash": {
        const stashPos = params.stashPos;
        const keepItems = params.keepItems;
        if (!stashPos) return "No stash position configured.";
        return await depositStash(bot, stashPos, keepItems ?? [], params.materialReserve, params.canMine);
      }
      case "withdraw_stash": {
        const stashPos = params.stashPos;
        if (!stashPos) return "No stash position configured.";
        const item = params.item as string;
        const count = (params.count as number) || 1;
        if (!item) return "withdraw_stash needs an 'item' param.";
        return await withdrawStash(bot, stashPos, item, count);
      }
      default: {
        // Check if this is a registered skill
        const skill = skillRegistry.get(action);
        if (skill) {
          return await runSkill(bot, skill, params);
        }
        return `Unknown action: ${action}`;
      }
    }
  } catch (err: any) {
    return `Action failed: ${err.message || err}`;
  }
}

/** How far from base a bot may roam before gather_wood pulls it home first.
 *  Past this, the pathfinder is operating in unscouted terrain where 60+ hours
 *  of evidence shows it can't reach trunks even from 3 blocks away. */
const WOOD_LEASH_RADIUS = 200;

async function gatherWood(bot: Bot, count: number): Promise<string> {
  // Use shared LOG_TYPES so pale_oak_log (MC 1.21.4) and future wood types are included
  const logTypes = LOG_TYPES as readonly string[];

  // LEASH: wood is gathered near base, period. The explore loop walked bots
  // ~780 blocks out (Z=-1098 vs base Z=-314) into steep leafy mountains where
  // EVERY approach failed — 1,000+ "Couldn't reach any trees" per log window,
  // zero logs banked for 2+ days, while replanted saplings regrow at home.
  // If the bot has wandered past the leash, spreadplayers it back to base
  // (safe topmost-block landing, same mechanism brain.ts uses for water
  // escape) and search from there instead of burning the travel budget in
  // badlands. Gated on allowInterventions like every other teleport.
  const leashDist = Math.hypot(bot.entity.position.x - STASH_POS.x, bot.entity.position.z - STASH_POS.z);
  if (leashDist > WOOD_LEASH_RADIUS && config.bot.allowInterventions) {
    console.log(
      `[GatherDebug] leash: ${bot.username} is ${leashDist.toFixed(0)} blocks from base — TPing home to gather`,
    );
    bot.chat(`/spreadplayers ${STASH_POS.x} ${STASH_POS.z} 0 24 false ${bot.username}`);
    await new Promise((r) => setTimeout(r, 4000));
  }

  // Collect all nearby logs — use 256 block radius to find trees even after local depletion
  // count 64, not 20: floating trunk remnants (skipped below) accumulate as
  // the team chops, and with only 20 candidates the finder's list fills with
  // floaters, crowding out the real regrown trees behind them (overnight
  // evidence: 1,132 approach fails with grown trees standing at the grove).
  const allLogs = bot.findBlocks({
    matching: (block) => logTypes.includes(block.name),
    maxDistance: 256,
    count: 64,
  });

  // Don't advise exploring for wood: that advice is what walked the team 780
  // blocks into the badlands. Saplings replanted at base regrow on their own.
  if (allLogs.length === 0) {
    // PLANT before waiting: the deforested village hit 19 "no trees" answers
    // in one run while Blade carried three saplings the whole time. A bot
    // holding saplings puts them in the ground on nearby grass — the wait
    // becomes the thing that creates the trees being waited for.
    const sapling = bot.inventory.items().find((i) => i.name.endsWith("_sapling"));
    if (sapling) {
      let planted = 0;
      const spots = bot.findBlocks({
        matching: (b) => b.name === "grass_block",
        maxDistance: 12,
        count: 16,
      });
      for (const spot of spots) {
        if (planted >= 3 || !bot.inventory.items().some((i) => i.name.endsWith("_sapling"))) break;
        const above = bot.blockAt(spot.offset(0, 1, 0));
        if (!above || above.name !== "air") continue;
        // OPEN SKY required: seven saplings sat growthless for hours under
        // the deforestation's leftover floating canopies — filtered light
        // stalls growth. Ten clear blocks overhead approximates sky access.
        let sky = true;
        for (let dy = 2; dy <= 10; dy++) {
          const b = bot.blockAt(spot.offset(0, dy, 0));
          if (b && b.name !== "air") {
            sky = false;
            break;
          }
        }
        if (!sky) continue;
        try {
          const ground = bot.blockAt(spot);
          if (!ground) continue;
          await bot.pathfinder.goto(new goals.GoalNear(spot.x, spot.y + 1, spot.z, 2));
          const s = bot.inventory.items().find((i) => i.name.endsWith("_sapling"));
          if (!s) break;
          await bot.equip(s, "hand");
          await bot.placeBlock(ground, new Vec3(0, 1, 0));
          planted++;
        } catch {
          /* next spot */
        }
      }
      if (planted > 0)
        return `No trees within 256 blocks — planted ${planted} sapling(s) nearby instead. They grow in minutes; gather_wood again later.`;
    }
    return "No trees found within 256 blocks. Wait for replanted saplings near base to grow — do NOT wander off searching; do other useful work and try again later.";
  }

  // Nearest-first: findBlocks returns scan order, and burning the 4-try
  // budget on 120+ block hikes (which time out over broken terrain) starves
  // the close, reachable trees (evidence: failures at dist 124-163 while
  // dist<20 candidates existed).
  allLogs.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));

  // If underground, surface first — explorerMoves can't dig through solid blocks
  if (bot.entity.position.y < 63) {
    const digMoves = baseMoves(bot);
    digMoves.canDig = true;
    digMoves.allowFreeMotion = true;
    digMoves.allow1by1towers = true;
    bot.pathfinder.setMovements(digMoves);
    try {
      await safeGoto(bot, new goals.GoalY(70), 20000);
    } catch {
      /* best effort — continue anyway */
    }
    bot.pathfinder.setMovements(explorerMoves(bot));
  }

  const countLogsInInventory = () =>
    bot.inventory
      .items()
      .filter((i) => (logTypes as readonly string[]).includes(i.name))
      .reduce((s, i) => s + i.count, 0);
  const logsBefore = countLogsInInventory();

  let gathered = 0;
  let tried = 0;
  // Why candidates were rejected. The catch below logs approach failures, but it
  // fired twice against ~30 failed gathers with up to 4 tries each, so most
  // candidates never reach an approach at all: they are dropped by the filters
  // below and the action still reports "pathfinding failed". That message sent
  // previous fixes after the pathfinder while the real gate was the filters.
  const skip = { notLog: 0, floating: 0, belowNull: 0, approach: 0, budget: 0, samples: [] as string[] };
  // Trunk bases hovering over air. Skipped by the main pass in favour of real
  // trees, but kept as salvage: they are still wood, and chopping them is what
  // removes them from future candidate lists.
  const floaters: Vec3[] = [];
  const chopSpots: Vec3[] = []; // ground positions to replant saplings on
  // Aggregate travel budget: the old design allowed 4 tries x 90s per-tree goto
  // = 360s of pathing, which now trips the 150s action watchdog and hard-kills
  // the action mid-dig (Atlas/Forge hit it 4x in 10 min chasing far trees).
  // Cap the loop at 110s so it returns gracefully (restoring movements +
  // thinkTimeout via the finally) well before the watchdog fires. 110s + one
  // 30s goto = 140s < 150s.
  const gatherStart = Date.now();
  for (const pos of allLogs) {
    if (gathered >= count) break;
    if (Date.now() - gatherStart > 110000) {
      skip.budget++;
      break;
    }
    let log = bot.blockAt(pos);
    if (!log || !(logTypes as readonly string[]).includes(log.name)) {
      skip.notLog++;
      continue;
    }

    // Target the BASE of the trunk, not whatever log findBlocks returned.
    // Big oaks return canopy BRANCH logs 8-10 blocks up — GoalNear(3) can
    // never be satisfied from the ground for those (instrumentation showed
    // repeated failures with the tree DIRECTLY OVERHEAD at dist 8-10), and
    // chopping a canopy log rains its drops into the leaves. Walk the log
    // column down to ground level and approach that instead.
    let below = bot.blockAt(log.position.offset(0, -1, 0));
    while (below && (logTypes as readonly string[]).includes(below.name)) {
      log = below;
      below = bot.blockAt(log.position.offset(0, -1, 0));
    }
    const basePos = log.position;
    // Skip FLOATING tree remnants: weeks of old one-log chopping left
    // trunk-tops hovering over air everywhere, and they bait the finder into
    // unreachable targets (evidence: base at y=82 with the bot directly
    // below at y=74). A real trunk base sits on a solid block.
    if (!below || below.name === "air" || below.name === "water") {
      // Split null from genuinely-floating: bot.blockAt returns null for an
      // unloaded chunk, which is a chunk-loading problem, while air/water under
      // a trunk base is a real remnant left by weeks of one-log chopping. Both
      // land here, and they need opposite fixes. 64 of 64 candidates were
      // rejected by this branch in one sample with zero approaches attempted.
      if (!below) skip.belowNull++;
      else {
        skip.floating++;
        if (floaters.length < 8) floaters.push(basePos);
      }
      if (skip.samples.length < 3) {
        skip.samples.push(`(${basePos.x},${basePos.y},${basePos.z})below=${below?.name ?? "NULL"}`);
      }
      continue;
    }

    tried++;
    try {
      // explorerMoves allows swimming — essential when trees are across water
      bot.pathfinder.setMovements(explorerMoves(bot));
      // Increase think timeout for long-distance pathing around lakes (default 10s is too short)
      // Also delay stall detection by 32s to match — stall fires only AFTER bot starts moving
      const prevThinkTimeout = bot.pathfinder.thinkTimeout;
      // 12s, not 30s. thinkTimeout is how long a doomed A* search has to fill
      // its bounded volume with nodes, and this was the largest such window in
      // the codebase. Combined with searchRadius=64 it bounds both the extent
      // and the duration of the worst case.
      bot.pathfinder.thinkTimeout = 12000;
      // Y-floor guard: if pathfinder dives below Y=60 (lake bed) stop navigation to prevent drowning
      const Y_FLOOR = 60;
      const yGuard = setInterval(() => {
        if (bot.entity.position.y < Y_FLOOR) {
          bot.pathfinder.stop();
        }
      }, 400);
      try {
        // The clean (no-dig) approach may THROW on a bush-locked tree, not just
        // resolve-without-arriving — and a throw used to skip the dig retry
        // entirely, which is why regrown clumpy forests still starved us after
        // the retry was added. Swallow the first failure; the dig retry below
        // is the real fallback either way.
        try {
          await safeGoto(bot, new goals.GoalNear(basePos.x, basePos.y, basePos.z, 3), 30000, 12000);
        } catch {
          /* fall through to the dig-enabled retry */
        }
        // Young regrown trees sit inside ground-level leaf bushes that the
        // no-dig movement can't push through — at the regrown forest EVERY
        // approach failed ("Couldn't reach any trees... pathfinding failed").
        // If we're still not adjacent, retry once with digging allowed: the
        // bot chews through the bush exactly like a player would.
        if (bot.entity.position.distanceTo(new Vec3(basePos.x, basePos.y, basePos.z)) > 4.5) {
          const bushMoves = baseMoves(bot);
          bushMoves.canDig = true;
          bushMoves.allow1by1towers = false;
          bushMoves.maxDropDown = 3;
          bushMoves.allowParkour = false;
          bot.pathfinder.setMovements(bushMoves);
          await safeGoto(bot, new goals.GoalNear(basePos.x, basePos.y, basePos.z, 2), 20000, 8000);
        }
        await digSafe(bot, log);
        gathered++;
        // Fell the WHOLE trunk, not just one block: logs above float (classic
        // Minecraft) and their drops rain down the cleared column to walkable
        // ground. Chopping a single log left drops lodged in the canopy — 78%
        // of chopped logs were lost as unreachable (1138 lost vs 326 gathered).
        let above = bot.blockAt(basePos.offset(0, 1, 0));
        let felled = 0;
        // Cap 12, not 6: a 6-cap left the tops of tall oaks floating, and those
        // remnants are exactly what poisons the finder (see count comment above).
        while (above && (logTypes as readonly string[]).includes(above.name) && felled < 12) {
          try {
            await digSafe(bot, above);
            felled++;
          } catch {
            break; // out of dig reach — the rest of the trunk stays
          }
          above = bot.blockAt(above.position.offset(0, 1, 0));
        }
        gathered += felled;
        chopSpots.push(basePos.clone()); // remember the trunk spot to replant on
        // Walk over the drops — digging alone leaves the items on the ground
        await new Promise((r) => setTimeout(r, 600));
        await collectNearbyDrops(bot, 8, 9000);
      } finally {
        clearInterval(yGuard);
        bot.pathfinder.thinkTimeout = prevThinkTimeout;
      }
    } catch {
      // This log was unreachable — skip it and try the next one.
      // INSTRUMENTATION (wood-economy debugging): record exactly where the
      // approach fails so the fix targets evidence, not guesses — 80% of
      // gathers still die here even after the leaf-dig retry.
      skip.approach++;
      const bp = bot.entity.position;
      console.log(
        `[GatherDebug] approach failed: bot(${bp.x.toFixed(0)},${bp.y.toFixed(0)},${bp.z.toFixed(0)}) -> base(${basePos.x},${basePos.y},${basePos.z}) dist=${bp.distanceTo(basePos).toFixed(0)}`,
      );
    }
    if (tried >= 4 && gathered === 0) break; // give up after 4 failed attempts (~120s max)
  }

  // SALVAGE PASS: floating remnants are still wood.
  //
  // The main pass skips trunk bases hovering over air because they used to bait
  // the finder toward unreachable targets. That reasoning inverted as the world
  // changed: weeks of one-log chopping left floaters everywhere, and they are
  // now the ONLY wood near base. Instrumentation showed candidates=64 with
  // floating=64, belowNull=0 and zero approaches attempted, while the action
  // reported "pathfinding failed" and the team starved for logs with wood
  // hanging six blocks overhead.
  //
  // Raising the candidate cap was the previous answer (20 -> 64) and it bought
  // weeks before all 64 were floaters too. Chopping them is self-correcting:
  // every floater harvested is permanently one fewer bad candidate.
  //
  // Real trees still win — this only runs when the main pass came back empty.
  if (gathered === 0 && floaters.length > 0) {
    // Height cap. Salvage pillars up to reach a hovering trunk, and falls became
    // the top death cause concentrated in one bot: Forge took ~10 of the swarm's
    // 12 falls while invoking gather_wood. Correlating timestamps put falls
    // within 60s of a salvage at 1.9x their base rate, and the tall pillar is
    // the plausible mechanism.
    //
    // A floater 3 blocks up is worth a short climb; one 10 blocks up is not
    // worth a tower to fall off. Digging still reaches anything at or below
    // head height, so most salvage value survives the cap.
    // 8, not 4. A cap of 4 skipped 190 floaters against 15 salvaged — 93% of
    // opportunities — so bots ate the low remnants and then starved, with empty
    // gathers (81) overtaking successes (58) and deposits halving. Fall damage
    // is 0.5 hearts per block above 3, so an 8-block drop costs ~2.5 of 10
    // hearts. Height alone was never the hazard: coming off the pillar is, and
    // that is handled by the deliberate descent below.
    const MAX_CLIMB = 8;
    const reachable = floaters.filter((f) => f.y - bot.entity.position.y <= MAX_CLIMB);
    const skippedHigh = floaters.length - reachable.length;
    if (skippedHigh > 0) {
      console.log(`[GatherDebug] skipped ${skippedHigh} floaters above +${MAX_CLIMB} (fall risk)`);
    }

    for (const fpos of reachable.slice(0, 3)) {
      if (Date.now() - gatherStart > 100000) break;
      // Ground level before any towering, so the descent below knows where home is.
      const groundY = bot.entity.position.y;
      try {
        // Towers allowed so the bot can build up to a hovering trunk. baseMoves
        // keeps maxDropDown=3 and parkour off, so climbing stays fall-safe.
        const towerMoves = baseMoves(bot);
        towerMoves.canDig = true;
        towerMoves.allow1by1towers = true;
        bot.pathfinder.setMovements(towerMoves);
        await safeGoto(bot, new goals.GoalNear(fpos.x, fpos.y, fpos.z, 2), 20000, 8000);

        let floater = bot.blockAt(fpos);
        let felled = 0;
        while (floater && (logTypes as readonly string[]).includes(floater.name) && felled < 12) {
          await digSafe(bot, floater);
          gathered++;
          felled++;
          floater = bot.blockAt(fpos.offset(0, felled, 0));
        }
        if (felled > 0) {
          console.log(`[GatherDebug] salvaged ${felled} floating logs at (${fpos.x},${fpos.y},${fpos.z})`);

          // Come down deliberately. Towering leaves the bot standing on a 1x1
          // pillar it just built, and stepping off that is the plausible source
          // of the fall deaths this pass was blamed for. safeMoves caps drops at
          // 3 and forbids parkour, so this routes down instead of falling off.
          if (bot.entity.position.y > groundY + 2) {
            bot.pathfinder.setMovements(safeMoves(bot));
            await safeGoto(bot, new goals.GoalY(Math.floor(groundY)), 10000).catch(() => {});
          }

          await collectNearbyDrops(bot, 6);
        }
      } catch {
        continue;
      } finally {
        bot.pathfinder.setMovements(explorerMoves(bot));
      }
    }
  }

  // Sustainability: replant saplings so the forest regrows. Trees never come
  // back on their own in Minecraft — without this the team permanently
  // deforests the area and wood trips range ever farther. Saplings drop from
  // the leaf decay of the trees just chopped (collected above).
  const replanted = await replantSaplings(bot, chopSpots);

  // Name the gate whenever a gather comes back empty. "pathfinding failed" is
  // only true when skip.approach dominates; a high notLog or floating count
  // means the candidate list was exhausted by filters before any approach was
  // attempted, which is a completely different bug with a different fix.
  if (gathered === 0) {
    console.log(
      `[GatherDebug] empty gather: candidates=${allLogs.length} tried=${tried} ` +
        `notLog=${skip.notLog} floating=${skip.floating} belowNull=${skip.belowNull} ` +
        `approachFailed=${skip.approach} budgetHit=${skip.budget} ` +
        `botY=${bot.entity.position.y.toFixed(0)} samples=[${skip.samples.join(" ")}]`,
    );
  }

  const collected = countLogsInInventory() - logsBefore;
  const replantNote = replanted > 0 ? ` Replanted ${replanted} sapling${replanted > 1 ? "s" : ""}.` : "";
  if (collected > 0) return `Gathered ${collected} logs. Inventory now has wood!${replantNote}`;
  if (gathered > 0)
    return `Chopped ${gathered} logs but couldn't pick up the drops — they may be stuck in leaves or a hole.${replantNote}`;
  // BOOTSTRAP path: with zero chops there are no chopSpots, so the replant
  // above planted nothing — and if planting only happens after success, a
  // treeless area DEADLOCKS (saplings in pockets, none in the ground, no
  // trees ever again). A failed gather is exactly when planting matters
  // most: seed the recovery now so there's something to chop next time.
  // SEED CAPITAL: saplings come from leaf decay of chopped trees, so a bot
  // with no saplings AND no reachable trees is doubly stuck (182 fails/hour
  // with zero plantings — the seeds have to come from somewhere). The team
  // stash banks saplings from richer times; withdraw a handful first.
  if (!bot.inventory.items().some((i) => i.name.endsWith("_sapling"))) {
    try {
      await withdrawStash(bot, STASH_POS, "sapling", 8);
    } catch {
      /* stash empty or unreachable — scatterSaplings will no-op below */
    }
  }
  const seeded = await scatterSaplings(bot, 4);
  if (seeded > 0)
    return `Couldn't reach any trees, so planted ${seeded} sapling${seeded > 1 ? "s" : ""} on open ground instead — they'll grow. Do other work and gather later.`;
  return "Couldn't reach any trees this attempt (pathfinding failed). Stay near base and try again — do NOT explore far for wood.";
}

/**
 * Replant saplings on the chopped-tree spots (or nearby grass/dirt) so the
 * forest regrows. Plants up to as many saplings as the bot is carrying.
 * Returns the number planted.
 */
async function replantSaplings(bot: Bot, chopSpots: Vec3[]): Promise<number> {
  const saplings = bot.inventory.items().filter((i) => i.name.endsWith("_sapling"));
  if (saplings.length === 0 || chopSpots.length === 0) return 0;
  let sapling = saplings[0];
  let planted = 0;

  for (const spot of chopSpots) {
    if (sapling.count <= 0) {
      const next = bot.inventory.items().find((i) => i.name.endsWith("_sapling"));
      if (!next) break;
      sapling = next;
    }
    // The trunk base sat on grass/dirt; plant on that ground block (one below
    // the lowest log) by placing against it with the sapling occupying the
    // log's old space.
    const ground = bot.blockAt(spot.offset(0, -1, 0));
    const target = bot.blockAt(spot);
    if (!ground || !target) continue;
    if (!["grass_block", "dirt", "podzol", "rooted_dirt"].includes(ground.name)) continue;
    if (target.name !== "air") continue;
    try {
      if (bot.entity.position.distanceTo(spot) > 4) {
        await safeGoto(bot, new goals.GoalNear(spot.x, spot.y, spot.z, 3), 8000);
      }
      await bot.equip(sapling, "hand");
      await bot.placeBlock(ground, new Vec3(0, 1, 0));
      planted++;
      sapling = { ...sapling, count: sapling.count - 1 } as typeof sapling;
    } catch {
      // couldn't place here — try the next spot
    }
  }

  // FORESTRY, not just replacement: chop spots sit inside the old clumps, so
  // replanting only there regrows the same bush-locked thickets the
  // pathfinder can't enter — the forest "regrew" three times and starved the
  // team anyway. Scatter a few extra saplings on OPEN grass with clearance so
  // the next generation grows spaced and reachable.
  planted += await scatterSaplings(bot, 4);
  return planted;
}

/**
 * Plant up to `max` saplings on open grass near the bot: sky above, no logs or
 * leaves within 2 blocks, and ≥4 blocks from any other sapling so grown trees
 * don't fuse into an unreachable thicket. This is the bots' own forestry —
 * the forest must sustain itself without outside gardening.
 */
async function scatterSaplings(bot: Bot, max: number): Promise<number> {
  let sapling = bot.inventory.items().find((i) => i.name.endsWith("_sapling"));
  if (!sapling) return 0;

  const isClearAround = (pos: Vec3): boolean => {
    // Logs need 2 blocks of clearance (trunk adjacency = fused thicket), but
    // leaves/saplings only 1: requiring a 5-block-wide woody-free zone found
    // ZERO valid spots near the lived-in base (existing plantings, floaters,
    // and canopy edges disqualified everything — 272 fails, 0 seeds).
    for (let dx = -2; dx <= 2; dx++)
      for (let dy = 0; dy <= 2; dy++)
        for (let dz = -2; dz <= 2; dz++) {
          const b = bot.blockAt(pos.offset(dx, dy, dz));
          if (!b) continue;
          if (b.name.endsWith("_log")) return false;
          if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && (b.name.endsWith("_leaves") || b.name.endsWith("_sapling")))
            return false;
        }
    return true;
  };

  const grounds = bot.findBlocks({
    matching: (b) => b.name === "grass_block" || b.name === "dirt",
    maxDistance: 32,
    count: 60,
  });
  let planted = 0;
  const plantedAt: Vec3[] = [];
  for (const g of grounds) {
    if (planted >= max) break;
    const above = bot.blockAt(g.offset(0, 1, 0));
    if (!above || above.name !== "air") continue;
    if (!isClearAround(g.offset(0, 1, 0))) continue;
    if (plantedAt.some((p) => p.distanceTo(g) < 4)) continue;
    try {
      if (bot.entity.position.distanceTo(g) > 4) {
        await safeGoto(bot, new goals.GoalNear(g.x, g.y, g.z, 3), 8000);
      }
      const ground = bot.blockAt(g);
      if (!ground) continue;
      sapling = bot.inventory.items().find((i) => i.name.endsWith("_sapling"));
      if (!sapling) break;
      await bot.equip(sapling, "hand");
      await bot.placeBlock(ground, new Vec3(0, 1, 0));
      planted++;
      plantedAt.push(g.clone());
    } catch {
      // spot didn't work out — try the next one
    }
  }
  // INSTRUMENTATION (forestry debugging): when nothing gets planted, say why
  // it looks that way so the next fix targets evidence, not guesses.
  if (planted === 0) {
    const sapCount = bot.inventory
      .items()
      .filter((i) => i.name.endsWith("_sapling"))
      .reduce((s, i) => s + i.count, 0);
    console.log(`[ForestryDebug] scatter planted 0: ${grounds.length} ground candidates, ${sapCount} saplings held`);
  }
  return planted;
}

/**
 * Normalize what the LLM asked to mine into a block-name matcher.
 * Accepts exact names ("iron_ore"), bare metals ("iron" → "iron_ore"), and
 * the generic "ore"/"ores" (any *_ore block). Ore is the whole point of
 * mining, so when an ore is requested we prefer it over plain stone.
 */
/** What to mine when the caller names no block.
 *
 *  This was "stone", and it quietly answered a question nobody asked. The critic
 *  returns nextParams:{} for most follow-ups, so 39 of 116 mine_block calls in
 *  one session arrived with no blockType and mined stone while the bot's own
 *  thought said "Time to dig for iron!". Meanwhile the strategic path asked for
 *  iron_ore 44 times out of 52 explicit requests, and exactly one call asked for
 *  stone.
 *
 *  The swarm was starving for iron the whole time: bots held 0-2 ingots against
 *  a 4-ingot boot, "No iron_ingot in the stash" appeared 56 times, and 15 of 21
 *  deaths were unarmoured. A third of all mining was being spent on cobblestone
 *  nobody had asked for.
 *
 *  "ore" matches any *_ore through the branch below, so an unspecified dig now
 *  follows the intent the logs actually show. A bot that wants stone still says
 *  so, and one did. */
/** Fallback matcher requested when the LLM asks to mine without naming a block. */
export const DEFAULT_MINE_TARGET = "ore";

/**
 * Builds the name predicate used by mining actions.
 *
 * @param blockType - A concrete Minecraft block name or the `ore` category.
 * @returns A predicate plus whether the request should use ore-specific logic.
 */
export function blockMatcher(blockType: string): { match: (name: string) => boolean; isOre: boolean } {
  const bt = blockType.toLowerCase();
  if (bt === "ore" || bt === "ores") {
    return { match: (n) => n.endsWith("_ore"), isOre: true };
  }
  // "iron" / "iron_ore" / "diamond" etc. → match the ore form too
  const oreForm = bt.endsWith("_ore") ? bt : `${bt}_ore`;
  const isOre = oreForm.endsWith("_ore") && bt !== "stone" && bt !== "cobblestone" && bt !== "deepslate";
  return { match: (n) => n === bt || n === oreForm || (isOre && n === `deepslate_${oreForm}`), isOre };
}

/** bot.dig with a hard timeout — an unbounded dig (odd block state, a face the
 *  bot can't quite reach, a server hiccup) otherwise blocks the brain until the
 *  150s action watchdog fires. mine_block was the top residual watchdog trip
 *  (8 in 11h) from exactly this; stopDigging + reject lets it fail fast. */
async function digSafe(bot: Bot, block: import("prismarine-block").Block): Promise<void> {
  await Promise.race([
    bot.dig(block),
    new Promise<void>((_, rej) =>
      setTimeout(() => {
        try {
          bot.stopDigging();
        } catch {
          /* wasn't digging */
        }
        rej(new Error("dig timeout"));
      }, 12000),
    ),
  ]);
}

async function mineBlock(
  bot: Bot,
  blockType: string,
  protectPos?: { x: number; y: number; z: number },
): Promise<string> {
  // Keep the village/stash site intact — bots kept strip-mining the base and
  // other bots fell into the pits and got stuck.
  const PROTECT_RADIUS = 12;
  const { match, isOre } = blockMatcher(blockType);
  const protectedAt = (pos: Vec3) => {
    if (!protectPos) return false;
    const dx = pos.x - protectPos.x;
    const dz = pos.z - protectPos.z;
    return dx * dx + dz * dz <= PROTECT_RADIUS * PROTECT_RADIUS;
  };

  // Ore can be tens of blocks below the surface, so search wider for it.
  const block = bot.findBlock({
    matching: (b) => match(b.name),
    maxDistance: isOre ? 64 : 32,
    useExtraInfo: (b) => !protectedAt(b.position),
  });

  if (!block)
    return protectPos
      ? `No ${blockType} found nearby (the ${PROTECT_RADIUS}-block zone around The Stash is protected — mine elsewhere).`
      : `No ${blockType} found nearby.`;

  // Refuse a dig the tool cannot finish, BEFORE walking up to 64 blocks to it.
  //
  // 251 of one session's mine_block calls asked for iron_ore while 281 of the
  // pickaxes in play were wooden. Iron ore needs stone+; with wood it takes 15s
  // and drops nothing, and digSafe gives up at 12s. Every one of those attempts
  // was arithmetically incapable of succeeding, and "dig timeout" told the brain
  // nothing, so it asked again -- 120 timeouts, an 8% mine success rate, and a
  // swarm banking 1 item an hour.
  //
  // The advice matters more than the refusal: stone IS minable with wood, so
  // saying which pickaxe is missing and how to get it turns a permanent deadlock
  // into a two-step plan the brain can actually follow.
  const held = bestPickaxe(bot)?.name ?? null;
  if (!canHarvest(block.name, held)) return harvestAdvice(block.name, held);

  // Allow digging so pathfinder can reach underground ores through stone
  const { Movements } = (await import("mineflayer-pathfinder")).default;
  const digMoves = baseMoves(bot);
  digMoves.canDig = true;
  bot.pathfinder.setMovements(digMoves);
  // Budget the walk against the distance, not a flat 15s default.
  //
  // The ore search reaches 64 blocks and this goto took safeGoto's 15 second
  // default while digging through stone. Those two numbers disagreed by about
  // an order of magnitude, and the result was 39 navigation timeouts and 28 dig
  // timeouts against 8 iron mined in one session. See mine-budget.ts.
  const travelMs = travelBudgetMs(bot.entity.position.distanceTo(block.position));
  await safeGoto(bot, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), travelMs);
  await equipPickaxe(bot);
  await digSafe(bot, block);
  let mined = 1;

  // Vein mining: one ore block is rarely worth the trip. Follow the connected
  // vein (flood-fill of same-type ore) so a single mine_block yields a useful
  // haul instead of one block at a time.
  if (isOre) {
    mined += await mineVein(bot, block.position, block.name, protectedAt);
  }

  // Walk over the drops — digging alone leaves items on the ground
  await new Promise((r) => setTimeout(r, 400));
  await collectNearbyDrops(bot, 6, 6000);
  bot.pathfinder.setMovements(safeMoves(bot)); // restore safe moves
  return isOre ? `Mined ${mined}x ${block.name} (vein).` : `Mined ${blockType}.`;
}

function bestPickaxe(bot: Bot) {
  // Prefer the best pickaxe so harder ores (iron needs stone+) actually drop.
  const ranks = ["netherite", "diamond", "iron", "stone", "golden", "wooden"];
  const picks = bot.inventory.items().filter((i) => i.name.endsWith("_pickaxe"));
  picks.sort((a, b) => ranks.findIndex((r) => a.name.startsWith(r)) - ranks.findIndex((r) => b.name.startsWith(r)));
  return picks.find((p) => ranks.some((r) => p.name.startsWith(r)));
}

async function equipPickaxe(bot: Bot): Promise<void> {
  const best = bestPickaxe(bot);
  if (best) {
    try {
      await bot.equip(best, "hand");
    } catch {
      /* keep current tool */
    }
  }
}

/** Flood-fill mine the ore vein connected to `start`. Capped to stay quick. */
async function mineVein(
  bot: Bot,
  start: Vec3,
  oreName: string,
  protectedAt: (pos: Vec3) => boolean,
  cap = 16,
): Promise<number> {
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
      const key = p.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      const b = bot.blockAt(p);
      if (!b || b.name !== oreName || protectedAt(p)) continue;
      try {
        if (bot.entity.position.distanceTo(p) > 4) {
          await safeGoto(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 8000);
        }
        await equipPickaxe(bot);
        await digSafe(bot, b);
        extra++;
        queue.push(p);
        if (extra >= cap) break;
      } catch {
        /* unreachable block — skip */
      }
    }
  }
  return extra;
}

async function goTo(bot: Bot, x: number, y: number, z: number): Promise<string> {
  // Default missing coordinates to bot's current position
  const cx = isFinite(x) ? x : bot.entity.position.x;
  const cy = isFinite(y) ? y : bot.entity.position.y;
  const cz = isFinite(z) ? z : bot.entity.position.z;

  // Reject unreasonable distances — LLM often hallucinates coordinates
  const dist = bot.entity.position.distanceTo(new Vec3(cx, cy, cz));
  if (dist > 200) return `That's ${dist.toFixed(0)} blocks away — too far! Try explore instead for shorter trips.`;
  if (dist < 2) return "Already here!";

  bot.pathfinder.setMovements(safeMoves(bot));
  try {
    await safeGoto(bot, new goals.GoalNear(cx, cy, cz, 2));
  } catch (err) {
    // Rescue mode: safe movements can't dig or tower, so a bot standing in a
    // pit (or behind one block of dirt) is permanently stuck. Retry once with
    // digging + 1x1 towers enabled before giving up.
    const rescue = baseMoves(bot);
    rescue.canDig = true;
    rescue.allow1by1towers = true;
    bot.pathfinder.setMovements(rescue);
    try {
      await safeGoto(bot, new goals.GoalNear(cx, cy, cz, 2), 30000);
    } finally {
      bot.pathfinder.setMovements(safeMoves(bot));
    }
  }
  return `Arrived at ${cx.toFixed(0)}, ${cy.toFixed(0)}, ${cz.toFixed(0)}.`;
}

/**
 * Hand items to a teammate by walking up and tossing them at their feet.
 * Bots kept negotiating handoffs in chat ("give me the logs!" / "take
 * them!") with no mechanism to actually do it — this is that mechanism.
 */
async function giveItem(bot: Bot, to: string, itemName: string, count: number): Promise<string> {
  if (!to) return "give_item needs a 'to' param (teammate name).";
  if (!itemName) return "give_item needs an 'item' param.";

  const item = bot.inventory.items().find((i) => i.name === itemName || i.name.includes(itemName));
  if (!item) return `You don't have any ${itemName} to give.`;

  const target = bot.players[to]?.entity;
  if (!target) {
    const { getBotStatus } = await import("./bulletin.js");
    const status = getBotStatus(to);
    if (!status) return `Can't find ${to} nearby. Ask them to come to you, or go_to their position first.`;
    const { x, y, z } = status.position;
    const dist = bot.entity.position.distanceTo(new Vec3(x, y, z));
    if (dist > 64)
      return `${to} is ${dist.toFixed(0)} blocks away at (${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)}) — go_to them first.`;
    bot.pathfinder.setMovements(explorerMoves(bot));
    await safeGoto(bot, new goals.GoalNear(x, y, z, 2), 30000);
  } else {
    if (bot.entity.position.distanceTo(target.position) > 3) {
      // CHASE the live entity rather than its remembered spot: two bots once
      // walked toward each other to trade (gold one way, iron the other),
      // each goto died to the other's movement, and both handoffs aborted
      // with "moved away". GoalFollow tracks the recipient wherever they
      // wander during the approach.
      bot.pathfinder.setMovements(explorerMoves(bot));
      await safeGoto(bot, new goals.GoalFollow(target, 2), 30000).catch(() => {});
    }
  }

  // Honest handoff: only toss when the target is actually here, and verify
  // the drops got picked up. The first version reported success while the
  // recipient walked away and the items rotted on the ground — Flora got
  // "given" 115 planks and received zero.
  //
  // CLOSE the gap before throwing: the pickup magnet only reaches ~1-2
  // blocks, so a toss from 4 blocks at a stationary recipient lands on the
  // floor between them — Mason threw 3 diamonds "toward Forge" twice and
  // both times the stones sat on the ground until a bystander wandered
  // through (Flora walked off with one and earned Diamonds! doing it).
  const tgt = bot.players[to]?.entity;
  if (!tgt || bot.entity.position.distanceTo(tgt.position) > 4) {
    return `${to} moved away before the handoff — NOTHING was given. Get next to them and try again.`;
  }
  if (bot.entity.position.distanceTo(tgt.position) > 2) {
    await safeGoto(bot, new goals.GoalNear(tgt.position.x, tgt.position.y, tgt.position.z, 1), 15000).catch(() => {});
  }
  const tgt2 = bot.players[to]?.entity;
  if (!tgt2 || bot.entity.position.distanceTo(tgt2.position) > 3) {
    return `${to} moved away before the handoff — NOTHING was given. Get next to them and try again.`;
  }
  await bot.lookAt(tgt2.position.offset(0, 1, 0));
  const toGive = Math.min(count, item.count);
  const countMine = () =>
    bot.inventory
      .items()
      .filter((i) => i.name === item.name)
      .reduce((sum, i) => sum + i.count, 0);
  const beforeToss = countMine();
  await bot.toss(item.type, null, toGive);
  // STEP AWAY from the drop: with both bots inside two blocks, the item
  // lands in BOTH pickup magnets and the giver's own magnet can win the
  // race — Forge "gave" Blade four gold, the ground cleared, delivery was
  // "confirmed", and the ingots were back in Forge's pocket the whole time.
  // Backing off leaves the drop inside the recipient's magnet alone.
  bot.setControlState("back", true);
  await new Promise((r) => setTimeout(r, 1200));
  bot.setControlState("back", false);
  await new Promise((r) => setTimeout(r, 2500)); // pickup time
  const leftovers = Object.values(bot.entities).filter(
    (e) => e.name === "item" && e.position.distanceTo(bot.entity.position) < 6,
  ).length;
  // The honest verdict needs BOTH signals: ground clear AND the goods gone
  // from the giver's own pocket. Ground-clear alone cannot tell which
  // magnet won.
  if (countMine() >= beforeToss) {
    return `Tossed ${toGive}x ${item.name} toward ${to} but my own pickup magnet caught it — stepping back and retrying later.`;
  }
  if (leftovers > 0) {
    // Take the goods BACK rather than abandoning them: three diamonds left
    // "for Forge to pick up" are three diamonds for whoever strolls past.
    // Custody plus a retry on the next cooldown beats scatter.
    //
    // VERIFY the reclaim: this branch once REPORTED custody while the sweep
    // quietly failed and four gold ingots despawned on the village floor —
    // the kit tape showed the toss leaving the pocket and nothing coming
    // back, while the return string said "took the items back". Sweep
    // wider, then count.
    const { collectNearbyDrops, shedJunk } = await import("./navigation.js");
    await shedJunk(bot, 2).catch(() => {});
    await collectNearbyDrops(bot, 8, 8000).catch(() => {});
    const reclaimed = countMine() - (beforeToss - toGive);
    if (reclaimed >= toGive) {
      return `Tossed ${toGive}x ${item.name} toward ${to} but they didn't catch it — took the items back into my own pack to retry later.`;
    }
    const p = bot.entity.position.floored();
    console.log(
      `[Kit] RECLAIM SHORTFALL: ${bot.username} recovered ${Math.max(0, reclaimed)}/${toGive} ${item.name} near ${p.x},${p.y},${p.z}`,
    );
    return `Tossed ${toGive}x ${item.name} toward ${to}, they didn't catch it, and I could only reclaim ${Math.max(0, reclaimed)} — the rest may be on the ground near ${p.x},${p.y},${p.z}.`;
  }
  return `Gave ${toGive}x ${item.name} to ${to} — delivery confirmed (left my pocket, ground clear).`;
}

async function explore(bot: Bot, direction: string): Promise<string> {
  const pos = bot.entity.position;

  // If in water, use pathfinder with free motion to navigate to surface/shore
  const currentBlock = bot.blockAt(pos);
  const headBlock = bot.blockAt(pos.offset(0, 1, 0));
  if (currentBlock?.name === "water" || headBlock?.name === "water") {
    console.log("[Explore] Bot is in water — attempting pathfinder escape");
    bot.pathfinder.setMovements(explorerMoves(bot));
    // TIGHT search bound for the escape: GoalY from open water asks A* for
    // "any block at that height" and the frontier is the whole lake — this
    // exact line preceded all three heap-OOM crashes (173MB to 8GB in
    // seconds). A shore within 48 blocks is reachable; one farther away is
    // a swim the lateral fallback handles a leg at a time.
    const pf = bot.pathfinder as unknown as { searchRadius: number };
    const priorRadius = pf.searchRadius;
    pf.searchRadius = 48;
    try {
      // Try to reach a high Y to surface
      await safeGoto(bot, new goals.GoalY(70), 30000);
    } catch {
      // If that fails, try moving laterally to find shore
      try {
        const p = bot.entity.position;
        await safeGoto(bot, new goals.GoalNear(p.x + 100, p.y, p.z, 5), 30000);
      } catch {
        /* best effort */
      }
    } finally {
      pf.searchRadius = priorRadius;
    }
  }

  // If underground (below y=67), try to dig/climb to the surface before exploring laterally.
  if (bot.entity.position.y < 67) {
    const digMoves = baseMoves(bot);
    digMoves.canDig = true;
    digMoves.allowFreeMotion = true;
    digMoves.allow1by1towers = true;
    bot.pathfinder.setMovements(digMoves);
    try {
      await safeGoto(bot, new goals.GoalY(70), 30000);
    } catch {
      /* best effort */
    }
    bot.pathfinder.setMovements(explorerMoves(bot));
  }

  // Hops of 60-120 blocks — large enough to escape stripped biomes quickly,
  // small enough to not skip entire forest biomes. TP fallback handles stuck cases.
  const currentPos = bot.entity.position;
  const dist = 60 + Math.floor(Math.random() * 60);
  const jitter = () => (Math.random() - 0.5) * 20;
  // Movement is measured from BEFORE the switch — the "up" case moves the bot
  // inside its case block, and measuring after it would misreport a
  // successful climb as "Couldn't move up".
  const originPos = bot.entity.position.clone();
  let target: Vec3;

  switch (direction) {
    case "up": {
      // Real vertical escape. The LLM asks to explore "up" constantly when a
      // bot is trapped in the mined-out pits around the base (92x in 73 min):
      // maxDropDown=3 lets bots DROP into 3-deep pits, but they can't climb
      // 2+ block walls and towers are disabled in normal movement — a trap.
      // Previously "up" wasn't a case, silently aliased to the default
      // (east!) and honest-failed. Dig/tower toward the surface instead,
      // using the bot's own tools and blocks.
      const upMoves = baseMoves(bot);
      upMoves.canDig = true;
      upMoves.allow1by1towers = true;
      upMoves.allowFreeMotion = true;
      bot.pathfinder.setMovements(upMoves);
      const fromY = bot.entity.position.y;
      try {
        await safeGoto(bot, new goals.GoalY(Math.max(72, Math.ceil(fromY) + 4)), 30000);
      } catch {
        /* movedDist check below reports honestly */
      }
      bot.pathfinder.setMovements(explorerMoves(bot));
      target = bot.entity.position.clone(); // no lateral leg; report from here
      break;
    }
    case "north":
      target = currentPos.offset(jitter(), 0, -dist);
      break;
    case "south":
      target = currentPos.offset(jitter(), 0, dist);
      break;
    case "east":
      target = currentPos.offset(dist, 0, jitter());
      break;
    case "west":
      target = currentPos.offset(-dist, 0, jitter());
      break;
    default:
      target = currentPos.offset(dist, 0, jitter());
  }

  bot.pathfinder.setMovements(explorerMoves(bot));
  const startPos = originPos;
  try {
    await safeGoto(bot, new goals.GoalNear(target.x, target.y, target.z, 5), 20000);
  } catch {
    /* ignore — stuck check below fires either way */
  }

  // TP fallback: runs whether safeGoto threw OR resolved without moving.
  // The pathfinder can resolve its promise without error when it gives up on an unreachable
  // goal, leaving the bot at the same position. Checking AFTER try/catch ensures we catch both.
  const movedDist = bot.entity.position.distanceTo(startPos);
  if (movedDist < 2) {
    if (config.bot.allowInterventions) {
      // Teleport-unstick is an intervention — off by default (the bot must find
      // its own way or stay put). spreadplayers lands on a safe surface block.
      bot.chat(`/spreadplayers ${Math.round(target.x)} ${Math.round(target.z)} 0 4 false ${bot.username}`);
      await new Promise((r) => setTimeout(r, 3000));
    } else {
      // HONEST failure. This used to fall through to the success message —
      // "Explored <dir> (~N blocks)" with the INTENDED distance — even when
      // the pathfinder never moved the bot. The LLM believed it, saw the same
      // surroundings, and chose explore again: Atlas returned 226 identical
      // "explored" results at the same coords, visually frozen at a lake edge.
      // Report the truth so the brain re-plans instead of looping.
      return `Couldn't move ${direction} — path blocked, still at ${startPos.x.toFixed(0)}, ${startPos.y.toFixed(0)}, ${startPos.z.toFixed(0)}. Try a DIFFERENT direction, mine_block to dig through the obstacle, or go_to a known location like the stash.`;
    }
  }

  // Report what we can see from wherever we ended up
  // MC 1.21.4 adds pale_oak_log (Pale Garden biome); scan at 64 blocks to catch nearby forests.
  const logTypes = ["oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log", "pale_oak_log"];
  const nearbyTree = bot.findBlock({ matching: (b) => logTypes.includes(b.name), maxDistance: 64 });
  const nearbyOre = bot.findBlock({ matching: (b) => b.name.includes("ore"), maxDistance: 16 });
  const nearbyWater = bot.findBlock({ matching: (b) => b.name === "water", maxDistance: 16 });

  const notes: string[] = [];
  if (nearbyTree) notes.push("Found trees nearby!");
  if (nearbyOre) notes.push(`Spotted ${nearbyOre.name}!`);
  if (nearbyWater) notes.push("Water/lake visible.");
  if (notes.length === 0) notes.push("Barren area — no trees or resources visible.");

  const block = bot.blockAt(bot.entity.position) as any;
  const rawBiome = block?.biome;
  // block.biome might be a biome object directly, or a numeric ID
  const biome =
    typeof rawBiome === "object" && rawBiome?.name
      ? rawBiome.name
      : typeof rawBiome === "number"
        ? ((bot as any).registry?.biomes?.[rawBiome]?.name ?? `biome_${rawBiome}`)
        : "unknown";
  const newPos = bot.entity.position;
  return `Explored ${direction} (~${dist} blocks). Now at ${newPos.x.toFixed(0)}, ${newPos.y.toFixed(0)}, ${newPos.z.toFixed(0)}. Biome: ${biome}. ${notes.join(" ")}`;
}

// Common crafting aliases — LLMs often use informal names
const CRAFT_ALIASES: Record<string, string> = {
  planks: "oak_planks",
  wooden_planks: "oak_planks",
  wood_planks: "oak_planks",
  sticks: "stick",
  wood_pickaxe: "wooden_pickaxe",
  wood_axe: "wooden_axe",
  wood_sword: "wooden_sword",
  wood_shovel: "wooden_shovel",
  wood_hoe: "wooden_hoe",
  stone_pick: "stone_pickaxe",
  iron_pick: "iron_pickaxe",
  diamond_pick: "diamond_pickaxe",
  workbench: "crafting_table",
  table: "crafting_table",
  bed: "red_bed",
};

async function craftItem(bot: Bot, itemName: string, count: number): Promise<string> {
  // Resolve aliases
  const resolvedName = CRAFT_ALIASES[itemName] || itemName;
  const mcData = (await import("minecraft-data")).default(bot.version);
  const item = mcData.itemsByName[resolvedName];
  if (!item) return `Unknown item: ${itemName}. Use exact Minecraft IDs like oak_planks, stick, wooden_pickaxe.`;

  // Find or place crafting table (needed for 3x3 recipes like pickaxes)
  let craftingTable = bot.findBlock({
    matching: (b) => b.name === "crafting_table",
    maxDistance: 32,
  });

  // Try recipe with crafting table first (supports 3x3), fall back to hand (2x2)
  let recipe = craftingTable ? bot.recipesFor(item.id, null, 1, craftingTable)[0] : null;

  if (!recipe) {
    // Try 2x2 hand recipe
    recipe = bot.recipesFor(item.id, null, 1, null)[0];
  }

  if (!recipe && !craftingTable) {
    // No recipe without table — try auto-placing one from inventory
    const tableItem = bot.inventory.items().find((i) => i.name === "crafting_table");
    if (tableItem) {
      const placePos = findAdjacentAir(bot);
      if (placePos) {
        try {
          await bot.equip(tableItem, "hand");
          await bot.lookAt(placePos.ref.position.offset(0.5, 0.5, 0.5));
          await bot.placeBlock(placePos.ref, placePos.face);
          // Find the table we just placed
          craftingTable = bot.findBlock({
            matching: (b) => b.name === "crafting_table",
            maxDistance: 8,
          });
          if (craftingTable) {
            recipe = bot.recipesFor(item.id, null, 1, craftingTable)[0];
          }
        } catch {
          // Placement failed, continue without table
        }
      }
    }
  }

  if (!recipe) {
    // Auto-convert logs → planks if missing planks (common early-game bottleneck)
    const hasPlanks = bot.inventory.items().some((i) => i.name.endsWith("_planks"));
    if (!hasPlanks) {
      const logItem = bot.inventory.items().find((i) => i.name.endsWith("_log"));
      if (logItem) {
        const planksName = logItem.name.replace("_log", "_planks");
        const planksItemData = mcData.itemsByName[planksName];
        if (planksItemData) {
          const planksRecipe = bot.recipesFor(planksItemData.id, null, 1, null)[0];
          if (planksRecipe) {
            try {
              await bot.craft(planksRecipe, Math.floor(logItem.count), undefined);
              console.log(`[Craft] Auto-crafted ${logItem.name} → ${planksName}`);
            } catch {
              /* ignore, try main recipe anyway */
            }
            // Re-check recipe after getting planks
            recipe = craftingTable
              ? bot.recipesFor(item.id, null, 1, craftingTable)[0]
              : bot.recipesFor(item.id, null, 1, null)[0];
          }
        }
      }
    }
  }

  if (!recipe) {
    // Provide specific missing-material feedback so the LLM knows what to gather next.
    if (resolvedName.endsWith("_bed")) {
      const hasWool = bot.inventory.items().some((i) => i.name.endsWith("_wool"));
      const woolCount = bot.inventory
        .items()
        .filter((i) => i.name.endsWith("_wool"))
        .reduce((s, i) => s + i.count, 0);
      if (!hasWool || woolCount < 3) {
        return `Can't craft ${resolvedName} — need 3 wool (you have ${woolCount}). Kill/shear nearby sheep to get wool, then craft planks + wool into a bed.`;
      }
    }
    if (resolvedName === "torch") {
      const hasCoal = bot.inventory.items().some((i) => i.name === "coal" || i.name === "charcoal");
      const hasStick = bot.inventory.items().some((i) => i.name === "stick");
      const missing: string[] = [];
      if (!hasCoal) missing.push("coal or charcoal (mine coal_ore with a pickaxe)");
      if (!hasStick) missing.push("sticks (craft from planks)");
      return `Can't craft torch — missing: ${missing.length ? missing.join(", ") : "unknown"}. Recipe: 1 coal/charcoal + 1 stick = 4 torches.`;
    }
    // Generic: try to identify missing ingredients from the first known recipe
    const allRecipes = mcData.recipes?.[item.id];
    if (allRecipes?.length) {
      // Recipe is ShapedRecipe | ShapelessRecipe — one has inShape, the other
      // ingredients. Cast to read both with ?? (the union type rejects each).
      const r0 = allRecipes[0] as { ingredients?: unknown[]; inShape?: unknown[][] };
      const needed = (r0.ingredients ?? r0.inShape?.flat() ?? []).filter(Boolean).map((ing: any) => {
        const ingId = typeof ing === "object" ? (ing.id ?? ing) : ing;
        return mcData.items[ingId]?.name ?? String(ingId);
      });
      const uniqueNeeded = [...new Set(needed)]
        .filter((n) => n && n !== "null")
        // Recipe variant 0 is an arbitrary wood family — don't tell the bot it
        // specifically needs pale_oak_planks when any planks work.
        .map((n) => (String(n).endsWith("_planks") ? "planks (any wood — craft from your logs)" : n));
      const dedup = [...new Set(uniqueNeeded)];
      if (dedup.length) {
        return `Can't craft ${resolvedName} — need: ${dedup.join(", ")}. Gather those first.`;
      }
    }
    return `Can't craft ${resolvedName} — missing materials or need a crafting table.`;
  }

  if (craftingTable) {
    // Walk to the crafting table
    bot.pathfinder.setMovements(safeMoves(bot));
    await safeGoto(
      bot,
      new goals.GoalNear(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 2),
      8000,
    );
  }

  await bot.craft(recipe, count, craftingTable || undefined);
  return `Crafted ${count}x ${resolvedName}.`;
}

// Food ranked best→worst by hunger/saturation. The bot eats the best it has.
// Raw meats are the critical addition: bots hunt animals and end up holding
// raw_mutton/raw_beef, but the old list only knew cooked food — so a starving
// bot with raw meat got "No food!" and died. Raw is weak but beats starvation.
const FOOD_PRIORITY = [
  "rabbit_stew",
  "cooked_beef",
  "cooked_porkchop",
  "pumpkin_pie",
  "golden_apple",
  "cooked_mutton",
  "cooked_salmon",
  "cooked_chicken",
  "mushroom_stew",
  "beetroot_soup",
  "bread",
  "baked_potato",
  "cooked_cod",
  "cooked_rabbit",
  "apple",
  "carrot",
  "melon_slice",
  "sweet_berries",
  "glow_berries",
  "cookie",
  // weak edibles + raw fallback — low hunger value, but prevent starvation death
  "potato",
  "beetroot",
  "dried_kelp",
  // NOTE: raw meats have NO raw_ prefix in Minecraft (that's only ores like
  // raw_iron). The list previously said raw_beef/raw_porkchop/... which match
  // NOTHING — so the raw fallback never fired and bots starved at HP 10
  // holding meat ("No food in inventory!" 559x/run). Real ids: beef, porkchop,
  // rabbit, mutton, salmon, cod, chicken.
  "beef",
  "porkchop",
  "rabbit",
  "mutton",
  "salmon",
  "cod",
  "chicken",
  // ABSOLUTE last resort: rotten flesh restores 4 hunger (brief harmless hunger
  // debuff on Easy). Bots were starving to death holding rotten flesh from
  // zombie kills while looping "eat is broken" because it wasn't recognized.
  "rotten_flesh",
];

/** Total count of edible items (raw or cooked) in the bot's inventory. */
function countEdibleItems(bot: Bot): number {
  const edible = new Set(FOOD_PRIORITY);
  return bot.inventory
    .items()
    .filter((i) => edible.has(i.name))
    .reduce((sum, i) => sum + i.count, 0);
}

async function eat(bot: Bot): Promise<string> {
  if (bot.food >= 20) return "Already full! Hunger: 20/20. Do something else.";

  const have = new Map(bot.inventory.items().map((i) => [i.name, i]));
  const best = FOOD_PRIORITY.find((name) => have.has(name));
  if (!best) return "No food in inventory!";

  await bot.equip(have.get(best)!, "hand");
  await bot.consume();
  const raw = best.startsWith("raw_");
  return `Ate ${best}. Hunger: ${bot.food}/20${raw ? " (raw — cook it next time for more)" : ""}`;
}

const FOOD_ANIMALS = ["cow", "pig", "sheep", "chicken", "rabbit", "mooshroom"];

async function attackNearest(bot: Bot): Promise<string> {
  // Guard: while dead/respawning, bot.entity is undefined. Dereferencing
  // bot.entity.position inside the search predicates threw ~20k times/run and
  // silently killed every attack/hunt during that window. Bail cleanly instead.
  const myPos = bot.entity?.position;
  if (!myPos) return "Can't attack right now — still respawning.";

  // Fall guard: don't pursue a target more than 3 blocks BELOW us — chasing
  // mobs down into the base mining-pits / off ledges was the #1 death cause
  // (falls during combat pursuit, which the swordpvp sprint takes the bot over,
  // bypassing the pathfinder drop cap). A target down a pit isn't worth dying
  // for; engage only reachable ones.
  const reachable = (e: { position?: { y: number } }) => !!e.position && e.position.y >= myPos.y - 3;

  // Defense first: nearest hostile within 16. (!!e.position guards entities
  // that are mid-spawn and have no position yet.)
  let target = bot.nearestEntity((e) => reachable(e) && isHostile(e) && e.position.distanceTo(myPos) < 16);

  if (!target) {
    // No threat → HUNT the nearest passive food animal for meat. This was the
    // missing food source: bots killed hostiles (bones/arrows, no food) but
    // never sought out animals, so raw meat never entered the pipeline.
    const animal = bot.nearestEntity(
      (e) =>
        e !== bot.entity &&
        reachable(e) &&
        FOOD_ANIMALS.includes((e.name || "").toLowerCase()) &&
        e.position.distanceTo(myPos) < 24,
    );
    if (animal) {
      // Hunt it with a dedicated pursue-and-kill loop (below). swordpvp is built
      // for hostiles that approach you — it does NOT chase fleeing animals, so it
      // was falsely reporting kills when the animal just ran >20 blocks away.
      return await huntAnimal(bot, animal);
    }
  }

  if (!target) {
    // Last resort: any living mob nearby (exclude players, dropped items, projectiles)
    target = bot.nearestEntity(
      (e) => e !== bot.entity && !!e.position && e.type === "mob" && e.position.distanceTo(myPos) < 8,
    );
    if (!target) return "No hostiles or food animals to hunt nearby. Explore to find some.";
  }

  const targetName = target.name || "entity";

  // Use @nxg-org/mineflayer-custom-pvp for sustained, skilled combat
  // The plugin handles strafing, critical-hit timing, shield use, and target tracking
  if ((bot as any).swordpvp) {
    const swordpvp = (bot as any).swordpvp;

    // Start the custom PvP attack — it runs asynchronously via physicsTick
    swordpvp.attack(target);

    // Wait up to 6 seconds for combat to resolve (target dies or timeout)
    const COMBAT_TIMEOUT = 6000;
    const combatStart = Date.now();
    let kills = 0;

    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        // Stop if timeout exceeded
        if (Date.now() - combatStart >= COMBAT_TIMEOUT) {
          cleanup();
          resolve();
          return;
        }
        // A real kill = the entity is gone. Fleeing >20 blocks away ends the
        // engagement but is NOT a kill (it used to be falsely counted). If we
        // died mid-fight (bot.entity gone), just end it.
        const me = bot.entity?.position;
        if (!target!.isValid) {
          kills++;
          cleanup();
          resolve();
        } else if (!me || target!.position.distanceTo(me) > 20) {
          cleanup();
          resolve();
        }
      }, 250);

      function cleanup() {
        clearInterval(checkInterval);
        swordpvp.stop();
      }
    });

    if (kills > 0) {
      // Walk over the drops — a kill leaves raw meat/wool/etc. on the ground,
      // and without collecting it the bots hunt but never actually get food.
      // This was THE food-acquisition gap: 5 sheep killed, 0 meat in inventory.
      const foodBefore = countEdibleItems(bot);
      await collectNearbyDrops(bot, 8, 6000);
      const gained = countEdibleItems(bot) - foodBefore;
      return `Defeated ${targetName} using advanced combat!${gained > 0 ? ` Grabbed ${gained} food drop(s).` : " (grabbed drops)"}`;
    }
    return `Fought ${targetName} for ${((Date.now() - combatStart) / 1000).toFixed(1)}s (still alive — may need to re-engage).`;
  }

  // Fallback: bare mineflayer attack if swordpvp somehow not loaded
  await bot.lookAt(target.position.offset(0, (target as any).height ?? 1.6, 0));
  bot.attack(target);
  return `Attacked ${targetName} (basic hit).`;
}

/**
 * Pursue and kill a fleeing passive animal, then collect the meat. Animals run
 * when hit, so we chase (re-path toward it) and swing until it's actually dead
 * (entity invalid) — not until it gets "far enough away" (the old false-kill).
 */
async function huntAnimal(bot: Bot, animal: import("prismarine-entity").Entity): Promise<string> {
  const name = animal.name || "animal";
  const HUNT_TIMEOUT = 12000;
  const start = Date.now();

  while (Date.now() - start < HUNT_TIMEOUT && animal.isValid) {
    const myPos = bot.entity?.position;
    if (!myPos) return `Lost ${name} — died/respawned mid-hunt.`; // bot died chasing
    const dist = animal.position.distanceTo(myPos);
    if (dist > 3) {
      try {
        await safeGoto(bot, new goals.GoalNear(animal.position.x, animal.position.y, animal.position.z, 2), 3000);
      } catch {
        /* keep chasing */
      }
    }
    if (!animal.isValid) break; // died while we closed in
    try {
      await bot.lookAt(animal.position.offset(0, (animal as any).height ?? 0.6, 0));
      bot.attack(animal);
    } catch {
      /* swing missed — loop and retry */
    }
    await bot.waitForTicks(6); // attack cooldown (~0.3s)
  }

  if (animal.isValid) {
    return `Chased ${name} but it got away — too fast. Try again or pick a closer one.`;
  }

  // Confirmed kill — collect the meat it dropped.
  const before = countEdibleItems(bot);
  await collectNearbyDrops(bot, 8, 6000);
  const gained = countEdibleItems(bot) - before;
  return gained > 0
    ? `Hunted ${name} and collected ${gained} food! Eat when hungry.`
    : `Hunted ${name} (drops collected — check inventory).`;
}

async function flee(bot: Bot): Promise<string> {
  const myPos = bot.entity?.position;
  if (!myPos) return "Can't flee right now — still respawning.";
  // Use same hostile detection as perception system
  const hostile = bot.nearestEntity((e) => !!e.position && isHostile(e) && e.position.distanceTo(myPos) < 16);

  if (!hostile) {
    // No hostile found — just move somewhere random to break the loop
    const pos = bot.entity.position;
    const angle = Math.random() * Math.PI * 2;
    const target = pos.offset(Math.cos(angle) * 15, 0, Math.sin(angle) * 15);
    bot.pathfinder.setMovements(safeMoves(bot));
    await safeGoto(bot, new goals.GoalNear(target.x, target.y, target.z, 5), 8000);
    return "Ran in a random direction — nothing visible to flee from.";
  }

  // Run away from the threat.
  //
  // This used to project a SINGLE blind target 20 blocks opposite the hostile
  // and path straight at it. Nothing checked the destination was standable, so
  // it landed in walls, water, cliff faces and thin air, and safeMoves has
  // canDig=false so a blocked direction is simply unreachable. Measured: 41
  // navigation timeouts against 41 successful flees, a 42% failure rate on the
  // one defensive action Forge has. Forge cannot attack and led the swarm in
  // deaths with "slain by" as its top cause.
  //
  // Fan candidates out from directly-away and take the first standable one,
  // trying shorter distances as it goes: escaping diagonally or only part way
  // still breaks contact, whereas timing out leaves the bot beside the mob.
  const dir = bot.entity.position.minus(hostile.position).normalize();
  const candidates: InstanceType<typeof Vec3>[] = [];

  for (const dist of [20, 12, 7]) {
    for (const spread of [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3]) {
      // Rotate the away-vector horizontally; vertical escape is not meaningful.
      const cos = Math.cos(spread);
      const sin = Math.sin(spread);
      const away = new Vec3(dir.x * cos - dir.z * sin, 0, dir.x * sin + dir.z * cos).normalize();
      candidates.push(bot.entity.position.plus(away.scaled(dist)));
    }
  }

  const fleeStart = Date.now();
  for (const c of candidates) {
    if (Date.now() - fleeStart > 12000) break;

    // Find a standable spot near this candidate, allowing for sloped ground.
    let spot: InstanceType<typeof Vec3> | null = null;
    for (const dy of [0, 1, -1, -2]) {
      const base = c.offset(0, dy, 0);
      const ground = bot.blockAt(base.offset(0, -1, 0));
      const feet = bot.blockAt(base);
      const head = bot.blockAt(base.offset(0, 1, 0));
      if (!ground || ground.boundingBox !== "block") continue;
      if (ground.name === "lava" || feet?.name === "lava") continue;
      if (!feet || feet.name !== "air" || !head || head.name !== "air") continue;
      spot = base;
      break;
    }
    if (!spot) continue;

    try {
      bot.pathfinder.setMovements(safeMoves(bot));
      await safeGoto(bot, new goals.GoalNear(spot.x, spot.y, spot.z, 3), 6000);
      return `Fled from ${hostile.name || "danger"}!`;
    } catch {
      continue;
    }
  }

  // No open route anywhere in the fan. Bots spend most of their time in mining
  // tunnels (mine_block is a top-3 action), so surface-style candidates hit
  // solid rock and the bot stands beside the mob until it dies: 49 cornered
  // events in one session, every one with all 15 candidates rejected, while
  // deaths nearly doubled and falls spread across all four roles.
  //
  // Tunnel out instead. The bots carry pickaxes, this is what a player does
  // when cornered underground, and it needs no action the roles do not already
  // have — which matters for Forge, whose role has no attack at all.
  try {
    const digAway = baseMoves(bot);
    digAway.canDig = true;
    digAway.allow1by1towers = false; // no pillaring: that is a fall risk
    bot.pathfinder.setMovements(digAway);

    const flat = new Vec3(dir.x, 0, dir.z).normalize();
    const digTarget = bot.entity.position.plus(flat.scaled(7));
    await safeGoto(bot, new goals.GoalNear(digTarget.x, digTarget.y, digTarget.z, 3), 8000);
    return `Tunnelled away from ${hostile.name || "danger"}!`;
  } catch {
    /* even digging failed — report honestly below */
  } finally {
    bot.pathfinder.setMovements(safeMoves(bot));
  }

  console.log(`[FleeDebug] no standable escape from ${hostile.name} — ${candidates.length} candidates rejected`);
  return `Cornered by ${hostile.name || "danger"} — no escape route. Fight or find cover.`;
}

async function buildShelter(bot: Bot): Promise<string> {
  // Simple shelter: place blocks around and above the bot
  const pos = bot.entity.position.floored();
  const dirtId = bot.registry.blocksByName["dirt"]?.id;

  if (!dirtId) return "Can't identify dirt block.";

  // Check if we have any building blocks
  const buildBlocks = bot.inventory
    .items()
    .filter((i) => ["dirt", "cobblestone", "oak_planks", "spruce_planks", "birch_planks", "stone"].includes(i.name));

  if (buildBlocks.length === 0) return "No building blocks in inventory!";

  // Place a simple 3x3 ring at the player's position
  const offsets = [
    [-1, 0, -1],
    [0, 0, -1],
    [1, 0, -1],
    [-1, 0, 0],
    [1, 0, 0],
    [-1, 0, 1],
    [0, 0, 1],
    [1, 0, 1],
    // Roof
    [-1, 2, -1],
    [0, 2, -1],
    [1, 2, -1],
    [-1, 2, 0],
    [0, 2, 0],
    [1, 2, 0],
    [-1, 2, 1],
    [0, 2, 1],
    [1, 2, 1],
  ];

  let placed = 0;
  for (const [dx, dy, dz] of offsets) {
    const targetPos = pos.offset(dx, dy, dz);
    const existingBlock = bot.blockAt(targetPos);
    if (existingBlock && existingBlock.name === "air") {
      const buildBlock = bot.inventory
        .items()
        .find((i) => ["dirt", "cobblestone", "oak_planks", "spruce_planks", "birch_planks", "stone"].includes(i.name));
      if (!buildBlock) break;
      try {
        await bot.equip(buildBlock, "hand");
        const refBlock = bot.blockAt(targetPos.offset(0, -1, 0));
        if (refBlock && refBlock.name !== "air") {
          await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
          placed++;
        }
      } catch {
        // Skip blocks we can't place
      }
    }
  }

  return placed > 0 ? `Built basic shelter (${placed} blocks placed).` : "Couldn't build shelter here.";
}

/**
 * Find a flat 2-block area nearby for bed placement.
 * Beds need 2 adjacent air blocks on top of 2 solid blocks.
 * Leaves/transparent blocks above are fine — MC allows beds under trees.
 */
function findFlatSpot(bot: Bot): Vec3 | null {
  const pos = bot.entity.position.floored();
  const directions = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

  // Search wider area (5-block radius) at multiple y-levels for uneven terrain
  for (let dx = -5; dx <= 5; dx++) {
    for (let dz = -5; dz <= 5; dz++) {
      for (let dy = -3; dy <= 3; dy++) {
        const base = pos.offset(dx, dy - 1, dz);
        const above = pos.offset(dx, dy, dz);
        const groundBlock = bot.blockAt(base);
        const airBlock = bot.blockAt(above);

        if (!groundBlock || groundBlock.name === "air") continue;
        if (!airBlock || airBlock.name !== "air") continue;

        for (const dir of directions) {
          const base2 = base.plus(dir);
          const above2 = above.plus(dir);
          const ground2 = bot.blockAt(base2);
          const air2 = bot.blockAt(above2);

          if (ground2 && ground2.name !== "air" && air2 && air2.name === "air") {
            return above;
          }
        }
      }
    }
  }
  return null;
}

/**
 * Find an air block near the bot where we can place something.
 * Returns the reference (solid) block and face vector for bot.placeBlock().
 * placeBlock(ref, face) creates a new block at ref.position + face.
 */
function findAdjacentAir(bot: Bot): { ref: any; face: Vec3 } | null {
  const pos = bot.entity.position.floored();
  const faces = [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
    new Vec3(0, 1, 0),
    new Vec3(0, -1, 0),
  ];

  // Scan air blocks around the bot (within 2 blocks, at foot and ground level)
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        const airPos = pos.offset(dx, dy, dz);
        const airBlock = bot.blockAt(airPos);
        if (!airBlock || airBlock.name !== "air") continue;
        // Don't place where the bot is standing or at head height
        if (airPos.equals(pos) || airPos.equals(pos.offset(0, 1, 0))) continue;

        // Find a solid neighbor to use as reference
        for (const face of faces) {
          const refPos = airPos.minus(face);
          const refBlock = bot.blockAt(refPos);
          if (refBlock && refBlock.name !== "air" && !refBlock.name.includes("leaves")) {
            return { ref: refBlock, face };
          }
        }
      }
    }
  }
  return null;
}

/** Try placing a block with a fast 2s timeout. Returns true on success. */
async function tryPlace(bot: Bot, refBlock: any, face: Vec3): Promise<boolean> {
  return Promise.race([
    bot
      .placeBlock(refBlock, face)
      .then(() => true)
      .catch(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
  ]);
}

async function sleepInBed(bot: Bot): Promise<string> {
  // Already in bed — just wait for morning (counts as success so no blacklisting)
  if ((bot as any).isSleeping) return "Sleeping... zzz (waiting for morning)";

  // 64, up from 32: the village's one surviving bed sits at 314,67,-336,
  // ~35 blocks from the stash where bots idle at night. Every one of the 68
  // "No bed and no wool" reflex failures on the first real night happened
  // within walking distance of a bed the search radius missed by 3 blocks.
  // endsWith("_bed"), never includes("bed"): the old match caught BEDROCK,
  // and every underground bot spent its night reflex trying to tuck itself
  // into the bottom of the world ("wrong block: not a bed block").
  let bed = bot.findBlock({
    matching: (b) => b.name.endsWith("_bed"),
    maxDistance: 64,
  });

  // Auto-place bed from inventory if none found nearby
  if (!bed) {
    let bedItem = bot.inventory.items().find((i) => i.name.includes("bed"));

    // Self-sufficiency (same pattern as build_farm's hoe / smelt's furnace):
    // craft a bed from wool + planks instead of failing. Bots were CHOOSING to
    // sleep at night but none of the 5 ever owned a bed ("No bed in inventory"
    // x4/run), so they roamed at night and skeletons shredded them (20
    // skeleton deaths in one 5h window). Bed = 3 same-color wool + 3 planks.
    if (!bedItem) {
      const woolCounts = new Map<string, number>();
      for (const it of bot.inventory.items()) {
        if (it.name.endsWith("_wool")) woolCounts.set(it.name, (woolCounts.get(it.name) ?? 0) + it.count);
      }
      const woolColor = [...woolCounts.entries()].find(([, c]) => c >= 3)?.[0];
      if (!woolColor) {
        return "No bed and no wool to craft one (need 3 same-color wool + 3 planks). Hunt sheep for wool first!";
      }
      const planks = bot.inventory
        .items()
        .filter((i) => i.name.endsWith("_planks"))
        .reduce((s, i) => s + i.count, 0);
      if (planks < 3) {
        const log = bot.inventory.items().find((i) => (LOG_TYPES as readonly string[]).includes(i.name));
        if (!log) return "Have wool but no planks/logs for a bed. Gather wood, then sleep.";
        await craftItem(bot, log.name.replace("_log", "_planks"), 1); // 1 craft = 4 planks
      }
      await craftItem(bot, woolColor.replace("_wool", "_bed"), 1);
      bedItem = bot.inventory.items().find((i) => i.name.includes("bed"));
      if (!bedItem) return "Bed crafting failed — need a crafting table nearby (or in inventory).";
      console.log(`[Skill] Crafted a ${bedItem.name} to sleep in`);
    }

    await bot.equip(bedItem, "hand");

    // Brute-force: try placing on ground blocks in a spiral around the bot
    const pos = bot.entity.position.floored();
    let placed = false;
    outer: for (let r = 1; r <= 4; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue; // Only ring
          for (let dy = -2; dy <= 2; dy++) {
            const ground = bot.blockAt(pos.offset(dx, dy - 1, dz));
            const above = bot.blockAt(pos.offset(dx, dy, dz));
            if (!ground || ground.name === "air" || ground.name.includes("leaves")) continue;
            if (!above || above.name !== "air") continue;
            // Check second bed block in any horizontal direction
            const dirs = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
            for (const d of dirs) {
              const g2 = bot.blockAt(ground.position.plus(d));
              const a2 = bot.blockAt(above.position.plus(d));
              // g2 must be solid ground (not air, not water, not leaves)
              if (!g2 || g2.name === "air" || g2.name === "water" || g2.name.includes("leaves")) continue;
              // a2 must be passable — air is ideal but short_grass/flowers are also fine (bed replaces them)
              if (!a2) continue;
              if (a2.name !== "air" && (a2.boundingBox === "block" || a2.name === "water" || a2.name === "lava"))
                continue;
              // Valid 2-block flat spot found — try placing
              try {
                await bot.lookAt(ground.position.offset(0.5, 1, 0.5));
                placed = await tryPlace(bot, ground, new Vec3(0, 1, 0));
                if (placed) break outer;
              } catch {
                /* next */
              }
            }
          }
        }
      }
    }

    if (!placed) return "Can't place bed here — terrain too rough. Explore to find flat open ground.";
    bed = bot.findBlock({ matching: (b) => b.name.endsWith("_bed"), maxDistance: 8 });
  }

  if (!bed) return "Bed disappeared after placing!";

  try {
    bot.pathfinder.setMovements(safeMoves(bot));
    // Time-budgeted walk, the mining-hike pattern: run 399 lost 65 sleep
    // attempts to "The goal was changed" — a mob flee killing the very
    // bed-walk that would skip the night that spawned the mob. Deaths hit
    // 20/hr (zombie-villager massacre) while sleeps failed all night. A
    // flee now pauses the walk; the bot resumes toward the bed until 75s
    // is spent or it arrives.
    const bedDeadline = Date.now() + 75_000;
    while (Date.now() < bedDeadline && bot.entity.position.distanceTo(bed.position) > 3) {
      try {
        await safeGoto(
          bot,
          new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2),
          Math.max(10_000, bedDeadline - Date.now()),
        );
      } catch {
        await new Promise((r) => setTimeout(r, 2000)); // let the flee finish
      }
    }
    await bot.sleep(bed);
    return "Sleeping... zzz";
  } catch (err: any) {
    if (err.message?.includes("not possible")) {
      return "Can't sleep — not nighttime yet.";
    }
    return `Sleep failed: ${err.message}`;
  }
}

async function placeBlock(bot: Bot, blockType: string): Promise<string> {
  if (!blockType) return "What block should I place? Specify blockType.";

  const item = bot.inventory.items().find((i) => i.name.includes(blockType));
  if (!item) return `No ${blockType} in inventory.`;

  // Do not build storage or workstations into the sky. Two fall records name
  // the footing directly -- on=chest at y=123 and on=crafting_table at y=119,
  // about 50 blocks above the base -- and the same session placed 10 chests and
  // 6 crafting tables while ascending to y=121-126 thirty-six times. A chest up
  // there is also the chest_unreachable that keeps bouncing deposits: storage
  // 50 blocks above the stash was never storage.
  const baseY = (bot as unknown as { swarmBaseY?: number }).swarmBaseY;
  const placeY = Math.floor(bot.entity.position.y);
  if (tooHighForFurniture(blockType, placeY, baseY)) {
    return furnitureRefusal(blockType, placeY, baseY!);
  }

  // Beds need special handling — use sleep action which auto-places
  if (item.name.includes("bed")) {
    return await sleepInBed(bot);
  }

  // Regular block placement — try multiple adjacent positions with fast timeout
  await bot.equip(item, "hand");
  const pos = bot.entity.position.floored();
  const faces = [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
    new Vec3(0, 1, 0),
    new Vec3(0, -1, 0),
  ];

  // Try up to 8 nearby positions
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        const airPos = pos.offset(dx, dy, dz);
        const airBlock = bot.blockAt(airPos);
        if (!airBlock || airBlock.name !== "air") continue;
        if (airPos.equals(pos) || airPos.equals(pos.offset(0, 1, 0))) continue;

        for (const face of faces) {
          const refPos = airPos.minus(face);
          const refBlock = bot.blockAt(refPos);
          if (!refBlock || refBlock.name === "air" || refBlock.name.includes("leaves")) continue;

          try {
            await bot.lookAt(refBlock.position.offset(0.5, 0.5, 0.5));
            const ok = await tryPlace(bot, refBlock, face);
            if (ok) return `Placed ${item.name}.`;
          } catch {
            /* try next */
          }
        }
      }
    }
  }
  return `Couldn't place ${item.name} — no valid spot nearby. Try moving first.`;
}
