import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import { LOG_TYPES } from "./materials.js";

/**
 * wood_run: walk to a standing tree the bot can see and chop there.
 *
 * Run 835: 27 gather_wood attempts in three runs brought home six logs. The
 * candidates near the village were beams in its houses, floating over air at
 * (293, 73, -312), and cave timber at (294, 46, -323); every approach failed.
 * The real trees the bots could see stood 170 to 220 blocks out, at
 * (461, 108, -214) and (494, 88, -412), past what one gather action walks.
 * The swarm has had no sticks for days, so no pickaxes, swords, arrows or
 * shield. This skill marches to the nearest standing tree in sight and hands
 * over to gather_wood there, where the nearest logs are real ones.
 */

const NATURAL_GROUND = new Set([
  "dirt",
  "grass_block",
  "podzol",
  "coarse_dirt",
  "rooted_dirt",
  "mycelium",
  "moss_block",
  "mud",
]);

type Lookup = (x: number, y: number, z: number) => string | undefined;

const NOT_GROUND = new Set(["air", "cave_air", "void_air", "water", "lava", "flowing_water", "flowing_lava"]);

/**
 * Is the log at (x, y, z) part of a standing tree? Walk down the log column
 * to its base, which must sit on natural ground, and up to its top, which
 * must have leaves within three blocks.
 */
export function isStandingTree(x: number, y: number, z: number, at: Lookup): boolean {
  const isLog = (n?: string) => !!n && (LOG_TYPES as readonly string[]).includes(n);
  let base = y;
  while (isLog(at(x, base - 1, z)) && y - base < 30) base--;
  // Run 838: 256 logs in sight and none passed with the ground limited to a
  // list of soils. The base only has to stand on something solid: house
  // beams float over air and cave timber has no leaves, and both still fail.
  const under = at(x, base - 1, z) ?? "";
  if (!NATURAL_GROUND.has(under) && (under === "" || NOT_GROUND.has(under) || under.endsWith("_log"))) return false;
  let top = y;
  while (isLog(at(x, top + 1, z)) && top - y < 30) top++;
  for (let dy = -1; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        if ((at(x + dx, top + dy, z + dz) ?? "").endsWith("_leaves")) return true;
      }
    }
  }
  return false;
}

/**
 * Record the standing trees this bot can see, so a teammate at the village,
 * whose loaded chunks do not reach them, can walk there. Run 836: both wood
 * runs from the village saw one to three logs and no tree, while bots further
 * east had seen trees 170 to 220 blocks out.
 */
export async function scanTrees(bot: Bot, radius = 128, keep = 5): Promise<number> {
  const at: Lookup = (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name;
  const me = bot.entity.position;
  const trees = bot
    .findBlocks({ matching: (b) => (LOG_TYPES as readonly string[]).includes(b.name), maxDistance: radius, count: 96 })
    .filter((p) => isStandingTree(p.x, p.y, p.z, at))
    .sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))
    .slice(0, keep);
  if (!trees.length) return 0;
  // Run 837: the module-level recordOre writes to an unregistered
  // "memory.json" store that getAllMemoryStores never reads, so wood_run
  // answered "none remembered" with two sightings on disk. Write to this
  // bot's own registered store.
  const { getBotMemoryStore } = await import("../bot/memory-registry.js");
  const store = getBotMemoryStore(bot);
  if (store) {
    for (const t of trees) store.recordOre("standing_tree", t.x, t.y, t.z);
  } else {
    const { recordOre } = await import("../bot/memory.js");
    for (const t of trees) recordOre("standing_tree", t.x, t.y, t.z);
  }
  return trees.length;
}

