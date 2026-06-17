import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import { collectNearbyDrops } from "../bot/navigation.js";

const TUNNEL_LENGTH = 30;
const TORCH_INTERVAL = 6;
const TARGET_Y = 11; // Classic diamond level, also good for iron/gold/redstone

export const stripMineSkill: Skill = {
  name: "strip_mine",
  description:
    "Dig a mining tunnel for ores. Staircases down to Y=11 if needed, then mines 30 blocks horizontally with torch lighting. Requires a pickaxe.",
  params: {},

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    // Verify pickaxe
    const pickaxe = bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
    if (!pickaxe) {
      return { success: false, message: "Need a pickaxe! Use craft_gear first, then strip_mine." };
    }

    let mined = 0;
    const oresFound: string[] = [];

    // Snap to nearest cardinal direction
    const forward = getCardinalDirection(bot.entity.yaw);
    console.log(`[Skill] Strip mine direction: ${dirName(forward)}, starting Y=${bot.entity.position.y.toFixed(0)}`);

    // --- Phase 1: Descend to TARGET_Y (iron/diamond depth) ---
    // The old manual staircase dug blocks but moveToPosition often failed to
    // follow it down, so the bot stayed at the surface (Y~64-90) and tunneled
    // where iron is rare — 12 runs found only coal, 0 iron. Use the pathfinder
    // with digging enabled to ACTUALLY reach depth: it handles the descent and
    // avoids lava/dangerous falls itself.
    const currentY = Math.floor(bot.entity.position.y);
    if (currentY > TARGET_Y + 5) {
      onProgress({
        skillName: "strip_mine",
        phase: "Digging down",
        progress: 0.05,
        message: `Digging down to Y=${TARGET_Y} (iron depth)...`,
        active: true,
      });
      const digMoves = new Movements(bot);
      digMoves.canDig = true;
      digMoves.allow1by1towers = true;
      bot.pathfinder.setMovements(digMoves);
      try {
        await Promise.race([
          bot.pathfinder.goto(new goals.GoalY(TARGET_Y)),
          new Promise<void>((_, rej) =>
            setTimeout(() => {
              bot.pathfinder.stop();
              rej(new Error("descend timeout"));
            }, 90000),
          ),
        ]);
      } catch {
        /* partial descent — mine wherever we reached */
      }
      // Collect anything the descent dropped (ore dug on the way down).
      await collectNearbyDrops(bot, 4, 3000);
      console.log(`[Skill] strip_mine descended to Y=${bot.entity.position.y.toFixed(0)}`);
    }

    // --- Phase 2: Horizontal mining tunnel ---
    onProgress({
      skillName: "strip_mine",
      phase: "Mining tunnel",
      progress: 0.3,
      message: "Mining horizontal tunnel...",
      active: true,
    });

    for (let step = 0; step < TUNNEL_LENGTH && !signal.aborted; step++) {
      const pos = bot.entity.position.floored();

      // Dig 2 blocks ahead: foot level and head level
      const targets = [pos.offset(forward.x, 0, forward.z), pos.offset(forward.x, 1, forward.z)];

      for (const t of targets) {
        const b = bot.blockAt(t);
        if (!b || b.name === "air") continue;
        if (b.name === "bedrock") {
          return {
            success: true,
            message: `Hit bedrock at step ${step}! Mined ${mined} blocks. ${formatOres(oresFound)}`,
            stats: { blocksMined: mined, oresFound: oresFound.length },
          };
        }
        if (b.name === "lava" || b.name === "water") continue;

        await equipBestPickaxe(bot);
        try {
          await bot.dig(b);
          mined++;
          if (b.name.includes("ore")) oresFound.push(b.name);
        } catch {
          /* skip */
        }
      }

      // Mine any ore exposed in the surrounding walls/floor/ceiling. The old
      // tunnel only checked the 2 blocks dead ahead, so it walked straight past
      // veins in the walls — which is why nights of mining found "0 ores".
      const exposed = await mineExposedOre(bot, pos);
      mined += exposed.mined;
      oresFound.push(...exposed.ores);

      // Walk forward into cleared space
      const targetPos = pos.offset(forward.x, 0, forward.z);
      await moveToPosition(bot, targetPos);

      // Place torch every N blocks
      if (step > 0 && step % TORCH_INTERVAL === 0) {
        await placeTorchOnWall(bot, forward);
      }

      if (step % 5 === 0) {
        onProgress({
          skillName: "strip_mine",
          phase: "Mining tunnel",
          progress: 0.3 + (step / TUNNEL_LENGTH) * 0.7,
          message: `${step}/${TUNNEL_LENGTH} blocks | Mined: ${mined} | Ores: ${oresFound.length}`,
          active: true,
        });
      }
    }

    if (mined === 0) {
      return { success: false, message: "Couldn't mine anything. Pickaxe might have broken." };
    }

    // Sweep the tunnel to pick up the ore we dug — without this, strip_mine
    // reported "Found 8x iron_ore" but left the drops on the ground, so the
    // bot never actually had iron to smelt. Walk back over the tunnel.
    await collectNearbyDrops(bot, 16, 8000);

    return {
      success: true,
      message: `Strip mine complete! Dug ${TUNNEL_LENGTH}-block tunnel, mined ${mined} blocks total. ${formatOres(oresFound)}`,
      stats: { blocksMined: mined, oresFound: oresFound.length },
    };
  },
};

