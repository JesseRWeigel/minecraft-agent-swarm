import type { Bot } from "mineflayer";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import { Vec3 } from "vec3";
import { isHostile } from "./perception.js";
import { skillRegistry } from "../skills/registry.js";
import { runSkill } from "../skills/executor.js";
import { checkRetiredWithParole, getSkillStats } from "../skills/reliability.js";
import { getDynamicSkillNames } from "../skills/dynamic-loader.js";
import { runNeuralCombat } from "../neural/combat.js";
import { LOG_TYPES } from "../skills/materials.js";
import { depositStash, withdrawStash } from "../skills/stash.js";

import { safeMoves, explorerMoves, safeGoto, collectNearbyDrops } from "./navigation.js";
export { safeMoves, explorerMoves, safeGoto, collectNearbyDrops };

export async function executeAction(bot: Bot, action: string, params: Record<string, any>): Promise<string> {
  try {
    switch (action) {
      case "gather_wood":
        return await gatherWood(bot, params.count || 5);
      case "mine_block":
        return await mineBlock(bot, params.blockType || "stone", params.protectPos);
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
        return await placeBlock(bot, params.blockType);
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
        bot.chat(msg);
        return `Said: ${msg}`;
      }
      case "respond_to_chat": {
        const msg = typeof params.message === "string" ? params.message.trim() : "";
        if (!msg) return "respond_to_chat needs a 'message' param — nothing was said.";
        bot.chat(msg);
        return `Replied: ${msg}`;
      }
      case "generate_skill": {
        if (!params.task || !String(params.task).trim()) return "generate_skill needs a non-empty 'task' param.";
        const { generateSkill } = await import("../skills/generator.js");
        const name = await generateSkill(params.task as string);
        return `Generated skill '${name}'! I can now use it with invoke_skill.`;
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
        const skillResult = await runSkill(bot, skill, params);
        // Voyager-style refinement: a dynamic skill that failed with a CODE
        // error (not a precondition) gets its source + error fed back to the
        // LLM for a fix. Fire-and-forget — the bot keeps playing meanwhile.
        const looksLikeCodeBug =
          /is not a function|Cannot read|ReferenceError|TypeError|is not defined|timed out after/i.test(skillResult);
        const looksLikePrecondition = /need|missing|not enough|no trees|no water|gather|explore first/i.test(
          skillResult,
        );
        if (looksLikeCodeBug && !looksLikePrecondition && getDynamicSkillNames().includes(name)) {
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
        return await depositStash(bot, stashPos, keepItems ?? []);
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

async function gatherWood(bot: Bot, count: number): Promise<string> {
  // Use shared LOG_TYPES so pale_oak_log (MC 1.21.4) and future wood types are included
  const logTypes = LOG_TYPES as readonly string[];

  // Collect all nearby logs — use 256 block radius to find trees even after local depletion
  const allLogs = bot.findBlocks({
    matching: (block) => logTypes.includes(block.name),
    maxDistance: 256,
    count: 20,
  });

  if (allLogs.length === 0)
    return "No trees found within 256 blocks. Explore further south (toward Z=-100 or Z=0) to find an uncharted forest.";

  // If underground, surface first — explorerMoves can't dig through solid blocks
  if (bot.entity.position.y < 63) {
    const digMoves = new Movements(bot);
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
  for (const pos of allLogs) {
    if (gathered >= count) break;
    const log = bot.blockAt(pos);
    if (!log || !(logTypes as readonly string[]).includes(log.name)) continue;

    tried++;
    try {
      // explorerMoves allows swimming — essential when trees are across water
      bot.pathfinder.setMovements(explorerMoves(bot));
      // Increase think timeout for long-distance pathing around lakes (default 10s is too short)
      // Also delay stall detection by 32s to match — stall fires only AFTER bot starts moving
      const prevThinkTimeout = bot.pathfinder.thinkTimeout;
      bot.pathfinder.thinkTimeout = 30000;
      // Y-floor guard: if pathfinder dives below Y=60 (lake bed) stop navigation to prevent drowning
      const Y_FLOOR = 60;
      const yGuard = setInterval(() => {
        if (bot.entity.position.y < Y_FLOOR) {
          bot.pathfinder.stop();
        }
      }, 400);
      try {
        await safeGoto(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 3), 90000, 32000);
        await bot.dig(log);
        gathered++;
        // Walk over the drop — digging alone leaves the item on the ground
        await new Promise((r) => setTimeout(r, 400));
        await collectNearbyDrops(bot, 6, 6000);
      } finally {
        clearInterval(yGuard);
        bot.pathfinder.thinkTimeout = prevThinkTimeout;
      }
    } catch {
      // This log was unreachable — skip it and try the next one
    }
    if (tried >= 4 && gathered === 0) break; // give up after 4 failed attempts (360s max)
  }

  const collected = countLogsInInventory() - logsBefore;
  if (collected > 0) return `Gathered ${collected} logs. Inventory now has wood!`;
  if (gathered > 0)
    return `Chopped ${gathered} logs but couldn't pick up the drops — they may be stuck in leaves or a hole.`;
  return "Couldn't reach any trees within 128 blocks (pathfinding failed). Try exploring south toward Z=-200.";
}

async function mineBlock(
  bot: Bot,
  blockType: string,
  protectPos?: { x: number; y: number; z: number },
): Promise<string> {
  // Keep the village/stash site intact — bots kept strip-mining the base and
  // other bots fell into the pits and got stuck.
  const PROTECT_RADIUS = 12;
  const block = bot.findBlock({
    matching: (b) => b.name === blockType,
    maxDistance: 32,
    useExtraInfo: (b) => {
      if (!protectPos) return true;
      const dx = b.position.x - protectPos.x;
      const dz = b.position.z - protectPos.z;
      return dx * dx + dz * dz > PROTECT_RADIUS * PROTECT_RADIUS;
    },
  });

  if (!block)
    return protectPos
      ? `No ${blockType} found nearby (the ${PROTECT_RADIUS}-block zone around The Stash is protected — mine elsewhere).`
      : `No ${blockType} found nearby.`;

  // Allow digging so pathfinder can reach underground ores through stone
  const { Movements } = (await import("mineflayer-pathfinder")).default;
  const digMoves = new Movements(bot);
  digMoves.canDig = true;
  bot.pathfinder.setMovements(digMoves);
  await safeGoto(bot, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2));
  await bot.dig(block);
  // Walk over the drop — digging alone leaves the item on the ground
  await new Promise((r) => setTimeout(r, 400));
  await collectNearbyDrops(bot, 6, 5000);
  bot.pathfinder.setMovements(safeMoves(bot)); // restore safe moves
  return `Mined ${blockType}.`;
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
    const rescue = new Movements(bot);
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
      bot.pathfinder.setMovements(explorerMoves(bot));
      await safeGoto(bot, new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2), 30000);
    }
  }

  // Honest handoff: only toss when the target is actually here, and verify
  // the drops got picked up. The first version reported success while the
  // recipient walked away and the items rotted on the ground — Flora got
  // "given" 115 planks and received zero.
  const tgt = bot.players[to]?.entity;
  if (!tgt || bot.entity.position.distanceTo(tgt.position) > 4) {
    return `${to} moved away before the handoff — NOTHING was given. Get next to them and try again.`;
  }
  await bot.lookAt(tgt.position.offset(0, 1, 0));
  const toGive = Math.min(count, item.count);
  await bot.toss(item.type, null, toGive);
  await new Promise((r) => setTimeout(r, 2500)); // pickup time
  const leftovers = Object.values(bot.entities).filter(
    (e) => e.name === "item" && e.position.distanceTo(bot.entity.position) < 5,
  ).length;
  if (leftovers > 0) {
    return `Tossed ${toGive}x ${item.name} toward ${to} but items are still on the ground — delivery NOT confirmed. Tell them to pick the items up.`;
  }
  return `Gave ${toGive}x ${item.name} to ${to} — delivery confirmed.`;
}

