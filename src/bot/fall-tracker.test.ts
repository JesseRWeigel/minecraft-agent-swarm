import { test } from "node:test";
import assert from "node:assert/strict";

import { createFallTracker, isFallDeath } from "./fall-tracker.js";

// The bug this file exists for: a falling bot lands before it dies, and the
// landing tick used to overwrite the recorded ground height, so the drop
// computed as ~0 and nothing was logged across two real fall deaths.
test("drop survives the landing tick that precedes a fall death", () => {
  const t = createFallTracker(90);
  t.update(90, true, 0); // walking on high ground
  t.update(89, false, 100); // steps off — fall begins at y=90
  t.update(80, false, 400); // mid-air
  t.update(70, true, 900); // LANDS at y=70, then dies from the damage
  assert.equal(t.dropFrom(70), 20, "must report the 20-block fall, not 0");
  assert.equal(t.originY(), 90);
});

test("a bot that never left the ground reports no fall", () => {
  const t = createFallTracker(64);
  t.update(64, true, 0);
  t.update(64, true, 50);
  assert.equal(t.dropFrom(64), 0);
});

test("walking downhill on the ground is not a fall", () => {
  const t = createFallTracker(80);
  for (let y = 80; y >= 70; y--) t.update(y, true, y);
  assert.equal(t.dropFrom(70), 0, "grounded descent must not read as a drop");
});

test("only the most recent departure from ground counts", () => {
  const t = createFallTracker(100);
  t.update(100, true, 0);
  t.update(99, false, 10); // first fall from 100
  t.update(90, true, 20); // survives, lands at 90
  t.update(89, false, 30); // second fall starts from 90
  t.update(60, true, 40);
  assert.equal(t.dropFrom(60), 30, "must measure the second fall, not the first");
  assert.equal(t.originY(), 90);
});

test("airborne time is zero before the first fall", () => {
  const t = createFallTracker(64);
  t.update(64, true, 500);
  assert.equal(t.airborneMs(900), 0);
});

test("airborne time measures from leaving the ground", () => {
  const t = createFallTracker(64);
  t.update(64, true, 0);
  t.update(63, false, 1000);
  assert.equal(t.airborneMs(3500), 2500);
});

// Three mechanism hypotheses died against the source before this instrument
// existed. What holds the controls at the ground->airborne tick is the evidence.
test("captures what was moving the bot at the moment it left the ground", () => {
  const t = createFallTracker(116);
  t.update(116, true, 0, "controls=forward pathing=true");
  t.update(115, false, 10, "controls=sprint+forward pathing=false");
  t.update(80, false, 500, "controls=none pathing=false");
  t.update(71, true, 900, "controls=none pathing=false");
  assert.equal(t.originContext(), "controls=sprint+forward pathing=false");
  assert.equal(t.dropFrom(71), 45);
});

test("grounded ticks do not overwrite the departure context", () => {
  const t = createFallTracker(90);
  t.update(90, true, 0, "controls=forward");
  t.update(89, false, 10, "controls=left+sprint");
  t.update(72, true, 400, "controls=none"); // landing must not clobber it
  assert.equal(t.originContext(), "controls=left+sprint");
});

test("context defaults to empty when not supplied", () => {
  const t = createFallTracker(64);
  t.update(64, true, 0);
  t.update(63, false, 10);
  assert.equal(t.originContext(), "");
});

// THE FOOTING BUG.
//
// c88d494 added `on=` to answer "what is he standing on when he comes off".
// It read the block below the bot on the ground->airborne tick — but by that
// tick the bot has already stepped over the edge, so `on=` describes the gap
// it fell into, not the ground it left. Three of the first four real records
// read `on=air`, which is tautologically true of every fall and says nothing.
//
// This is the same off-by-one-tick the header comment describes for the fall
// HEIGHT, in the opposite direction: the height was sampled one tick too late
// (the landing) and fixed by holding the last grounded value; the footing is
// sampled one tick too late (the departure) and needs the same treatment.
// originY() already uses lastGroundY. The footing must come from the same tick.
test("footing is the ground the bot left, not the gap it fell into", () => {
  const t = createFallTracker(71);
  t.update(71, true, 0, "controls=none in=air on=cobblestone");
  // First airborne tick: already over the gap, so the block below reads air.
  t.update(70.9, false, 50, "controls=none in=air on=air");
  t.update(50, false, 900, "controls=none in=air on=air");
  assert.equal(
    t.originFooting(),
    "controls=none in=air on=cobblestone",
    "must report the cobblestone it walked off, not the air it fell through",
  );
  // The departure sample is still worth keeping: controls and velocity at the
  // instant of leaving are what killed three hypotheses.
  assert.equal(t.originContext(), "controls=none in=air on=air");
});

test("footing survives the landing tick like the height does", () => {
  const t = createFallTracker(118);
  t.update(118, true, 0, "on=oak_planks");
  t.update(117, false, 10, "on=air");
  t.update(96, true, 900, "on=grass_block"); // lands, then dies
  assert.equal(t.originFooting(), "on=oak_planks", "landing must not clobber the footing");
});

test("only the most recent departure's footing is kept", () => {
  const t = createFallTracker(100);
  t.update(100, true, 0, "on=stone");
  t.update(99, false, 10, "on=air");
  t.update(90, true, 20, "on=dirt"); // survives the first fall
  t.update(89, false, 30, "on=air"); // second fall leaves from dirt
  assert.equal(t.originFooting(), "on=dirt");
});

