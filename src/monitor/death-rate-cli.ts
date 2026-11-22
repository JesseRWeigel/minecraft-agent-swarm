/**
 * Thin CLI so swarm-health.sh can use the tested rate logic instead of keeping
 * its own copy in bash. A second implementation is a second thing to be wrong,
 * and the bash one would be the untested one.
 *
 *   node --import tsx src/monitor/death-rate-cli.ts <prev> <curr> <elapsedSeconds>
 *
 * Prints KEY=VALUE lines to match the rest of the health output. Prints
 * nothing at all when the comparison carries no signal.
 */
import { parseBotDeaths, worstRecentDeathRate, exceedsDeathRateAlert, RECENT_DEATH_RATE_ALERT } from "./death-rate.js";

const [prevSpec = "", currSpec = "", elapsedRaw = "0"] = process.argv.slice(2);
const elapsed = Number.parseInt(elapsedRaw, 10);

const worst = worstRecentDeathRate(
  parseBotDeaths(prevSpec),
  parseBotDeaths(currSpec),
  Number.isNaN(elapsed) ? 0 : elapsed,
);

if (worst) {
  console.log(`WORST_BOT_DEATHS_PER_HR=${worst.bot}:${worst.perHour}`);
  if (exceedsDeathRateAlert(worst)) {
    // When the whole-number display equals the threshold, show the measured
    // count and elapsed time instead of claiming that e.g. 4 exceeds 4.
    const alert =
      worst.perHour <= RECENT_DEATH_RATE_ALERT
        ? `${worst.deaths}_deaths_in_${worst.elapsedSeconds}s_over_${RECENT_DEATH_RATE_ALERT}_per_hr`
        : `${worst.perHour}_per_hr_over_${RECENT_DEATH_RATE_ALERT}`;
    console.log(`ALERT=one_bot_dying_${worst.bot}_${alert}`);
  }
}
