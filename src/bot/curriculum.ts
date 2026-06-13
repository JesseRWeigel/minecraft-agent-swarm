/**
 * Tech-tree curriculum — Voyager-style automatic next-goal proposal.
 *
 * Instead of relying solely on fixed role priorities, the brain injects a
 * deterministic "where you are / what's next" line computed from the bot's
 * actual inventory. This gives every strategic decision a concrete
 * progression target (wood age → stone → iron → diamond) without
 * restricting the LLM's freedom to handle survival or role work first.
 */

import type { Bot } from "mineflayer";

interface TechStage {
  name: string;
  /** Does the bot's inventory satisfy this stage? */
  reached: (inv: Set<string>, counts: Map<string, number>) => boolean;
  /** Concrete suggestion for how to reach this stage (shown when it's next). */
  suggestion: string;
}

/** Ordered ladder — the first unreached stage is the proposed next goal. */
const TECH_LADDER: TechStage[] = [
  {
    name: "wood",
    reached: (inv) => [...inv].some((n) => n.endsWith("_log") || n.endsWith("_planks")),
    suggestion: "gather_wood to collect logs",
  },
  {
    name: "crafting table",
    reached: (inv) => inv.has("crafting_table"),
    suggestion: 'craft {"item":"crafting_table"} (needs 4 planks — craft planks from logs first)',
  },
  {
    name: "wooden tools",
    reached: (inv) => [...inv].some((n) => n.startsWith("wooden_")),
    suggestion: 'craft {"item":"wooden_pickaxe"} (3 planks + 2 sticks)',
  },
  {
    name: "stone tools",
    reached: (inv) => [...inv].some((n) => n.startsWith("stone_") && n !== "stone"),
    suggestion: 'mine_block {"blockType":"stone"} x3 then craft {"item":"stone_pickaxe"}',
  },
  {
    name: "furnace",
    reached: (inv) => inv.has("furnace"),
    suggestion: 'craft {"item":"furnace"} (8 cobblestone)',
  },
  {
    name: "iron",
    reached: (inv) => inv.has("iron_ingot") || [...inv].some((n) => n.startsWith("iron_") && n !== "iron_ore"),
    suggestion: 'mine_block {"blockType":"iron_ore"} (need stone pickaxe), then smelt_ores',
  },
  {
    name: "iron tools",
    reached: (inv) => [...inv].some((n) => n.startsWith("iron_") && n !== "iron_ingot" && n !== "iron_ore"),
    suggestion: 'craft {"item":"iron_pickaxe"} (3 iron ingots + 2 sticks)',
  },
  {
    name: "diamonds",
    reached: (inv) => inv.has("diamond"),
    suggestion: "strip_mine deep (Y=-58) with an iron pickaxe to find diamonds",
  },
];

/** Flora's ladder — farming progression, not mining. */
const FARM_LADDER: TechStage[] = [
  {
    name: "wood for the hoe",
    reached: (inv) => [...inv].some((n) => n.endsWith("_log") || n.endsWith("_planks")),
    suggestion: "gather_wood (or ask a teammate to give_item planks)",
  },
  {
    name: "a hoe",
    reached: (inv) => [...inv].some((n) => n.endsWith("_hoe")),
    suggestion: 'craft {"item":"wooden_hoe"} (2 planks + 2 sticks)',
  },
  {
    name: "seeds",
    reached: (inv) => [...inv].some((n) => n.includes("seeds")),
    suggestion: "break tall grass near the village for wheat seeds (build_farm also collects them)",
  },
  {
    name: "the farm",
    reached: () => false, // completion is recorded by the skill itself; keep pushing
    suggestion: "go_to the irrigation bed at (290, 71, -312), then invoke_skill build_farm — water is there",
  },
];

/** Blade's ladder — fighting kit, not pickaxes. */
const COMBAT_LADDER: TechStage[] = [
  {
    name: "a sword",
    reached: (inv) => [...inv].some((n) => n.endsWith("_sword")),
    suggestion: 'craft {"item":"wooden_sword"} (2 planks + 1 stick) — upgrade to stone/iron when possible',
  },
  {
    name: "armor",
    reached: (inv) => [...inv].some((n) => n.includes("chestplate") || n.includes("helmet")),
    suggestion: "withdraw_stash iron, or hunt mobs while Forge smelts armor materials",
  },
  {
    name: "patrol duty",
    reached: () => false,
    suggestion: "patrol the village perimeter at The Stash; hunt food animals; neural_combat on hostiles",
  },
];

const ROLE_LADDERS: Record<string, TechStage[]> = {
  "Farmer / Crafter": FARM_LADDER,
  "Combat / Guard": COMBAT_LADDER,
};

/**
 * One-line tech status for the strategic context, e.g.:
 * "TECH TREE: reached [wood, crafting table]. NEXT: wooden tools — craft {...}"
 * Role-aware: the farmer gets a farming ladder, the guard a combat ladder —
 * the generic mining ladder was steering Flora toward copper ore.
 * Returns "" when the ladder is complete.
 */
export function getTechTreeLine(bot: Bot, role?: string): string {
  let inv: Set<string>;
  const counts = new Map<string, number>();
  try {
    inv = new Set(bot.inventory.items().map((i) => i.name));
    for (const i of bot.inventory.items()) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  } catch {
    return "";
  }

  const ladder = (role && ROLE_LADDERS[role]) || TECH_LADDER;
  const reached: string[] = [];
  let next: TechStage | null = null;
  for (const stage of ladder) {
    if (stage.reached(inv, counts)) {
      reached.push(stage.name);
    } else if (!next) {
      next = stage;
    }
  }

  if (!next) return "TECH TREE: complete through diamonds. You are endgame — focus on your role and the mission.";
  const reachedStr = reached.length ? reached.join(", ") : "nothing yet";
  return `TECH TREE: reached [${reachedStr}]. NEXT MILESTONE: ${next.name} — ${next.suggestion}`;
}
