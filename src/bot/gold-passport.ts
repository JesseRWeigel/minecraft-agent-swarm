// src/bot/gold-passport.ts
// Why a bot keeps wearing the worst boots it owns in the Nether.
//
// Run 757: "[Fortress] Mason: wearing golden_boots for the piglins (on)",
// then, minutes later, "I died! Cause: Mason was slain by Piglin. Armor:
// -,-,iron_leggings,iron_boots". The preflight dressed him correctly and the
// armour pass undressed him, because it ranks iron above gold and runs every
// twenty seconds.
//
// Piglins stay neutral toward anyone wearing a single piece of gold, anywhere
// on the body. In the Nether that one piece is worth more than the two points
// of protection iron adds, so it stays on. Everywhere else gold is simply bad
// armour and the ordinary ranking applies.

/** Does this piece keep the piglins calm, so the armour pass must leave it on? */
export function isGoldPiece(name: string | undefined | null): boolean {
  return !!name && name.startsWith("golden_") && !name.startsWith("golden_apple");
}

/**
 * Bots that have been dressed for piglins, and until when.
 *
 * Run 758 showed why a dimension test is not enough. The log order is
 * "[Armor] equipped iron_boots", then "[Fortress] Mason: wearing golden_boots
 * for the piglins (on)", then twenty seconds later the armour pass runs again
 * while he is still in the overworld and puts the iron back. He crossed with
 * no gold and was shot by piglins twice. The preflight dresses him BEFORE the
 * portal, so the protection has to start there too.
 *
 * A time limit rather than a flag, because nothing reliably signals the end of
 * a trip: a bot that dies in the Nether respawns in the overworld with no
 * event the armour pass can see, and a stale mark would keep it in bad boots
 * for the rest of the run.
 */
const passports = new Map<string, number>();

/** Fifteen minutes: longer than a crossing and shorter than a mining shift. */
export const PASSPORT_TTL_MS = 15 * 60_000;

/** The gold went on for the piglins: keep it on until the trip is over. */
export function markPiglinPassport(botName: string, now = Date.now()): void {
  passports.set(botName, now + PASSPORT_TTL_MS);
}

/** Has this bot been dressed for piglins recently enough to still mean it? */
export function hasPiglinPassport(botName: string | undefined | null, now = Date.now()): boolean {
  const until = passports.get(String(botName ?? ""));
  return until !== undefined && until > now;
}

/** Forget a bot's mark. Used by the tests; a trip normally just times out. */
export function clearPiglinPassport(botName: string): void {
  passports.delete(botName);
}

/**
 * Should a worn piece survive an upgrade to a better tier?
 *
 * `otherWornGold` is whether another slot already carries gold. One piece is
 * all the piglins check, so a second one is free to upgrade.
 */
export function keepsPiglinPassport(
  dimension: string | undefined | null,
  wornName: string | undefined | null,
  otherWornGold: boolean,
  botName?: string | undefined | null,
  now = Date.now(),
): boolean {
  if (!isGoldPiece(wornName)) return false;
  if (otherWornGold) return false;
  return /nether/i.test(String(dimension ?? "")) || hasPiglinPassport(botName, now);
}