export const woodRunSkill: Skill = {
  name: "wood_run",
  description:
    "Walk to the nearest standing tree in sight (up to 250 blocks) and chop logs there. Use when the team has no wood and nearby logs cannot be reached.",
  params: {},
  timeoutMs: 420_000,

  estimateMaterials() {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "wood_run", phase: "Wood", progress, message, active: true });
    const at: Lookup = (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name;
    const me = bot.entity.position;
    const logs = bot.findBlocks({
      matching: (b) => (LOG_TYPES as readonly string[]).includes(b.name),
      maxDistance: 250,
      count: 256,
    });
    const trees = logs
      .filter((p) => Math.hypot(p.x - me.x, p.z - me.z) >= 16)
      .filter((p) => isStandingTree(p.x, p.y, p.z, at))
      .sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z));
    console.log(`[Wood] ${bot.username}: ${logs.length} logs in sight, ${trees.length} in standing trees`);
    if (logs.length && !trees.length) {
      const sample = logs.slice(0, 4).map((p) => {
        let base = p.y;
        while ((at(p.x, base - 1, p.z) ?? "").endsWith("_log") && p.y - base < 30) base--;
        return `(${p.x},${p.y},${p.z}) base ${base} on ${at(p.x, base - 1, p.z)}`;
      });
      console.log(`[Wood] ${bot.username}: rejected samples ${sample.join(" ")}`);
    }
    let t = trees[0] as { x: number; y: number; z: number } | undefined;
    let remembered = false;
    if (!t) {
      const { getAllMemoryStores } = await import("../bot/memory-registry.js");
      const known = getAllMemoryStores()
        .map((st) => st.getNearestOre("standing_tree", me.x, me.z, 400))
        .filter((o): o is NonNullable<typeof o> => !!o)
        .sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0];
      if (!known) return { success: false, message: "No standing tree in sight or remembered within 400 blocks." };
      t = { x: known.x, y: known.y, z: known.z };
      remembered = true;
      console.log(`[Wood] ${bot.username}: none in sight; walking to a remembered tree at ${t.x},${t.y},${t.z}`);
    }
    const far = Math.hypot(t.x - me.x, t.z - me.z);
    step(`Walking to a tree at ${t.x},${t.y},${t.z} (${far.toFixed(0)} blocks)...`, 0.1);
    console.log(`[Wood] ${bot.username}: marching to the tree at ${t.x},${t.y},${t.z} (${far.toFixed(0)} away)`);
    const { marchToward } = await import("./loot-bastion.js");
    const gap = await marchToward(bot, { x: t.x, y: t.y, z: t.z }, 240_000, signal, {
      label: "Walking to the trees",
      progress: () => 0.4,
      step,
      stop: () => Math.hypot(bot.entity.position.x - t.x, bot.entity.position.z - t.z) <= 8,
    }).catch(() => Infinity);
    console.log(`[Wood] ${bot.username}: arrived within ${Number(gap).toFixed(0)} of the tree`);
    if (signal.aborted) return { success: false, message: "Wood run aborted." };
    if (remembered && (await scanTrees(bot, 24)) === 0) {
      const { getAllMemoryStores } = await import("../bot/memory-registry.js");
      let gone = 0;
      for (const st of getAllMemoryStores()) gone += st.forgetOreNear("standing_tree", t.x, t.z, 16);
      console.log(`[Wood] ${bot.username}: no standing tree here any more; forgot ${gone} remembered spot(s)`);
      return { success: false, message: `The remembered tree at ${t.x},${t.z} is gone.` };
    }
    const before = bot.inventory
      .items()
      .filter((i) => (LOG_TYPES as readonly string[]).includes(i.name))
      .reduce((n, i) => n + i.count, 0);
    step("Chopping...", 0.7);
    const { executeAction } = await import("../bot/actions.js");
    const chopped = await executeAction(bot, "gather_wood", { count: 16 }).catch((e: Error) => e.message);
    const after = bot.inventory
      .items()
      .filter((i) => (LOG_TYPES as readonly string[]).includes(i.name))
      .reduce((n, i) => n + i.count, 0);
    console.log(`[Wood] ${bot.username}: ${String(chopped).slice(0, 80)} (logs ${before} -> ${after})`);
    return {
      success: after > before,
      message: `Wood run to ${t.x},${t.z}: ${String(chopped).slice(0, 120)} Logs now ${after}.`,
      stats: { logs: after - before },
    };
  },
};
