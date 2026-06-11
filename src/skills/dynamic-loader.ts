import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Vec3 } from "vec3";
import { skillRegistry } from "./registry.js";
import type { Skill } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../");

const SKILL_DIRS = [path.join(PROJECT_ROOT, "skills/voyager"), path.join(PROJECT_ROOT, "skills/generated")];

// All Voyager skills concatenated — used as a helper library in the vm context so skills
// can call each other (e.g. smeltFiveRawIron calls craftFurnace, placeItem, smeltItem)
let voyagerHelperBundle = "";

// Primitive functions that Voyager skills expect in the global scope.
// These are the Voyager framework utilities, implemented with Mineflayer's API.
const VOYAGER_PRIMITIVES = `
const { goals: _vGoals, Movements: _vMovements } = require('mineflayer-pathfinder');
// Expose goal constructors as bare names so Voyager skills can use e.g. new GoalBlock(...)
const GoalBlock = _vGoals.GoalBlock;
const GoalNear = _vGoals.GoalNear;
const GoalFollow = _vGoals.GoalFollow;
const GoalXZ = _vGoals.GoalXZ;
const GoalY = _vGoals.GoalY;

async function mineBlock(bot, name, count) {
  const target = count || 1;
  // Enable digging AND swimming so pathfinder can reach ores through stone and water
  const _digMoves = new _vMovements(bot);
  _digMoves.canDig = true;
  _digMoves.allowFreeMotion = true; // allows swimming to ores in lakes
  bot.pathfinder.setMovements(_digMoves);
  let mined = 0;
  let attempts = 0;
  while (mined < target && attempts < target + 5) {
    attempts++;
    const block = bot.findBlock({ matching: (b) => b.name === name || b.name === 'deepslate_' + name + '_ore', maxDistance: 48 });
    if (!block) throw new Error('Cannot find ' + name + ' nearby');
    try {
      // Radius 2 instead of 1 gives the pathfinder more flexibility to find a valid approach
      await bot.pathfinder.goto(new _vGoals.GoalNear(block.position.x, block.position.y, block.position.z, 2));
      await bot.dig(block);
      // Wait for item drops to float up (especially coal in water) and be auto-collected
      await new Promise(r => setTimeout(r, 800));
      mined++;
    } catch (e) {
      // Block unreachable — it may be in a tree canopy or across water; try next nearest
      if (attempts >= target + 5) throw e;
    }
  }
}

async function placeItem(bot, name, position) {
  // If a block of this type already exists nearby, just navigate to it — no need to place
  const existing = bot.findBlock({ matching: (b) => b.name === name, maxDistance: 32 });
  if (existing) {
    await bot.pathfinder.goto(new _vGoals.GoalNear(existing.position.x, existing.position.y, existing.position.z, 2));
    return;
  }
  let item = bot.inventory.items().find(i => i.name === name);
  if (!item) {
    // Try crafting without a table (covers 2x2 recipes like crafting_table from planks)
    const _md = typeof mcData !== 'undefined' ? mcData : require('minecraft-data')(bot.version);
    const itm = _md.itemsByName[name];
    if (itm) {
      const recipes = bot.recipesFor(itm.id, null, 1, null);
      if (recipes.length) { try { await bot.craft(recipes[0], 1, null); } catch {} }
    }
    item = bot.inventory.items().find(i => i.name === name);
  }
  if (!item) throw new Error('No ' + name + ' in inventory');
  await bot.equip(item, 'hand');
  const px = Math.floor(position.x), py = Math.floor(position.y), pz = Math.floor(position.z);
  await bot.pathfinder.goto(new _vGoals.GoalNear(px, py, pz, 2));
  const refBlock = bot.blockAt(new Vec3(px, py - 1, pz));
  if (refBlock) { try { await bot.placeBlock(refBlock, new Vec3(0, 1, 0)); } catch {} }
}

async function craftItem(bot, name, count, craftingTable) {
  const _md = typeof mcData !== 'undefined' ? mcData : require('minecraft-data')(bot.version);
  const itm = _md.itemsByName[name];
  if (!itm) throw new Error('Unknown item: ' + name);
  let table = craftingTable || bot.findBlock({ matching: (b) => b.name === 'crafting_table', maxDistance: 16 });
  const recipes = bot.recipesFor(itm.id, null, 1, table || null);
  if (!recipes.length) throw new Error('No recipe for ' + name);
  await bot.craft(recipes[0], count || 1, table || null);
}

async function smeltItem(bot, inputName, fuelName, count) {
  const furnaceBlock = bot.findBlock({ matching: (b) => b.name === 'furnace', maxDistance: 16 });
  if (!furnaceBlock) throw new Error('No furnace nearby');
  await bot.pathfinder.goto(new _vGoals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2));
  const furnace = await bot.openFurnace(furnaceBlock);
  const fuel = bot.inventory.items().find(i => i.name === fuelName);
  const input = bot.inventory.items().find(i => i.name === inputName || i.name === 'raw_' + inputName.replace('_ore',''));
  if (!input) { furnace.close(); throw new Error('No ' + inputName + ' in inventory'); }
  if (!fuel) { furnace.close(); throw new Error('No ' + fuelName + ' in inventory'); }
  await furnace.putFuel(fuel.type, null, Math.min(fuel.count, count * 2));
  await furnace.putInput(input.type, null, count);
  await new Promise(r => setTimeout(r, count * 11000));
  try { if (furnace.outputItem()) await furnace.takeOutput(); } catch {}
  furnace.close();
}

async function killMob(bot, name, timeout) {
  const end = Date.now() + (timeout || 30) * 1000;
  while (Date.now() < end) {
    const mob = bot.nearestEntity(e => e.name === name && e.position && e.position.distanceTo(bot.entity.position) < 32);
    if (!mob) break;
    await bot.pathfinder.goto(new _vGoals.GoalNear(mob.position.x, mob.position.y, mob.position.z, 2));
    bot.attack(mob);
    await new Promise(r => setTimeout(r, 500));
  }
}

async function exploreUntil(bot, direction, maxTime, callback) {
  const endTime = Date.now() + maxTime * 1000;
  const dx = (direction && direction.x) || 1, dz = (direction && direction.z) || 0;
  while (Date.now() < endTime) {
    const result = callback();
    if (result) return result;
    const pos = bot.entity.position;
    try { await bot.pathfinder.goto(new _vGoals.GoalNear(pos.x + dx * 20, pos.y, pos.z + dz * 20, 2)); } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return callback();
}
`;

