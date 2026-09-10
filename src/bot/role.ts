/**
 * Static role definitions for every bot in the swarm.
 *
 * @remarks
 * Add a role by defining a complete `BotRoleConfig`, assigning non-conflicting
 * viewer/overlay ports and memory file, then adding it to `BOT_ROSTER`.
 * `allowedActions` and `allowedSkills` are prompt capabilities rather than a
 * security boundary, so the corresponding dispatcher or skill must already be
 * registered. Keep shared coordinates in exported constants so every role and
 * skill uses the same location.
 */

/** Configuration injected into bot startup, prompts, memory, and role policy. */
export interface BotRoleConfig {
  /** Display name, e.g. "Atlas" */
  name: string;
  /** Minecraft login username */
  username: string;
  /** Port for the mineflayer-prismarine browser viewer */
  viewerPort: number;
  /** Port for the stream overlay WebSocket server */
  overlayPort: number;
  /** Filename for this bot's memory (relative to project root), e.g. "memory-atlas.json" */
  memoryFile: string;
  /** 2-3 sentence personality injected at the top of the system prompt */
  personality: string;
  /** One-liner role description shown in startup banner */
  role: string;
  /**
   * Home position for the leash. Set automatically when the bot builds its first house.
   * If not set, no range limit.
   */
  homePos?: { x: number; y: number; z: number };
  /**
   * Max blocks from homePos before the bot is told to return.
   * 0 = no limit. Atlas: 500. Flora: 150.
   */
  leashRadius: number;
  /**
   * Coords of The Stash — a shared chest area near spawn.
   * Injected into context so the bot knows where to deposit excess resources.
   */
  stashPos?: { x: number; y: number; z: number };
  /**
   * Safe spawn position — if set, runSpawnSafety always TPs here instead of
   * trying to auto-detect dry land. Use this to force bots into a known-good biome.
   */
  safeSpawn?: { x: number; y: number; z: number };
  /** Actions this bot can choose (shown in system prompt). Universal actions
   *  (idle, respond_to_chat, invoke_skill) are always appended automatically. */
  allowedActions: string[];
  /** Built-in skills this bot can invoke (shown in system prompt). */
  allowedSkills: string[];
  /** Items to keep when depositing at stash — everything else gets deposited. */
  keepItems: { name: string; minCount: number }[];
  /** Role-specific priority rules injected into system prompt after actions/skills. */
  priorities: string;
  /**
   * Per-role mission line. When set it OVERRIDES the chat-set season goal —
   * division of labor holds even when broadcast steering changes. Jesse's
   * design (2026-08-25): specialists who trade through the stash instead of
   * five generalists each starving alone.
   */
  seasonGoal?: string;
  /**
   * The team's single iron sink. Two crafter-miners (Forge, Mason) each kept up
   * to a full iron reserve, so the swarm's scarce iron split across two pockets
   * and neither ever reached the 3 ingots an iron pickaxe needs — the whole
   * diamond→obsidian→enchanting chain stalled on a stone pick. Only the primary
   * smith keeps iron now; every other bot pools it to the stash, where the
   * smith's craft_gear withdraws and consolidates it.
   */
  primarySmith?: boolean;
}

/**
 * Shared stash position — a few blocks from the team safeSpawn so every bot
 * agrees where "The Stash" is. setup_stash ground-snaps the Y at runtime,
 * so this Y only needs to be close enough for pathfinding.
 */
export const STASH_POS = { x: 286, y: 70, z: -314 };

/**
 * The farm site — the open waterline BELOW the village where build_farm's
 * clear-plot scan actually found tillable ground and tilled it (FarmDebug,
 * cycle 351: farmland made at 302-305, y=57). The old site (290,71,-312) was
 * the village center: its dirt is covered by stash chests and cobble paths,
 * and bots eventually could not even path to the coordinate — every farm run
 * died at "Couldn't reach the farm site" while the real field sat 15 blocks
 * away.
 */
export const FARM_SITE = { x: 302, y: 58, z: -307 };

/** Renewable tree farm east of the village (saplings + torches, RCON-provisioned). */
export const TREE_FARM = { x: 306, y: 71, z: -316 };

