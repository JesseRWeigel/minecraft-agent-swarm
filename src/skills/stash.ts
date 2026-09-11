// src/skills/stash.ts
// Shared stash management — deposit/withdraw from categorised chests.

import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { snapshotChest } from "./stash-ledger.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { safeGoto } from "../bot/actions.js";
import { baseMoves, safeMoves, isPreciousBlock } from "../bot/navigation.js";

/** bot.openContainer with a hard timeout — a chest GUI that never opens (block
 *  not truly reachable/loaded) otherwise blocks forever, hanging the calling
 *  skill to the 240s watchdog. Fail fast (10s) so the skill recovers. */
/** Server-enforced interaction range for digging and opening containers.
 *  Used to decide whether a bot can act on a chest the pathfinder failed to
 *  route to — the observed failures sat at dist 0.6-2.5, comfortably inside it. */
export const INTERACT_REACH = 4.5;

export function withinReach(dist: number): boolean {
  return Number.isFinite(dist) && dist <= INTERACT_REACH;
}

/** How far away a chest may be and still be worth tunnelling to. */
export const DIG_APPROACH_MAX = 16;

/** How many chests to try per category before giving up on the load.
 *
 *  findBlock returns only the nearest, and when that one is walled in the whole
 *  category was abandoned. Measured over one session: three distinct chests were
 *  ever targeted, one absorbed 64 consecutive failures, and the stash holds
 *  hundreds. Four keeps the walk bounded while making a single buried chest stop
 *  being fatal. */
export const CHEST_CANDIDATES = 4;

/** Should a failed walk to a chest be retried with a digging movement config?
 *
 *  The bots walled in their own stash. Measured over 340 attributed deposit
 *  failures, every one of them chest_unreachable:
 *
 *    above=chest   168   chests stacked directly on other chests
 *    "No path to the goal!"  203   A* found no route at all, not a timeout
 *    give-up distance  5.5 to 7.6 blocks
 *
 *  The surrounding blocks are oak_planks, oak_stairs and cobblestone, which are
 *  the bots' own placements. safeMoves sets canDig=false, so a bot standing six
 *  blocks from its chest with a plank wall between them has no route and no way
 *  to make one. Only 16 deposits succeeded against those 340 failures.
 *
 *  Digging the last few blocks is already precedent in this file (the stash
 *  approach dig-retry) and is safe for storage: mineflayer-pathfinder's
 *  blocksCantBreak includes chests by default, so a digging config routes
 *  around them rather than through them.
 *
 *  Bounded by distance so a failed path never becomes a cross-map tunnel. */
export function shouldDigToChest(distToChest: number, navFailed: boolean, dy = 0): boolean {
  if (!navFailed) return false;
  if (!Number.isFinite(distToChest)) return false;
  // Already close enough to open it — digging would be pointless and destructive.
  if (withinReach(distToChest)) return false;
  // Sideways only. The stash sprawls from y64 to y76, and digging toward a
  // chest a level up or down carved the village into a honeycomb of pits
  // the bots then fell into (27 dig events in one run; Blade in a cave at
  // y64 under the chest floor). A chest on another level is skipped.
  if (Math.abs(dy) > 1) return false;
  return distToChest <= DIG_APPROACH_MAX;
}

/** Which held tool breaks this block fastest, if the bot has one.
 *
 *  Deliberately tiny: the only blocks this has to handle are what bots stack on
 *  their own stash — cobblestone, planks, stairs, dirt. Returns the best material
 *  available rather than the best that exists, so a bot with only a wooden
 *  pickaxe still gets it equipped. */
const TOOL_MATERIALS = ["netherite", "diamond", "iron", "stone", "golden", "wooden"];

export function bestToolFor(blockName: string, inventory: string[]): string | null {
  const kind = /(stone|cobble|ore|brick|concrete|deepslate|tuff|andesite|diorite|granite|furnace)/.test(blockName)
    ? "pickaxe"
    : /(log|planks|stairs|fence|door|wood|plank)/.test(blockName)
      ? "axe"
      : /(dirt|sand|gravel|grass_block|clay|soul)/.test(blockName)
        ? "shovel"
        : null;
  if (!kind) return null;
  for (const mat of TOOL_MATERIALS) {
    const want = `${mat}_${kind}`;
    if (inventory.includes(want)) return want;
  }
  return null;
}

/** Break the one block sitting on a chest so it can be opened.
 *
 *  Called BEFORE opening rather than after a failure: an obstructed chest costs a
 *  full 10s openContainer timeout to discover, and with several categories per
 *  deposit that alone approached the action watchdog. Checking a single block is
 *  free by comparison.
 *
 *  Deliberately narrow — only the block directly above, only when it is safe to
 *  break, and no retry. This gives the bots the capability to unseal storage they
 *  built over themselves; it is not a general excavation licence. */
async function clearChestRoof(bot: Bot, chestPos: Vec3): Promise<boolean> {
  const above = bot.blockAt(chestPos.offset(0, 1, 0));
  if (!above || !canClearObstruction(above.name)) return false;
  // Hand-breaking cobblestone takes ~11s, which would just relocate the stall
  // that this whole change exists to remove. mineflayer-tool is not loaded on
  // this bot, so pick the tool directly.
  const tool = bestToolFor(
    above.name,
    bot.inventory.items().map((i) => i.name),
  );
  if (tool) {
    const held = bot.inventory.items().find((i) => i.name === tool);
    if (held) {
      try {
        await bot.equip(held, "hand");
      } catch {
        /* equip races the deposit loop occasionally — digging by hand still works */
      }
    }
  }
  try {
    await bot.dig(above);
    console.log(`[Stash] Cleared ${above.name} off the chest at ${chestPos}`);
    return true;
  } catch (err) {
    console.log(`[Stash] Could not clear ${above.name} off chest at ${chestPos}: ${(err as Error).message}`);
    return false;
  }
}

async function openContainerTimed(bot: Bot, block: Parameters<Bot["openContainer"]>[0]) {
  return (await Promise.race([
    bot.openContainer(block),
    new Promise((_, rej) => setTimeout(() => rej(new Error("openContainer timeout")), 10000)),
  ])) as Awaited<ReturnType<Bot["openContainer"]>>;
}

/** Stash row categories and their item patterns. Order matches physical chest rows. */
const STASH_ROWS: { category: string; patterns: string[] }[] = [
  {
    category: "building",
    patterns: [
      "log",
      "planks",
      "cobblestone",
      "stone",
      "deepslate",
      "glass",
      "sand",
      "sandstone",
      "brick",
      "terracotta",
      "concrete",
      "gravel",
      "dirt",
    ],
  },
  {
    category: "metals",
    patterns: [
      "raw_iron",
      "iron_ingot",
      "iron_nugget",
      "raw_copper",
      "copper_ingot",
      "raw_gold",
      "gold_ingot",
      "gold_nugget",
      "coal",
      "diamond",
      "emerald",
      "lapis",
      "redstone",
      "quartz",
      "netherite",
      "amethyst",
    ],
  },
  {
    category: "food",
    patterns: [
      "wheat",
      "seed",
      "bread",
      "carrot",
      "potato",
      "beetroot",
      "melon",
      "pumpkin",
      "apple",
      "porkchop",
      "beef",
      "chicken",
      "mutton",
      "cod",
      "salmon",
      "rabbit",
      "stew",
      "cookie",
      "cake",
      "pie",
      "sugar",
      "egg",
      "cocoa",
      "mushroom",
      "kelp",
      "sweet_berries",
    ],
  },
  {
    category: "tools",
    patterns: [
      "sword",
      "pickaxe",
      "axe",
      "shovel",
      "hoe",
      "bow",
      "crossbow",
      "arrow",
      "shield",
      "helmet",
      "chestplate",
      "leggings",
      "boots",
      "fishing_rod",
      "shears",
      "flint_and_steel",
      "compass",
      "clock",
      "spyglass",
      "trident",
    ],
  },
];

/** Why a category's items could not be banked.
 *
 *  depositStash abandons a category at three unrelated points: the stash has no
 *  chest serving that row, the bot cannot walk to a chest it did find, or the
 *  chest GUI never opens. All three incremented one `noChest` counter and printed
 *  one message, so "No reachable chest" meant any of them. That message fired 596
 *  times in a 10h session — more than double the successful deposits — with no way
 *  to tell which cause dominated, and `openContainer timeout` never appeared in the
 *  log at all because the catch swallowed it.
 *
 *  This is the same silent-catch trap documented for the expansion gates below,
 *  which cost three rounds of guesswork before the gates were labelled. Label the
 *  cause where it happens so the fix targets the one that is actually firing. */
export type DepositFailure = "no_chest_found" | "chest_unreachable" | "chest_open_failed" | "chest_full";

const FAILURE_WORDING: Record<DepositFailure, string> = {
  no_chest_found: "no chest serves that category",
  chest_unreachable: "couldn't walk to the chest",
  chest_open_failed: "the chest wouldn't open",
  chest_full: "every chest tried was full",
};

