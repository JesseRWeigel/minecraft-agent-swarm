import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseBotDeaths,
  formatBotDeaths,
  exceedsDeathRateAlert,
  worstRecentDeathRate,
  RECENT_DEATH_RATE_ALERT,
  MIN_ELAPSED_S,
} from "./death-rate.js";

const HOUR = 3600;

test("parses and re-serialises the per-bot death spec", () => {
  const parsed = parseBotDeaths("Atlas:10,Flora:6,Mason:5");
  assert.equal(parsed.get("Atlas"), 10);
  assert.equal(parsed.get("Flora"), 6);
  assert.equal(parsed.get("Mason"), 5);
  assert.equal(formatBotDeaths(parsed), "Atlas:10,Flora:6,Mason:5");
});

test("survives an empty, absent or malformed spec", () => {
  assert.equal(parseBotDeaths("").size, 0);
  assert.equal(parseBotDeaths("garbage").size, 0);
  assert.equal(parseBotDeaths("Atlas:,Flora:6").get("Flora"), 6);
  assert.equal(formatBotDeaths(new Map()), "");
});

// THE BUG THIS MODULE EXISTS FOR.
//
// WORST_BOT_DEATHS_PER_HR divided ONE bot's SESSION total by the SESSION
// uptime. In a 6h25m session Flora died 6 times, three of them inside the last
// hour, and Mason died 5, three of them in the same hour. The instrument
// printed "Atlas:1" and ALERTS said none.
//
// Two independent defects produced that. Either alone is enough to hide a loop:
//   1. only the session-worst bot was ever evaluated, so Flora and Mason were
//      never looked at no matter how fast they were dying;
//   2. the rate was a session-long average, so deaths concentrated in the most
//      recent hour were divided by every quiet hour that preceded them.
//
// This is the same failure the metric was written to fix, one level down. The
// swarm-wide rate hid one bot; a session-long per-bot average hides one HOUR.
test("catches a bot that starts dying late in a long healthy session", () => {
  // 6 deaths, all inside the last hour of a 6h25m session.
  const prev = parseBotDeaths("Atlas:10,Flora:0,Mason:5");
  const curr = parseBotDeaths("Atlas:10,Flora:6,Mason:5");
  const worst = worstRecentDeathRate(prev, curr, HOUR);
  assert.equal(worst?.bot, "Flora");
  assert.equal(worst?.deaths, 6);
  assert.equal(worst?.perHour, 6);
  assert.ok(worst!.perHour > RECENT_DEATH_RATE_ALERT, "6 deaths in an hour must alert");

  // What the old metric reported for that same session: 6 deaths over 6h25m.
  const sessionAverage = Math.floor((6 * HOUR) / 23_100);
  assert.equal(sessionAverage, 0, "the session average could not have fired at any threshold");
});

test("evaluates every bot, not only the session leader", () => {
  // Atlas leads on session total and is NOT the one in trouble. The old code
  // picked Atlas by max(deaths) and never computed a rate for anyone else.
  const prev = parseBotDeaths("Atlas:20,Flora:1,Mason:1");
  const curr = parseBotDeaths("Atlas:21,Flora:9,Mason:2");
  const worst = worstRecentDeathRate(prev, curr, HOUR);
  assert.equal(worst?.bot, "Flora");
  assert.equal(worst?.deaths, 8);
});

// The hour that exposed the bug must still read healthy, or the fix is just a
// louder alarm. Flora 3/hr and Mason 3/hr were an ordinary night of mobs.
test("the hour that exposed the bug still reports healthy", () => {
  const prev = parseBotDeaths("Atlas:8,Flora:3,Mason:2,Forge:4,Blade:4");
  const curr = parseBotDeaths("Atlas:10,Flora:6,Mason:5,Forge:4,Blade:4");
  const worst = worstRecentDeathRate(prev, curr, HOUR);
  assert.ok(worst, "a worst bot is still reported for visibility");
  assert.equal(worst!.perHour, 3);
  assert.ok(worst!.perHour <= RECENT_DEATH_RATE_ALERT, "3/hr is a normal night, not a loop");
});

// Truncating integer division withheld a real alert once already: at a 6h gap
// 10.3 deaths/hr floored to 10 and lost to a "> 10" test. Compare on tenths.
test("a rate just over the threshold is not truncated away", () => {
  const prev = parseBotDeaths("Atlas:0");
  const curr = parseBotDeaths("Atlas:9");
  // 9 deaths in 2 hours = 4.5/hr. Flooring gives 4, which would not fire.
  const worst = worstRecentDeathRate(prev, curr, 2 * HOUR);
  assert.equal(worst?.perHourTenths, 45);
  assert.ok(worst!.perHourTenths > RECENT_DEATH_RATE_ALERT * 10, "4.5/hr must fire against a 4/hr bar");
});

