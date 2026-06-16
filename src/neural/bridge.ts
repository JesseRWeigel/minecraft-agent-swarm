import net from "node:net";
import { isHostile } from "../bot/perception.js";
import type { Bot } from "mineflayer";

export interface NeuralObservation {
  bot_health: number;
  bot_food: number;
  bot_pos: [number, number, number];
  nearest_hostile: { type: string; distance: number; angle: number; health: number } | null;
  all_entities: Array<{ type: string; distance: number; angle: number }>;
  has_sword: boolean;
  has_shield: boolean;
  has_bow: boolean;
}

export interface NeuralAction {
  action: "attack" | "strafe_left" | "strafe_right" | "flee" | "use_item" | "idle";
  confidence: number;
}

export function buildObservation(bot: Bot): NeuralObservation {
  const pos = bot.entity.position;
  const items = bot.inventory.items().map((i) => i.name);
  let nearestHostile: NeuralObservation["nearest_hostile"] = null;
  const allEntities: NeuralObservation["all_entities"] = [];

  for (const entity of Object.values(bot.entities)) {
    if (entity === bot.entity) continue;
    if (!entity.position) continue;
    const dist = pos.distanceTo(entity.position);
    if (dist > 16) continue;

    const dx = entity.position.x - pos.x;
    const dz = entity.position.z - pos.z;
    // Minecraft yaw: 0=South, π/2=West, π=North, -π/2=East (clockwise from South)
    // Bearing to entity in same system: atan2(-dx, dz)
    const bearingToEntity = Math.atan2(-dx, dz);
    // Normalize relative angle to [0, 180] (how far off-center is the entity)
    let relAngle = Math.abs(bearingToEntity - bot.entity.yaw);
    // Normalize to [0, π] (shortest arc)
    if (relAngle > Math.PI) relAngle = 2 * Math.PI - relAngle;
    const relAngleDeg = relAngle * (180 / Math.PI);

    const type = entity.name || "unknown";
    allEntities.push({ type, distance: dist, angle: relAngleDeg });

    if (isHostile(entity)) {
      if (!nearestHostile || dist < nearestHostile.distance) {
        nearestHostile = { type, distance: dist, angle: relAngleDeg, health: (entity as any).health ?? 20 };
      }
    }
  }

  return {
    bot_health: bot.health,
    bot_food: bot.food,
    bot_pos: [pos.x, pos.y, pos.z],
    nearest_hostile: nearestHostile,
    all_entities: allEntities,
    has_sword: items.some((n) => n.includes("sword")),
    has_shield: items.includes("shield"),
    has_bow: items.includes("bow"),
  };
}

export function queryNeural(obs: NeuralObservation, port = 12345, host = "127.0.0.1"): Promise<NeuralAction> {
  return new Promise((resolve, reject) => {
    let settled = false;
    function settle(fn: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.destroy();
      fn();
    }

    const client = new net.Socket();
    const timeout = setTimeout(() => {
      settle(() => reject(new Error("Neural server timeout")));
    }, 500);

    client.connect(port, host, () => client.write(JSON.stringify(obs) + "\n"));

    let buf = "";
    client.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        settle(() => {
          try {
            resolve(JSON.parse(buf.slice(0, nl)));
          } catch {
            reject(new Error(`Bad response: ${buf}`));
          }
        });
      }
    });

    client.on("error", (err) => settle(() => reject(err)));
  });
}

export async function isNeuralServerRunning(port = 12345): Promise<boolean> {
  try {
    await queryNeural(
      {
        bot_health: 20,
        bot_food: 20,
        bot_pos: [0, 64, 0],
        nearest_hostile: null,
        all_entities: [],
        has_sword: false,
        has_shield: false,
        has_bow: false,
      },
      port,
    );
    return true;
  } catch {
    return false;
  }
}