async function explore(bot: Bot, direction: string): Promise<string> {
  const pos = bot.entity.position;

  // If in water, use pathfinder with free motion to navigate to surface/shore
  const currentBlock = bot.blockAt(pos);
  const headBlock = bot.blockAt(pos.offset(0, 1, 0));
  if (currentBlock?.name === "water" || headBlock?.name === "water") {
    console.log("[Explore] Bot is in water — attempting pathfinder escape");
    bot.pathfinder.setMovements(explorerMoves(bot));
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
    }
  }

  // If underground (below y=67), try to dig/climb to the surface before exploring laterally.
  if (bot.entity.position.y < 67) {
    const digMoves = new Movements(bot);
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
  let target: Vec3;

  switch (direction) {
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
  const startPos = bot.entity.position.clone();
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
    bot.chat(`/tp ${Math.round(target.x)} 80 ${Math.round(target.z)}`);
    await new Promise((r) => setTimeout(r, 3000)); // wait for TP + fall
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
      const needed = (allRecipes[0].ingredients ?? allRecipes[0].inShape?.flat() ?? [])
        .filter(Boolean)
        .map((ing: any) => {
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

async function eat(bot: Bot): Promise<string> {
  const foods = bot.inventory.items().filter((i) => {
    const foodItems = [
      "bread",
      "cooked_beef",
      "cooked_porkchop",
      "cooked_chicken",
      "cooked_mutton",
      "cooked_salmon",
      "cooked_cod",
      "baked_potato",
      "apple",
      "golden_apple",
      "carrot",
      "melon_slice",
      "sweet_berries",
      "cookie",
      "pumpkin_pie",
      "mushroom_stew",
      "beetroot_soup",
      "rabbit_stew",
      "cooked_rabbit",
    ];
    return foodItems.includes(i.name);
  });

  if (foods.length === 0) return "No food in inventory!";
  if (bot.food >= 20) return "Already full! Hunger: 20/20. Do something else.";

  await bot.equip(foods[0], "hand");
  await bot.consume();
  return `Ate ${foods[0].name}. Hunger: ${bot.food}/20`;
}

async function attackNearest(bot: Bot): Promise<string> {
  // Use same hostile detection as perception system
  let target = bot.nearestEntity((e) => isHostile(e) && e.position.distanceTo(bot.entity.position) < 16);

  if (!target) {
    // Try any living mob nearby (exclude players, dropped items, projectiles)
    target = bot.nearestEntity(
      (e) => e !== bot.entity && e.type === "mob" && e.position.distanceTo(bot.entity.position) < 8,
    );
    if (!target) return "No mobs to attack nearby.";
  }

  const targetName = target.name || (target as any).mobType || "entity";

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
        // Stop if target is dead/removed or too far away
        if (!target!.isValid || target!.position.distanceTo(bot.entity.position) > 20) {
          kills++;
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
      return `Defeated ${targetName} using advanced combat!`;
    }
    return `Fought ${targetName} for ${((Date.now() - combatStart) / 1000).toFixed(1)}s (still alive — may need to re-engage).`;
  }

  // Fallback: bare mineflayer attack if swordpvp somehow not loaded
  await bot.lookAt(target.position.offset(0, (target as any).height ?? 1.6, 0));
  bot.attack(target);
  return `Attacked ${targetName} (basic hit).`;
}

async function flee(bot: Bot): Promise<string> {
  // Use same hostile detection as perception system
  const hostile = bot.nearestEntity((e) => isHostile(e) && e.position.distanceTo(bot.entity.position) < 16);

  if (!hostile) {
    // No hostile found — just move somewhere random to break the loop
    const pos = bot.entity.position;
    const angle = Math.random() * Math.PI * 2;
    const target = pos.offset(Math.cos(angle) * 15, 0, Math.sin(angle) * 15);
    bot.pathfinder.setMovements(safeMoves(bot));
    await safeGoto(bot, new goals.GoalNear(target.x, target.y, target.z, 5), 8000);
    return "Ran in a random direction — nothing visible to flee from.";
  }

  // Run in the opposite direction
  const dir = bot.entity.position.minus(hostile.position).normalize();
  const target = bot.entity.position.plus(dir.scaled(20));

  bot.pathfinder.setMovements(safeMoves(bot));
  await safeGoto(bot, new goals.GoalNear(target.x, target.y, target.z, 5), 8000);
  return `Fled from ${hostile.name || hostile.mobType}!`;
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

  let bed = bot.findBlock({
    matching: (b) => b.name.includes("bed"),
    maxDistance: 32,
  });

  // Auto-place bed from inventory if none found nearby
  if (!bed) {
    const bedItem = bot.inventory.items().find((i) => i.name.includes("bed"));
    if (!bedItem) return "No bed in inventory. Craft or find one.";

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
    bed = bot.findBlock({ matching: (b) => b.name.includes("bed"), maxDistance: 8 });
  }

  if (!bed) return "Bed disappeared after placing!";

  try {
    bot.pathfinder.setMovements(safeMoves(bot));
    await safeGoto(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), 8000);
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