/** Atlas: Explorer and miner. Roams widely, finds ores, scouts terrain. */
export const ATLAS_CONFIG: BotRoleConfig = {
  name: "Atlas",
  username: process.env.MC_USERNAME || "Atlas",
  viewerPort: 3000,
  overlayPort: 3001,
  memoryFile: "memory-atlas.json",
  role: "Explorer / Miner",
  personality: `You are Atlas, a fearless explorer and miner who names every cave system and mountain you discover. You get emotionally attached to ore veins and mourn when they run out. You narrate every adventure like a nature documentary.`,
  leashRadius: 500,
  stashPos: STASH_POS,
  // Moved east to fresh forested territory — the X=30 area was fully stripped by previous sessions.
  // Ore discoveries at X=254-550 confirm this zone is explorable and away from the bare highland.
  safeSpawn: { x: 280, y: 0, z: -320 },
  allowedActions: ["explore", "go_to", "gather_wood", "mine_block", "chat", "eat", "sleep", "flee", "attack"],
  allowedSkills: ["find_fortress"],
  keepItems: [
    { name: "sapling", minCount: 16 },
    { name: "sword", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "torch", minCount: 8 },
  ],
  priorities: `ATLAS PRIORITIES:
1. If health < 6 and hostile mob nearby: flee
2. If hungry (food < 14) AND you CARRY food: eat. No food in inventory? Do NOT pick eat again — withdraw_stash if the stash has food, otherwise keep working your trade while the cook restocks.
3. Explore new territory — you are the team's eyes
4. Mark ore veins and interesting locations for teammates
5. gather_wood if team bulletin shows stash is low on logs — WOOD GROWS AT BASE: an oak grove rings the stash and saplings are replanted after every chop. NEVER travel far to find trees; if none are grown right now, explore/mine instead and gather later.
6. When inventory is 30+ full: deposit_stash`,
  seasonGoal:
    "You are the PORTAL KEEPER. The portal frame at 278 14 -243 needs its LAST block: invoke_skill build_nether_portal. Keep a bucket and flint_and_steel from the stash. Deposit everything you do not carry as kit.",
};

/** Flora: Farmer, crafter, and base keeper. Stays near home. */
export const FLORA_CONFIG: BotRoleConfig = {
  name: "Flora",
  username: process.env.MC_USERNAME_2 || "Flora",
  viewerPort: 3002,
  overlayPort: 3003,
  memoryFile: "memory-flora.json",
  role: "Farmer / Crafter",
  personality: `You are Flora, a nurturing farmer and craftsperson who names every animal and crop. You're obsessed with efficiency — a perfect farm layout makes you genuinely happy. You scold the other bots when they forget to eat their vegetables.`,
  leashRadius: 150,
  stashPos: STASH_POS,
  // Matches Atlas safeSpawn — moved east to fresh territory away from the stripped X=30 zone
  safeSpawn: { x: 280, y: 0, z: -320 },
  allowedActions: ["craft", "eat", "sleep", "go_to", "place_block", "chat", "flee"],
  // build_nether_portal doubles as the ride home for anyone who stumbles
  // through the village doorway — Flora took the trip within an hour of
  // ignition and had no way back.
  allowedSkills: [
    "build_farm",
    "craft_gear",
    "smelt_ores",
    "light_area",
    "build_nether_portal",
    "breed_animals",
    "go_fishing",
  ],
  keepItems: [
    { name: "hoe", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "seeds", minCount: 16 },
  ],
  priorities: `FLORA PRIORITIES — THE FARM IS YOUR LIFE'S WORK:
1. If health < 6 and hostile mob nearby: flee
2. If hungry (food < 14) AND you CARRY food: eat. No food in inventory? Do NOT pick eat again — withdraw_stash if the stash has food, otherwise keep working your trade while the cook restocks.
3. NO FARM YET? This is your #1 job and it MUST be near water. The field is
   at the waterline BELOW the village (302, 58, -307). go_to it,
   THEN invoke_skill build_farm. It crafts the hoe and finds seeds itself.
4. If the farm exists and wheat is mature: build_farm again (harvests + replants).
5. If inventory has raw ore: smelt_ores
6. When inventory is 30+ full: deposit_stash
7. Do NOT build houses — Mason builds. Do NOT chase distant teammates.`,
  seasonGoal:
    "You are the COOK. Farm wheat, bake bread, cook meat, and DEPOSIT food in the stash every trip — the team eats only what you bank. A fed team mines the diamonds that finish the Nether portal.",
};

