/**
 * Converts live Mineflayer state into compact text consumed by the decision
 * prompts.
 *
 * @remarks
 * Extend perception by deriving a bounded signal from the bot, then appending
 * one concise line to `parts` in `getWorldContext`. Keep scans small because
 * this function runs in the decision loop. Add globally interesting blocks to
 * `NOTABLE_BLOCKS`; add entity families through `HOSTILE_MOBS` or
 * `PASSIVE_MOBS`. New wording should be covered in `perception.test.ts` because
 * it becomes part of the model's behavioral contract.
 */
import { recordNest } from "./nests.js";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { recordOre } from "./memory.js";
import { miningReachLine, bestPickaxeName } from "./mining-reach.js";
import { undergroundNote } from "./underground.js";

/**
 * Builds the newline-delimited world snapshot supplied to the LLM.
 *
 * @param bot - Bot whose position, vitals, inventory, entities, and blocks are read.
 * @param role - Optional role name used to make underground guidance role-aware.
 * @returns Stable, human-readable context with urgent warnings included only
 * when their conditions are present.
 */
export function getWorldContext(bot: Bot, role?: string): string {
  const pos = bot.entity.position;
  const health = bot.health;
  const food = bot.food;
  const time = bot.time.timeOfDay;
  const isDay = time < 13000 || time > 23000;
  const timeStr = isDay ? "daytime" : "nighttime";

  // Inventory summary
  const items = bot.inventory.items();
  const invSummary = items.length > 0 ? items.map((i) => `${i.name}x${i.count}`).join(", ") : "empty";

  // Nearby entities
  const nearbyEntities = getNearbyEntities(bot, 16);
  const hostiles = nearbyEntities.filter((e) => isHostile(e));
  const players = nearbyEntities.filter((e) => e.type === "player" && e.username !== bot.username);
  const animals = nearbyEntities.filter((e) => isPassive(e));

  // Nearby blocks (what's around us)
  const nearbyBlocks = getNearbyBlockTypes(bot);

  const parts: string[] = [
    `Position: ${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)}`,
    `Health: ${health}/20, Hunger: ${food}/20`,
    `Time: ${timeStr} (${time})`,
    `Inventory: ${invSummary}`,
  ];

  if (hostiles.length > 0) {
    parts.push(
      `DANGER - Hostile mobs nearby: ${hostiles.map((e) => `${e.name || "mob"} (${distTo(bot, e).toFixed(0)} blocks away)`).join(", ")}`,
    );
  }

  if (players.length > 0) {
    parts.push(`Players nearby: ${players.map((e) => e.username).join(", ")}`);
  }

  if (animals.length > 0) {
    parts.push(`Animals nearby: ${animals.map((e) => e.name || "animal").join(", ")}`);
  }

  if (nearbyBlocks.length > 0) {
    parts.push(`Nearby notable blocks: ${nearbyBlocks.join(", ")}`);
    // Which of those can actually be harvested with what's in the bag. Without
    // this, five different models all chose mine_block iron_ore while holding a
    // wooden pickaxe -- the block list said the ore was there and nothing said
    // it was out of reach. tool-tier.ts knew, but only checked after the dig.
    const reach = miningReachLine(nearbyBlocks, bestPickaxeName(items.map((i) => i.name)));
    if (reach) parts.push(reach);
  }

  if (food <= 6) {
    parts.push("WARNING: Very hungry! Should eat soon.");
  }

  if (health <= 8) {
    parts.push("WARNING: Low health! Be careful.");
  }

  if (!isDay) {
    parts.push("It's night — hostile mobs spawn in the dark. Consider shelter or a bed.");
  }

  // Water/ocean detection
  const feetBlock = bot.blockAt(pos);
  const headBlock = bot.blockAt(pos.offset(0, 1, 0));
  if (feetBlock?.name === "water" || headBlock?.name === "water") {
    parts.push(
      "ALERT: Bot is IN WATER (ocean/river/lake). Use the 'explore' action to escape to dry land IMMEDIATELY — do NOT craft, build, or idle while underwater.",
    );
  }

  // Underground detection: if Y < 80 and no sky access within 20 blocks, bot is underground
  const feetInWater = bot.blockAt(pos)?.name === "water";
  if (!feetInWater && pos.y < 80) {
    // Scan upward for sky (first non-air block above indicates no sky access)
    let skyAccessY = -1;
    for (let dy = 1; dy <= 20; dy++) {
      const b = bot.blockAt(pos.offset(0, dy, 0));
      if (!b || b.name === "air") continue;
      skyAccessY = dy;
      break;
    }
    if (skyAccessY !== -1 && skyAccessY <= 10) {
      // Solid block within 10 blocks above — definitely underground
      // Was an unconditional order to surface, which sent the Miner/Smelter
      // climbing out of the mine it had just dug. See underground.ts.
      parts.push(undergroundNote(pos.y, skyAccessY, role));
    } else if (skyAccessY === -1) {
      // No ceiling within 20 blocks — might be in open-air at low elevation
      parts.push(
        `NOTE: Bot is at low elevation (Y=${pos.y.toFixed(0)}). If no trees nearby, use 'explore' to find forested land.`,
      );
    }
  }

  return parts.join("\n");
}

