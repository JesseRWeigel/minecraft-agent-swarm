// src/skills/fortress-bank.ts
// Which nether-brick sighting is worth marching to.
//
// The bank held exactly one sighting and every new one overwrote it. That cost
// the study its best route. The sighting at (535, 52, -17) had been approached
// to 84 blocks, the best of the whole run, and when Mason spotted bricks at
// (490, 51, 37) on 2026-09-21 the bank replaced the first with the second.
// Every march since has stalled at the portal exit with the gap stuck at 464
// to 466, because the new one has no route anyone has found, and the old one
// is gone.
//
// So the bank keeps them all, remembers how close each march actually got, and
// marches to the one with the best result so far. A sighting nobody has tried
// is judged by plain distance until it has a result of its own.

export interface Sighting {
  x: number;
  y: number;
  z: number;
  seenAt: string;
  by: string;
  /** Closest any march has come, in blocks. Absent until one has been tried. */
  bestGap?: number;
  /** How many marches have been spent on it. */
  attempts?: number;
  /** Set when the spot was reached and held no bricks. Kept for the audit. */
  droppedAt?: string;
}

/** Two sightings this close are the same structure seen twice. */
export const SAME_SIGHTING_BLOCKS = 16;

/** Live sightings, best first: a proven approach beats a hopeful guess. */
export function rankSightings(all: Sighting[], from: { x: number; z: number }): Sighting[] {
  const live = all.filter((s) => !s.droppedAt && typeof s.x === "number" && typeof s.z === "number");
  const score = (s: Sighting) => (typeof s.bestGap === "number" ? s.bestGap : Math.hypot(s.x - from.x, s.z - from.z));
  return [...live].sort((a, b) => score(a) - score(b));
}

/** The one to march to, or null when the bank holds nothing live. */
export function pickSighting(all: Sighting[], from: { x: number; z: number }): Sighting | null {
  return rankSightings(all, from)[0] ?? null;
}

/** Add a sighting unless the bank already holds that structure. */
export function addSighting(all: Sighting[], s: Sighting): Sighting[] {
  const known = all.some((o) => Math.hypot(o.x - s.x, o.z - s.z) <= SAME_SIGHTING_BLOCKS && Math.abs(o.y - s.y) <= 16);
  return known ? all : [...all, s];
}

/** Record how close a march came, keeping the best result the bank has seen. */
export function recordApproach(all: Sighting[], target: { x: number; z: number }, gap: number): Sighting[] {
  return all.map((s) => {
    if (Math.hypot(s.x - target.x, s.z - target.z) > SAME_SIGHTING_BLOCKS) return s;
    const bestGap = typeof s.bestGap === "number" ? Math.min(s.bestGap, gap) : gap;
    return { ...s, bestGap, attempts: (s.attempts ?? 0) + 1 };
  });
}

/** Mark a sighting as visited and empty. Nothing is ever removed from the bank. */
export function dropSighting(
  all: Sighting[],
  target: { x: number; z: number },
  when = new Date().toISOString(),
): Sighting[] {
  return all.map((s) =>
    Math.hypot(s.x - target.x, s.z - target.z) <= SAME_SIGHTING_BLOCKS ? { ...s, droppedAt: s.droppedAt ?? when } : s,
  );
}

/** Read either shape of the file: the old single sighting or the list. */
export function parseBank(raw: unknown): Sighting[] {
  if (Array.isArray(raw)) return raw as Sighting[];
  const obj = raw as { sightings?: unknown; x?: unknown; z?: unknown };
  if (Array.isArray(obj?.sightings)) return obj.sightings as Sighting[];
  if (typeof obj?.x === "number" && typeof obj?.z === "number") return [raw as Sighting];
  return [];
}