/** Does this block, sitting directly on top of a chest, stop the chest opening?
 *
 *  Minecraft refuses to open a chest with an opaque block above it. Measured over
 *  78 attributed deposit failures: 47 had cobblestone above, 30 oak_planks, and
 *  exactly 1 had air. The bots had built over their own stash (oak_stairs and
 *  oak_fence show up in the side neighbours), sealing the chests they then could
 *  not deposit into. One obstruction produced both attributed causes — the GUI
 *  never opens, and a buried chest has no standable neighbour to path to.
 *
 *  Non-solid blocks are listed rather than derived because minecraft-data's
 *  boundingBox is not loaded on this path, and the list only has to cover what
 *  actually lands on a chest. Anything unknown is treated as obstructing, which
 *  errs toward clearing rather than toward another silent 10s timeout. */
const NON_OBSTRUCTING = [
  "air",
  "water",
  "torch",
  "lantern",
  "rail",
  "carpet",
  "pressure_plate",
  "button",
  "sign",
  "banner",
  "vine",
  "ladder",
  "tripwire",
  "redstone_wire",
  "repeater",
  "comparator",
  "short_grass",
  "tall_grass",
  "fern",
  "dead_bush",
  "sapling",
  "poppy",
  "dandelion",
  "wheat",
];

/** Match on name tokens, not substrings. `oak_stairs` contains "air", so a plain
 *  includes() classified a stairs block as open sky and skipped the dig — caught
 *  by the test below before it shipped. Bare "grass" and "snow" are absent for the
 *  same reason: they would swallow the solid grass_block and snow_block. */
function hasToken(name: string, token: string): boolean {
  return name === token || name.startsWith(`${token}_`) || name.endsWith(`_${token}`) || name.includes(`_${token}_`);
}

export function obstructsChest(blockName: string | undefined | null): boolean {
  if (!blockName) return false; // unloaded chunk — nothing to act on
  return !NON_OBSTRUCTING.some((n) => hasToken(blockName, n));
}

/** Safe to break to free a chest? Never trade a chest, furnace or bed for a
 *  deposit — the drowning dig-out already learned that lesson by destroying team
 *  storage to save one bot. */
export function canClearObstruction(blockName: string | undefined | null): boolean {
  return obstructsChest(blockName) && !isPreciousBlock(blockName!);
}

/** What to say when a bot walked to the stash and banked nothing, with no
 *  failure to report.
 *
 *  "Deposited 0 items at the stash." fired 132 times in under two hours and reads
 *  as success, so the brain banked nothing, believed it had, and chose
 *  deposit_stash again — 83 invocations to move 20 items. It happens when
 *  everything carried passes shouldKeep: the category map comes out empty, the
 *  deposit loop never runs, and the function falls through to its success string.
 *
 *  The explore action already carries this exact lesson (actions.ts): a false
 *  success the LLM believes is worse than a blunt failure, because it re-plans
 *  straight back into the same dead end. Say what is actually being held and
 *  point somewhere else. */
export function nothingToBankMessage(keptNames: string[]): string {
  const unique = [...new Set(keptNames)];
  const held = unique.length ? unique.slice(0, 4).join(", ") + (unique.length > 4 ? ", ..." : "") : "nothing";
  return (
    `Banked nothing — everything I'm carrying (${held}) is gear or food I'm keeping. ` +
    `Don't return to the stash until I've gathered something worth banking: mine, chop wood, or explore.`
  );
}

/** Should a bounced deposit try to place another chest?
 *
 *  Only when a category had NO chest at all. Measured over 38 attributed failures:
 *  no_chest_found was 0, every chest was located at rowGap 0.0-1.4 (exactly its
 *  expected row), and the deposits still bounced — 20 because the pathfinder could
 *  not reach a chest 1-2 blocks away, 18 because openContainer timed out at
 *  dist 0.6-2.5, point blank and well inside the ~4.5 reach.
 *
 *  Expansion fired 18 times anyway, because it keyed off the merged counter. It
 *  cannot possibly help: adding a chest does not make an existing, located,
 *  adjacent chest open. Each attempt also burns a 45s placement budget the bot
 *  could spend gathering, and the resulting "all placement attempts failed" is
 *  what sent seven earlier hypotheses chasing chest supply that was never short. */
export function shouldAttemptExpansion(failures: Map<DepositFailure, number>): boolean {
  // A full chest is the other condition a NEW chest genuinely fixes. Blade
  // stood at the stash with 148 andesite + 132 diorite aboard, the one chest
  // his category resolved to was full, and the load came home — misreported
  // as "everything I'm carrying is kept" (RCON census cycle 187).
  return (failures.get("no_chest_found") ?? 0) > 0 || (failures.get("chest_full") ?? 0) > 0;
}

/**
 * What the bot should DO about a bounced deposit, keyed on the dominant cause.
 *
 * shouldAttemptExpansion above was corrected to fire only on no_chest_found,
 * because adding a chest cannot make an existing, located, adjacent chest open.
 * That reasoning was never applied to the message, which suggested expanding for
 * all three causes off the same merged counter — and the brain reads the message,
 * not the gate. One 1h49m session logged the expand hint 86 times and crafted 30
 * chests, its largest craft, while 34 iron ore went unsmelted.
 *
 * It compounds: unreachable chests read as "full", the brain adds chests, the
 * maze gets denser, more chests fall out of reach. That maze is also what
 * drowned Mason under a ceiling the escape was forbidden to dig.
 */
