import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chestPlacementOffsets,
  CHEST_MIN_RING,
  CHEST_MAX_RING,
  CHEST_NEIGHBOUR_OFFSETS,
  summarizeDepositFailure,
  shouldAttemptExpansion,
  depositFailureAdvice,
  obstructsChest,
  canClearObstruction,
  bestToolFor,
  withinReach,
  nothingToBankMessage,
  shouldKeep,
  KEEP_MATERIAL_RESERVE,
  shouldDigToChest,
  DIG_APPROACH_MAX,
  CHEST_CANDIDATES,
  type DepositFailure,
} from "./stash.js";

// Regression: the original scan walked dx 10..16 with dz -2..2, which is a 7x5
// strip on the +X side of the stash only. Once that strip filled with base
// buildings, expansion became impossible no matter how many chests a bot
// carried. It surfaced as "All stash chests are full! Need more chests" and
// sent four rounds of fixes chasing chest supply. Measured before the fix: 41
// of 55 expansion attempts failed with a chest already in hand.

test("placement search covers every horizontal direction", () => {
  const offsets = chestPlacementOffsets();

  const hasNegX = offsets.some(([dx]) => dx < 0);
  const hasPosX = offsets.some(([dx]) => dx > 0);
  const hasNegZ = offsets.some(([, , dz]) => dz < 0);
  const hasPosZ = offsets.some(([, , dz]) => dz > 0);

  assert.ok(hasNegX, "search never looks in -X (the original one-directional bug)");
  assert.ok(hasPosX, "search never looks in +X");
  assert.ok(hasNegZ, "search never looks in -Z");
  assert.ok(hasPosZ, "search never looks in +Z");
});

test("placement search reaches all four quadrants", () => {
  const offsets = chestPlacementOffsets();
  const quadrant = (sx: number, sz: number) =>
    offsets.some(([dx, , dz]) => Math.sign(dx) === sx && Math.sign(dz) === sz);

  for (const [sx, sz] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const) {
    assert.ok(quadrant(sx, sz), `no candidate in quadrant (${sx}, ${sz})`);
  }
});

test("placement search respects the ring bounds", () => {
  const offsets = chestPlacementOffsets();

  for (const [dx, , dz] of offsets) {
    const ring = Math.max(Math.abs(dx), Math.abs(dz));
    assert.ok(ring >= CHEST_MIN_RING, `candidate at ring ${ring} crowds the stash rows`);
    assert.ok(ring <= CHEST_MAX_RING, `candidate at ring ${ring} is beyond the search radius`);
  }
});

test("placement search is ordered nearest ring first", () => {
  const rings = chestPlacementOffsets().map(([dx, , dz]) => Math.max(Math.abs(dx), Math.abs(dz)));

  for (let i = 1; i < rings.length; i++) {
    assert.ok(rings[i] >= rings[i - 1], "rings must be emitted in ascending order");
  }
});

test("placement search offers meaningfully more spots than the old strip", () => {
  // The old scan produced 35 candidates, all on one side.
  const offsets = chestPlacementOffsets();
  assert.ok(offsets.length > 35 * 10, `only ${offsets.length} candidates`);
});

test("placement search allows slight vertical tolerance for uneven ground", () => {
  const ys = new Set(chestPlacementOffsets().map(([, dy]) => dy));

  assert.ok(ys.has(0));
  assert.ok(ys.has(1) || ys.has(-1), "no vertical tolerance for uneven terrain");
});

