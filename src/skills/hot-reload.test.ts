import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reloadTypeScriptSkills, startSkillHotReload } from "./hot-reload.js";
import { reloadDynamicSkill } from "./dynamic-loader.js";
import { skillRegistry } from "./registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../");

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for skill reload");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("TypeScript reload replaces valid skills and keeps the previous version on failure", async () => {
  const skillName = `hot_reload_ts_${process.pid}`;
  const filePath = path.join(__dirname, `hot-reload-fixture-${process.pid}.ts`);
  const moduleSource = (version: number) => `
    export const fixtureSkill = {
      name: "${skillName}",
      description: "test fixture",
      params: {},
      estimateMaterials: () => ({}),
      execute: async () => ({ success: true, message: "v${version}" }),
    };
  `;

  try {
    fs.writeFileSync(filePath, moduleSource(1));
    assert.deepEqual(await reloadTypeScriptSkills(filePath), [skillName]);
    const first = skillRegistry.get(skillName)!;

    fs.writeFileSync(filePath, "export const fixtureSkill = {");
    await assert.rejects(reloadTypeScriptSkills(filePath));
    assert.equal(skillRegistry.get(skillName), first);

    fs.writeFileSync(filePath, moduleSource(2));
    await reloadTypeScriptSkills(filePath);
    const second = skillRegistry.get(skillName)!;
    assert.notEqual(second, first);
    assert.equal((await second.execute({} as any, {}, new AbortController().signal, () => {})).message, "v2");
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    skillRegistry.delete(skillName);
  }
});

test("development watcher reloads trusted Voyager skills without restarting", async () => {
  const skillName = `hotReloadWatch${process.pid}`;
  const filePath = path.join(PROJECT_ROOT, "skills/voyager", `${skillName}.js`);
  const stop = startSkillHotReload(PROJECT_ROOT);

  try {
    fs.writeFileSync(filePath, `async function ${skillName}(bot) { bot.version = 1; }`);
    await waitFor(() => skillRegistry.has(skillName));
    const first = skillRegistry.get(skillName)!;

    fs.writeFileSync(filePath, `async function ${skillName}(bot) { bot.version = 2; }`);
    await waitFor(() => skillRegistry.get(skillName) !== first);
    const second = skillRegistry.get(skillName)!;

    fs.writeFileSync(filePath, `async function ${skillName}( {`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(skillRegistry.get(skillName), second);
  } finally {
    stop();
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    reloadDynamicSkill(filePath);
  }
});

test("development watcher ignores generated candidate files", async () => {
  const skillName = `ignoredGeneratedWatch${process.pid}`;
  const filePath = path.join(PROJECT_ROOT, "skills/generated", `${skillName}.js`);
  const stop = startSkillHotReload(PROJECT_ROOT);
  try {
    fs.writeFileSync(filePath, `async function ${skillName}() {}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(skillRegistry.has(skillName), false);
  } finally {
    stop();
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
});