test("rounding the display to 4.0 does not hide a rate above the alert threshold", () => {
  const previous = parseBotDeaths("Atlas:0");
  const current = parseBotDeaths("Atlas:5");
  const above = worstRecentDeathRate(previous, current, 4470)!;
  assert.equal(above.perHourTenths, 40);
  assert.equal(exceedsDeathRateAlert(above), true, "5 deaths in 74m30s is over 4/hr");

  const equal = worstRecentDeathRate(previous, current, 4500)!;
  const below = worstRecentDeathRate(previous, current, 4530)!;
  assert.equal(equal.perHourTenths, 40);
  assert.equal(below.perHourTenths, 40);
  assert.equal(exceedsDeathRateAlert(equal), false, "exactly 4/hr is not over the threshold");
  assert.equal(exceedsDeathRateAlert(below), false, "the rounded display can also be above the actual rate");
});

test("selects the higher rate even when both bots round to the same tenth", () => {
  const previous = parseBotDeaths("Atlas:0,Flora:0");
  const current = parseBotDeaths("Atlas:100,Flora:101");
  const worst = worstRecentDeathRate(previous, current, 25 * HOUR)!;
  assert.equal(worst.perHourTenths, 40);
  assert.equal(worst.bot, "Flora");
  assert.equal(worst.deaths, 101);
  assert.equal(exceedsDeathRateAlert(worst), true);
});

test("too short a gap carries no signal", () => {
  // 2 deaths 90 seconds apart is 80/hr and means nothing.
  const prev = parseBotDeaths("Atlas:0");
  const curr = parseBotDeaths("Atlas:2");
  assert.equal(worstRecentDeathRate(prev, curr, 90), null);
  assert.equal(worstRecentDeathRate(prev, curr, MIN_ELAPSED_S - 1), null);
  assert.ok(worstRecentDeathRate(prev, curr, MIN_ELAPSED_S) !== null);
});

// With no previous sample every session death looks like it happened just now.
// The first run after a restart would have reported the whole session as recent.
test("the first sample cannot manufacture a spike", () => {
  assert.equal(worstRecentDeathRate(new Map(), parseBotDeaths("Atlas:40"), HOUR), null);
});

// A restarted swarm resets counters to zero. A negative delta is not a
// resurrection, and must not read as a healthy negative rate either.
test("counters going backwards are ignored, not negated", () => {
  const prev = parseBotDeaths("Atlas:40,Flora:9");
  const curr = parseBotDeaths("Atlas:2,Flora:1");
  assert.equal(worstRecentDeathRate(prev, curr, HOUR), null);
});

// A bot that joins mid-session has no previous count. Treating absent as zero
// is right; treating it as "skip" would hide the newcomer entirely.
test("a bot absent from the previous sample counts from zero", () => {
  const worst = worstRecentDeathRate(parseBotDeaths("Atlas:1"), parseBotDeaths("Atlas:1,Blade:7"), HOUR);
  assert.equal(worst?.bot, "Blade");
  assert.equal(worst?.deaths, 7);
});

test("a swarm that stopped dying reports zero rather than nothing", () => {
  const same = parseBotDeaths("Atlas:10,Flora:6");
  const worst = worstRecentDeathRate(same, same, HOUR);
  assert.equal(worst?.perHour, 0);
});

// Replayed against the incidents that motivated the original metric, so the
// rewrite cannot be quietly less sensitive than what it replaces.
test("still fires on every loop the old metric was built for", () => {
  // Forge, 29 deaths in 3h46m — a respawn loop that took two deploys to fix.
  const forge = worstRecentDeathRate(parseBotDeaths("Forge:0"), parseBotDeaths("Forge:29"), 13_560);
  assert.ok(forge!.perHourTenths > RECENT_DEATH_RATE_ALERT * 10, "7.7/hr must fire");
  // Atlas, 11 deaths in 1h54m — a real fall loop.
  const atlas = worstRecentDeathRate(parseBotDeaths("Atlas:0"), parseBotDeaths("Atlas:11"), 6_840);
  assert.ok(atlas!.perHourTenths > RECENT_DEATH_RATE_ALERT * 10, "5.8/hr must fire");
  // Atlas, 13 deaths in 6h32m — healthy, and must stay quiet.
  const calm = worstRecentDeathRate(parseBotDeaths("Atlas:0"), parseBotDeaths("Atlas:13"), 23_520);
  assert.ok(calm!.perHourTenths <= RECENT_DEATH_RATE_ALERT * 10, "2/hr was healthy");
});
