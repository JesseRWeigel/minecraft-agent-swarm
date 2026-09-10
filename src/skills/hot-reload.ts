import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reloadDynamicSkill } from "./dynamic-loader.js";
import { registerTrustedHotReloadSkill, skillRegistry } from "./registry.js";
import type { Skill } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../");
let importSequence = 0;

function isSkill(value: unknown): value is Skill {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Skill>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.estimateMaterials === "function" &&
    typeof candidate.execute === "function"
  );
}

/** Reload all `Skill` exports from one TypeScript module as one registry update. */
export async function reloadTypeScriptSkills(filePath: string): Promise<string[]> {
  const specifier = `${pathToFileURL(filePath).href}?hot=${Date.now()}-${importSequence++}`;
  const module = await import(specifier);
  const skills = Object.values(module).filter(isSkill);
  const names = skills.map((skill) => skill.name);

  if (new Set(names).size !== names.length) {
    throw new Error(`Duplicate skill names exported by ${path.basename(filePath)}`);
  }

  // Import and validate every export before replacing anything. Running skills
  // retain their old object; future invocations read the new registry entries.
  for (const skill of skills) registerTrustedHotReloadSkill(skill);
  return names;
}

type PendingReload = { timer: ReturnType<typeof setTimeout>; kind: "typescript" | "dynamic" };

/** Starts granular skill watchers used by `npm run dev`; returns their cleanup. */
export function startSkillHotReload(projectRoot: string = PROJECT_ROOT): () => void {
  const watchers: fs.FSWatcher[] = [];
  const pending = new Map<string, PendingReload>();

  const schedule = (filePath: string, kind: "typescript" | "dynamic") => {
    const previous = pending.get(filePath);
    if (previous) clearTimeout(previous.timer);

    const timer = setTimeout(async () => {
      pending.delete(filePath);
      try {
        const names = kind === "typescript" ? await reloadTypeScriptSkills(filePath) : [reloadDynamicSkill(filePath)];
        if (names.length > 0) {
          console.log(`[SkillHotReload] Reloaded ${names.join(", ")} from ${path.relative(projectRoot, filePath)}`);
        }
      } catch (err) {
        console.warn(
          `[SkillHotReload] Kept previous skill after ${path.relative(projectRoot, filePath)} failed: ${(err as Error).message}`,
        );
      }
    }, 75);
    pending.set(filePath, { timer, kind });
  };

  const watchDirectory = (dir: string, kind: "typescript" | "dynamic") => {
    if (!fs.existsSync(dir)) return;
    watchers.push(
      fs.watch(dir, (_event, filename) => {
        if (!filename) return;
        const name = filename.toString();
        if (kind === "typescript") {
          if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name === "hot-reload.ts") return;
        } else if (!name.endsWith(".js")) {
          return;
        }
        schedule(path.join(dir, name), kind);
      }),
    );
  };

  watchDirectory(path.join(projectRoot, "src/skills"), "typescript");
  watchDirectory(path.join(projectRoot, "skills/voyager"), "dynamic");
  console.log(`[SkillHotReload] Watching ${watchers.length} skill directories`);

  return () => {
    for (const { timer } of pending.values()) clearTimeout(timer);
    pending.clear();
    for (const watcher of watchers) watcher.close();
  };
}
