import type { Bot } from "mineflayer";
import pkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import type { GeneratedCapabilityHandler, GeneratedCapabilityMethod } from "./generated-sandbox.js";

const { goals } = pkg;
const ITEM_NAME = /^[a-z0-9_]{1,64}$/;
const DESTINATIONS = new Set(["hand", "head", "torso", "legs", "feet", "off-hand"]);
const METHOD_QUOTAS: Record<GeneratedCapabilityMethod, number> = {
  observe: 16,
  navigate: 4,
  mine: 8,
  craft: 8,
  equip: 8,
  consume: 8,
  place: 8,
  look: 16,
  attack: 8,
  wait: 16,
};

function objectParams(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Capability params must be an object");
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (!allowed.includes(key)) throw new Error(`Unexpected capability parameter '${key}'`);
  }
  return result;
}

function numberParam(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a finite number from ${min} to ${max}`);
  }
  return value;
}

function integerParam(value: unknown, name: string, min: number, max: number): number {
  const number = numberParam(value, name, min, max);
  if (!Number.isSafeInteger(number)) throw new Error(`${name} must be an integer`);
  return number;
}

function itemParam(value: unknown, name: string): string {
  if (typeof value !== "string" || !ITEM_NAME.test(value)) throw new Error(`${name} must be a Minecraft identifier`);
  return value;
}

function point(params: Record<string, unknown>): { x: number; y: number; z: number } {
  return {
    x: numberParam(params.x, "x", -30_000_000, 30_000_000),
    y: numberParam(params.y, "y", -64, 320),
    z: numberParam(params.z, "z", -30_000_000, 30_000_000),
  };
}

function dtoPoint(position: { x: number; y: number; z: number }) {
  return { x: position.x, y: position.y, z: position.z };
}

function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

async function bounded<T>(bot: Bot, operation: Promise<T>, signal: AbortSignal, timeoutMs = 15_000): Promise<T> {
  if (signal.aborted) throw new Error("Generated skill was aborted");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        bot.pathfinder.stop();
      } catch {}
      try {
        bot.stopDigging();
      } catch {}
      reject(new Error(`Capability timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createGeneratedCapabilityHandler(
  bot: Bot,
  options: { signal?: AbortSignal; maxDistance?: number } = {},
): GeneratedCapabilityHandler {
  const signal = options.signal ?? new AbortController().signal;
  const maxDistance = options.maxDistance ?? 64;
  const origin = dtoPoint(bot.entity.position);
  const uses = new Map<GeneratedCapabilityMethod, number>();

  const charge = (method: GeneratedCapabilityMethod, amount = 1) => {
    const next = (uses.get(method) ?? 0) + amount;
    if (next > METHOD_QUOTAS[method]) throw new Error(`Capability '${method}' exceeded its quota`);
    uses.set(method, next);
  };
  const inRange = (position: { x: number; y: number; z: number }) => {
    if (distance(origin, position) > maxDistance) {
      throw new Error(`Capability target exceeds the ${maxDistance}-block invocation radius`);
    }
  };

  return async (method, rawParams) => {
    if (signal.aborted) throw new Error("Generated skill was aborted");
    switch (method) {
      case "observe": {
        charge(method);
        const params = objectParams(rawParams, ["blocks", "includeEntities", "radius"]);
        const radius = params.radius === undefined ? 16 : integerParam(params.radius, "radius", 1, 32);
        const names =
          params.blocks === undefined
            ? []
            : Array.isArray(params.blocks) && params.blocks.length <= 16
              ? params.blocks.map((name) => itemParam(name, "block"))
              : (() => {
                  throw new Error("blocks must be an array of at most 16 Minecraft identifiers");
                })();
        const ids = names
          .map((name) => bot.registry.blocksByName[name]?.id)
          .filter((id): id is number => id !== undefined);
        const foundPositions = ids.length ? bot.findBlocks({ matching: ids, maxDistance: radius, count: 64 }) : [];
        const blocks = foundPositions.flatMap((position) => {
          const block = bot.blockAt(position);
          return block ? [{ name: block.name, position: dtoPoint(block.position) }] : [];
        });
        const entities =
          params.includeEntities === true
            ? Object.values(bot.entities)
                .filter(
                  (entity) =>
                    entity &&
                    entity.type !== "player" &&
                    !entity.username &&
                    distance(bot.entity.position, entity.position) <= radius,
                )
                .slice(0, 32)
                .map((entity) => ({
                  id: entity.id,
                  name: entity.name ?? entity.displayName ?? "unknown",
                  type: entity.type ?? "unknown",
                  position: dtoPoint(entity.position),
                }))
            : [];
        return {
          position: dtoPoint(bot.entity.position),
          health: bot.health,
          food: bot.food,
          inventory: bot.inventory
            .items()
            .slice(0, 46)
            .map((item) => ({ name: item.name, count: item.count })),
          blocks,
          entities,
        };
      }
      case "navigate": {
        charge(method);
        const params = objectParams(rawParams, ["x", "y", "z", "radius"]);
        const target = point(params);
        inRange(target);
        const radius = params.radius === undefined ? 2 : integerParam(params.radius, "radius", 1, 4);
        await bounded(bot, bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, radius)), signal);
        return { ok: true, position: dtoPoint(bot.entity.position) };
      }
      case "mine": {
        const params = objectParams(rawParams, ["block", "count"]);
        const blockName = itemParam(params.block, "block");
        const count = params.count === undefined ? 1 : integerParam(params.count, "count", 1, 8);
        charge(method, count);
        let mined = 0;
        for (; mined < count; mined++) {
          const block = bot.findBlock({ matching: (candidate) => candidate.name === blockName, maxDistance: 32 });
          if (!block) throw new Error(`Cannot find ${blockName} within 32 blocks`);
          inRange(block.position);
          await bounded(
            bot,
            bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2)),
            signal,
          );
          await bounded(bot, bot.dig(block), signal, 12_000);
        }
        return { ok: true, mined };
      }
      case "craft": {
        charge(method);
        const params = objectParams(rawParams, ["item", "count"]);
        const itemName = itemParam(params.item, "item");
        const count = params.count === undefined ? 1 : integerParam(params.count, "count", 1, 16);
        const item = bot.registry.itemsByName[itemName];
        if (!item) throw new Error(`Unknown item '${itemName}'`);
        const table = bot.findBlock({ matching: (block) => block.name === "crafting_table", maxDistance: 16 });
        const recipes = bot.recipesFor(item.id, null, 1, table);
        if (!recipes.length) throw new Error(`No available recipe for ${itemName}`);
        await bounded(bot, bot.craft(recipes[0], count, table ?? undefined), signal, 20_000);
        return { ok: true, crafted: count, item: itemName };
      }
      case "equip": {
        charge(method);
        const params = objectParams(rawParams, ["item", "destination"]);
        const itemName = itemParam(params.item, "item");
        const destination = params.destination === undefined ? "hand" : params.destination;
        if (typeof destination !== "string" || !DESTINATIONS.has(destination))
          throw new Error("Invalid equip destination");
        const item = bot.inventory.items().find((candidate) => candidate.name === itemName);
        if (!item) throw new Error(`No ${itemName} in inventory`);
        await bounded(bot, bot.equip(item, destination as any), signal, 10_000);
        return { ok: true };
      }
      case "consume": {
        charge(method);
        const params = objectParams(rawParams, ["item"]);
        const itemName = itemParam(params.item, "item");
        const item = bot.inventory.items().find((candidate) => candidate.name === itemName);
        if (!item) throw new Error(`No ${itemName} in inventory`);
        await bounded(bot, bot.equip(item, "hand"), signal, 10_000);
        await bounded(bot, bot.consume(), signal, 10_000);
        return { ok: true };
      }
      case "place": {
        charge(method);
        const params = objectParams(rawParams, ["block", "x", "y", "z"]);
        const blockName = itemParam(params.block, "block");
        const target = point(params);
        inRange(target);
        if (distance(bot.entity.position, target) > 6) throw new Error("Placement target is more than 6 blocks away");
        const item = bot.inventory.items().find((candidate) => candidate.name === blockName);
        if (!item) throw new Error(`No ${blockName} in inventory`);
        const support = bot.blockAt(new Vec3(target.x, target.y - 1, target.z));
        if (!support) throw new Error("Placement requires a loaded support block below the target");
        await bounded(bot, bot.equip(item, "hand"), signal, 10_000);
        await bounded(bot, bot.placeBlock(support, new Vec3(0, 1, 0)), signal, 10_000);
        return { ok: true };
      }
      case "look": {
        charge(method);
        const params = objectParams(rawParams, ["x", "y", "z"]);
        const target = point(params);
        inRange(target);
        await bounded(bot, bot.lookAt(new Vec3(target.x, target.y, target.z), true), signal, 5_000);
        return { ok: true };
      }
      case "attack": {
        charge(method);
        const params = objectParams(rawParams, ["entityId"]);
        const entityId = integerParam(params.entityId, "entityId", 0, Number.MAX_SAFE_INTEGER);
        const entity = bot.entities[entityId];
        if (!entity) throw new Error(`Entity ${entityId} is no longer visible`);
        if (entity.type === "player" || entity.username) throw new Error("Generated skills cannot attack players");
        if (distance(bot.entity.position, entity.position) > 16)
          throw new Error("Attack target is more than 16 blocks away");
        bot.attack(entity);
        return { ok: true };
      }
      case "wait": {
        charge(method);
        const params = objectParams(rawParams, ["ticks"]);
        const ticks = integerParam(params.ticks, "ticks", 1, 100);
        await bounded(bot, bot.waitForTicks(ticks), signal, Math.max(1_000, ticks * 100));
        return { ok: true };
      }
    }
  };
}
