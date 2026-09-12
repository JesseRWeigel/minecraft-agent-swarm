import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import mcDataLoader from "minecraft-data";
import { baseMoves, explorerMoves, safeGoto, GoalNearXZAbove, collectNearbyDrops } from "../bot/navigation.js";
import { placeCraftingTable } from "./craft-gear.js";

const FISH_ATTEMPTS = 6;
const BITE_TIMEOUT_MS = 30000;

export const goFishingSkill: Skill = {
  name: "go_fishing",
  // Stash march (170s cap) + rod craft + walk to water + 6 casts of 30s.
  // Run 564: two trips died at the 240s default with the rod in hand.
  timeoutMs: 480_000,
  description:
    "Fish at nearby water for food and loot. Crafts a fishing rod if possible (needs 3 sticks + 2 string). Catches ~3-5 items.",
  params: {},

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    // --- Step 1: Get or craft a fishing rod ---
    onProgress({
      skillName: "go_fishing",
      phase: "Preparing",
      progress: 0,
      message: "Looking for fishing rod...",
      active: true,
    });

    let rod = bot.inventory.items().find((i) => i.name === "fishing_rod");
    if (!rod) {
      // Self-supply the rod: withdraw a spare or its string from the stash,
      // then kill a loaded spider for string, before crafting. Without this
      // the skill dead-ended on "need string" every time and never fished.
      const held = (n: string) =>
        bot.inventory
          .items()
          .filter((i) => i.name === n)
          .reduce((s, i) => s + i.count, 0);
      try {
        const { withdrawStash } = await import("./stash.js");
        const { STASH_POS } = await import("../bot/role.js");
        // The stash is the rod: it holds string, sticks and planks (ledger
        // 2026-09-12: string 9, stick 573). Run 563: every bot at 0 food, nine
        // hunts in a row saw no animal, and the one fishing attempt gave up
        // because Flora stood 200 blocks from the stash. Walk there first.
        const gap = () => Math.hypot(bot.entity.position.x - STASH_POS.x, bot.entity.position.z - STASH_POS.z);
        if (gap() > 60) {
          onProgress({
            skillName: "go_fishing",
            phase: "Preparing",
            progress: 0.01,
            message: `Walking to the stash for string — ${Math.round(gap())} blocks out...`,
            active: true,
          });
          bot.pathfinder.setMovements(explorerMoves(bot));
          const deadline = Date.now() + 170_000;
          let guard = 0;
          while (gap() > 40 && Date.now() < deadline && !signal.aborted) {
            const before = gap();
            const t = Math.min(1, 100 / before);
            const wx = Math.round(bot.entity.position.x + (STASH_POS.x - bot.entity.position.x) * t);
            const wz = Math.round(bot.entity.position.z + (STASH_POS.z - bot.entity.position.z) * t);
            await safeGoto(bot, new GoalNearXZAbove(wx, wz, 8, 62), 45_000, 12_000).catch(() => {});
            if (before - gap() >= 6) guard = 0;
            else if (++guard >= 3) break;
          }
          console.log(`[FishDebug] ${bot.username} stash march ended ${Math.round(gap())} blocks out`);
        }
        // 90, up from 60: two marches ended at 63 and 82 blocks out and the
        // withdraw was skipped; withdrawStash walks the rest itself.
        if (gap() <= 90) {
          const r1 = await Promise.race([
            withdrawStash(bot, STASH_POS, "fishing_rod", 1),
            new Promise<string>((r) => setTimeout(() => r("timeout"), 30_000)),
          ]).catch((e: Error) => e.message);
          console.log(`[FishDebug] ${bot.username} rod withdraw: ${r1}`);
          if (!bot.inventory.items().some((i) => i.name === "fishing_rod") && held("string") < 2) {
            const r2 = await Promise.race([
              withdrawStash(bot, STASH_POS, "string", 2),
              new Promise<string>((r) => setTimeout(() => r("timeout"), 30_000)),
            ]).catch((e: Error) => e.message);
            console.log(`[FishDebug] ${bot.username} string withdraw: ${r2} (string now ${held("string")})`);
          }
          if (!bot.inventory.items().some((i) => i.name === "fishing_rod") && held("stick") < 3) {
            const r3 = await Promise.race([
              withdrawStash(bot, STASH_POS, "stick", 3),
              new Promise<string>((r) => setTimeout(() => r("timeout"), 30_000)),
            ]).catch((e: Error) => e.message);
            console.log(`[FishDebug] ${bot.username} stick withdraw: ${r3} (sticks now ${held("stick")})`);
          }
        }
      } catch {
        /* stash unavailable */
      }
      rod = bot.inventory.items().find((i) => i.name === "fishing_rod");
      // Hunt a loaded spider for string when we still lack it.
      if (!rod && held("string") < 2) {
        const spider = bot.nearestEntity((e) => e.name === "spider" || e.name === "cave_spider");
        if (spider && spider.position.distanceTo(bot.entity.position) < 24) {
          onProgress({
            skillName: "go_fishing",
            phase: "Preparing",
            progress: 0.02,
            message: "Hunting a spider for string...",
            active: true,
          });
          try {
            const { baseMoves } = await import("../bot/navigation.js");
            bot.pathfinder.setMovements(baseMoves(bot));
            await bot.pathfinder.goto(new goals.GoalNear(spider.position.x, spider.position.y, spider.position.z, 2));
            const sword = bot.inventory.items().find((i) => i.name.endsWith("_sword"));
            if (sword) await bot.equip(sword, "hand").catch(() => {});
            for (let s = 0; s < 10 && spider.isValid; s++) {
              await bot.attack(spider);
              await new Promise((r) => setTimeout(r, 600));
            }
            const { collectNearbyDrops } = await import("../bot/navigation.js");
            await collectNearbyDrops(bot, 5, 3000);
          } catch {
            /* best effort */
          }
        }
      }
      if (!rod) {
        await craftFishingRod(bot, signal);
        rod = bot.inventory.items().find((i) => i.name === "fishing_rod");
      }
      if (!rod) {
        const tableNear = !!bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
        return {
          success: false,
          message: `Can't fish yet — need a fishing rod (3 sticks + 2 string). Holding string ${held("string")}, sticks ${held("stick")}, crafting table within 32: ${tableNear ? "yes" : "no"}. ${held("string") < 2 ? "Kill a spider or withdraw string from the stash, then" : "Get to a crafting table, then"} invoke_skill go_fishing again.`,
        };
      }
    }

    // --- Step 2: Find water ---
    onProgress({
      skillName: "go_fishing",
      phase: "Finding water",
      progress: 0.05,
      message: "Heading to water...",
      active: true,
    });

    // 64, up from 48: the nearest open water to the stash is 41 blocks out
    // and the lake at (338, 62, -330) is 54 (RCON scan 2026-09-12).
    const water = bot.findBlock({
      matching: (b) => b.name === "water",
      maxDistance: 64,
    });
    if (!water) {
      return { success: false, message: "No water nearby! Explore to find a lake or river." };
    }

    // Navigate to water's edge (stand on the bank, not in the water)
    setMovements(bot);
    await safeGoto(
      bot,
      new goals.GoalNear(water.position.x, water.position.y + 1, water.position.z, 3),
      60_000,
      12_000,
    ).catch(() => {
      /* try anyway */
    });

    // --- Step 3: Fish! ---
    let caught = 0;
    const catches: string[] = [];

    for (let attempt = 0; attempt < FISH_ATTEMPTS && !signal.aborted; attempt++) {
      onProgress({
        skillName: "go_fishing",
        phase: "Fishing",
        progress: 0.1 + (attempt / FISH_ATTEMPTS) * 0.85,
        message: `Cast ${attempt + 1}/${FISH_ATTEMPTS} | Caught: ${caught}`,
        active: true,
      });

      rod = bot.inventory.items().find((i) => i.name === "fishing_rod");
      if (!rod) break;

      try {
        await bot.equip(rod, "hand");
        await bot.lookAt(water.position.offset(0.5, 1, 0.5));

        // Cast the line
        bot.activateItem();
        await bot.waitForTicks(20);

        // Wait for a bite (bobber dip detection)
        const gotBite = await waitForBite(bot, signal, BITE_TIMEOUT_MS);

        // Reel in
        bot.activateItem();
        await bot.waitForTicks(10);

        if (gotBite) {
          caught++;
          catches.push("catch");
          console.log(`[Skill] Fish caught! (#${caught})`);
        }
      } catch {
        // Clean up - make sure rod is deactivated
        try {
          bot.deactivateItem();
        } catch {
          /* ok */
        }
        continue;
      }
    }

    if (caught === 0) {
      return { success: false, message: "Didn't catch anything! The fish outsmarted me. Try again near deeper water." };
    }

    // The catch flies to the player and lands beside them; give it a moment.
    await collectNearbyDrops(bot, 4, 2500).catch(() => {});
    // Eat the catch on the bank while hungry: raw cod and salmon are 2 hunger
    // each, and a starving bot has no regen until food is back over 17.
    let ate = 0;
    const foodBefore = bot.food;
    for (let i = 0; i < 6 && bot.food < 17 && !signal.aborted; i++) {
      const fish = bot.inventory
        .items()
        .find((it) => /^(cod|salmon|cooked_cod|cooked_salmon|tropical_fish)$/.test(it.name));
      if (!fish) break;
      try {
        await bot.equip(fish, "hand");
        await bot.consume();
        ate++;
      } catch {
        break;
      }
    }
    console.log(`[FishDebug] ${bot.username} caught ${caught}, ate ${ate}, hunger ${foodBefore} -> ${bot.food}`);

    return {
      success: true,
      message: `Fishing trip done! Caught ${caught} items in ${FISH_ATTEMPTS} casts${ate ? `, ate ${ate} (hunger ${foodBefore} -> ${bot.food})` : ""}. Fresh fish dinner!`,
      stats: { fishCaught: caught },
    };
  },
};

