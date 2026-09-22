const MAX_OBSERVATION_BYTES = 16_384;
const MAX_SLOTS = 46;
const MAX_WORLD_COORDINATE = 30_000_000;
const ITEM_NAME = /^[a-z0-9_]{1,64}$/;

function invalid() {
  throw new Error("invalid model observation");
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function worldPosition(position, integer = false) {
  if (!position || typeof position !== "object" || Array.isArray(position)) invalid();
  const { x, y, z } = position;
  if (
    ![x, y, z].every(finite) ||
    (integer && ![x, y, z].every(Number.isInteger)) ||
    Math.abs(x) > MAX_WORLD_COORDINATE ||
    Math.abs(z) > MAX_WORLD_COORDINATE ||
    y < -64 ||
    y > 319
  )
    invalid();
  return { x, y, z };
}

function inventoryProjection(slots) {
  if (!Array.isArray(slots) || slots.length > MAX_SLOTS) invalid();
  const inventory = [];
  for (let slot = 0; slot < slots.length; slot += 1) {
    const item = slots[slot];
    if (item === null) continue;
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.name !== "string" ||
      !ITEM_NAME.test(item.name) ||
      !Number.isInteger(item.count) ||
      item.count < 1 ||
      item.count > 64
    )
      invalid();
    inventory.push({ slot, name: item.name, count: item.count });
  }
  return inventory;
}

export function snapshotModelObservation(bot) {
  try {
    if (!bot || typeof bot !== "object" || !bot.entity || typeof bot.entity !== "object") invalid();
    const position = worldPosition(bot.entity.position);
    if (
      !finite(bot.entity.yaw) ||
      !finite(bot.entity.pitch) ||
      !finite(bot.health) ||
      bot.health < 0 ||
      bot.health > 2048
    )
      invalid();
    if (!bot.inventory || typeof bot.inventory !== "object") invalid();
    const inventory = inventoryProjection(bot.inventory.slots);
    if (typeof bot.blockAtCursor !== "function") invalid();
    const block = bot.blockAtCursor(4.5);
    const visibleBlocks =
      block === null
        ? []
        : (() => {
            if (!block || typeof block !== "object" || typeof block.name !== "string" || !ITEM_NAME.test(block.name))
              invalid();
            const point = worldPosition(block.position, true);
            return [{ name: block.name, x: point.x, y: point.y, z: point.z }];
          })();
    const result = {
      schema_version: 1,
      source: "participant_bot",
      position,
      yaw: bot.entity.yaw,
      pitch: bot.entity.pitch,
      health: bot.health,
      inventory,
      visibleBlocks,
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_OBSERVATION_BYTES) invalid();
    return result;
  } catch {
    invalid();
  }
}