test("footing is empty before the bot has ever left the ground", () => {
  const t = createFallTracker(64);
  t.update(64, true, 0, "on=stone");
  assert.equal(t.originFooting(), "");
});

// onGround LAGS, so "the last grounded tick" is not the departure point.
//
// Three independent fall records, after the footing was already moved one tick
// earlier by the previous fix, all read identically:
//
//   Forge  [stood vel=-0.08 at=282,119,-323 in=air on=air]
//   Blade  [stood vel=-0.08 at=282,120,-322 in=air on=air]
//   Blade  [stood vel=-0.08 at=277,107,-305 in=air on=air]
//
// vel=-0.08 is one tick of gravity. At every tick where mineflayer reported
// onGround=true, the entity had ALREADY started falling — the flag reflects the
// last server-confirmed state, not the current one. So both samples are taken
// after departure and both read air, which is why two rounds of fixing WHEN to
// sample produced the same useless answer.
//
// Stop trusting the flag. Track the last tick the block below was actually
// solid, whatever onGround claimed, and report how stale it is.
test("footing comes from the last SOLID ground, not the last onGround tick", () => {
  const t = createFallTracker(120);
  t.update(120, true, 0, "on=cobblestone", true);
  // onGround still true here, but the bot is over air and already descending.
  t.update(120, true, 50, "on=air", false);
  t.update(119, false, 100, "on=air", false);
  assert.equal(t.originFooting(), "on=cobblestone", "must report the cobblestone, not the lagging tick");
});

test("reports how stale the footing sample is", () => {
  const t = createFallTracker(120);
  t.update(120, true, 1000, "on=stone", true);
  t.update(120, true, 1050, "on=air", false);
  t.update(119, false, 1100, "on=air", false);
  assert.equal(t.footingAgeMs(1100), 100, "100ms between the last solid ground and leaving");
});

// If the ground never was solid in the samples we hold, say so rather than
// inventing one. That is itself the finding: a bot that was never on ground.
test("no solid footing ever seen reports empty, not a guess", () => {
  const t = createFallTracker(120);
  t.update(120, true, 0, "on=air", false);
  t.update(119, false, 50, "on=air", false);
  assert.equal(t.originFooting(), "");
});

// Backwards compatible: callers that do not pass the flag keep the old
// behaviour rather than silently recording nothing.
test("omitting the solid flag falls back to the grounded sample", () => {
  const t = createFallTracker(90);
  t.update(90, true, 0, "on=dirt");
  t.update(89, false, 10, "on=air");
  assert.equal(t.originFooting(), "on=dirt");
});

// THE SUPPRESSION BUG.
//
// The death log emits the fall record only when the computed drop exceeds 1.
// That gate is backwards for the case that matters. In one 2h45m session:
//
//   Blade "fell from a high place"  -> NO record at all
//   Forge "was slain by Zombie"     -> a full record, for a 1.1 block drop
//
// The instrument fired on a trivial drop attached to an unrelated death and
// stayed silent on the only death whose cause was literally a fall. When the
// tracker is confused about a fall, the drop it computes is exactly the thing
// that cannot be trusted to decide whether to print.
//
// A fall death with no telemetry is the case the whole investigation is waiting
// on, so the cause has to open the gate, not the number the tracker produced.
test("a fall-family death is recognised whatever the computed drop", () => {
  for (const cause of [
    "Blade fell from a high place",
    "Atlas hit the ground too hard",
    "Forge fell off a ladder",
    "Mason fell out of the world",
  ]) {
    assert.equal(isFallDeath(cause), true, `should be a fall: ${cause}`);
  }
});

test("ordinary deaths are not fall deaths", () => {
  for (const cause of [
    "Forge was slain by Zombie",
    "Blade was shot by Skeleton",
    "Mason drowned",
    "Flora was blown up by Creeper",
    "Mason suffocated in a wall",
  ]) {
    assert.equal(isFallDeath(cause), false, `should not be a fall: ${cause}`);
  }
});

// "hit the ground too hard" was missed by every fall count I ran today, because
// I only ever grepped "fell from". Spellings are part of the interface.
test("every spelling Minecraft uses for fall damage is covered", () => {
  assert.equal(isFallDeath("hit the ground too hard"), true);
  assert.equal(isFallDeath("fell from a high place"), true);
});

test("fall tracker: freezes where the bot last stood, not where it ended up", () => {
  const t = createFallTracker(64);
  // Walking along a gravel crust, then one step over the edge.
  t.update(64, true, 1000, "on=gravel", true, { x: 172, y: 64, z: -18 });
  t.update(64, true, 1050, "on=gravel", true, { x: 172, y: 64, z: -18 });
  t.update(64, false, 1100, "on=air", false, { x: 171, y: 64, z: -19 });
  assert.deepStrictEqual(
    t.originFootingPos(),
    { x: 172, y: 64, z: -18 },
    "the footing position must be the last SOLID sample, so the spot can be read back after the fall",
  );
});

test("fall tracker: reports no footing position when the bot was never on solid ground", () => {
  const t = createFallTracker(64);
  t.update(64, true, 1000, "on=air", false, { x: 1, y: 64, z: 1 });
  t.update(64, false, 1050, "on=air", false, { x: 1, y: 64, z: 1 });
  assert.strictEqual(t.originFootingPos(), null);
});