/** Wait for the fishing bobber to dip, indicating a bite. */
async function waitForBite(bot: Bot, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let resolved = false;

    const cleanup = () => {
      resolved = true;
      clearTimeout(timeout);
      clearInterval(check);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const timeout = setTimeout(() => {
      if (!resolved) {
        cleanup();
        resolve(false);
      }
    }, timeoutMs);

    let bobber: any = null;
    let lastY = 0;
    let stableCount = 0;

    const check = setInterval(() => {
      if (resolved) return;

      // Find bobber entity
      if (!bobber) {
        for (const entity of Object.values(bot.entities)) {
          const name = entity.name || (entity as any).objectType || "";
          if (
            (name === "fishing_bobber" || name === "fishing_float") &&
            entity.position.distanceTo(bot.entity.position) < 40
          ) {
            bobber = entity;
            lastY = entity.position.y;
            stableCount = 0;
            break;
          }
        }
        return;
      }

      // Check if bobber is gone (someone else reeled in, or entity despawned)
      if (!bobber.isValid) {
        cleanup();
        resolve(false);
        return;
      }

      const currentY = bobber.position.y;
      const dy = currentY - lastY;

      // Wait for bobber to settle on water (~5 ticks of stability)
      if (Math.abs(dy) < 0.05) {
        stableCount++;
      } else if (stableCount < 5) {
        // Still landing/bouncing
        stableCount = 0;
      }

      // Once stable, watch for the dip (Y decreases when fish bites)
      if (stableCount > 5 && dy < -0.1) {
        cleanup();
        resolve(true);
        return;
      }

      lastY = currentY;
    }, 100);
  });
}

