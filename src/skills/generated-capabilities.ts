import type { Bot } from "mineflayer";
import pkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import {
  GENERATED_CAPABILITY_POLICY,
  type GeneratedCapabilityHandler,
  type GeneratedCapabilityMethod,
} from "./generated-sandbox.js";

const { goals } = pkg;
const ITEM_NAME = /^[a-z0-9_]{1,64}$/;
const DESTINATIONS = new Set(["hand", "head", "torso", "legs", "feet", "off-hand"]);
const METHOD_QUOTAS: Record<GeneratedCapabilityMethod, number> = GENERATED_CAPABILITY_POLICY.methodQuotas;

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

function stopBotOperations(bot: Bot): void {
  try {
    bot.pathfinder.stop();
  } catch {
    // Best-effort stop: the bot may be disconnecting.
  }
  try {
    bot.stopDigging();
  } catch {
    // Best-effort stop: no dig may be active.
  }
}

async function bounded<T>(
  bot: Bot,
  start: () => Promise<T>,
  signal: AbortSignal,
  onTimeout: (error: Error) => void,
  timeoutMs: number,
): Promise<T> {
  if (signal.aborted) throw new Error("Generated skill was aborted");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort = () => {};
  const abort = new Promise<never>((_, reject) => {
    const onAbort = () => {
      stopBotOperations(bot);
      reject(new Error("Generated skill was aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Capability timed out after ${timeoutMs}ms; invocation terminated`);
      onTimeout(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    if (signal.aborted) throw new Error("Generated skill was aborted");
    return await Promise.race([start(), timeout, abort]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort();
  }
}

export function createGeneratedCapabilityHandler(
  bot: Bot,
  options: {
    signal?: AbortSignal;
    maxDistance?: number;
    operationTimeoutMs?: number;
    onFatal?: (error: Error) => void;
  } = {},
): GeneratedCapabilityHandler {
  const signal = options.signal ?? new AbortController().signal;
  const maxDistance = options.maxDistance ?? GENERATED_CAPABILITY_POLICY.maxDistance;
  const origin = dtoPoint(bot.entity.position);
  const uses = new Map<GeneratedCapabilityMethod, number>();
  let fatalError: Error | undefined;
  const poison = (error: Error) => {
    if (fatalError) return;
    fatalError = error;
    stopBotOperations(bot);
    options.onFatal?.(error);
  };
  const run = <T>(start: () => Promise<T>, timeoutMs = 15_000) =>
    bounded(bot, start, signal, poison, Math.min(timeoutMs, options.operationTimeoutMs ?? timeoutMs));
  const stopOnAbort = () => stopBotOperations(bot);
  signal.addEventListener("abort", stopOnAbort, { once: true });

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
    if (fatalError)
      throw new Error("Generated skill invocation is terminated after a capability timeout", { cause: fatalError });
    if (signal.aborted) throw new Error("Generated skill was aborted");
    switch (method) {
      case "observe": {
        charge(method);
        const params = objectParams(rawParams, ["blocks", "includeEntities", "radius"]);
        const radius =
          params.radius === undefined
            ? 16
            : integerParam(params.radius, "radius", 1, GENERATED_CAPABILITY_POLICY.maxObserveRadius);
        if (params.includeEntities !== undefined && typeof params.includeEntities !== "boolean") {
          throw new Error("includeEntities must be a boolean");
        }
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
        const foundPositions = ids.length
          ? bot.findBlocks({ matching: ids, maxDistance: radius, count: GENERATED_CAPABILITY_POLICY.maxObservedBlocks })
          : [];
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
                .slice(0, GENERATED_CAPABILITY_POLICY.maxObservedEntities)
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
        await run(() => bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, radius)));
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
          await run(() =>
            bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2)),
          );
          await run(() => bot.dig(block), 12_000);
        }
        return { ok: true, mined };
      }
      case "craft": {
        const params = objectParams(rawParams, ["item", "count"]);
        const itemName = itemParam(params.item, "item");
        const count =
          params.count === undefined
            ? 1
            : integerParam(params.count, "count", 1, GENERATED_CAPABILITY_POLICY.maxCraftCount);
        charge(method, count);
        const item = bot.registry.itemsByName[itemName];
        if (!item) throw new Error(`Unknown item '${itemName}'`);
        const table = bot.findBlock({ matching: (block) => block.name === "crafting_table", maxDistance: 16 });
        const recipes = bot.recipesFor(item.id, null, 1, table);
        if (!recipes.length) throw new Error(`No available recipe for ${itemName}`);
        await run(() => bot.craft(recipes[0], count, table ?? undefined), 20_000);
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
        await run(() => bot.equip(item, destination as any), 10_000);
        return { ok: true };
      }
      case "consume": {
        charge(method);
        const params = objectParams(rawParams, ["item"]);
        const itemName = itemParam(params.item, "item");
        const item = bot.inventory.items().find((candidate) => candidate.name === itemName);
        if (!item) throw new Error(`No ${itemName} in inventory`);
        await run(() => bot.equip(item, "hand"), 10_000);
        await run(() => bot.consume(), 10_000);
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
        await run(() => bot.equip(item, "hand"), 10_000);
        await run(() => bot.placeBlock(support, new Vec3(0, 1, 0)), 10_000);
        return { ok: true };
      }
      case "look": {
        charge(method);
        const params = objectParams(rawParams, ["x", "y", "z"]);
        const target = point(params);
        inRange(target);
        await run(() => bot.lookAt(new Vec3(target.x, target.y, target.z), true), 5_000);
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
        await run(() => bot.waitForTicks(ticks), Math.max(1_000, ticks * 100));
        return { ok: true };
      }
    }
  };
}
