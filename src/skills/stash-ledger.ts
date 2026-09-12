/**
 * Stash ledger — real-time view of what's in the team stash.
 *
 * Bots can't read chest contents without opening them, but the stash code
 * opens chests on every deposit/withdraw — so we snapshot actual contents
 * at each interaction. The dashboard's STASH STATUS panel (previously a
 * hardcoded "--" stub) reads the aggregate from here.
 */

import fs from "node:fs";

export interface ChestSnapshot {
  /** "x,y,z" */
  pos: string;
  items: { name: string; count: number }[];
  usedSlots: number;
  totalSlots: number;
  updatedAt: number;
}

const chests = new Map<string, ChestSnapshot>();

// ── Disk persistence ────────────────────────────────────────────────────────
// The ledger used to be per-process, and the swarm restarts hourly — every
// restart wiped all chest knowledge, so withdrawals fell back to blind
// position-order scans that exhaust their 110s budget a dozen chests into a
// 60-chest sprawl. That is how the team's ONLY diamond pickaxe sat banked
// and unfindable while Forge logged "0/1 diamond_pickaxe" scan after scan.
// Entries can go stale (contents change while unobserved); the withdraw
// verifies on open, so a stale hint still beats no hint.
const LEDGER_FILE = new URL("../../logs/stash-ledger.json", import.meta.url).pathname;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function persistLedger(): Promise<void> {
  try {
    await fs.promises.writeFile(LEDGER_FILE, JSON.stringify([...chests.values()]), "utf8");
  } catch {
    /* best effort — an unsaved ledger just means a blind scan next run */
  }
}

function schedulePersist(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persistLedger();
  }, 5_000);
  saveTimer.unref?.();
}

(function hydrateLedger() {
  try {
    // Synchronous on purpose: module init, before any bot logic runs.
    const raw = fs.readFileSync(LEDGER_FILE, "utf8");
    const snapshots = JSON.parse(raw) as ChestSnapshot[];
    for (const s of snapshots) {
      if (s && typeof s.pos === "string" && Array.isArray(s.items)) chests.set(s.pos, s);
    }
    if (chests.size > 0) console.log(`[Stash] ledger hydrated: ${chests.size} chests known from previous runs`);
  } catch {
    /* no ledger yet — first run or wiped logs */
  }
})();

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
  schedulePersist();
}

/**
 * Chest positions last seen holding an item whose name includes `matchName`,
 * most-recently-snapshotted first. Lets a withdrawal walk to the chest that
 * actually has the item instead of scanning a 60-chest sprawl in position
 * order until the watchdog fires.
 */
/** Total count of an item across ledger chests, optionally only those within 10 blocks of a y level. */
export function stashCount(matchName: string, nearY?: number): number {
  let n = 0;
  for (const chest of chests.values()) {
    const y = Number(chest.pos.split(",")[1]);
    if (nearY !== undefined && Math.abs(y - nearY) > 10) continue;
    for (const i of chest.items) if (i.name.includes(matchName)) n += i.count;
  }
  return n;
}

/** True once the ledger knows at least one chest (it is empty until the first open). */
export function ledgerKnown(): boolean {
  return chests.size > 0;
}

export function chestsWithItem(matchName: string): { x: number; y: number; z: number }[] {
  const hits: { pos: { x: number; y: number; z: number }; updatedAt: number }[] = [];
  for (const chest of chests.values()) {
    if (chest.items.some((i) => i.name.includes(matchName))) {
      const [x, y, z] = chest.pos.split(",").map(Number);
      hits.push({ pos: { x, y, z }, updatedAt: chest.updatedAt });
    }
  }
  return hits.sort((a, b) => b.updatedAt - a.updatedAt).map((h) => h.pos);
}

/**
 * Chest positions the ledger last saw with at least one free slot, emptiest
 * first. When a category's own chests are full, the deposit spills here
 * instead of giving up on the load — the deposit-side mirror of
 * chestsWithItem. Chests never yet opened this run are absent (the cache is
 * per-process), so this augments the category scan rather than replacing it.
 */
export function chestsWithSpace(): { x: number; y: number; z: number }[] {
  const open: { pos: { x: number; y: number; z: number }; free: number }[] = [];
  for (const chest of chests.values()) {
    const free = chest.totalSlots - chest.usedSlots;
    if (free > 0) {
      const [x, y, z] = chest.pos.split(",").map(Number);
      open.push({ pos: { x, y, z }, free });
    }
  }
  return open.sort((a, b) => b.free - a.free).map((o) => o.pos);
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
