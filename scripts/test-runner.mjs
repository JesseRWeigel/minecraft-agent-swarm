import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH_PREFIX = "minecraft-agent-swarm-tests-";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function matchingFiles(directory, extension) {
  const absolute = path.join(repositoryRoot, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(absolute, entry.name));
}

export function discoverTestFiles() {
  const sourceRoot = matchingFiles("src", ".test.ts");
  const sourceChildren = readdirSync(path.join(repositoryRoot, "src"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => matchingFiles(path.join("src", entry.name), ".test.ts"));

  return [
    ...sourceRoot,
    ...sourceChildren,
    ...matchingFiles("scripts", ".test.mjs"),
    ...matchingFiles(path.join("tools", "pilot"), ".test.mjs"),
  ].sort();
}

function removeOwnedScratchDirectory(scratchDir) {
  const temporaryRoot = realpathSync(tmpdir());
  const resolvedScratch = realpathSync(scratchDir);
  if (
    path.dirname(resolvedScratch) !== temporaryRoot ||
    !path.basename(resolvedScratch).startsWith(SCRATCH_PREFIX)
  ) {
    throw new Error(`refusing to remove unowned test telemetry directory: ${resolvedScratch}`);
  }
  rmSync(resolvedScratch, { recursive: true });
}

export function runTestProcess({
  testFiles = discoverTestFiles(),
  testArgs = [],
  env = process.env,
  stdio = "inherit",
} = {}) {
  const scratchDir = mkdtempSync(path.join(realpathSync(tmpdir()), SCRATCH_PREFIX));
  const childEnv = { ...env };
  for (const key of [
    "NODE_TEST_CONTEXT",
    "DATASET_TRIAL_ID",
    "DATASET_GIT_COMMIT",
    "DATASET_DIRTY_DIFF_HASH",
    "DATASET_WORLD_SNAPSHOT_ID",
    "SWARM_LAUNCH_CONTEXT_JSON",
  ]) {
    delete childEnv[key];
  }
  let result;
  let cleanupError;
  try {
    result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...testArgs, ...testFiles], {
      cwd: repositoryRoot,
      env: {
        ...childEnv,
        DATASET_EVENT_DIR: scratchDir,
        DATASET_OPERATION_MODE: "test",
        DATASET_RUN_ID: `test-${process.pid}-${randomUUID()}`,
      },
      stdio,
    });
  } finally {
    try {
      removeOwnedScratchDirectory(scratchDir);
    } catch (error) {
      cleanupError = error;
    }
  }

  if (cleanupError) throw cleanupError;
  if (result.error) throw result.error;
  return { status: result.status, signal: result.signal, scratchDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requestedFiles = [];
  const testArgs = [];
  const optionsWithValues = new Set([
    "--test-concurrency",
    "--test-name-pattern",
    "--test-reporter",
    "--test-reporter-destination",
    "--test-shard",
    "--test-timeout",
  ]);
  const commandArgs = process.argv.slice(2);
  for (let index = 0; index < commandArgs.length; index += 1) {
    const argument = commandArgs[index];
    if (argument.startsWith("-")) {
      testArgs.push(argument);
      if (optionsWithValues.has(argument) && commandArgs[index + 1] !== undefined) {
        testArgs.push(commandArgs[++index]);
      }
    } else {
      requestedFiles.push(path.resolve(repositoryRoot, argument));
    }
  }
  const result = runTestProcess({
    testArgs,
    testFiles: requestedFiles.length ? requestedFiles : discoverTestFiles(),
  });
  if (result.signal) {
    process.kill(process.pid, result.signal);
  } else {
    process.exitCode = result.status ?? 1;
  }
}
