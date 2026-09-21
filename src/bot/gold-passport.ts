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
 * Should a worn piece survive an upgrade to a better tier?
 *
 * `otherWornGold` is whether another slot already carries gold. One piece is
 * all the piglins check, so a second one is free to upgrade.
 */
export function keepsPiglinPassport(
  dimension: string | undefined | null,
  wornName: string | undefined | null,
  otherWornGold: boolean,
): boolean {
  if (!isGoldPiece(wornName)) return false;
  if (!/nether/i.test(String(dimension ?? ""))) return false;
  return !otherWornGold;
}
