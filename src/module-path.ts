import { fileURLToPath } from "node:url";

/**
 * Resolve a repository path from the URL of a module that lives under it.
 *
 * `new URL(...).pathname` keeps percent-encoding, so a checkout under a
 * directory with a space (or any Windows path) resolves to a location that
 * does not exist.
 */
export function resolveModulePath(moduleUrl: string | URL, relative: string): string {
  return fileURLToPath(new URL(relative, moduleUrl));
}
