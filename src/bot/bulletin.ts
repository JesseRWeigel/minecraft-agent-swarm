// src/bot/bulletin.ts
// Shared in-memory team status board.
// All bots run in the same Node.js process, so they share this module singleton.

export interface BotStatus {
  name: string;
  action: string;
  position: { x: number; y: number; z: number };
  thought: string;
  health: number;
  food: number;
  timestamp: number;
  /** Current multi-step goal, if any */
  goal?: string;
  /** Result of the last action */
  lastResult?: string;
}

const bulletin = new Map<string, BotStatus>();

/** Update this bot's entry after every decision cycle. */
export function updateBulletin(status: BotStatus): void {
  bulletin.set(status.name, status);
}

/** Get one bot's status — used by the viewer HUD. */
export function getBotStatus(name: string): BotStatus | undefined {
  return bulletin.get(name);
}

/** Get all teammates' statuses (excludes the requester). */
export function getTeamStatus(excludeName: string): BotStatus[] {
  const result: BotStatus[] = [];
  for (const [name, status] of bulletin) {
    if (name !== excludeName) result.push(status);
  }
  return result;
}

/** Format team status for injection into LLM context. */
export function formatTeamBulletin(excludeName: string): string {
  const teammates = getTeamStatus(excludeName);
  if (teammates.length === 0) return "";

  const lines = teammates.map((t) => {
    const pos = `(${Math.round(t.position.x)}, ${Math.round(t.position.y)}, ${Math.round(t.position.z)})`;
    const age = Math.round((Date.now() - t.timestamp) / 1000);
    const stale = age > 30 ? " [stale]" : "";
    return `- ${t.name}: ${t.action} at ${pos} — "${t.thought}"${stale}`;
  });

  return `\nTEAM STATUS (live):\n${lines.join("\n")}`;
}