function getNearbyEntities(bot: Bot, range: number): Entity[] {
  if (!bot.entity?.position) return [];
  return Object.values(bot.entities).filter((e) => {
    if (e === bot.entity) return false;
    if (!e.position) return false;
    return distTo(bot, e) <= range;
  });
}

function distTo(bot: Bot, entity: Entity): number {
  if (!bot.entity?.position || !entity.position) return Infinity;
  return bot.entity.position.distanceTo(entity.position);
}

const HOSTILE_MOBS = new Set([
  "zombie",
  "skeleton",
  "creeper",
  "spider",
  "enderman",
  "witch",
  "phantom",
  "drowned",
  "husk",
  "stray",
  "blaze",
  "ghast",
  "wither_skeleton",
  "piglin_brute",
  "warden",
  "pillager",
  "vindicator",
  "evoker",
  "ravager",
  "slime",
  "magma_cube",
]);

const PASSIVE_MOBS = new Set([
  "cow",
  "pig",
  "sheep",
  "chicken",
  "horse",
  "donkey",
  "rabbit",
  "wolf",
  "cat",
  "fox",
  "mooshroom",
  "parrot",
  "turtle",
  "bee",
  "goat",
  "frog",
  "axolotl",
  "camel",
  "sniffer",
]);

/**
 * Entity type id, lowercased, for matching against the mob sets.
 * Uses ONLY entity.name — never entity.mobType, which is a deprecated getter
 * that emits a console.trace warning on every access (it spammed ~tens of
 * thousands of stack traces per run through this hot path, bloating logs to
 * 280MB+ and masquerading as "attackNearest errors"). Defensive try/catch
 * returns "" on any bad entity ref — a nameless entity is safely treated as
 * neither hostile nor passive.
 */
function entityName(entity: Entity): string {
  try {
    return (entity?.name || "").toLowerCase();
  } catch {
    return "";
  }
}

/** Returns whether an entity's canonical Mineflayer name is a hostile mob. */
export function isHostile(entity: Entity): boolean {
  return HOSTILE_MOBS.has(entityName(entity));
}

/** Returns whether an entity's canonical Mineflayer name is a passive mob. */
export function isPassive(entity: Entity): boolean {
  return PASSIVE_MOBS.has(entityName(entity));
}

const NOTABLE_BLOCKS = new Set([
  "diamond_ore",
  "deepslate_diamond_ore",
  "iron_ore",
  "deepslate_iron_ore",
  "gold_ore",
  "deepslate_gold_ore",
  "coal_ore",
  "deepslate_coal_ore",
  "lapis_ore",
  "redstone_ore",
  "emerald_ore",
  "crafting_table",
  "furnace",
  "chest",
  "bed",
  "enchanting_table",
  "anvil",
  "brewing_stand",
  "spawner",
  "village_bell",
  "bee_nest",
  "beehive",
]);

function getNearbyBlockTypes(bot: Bot): string[] {
  const found = new Set<string>();
  const pos = bot.entity.position;

  for (let dx = -8; dx <= 8; dx += 2) {
    for (let dy = -4; dy <= 4; dy += 2) {
      for (let dz = -8; dz <= 8; dz += 2) {
        const block = bot.blockAt(pos.offset(dx, dy, dz));
        if (block && (block.name === "bee_nest" || block.name === "beehive")) {
          recordNest(block.position.x, block.position.y, block.position.z);
        }
        if (block && NOTABLE_BLOCKS.has(block.name)) {
          found.add(block.name);
          if (block.name.includes("ore")) {
            recordOre(block.name, pos.x + dx, pos.y + dy, pos.z + dz);
          }
        }
      }
    }
  }

  return Array.from(found);
}