export function depositFailureAdvice(failures: Map<DepositFailure, number>): string {
  const ranked = [...failures.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const dominant = ranked[0]?.[0];
  if (!dominant) return "";

  // Only a genuinely missing chest is fixed by another chest.
  if (dominant === "no_chest_found") {
    return "No chest serves that category — craft a chest and place it by the stash.";
  }
  if (dominant === "chest_full") {
    return "The chests this load reached are full — a NEW chest is needed; carry planks or a chest on the next trip.";
  }
  return (
    "The chest exists and was found, so more chests will not help — do NOT craft one. " +
    "It is blocked: clear the space around it or walk to a different chest."
  );
}

/** Render per-cause item tallies as one clause, dominant cause first. Pure so the
 *  wording can be tested without a live world. */
export function summarizeDepositFailure(failures: Map<DepositFailure, number>): string {
  const ranked = [...failures.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked.map(([reason, n]) => `${n} ${FAILURE_WORDING[reason]}`).join(", ");
}

/** Determine which stash category an item belongs to. Returns "overflow" if no match. */
export function categorizeItem(itemName: string): string {
  for (const row of STASH_ROWS) {
    if (row.patterns.some((p) => itemName.includes(p))) {
      return row.category;
    }
  }
  return "overflow";
}

/** Get the chest offset for a category (row index along X axis, 2 blocks per row for double chests). */
export function getRowOffset(category: string): number {
  const idx = STASH_ROWS.findIndex((r) => r.category === category);
  return idx >= 0 ? idx * 2 : STASH_ROWS.length * 2; // overflow goes after last row
}

/** Check if an item should be kept based on the bot's keepItems config. */
/** Iron/gold/diamond a bot holds back for its own crafting before pooling the
 *  rest. 8 = one iron chestplate, the most expensive single piece. */
export const KEEP_MATERIAL_RESERVE = 8;

export function shouldKeep(
  itemName: string,
  keepItems: { name: string; minCount: number }[],
  currentCounts: Map<string, number>,
  /** How many items are in this stack. Defaults to 1 so callers that only know
   *  the name still behave as before. */
  itemCount = 1,
  /** Ingot/diamond pocket reserve. The default assumes the bot can craft with
   *  what it keeps; pass 0 for bots with no craft action or craft_gear skill —
   *  Atlas carried 9 iron ingots for a day under the default reserve while
   *  Forge sat at 2 of the 3 ingots the iron pickaxe needed. */
  materialReserve = KEEP_MATERIAL_RESERVE,
  /** Which pickaxe (if any) this bot should keep. undefined = legacy "keep
   *  the first pickaxe seen", which is how the team's ONLY iron pickaxe got
   *  banked from behind a stone pick in slot order and ended up stranded on
   *  Blade, a bot with no mining ability (run 374). Pass the bot's best
   *  pickaxe name to keep exactly that one, or null to bank them all. */
  pickaxeKeep?: string | null,
  /** Food items to hold before banking the rest. 6 by default; a farmer
   *  fresh from baking passes 2 so the loaves reach the bots that cannot
   *  bake (five loaves an hour were being eaten by the bakers alone). */
  foodKeep = 6,
): boolean {
  // Explicit pickaxe policy trumps every blanket rule below, including the
  // always-keep-iron-gear one — that blanket is what stranded the team's only
  // iron pickaxe on a bot that cannot mine.
  if (pickaxeKeep !== undefined && itemName.endsWith("_pickaxe")) {
    if (pickaxeKeep === null || itemName !== pickaxeKeep) return false;
    const kept = currentCounts.get("__pickaxe") ?? 0;
    if (kept >= 1) return false;
    currentCounts.set("__pickaxe", 1);
    return true;
  }

  // ALWAYS keep valuable gear. Bots crafted iron tools (12 in one run) then
  // deposited them as "surplus" and re-ground iron forever, never advancing.
  // A bot should never give up its iron/diamond/netherite tools or armor.
  const GEAR = ["_pickaxe", "_axe", "_sword", "_shovel", "_hoe", "_helmet", "_chestplate", "_leggings", "_boots"];
  const ARMOUR_SLOTS = ["_helmet", "_chestplate", "_leggings", "_boots"];
  if (
    (itemName.startsWith("iron_") || itemName.startsWith("diamond_") || itemName.startsWith("netherite_")) &&
    GEAR.some((g) => itemName.includes(g))
  ) {
    // Keep ONE per armour slot, bank the rest.
    //
    // This kept every piece unconditionally, duplicates included. Now that the
    // crafters actually produce full sets, the spares pile up in their packs and
    // the stash holds no armour at all: measured 0 armour withdrawals in a
    // session where Blade tried withdraw_stash 31 times.
    //
    // Blade is the swarm's fighter. His role has attack but NOT craft and NOT
    // mine_block, so he cannot make armour and cannot mine the iron for it. The
    // stash is his only route to a chestplate, and the crafters were hoarding
    // the spares. He died 15 times in one hour, every single one "slain by"
    // with Armor: -,-,-,- and all of it within four blocks of the stash.
    //
    // One per slot is the same rule this function already applies to pickaxes
    // and axes below, for the same reason: a bot needs one, not a collection.
    const slot = ARMOUR_SLOTS.find((a) => itemName.includes(a));
    if (slot) {
      const kept = currentCounts.get(`__armour${slot}`) ?? 0;
      if (kept >= 1) return false; // spare — let the fighter have it
      currentCounts.set(`__armour${slot}`, 1);
      return true;
    }
    return true;
  }
  if (itemName === "shield") return true;

  // The Nether kit: ONE bucket (any fill state) and ONE igniter stay with the
  // bot. Neither had a keep rule, so every deposit_stash trip donated them to
  // the chest — the portal then failed "missing bucket, flint_and_steel" and
  // the bot went back to re-grinding four iron for a kit it already owned.
  // keepInventory means deaths never took them; the stash did.
  if (itemName === "bucket" || itemName === "water_bucket" || itemName === "lava_bucket") {
    const kept = currentCounts.get("__bucket") ?? 0;
    if (kept >= 1) return false;
    currentCounts.set("__bucket", 1);
    return true;
  }
  if (itemName === "flint_and_steel") {
    const kept = currentCounts.get("__igniter") ?? 0;
    if (kept >= 1) return false;
    currentCounts.set("__igniter", 1);
    return true;
  }

  // Never deposit your ONLY tools. shouldKeep protected iron+ gear only, so
  // wooden/stone pickaxes were dumped as junk on every stash trip — craft_gear
  // made wooden_pickaxe repeatedly (4 successes in run 127) and every one
  // vanished into the stash, so nobody could ever mine iron. Keep ONE pickaxe
  // and ONE axe of ANY tier.
  if (itemName.endsWith("_pickaxe")) {
    const kept = currentCounts.get("__pickaxe") ?? 0;
    if (kept < 1) {
      currentCounts.set("__pickaxe", 1);
      return true;
    }
  }
  if (itemName.endsWith("_axe") && !itemName.endsWith("_pickaxe")) {
    const kept = currentCounts.get("__axe") ?? 0;
    if (kept < 1) {
      currentCounts.set("__axe", 1);
      return true;
    }
  }

  // Keep precious crafting materials in inventory. Bots deposited every iron
  // ingot the instant they smelted it (314 deposits/run, empty inventories), so
  // they never accumulated the 3+ ingots needed in-hand to craft an iron tool.
  // Hold onto these so the smelter can actually craft — surplus is fine, the
  // bots' inventories are nearly empty anyway.
  // ...but CAP it. This returned true unconditionally, the only unbounded
  // reserve in the function — food is capped at 6, wheat at 2, tools at one
  // each, role items at minCount. Iron therefore never reached the stash at all,
  // which is why withdraw_stash logged "No iron_ingot in the stash" 245 times in
  // one session while bots walked around carrying raw_iron and iron_ingot, why
  // craft_gear attempted only tools and never armour across 26 runs, and why
  // 22 of 33 deaths were unarmoured. The supply was never missing; it was
  // stranded in five separate pockets.
  //
  // KEEP_MATERIAL_RESERVE is 8 because that is an iron chestplate, the most
  // expensive single piece. A bot holding that much can still craft anything on
  // its own; beyond it, the team is better served by pooling.
  // SMELTED forms only. Raw ore is deliberately absent.
  //
  // raw_iron cannot be crafted into anything: it has to be smelted first, and
  // the smelter is usually a different bot, so the stash is the hand-off. A
  // miner holding raw ore under this reserve blocks the whole chain.
  //
  // Measured in one 2h42m session: 20 iron ore mined, ZERO raw_iron reaching
  // the stash, smelt_ores reporting "Nothing to smelt! Mine some ore first" 27
  // times, craft_gear seeing 0-2 ingots on every run, zero armour crafted, and
  // 13 of 18 deaths with no armour at all. Every link was working except this
  // one, which quietly held the input in the wrong bot's pocket.
  // Diamonds get their OWN reserve, never the shared ingot pool. Forge's
  // mining fills the 8-material reserve with iron and gold, so his diamonds
  // leaked to the stash and no crafter ever held the 5 that the diamond pick
  // (3) plus the enchanting table (2) need — the whole Enchanter chain stalled
  // at 0 held. Hold up to 5 diamonds so they accumulate toward both.
  // Obsidian: keep up to 4 in pocket — the enchanting table's exact cost.
  // It had no keep rule, so the pre-dive deposit stripped the 4 blocks
  // setup_enchanting had just mined from the deep frames, and the skill spent
  // the next hour commuting back to re-mine what it already owned.
  if (itemName === "obsidian") {
    const kept = currentCounts.get("__obsidian") ?? 0;
    if (kept < 4) {
      currentCounts.set("__obsidian", kept + itemCount);
      return true;
    }
    return false;
  }
  // A bed is 3 wool, and the sleep action crafts one all by itself — but only
  // from POCKET wool. Without a floor, the wool Flora withdraws for tonight's
  // bed boomerangs into a chest on her next deposit before dusk.
  if (itemName === "white_wool") {
    const kept = currentCounts.get("__white_wool") ?? 0;
    if (kept < 3) {
      currentCounts.set("__white_wool", kept + itemCount);
      return true;
    }
    return false;
  }

  if (itemName === "diamond") {
    // The 5-diamond pocket reserve is for the bot that can SPEND them — the
    // primary smith (materialReserve > 0). Everyone else banks every diamond:
    // pick-crafting is smith-only, so 5 diamonds parked in a non-smith's
    // pocket are dead capital the endgame cannot see.
    if (materialReserve === 0) return false;
    const kept = currentCounts.get("__diamond") ?? 0;
    if (kept < 5) {
      currentCounts.set("__diamond", kept + itemCount);
      return true;
    }
    return false;
  }

  // Iron gets its own reserve, never shared with gold. Iron is the tool
  // material — every pickaxe, and diamond ore only drops for an iron+ pick —
  // and a crafter-miner burns ~one iron pick per diamond dive. When gold
  // (from bartering runs and deep veins) crowded the shared reserve, Forge's
  // iron leaked to the stash, he dived on a worn pick that broke into stone,
  // and could not mine the diamond ore he was standing in. Holding the full
  // reserve (8) covers two picks (6) with room to spare, so a dive can carry
  // a spare and still have iron for repairs.
  if (itemName === "iron_ingot") {
    const kept = currentCounts.get("__iron") ?? 0;
    if (kept < materialReserve) {
      currentCounts.set("__iron", kept + itemCount);
      return true;
    }
    return false;
  }

  // Copper ingots: keep them IN POCKET, do not bank them. The miners pull
  // copper in quantity at the shallow band (22 raw smelted in one session),
  // but copper_ingot has no keep rule, so deposit_stash donates every one to
  // the 87-chest junk pile where it is lost — and wax_on needs a full copper
  // block (9 ingots) held to craft. 12 covers the block plus a margin. Copper
  // is used for nothing else, so a held stack is pure progress, never dead
  // weight. (Raw copper stays banked for the smelter hand-off, like other raw
  // ore; it is the smelted ingot that must survive to reach the crafting.)
  if (itemName === "copper_ingot") {
    const kept = currentCounts.get("__copper") ?? 0;
    if (kept < 12) {
      currentCounts.set("__copper", kept + itemCount);
      return true;
    }
    return false;
  }

  // Wax On kit: a crafted copper block, the shears, a harvested honeycomb and
  // a campfire are single-purpose progress items; banking them to the junk
  // pile (or shedding them) has cost the chain twice. Always keep them.
  if (itemName === "copper_block" || itemName === "honeycomb" || itemName === "shears" || itemName === "campfire") {
    return true;
  }

  const KEEP_MATERIALS = ["gold_ingot"];
  if (KEEP_MATERIALS.includes(itemName)) {
    // An explicit keepItems entry OUTRANKS the generic material reserve.
    // Blade's hand-delivered piglin payroll (9 ingots) was stripped by
    // materialReserve=0 right here, one rule before the keepItems loop
    // below would have protected it.
    const explicit = keepItems.find((k) => itemName.includes(k.name));
    const floor = Math.max(materialReserve, explicit?.minCount ?? 0);
    const kept = currentCounts.get("__materials") ?? 0;
    if (kept < floor) {
      currentCounts.set("__materials", kept + itemCount);
      return true;
    }
    return false;
  }

  // Crafting floor: keep a few planks and sticks IN POCKET, always. Bots
  // banked every scrap of wood, then stranded themselves — craft_gear found a
  // stone-pick recipe with 30 cobble aboard and could not use it because the
  // nearby table was walled off and placing a fresh one needs 4 planks the bot
  // had just deposited (GearDebug: planks=0, "No new tools crafted" while
  // materials sat everywhere). Eight planks = a table plus a stick batch;
  // eight sticks covers two tools. Any *_planks counts toward the one floor.
  if (itemName.endsWith("_planks")) {
    const kept = currentCounts.get("__planks") ?? 0;
    if (kept < 8) {
      currentCounts.set("__planks", kept + itemCount);
      return true;
    }
    return false;
  }
  if (itemName === "stick") {
    const kept = currentCounts.get("__sticks") ?? 0;
    if (kept < 8) {
      currentCounts.set("__sticks", kept + itemCount);
      return true;
    }
    return false;
  }

  // Seeds: always keep (needed to replant).
  if (itemName === "wheat_seeds") return true;
  // Wheat: keep only a tiny reserve, DEPOSIT the surplus so it POOLS in the
  // stash. Keeping all wheat (prior fix) backfired — harvests stayed scattered
  // across bots in sub-3 amounts, so no baker ever reached 3 and bread never
  // baked (81 wheat/run -> 4 bread, team starved). Pooling + build_farm's
  // stash-withdraw bake step turns the team's wheat into real bread batches.
  if (itemName === "wheat") {
    const kept = currentCounts.get("__wheat") ?? 0;
    if (kept < 2) {
      currentCounts.set("__wheat", kept + 1);
      return true;
    }
    return false;
  }

  // Keep a PERSONAL FOOD BUFFER. Bots deposited every scrap of food the instant
  // they got it (314 deposits/run) and then starved between production cycles —
  // a starving worker (esp. the miner) burns all its turns failing to eat
  // instead of working. Hold up to KEEP_FOOD food stacks; surplus still goes to
  // the stash for the team.
  const FOOD = new Set([
    "bread",
    "cooked_beef",
    "cooked_porkchop",
    "cooked_mutton",
    "cooked_chicken",
    "cooked_cod",
    "cooked_salmon",
    "cooked_rabbit",
    "baked_potato",
    "apple",
    "golden_apple",
    "carrot",
    "melon_slice",
    "mushroom_stew",
    "rabbit_stew",
    "beetroot_soup",
    // Raw meats — real Minecraft ids have NO raw_ prefix (that's only ores).
    // The old raw_beef/raw_mutton/... names matched nothing, so raw meat never
    // counted toward the food buffer and bots deposited ALL their meat.
    "beef",
    "porkchop",
    "mutton",
    "chicken",
    "cod",
    "salmon",
    "rabbit",
  ]);
  if (FOOD.has(itemName)) {
    const KEEP_FOOD = foodKeep;
    const kept = currentCounts.get("__food") ?? 0;
    if (kept < KEEP_FOOD) {
      currentCounts.set("__food", kept + 1);
      return true;
    }
    return false;
  }

  // minCount is a count of ITEMS, not of inventory slots. This loop used to add
  // 1 per stack, so { sapling, minCount: 16 } meant "keep the first 16 sapling
  // STACKS" — up to 1,024 saplings, more than an inventory holds. A bot carrying
  // three stacks of saplings kept all three and reported "Banked nothing", which
  // was the dominant deposit outcome at 240 against 10 successes.
  //
  // Counting the stack size means the reserve fills on the first stack and the
  // surplus goes to the team. It over-keeps within a single stack (64 saplings
  // to satisfy a reserve of 16) because a boolean cannot split one; that is a
  // rounding error next to hoarding sixteen stacks.
  //
  // Only this loop changed. The food and wheat reserves above deliberately count
  // stacks — food is a survival buffer where under-keeping starves the miner,
  // and the wheat reserve of 2 exists so harvests pool in the stash for baking.
  for (const keep of keepItems) {
    if (itemName.includes(keep.name)) {
      const kept = currentCounts.get(keep.name) ?? 0;
      if (kept < keep.minCount) {
        currentCounts.set(keep.name, kept + itemCount);
        return true;
      }
    }
  }
  return false;
}

export { STASH_ROWS };

/**
 * Walk to stash, find the correct category chest for each item, deposit.
 * Keeps items on the bot's keepItems list.
 */
export async function depositStash(
  bot: Bot,
  stashPos: { x: number; y: number; z: number },
  keepItems: { name: string; minCount: number }[],
  /** See shouldKeep: 0 for bots that cannot craft, so their ingots pool. */
  materialReserve = KEEP_MATERIAL_RESERVE,
  /** Whether this bot can mine (mine_block action or strip_mine skill).
   *  Non-miners bank every pickaxe; miners keep only their best one. */
  canMine = true,
  /** See shouldKeep: food items to hold back from the bank. */
  foodKeep = 6,
): Promise<string> {
  const PICK_RANK: Record<string, number> = {
    wooden_pickaxe: 0,
    golden_pickaxe: 1,
    stone_pickaxe: 1,
    iron_pickaxe: 2,
    diamond_pickaxe: 3,
    netherite_pickaxe: 4,
  };
  const bestPick = bot.inventory
    .items()
    .filter((i) => i.name.endsWith("_pickaxe"))
    .sort((a, b) => (PICK_RANK[b.name] ?? 0) - (PICK_RANK[a.name] ?? 0))[0];
  const pickaxeKeep: string | null = canMine && bestPick ? bestPick.name : null;
  // Walk to stash area
  const startPos = bot.entity.position.clone();
  await safeGoto(bot, new goals.GoalNear(stashPos.x, stashPos.y, stashPos.z, 3), 30000);
  const movedDist = bot.entity.position.distanceTo(startPos);

  // Fail fast if we never actually reached the stash (underground / blocked /
  // being chased). safeGoto returns after its 30s timeout WITHOUT throwing, so
  // otherwise every downstream op — per-chest gotos + the 6-type food top-up
  // loop, each a fresh withdrawStash with its own 30s goto — retries the same
  // unreachable spot and their timeouts sum past the 150s action watchdog. This
  // caused 16 deposit_stash hangs in 9 min when the team was stuck underground.
  let distToStash = bot.entity.position.distanceTo(new Vec3(stashPos.x, stashPos.y, stashPos.z));

  // The stash sits underground at y=70 while bots work the surface at y=90-100,
  // so the recurring "21 blocks away" was the vertical gap: they stand directly
  // above their own stash with no route down. safeMoves sets canDig=false, so
  // the pathfinder refuses to tunnel and the deposit bounces. 33 of 46 deposit
  // failures in one session were this exact case, at this exact distance.
  //
  // Give them the capability to dig down to their own stash, the same way the
  // pit-escape helper does. baseMoves keeps the fall cap, so descending stays
  // safe.
  //
  // The original guard was "only if already overhead" (horizontal gap under 12),
  // on the reasoning that a distant bot should walk rather than tunnel sideways.
  // That used position as a proxy for the real question. Once bots started
  // strip-mining they stranded themselves in tunnels safeMoves cannot path out
  // of, and the failure came back as 46 bounces at exactly 45 blocks — the same
  // constant every time, meaning the bot never moved at all.
  //
  // Progress is the honest discriminator. A bot that walked most of the way and
  // stopped short is navigating fine and should not tunnel. A bot that did not
  // move is stuck, and digging is its only way out regardless of distance.
  const horizontalGap = Math.hypot(bot.entity.position.x - stashPos.x, bot.entity.position.z - stashPos.z);
  const madeNoProgress = movedDist < 3;
  if (distToStash > 6 && (horizontalGap < 12 || madeNoProgress)) {
    const digMoves = baseMoves(bot);
    digMoves.canDig = true;
    digMoves.allow1by1towers = true;
    bot.pathfinder.setMovements(digMoves);
    try {
      await safeGoto(bot, new goals.GoalNear(stashPos.x, stashPos.y, stashPos.z, 3), 25000);
    } catch {
      /* best effort — the distance check below decides */
    } finally {
      bot.pathfinder.setMovements(safeMoves(bot));
    }
    distToStash = bot.entity.position.distanceTo(new Vec3(stashPos.x, stashPos.y, stashPos.z));
    if (distToStash > 6) {
      console.log(
        `[Stash] dig-retry did not reach: still ${distToStash.toFixed(0)} blocks, ` +
          `moved ${movedDist.toFixed(0)} on first goto, horizGap ${horizontalGap.toFixed(0)}`,
      );
    }
  }

  if (distToStash > 6) {
    return `Can't reach the stash — ${distToStash.toFixed(0)} blocks away (blocked or underground). Get to the surface near ${stashPos.x},${stashPos.y},${stashPos.z} first.`;
  }

  const itemsToDeposit = bot.inventory.items();
  if (itemsToDeposit.length === 0) return "Nothing to deposit — inventory is empty.";

  // Track kept items to respect minCount
  const keptCounts = new Map<string, number>();
  let deposited = 0;
  let noChest = 0;
  const failures = new Map<DepositFailure, number>();
  const noteFailure = (reason: DepositFailure, count: number, detail: string) => {
    noChest += count;
    failures.set(reason, (failures.get(reason) ?? 0) + count);
    console.log(`[Stash] deposit gave up: ${reason} (${count} items) — ${detail}`);
  };

  // Group items by category
  const byCategory = new Map<string, typeof itemsToDeposit>();
  const keptNames: string[] = [];
  for (const item of itemsToDeposit) {
    if (shouldKeep(item.name, keepItems, keptCounts, item.count, materialReserve, pickaxeKeep, foodKeep)) {
      keptNames.push(item.name);
      continue;
    }
    const cat = categorizeItem(item.name);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(item);
  }

  // For each category, find nearest chest at the right row offset and deposit
  for (const [category, items] of byCategory) {
    const rowOffset = getRowOffset(category);
    const chestPos = new Vec3(stashPos.x + rowOffset, stashPos.y, stashPos.z);

    // Find the nearest chest for this category.
    //
    // maxDistance was 6, which assumed the tidy original layout: one chest per
    // category row at stashPos.x + 0/2/4/6. The placement-diversity fix
    // (2277e3d) scatters new chests across rings 3-16 to avoid the double-chest
    // rejection, so category lookups increasingly found nothing at the expected
    // offset, counted the items as noChest, and reported "All stash chests are
    // full" when the real problem was "no chest at this row offset".
    //
    // 18 covers the whole placement ring, so a scattered chest still serves its
    // category. Nearest-first keeps the row grouping when the tidy chests exist.
    //
    // CANDIDATES, not one chest. findBlock returns the single nearest, and when
    // that one is walled in the deposit gave up on the whole category. Measured
    // over one session: only THREE distinct chests were ever targeted and one of
    // them absorbed 64 attempts, every one failing, while the stash holds
    // hundreds. All 30 post-dig "still short" attempts ended in
    // chest_unreachable and not one ever succeeded. Trying the next chest costs
    // a walk; not trying it costs the entire load.
    const candidates = bot
      .findBlocks({
        matching: (b) => b.name === "chest" || b.name === "trapped_chest",
        maxDistance: 18,
        point: chestPos,
        count: CHEST_CANDIDATES,
      })
      .map((pos) => bot.blockAt(pos))
      .filter((b): b is NonNullable<typeof b> => b !== null);

    // SPILL-OVER: when a category's own chests fill, the deposit used to give
    // up on the load — 16 chest_full give-ups in one run while a 60-chest
    // stash surely had space, and expansion couldn't rescue it (the bot
    // carried no planks to craft a chest). Append chests the ledger last saw
    // with free slots, emptiest first, so the load lands somewhere instead of
    // riding back out. A category miss just means items scatter — findable
    // again because every withdraw scans the ledger for the item.
    const { chestsWithSpace } = await import("./stash-ledger.js");
    for (const spot of chestsWithSpace()) {
      const b = bot.blockAt(new Vec3(spot.x, spot.y, spot.z));
      if (
        b &&
        (b.name === "chest" || b.name === "trapped_chest") &&
        !candidates.some((c) => c.position.equals(b.position))
      ) {
        candidates.push(b);
      }
    }
    const chest = candidates[0] ?? null;

    if (!chest) {
      // No chest at this row — try any nearby chest as fallback
      const fallback = bot.findBlock({
        matching: (b) => b.name === "chest" || b.name === "trapped_chest",
        maxDistance: 8,
      });
      if (!fallback) {
        noteFailure(
          "no_chest_found",
          items.length,
          `category ${category}: none within 18 of row, none within 8 of bot`,
        );
        continue;
      }
      // Use fallback chest
      try {
        await clearChestRoof(bot, fallback.position);
        const container = await openContainerTimed(bot, fallback);
        for (const item of items) {
          try {
            await container.deposit(item.type, null, item.count);
            deposited += item.count;
          } catch {
            // Chest might be full
          }
        }
        snapshotChest(fallback.position, container.containerItems(), container.inventoryStart);
        container.close();
      } catch (err) {
        const dist = bot.entity.position.distanceTo(fallback.position);
        noteFailure(
          "chest_open_failed",
          items.length,
          `category ${category}: fallback chest at dist=${dist.toFixed(1)} — ${(err as Error).message}`,
        );
      }
      continue;
    }

    // Measured only to LABEL the failure below, never to skip the attempt — this
    // round is pure instrumentation, so behaviour must stay byte-for-byte the same
    // while the cause becomes visible. safeGoto returns without throwing on
    // timeout, so distance after it is the only honest signal of whether the walk
    // worked. Server reach is ~4.5 blocks; beyond that openContainer is doomed and
    // the 10s timeout is what we are actually paying.
    let banked = false;
    let lastFail: { reason: DepositFailure; detail: string } | null = null;
    // Items still looking for a chest with room. The loop used to stop at the
    // first chest it OPENED, swallow every full-chest throw item by item, and
    // report the load as kept gear — Blade's 148 andesite + 132 diorite came
    // home from a 61-chest stash because his one category chest was full.
    // Leftovers now walk on to the next candidate.
    let pending = [...items];

    for (const chest of candidates) {
      if (pending.length === 0) break;
      let distToChest = Number.NaN;
      try {
        // Navigation failure must NOT skip the roof clear. First deploy of the
        // unsealing put clearChestRoof after safeGoto inside one try, so a thrown
        // "No path to the goal!" jumped straight to the catch and the roof stayed
        // on — circular, because a sealed chest is exactly what has no standable
        // neighbour to path to. That was 20 of 38 failures, and the first two
        // failures after deploy were both this case with zero roofs cleared.
        let navErr: Error | null = null;
        try {
          await safeGoto(bot, new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2), 10000);
        } catch (e) {
          navErr = e as Error;
        }
        distToChest = bot.entity.position.distanceTo(chest.position);

        // Walled in. The bots stack chests on chests and ring them with their own
        // planks, stairs and cobblestone, and safeMoves cannot dig, so A* returns
        // "No path to the goal!" while the bot stands six blocks away. See
        // shouldDigToChest: 340 attributed failures, all chest_unreachable,
        // against 16 successful deposits. Tunnel the last few blocks instead of
        // abandoning the load. Chests are in the pathfinder's blocksCantBreak set,
        // so this routes around storage rather than through it.
        if (shouldDigToChest(distToChest, navErr !== null, chest.position.y - bot.entity.position.y)) {
          const digApproach = baseMoves(bot);
          digApproach.canDig = true;
          digApproach.maxDropDown = 1; // never dig a pit to reach a chest
          digApproach.allow1by1towers = false; // no pillaring: that is the fall risk
          bot.pathfinder.setMovements(digApproach);
          try {
            await safeGoto(bot, new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2), 12000);
            navErr = null;
          } catch (e) {
            navErr = e as Error;
          } finally {
            bot.pathfinder.setMovements(safeMoves(bot));
          }
          const after = bot.entity.position.distanceTo(chest.position);
          console.log(
            `[Stash] dug toward chest at ${chest.position}: ${distToChest.toFixed(1)} -> ${after.toFixed(1)} blocks` +
              `${withinReach(after) ? " (in reach)" : " (still short)"}`,
          );
          distToChest = after;
        }

        // Standing close enough to touch it is what matters, not whether the
        // pathfinder said so. Digging and opening both work from here.
        if (withinReach(distToChest)) {
          await clearChestRoof(bot, chest.position);
        } else if (navErr) {
          throw navErr; // genuinely could not get there — keep the old attribution
        }
        const container = await openContainerTimed(bot, chest);
        const leftover: typeof pending = [];
        for (const item of pending) {
          try {
            await container.deposit(item.type, null, item.count);
            deposited += item.count;
          } catch {
            leftover.push(item); // this chest has no room for it — try the next candidate
          }
        }
        snapshotChest(chest.position, container.containerItems(), container.inventoryStart);
        container.close();
        banked = true;
        pending = leftover;
      } catch (err) {
        const walked = withinReach(distToChest);
        // A chest one block away that will neither open nor be pathed to points at
        // the space around it, not at the chest lookup. Minecraft refuses to open a
        // chest with an opaque block directly above, and a buried chest also has no
        // standable neighbour to path to — one obstruction would explain BOTH
        // attributed causes at once. Log what is actually there before assuming it.
        const above = bot.blockAt(chest.position.offset(0, 1, 0));
        const sides = [
          [1, 0, 0],
          [-1, 0, 0],
          [0, 0, 1],
          [0, 0, -1],
        ]
          .map(([dx, dy, dz]) => bot.blockAt(chest.position.offset(dx, dy, dz))?.name ?? "?")
          .join("/");
        // Remember, do not report. Reporting here counted one unreachable chest
        // as a failed category while three untried chests were still standing, so
        // the log showed 64 failures against a single buried chest and no attempt
        // at any other. Only the last failure, after every candidate is spent, is
        // the category's real outcome.
        lastFail = {
          reason: walked ? "chest_open_failed" : "chest_unreachable",
          detail:
            `category ${category}: chest at ${chest.position} dist=${Number.isFinite(distToChest) ? distToChest.toFixed(1) : "?"} ` +
            `rowGap=${chest.position.distanceTo(chestPos).toFixed(1)} above=${above?.name ?? "?"} ` +
            `sides=${sides} tried=${candidates.length} — ${(err as Error).message}`,
        };
      }
    }

    if (!banked && lastFail) {
      noteFailure(lastFail.reason, items.length, lastFail.detail);
    } else if (pending.length > 0) {
      // Chests were reached and opened; these stacks just found no room in any
      // of them. Real chest_full failures feed the expansion trigger above.
      noteFailure(
        "chest_full",
        pending.length,
        `category ${category}: ${pending.length} of ${items.length} stacks left after ${candidates.length} chest(s)`,
      );
    }
  }

  // AUTO-EXPANSION: the stash filled up with weeks of accumulated blocks and
  // every deposit bounced ("needs expansion" x days). The prompt-level cue
  // (Mason: place chests) produced chest WITHDRAWALS but no successful
  // placement in 24h — so give the deposit routine the capability directly:
  // if items bounced and this bot is CARRYING a chest (crafted by the team —
  // no free items), place it past the stash rows and deposit into it.
  if (shouldAttemptExpansion(failures)) {
    let chestItem = bot.inventory.items().find((i) => i.name === "chest");

    // Records which gate stopped the expansion. Every bail-out below used to be
    // a silent catch or a falsy check, so three rounds of fixes were guesswork:
    // the stash bounced 51-66 times per session and nobody could see whether it
    // lacked logs, planks, a crafting table, or a recipe. Report the reason once
    // per bounce so the next fix targets the gate that is actually closed.
    let expandBail = "";
    // No chest carried? CRAFT one on the spot from carried planks (8) — the
    // "craft a chest and carry it" mission produced talk but no carried
    // chests across a full day (crafted ones get spent/deposited before the
    // next bounce). All materials are still bot-earned; this only removes
    // the multi-step timing coordination the LLM can't hold.
    if (!chestItem) {
      const countPlanks = () =>
        bot.inventory
          .items()
          .filter((i) => i.name.endsWith("_planks"))
          .reduce((sum, i) => sum + i.count, 0);

      let planks = countPlanks();

      // Bots arrive at the stash carrying LOGS, not planks: they gather wood
      // and deposit it raw. Requiring 8 planks meant a bot standing at a full
      // stash holding 4 oak_log (16 planks' worth) counted as zero and reported
      // "need more chests" instead of expanding. Measured: 66 bounces and zero
      // successful expansions in a 5h session, while the LLM narrated the
      // problem it could not act on ("Forge's chest dream still stuck").
      // Convert first — logs to planks is a 2x2 recipe, so no table is needed.
      if (planks < 8) {
        try {
          const mcData = (await import("minecraft-data")).default(bot.version);
          let log = bot.inventory.items().find((i) => i.name.endsWith("_log"));
          if (!log) {
            // The deposit that just bounced BANKED this bot's logs moments
            // earlier — five "carrying 0 planks and no logs" bails in run 359,
            // each right after a deposit that included wood. The bot is
            // standing at the stash; take two logs back out for the chest.
            try {
              await withdrawStash(bot, stashPos, "log", 2);
            } catch {
              /* stash has no logs either — the bail below reports it */
            }
            log = bot.inventory.items().find((i) => i.name.endsWith("_log"));
          }
          if (!log) {
            expandBail = `carrying ${planks} planks and no logs`;
          } else {
            const plankDef = mcData.itemsByName[log.name.replace("_log", "_planks")];
            const recipe = plankDef && bot.recipesFor(plankDef.id, null, 1, null)[0];
            if (!recipe) {
              expandBail = `no plank recipe for ${log.name}`;
            } else {
              const logsNeeded = Math.ceil((8 - planks) / 4); // 1 log = 4 planks
              await bot.craft(recipe, Math.min(logsNeeded, log.count), undefined);
              planks = countPlanks();
              console.log(`[Stash] Converted logs to planks for expansion (${planks} planks)`);
            }
          }
        } catch (err) {
          expandBail = `plank craft threw: ${(err as Error).message}`;
        }
      }

      if (planks >= 8) {
        try {
          const mcData = (await import("minecraft-data")).default(bot.version);
          const chestDef = mcData.itemsByName["chest"];
          const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 24 });
          if (!chestDef) {
            expandBail = "no chest item definition";
          } else if (!table) {
            // A chest is a 3x3 recipe, so it needs a table. If the stash has no
            // table within reach, expansion can never complete no matter how
            // many planks the bot carries.
            expandBail = `${planks} planks but no crafting_table within 24 blocks of the stash`;
          } else {
            await safeGoto(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 15000);
            const recipe = bot.recipesFor(chestDef.id, null, 1, table)[0];
            if (!recipe) {
              expandBail = `${planks} planks, table found, but no chest recipe offered`;
            } else {
              await Promise.race([
                bot.craft(recipe, 1, table),
                new Promise<void>((_, rej) => setTimeout(() => rej(new Error("craft timeout")), 15000)),
              ]);
              chestItem = bot.inventory.items().find((i) => i.name === "chest");
              if (chestItem) console.log("[Stash] Crafted a chest for expansion");
              else expandBail = "chest craft completed but produced no chest";
            }
          }
        } catch (err) {
          expandBail = `chest craft threw: ${(err as Error).message}`;
        }
      } else if (!expandBail) {
        expandBail = `only ${planks} planks after conversion`;
      }
    }
    if (chestItem) {
      try {
        const placed = await placeChestNearStash(bot, stashPos);
        if (placed) {
          // A freshly placed chest is not immediately openable: the bot may be
          // up to 2 blocks away from where it placed, and the block state needs
          // a moment to register. The first successful expansion placed a chest
          // and then died on "openContainer timeout", losing the deposit it had
          // just made room for. Step adjacent, let the block settle, and retry
          // once before giving up.
          const container = await openNewChest(bot, placed);
          // FRESH keep-counts for this second pass. Reusing the first pass's
          // populated map means every reserve reads as already full, so the
          // items kept in pass one (the only pickaxe, the food buffer) would
          // fall through shouldKeep and be dumped into the new chest.
          const expansionKept = new Map<string, number>();
          for (const item of bot.inventory.items()) {
            if (item.name === "chest") continue; // keep spare chests for next expansion
            if (shouldKeep(item.name, keepItems, expansionKept, item.count, materialReserve, pickaxeKeep, foodKeep))
              continue;
            try {
              await container.deposit(item.type, null, item.count);
              deposited += item.count;
            } catch {
              break; // new chest full too
            }
          }
          snapshotChest(placed.position, container.containerItems(), container.inventoryStart);
          container.close();
          noChest = 0;
        } else {
          expandBail = "carried a chest but found nowhere to place it near the stash";
        }
      } catch (err) {
        expandBail = `chest placement threw: ${(err as Error).message}`;
      }
    }

    if (noChest > 0 && expandBail) {
      console.log(`[Stash] Expansion blocked: ${expandBail}`);
    }
  }

  // Top up food while we're already at the stash (non-disruptive distribution).
  // Remote workers (miner, explorer) starve away from the farm; topping up on
  // each stash visit spreads the team's surplus bread to whoever comes to
  // deposit — the stash as a shared pantry, no extra trips.
  const foodHeld = bot.inventory
    .items()
    .filter((i) => i.name === "bread" || i.name.startsWith("cooked_"))
    .reduce((s, i) => s + i.count, 0);
  if (foodHeld < 4) {
    // Aggregate budget (LESSON 2): even though each withdrawStash is individually
    // bounded, looping all 6 food types re-runs the travel each time — cap the
    // whole top-up so it can't stall deposit_stash if the stash chest churns.
    const topupStart = Date.now();
    for (const f of ["bread", "cooked_beef", "cooked_porkchop", "cooked_mutton", "cooked_chicken", "cooked_cod"]) {
      if (Date.now() - topupStart > 20000) break;
      try {
        await withdrawStash(bot, stashPos, f, 4 - foodHeld);
      } catch {
        /* none of this food in stash — try next */
      }
      if (bot.inventory.items().some((i) => i.name === f)) break;
    }
  }

  if (noChest > 0 && deposited === 0) {
    // Say what actually happened. noChest counts items whose category had NO
    // reachable chest, not full ones, and the old wording sent several rounds of
    // work chasing chest supply when the stash had space but the lookup missed.
    return (
      `No reachable chest for ${noChest} carried item${noChest === 1 ? "" : "s"} ` +
      `(${summarizeDepositFailure(failures)}). ${depositFailureAdvice(failures)}`
    );
  }
  if (noChest > 0) {
    return `Deposited ${deposited} items. ${noChest} items couldn't fit (${summarizeDepositFailure(failures)}). ${depositFailureAdvice(failures)}`;
  }
  if (deposited === 0) return nothingToBankMessage(keptNames);
  return `Deposited ${deposited} items at the stash.`;
}