const sandboxRequire = createRequire(import.meta.url);
function safeRequire(mod: string) {
  try {
    return sandboxRequire(mod);
  } catch {
    return {};
  }
}

/**
 * Forgiving minecraft-data for skill sandboxes. LLM-written skills routinely
 * forget the factory call — `require('minecraft-data').blocksByName` instead
 * of `require('minecraft-data')(bot.version).blocksByName` — and crash with
 * "Cannot read properties of undefined". This proxy works both ways: callable
 * like the factory AND with the bot-version data available directly.
 */
function makeForgivingMcData(version: string): any {
  const factory = safeRequire("minecraft-data");
  if (typeof factory !== "function") return factory;
  let versionData: any;
  try {
    versionData = factory(version);
  } catch {
    return factory;
  }
  return new Proxy(factory, {
    get(target, prop, receiver) {
      if (versionData && prop in versionData) return versionData[prop as keyof typeof versionData];
      return Reflect.get(target, prop, receiver);
    },
    apply(target, thisArg, args) {
      return Reflect.apply(target, thisArg, args);
    },
  });
}

/** Per-bot require that hands skills the forgiving minecraft-data. */
function makeSandboxRequire(version: string) {
  const forgiving = makeForgivingMcData(version);
  return (mod: string) => (mod === "minecraft-data" ? forgiving : safeRequire(mod));
}

export function loadDynamicSkills(): void {
  let loaded = 0;

  // Build the Voyager helper bundle first (all Voyager skills concatenated)
  // so that when any skill runs it can call helpers like craftFurnace, placeItem, smeltItem
  const voyagerDir = SKILL_DIRS[0];
  if (fs.existsSync(voyagerDir)) {
    const parts: string[] = [];
    for (const file of fs.readdirSync(voyagerDir)) {
      if (!file.endsWith(".js")) continue;
      try {
        parts.push(fs.readFileSync(path.join(voyagerDir, file), "utf-8"));
      } catch {
        /* skip unreadable files */
      }
    }
    voyagerHelperBundle = parts.join("\n\n");
  }

  for (const dir of SKILL_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".js")) continue;
      const skillName = file.replace(".js", "");
      const skillPath = path.join(dir, file);
      try {
        skillRegistry.set(skillName, buildDynamicSkill(skillName, skillPath));
        loaded++;
      } catch (err: any) {
        console.warn(`[DynamicSkill] Skipped ${file}: ${err.message}`);
      }
    }
  }
  if (loaded > 0) console.log(`[DynamicSkill] Loaded ${loaded} dynamic skills`);
}

