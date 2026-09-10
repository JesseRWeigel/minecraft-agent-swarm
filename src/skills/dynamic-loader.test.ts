import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("dynamic-loader: does not host-load a generated JS candidate", async () => {
  const { loadDynamicSkills } = await import("./dynamic-loader.js");
  const { skillRegistry } = await import("./registry.js");

  const tmpDir = path.join(__dirname, "../../skills/generated");
  fs.mkdirSync(tmpDir, { recursive: true });
  const skillPath = path.join(tmpDir, "testEcho.js");
  fs.writeFileSync(skillPath, `async function testEcho(bot) { bot.__testResult = "echo"; }`);

  loadDynamicSkills();

  assert.equal(skillRegistry.has("testEcho"), false);

  fs.unlinkSync(skillPath);
  skillRegistry.delete("testEcho");
});

test("dynamic-loader: trusted Voyager skill executes through the authored VM path", async () => {
  const { loadDynamicSkills } = await import("./dynamic-loader.js");
  const { skillRegistry } = await import("./registry.js");

  const tmpDir = path.join(__dirname, "../../skills/voyager");
  fs.mkdirSync(tmpDir, { recursive: true });
  const skillPath = path.join(tmpDir, "testMock.js");
  fs.writeFileSync(skillPath, `async function testMock(bot) { bot.__ran = true; }`);

  loadDynamicSkills();

  const skill = skillRegistry.get("testMock")!;
  const mockBot = { __ran: false } as any;
  const result = await skill.execute(mockBot, {}, new AbortController().signal, () => {});

  assert.ok(mockBot.__ran, "skill should have set __ran on bot");
  assert.ok(result.success);

  fs.unlinkSync(skillPath);
  skillRegistry.delete("testMock");
});

// THE BUG THIS TEST EXISTS FOR.
//
// runDynamicSkill raced the skill against a 120s watchdog:
//
//   const timeoutPromise = new Promise((_, reject) =>
//     setTimeout(() => reject(...), 120_000));
//   await Promise.race([vmPromise, timeoutPromise]);
//
// and never cleared the timer when the skill won. The timer then held the event
// loop open for the remaining two minutes and eventually rejected a promise
// nobody was listening to.
//
// Measured 2026-08-15: this one test FILE took 128 seconds while its two tests
// took 180ms between them. It was the entire test suite's runtime -- and once
// --test-force-exit was removed (it had been silently discarding tests), that
// cost became visible on every run. In production every dynamic skill
// invocation left one of these behind.

test("dynamic-loader: a finished authored skill leaves no watchdog timer behind", async () => {
  const { loadDynamicSkills } = await import("./dynamic-loader.js");
  const { skillRegistry } = await import("./registry.js");

  const tmpDir = path.join(__dirname, "../../skills/voyager");
  fs.mkdirSync(tmpDir, { recursive: true });
  const skillPath = path.join(tmpDir, "testQuick.js");
  fs.writeFileSync(skillPath, `async function testQuick(bot) { bot.__quick = true; }`);
  loadDynamicSkills();

  const before = (process as any).getActiveResourcesInfo().filter((r: string) => r === "Timeout").length;
  await skillRegistry.get("testQuick")!.execute({} as any, {}, new AbortController().signal, () => {});
  const after = (process as any).getActiveResourcesInfo().filter((r: string) => r === "Timeout").length;

  assert.ok(
    after <= before,
    `skill execution leaked ${after - before} timer(s); the 120s watchdog must be cleared when the skill wins the race`,
  );

  fs.unlinkSync(skillPath);
  skillRegistry.delete("testQuick");
});

test("dynamic-loader: Voyager reload keeps the previous skill after a syntax error", async () => {
    const { reloadDynamicSkill } = await import("./dynamic-loader.js");
    const { skillRegistry } = await import("./registry.js");
    const skillName = "hotReloadVoyager";
    const skillPath = path.join(__dirname, `../../skills/voyager/${skillName}.js`);

    fs.writeFileSync(skillPath, `async function ${skillName}(bot) { bot.version = 1; }`);
    reloadDynamicSkill(skillPath);
    const workingSkill = skillRegistry.get(skillName)!;

    fs.writeFileSync(skillPath, `async function ${skillName}( {`);
    assert.throws(() => reloadDynamicSkill(skillPath), SyntaxError);
    assert.equal(skillRegistry.get(skillName), workingSkill);

    fs.writeFileSync(skillPath, `async function ${skillName}(bot) { bot.version = 2; }`);
    reloadDynamicSkill(skillPath);
    assert.notEqual(skillRegistry.get(skillName), workingSkill);

    fs.unlinkSync(skillPath);
    reloadDynamicSkill(skillPath);
    assert.equal(skillRegistry.has(skillName), false);
});

test("dynamic-loader: generated paths cannot be reloaded into the host registry", async () => {
  const { reloadDynamicSkill } = await import("./dynamic-loader.js");
  const skillPath = path.join(__dirname, "../../skills/generated/rejectedGenerated.js");
  fs.writeFileSync(skillPath, "async function rejectedGenerated() {}");
  try {
    assert.throws(() => reloadDynamicSkill(skillPath), /trusted authored skill path/);
  } finally {
    fs.unlinkSync(skillPath);
  }
});

test("dynamic-loader: a Voyager filename cannot replace a built-in skill", async () => {
  const { loadDynamicSkills } = await import("./dynamic-loader.js");
  const { skillRegistry } = await import("./registry.js");
  const original = skillRegistry.get("build_house");
  const skillPath = path.join(__dirname, "../../skills/voyager/build_house.js");
  fs.writeFileSync(skillPath, "async function build_house() { throw new Error('collision'); }");
  try {
    loadDynamicSkills();
    assert.equal(skillRegistry.get("build_house"), original);
  } finally {
    fs.unlinkSync(skillPath);
    if (original) skillRegistry.set("build_house", original);
  }
});