/**
 * Walk to stash, find item in categorized chests, withdraw specified count.
 */
export async function withdrawStash(
  bot: Bot,
  stashPos: { x: number; y: number; z: number },
  itemName: string,
  count: number,
  budgetMs = 110_000,
): Promise<string> {
  await safeGoto(bot, new goals.GoalNear(stashPos.x, stashPos.y, stashPos.z, 3), 30000);

  const category = categorizeItem(itemName);

  // Wood-family fuzzy matching: bots request "oak_log" while the stash holds
  // birch/spruce (exact-name miss — the raw_beef lesson again: 58 failed
  // withdrawals in one night while wood sat in the chests). Any wood variant
  // or generic term matches the whole family via substring.
  let matchName = itemName;
  if (/^([a-z]+_)?logs?$|^wood$/.test(itemName) || itemName.endsWith("_log")) matchName = "_log";
  else if (/^([a-z]+_)?planks?$/.test(itemName) || itemName.endsWith("_planks")) matchName = "_planks";
  const rowOffset = getRowOffset(category);
  const chestPos = new Vec3(stashPos.x + rowOffset, stashPos.y, stashPos.z);

  // Try category chest first, then scan all nearby chests
  const chestsToTry: any[] = [];

  const categoryChest = bot.findBlock({
    matching: (b) => b.name === "chest" || b.name === "trapped_chest",
    maxDistance: 6,
    point: chestPos,
  });
  if (categoryChest) chestsToTry.push(categoryChest);

  // Also check all nearby chests in case the item was overflow-deposited
  // 20, not 10: the expansion row runs to stash+18, and a spare bucket sat
  // in the chest at (298,70,-308) — 13 blocks out — invisible to every
  // withdrawal while Mason ground iron for a bucket the team already owned.
  // The same blind spot cost two RCON hunts before this made it durable.
  // count 64, not 16: the stash has sprawled to SIXTY-ONE chests, and the
  // sixteen nearest happened to exclude the one holding the team's last two
  // sticks — the withdrawal reported empty shelves while the item sat
  // banked twenty blocks away. Scan them all.
  // Chests the ledger last saw holding this item go to the FRONT, so a
  // scattered item is found in the first chest or two instead of the
  // sixtieth. The ledger snapshots contents on every open, so it is as
  // fresh as the last visit — a miss just falls through to the full scan.
  const { chestsWithItem } = await import("./stash-ledger.js");
  for (const known of chestsWithItem(matchName)) {
    const block = bot.blockAt(new Vec3(known.x, known.y, known.z));
    if (block && (block.name === "chest" || block.name === "trapped_chest") && !chestsToTry.includes(block)) {
      chestsToTry.push(block);
    }
  }

  const allChests = bot.findBlocks({
    matching: (b) => b.name === "chest" || b.name === "trapped_chest",
    maxDistance: 20,
    count: 64,
  });
  for (const pos of allChests) {
    const block = bot.blockAt(pos);
    if (block && !chestsToTry.includes(block)) chestsToTry.push(block);
  }

  // When a well-populated ledger has never seen this item in ANY chest, the
  // full walk-and-open sweep is a hundred seconds of confirming what the
  // ledger already knew — leather burned two such sweeps per book attempt.
  // Check the nearest few in case the ledger is stale, then hand the time
  // back to the caller.
  const { getStashSummary } = await import("./stash-ledger.js");
  if (getStashSummary().chestCount >= 20 && chestsWithItem(matchName).length === 0) {
    chestsToTry.length = Math.min(chestsToTry.length, 6);
  }

  // Count what we actually have BEFORE, so we can report the real delta —
  // container.withdraw can resolve without delivering (Flora "withdrew" 48
  // planks across 6 calls and ended with 0), which made her loop forever.
  const countItem = () =>
    bot.inventory
      .items()
      .filter((i) => i.name.includes(matchName))
      .reduce((s, i) => s + i.count, 0);
  const before = countItem();

  let withdrawn = 0;
  let openFailures = 0;
  const needed = count;

  // Time-box the whole scan. The stash sprawled to 60+ chests, and walking
  // to and opening every one blew the executor's 150s watchdog — 901
  // withdraw timeouts in one run, leaving bots starving and pickless while
  // the item sat in a chest the scan never reached. Stop at 110s and return
  // whatever was gathered; a partial withdrawal beats a watchdog kill that
  // returns nothing.
  const scanDeadline = Date.now() + budgetMs;

  for (const chest of chestsToTry) {
    if (withdrawn >= needed) break;
    if (Date.now() > scanDeadline) {
      console.log(
        `[Stash] withdraw scan hit its ${Math.round(budgetMs / 1000)}s budget after ${withdrawn}/${needed} ${matchName}`,
      );
      break;
    }
    try {
      await safeGoto(bot, new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2), 8000);
      const container = await openContainerTimed(bot, chest);

      for (const slot of container.containerItems()) {
        if (withdrawn >= needed) break;
        if (slot.name.includes(matchName)) {
          // A FULL inventory makes withdraw throw — and the old silent catch
          // turned that into "no leather in the stash" while Forge stood at
          // an open chest holding five of them. Bank junk into this very
          // chest to make room first.
          if (bot.inventory.emptySlotCount() < 1) {
            const JUNK = [
              "cobblestone",
              "cobbled_deepslate",
              "dirt",
              "gravel",
              "andesite",
              "diorite",
              "granite",
              "tuff",
              "netherrack",
            ];
            for (const j of bot.inventory.items()) {
              if (bot.inventory.emptySlotCount() >= 2) break;
              if (JUNK.includes(j.name)) {
                try {
                  await container.deposit(j.type, null, j.count);
                  console.log(`[Stash] pocket full mid-withdraw — banked ${j.count}x ${j.name} to make room`);
                } catch {
                  /* chest full — try the next junk stack */
                }
              }
            }
          }
          const take = Math.min(slot.count, needed - withdrawn);
          try {
            await container.withdraw(slot.type, null, take);
            withdrawn += take;
          } catch (e) {
            console.log(`[Stash] withdraw of ${slot.count}x ${slot.name} FAILED: ${(e as Error).message}`);
          }
        }
      }
      snapshotChest(chest.position, container.containerItems(), container.inventoryStart);
      container.close();
    } catch (e) {
      // A silent open-failure here once let a bot stand beside the ledger's
      // gold chest and report the whole stash empty. Name the first few.
      if (openFailures < 3) {
        console.log(
          `[Stash] couldn't open chest at ${chest.position.x},${chest.position.y},${chest.position.z}: ${(e as Error).message}`,
        );
      }
      openFailures++;
    }
  }
  if (openFailures > 0 && withdrawn === 0) {
    console.log(`[Stash] ${openFailures} chest opens failed during the ${matchName} scan — 0 withdrawn`);
  }

  // Report the VERIFIED delta, not what container.withdraw claimed.
  const gained = countItem() - before;
  if (gained <= 0 && withdrawn > 0) {
    return `Tried to withdraw ${itemName} but it never reached your inventory (stash transfer failed) — the stash may be empty of it. Gather it yourself or check a different item.`;
  }
  if (gained === 0) return `No ${itemName} in the stash. Gather it yourself instead.`;
  if (gained < needed) return `Withdrew ${gained}x ${itemName} from stash (wanted ${needed} — that's all there was).`;
  return `Withdrew ${gained}x ${itemName} from stash.`;
}

