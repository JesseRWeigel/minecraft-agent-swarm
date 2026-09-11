import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { resolveProjectRoot } from "../project-root.js";

const PROJECT_ROOT = resolveProjectRoot(path.dirname(fileURLToPath(import.meta.url)));

export type Nest = { x: number; y: number; z: number };

/**
 * Bee nests the swarm knows about. The first two were found by reading the
 * surviving bee's hive_pos on the server; the third the same way after the
 * second colony died. From here on any bot whose perception passes a nest
 * records it, so the wax skill's target list grows with exploration.
 */
export const STATIC_NESTS: Nest[] = [
  { x: 474, y: 77, z: -323 },
  { x: 452, y: 72, z: -361 },
  { x: 472, y: 71, z: -445 },
];

const NEST_FILE = path.join(PROJECT_ROOT, "logs", "known-nests.json");

function readFile(): Nest[] {
  try {
    const raw = JSON.parse(fs.readFileSync(NEST_FILE, "utf8"));
    return Array.isArray(raw)
      ? raw.filter((n) => Number.isFinite(n?.x) && Number.isFinite(n?.y) && Number.isFinite(n?.z))
      : [];
  } catch {
    return [];
  }
}

export function mergeNests(...lists: Nest[][]): Nest[] {
  const out: Nest[] = [];
  for (const list of lists) {
    for (const n of list) {
      if (!out.some((o) => o.x === n.x && o.y === n.y && o.z === n.z)) out.push({ x: n.x, y: n.y, z: n.z });
    }
  }
  return out;
}

/** Static nests plus every nest a bot has recorded. */
export function knownNests(): Nest[] {
  return mergeNests(STATIC_NESTS, readFile());
}

/** Remember a nest a bot just saw. Returns true when it was new. */
export function recordNest(x: number, y: number, z: number): boolean {
  const n = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
  if (knownNests().some((o) => o.x === n.x && o.y === n.y && o.z === n.z)) return false;
  try {
    fs.mkdirSync(path.dirname(NEST_FILE), { recursive: true });
    fs.writeFileSync(NEST_FILE, JSON.stringify(mergeNests(readFile(), [n]), null, 2));
  } catch {
    /* disk trouble: the static list still works */
  }
  console.log(`[Nests] recorded a bee nest at ${n.x},${n.y},${n.z}`);
  return true;
}

/** The known nest closest to a position (XZ), for reflexes that gate on "near the hive". */
export function nearestNest(x: number, z: number): Nest {
  return [...knownNests()].sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
}

/** Copper blocks the swarm has waxed (Wax Off scrapes one of these). The
 *  first was placed by Forge beside the third nest on 2026-09-11 and
 *  confirmed by RCON at 475,78,-321. */
export const STATIC_WAXED: Nest[] = [{ x: 475, y: 78, z: -321 }];
const WAXED_FILE = "logs/known-waxed.json";

function readWaxed(): Nest[] {
  try {
    const raw = JSON.parse(fs.readFileSync(WAXED_FILE, "utf8"));
    return Array.isArray(raw) ? raw.filter((n) => typeof n?.x === "number") : [];
  } catch {
    return [];
  }
}

export function knownWaxedBlocks(): Nest[] {
  return mergeNests(STATIC_WAXED, readWaxed());
}

export function recordWaxedBlock(x: number, y: number, z: number): void {
  const all = mergeNests(readWaxed(), [{ x, y, z }]);
  try {
    fs.writeFileSync(WAXED_FILE, JSON.stringify(all, null, 2));
  } catch {
    /* logs dir missing: the static list still covers the first block */
  }
}
