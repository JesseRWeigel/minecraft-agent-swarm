/**
 * Stash ledger — real-time view of what's in the team stash.
 *
 * Bots can't read chest contents without opening them, but the stash code
 * opens chests on every deposit/withdraw — so we snapshot actual contents
 * at each interaction. The dashboard's STASH STATUS panel (previously a
 * hardcoded "--" stub) reads the aggregate from here.
 */

export interface ChestSnapshot {
  /** "x,y,z" */
  pos: string;
  items: { name: string; count: number }[];
  usedSlots: number;
  totalSlots: number;
  updatedAt: number;
}

const chests = new Map<string, ChestSnapshot>();

const CATEGORY_MATCHERS: { key: string; match: (n: string) => boolean }[] = [
  {
    key: "building",
    match: (n) =>
      n.endsWith("_log") ||
      n.endsWith("_planks") ||
      n.includes("cobblestone") ||
      n === "stone" ||
      n === "dirt" ||
      n === "glass" ||
      n === "sand" ||
      n.endsWith("_stairs") ||
      n.endsWith("_slab"),
  },
  {
    key: "metal",
    match: (n) =>
      n.includes("iron") ||
      n.includes("copper") ||
      n.includes("gold") ||
      n === "coal" ||
      n === "charcoal" ||
      n.includes("diamond"),
  },
  {
    key: "food",
    match: (n) =>
      ["bread", "wheat", "apple", "carrot", "potato", "beetroot", "egg", "sugar"].some((f) => n.includes(f)) ||
      n.includes("beef") ||
      n.includes("porkchop") ||
      n.includes("chicken") ||
      n.includes("mutton") ||
      n.includes("seeds"),
  },
  {
    key: "tools",
    match: (n) =>
      ["pickaxe", "axe", "sword", "shovel", "hoe", "helmet", "chestplate", "leggings", "boots", "shield", "bow"].some(
        (t) => n.includes(t),
      ),
  },
];

/** Record actual chest contents whenever a bot has one open. */
export function snapshotChest(
  pos: { x: number; y: number; z: number },
  items: { name: string; count: number }[],
  totalSlots = 27,
): void {
  const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
  chests.set(key, {
    pos: key,
    items: items.map((i) => ({ name: i.name, count: i.count })),
    usedSlots: items.length,
    totalSlots,
    updatedAt: Date.now(),
  });
}

export interface StashSummary {
  categories: Record<string, number>;
  freeSlots: number;
  totalSlots: number;
  chestCount: number;
  topItems: { name: string; count: number }[];
  updatedAt: number | null;
}

/** Aggregate across all known stash chests — consumed by the dashboard. */
export function getStashSummary(): StashSummary {
  const categories: Record<string, number> = { building: 0, metal: 0, food: 0, tools: 0, other: 0 };
  const itemTotals = new Map<string, number>();
  let usedSlots = 0;
  let totalSlots = 0;
  let updatedAt: number | null = null;

  for (const chest of chests.values()) {
    usedSlots += chest.usedSlots;
    totalSlots += chest.totalSlots;
    updatedAt = Math.max(updatedAt ?? 0, chest.updatedAt);
    for (const item of chest.items) {
      itemTotals.set(item.name, (itemTotals.get(item.name) ?? 0) + item.count);
      const cat = CATEGORY_MATCHERS.find((c) => c.match(item.name));
      categories[cat?.key ?? "other"] += item.count;
    }
  }

  const topItems = [...itemTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => ({ name, count }));

  return {
    categories,
    freeSlots: totalSlots - usedSlots,
    totalSlots,
    chestCount: chests.size,
    topItems,
    updatedAt,
  };
}