/** Find open ground just past the stash rows and place a chest from inventory.
 *  Part of auto-expansion: the bot supplies its own chest; this only handles
 *  the placement mechanics (goto, equip, place) that the LLM kept fumbling. */
/**
 * Open a chest the bot just placed.
 *
 * Placement finishes from up to 2 blocks away and the new block takes a moment
 * to register, so an immediate openContainer hits the 10s timeout. That cost
 * the very first successful expansion its deposit. Close the distance, let the
 * block settle, and retry once.
 */
async function openNewChest(bot: Bot, placed: NonNullable<ReturnType<Bot["blockAt"]>>) {
  const p = placed.position;

  for (let attempt = 0; attempt < 2; attempt++) {
    let approach = "ok";
    try {
      await safeGoto(bot, new goals.GoalNear(p.x, p.y, p.z, 1), 10000);
    } catch (err) {
      // Swallowed so we still attempt the open, but record it: if the approach
      // fails the bot may be well outside interaction range, and openContainer
      // would then time out for a reason that has nothing to do with the chest.
      approach = `failed (${(err as Error).message})`;
    }
    await new Promise((r) => setTimeout(r, attempt === 0 ? 400 : 1200));
    try {
      return await openContainerTimed(bot, placed);
    } catch (err) {
      // Distance is the discriminator: in-range means a protocol or block-state
      // problem, out-of-range means the approach is the real failure.
      const dist = bot.entity.position.distanceTo(p).toFixed(1);
      const stillThere = bot.blockAt(p)?.name ?? "unknown";
      console.log(
        `[Stash] openNewChest attempt ${attempt + 1} failed: dist=${dist} block=${stillThere} approach=${approach}`,
      );
      if (attempt === 1) throw err;
    }
  }

  throw new Error("openNewChest exhausted retries");
}