function buildDynamicSkill(name: string, filePath: string): Skill {
  const code = fs.readFileSync(filePath, "utf-8");

  // Validate syntax at load time — throws SyntaxError for malformed JS before the
  // skill ever reaches the registry.  This replaces the old fragile substring check
  // (which failed for arrow functions and was fooled by comments).
  new vm.Script(code);

  return {
    name,
    description: `Dynamic skill: ${name}`,
    params: {},
    estimateMaterials: () => ({}),

    async execute(bot, _params, signal, onProgress) {
      onProgress({ skillName: name, phase: "Running", progress: 0, message: name, active: true });
      try {
        // NOTE: vm.createContext is NOT a security sandbox — skill files must be trusted.
        // A malicious skill could escape via prototype chain. Only load skills from trusted sources.
        // mcData is required by many Voyager skills (require('minecraft-data')(version))
        let mcData: any;
        try {
          mcData = safeRequire("minecraft-data")(bot.version);
        } catch {
          mcData = {};
        }
        const ctx = vm.createContext({
          bot,
          Vec3,
          mcData,
          require: makeSandboxRequire(bot.version),
          console,
          setTimeout,
          clearTimeout,
          setInterval,
          clearInterval,
          Promise,
          Math,
          JSON,
        });

        // Shim bot.pathfinder.waitForGoal — the old pathfinder API used setGoal+waitForGoal but
        // modern mineflayer-pathfinder only exposes goto().  Generated skills often use the old
        // pattern.  Implementing waitForGoal as a timed wait gives the pathfinder a chance to
        // make progress (setGoal starts movement; waitForGoal just waits) without crashing.
        try {
          vm.runInContext(
            `if (bot.pathfinder && !bot.pathfinder.waitForGoal) {
               bot.pathfinder.waitForGoal = (timeout) =>
                 new Promise(r => setTimeout(r, typeof timeout === 'number' ? timeout : 4000));
             }`,
            ctx,
            { filename: "pathfinder-shim" },
          );
        } catch {
          /* ignore */
        }

        // Null-safe equip wrapper — many Voyager skills call bot.equip(item) without null-checking.
        // If the bot lacks the expected tool the item lookup returns null/undefined and the raw
        // bot.equip call throws "Invalid item object in equip".  Silently skipping is the safest
        // default: the skill will either succeed anyway (bot already holding something useful) or
        // fail later with a more informative error.
        try {
          vm.runInContext(
            `const _origEquip = bot.equip.bind(bot);
             bot.equip = async (item, dest) => { if (!item) return; return _origEquip(item, dest); };`,
            ctx,
            { filename: "equip-shim" },
          );
        } catch {
          /* ignore */
        }

        // Load Voyager primitives first (mineBlock, placeItem, craftItem, smeltItem, killMob, exploreUntil)
        try {
          vm.runInContext(VOYAGER_PRIMITIVES, ctx, { filename: "voyager-primitives" });
        } catch {
          /* primitives may throw on parse errors — ignore, skills will fail gracefully */
        }

        // Load the Voyager helper bundle so skills can call each other as helpers
        if (voyagerHelperBundle) {
          try {
            vm.runInContext(voyagerHelperBundle, ctx, { filename: "voyager-helpers" });
          } catch {
            /* helpers may throw if partially evaluated — ignore */
          }
        }

        // Run the definition to populate the context (does not invoke the function yet).
        vm.runInContext(code, ctx, { filename: filePath });

        // Runtime inspection: confirm the expected name is actually a callable function.
        // This handles async functions, regular functions, arrow functions assigned to
        // const/let/var, and any other declaration style — none of which a substring
        // check could reliably catch.
        if (typeof (ctx as any)[name] !== "function") {
          return {
            success: false,
            message: `${name}: file must define a function named '${name}' (found: ${typeof (ctx as any)[name]})`,
          };
        }

        // Invoke the already-defined function.
        // vm.runInContext's `timeout` option only covers synchronous code; the async
        // wrapper returns a Promise immediately, so we race against an explicit timer.
        const vmPromise = vm.runInContext(`(async()=>{ await ${name}(bot); })()`, ctx, {
          filename: filePath,
        }) as Promise<void>;

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${name} timed out after 120s`)), 120_000),
        );

        await Promise.race([vmPromise, timeoutPromise]);
        onProgress({ skillName: name, phase: "Done", progress: 1, message: `${name} complete`, active: false });
        return { success: true, message: `${name} completed.` };
      } catch (err: any) {
        if (signal.aborted) return { success: false, message: `${name} aborted.` };
        return { success: false, message: `${name} failed: ${err.message}` };
      }
    },
  };
}

const STATIC_SKILL_NAMES = new Set([
  "build_house",
  "craft_gear",
  "light_area",
  "build_farm",
  "strip_mine",
  "smelt_ores",
  "go_fishing",
  "build_bridge",
]);

export function getDynamicSkillNames(): string[] {
  return Array.from(skillRegistry.keys()).filter((k) => !STATIC_SKILL_NAMES.has(k));
}