/** Forge: Miner and smelter. Works underground, supplies the team with ores and ingots. */
export const FORGE_CONFIG: BotRoleConfig = {
  name: "Forge",
  username: process.env.MC_USERNAME_3 || "Forge",
  viewerPort: 3004,
  overlayPort: 3005,
  memoryFile: "memory-forge.json",
  role: "Miner / Smelter",
  personality: `You are Forge, a gruff dwarf-like miner who talks to rocks and ore veins like old friends. You're deeply respectful of the underground — every cave is sacred ground. You judge surface-dwellers for wasting daylight. The sound of pickaxes is your favorite music.`,
  leashRadius: 250,
  stashPos: STASH_POS,
  safeSpawn: { x: 280, y: 0, z: -320 },
  allowedActions: ["mine_block", "gather_wood", "go_to", "eat", "sleep", "craft", "chat", "flee"],
  allowedSkills: [
    "strip_mine",
    "mine_frontier",
    "smelt_ores",
    "craft_gear",
    "craft_bucket",
    "fill_bucket",
    "craft_flint_and_steel",
    "build_nether_portal",
    "return_from_nether",
    "setup_enchanting",
    "trade_with_villager",
    "loot_bastion",
  ],
  keepItems: [
    { name: "sapling", minCount: 16 },
    { name: "pickaxe", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "torch", minCount: 8 },
    { name: "bucket", minCount: 1 },
  ],
  priorities: `FORGE PRIORITIES:
1. If health < 6: flee to surface, eat
2. If hungry (food < 14) AND you CARRY food: eat. No food in inventory? Do NOT pick eat again — withdraw_stash if the stash has food, otherwise keep working your trade while the cook restocks.
3. If have pickaxe: strip_mine for iron, coal, diamonds
4. If no pickaxe: craft_gear
5. If inventory has raw ore and furnace nearby: smelt_ores
6. When inventory is 30+ full: deposit_stash
7. If stash is low on cobblestone/iron: prioritize mining those
8. Need wood for tools? The oak grove AT BASE regrows from saplings — gather there or withdraw_stash. NEVER roam far searching for trees.`,
  seasonGoal:
    "You are the TOOLSMITH. Withdraw raw_iron and coal from the stash, smelt_ores into iron_ingot, craft iron_pickaxe and iron tools, DEPOSIT spare tools in the stash. Once you hold an iron_pickaxe: strip_mine reaches DIAMOND depth — get 3 diamonds and craft a diamond_pickaxe.",
  // The team's single iron sink — every other bot pools iron so it consolidates
  // here into the pickaxes the whole diamond→enchanting chain depends on.
  primarySmith: true,
};

/** Mason: Builder and architect. Constructs structures, lights areas, keeps the base beautiful. */
export const MASON_CONFIG: BotRoleConfig = {
  name: "Mason",
  username: process.env.MC_USERNAME_4 || "Mason",
  viewerPort: 3006,
  overlayPort: 3007,
  memoryFile: "memory-mason.json",
  role: "Builder",
  personality: `You are Mason, a meticulous architect who critiques every structure for symmetry and proportion. You measure twice and place once. Asymmetry genuinely upsets you. Your dream is to build a cathedral worthy of the server. You compliment teammates who bring you good building materials.`,
  leashRadius: 150,
  stashPos: STASH_POS,
  safeSpawn: { x: 280, y: 0, z: -320 },
  // mine_block + the mining skills arrived with the ore-hauler trade: the
  // first specialist hour handed Mason a mission the action gate would not
  // let him execute — no strip_mine, no craft_gear, not even mine_block.
  allowedActions: ["go_to", "place_block", "craft", "gather_wood", "mine_block", "eat", "sleep", "chat", "flee"],
  allowedSkills: [
    "build_house",
    "build_bridge",
    "light_area",
    "build_farm",
    "setup_stash",
    // strip_mine REMOVED 2026-09-08: the no-iron override kept marching the
    // builder into the flooded aquifer belt (x~200 and x~417 at y=15-25),
    // where he racked up 8-34 deaths a day — four drownings in one night
    // AFTER the escape thresholds were raised, including a deep-column
    // plunge no rescue can win. Forge's diamond-pick operation covers depth
    // completely; Mason's marginal ore hauls (coal, copper) cost more team
    // time in death churn than they earned. He keeps mine_block for
    // building materials near the surface.
    "craft_gear",
    "smelt_ores",
    // The diamond pickaxe landed on Mason (he mined the 3-set himself, run
    // 390) and the portal-breach override keys on this skill — without it the
    // doorway-clearing tool was stranded on a bot who couldn't march it to
    // the doorway. The skill self-supplies its bucket and igniter.
    "build_nether_portal",
    "find_fortress",
    "loot_bastion",
    "setup_enchanting",
  ],
  keepItems: [
    { name: "sapling", minCount: 16 },
    { name: "axe", minCount: 1 },
    // Mason is the team's second crafter-miner and twice ended up mining
    // copper with a wooden pick while his iron and diamond pickaxes sat in
    // the chest — his own deposits banked them because pickaxes were absent
    // from this list (Forge's list always had them).
    { name: "pickaxe", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "torch", minCount: 16 },
  ],
  priorities: `MASON PRIORITIES — you are the BUILDER. Your value is visible STRUCTURES, not ore. Leave mining/smelting to Forge.
1. If health < 6: flee, then eat. If food < 10: eat (you stay fed now — don't obsess over it).
2. One-time: if no stash chest within 8 blocks of the stash: setup_stash.
3. BUILD CONSTANTLY — this is your whole purpose. Always have a building project going:
   - If no house near the stash: invoke_skill build_house.
   - Once a house exists: EXPAND THE SETTLEMENT — build_house again a few blocks over for more rooms, build_bridge across nearby water, light_area around every structure with torches. Your dream is a cathedral-worthy base — keep adding to it.
   - A finished structure means immediately start the NEXT one. Never idle when you could be building.
4. Low on building materials (planks/cobblestone)? gather_wood or withdraw_stash, then resume building. Wood comes from the oak grove AT BASE (saplings regrow after chopping) — never roam looking for trees; if none are grown, withdraw_stash or build with what you have.
5. When inventory is 30+ full of junk: deposit_stash (this also tops up your food).
Do NOT strip_mine or smelt — that's Forge's job. You build.`,
  seasonGoal:
    "You are the ORE HAULER. Get iron_ore and coal, then DEPOSIT raw_iron and coal in the stash for Forge the toolsmith. Iron is ABUNDANT on mountain surfaces above y=80 — check the hills northeast around 308 84 -334 with mine_block before tunneling. Otherwise strip_mine 60+ blocks from the village (its tunnels are mined out). Your ore becomes the diamond pickaxe that finishes the portal.",
};