/**
 * Horizontal neighbours of a candidate spot. A chest in any of these would pair
 * into a double chest, and an already-paired chest silently rejects placement.
 */
export const CHEST_NEIGHBOUR_OFFSETS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Leave breathing room around the stash rows before placing anything. */
export const CHEST_MIN_RING = 3;
export const CHEST_MAX_RING = 16;

/**
 * Candidate [dx, dy, dz] offsets for a new stash chest, nearest ring first.
 *
 * Must cover every horizontal direction. The original scan walked dx 10..16
 * with dz -2..2, a strip on the +X side only, so once that strip filled up
 * expansion was impossible regardless of how many chests a bot carried.
 */
export function chestPlacementOffsets(): Array<[number, number, number]> {
  const offsets: Array<[number, number, number]> = [];

  for (let r = CHEST_MIN_RING; r <= CHEST_MAX_RING; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring perimeter only
        // Slight vertical tolerance for uneven ground around the base.
        for (const dy of [0, 1, -1]) offsets.push([dx, dy, dz]);
      }
    }
  }

  return offsets;
}

async function placeChestNearStash(
  bot: Bot,
  stashPos: { x: number; y: number; z: number },
): Promise<ReturnType<Bot["blockAt"]>> {
  const chestItem = bot.inventory.items().find((i) => i.name === "chest");
  if (!chestItem) return null;

  // The old scan covered dx 10..16 with dz -2..2: a 7x5 strip in the +X
  // direction only, 35 spots all on one side of the stash. After weeks of base
  // building that strip is occupied, so bots arrived holding a chest and had
  // nowhere to put it. Measured: 41 of 55 expansion attempts failed this way
  // with a chest already in hand, which surfaced as "stash full, need more
  // chests" and sent four rounds of fixes chasing chest supply instead.
  //
  // Search rings outward in every direction. Block-state checks are free, so
  // gather candidates first and only spend walk time on the nearest few.
  const spots: InstanceType<typeof Vec3>[] = [];

  for (const [dx, dy, dz] of chestPlacementOffsets()) {
    const base = new Vec3(stashPos.x + dx, stashPos.y + dy, stashPos.z + dz);
    const ground = bot.blockAt(base.offset(0, -1, 0));
    const target = bot.blockAt(base);
    const above = bot.blockAt(base.offset(0, 1, 0));
    if (!ground || ground.boundingBox !== "block") continue;
    if (!target || target.name !== "air") continue;
    if (!above || above.name !== "air") continue;

    // Reject spots touching an existing chest.
    //
    // Placing a chest beside another forms a double chest, and a chest already
    // paired into a double CANNOT accept a third: the server rejects the
    // placement silently, so placeBlock never resolves and burns its timeout.
    // That is what the diagnostic caught — 11 of 14 failures had the bot
    // standing among chests with the target in reach and in plain sight
    // (sight=visible in=chest).
    //
    // It also explains why expansion decayed as the ring filled: every chest
    // placed makes its neighbours unplaceable, so the scatter that fixed
    // placement eventually created the density that defeats it. With 328 open
    // spots available, insisting on an isolated one is cheap.
    if (CHEST_NEIGHBOUR_OFFSETS.some((o) => bot.blockAt(base.offset(o[0], 0, o[1]))?.name.includes("chest"))) {
      continue;
    }

    spots.push(base);
  }

  if (spots.length === 0) {
    console.log(`[Stash] No open placement spot within ${CHEST_MAX_RING} blocks of the stash`);
    return null;
  }

  // Nearest first — every attempt costs a walk, so try the cheap ones first.
  const from = bot.entity.position;
  spots.sort((a, b) => a.distanceTo(from) - b.distanceTo(from));

  // ...but do not spend every attempt in one pocket. Trying the 8 nearest spots
  // meant 8 ADJACENT spots, which fail for the same reason, so expansion died
  // with "Found 342 open spots but every placement attempt failed" while 340
  // untried alternatives sat there. Nearest-first is right for cost and wrong
  // for diversity when failures are spatially correlated.
  //
  // Take a handful of close spots, then sample across the rest so later
  // attempts land in genuinely different areas.
  //
  // Sample across the NEARER HALF only. Sampling the whole remainder reached
  // ring-16 spots that cannot be walked to inside the 5s per-attempt budget, so
  // once place-timeout was fixed, navigation timeouts became the dominant
  // failure (15 of 23) with 327 open spots available. Diversity and
  // reachability pull against each other; keep diversity WITHIN what is
  // reachable rather than trading one for the other.
  const attemptSpots = spots.slice(0, 5);
  const pool = spots.slice(5, Math.max(6, Math.ceil(spots.length / 2)));
  const stride = Math.max(1, Math.floor(pool.length / 12));
  for (let i = 0; i < pool.length && attemptSpots.length < 17; i += stride) {
    attemptSpots.push(pool[i]);
  }

  // Bounded overall: more chances, but the pair of gotos must stay inside the
  // action watchdog, so the per-attempt timeout drops as the count rises.
  const attemptStart = Date.now();
  let attempts = 0;
  let budgetHit = false;
  // Kept separate from the budget break: "time budget exhausted" used to
  // overwrite the real per-attempt reason, so 52 of 54 failures reported the
  // cap and hid why the individual placements failed.
  let lastErr = "no attempts made";

  for (const base of attemptSpots) {
    if (Date.now() - attemptStart > 45000) {
      budgetHit = true;
      break;
    }
    attempts++;
    try {
      // 5s, not 8s. At 8s the 45s cap allowed only ~5 attempts, so expansion
      // failed 54 times against 30 successes with 342 spots available and the
      // budget as the dominant limiter. A spot needing more than 5s of walking
      // is not the cheap one we sorted for anyway.
      await safeGoto(bot, new goals.GoalNear(base.x, base.y, base.z, 2), 5000);
      await bot.equip(chestItem, "hand");

      // A bot standing IN the target cannot place a block at its own feet, and
      // the doomed placeBlock burns the whole 5s timeout. GoalNear(base, 2)
      // permits arriving at distance 0, and the spot was validated as air
      // BEFORE walking there: the bot is what fills it. 35 of 61 placement
      // failures were "place timeout", and skipping a doomed attempt reclaims
      // enough budget for roughly one extra real one.
      const feet = bot.entity.position.floored();
      if (feet.x === base.x && feet.z === base.z && Math.abs(feet.y - base.y) <= 1) {
        lastErr = "bot ended up standing in the target spot";
        continue;
      }

      const ground = bot.blockAt(base.offset(0, -1, 0));
      if (!ground) {
        lastErr = "ground block vanished before placing";
        continue;
      }
      // Re-verify the spot is still empty: another bot may have filled it while
      // this one walked over.
      const target = bot.blockAt(base);
      if (target && target.name !== "air") {
        lastErr = `spot taken by ${target.name} before placing`;
        continue;
      }
      // Look at the block first. placeBlock does this internally, but doing it
      // explicitly and letting it settle avoids racing the server's view of
      // where the bot is facing.
      try {
        await bot.lookAt(ground.position.offset(0.5, 1, 0.5));
      } catch {
        /* not fatal — placeBlock will try on its own */
      }

      await Promise.race([
        bot.placeBlock(ground, new Vec3(0, 1, 0)),
        new Promise<void>((_, rej) => {
          setTimeout(() => {
            // "place timeout" returned as the dominant failure (28 of 46) even
            // after the standing-in-spot fix removed one cause of it, and
            // "bot ended up standing in the target spot" never appears now. So
            // a DIFFERENT cause produces the same symptom, and the error string
            // cannot tell them apart. Record reach and footing: placeBlock needs
            // the reference block within ~4.5 blocks.
            const d = bot.entity.position.distanceTo(ground.position);
            const standingOn = bot.entity.position.floored().equals(ground.position.offset(0, 1, 0))
              ? " standingOnGround"
              : "";
            // Reach and footing are already ruled out: every failure landed at
            // 1.7-3.1 blocks, well inside the ~4.5 limit, with no standingOn.
            // Two hypotheses remain. The chest ring is now dense enough that
            // line of sight to the reference face may be blocked, and bots work
            // beside the farm water where placement can fail outright.
            let sight = "?";
            try {
              sight = bot.canSeeBlock(ground) ? "visible" : "BLOCKED";
            } catch {
              /* helper unavailable on this build */
            }
            const feetBlock = bot.blockAt(bot.entity.position)?.name ?? "?";
            // The neighbour filter reduced place timeouts 15.5/hr to 9/hr but
            // did not solve them, and in=chest turned out to describe the BOT's
            // footing rather than the target's neighbours. One hypothesis is
            // untested: an earlier failure logged "must be holding an item to
            // place", so the equip may not be completing. Record what is
            // actually in hand and whether the bot is airborne, since placing
            // mid-fall off a chest would also fail.
            const held = bot.heldItem?.name ?? "EMPTY";
            const onGround = bot.entity.onGround ? "grounded" : "AIRBORNE";
            rej(
              new Error(
                `place timeout (dist=${d.toFixed(1)}${standingOn} sight=${sight} in=${feetBlock} held=${held} ${onGround})`,
              ),
            );
          }, 5000);
        }),
      ]);
      const placed = bot.findBlock({ matching: (b) => b.name === "chest", maxDistance: 4 });
      if (placed) {
        console.log(`[Stash] Expanded: placed a new chest at ${placed.position} (attempt ${attempts})`);
        return placed;
      }
      lastErr = "placeBlock resolved but no chest appeared";
    } catch (err) {
      // Verify against the WORLD before believing the failure.
      //
      // placeBlock settles by waiting for a block-update packet. If the server
      // places the chest and the client misses that packet, the promise never
      // resolves and we report a timeout for a placement that actually worked,
      // then throw away a chest we already spent.
      //
      // Every other hypothesis is dead: the failures log dist=1.7-3.1 (inside
      // the ~4.5 reach), sight=visible, held=chest, grounded, and they persist
      // after the chest-neighbour filter. Checking the world costs nothing and
      // is more trustworthy than the API's promise either way.
      const landed = bot.blockAt(base);
      if (landed?.name.includes("chest")) {
        console.log(`[Stash] Expanded: chest at ${base} landed despite "${(err as Error).message}"`);
        return landed;
      }
      // Capture the reason: the old silent catch is why "every placement
      // attempt failed" could not be acted on without another round of guessing.
      lastErr = (err as Error).message;
      continue;
    }
  }

  console.log(
    `[Stash] ${spots.length} open spots, ${attempts} attempts across the ring, all failed. ` +
      `Last attempt error: ${lastErr}${budgetHit ? " (stopped on 45s budget)" : ""}`,
  );
  return null;
}
