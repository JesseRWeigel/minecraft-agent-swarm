import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && full.endsWith(".ts") ? [full] : [];
  });
}

// Regression guard. mineflayer-pathfinder defaults to maxDropDown=4, which is
// one block into fall-damage range, and allowParkour=true. Fall damage was the
// top death cause for weeks because only 2 of 22 construction sites capped it.
// Atlas took 19 of 22 deaths this way in a single 5h session.
//
// baseMoves() in navigation.ts is the one place allowed to call the raw
// constructor. Everything else must derive from it so fall safety cannot be
// forgotten at a new call site.
test("no module constructs Movements outside navigation.ts", () => {
  const offenders: string[] = [];

  for (const file of walk(SRC)) {
    if (file.endsWith(path.join("bot", "navigation.ts"))) continue;
    if (file.endsWith(".test.ts")) continue;

    const source = fs.readFileSync(file, "utf8");
    source.split("\n").forEach((line, i) => {
      if (line.includes("new Movements(")) {
        offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `these sites bypass baseMoves() and get maxDropDown=4 plus parkour:\n  ${offenders.join("\n  ")}`,
  );
});

test("navigation.ts constructs Movements exactly once, inside baseMoves", () => {
  const source = fs.readFileSync(path.join(SRC, "bot", "navigation.ts"), "utf8");
  const constructions = source.match(/new Movements\(/g) ?? [];

  assert.equal(constructions.length, 1, "baseMoves should be the only constructor call");
  // The single construction must be inside baseMoves and must cap the drop.
  const baseMovesBody = source.slice(source.indexOf("export function baseMoves"));
  assert.match(baseMovesBody.slice(0, 400), /new Movements\(/);
  assert.match(baseMovesBody.slice(0, 400), /maxDropDown\s*=\s*3/);
  assert.match(baseMovesBody.slice(0, 400), /allowParkour\s*=\s*false/);
});

test("safeMoves and explorerMoves derive from baseMoves", () => {
  const source = fs.readFileSync(path.join(SRC, "bot", "navigation.ts"), "utf8");

  for (const fn of ["safeMoves", "explorerMoves"]) {
    const body = source.slice(source.indexOf(`export function ${fn}`));
    assert.match(body.slice(0, 300), /baseMoves\(bot\)/, `${fn} should build on baseMoves`);
  }
});

// Regression: the drowning dig-out escape fired and logged "digging up through
// chest" — a bot destroyed team storage to save itself, scattering whatever was
// banked in it. A drowning costs one respawn; a broken stash chest can scatter
// hundreds of items the team spent hours gathering.
test("drowning escape refuses to dig through valuable blocks", () => {
  const source = fs.readFileSync(path.join(SRC, "bot", "navigation.ts"), "utf8");

  // The guard must exist and cover storage, workstations and unbreakable blocks.
  for (const name of ["chest", "barrel", "furnace", "crafting_table", "bed", "bedrock", "shulker"]) {
    assert.match(source, new RegExp(`"${name}"`), `PRECIOUS_BLOCKS is missing "${name}"`);
  }

  // The choice of what to dig now lives in drown-escape.ts, because the
  // up-only version drowned Mason 5 times under a chest while stone sat beside
  // him. The invariant is unchanged and still has to hold at its new address:
  // every dig goes through chooseDrownEscape, and that consults isPreciousBlock.
  // Anchor on the dig threshold WITHOUT baking in its number — it moved from
  // 10 to 13 once (Mason drowned starting the dig with three hearts of air),
  // and the invariant under test is about WHAT gets dug, never about when.
  const digAnchor = source.search(/if \(air < \d+\) \{\n\s+const p = bot\.entity\.position;/);
  assert.notStrictEqual(digAnchor, -1, "dig-out block not found");
  // Window runs to the swim section that follows the dig-out, so comment and
  // branch growth inside the block (run 560/561 dig-time budget) cannot push
  // the dig call past a fixed character count.
  const digEnd = source.indexOf("swim upward toward the surface", digAnchor);
  assert.notStrictEqual(digEnd, -1, "swim section after the dig-out not found");
  const digBlock = source.slice(digAnchor, digEnd);
  assert.match(digBlock, /chooseDrownEscape\(/, "dig-out must choose its target, not assume the ceiling");
  assert.match(digBlock, /bot\.dig\(/, "dig-out should still dig when a route is ordinary");
  assert.doesNotMatch(digBlock, /bot\.dig\(ceiling\)/, "must not go back to digging whatever is overhead");

  const escapeSource = fs.readFileSync(path.join(SRC, "bot", "drown-escape.ts"), "utf8");
  assert.match(escapeSource, /isPreciousBlock\(/, "the escape chooser must consult isPreciousBlock");
});