// Regression: chest placement decayed to 10% success as the stash ring filled.
// The diagnostic showed 11 of 14 failures with the target in reach and in plain
// sight (sight=visible in=chest) — the bot standing among a dense chest cluster.
// Placing beside an existing chest forms a double chest, and a chest already
// paired into a double silently rejects the placement, so placeBlock never
// resolves. Candidate spots must therefore avoid chest neighbours.
test("chest neighbour offsets cover all four horizontal directions", () => {
  const dirs = CHEST_NEIGHBOUR_OFFSETS;

  assert.equal(dirs.length, 4, "a chest pairs horizontally in exactly four directions");
  assert.ok(dirs.some(([dx, dz]) => dx === 1 && dz === 0));
  assert.ok(dirs.some(([dx, dz]) => dx === -1 && dz === 0));
  assert.ok(dirs.some(([dx, dz]) => dx === 0 && dz === 1));
  assert.ok(dirs.some(([dx, dz]) => dx === 0 && dz === -1));

  // Diagonals do NOT pair into a double chest, so excluding them would
  // needlessly discard valid spots.
  assert.ok(!dirs.some(([dx, dz]) => dx !== 0 && dz !== 0), "diagonals do not form double chests");
});

// The three sites that abandon a category all printed "No reachable chest", so a
// 596-event failure mode was unattributable. These lock in that the causes stay
// distinguishable and that the dominant one leads.
test("summarizeDepositFailure names the dominant cause first", () => {
  const failures = new Map<DepositFailure, number>([
    ["chest_open_failed", 3],
    ["no_chest_found", 9],
  ]);
  const msg = summarizeDepositFailure(failures);
  assert.match(msg, /^9 no chest serves that category/);
  assert.match(msg, /3 the chest wouldn't open/);
});

test("summarizeDepositFailure keeps the three causes distinct", () => {
  const wordings = (["no_chest_found", "chest_unreachable", "chest_open_failed"] as DepositFailure[]).map((r) =>
    summarizeDepositFailure(new Map([[r, 1]])),
  );
  assert.equal(new Set(wordings).size, 3, "each cause must read differently or the log stays ambiguous");
});

test("summarizeDepositFailure omits zero-count causes", () => {
  const msg = summarizeDepositFailure(
    new Map<DepositFailure, number>([
      ["no_chest_found", 0],
      ["chest_unreachable", 4],
    ]),
  );
  assert.equal(msg, "4 couldn't walk to the chest");
});

// Expansion fired 18 times against 0 no_chest_found failures, burning a 45s
// placement budget each time on a chest shortage that did not exist. Adding a
// chest cannot make an already-located adjacent chest open.
test("expansion only when a category genuinely had no chest", () => {
  assert.equal(shouldAttemptExpansion(new Map([["no_chest_found", 1]])), true);
  assert.equal(shouldAttemptExpansion(new Map([["chest_open_failed", 18]])), false);
  assert.equal(shouldAttemptExpansion(new Map([["chest_unreachable", 20]])), false);
});

test("expansion still fires when a real shortage is mixed with other causes", () => {
  const mixed = new Map<DepositFailure, number>([
    ["chest_open_failed", 18],
    ["chest_unreachable", 20],
    ["no_chest_found", 2],
  ]);
  assert.equal(shouldAttemptExpansion(mixed), true);
});

test("no failures means no expansion", () => {
  assert.equal(shouldAttemptExpansion(new Map()), false);
  assert.equal(shouldAttemptExpansion(new Map([["no_chest_found", 0]])), false);
});

// 77 of 78 attributed deposit failures had an opaque block directly above the
// chest (47 cobblestone, 30 oak_planks, 1 air). Minecraft will not open a chest
// under an opaque block, which produced both attributed causes at once.
test("obstructsChest flags what actually landed on the stash", () => {
  assert.equal(obstructsChest("cobblestone"), true);
  assert.equal(obstructsChest("oak_planks"), true);
  assert.equal(obstructsChest("oak_stairs"), true);
  assert.equal(obstructsChest("air"), false);
  assert.equal(obstructsChest("water"), false);
});

test("obstructsChest treats unknown blocks as obstructing", () => {
  // Erring the other way costs another silent 10s openContainer timeout.
  assert.equal(obstructsChest("some_modded_slab"), true);
});

test("obstructsChest ignores unloaded chunks", () => {
  assert.equal(obstructsChest(undefined), false);
  assert.equal(obstructsChest(null), false);
});

// The drowning dig-out once destroyed a team chest to save one bot. Never trade
// storage for a deposit.
test("canClearObstruction refuses to break valuables", () => {
  assert.equal(canClearObstruction("chest"), false);
  assert.equal(canClearObstruction("trapped_chest"), false);
  assert.equal(canClearObstruction("furnace"), false);
  assert.equal(canClearObstruction("bed"), false);
  assert.equal(canClearObstruction("bedrock"), false);
});

test("canClearObstruction allows ordinary build blocks", () => {
  assert.equal(canClearObstruction("cobblestone"), true);
  assert.equal(canClearObstruction("oak_planks"), true);
  assert.equal(canClearObstruction("dirt"), true);
  assert.equal(canClearObstruction("air"), false);
});

// Hand-breaking cobblestone takes ~11s, which would relocate the stall rather
// than remove it. mineflayer-tool is not loaded, so the pick is ours to make.
test("bestToolFor matches tool kind to the block", () => {
  assert.equal(bestToolFor("cobblestone", ["iron_pickaxe", "iron_axe"]), "iron_pickaxe");
  assert.equal(bestToolFor("oak_planks", ["iron_pickaxe", "iron_axe"]), "iron_axe");
  assert.equal(bestToolFor("oak_stairs", ["stone_axe"]), "stone_axe");
  assert.equal(bestToolFor("dirt", ["iron_shovel"]), "iron_shovel");
});

test("bestToolFor prefers the best material the bot actually carries", () => {
  assert.equal(bestToolFor("cobblestone", ["wooden_pickaxe", "iron_pickaxe"]), "iron_pickaxe");
  assert.equal(bestToolFor("cobblestone", ["wooden_pickaxe"]), "wooden_pickaxe");
});

test("bestToolFor returns null when no suitable tool is carried", () => {
  assert.equal(bestToolFor("cobblestone", ["iron_axe", "bread"]), null);
  assert.equal(bestToolFor("wool", ["iron_pickaxe"]), null);
});

// The substring version classified oak_stairs as open sky because "stairs"
// contains "air", silently skipping the dig for 47 of the observed obstructions.
test("obstructsChest matches tokens, not substrings", () => {
  assert.equal(obstructsChest("oak_stairs"), true, "stairs contains 'air'");
  assert.equal(obstructsChest("grass_block"), true, "solid grass_block is not tall_grass");
  assert.equal(obstructsChest("snow_block"), true);
  assert.equal(obstructsChest("cave_air"), false);
  assert.equal(obstructsChest("tall_grass"), false);
  assert.equal(obstructsChest("oak_wall_sign"), false);
});

// The first deploy of the unsealing put clearChestRoof after safeGoto inside one
// try, so "No path to the goal!" skipped the clear entirely — circular, since a
// sealed chest is what has no standable neighbour to path to. Reach, not
// pathfinder success, decides whether a bot can dig the roof off.
test("withinReach covers the distances the failures actually sat at", () => {
  for (const d of [0.6, 0.7, 1.1, 1.8, 1.9, 2.4, 2.5]) {
    assert.equal(withinReach(d), true, `observed failure distance ${d} must be actionable`);
  }
});

test("withinReach rejects out-of-range and unmeasured distances", () => {
  assert.equal(withinReach(4.6), false);
  assert.equal(withinReach(12), false);
  assert.equal(withinReach(Number.NaN), false, "unmeasured must not count as in reach");
});

// "Deposited 0 items at the stash." fired 132 times in under two hours and reads
// as success, so the brain re-planned straight back into it: 83 deposit_stash
// invocations to move 20 items.
test("banking nothing never reports success", () => {
  const msg = nothingToBankMessage(["iron_pickaxe", "bread"]);
  assert.doesNotMatch(msg, /^Deposited/, "must not open with a success phrase");
  assert.match(msg, /Banked nothing/);
});

test("nothingToBank names what is being held so the brain can reason", () => {
  const msg = nothingToBankMessage(["iron_pickaxe", "bread", "iron_pickaxe"]);
  assert.match(msg, /iron_pickaxe/);
  assert.match(msg, /bread/);
  assert.equal(msg.match(/iron_pickaxe/g)?.length, 1, "duplicates should collapse");
});

test("nothingToBank redirects away from the stash", () => {
  // The livelock was deposit -> success -> deposit. The message must point
  // somewhere else or the brain has no reason to change action.
  assert.match(nothingToBankMessage(["bread"]), /mine|chop|explore/);
});

test("nothingToBank truncates a full inventory instead of dumping 36 names", () => {
  const many = ["a_pickaxe", "b_axe", "c_sword", "d_shovel", "e_bread", "f_torch"];
  const msg = nothingToBankMessage(many);
  assert.match(msg, /\.\.\./);
  assert.equal(msg.includes("f_torch"), false);
});

test("nothingToBank handles an empty keep list", () => {
  assert.match(nothingToBankMessage([]), /nothing/);
});

// minCount is a count of ITEMS. The loop used to add 1 per stack, so
// { sapling, minCount: 16 } meant "keep 16 sapling STACKS" — over 1,000 saplings,
// more than an inventory holds. "Banked nothing" was the dominant deposit
// outcome at 240 against 10 successes.
test("keep reserve is satisfied by one stack, not sixteen", () => {
  const keep = [{ name: "sapling", minCount: 16 }];
  const counts = new Map<string, number>();
  assert.equal(shouldKeep("oak_sapling", keep, counts, 64), true, "first stack fills the reserve");
  assert.equal(shouldKeep("oak_sapling", keep, counts, 64), false, "second stack must be banked");
  assert.equal(shouldKeep("oak_sapling", keep, counts, 64), false, "third stack must be banked");
});

test("a partial stack still counts toward the reserve", () => {
  const keep = [{ name: "torch", minCount: 8 }];
  const counts = new Map<string, number>();
  assert.equal(shouldKeep("torch", keep, counts, 5), true);
  assert.equal(shouldKeep("torch", keep, counts, 5), true, "5+5=10 only after the second, so this is kept");
  assert.equal(shouldKeep("torch", keep, counts, 5), false, "reserve now exceeded");
});

test("omitting the count keeps the old per-item behaviour", () => {
  const keep = [{ name: "sapling", minCount: 2 }];
  const counts = new Map<string, number>();
  assert.equal(shouldKeep("oak_sapling", keep, counts), true);
  assert.equal(shouldKeep("oak_sapling", keep, counts), true);
  assert.equal(shouldKeep("oak_sapling", keep, counts), false);
});

test("iron gear is still never deposited regardless of count", () => {
  const counts = new Map<string, number>();
  assert.equal(shouldKeep("iron_sword", [], counts, 1), true);
  assert.equal(shouldKeep("iron_chestplate", [], counts, 1), true);
});

test("food buffer still counts stacks, not items", () => {
  // Deliberately unchanged: under-keeping food starves the miner, and this
  // reserve was tuned against real starvation, not against hoarding.
  const counts = new Map<string, number>();
  for (let i = 0; i < 6; i++) assert.equal(shouldKeep("bread", [], counts, 1), true);
  assert.equal(shouldKeep("bread", [], counts, 1), false);
});

// KEEP_MATERIALS returned true unconditionally — the only unbounded reserve in
// shouldKeep. Iron never reached the stash, so withdraw_stash logged "No
// iron_ingot in the stash" 245 times while bots walked around carrying it.
test("iron pools to the team once a bot can craft for itself", () => {
  const counts = new Map<string, number>();
  assert.equal(shouldKeep("iron_ingot", [], counts, KEEP_MATERIAL_RESERVE), true, "first 8 stay with the bot");
  assert.equal(shouldKeep("iron_ingot", [], counts, 20), false, "the surplus must reach the stash");
  assert.equal(shouldKeep("raw_iron", [], counts, 30), false);
});

test("a bot below the reserve still keeps enough to craft", () => {
  const counts = new Map<string, number>();
  // 8 ingots is an iron chestplate (or two picks); a bot must be able to reach
  // that alone. Gold has its own reserve now, so it cannot crowd iron out.
  // Raw ore is excluded from the reserve entirely — it must reach the smelter.
  assert.equal(shouldKeep("iron_ingot", [], counts, 3), true);
  assert.equal(shouldKeep("gold_ingot", [], counts, 4), true);
  assert.equal(shouldKeep("iron_ingot", [], counts, 5), true, "iron still under its own 8 (3+5=8)");
  assert.equal(shouldKeep("iron_ingot", [], counts, 1), false, "now at iron's own reserve");
});

test("iron keeps its own reserve, independent of gold", () => {
  // Iron is the tool material — every pickaxe, and diamond ore only drops for
  // an iron+ pick. When iron shared an 8-item reserve with gold, a gold rush
  // filled it and Forge's iron leaked to the stash; he then dived on a worn
  // pick that broke to stone and could not mine the diamond ore he found.
  // Iron and gold each get their own reserve so gold can never starve tools.
  const counts = new Map<string, number>();
  assert.equal(shouldKeep("gold_ingot", [], counts, 8), true, "gold fills its own reserve");
  assert.equal(shouldKeep("iron_ingot", [], counts, 8), true, "iron is untouched by gold's reserve");
  assert.equal(shouldKeep("iron_ingot", [], counts, 8), false, "iron's own reserve is now spent");
});

test("diamonds get their own reserve, never spent by ingots", () => {
  // Forge's mining filled the shared reserve with iron/gold and his diamonds
  // leaked to the stash, so no crafter ever held the 5 the diamond pick (3)
  // plus the enchanting table (2) need. Diamonds are kept independently.
  const counts = new Map<string, number>();
  assert.equal(shouldKeep("iron_ingot", [], counts, 8), true);
  assert.equal(shouldKeep("diamond", [], counts, 8), true, "diamonds are not spent by the ingot reserve");
});

test("iron TOOLS are still never deposited", () => {
  // Separate rule, above the materials cap — bots re-ground iron forever when
  // they deposited their own gear as surplus.
  const counts = new Map<string, number>();
  assert.equal(shouldKeep("iron_pickaxe", [], counts, 1), true);
  assert.equal(shouldKeep("iron_chestplate", [], counts, 1), true);
});

// The bots walled in their own stash. 340 attributed deposit failures, every
// one chest_unreachable, against 16 successful deposits: 168 chests had another
// chest stacked directly on top, and A* returned "No path to the goal!" 203
// times while the bot stood 5.5 to 7.6 blocks away. safeMoves cannot dig, so
// there was no route and no way to make one.
test("digs to a chest the pathfinder could not route to", () => {
  for (const d of [5.5, 6.6, 7.4, 7.6]) {
    assert.equal(shouldDigToChest(d, true), true, `observed give-up distance ${d} must be recoverable`);
  }
});

test("does not dig when the walk actually succeeded", () => {
  assert.equal(shouldDigToChest(7.0, false), false);
});

test("does not dig when already in reach", () => {
  // Opening works from here; breaking blocks would be pointless and destructive.
  assert.equal(shouldDigToChest(4.5, true), false);
  assert.equal(shouldDigToChest(1.1, true), false);
});

test("a failed path never becomes a cross-map tunnel", () => {
  assert.equal(shouldDigToChest(DIG_APPROACH_MAX, true), true, "boundary is inclusive");
  assert.equal(shouldDigToChest(DIG_APPROACH_MAX + 0.1, true), false);
  assert.equal(shouldDigToChest(64, true), false);
});

test("an unmeasured distance is never dug toward", () => {
  assert.equal(shouldDigToChest(Number.NaN, true), false);
});

// findBlock returns only the NEAREST chest. When that one was walled in, the
// whole category was abandoned. Measured over one session: three distinct
// chests were ever targeted, one absorbed 64 consecutive failures, all 30
// post-dig attempts on it ended chest_unreachable, and none ever succeeded --
// while the stash holds hundreds of chests.
test("more than one chest is tried before a category is abandoned", () => {
  assert.ok(CHEST_CANDIDATES > 1, "a single candidate is what caused 64 failures on one chest");
});

test("candidate count stays bounded so a deposit cannot wander the stash", () => {
  // Each candidate costs a walk plus a possible dig, inside the action watchdog.
  assert.ok(CHEST_CANDIDATES <= 6, `${CHEST_CANDIDATES} candidates would blow the action budget`);
});

// Blade is the swarm's fighter: his role has attack but NOT craft and NOT
// mine_block, so the stash is his only route to armour. He tried withdraw_stash
// 31 times in one session and withdrew nothing, because shouldKeep protected
// every iron piece unconditionally and the crafters hoarded their spares. He
// died 15 times that hour, all "slain by", all with Armor: -,-,-,-.
test("a bot keeps one of each armour piece and banks the spares", () => {
  const counts = new Map<string, number>();
  assert.equal(shouldKeep("iron_chestplate", [], counts, 1), true, "the one it wears");
  assert.equal(shouldKeep("iron_chestplate", [], counts, 1), false, "the spare goes to the fighter");
  assert.equal(shouldKeep("iron_chestplate", [], counts, 1), false);
});

test("each armour slot is tracked separately", () => {
  const counts = new Map<string, number>();
  for (const piece of ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"]) {
    assert.equal(shouldKeep(piece, [], counts, 1), true, `first ${piece} is kept`);
  }
  for (const piece of ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"]) {
    assert.equal(shouldKeep(piece, [], counts, 1), false, `second ${piece} is banked`);
  }
});

test("tools are still never deposited, at any count", () => {
  // The pickaxe rule below already handles quantity; this path must not start
  // banking the tool a bot is actively using.
  const counts = new Map<string, number>();
  assert.equal(shouldKeep("iron_pickaxe", [], counts, 1), true);
  assert.equal(shouldKeep("iron_sword", [], counts, 1), true);
  assert.equal(shouldKeep("diamond_sword", [], counts, 1), true);
});

test("better-tier armour is still kept even after a spare of another tier", () => {
  // Diamond and iron are different item names, so each gets its own slot budget.
  const counts = new Map<string, number>();
  assert.equal(shouldKeep("iron_chestplate", [], counts, 1), true);
  assert.equal(shouldKeep("diamond_chestplate", [], counts, 1), false, "same slot, already covered");
});

// Raw ore cannot be crafted into anything. It has to be smelted first, usually
// by a different bot, so the stash is the hand-off. Measured over one 2h42m
// session: 20 iron ore mined, ZERO raw_iron reaching the stash, smelt_ores
// reporting "Nothing to smelt" 27 times, craft_gear seeing 0-2 ingots every
// run, zero armour crafted, 13 of 18 deaths with no armour.
test("raw ore is banked so the smelter can reach it", () => {
  const counts = new Map<string, number>();
  assert.equal(shouldKeep("raw_iron", [], counts, 8), false, "raw ore belongs in the stash");
  assert.equal(shouldKeep("raw_gold", [], counts, 8), false);
  assert.equal(shouldKeep("raw_copper", [], counts, 8), false);
});

test("smelted materials are still reserved for crafting", () => {
  // The reserve exists so a bot can craft without a stash trip. Ingots can be
  // crafted; ore cannot, which is the whole distinction.
  const counts = new Map<string, number>();
  assert.equal(shouldKeep("iron_ingot", [], counts, 4), true);
  assert.equal(shouldKeep("diamond", [], counts, 2), true);
});

test("the ingot reserve still caps and pools the surplus", () => {
  const counts = new Map<string, number>();
  assert.equal(shouldKeep("iron_ingot", [], counts, KEEP_MATERIAL_RESERVE), true);
  assert.equal(shouldKeep("iron_ingot", [], counts, 20), false, "surplus ingots still pool");
});

// THE ADVICE PATH KEPT THE BUG THE CODE PATH FIXED.
//
// shouldAttemptExpansion was corrected to fire only on no_chest_found, because
// adding a chest cannot make an existing, located, adjacent chest open. That
// reasoning was never applied to the MESSAGE, which said "the stash may need
// expanding" for all three causes off the same merged counter.
//
// The brain reads the message, not the gate. Over one 1h49m session:
//
//   86  "the stash may need expanding, or its chests are out of range"
//   30  Crafted chest        <- the single largest craft of the session
//    0  Smelted anything     <- while 34 iron ore sat unprocessed
//
// It is a feedback loop, not just wasted effort: unreachable chests read as
// "full", the brain crafts more chests, the maze gets denser, more chests fall
// out of reach. It is the same chest maze that drowned Mason under a ceiling
// the escape was forbidden to dig.
test("advice never suggests expanding when a chest was found but unusable", () => {
  for (const cause of ["chest_unreachable", "chest_open_failed"] as const) {
    const advice = depositFailureAdvice(new Map([[cause, 5]]));
    assert.doesNotMatch(advice, /expand|another chest|craft a chest/i, `${cause}: must not ask for more chests`);
    assert.match(advice, /reach|open|blocked|clear/i, `${cause}: must describe the real obstruction`);
  }
});

test("advice does suggest a chest when no chest serves the category", () => {
  const advice = depositFailureAdvice(new Map([["no_chest_found", 3]]));
  assert.match(advice, /chest/i, "a missing chest is the one case another chest fixes");
});

// A mixed bag must follow the DOMINANT cause. Merging them is what produced the
// original bug: one no_chest_found among twenty unreachables read as "expand".
test("mixed causes follow the dominant one, not the presence of any", () => {
  const mostlyUnreachable = new Map([
    ["chest_unreachable", 20],
    ["no_chest_found", 1],
  ] as const);
  assert.doesNotMatch(depositFailureAdvice(mostlyUnreachable), /expand/i);

  const mostlyMissing = new Map([
    ["no_chest_found", 20],
    ["chest_unreachable", 1],
  ] as const);
  assert.match(depositFailureAdvice(mostlyMissing), /chest/i);
});

test("no recorded failures yields no advice to act on", () => {
  assert.equal(depositFailureAdvice(new Map()), "");
});

// ── The Nether kit stays with the bot ───────────────────────────────────────
//
// Neither the bucket nor the igniter had a keep rule, so every deposit trip
// donated them to the chest and the portal failed "missing bucket,
// flint_and_steel" — the bot re-ground four iron for a kit it already owned.

test("one bucket stays, whatever it is filled with; spares are banked", () => {
  const counts = new Map<string, number>();
  assert.equal(shouldKeep("lava_bucket", [], counts), true, "the first bucket is the kit");
  assert.equal(shouldKeep("bucket", [], counts), false, "a second bucket is surplus");
  assert.equal(shouldKeep("water_bucket", [], counts), false, "so is a third, full or not");
});

test("one flint_and_steel stays; spares are banked", () => {
  const counts = new Map<string, number>();
  assert.equal(shouldKeep("flint_and_steel", [], counts), true);
  assert.equal(shouldKeep("flint_and_steel", [], counts), false);
});

test("shouldDigToChest refuses chests on another level", () => {
  assert.equal(shouldDigToChest(6, true, 0), true);
  assert.equal(shouldDigToChest(6, true, 1), true);
  assert.equal(shouldDigToChest(6, true, -5), false, "a chest five blocks down means a pit");
  assert.equal(shouldDigToChest(6, true, 6), false, "a chest six blocks up means a shaft");
});