function setMovements(bot: Bot) {
  const moves = baseMoves(bot);
  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowFreeMotion = false;
  moves.scafoldingBlocks = [];
  bot.pathfinder.setMovements(moves);
}

async function craftFishingRod(bot: Bot, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const mcData = mcDataLoader(bot.version);
  const count = (n: string) =>
    bot.inventory
      .items()
      .filter((i) => i.name === n)
      .reduce((s, i) => s + i.count, 0);

  if (count("string") < 2) {
    console.log(`[FishDebug] ${bot.username} rod craft skipped: string ${count("string")}`);
    return;
  }

  const stickItem = mcData.itemsByName["stick"];
  if (stickItem && count("stick") < 3) {
    const recipe = bot.recipesFor(stickItem.id, null, 1, null)[0];
    if (recipe) {
      await bot.craft(recipe, 1, undefined).catch((e: Error) => {
        console.log(`[FishDebug] ${bot.username} stick craft failed: ${e.message}`);
      });
    }
  }

  const rodItem = mcData.itemsByName["fishing_rod"];
  if (!rodItem) return;

  // Run 564: every string withdrawal ended in "Can't fish yet" and nothing
  // said why. Name each step: the table, the walk to it, the recipe, the
  // craft. With no table in reach, place one (planks from the pack or the
  // stash's 806) the way craft_gear does.
  let table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
  if (!table) {
    await placeCraftingTable(bot).catch((e: Error) => {
      console.log(`[FishDebug] ${bot.username} table placement failed: ${e.message}`);
    });
    table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 8 });
  }
  if (!table) {
    console.log(`[FishDebug] ${bot.username} rod craft: no crafting table within 32 and none placed`);
    return;
  }
  setMovements(bot);
  await safeGoto(
    bot,
    new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2),
    40_000,
    12_000,
  ).catch((e: Error) => {
    console.log(`[FishDebug] ${bot.username} walk to table failed: ${e.message}`);
  });
  const recipe = bot.recipesFor(rodItem.id, null, 1, table)[0];
  if (!recipe) {
    console.log(
      `[FishDebug] ${bot.username} rod recipe unavailable: string ${count("string")} sticks ${count("stick")} table dist ${bot.entity.position.distanceTo(table.position).toFixed(1)}`,
    );
    return;
  }
  try {
    await bot.craft(recipe, 1, table);
    console.log(
      `[FishDebug] ${bot.username} crafted a fishing rod (string ${count("string")}, sticks ${count("stick")} left)`,
    );
  } catch (e) {
    console.log(`[FishDebug] ${bot.username} rod craft failed: ${(e as Error).message}`);
  }
}
