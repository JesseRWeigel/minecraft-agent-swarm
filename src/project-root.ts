import fs from "node:fs";
import path from "node:path";

const PACKAGE_NAME = "minecraft-agent-swarm";

function isProjectRoot(candidate: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8")) as { name?: unknown };
    return parsed.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

/** Resolve the repository root from source, bundled dist, or an explicit launch cwd. */
export function resolveProjectRoot(moduleDirectory: string, cwd = process.cwd()): string {
  const candidates = [path.resolve(moduleDirectory, "../.."), path.resolve(moduleDirectory, ".."), cwd];
  for (const candidate of candidates) {
    if (isProjectRoot(candidate)) return candidate;
  }
  throw new Error(`Could not locate the ${PACKAGE_NAME} project root from ${moduleDirectory}`);
}