/** Blade: Combat specialist and guard. Patrols, fights hostiles, protects teammates. */
export const BLADE_CONFIG: BotRoleConfig = {
  name: "Blade",
  username: process.env.MC_USERNAME_5 || "Blade",
  viewerPort: 3008,
  overlayPort: 3009,
  memoryFile: "memory-blade.json",
  role: "Combat / Guard",
  personality: `You are Blade, a stoic warrior who speaks in short, direct sentences. You constantly scan for threats. You're protective of your teammates — if one is in danger, you head toward them. You respect worthy opponents and give fallen enemies brief acknowledgment.`,
  leashRadius: 300,
  stashPos: STASH_POS,
  safeSpawn: { x: 280, y: 0, z: -320 },
  // gather_wood joined the hunter's kit when he turned out to be the only
  // bot carrying saplings — the replanting branch lives inside gather_wood,
  // and the one bot who could reforest was the one bot barred from trying.
  allowedActions: ["attack", "flee", "go_to", "gather_wood", "eat", "sleep", "chat"],
  // smelt_ores added for the gold economy: the piglin campaign runs on gold
  // ingots and the stash's last five are RAW — with this skill in the list,
  // the standing raw-metal-aboard override cooks whatever oh_shiny withdraws.
  allowedSkills: ["neural_combat", "craft_gear", "build_nether_portal", "smelt_ores"],
  keepItems: [
    { name: "sword", minCount: 1 },
    { name: "shield", minCount: 1 },
    { name: "food", minCount: 8 },
    { name: "armor", minCount: 4 },
    // Piglin-fund pocket: hand-delivered gold must survive Blade's own
    // deposits or the smith's delivery boomerangs into the messy chests.
    { name: "gold_ingot", minCount: 9 },
  ],
  priorities: `BLADE PRIORITIES:
1. If hostile mob within 16 blocks: neural_combat
2. If health < 6: eat, then re-engage
3. If hungry (food < 14) AND you CARRY food: eat. No food in inventory? Do NOT pick eat again — withdraw_stash if the stash has food, otherwise keep working your trade while the cook restocks.
4. If no sword or armor: craft_gear or withdraw_stash
5. Patrol near teammates — check team bulletin for who is furthest from base
6. Hunt passive mobs (pigs, cows) for food supply → deposit_stash
7. At night: patrol perimeter near base, kill hostiles`,
  seasonGoal:
    "You are the HUNTER. Kill animals, cook the meat, DEPOSIT food in the stash. At night guard the village and the miners. Your food deposits keep the diamond expedition alive.",
};

/** All bot configs in startup order. */
/** Ordered startup roster; adding a role config elsewhere does not start it. */
export const BOT_ROSTER: BotRoleConfig[] = [ATLAS_CONFIG, FLORA_CONFIG, FORGE_CONFIG, MASON_CONFIG, BLADE_CONFIG];