// --- Helpers ---

async function equipBestPickaxe(bot: Bot): Promise<void> {
  const pick = bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
  if (pick) await bot.equip(pick, "hand");
}

/**
 * Mine any ore block exposed in the 3x3x3 shell around `pos` (the bot's cell),
 * then follow each vein a few blocks. This is what turns a blind tunnel into an
 * actually-productive one — ores in the walls used to be ignored entirely.
 */
async function mineExposedOre(bot: Bot, pos: Vec3): Promise<{ mined: number; ores: string[] }> {
  let mined = 0;
  const ores: string[] = [];
  const toCheck: Vec3[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0 && (dy === 0 || dy === 1)) continue; // skip the cleared path itself
        toCheck.push(pos.offset(dx, dy, dz));
      }
    }
  }
  for (const t of toCheck) {
    const b = bot.blockAt(t);
    if (!b || !b.name.endsWith("_ore")) continue;
    try {
      await equipBestPickaxe(bot);
      await bot.dig(b);
      mined++;
      ores.push(b.name);
      // Follow the vein a little so we don't leave most of it in the wall.
      mined += await followVein(bot, t, b.name, ores);
    } catch {
      /* out of reach or interrupted — skip */
    }
  }
  return { mined, ores };
}

async function followVein(bot: Bot, start: Vec3, oreName: string, ores: string[], cap = 8): Promise<number> {
  const seen = new Set<string>([start.toString()]);
  const queue: Vec3[] = [start];
  let extra = 0;
  while (queue.length && extra < cap) {
    const cur = queue.shift()!;
    for (const d of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ] as const) {
      const p = cur.offset(d[0], d[1], d[2]);
      if (seen.has(p.toString())) continue;
      seen.add(p.toString());
      const b = bot.blockAt(p);
      if (!b || b.name !== oreName) continue;
      if (bot.entity.position.distanceTo(p) > 4.3) continue; // only what we can reach without re-pathing
      try {
        await equipBestPickaxe(bot);
        await bot.dig(b);
        extra++;
        ores.push(b.name);
        queue.push(p);
      } catch {
        /* skip */
      }
    }
  }
  return extra;
}

async function moveToPosition(bot: Bot, targetPos: Vec3): Promise<void> {
  try {
    const moves = new Movements(bot);
    moves.canDig = false;
    bot.pathfinder.setMovements(moves);
    await bot.pathfinder.goto(new goals.GoalBlock(targetPos.x, targetPos.y, targetPos.z));
  } catch {
    // Fallback: manual walk
    try {
      await bot.lookAt(targetPos.offset(0.5, 1, 0.5));
      bot.setControlState("forward", true);
      await bot.waitForTicks(8);
      bot.setControlState("forward", false);
    } catch {
      /* ok */
    }
  }
}

async function placeTorchOnWall(bot: Bot, forward: Vec3): Promise<void> {
  const torch = bot.inventory.items().find((i) => i.name === "torch");
  if (!torch) return;

  // Left wall = 90 degrees from forward
  const wallDir = new Vec3(-forward.z, 0, forward.x);
  const wallBlock = bot.blockAt(bot.entity.position.floored().offset(wallDir.x, 1, wallDir.z));
  if (wallBlock && wallBlock.name !== "air" && wallBlock.name !== "water") {
    try {
      await bot.equip(torch, "hand");
      await bot.placeBlock(wallBlock, new Vec3(-wallDir.x, 0, -wallDir.z));
    } catch {
      /* ok */
    }
  }
}

function formatOres(ores: string[]): string {
  if (ores.length === 0) return "No ores this time — try a different direction!";
  const counts: Record<string, number> = {};
  for (const o of ores) counts[o] = (counts[o] || 0) + 1;
  return (
    "Found: " +
    Object.entries(counts)
      .map(([k, v]) => `${v}x ${k}`)
      .join(", ") +
    "!"
  );
}

/** Snap yaw to nearest cardinal direction vector. */
function getCardinalDirection(yaw: number): Vec3 {
  // Mineflayer: 0 = south (+Z), pi/2 = west (-X), pi = north (-Z), 3pi/2 = east (+X)
  const n = ((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (n >= Math.PI * 0.25 && n < Math.PI * 0.75) return new Vec3(-1, 0, 0); // west
  if (n >= Math.PI * 0.75 && n < Math.PI * 1.25) return new Vec3(0, 0, -1); // north
  if (n >= Math.PI * 1.25 && n < Math.PI * 1.75) return new Vec3(1, 0, 0); // east
  return new Vec3(0, 0, 1); // south
}

function dirName(dir: Vec3): string {
  if (dir.z === -1) return "north";
  if (dir.z === 1) return "south";
  if (dir.x === -1) return "west";
  return "east";
}
