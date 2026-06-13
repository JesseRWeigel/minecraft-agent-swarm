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
}

/**
 * Shared stash position — a few blocks from the team safeSpawn so every bot
 * agrees where "The Stash" is. setup_stash ground-snaps the Y at runtime,
 * so this Y only needs to be close enough for pathfinding.
 */
export const STASH_POS = { x: 286, y: 70, z: -314 };

/**
 * The farm site — on the river nearest the village (located via
 * `locate biome minecraft:river`; the earlier "lake" coords were wrong).
 * build_farm travels here first; rivers sit at sea level, hence y=63.
 */
export const FARM_SITE = { x: 290, y: 71, z: -312 };

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
  allowedSkills: [],
  keepItems: [
    { name: "sword", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "torch", minCount: 8 },
  ],
  priorities: `ATLAS PRIORITIES:
1. If health < 6 and hostile mob nearby: flee
2. If hungry (food < 14): eat
3. Explore new territory — you are the team's eyes
4. Mark ore veins and interesting locations for teammates
5. gather_wood if team bulletin shows stash is low on logs
6. When inventory is 30+ full: deposit_stash`,
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
  allowedActions: ["craft", "eat", "sleep", "go_to", "place_block", "chat"],
  allowedSkills: ["build_farm", "craft_gear", "smelt_ores", "light_area"],
  keepItems: [
    { name: "hoe", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "seeds", minCount: 16 },
  ],
  priorities: `FLORA PRIORITIES — THE FARM IS YOUR LIFE'S WORK:
1. If health < 6 and hostile mob nearby: flee
2. If hungry (food < 14): eat
3. NO FARM YET? This is your #1 job and it MUST be near water. The village
   has no water — there is an irrigation bed with water at the village (290, 71, -312). go_to it,
   THEN invoke_skill build_farm. It crafts the hoe and finds seeds itself.
4. If the farm exists and wheat is mature: build_farm again (harvests + replants).
5. If inventory has raw ore: smelt_ores
6. When inventory is 30+ full: deposit_stash
7. Do NOT build houses — Mason builds. Do NOT chase distant teammates.`,
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
  allowedActions: ["mine_block", "go_to", "eat", "sleep", "craft", "chat", "flee"],
  allowedSkills: ["strip_mine", "smelt_ores", "craft_gear"],
  keepItems: [
    { name: "pickaxe", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "torch", minCount: 8 },
    { name: "bucket", minCount: 1 },
  ],
  priorities: `FORGE PRIORITIES:
1. If health < 6: flee to surface, eat
2. If hungry (food < 14): eat
3. If have pickaxe: strip_mine for iron, coal, diamonds
4. If no pickaxe: craft_gear
5. If inventory has raw ore and furnace nearby: smelt_ores
6. When inventory is 30+ full: deposit_stash
7. If stash is low on cobblestone/iron: prioritize mining those`,
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
  allowedActions: ["go_to", "place_block", "craft", "gather_wood", "eat", "sleep", "chat"],
  allowedSkills: ["build_house", "build_bridge", "light_area", "build_farm", "setup_stash"],
  keepItems: [
    { name: "axe", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "torch", minCount: 16 },
  ],
  priorities: `MASON PRIORITIES:
1. If health < 6: flee, eat
2. If hungry (food < 14): eat
3. FIRST PRIORITY: If no stash chest within 8 blocks of stash position: setup_stash
4. If teammate reports stash is full: craft + place more chests at stash
5. If no shelter within 80 blocks: build_house
6. light_area around structures
7. build_bridge if team needs water crossing
8. When inventory is 30+ full: deposit_stash
9. withdraw_stash for building materials when needed`,
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
  allowedActions: ["attack", "flee", "go_to", "eat", "sleep", "chat"],
  allowedSkills: ["neural_combat", "craft_gear"],
  keepItems: [
    { name: "sword", minCount: 1 },
    { name: "shield", minCount: 1 },
    { name: "food", minCount: 8 },
    { name: "armor", minCount: 4 },
  ],
  priorities: `BLADE PRIORITIES:
1. If hostile mob within 16 blocks: neural_combat
2. If health < 6: eat, then re-engage
3. If hungry (food < 14): eat
4. If no sword or armor: craft_gear or withdraw_stash
5. Patrol near teammates — check team bulletin for who is furthest from base
6. Hunt passive mobs (pigs, cows) for food supply → deposit_stash
7. At night: patrol perimeter near base, kill hostiles`,
};

/** All bot configs in startup order. */
export const BOT_ROSTER: BotRoleConfig[] = [ATLAS_CONFIG, FLORA_CONFIG, FORGE_CONFIG, MASON_CONFIG, BLADE_CONFIG];
