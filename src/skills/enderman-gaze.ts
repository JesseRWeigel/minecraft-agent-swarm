import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

/**
 * Endermen turn hostile when a player looks at their eyes. Vanilla's test
 * (EnderMan.isLookingAtMe): the unit vector from the player's eye to the
 * enderman's eye, dotted with the player's view vector, exceeds
 * 1 - 0.025 / distance, with line of sight.
 *
 * Run 820: five fortress marches in a row were "slain by Enderman" along
 * one corridor of the Nether route, x 336 to 398 at y=52. The guard below
 * tilts the view down whenever it comes near an enderman's eyes, using a
 * cone wider than vanilla's so a turning head never crosses the real one.
 */

/** Enderman eye height above its feet (vanilla EntityDimensions 2.9 tall, eyes 2.55). */
export const ENDERMAN_EYE = 2.55;

/** mineflayer's view vector for a yaw and pitch (pitch up is positive). */
export function viewVector(yaw: number, pitch: number): Vec3 {
  return new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
}

/**
 * Would this view provoke (or come close to provoking) an enderman at
 * `feet`? `margin` scales vanilla's 0.025 tolerance; 4 means a cone four
 * times wider than the game's.
 */
export function gazeProvokes(eye: Vec3, yaw: number, pitch: number, feet: Vec3, margin = 4): boolean {
  const target = feet.offset(0, ENDERMAN_EYE, 0).minus(eye);
  const d = target.norm();
  if (d < 0.5 || d > 64) return false;
  const dir = target.scaled(1 / d);
  const dot = dir.dot(viewVector(yaw, pitch));
  return dot > 1 - (0.025 * margin) / d;
}

/** Look down while an enderman's eyes sit near the view. Returns an uninstaller. */
export function installEndermanGazeGuard(bot: Bot, tag: string): () => void {
  let lastLog = 0;
  const onTick = () => {
    const e = bot.entity;
    if (!e) return;
    const eye = e.position.offset(0, 1.62, 0);
    for (const m of Object.values(bot.entities)) {
      if (m.name !== "enderman" || !m.isValid) continue;
      if (!gazeProvokes(eye, e.yaw, e.pitch, m.position)) continue;
      // Straight down never meets an enderman's eyes: they are always
      // above a standing player's feet level.
      void bot.look(e.yaw, -1.2, true).catch(() => {});
      if (Date.now() - lastLog > 10_000) {
        lastLog = Date.now();
        console.log(
          `[Gaze] ${bot.username}: enderman ${m.position.distanceTo(e.position).toFixed(0)} away in the view (${tag}); looking down`,
        );
      }
      return;
    }
  };
  bot.on("physicsTick", onTick);
  return () => bot.removeListener("physicsTick", onTick);
}
