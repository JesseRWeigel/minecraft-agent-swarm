/**
 * Per-bot death rate over the window BETWEEN health checks.
 *
 * swarm-health.sh already learned twice that a threshold on an accumulating
 * counter is a guaranteed future false positive, and once that a swarm-wide
 * rate hides a single bot in a loop. WORST_BOT_DEATHS_PER_HR was the fix for
 * the second lesson but was written with the first still half-applied: it took
 * ONE bot's session total over the session uptime.
 *
 * That leaves a blind spot with a precise shape. Deaths concentrated in the
 * most recent hour are divided by every quiet hour before them, so the longer
 * a session stays healthy the harder it becomes for it to report a new loop.
 * A bot dying 6 times in the last hour of a 6h session reported 1/hr against a
 * 4/hr bar, and no threshold could have caught it.
 *
 * So: a rate over the RECENT window, for EVERY bot, not a session average for
 * the session leader.
 */

/** Deaths per hour, for one bot, that is worth interrupting for. */
export const RECENT_DEATH_RATE_ALERT = 4;

/**
 * Two deaths 90 seconds apart is 80/hr and means nothing. Same guard, and the
 * same reasoning, as the swarm-wide delta rates in swarm-health.sh.
 */
export const MIN_ELAPSED_S = 600;

export interface RecentDeathRate {
  bot: string;
  /** Deaths in the window, not in the session. */
  deaths: number;
  /** Elapsed time for exact comparisons, before display rounding. */
  elapsedSeconds: number;
  /** Whole deaths per hour, for display. */
  perHour: number;
  /** Rounded tenths of a death per hour, for display only. */
  perHourTenths: number;
}

/** Parses `Atlas:10,Flora:6`. Anything unparseable is dropped, not thrown. */
export function parseBotDeaths(spec: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of spec.split(",")) {
    const [bot, count] = entry.split(":");
    if (!bot || count === undefined) continue;
    const n = Number.parseInt(count, 10);
    if (Number.isNaN(n)) continue;
    out.set(bot.trim(), n);
  }
  return out;
}

export function formatBotDeaths(deaths: Map<string, number>): string {
  return [...deaths].map(([bot, n]) => `${bot}:${n}`).join(",");
}

/**
 * The bot dying fastest since the previous health check, or null when the
 * comparison cannot mean anything.
 *
 * Returns null rather than a zero so a caller cannot mistake "no signal" for
 * "no deaths": an absent previous sample and a swarm that stopped dying are
 * different facts.
 */
export function worstRecentDeathRate(
  prev: Map<string, number>,
  curr: Map<string, number>,
  elapsedSeconds: number,
): RecentDeathRate | null {
  if (elapsedSeconds < MIN_ELAPSED_S) return null;
  // No previous sample means every session death looks like it happened just
  // now. The first run after a restart would report the whole session as recent.
  if (prev.size === 0) return null;

  let worst: RecentDeathRate | null = null;
  for (const [bot, count] of curr) {
    const before = prev.get(bot) ?? 0;
    const deaths = count - before;
    // A restarted swarm resets its counters. That is a new session, not a bot
    // coming back to life, and a negative delta must not read as a calm rate.
    if (deaths < 0) return null;

    // Every bot has the same window; comparing counts compares exact rates.
    if (!worst || deaths > worst.deaths) {
      const perHourTenths = Math.round((deaths * 36_000) / elapsedSeconds);
      worst = { bot, deaths, elapsedSeconds, perHour: Math.floor(perHourTenths / 10), perHourTenths };
    }
  }
  return worst;
}

/** True when this rate is worth an ALERT rather than a line of output. */
export function exceedsDeathRateAlert(rate: RecentDeathRate): boolean {
  // Compare without division so a rounded display cannot change the alert.
  return rate.deaths * 3600 > RECENT_DEATH_RATE_ALERT * rate.elapsedSeconds;
}
