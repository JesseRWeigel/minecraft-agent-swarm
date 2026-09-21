// src/bot/fall-tracker.ts
// Tracks how far a bot fell, for death attribution.
//
// The first version of this logged nothing across two fall deaths. It updated
// "last ground Y" on every movement tick where onGround was true — but a falling
// bot LANDS before it dies, and that landing fires a grounded tick which
// overwrote the height with the bottom of the fall. Drop computed as ~0 and the
// log suppressed itself.
//
// The height that matters is the ground the bot left, captured on the
// ground -> airborne transition and held until the next one, so it survives the
// landing tick and is still readable when the death event arrives.

export interface FallTracker {
  /** `context` describes what was moving the bot at this instant. It is only
   *  retained if this tick is the moment the bot leaves the ground, which is the
   *  one sample that says what walked it off the edge. */
  update(y: number, onGround: boolean, now: number, context?: string, onSolid?: boolean, pos?: FootingPos | null): void;
  /** Blocks fallen from the last ground the bot left, given where it ended up. */
  dropFrom(currentY: number): number;
  /** Height the fall started from — the ground the bot walked off. */
  originY(): number;
  /** How long it has been airborne, or since it landed. */
  airborneMs(now: number): number;
  /** What was moving the bot when it left the ground. */
  originContext(): string;
  /**
   * The last sample taken while the bot was still standing — what it was ON.
   *
   * Distinct from originContext() on purpose. By the ground -> airborne tick the
   * bot is already over the gap, so anything read about the world BELOW it then
   * describes where it is falling to, not where it left. Controls and velocity
   * are only meaningful at departure; footing is only meaningful one tick earlier.
   */
  originFooting(): string;
  /**
   * How long before leaving the ground the footing sample was taken.
   *
   * Non-zero means onGround was still claiming true after the bot was already
   * over air, which is the lag this exists to expose. 0 means they agreed.
   */
  footingAgeMs(now: number): number;
  /**
   * Where the bot stood for that footing sample.
   *
   * The footing string says what it was standing ON; this says where, so the
   * same spot can be read back after the fall. Run 752: two of Mason's lava
   * deaths were short drops, 2.0 and 3.5 blocks, off gravel and into lava,
   * while the planner was walking. Gravel falls when its support goes, so
   * "was gravel, is now air, with lava under it" and "the planner stepped off
   * a ledge onto lava" are different bugs with different fixes, and only the
   * block that is there afterwards tells them apart.
   */
  originFootingPos(): FootingPos | null;
}

/** A block position, kept plain so the tracker stays free of vec3. */
export interface FootingPos {
  x: number;
  y: number;
  z: number;
}

export function createFallTracker(initialY: number): FallTracker {
  let onGroundPrev = true;
  let lastGroundY = initialY;
  let fallStartY = initialY;
  let leftGroundAt = 0;
  let departureContext = "";
  // The two halves of a fall origin, sampled one tick apart. lastGroundContext
  // trails the feet exactly as lastGroundY does, and freezes at the same moment.
  let lastGroundContext = "";
  let footingContext = "";
  // onGround LAGS. Three fall records all showed vel=-0.08 -- one tick of
  // gravity -- at the last tick the flag claimed true, so both the departure
  // and the grounded sample were taken after the bot was already falling and
  // both read air. Track the last tick the block below was genuinely SOLID,
  // whatever the flag said, and how stale that sample is.
  let lastSolidContext = "";
  let lastSolidPos: FootingPos | null = null;
  let footingPos: FootingPos | null = null;
  let lastGroundPos: FootingPos | null = null;
  let lastSolidAt = 0;
  let footingAt = 0;
  let sawSolid = false;
  // Whether the caller reports footing at all. Passing false is a statement
  // that the ground was NOT solid; omitting the argument is no statement, and
  // must keep the old behaviour rather than silently reporting nothing.
  let footingReported = false;

  return {
    update(y, onGround, now, context = "", onSolid, pos = null) {
      // Solid ground beneath is a fact about the world; onGround is a claim
      // about the client's last server sync. Prefer the fact when given one.
      if (onSolid !== undefined) footingReported = true;
      if (onSolid) {
        lastSolidContext = context;
        lastSolidPos = pos;
        lastSolidAt = now;
        sawSolid = true;
      }
      if (onGround) {
        // Whatever is true while standing is the last honest description of the
        // ground. Held here, frozen below, for the same reason as lastGroundY.
        lastGroundContext = context;
        lastGroundPos = pos;
        if (onGroundPrev) {
          // Continuous ground contact — no fall is pending, so the origin tracks
          // the feet. Without this a bot walking down a 10-block slope reported a
          // 10-block fall, because the origin sat at wherever it first spawned.
          fallStartY = y;
        }
        // Else: this tick IS the landing. Hold the frozen origin so the death
        // event, which fires immediately after fall damage, can still read it.
        // A bot that survives resumes tracking on the next grounded tick.
        lastGroundY = y;
      } else if (onGroundPrev) {
        // Ground -> airborne: the only moment the fall origin is knowable.
        fallStartY = lastGroundY;
        leftGroundAt = now;
        departureContext = context;
        // A caller that reports footing and never saw solid ground means the bot
        // was never on any: say so, rather than handing back the lagging sample.
        footingContext = footingReported ? (sawSolid ? lastSolidContext : "") : lastGroundContext;
        footingPos = footingReported ? (sawSolid ? lastSolidPos : null) : lastGroundPos;
        footingAt = sawSolid ? lastSolidAt : now;
        leftGroundAt = now;
      }
      onGroundPrev = onGround;
    },
    dropFrom(currentY) {
      return fallStartY - currentY;
    },
    originY() {
      return fallStartY;
    },
    airborneMs(now) {
      return leftGroundAt === 0 ? 0 : now - leftGroundAt;
    },
    originContext() {
      return departureContext;
    },
    originFooting() {
      return footingContext;
    },
    footingAgeMs() {
      return footingAt === 0 || leftGroundAt === 0 ? 0 : leftGroundAt - footingAt;
    },
    originFootingPos() {
      return footingPos;
    },
  };
}

/**
 * Does this death message name a fall?
 *
 * The death log gated its fall record on `drop > 1`, which is backwards for the
 * only case that matters. In one 2h45m session Blade "fell from a high place"
 * and produced NO record, while Forge "was slain by Zombie" produced a full one
 * for a 1.1 block drop. When the tracker is confused about a fall, the drop it
 * computes is precisely the number that cannot decide whether to print.
 *
 * "hit the ground too hard" is here because every fall count I ran today grepped
 * only "fell from" and silently missed it. The spellings are part of the
 * interface, not trivia.
 */
const FALL_DEATH_PHRASES = [
  "fell from a high place",
  "hit the ground too hard",
  "fell off a ladder",
  "fell off some vines",
  "fell off scaffolding",
  "fell out of the world",
  "fell while climbing",
];

export function isFallDeath(cause: string): boolean {
  const c = cause.toLowerCase();
  return FALL_DEATH_PHRASES.some((p) => c.includes(p));
}
