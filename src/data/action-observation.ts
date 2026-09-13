import type { Bot } from "mineflayer";

export const MAX_OBSERVED_ITEM_TYPES = 128;
export const MAX_OBSERVED_INVENTORY_ENTRIES = 4096;
export type ActionObservationStage = "before_execution" | "at_terminal";

export interface ActionStateObservation {
  captureVersion: 1;
  stage: ActionObservationStage;
  source: "mineflayer_client_state";
  actionId: string;
  provenance: { observerIdentity: string; time: "episode_event.occurredAt" };
  limits: {
    sameProcessAsExecutor: true;
    sharedWorldView: true;
    instantaneousClientSample: true;
    independentOfExecutorProse: true;
    serverOracle: false;
    supportsTransferAttribution: false;
    supportsRecoveryInferenceFromDeltaAlone: false;
  };
  capture: { complete: boolean; unavailableFields: string[] };
  state: {
    position: { x: number; y: number; z: number; dimension: string | null } | null;
    inventory: {
      counts: Record<string, number>;
      observedTotalCount: number;
      totalCountComplete: boolean;
      observedDistinctItemTypes: number;
      entriesExamined: number;
      truncated: boolean;
      maxDistinctItemTypes: number;
      maxEntries: number;
    } | null;
    health: number | null;
    available: { position: boolean; dimension: boolean; inventory: boolean; health: boolean };
  };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Bounded Mineflayer client state, independent of executor prose but not an
 * independent server oracle. It shares process/world view and sampling timing;
 * deltas alone do not prove success, transfer attribution, or recovery. */
export function captureActionObservation(
  bot: Bot,
  observerIdentity: string,
  actionId: string,
  stage: ActionObservationStage,
): ActionStateObservation {
  const unavailable = new Set<string>();
  let dimension: string | null = null;
  try {
    const value = (bot as any)?.game?.dimension;
    if (typeof value === "string" && value.length > 0 && value.length <= 160) dimension = value;
    else unavailable.add("dimension");
  } catch {
    unavailable.add("dimension");
  }

  let position: ActionStateObservation["state"]["position"] = null;
  try {
    const raw = (bot as any)?.entity?.position;
    const x = finite(raw?.x),
      y = finite(raw?.y),
      z = finite(raw?.z);
    if (x !== null && y !== null && z !== null) position = { x, y, z, dimension };
    else unavailable.add("position");
  } catch {
    unavailable.add("position");
  }

  let health: number | null = null;
  try {
    health = finite((bot as any)?.health);
    if (health === null) unavailable.add("health");
  } catch {
    unavailable.add("health");
  }

  let inventory: ActionStateObservation["state"]["inventory"] = null;
  try {
    const items = (bot as any)?.inventory?.items?.();
    if (!Array.isArray(items)) throw new Error("items unavailable");
    const aggregate = new Map<string, number>();
    let invalid = false;
    let overflow = false;
    let observedTotalCount = 0;
    const entriesExamined = Math.min(items.length, MAX_OBSERVED_INVENTORY_ENTRIES);
    const entriesTruncated = items.length > MAX_OBSERVED_INVENTORY_ENTRIES;
    let distinctTruncated = false;
    for (let index = 0; index < entriesExamined; index++) {
      const item = items[index];
      const name = typeof item?.name === "string" ? item.name : "";
      const count = finite(item?.count);
      if (!name || name.length > 160 || count === null || !Number.isSafeInteger(count) || count < 0) {
        invalid = true;
        continue;
      }
      if (count === 0) continue;
      if (!Number.isSafeInteger(observedTotalCount + count)) overflow = true;
      else observedTotalCount += count;
      const prior = aggregate.get(name) ?? 0;
      if (!aggregate.has(name) && aggregate.size >= MAX_OBSERVED_ITEM_TYPES) {
        distinctTruncated = true;
        continue;
      }
      const next = prior + count;
      if (!Number.isSafeInteger(next)) overflow = true;
      else aggregate.set(name, next);
    }
    const entries = [...aggregate.entries()].sort(([a], [b]) => a.localeCompare(b));
    const truncated = entriesTruncated || distinctTruncated;
    inventory = {
      counts: Object.fromEntries(entries),
      observedTotalCount,
      totalCountComplete: !invalid && !overflow && !entriesTruncated,
      observedDistinctItemTypes: entries.length,
      entriesExamined,
      truncated,
      maxDistinctItemTypes: MAX_OBSERVED_ITEM_TYPES,
      maxEntries: MAX_OBSERVED_INVENTORY_ENTRIES,
    };
    if (invalid) unavailable.add("inventory.invalid_entries");
    if (overflow) unavailable.add("inventory.total_or_item_count_overflow");
    if (entriesTruncated) unavailable.add("inventory.entries_truncated");
    if (distinctTruncated) unavailable.add("inventory.distinct_counts_truncated");
  } catch {
    unavailable.add("inventory");
  }

  return {
    captureVersion: 1,
    stage,
    source: "mineflayer_client_state",
    actionId,
    provenance: { observerIdentity, time: "episode_event.occurredAt" },
    limits: {
      sameProcessAsExecutor: true,
      sharedWorldView: true,
      instantaneousClientSample: true,
      independentOfExecutorProse: true,
      serverOracle: false,
      supportsTransferAttribution: false,
      supportsRecoveryInferenceFromDeltaAlone: false,
    },
    capture: { complete: unavailable.size === 0, unavailableFields: [...unavailable].sort() },
    state: {
      position,
      inventory,
      health,
      available: {
        position: position !== null,
        dimension: dimension !== null,
        inventory: inventory !== null,
        health: health !== null,
      },
    },
  };
}
