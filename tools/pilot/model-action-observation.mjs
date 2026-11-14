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

// Optional local entities are untrusted observation data, never serialized whole.
function droppedItemsProjection(entities, origin) {
  const candidates = [];
  let scanned = 0,
    truncated = false;
  if (!entities || typeof entities !== "object" || Array.isArray(entities))
    return { nearbyDroppedItems: [], nearbyDroppedItemsTruncated: false };
  // Mineflayer uses a plain entity map. Do not traverse arbitrary prototypes.
  const prototype = Object.getPrototypeOf(entities);
  if (prototype !== Object.prototype && prototype !== null)
    return { nearbyDroppedItems: [], nearbyDroppedItemsTruncated: false };
  for (const key in entities) {
    if (!Object.hasOwn(entities, key)) continue;
    if (scanned >= 256) {
      truncated = true;
      break;
    }
    scanned += 1;
    try {
      const entity = entities[key];
      if (!entity || typeof entity !== "object" || typeof entity.getDroppedItem !== "function") continue;
      const position = worldPosition(entity.position);
      const distance = Math.hypot(position.x - origin.x, position.y - origin.y, position.z - origin.z);
      if (distance > 8) continue;
      const item = entity.getDroppedItem();
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
        continue;
      candidates.push({ name: item.name, count: item.count, position, distance });
    } catch {
      /* Malformed optional entity cannot invalidate the core observation. */
    }
  }
  candidates.sort(
    (a, b) =>
      a.distance - b.distance ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      a.position.x - b.position.x ||
      a.position.y - b.position.y ||
      a.position.z - b.position.z ||
      a.count - b.count,
  );
  if (candidates.length > 16) truncated = true;
  return {
    nearbyDroppedItems: candidates.slice(0, 16).map(({ name, count, position }) => ({ name, count, position })),
    nearbyDroppedItemsTruncated: truncated,
  };
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
    let dropped = { nearbyDroppedItems: [], nearbyDroppedItemsTruncated: false };
    try {
      dropped = droppedItemsProjection(bot.entities, position);
    } catch {
      /* optional map */
    }
    const result = {
      schema_version: 1,
      source: "participant_bot",
      position,
      yaw: bot.entity.yaw,
      pitch: bot.entity.pitch,
      health: bot.health,
      inventory,
      visibleBlocks,
      ...dropped,
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_OBSERVATION_BYTES) invalid();
    return result;
  } catch {
    invalid();
  }
}
