import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSandboxSeccompPolicy } from "./sandbox-policy.js";

export const GENERATED_CAPABILITY_SCHEMA_VERSION = 1;
export const GENERATED_CAPABILITY_METHODS = [
  "observe",
  "navigate",
  "mine",
  "craft",
  "equip",
  "consume",
  "place",
  "look",
  "attack",
  "wait",
] as const;

export type GeneratedCapabilityMethod = (typeof GENERATED_CAPABILITY_METHODS)[number];
export type GeneratedCapabilityHandler = (method: GeneratedCapabilityMethod, params: unknown) => Promise<unknown>;
export type TerminationAwareCapabilityHandler = (
  method: GeneratedCapabilityMethod,
  params: unknown,
  terminationSignal: AbortSignal,
) => Promise<unknown>;

export const GENERATED_CAPABILITY_POLICY = {
  version: 1,
  maxDistance: 64,
  methodQuotas: {
    observe: 16,
    navigate: 4,
    mine: 8,
    craft: 32,
    equip: 8,
    consume: 8,
    place: 8,
    look: 16,
    attack: 8,
    wait: 16,
  },
  maxObserveRadius: 32,
  maxObservedBlocks: 64,
  maxObservedEntities: 32,
  maxMineCount: 8,
  maxCraftCount: 16,
  maxPlaceDistance: 6,
  maxAttackDistance: 16,
  maxWaitTicks: 100,
} as const;

const SANDBOX_LAUNCH_POLICY = {
  version: 2,
  mounts: "exact-node-and-ldd-libraries",
  namespaces: "all",
  network: "none",
  environment: "clear",
  root: "read-only",
  devices: ["/dev/null", "/dev/urandom"],
  capabilities: "drop-all",
  nodePermissions: "read-worker-and-candidate-only",
} as const;

export type SandboxLimits = {
  wallMs: number;
  cpuSeconds: number;
  addressSpaceBytes: number;
  fileBytes: number;
  openFiles: number;
  maxRequests: number;
  maxMessageBytes: number;
};

const DEFAULT_LIMITS: SandboxLimits = {
  wallMs: 60_000,
  cpuSeconds: 30,
  addressSpaceBytes: 512 * 1024 * 1024,
  fileBytes: 1024 * 1024,
  openFiles: 64,
  maxRequests: 32,
  maxMessageBytes: 64 * 1024,
};

export type SandboxResult = {
  success: boolean;
  value?: unknown;
  error?: string;
  requests: number;
  sha256: string;
  policyHash: string;
};

function resolvedLimits(overrides: Partial<SandboxLimits> = {}): SandboxLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid generated-sandbox limit ${name}`);
  }
  return limits;
}

function hash(parts: Array<string | Buffer>): string {
  const digest = createHash("sha256");
  for (const part of parts) {
    const bytes = typeof part === "string" ? Buffer.from(part) : part;
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(bytes.length));
    digest.update(size).update(bytes);
  }
  return digest.digest("hex");
}

async function defaultWorkerSource(): Promise<Buffer> {
  const adjacent = fileURLToPath(new URL("./generated-worker.mjs", import.meta.url));
  try {
    return await readFile(adjacent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return readFile(path.resolve(process.cwd(), "src/skills/generated-worker.mjs"));
  }
}

export async function assertGeneratedSandboxAvailable(bwrapPath: string, nodePath: string): Promise<void> {
  createSandboxSeccompPolicy();
  try {
    await Promise.all([
      access(bwrapPath, constants.X_OK),
      access(nodePath, constants.X_OK),
      access("/usr/bin/prlimit", constants.X_OK),
    ]);
  } catch (error) {
    throw new Error(
      `Generated-skill sandbox unavailable (bubblewrap, Node, and prlimit are required): ${(error as Error).message}`,
      { cause: error },
    );
  }
}

export async function getSandboxPolicyHash(
  options: {
    workerSource?: Buffer;
    limits?: Partial<SandboxLimits>;
    nodePath?: string;
  } = {},
): Promise<string> {
  const worker = options.workerSource ? Buffer.from(options.workerSource) : await defaultWorkerSource();
  const limits = resolvedLimits(options.limits);
  const policy = createSandboxSeccompPolicy();
  const runtime = resolveNodeRuntime(options.nodePath ?? process.execPath);
  return hash([
    "minecraft-agent-swarm-generated-sandbox",
    String(GENERATED_CAPABILITY_SCHEMA_VERSION),
    JSON.stringify(limits),
    JSON.stringify(GENERATED_CAPABILITY_POLICY),
    JSON.stringify(SANDBOX_LAUNCH_POLICY),
    runtime.executable,
    runtime.version,
    JSON.stringify(runtime.libraries),
    policy,
    worker,
  ]);
}

function assertPlainParams(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function resolveNodeRuntime(nodePath: string): { executable: string; version: string; libraries: string[] } {
  let lddOutput: string;
  let version: string;
  try {
    lddOutput = execFileSync("/usr/bin/ldd", [nodePath], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    version = execFileSync(nodePath, ["--version"], { encoding: "utf8", env: {} }).trim();
  } catch (error) {
    throw new Error(`Could not inspect configured Node runtime: ${(error as Error).message}`, { cause: error });
  }
  if (lddOutput.includes("not found")) throw new Error("Configured Node runtime has an unresolved shared library");
  const libraries = new Set<string>();
  for (const line of lddOutput.split("\n")) {
    const mapped = line.match(/=>\s+(\/\S+)\s+\(/)?.[1];
    const loader = line.trim().match(/^(\/\S+)\s+\(/)?.[1];
    const library = mapped ?? loader;
    if (library) libraries.add(library);
  }
  if (libraries.size === 0) throw new Error("Could not resolve configured Node runtime libraries");
  return { executable: path.resolve(nodePath), version, libraries: Array.from(libraries).sort() };
}

function parentDirectories(filePaths: string[]): string[] {
  const directories = new Set<string>();
  for (const filePath of filePaths) {
    let current = path.dirname(filePath);
    while (current !== "/") {
      directories.add(current);
      current = path.dirname(current);
    }
  }
  return Array.from(directories).sort(
    (left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right),
  );
}

function sandboxArguments(
  bwrapPath: string,
  nodePath: string,
  stagingDir: string,
  limits: SandboxLimits,
): { command: string; args: string[] } {
  const runtime = resolveNodeRuntime(nodePath);
  const nodeMajor = Number.parseInt(runtime.version.replace(/^v/, "").split(".")[0], 10);
  if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 20) {
    throw new Error("Generated-skill sandbox requires Node 20 or newer");
  }
  const permissionFlag = nodeMajor >= 22 ? "--permission" : "--experimental-permission";
  const bwrap: string[] = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--cap-drop", "ALL"];
  for (const directory of parentDirectories(runtime.libraries)) bwrap.push("--dir", directory);
  for (const library of runtime.libraries) bwrap.push("--ro-bind", library, library);
  bwrap.push(
    "--dir",
    "/sandbox",
    "--ro-bind",
    nodePath,
    "/sandbox/node",
    "--ro-bind",
    path.join(stagingDir, "worker.mjs"),
    "/sandbox/worker.mjs",
    "--ro-bind",
    path.join(stagingDir, "candidate.js"),
    "/sandbox/candidate.js",
    "--proc",
    "/proc",
    "--remount-ro",
    "/proc",
    "--dir",
    "/dev",
    "--ro-bind",
    "/dev/null",
    "/dev/null",
    "--ro-bind",
    "/dev/urandom",
    "/dev/urandom",
    "--setenv",
    "PATH",
    "/sandbox",
    "--setenv",
    "PWD",
    "/sandbox",
    "--setenv",
    "UV_THREADPOOL_SIZE",
    "1",
    "--chdir",
    "/sandbox",
    "--remount-ro",
    "/",
    "--seccomp",
    "3",
    "--",
    "/sandbox/node",
    permissionFlag,
    "--allow-fs-read=/sandbox/worker.mjs",
    "--allow-fs-read=/sandbox/candidate.js",
    "--jitless",
    "--max-old-space-size=64",
    "/sandbox/worker.mjs",
  );
  return {
    command: "/usr/bin/prlimit",
    args: [
      `--as=${limits.addressSpaceBytes}`,
      `--cpu=${limits.cpuSeconds}`,
      `--fsize=${limits.fileBytes}`,
      `--nofile=${limits.openFiles}`,
      "--core=0",
      "--",
      bwrapPath,
      ...bwrap,
    ],
  };
}

export async function runGeneratedSkillInSandbox(options: {
  name: string;
  code: string | Buffer;
  capabilityHandler: TerminationAwareCapabilityHandler;
  bwrapPath: string;
  nodePath: string;
  limits?: Partial<SandboxLimits>;
  signal?: AbortSignal;
  workerSource?: Buffer;
  expectedPolicyHash?: string;
}): Promise<SandboxResult> {
  if (!/^[a-z][A-Za-z0-9_]{0,39}$/.test(options.name)) throw new Error("Invalid generated skill name");
  const code = Buffer.from(options.code);
  if (code.length === 0 || code.length > 64 * 1024) throw new Error("Generated skill must contain 1-65536 bytes");
  const worker = options.workerSource ? Buffer.from(options.workerSource) : await defaultWorkerSource();
  const limits = resolvedLimits(options.limits);
  const policy = createSandboxSeccompPolicy();
  const policyHash = await getSandboxPolicyHash({ workerSource: worker, limits, nodePath: options.nodePath });
  if (options.expectedPolicyHash !== undefined && options.expectedPolicyHash !== policyHash) {
    throw new Error(
      `Generated-skill sandbox policy changed before execution (expected ${options.expectedPolicyHash}, got ${policyHash})`,
    );
  }
  const codeHash = createHash("sha256").update(code).digest("hex");
  await assertGeneratedSandboxAvailable(options.bwrapPath, options.nodePath);

  const stagingDir = await mkdtemp(path.join(os.tmpdir(), "swarm-generated-run-"));
  await chmod(stagingDir, 0o700);
  try {
    await Promise.all([
      writeFile(path.join(stagingDir, "candidate.js"), code, { flag: "wx", mode: 0o400 }),
      writeFile(path.join(stagingDir, "worker.mjs"), worker, { flag: "wx", mode: 0o400 }),
    ]);
    const launch = sandboxArguments(options.bwrapPath, options.nodePath, stagingDir, limits);
    return await new Promise<SandboxResult>((resolve, reject) => {
      const child = spawn(launch.command, [...launch.args, options.name, "/sandbox/candidate.js"], {
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let stderrBytes = 0;
      let requests = 0;
      let readyToken: string | undefined;
      let result: Omit<SandboxResult, "requests" | "sha256" | "policyHash"> | undefined;
      let protocolChain = Promise.resolve();
      let finished = false;
      let admittedMessages = 0;
      let admittedBytes = 0;
      const requestIds = new Set<number>();
      const terminationController = new AbortController();

      const finishError = (error: Error) => {
        if (finished) return;
        finished = true;
        terminationController.abort();
        child.kill("SIGKILL");
        reject(error);
      };
      const timer = setTimeout(() => {
        finishError(new Error(`Generated skill timed out after ${limits.wallMs}ms`));
      }, limits.wallMs);
      timer.unref?.();

      const abort = () => finishError(new Error("Generated skill aborted"));
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });

      child.on("error", (error) => finishError(new Error(`Could not start generated-skill sandbox: ${error.message}`)));
      child.stdin.on("error", () => {});
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > limits.maxMessageBytes * 2) {
          finishError(new Error("Generated-skill worker exceeded its stderr output limit"));
          return;
        }
        stderr += chunk;
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        admittedBytes += Buffer.byteLength(chunk);
        if (admittedBytes > limits.maxMessageBytes * (limits.maxRequests + 2)) {
          finishError(new Error("Generated-skill worker exceeded its total protocol output limit"));
          return;
        }
        stdout += chunk;
        if (Buffer.byteLength(stdout) > limits.maxMessageBytes * 2) {
          finishError(new Error("Generated-skill worker exceeded its protocol output limit"));
          return;
        }
        let newline;
        while ((newline = stdout.indexOf("\n")) !== -1) {
          const line = stdout.slice(0, newline);
          stdout = stdout.slice(newline + 1);
          admittedMessages++;
          if (admittedMessages > limits.maxRequests + 2) {
            finishError(new Error("Generated-skill worker exceeded its protocol message quota"));
            return;
          }
          if (Buffer.byteLength(line) > limits.maxMessageBytes) {
            finishError(new Error("Generated-skill worker sent an oversized protocol message"));
            return;
          }
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line) as Record<string, unknown>;
          } catch (error) {
            finishError(new Error(`Generated-skill worker sent malformed JSON: ${(error as Error).message}`));
            return;
          }
          if (!message || typeof message !== "object" || Array.isArray(message)) {
            finishError(new Error("Generated-skill worker sent a non-object protocol message"));
            return;
          }
          if (message.type === "request") {
            if (
              !Number.isSafeInteger(message.id) ||
              typeof message.method !== "string" ||
              !assertPlainParams(message.params) ||
              requestIds.has(message.id as number)
            ) {
              finishError(new Error("Generated-skill worker sent a malformed or duplicate capability request"));
              return;
            }
            requestIds.add(message.id as number);
            requests++;
            if (requests > limits.maxRequests) {
              finishError(new Error("Generated skill exceeded its capability request quota"));
              return;
            }
          }
          protocolChain = protocolChain
            .then(async () => {
              if (finished || terminationController.signal.aborted) return;
              if (result) throw new Error("Generated-skill worker sent a protocol message after its terminal result");
              if (message.type === "ready") {
                if (readyToken || typeof message.token !== "string" || !/^[a-f0-9]{64}$/.test(message.token)) {
                  throw new Error("Generated-skill worker sent an invalid protocol ready message");
                }
                readyToken = message.token;
                return;
              }
              if (message.type === "request") {
                if (!readyToken)
                  throw new Error("Generated-skill worker requested a capability before protocol readiness");
                if (!GENERATED_CAPABILITY_METHODS.includes(message.method as GeneratedCapabilityMethod)) {
                  throw new Error(`Generated-skill worker requested unsupported capability '${message.method}'`);
                }
                try {
                  const value = await options.capabilityHandler(
                    message.method as GeneratedCapabilityMethod,
                    message.params,
                    terminationController.signal,
                  );
                  if (finished || terminationController.signal.aborted) return;
                  const response = JSON.stringify({ type: "response", id: message.id, ok: true, value });
                  if (Buffer.byteLength(response) > limits.maxMessageBytes)
                    throw new Error("Capability response is too large");
                  if (!child.stdin.destroyed) child.stdin.write(`${response}\n`);
                } catch (error) {
                  if (finished || terminationController.signal.aborted) return;
                  const response = JSON.stringify({
                    type: "response",
                    id: message.id,
                    ok: false,
                    error: (error as Error).message.slice(0, 1000),
                  });
                  if (!child.stdin.destroyed) child.stdin.write(`${response}\n`);
                }
                return;
              }
              if (message.type === "result" && typeof message.success === "boolean") {
                if (!readyToken || message.token !== readyToken || result) {
                  throw new Error("Generated-skill worker sent an invalid or duplicate result token");
                }
                result = {
                  success: message.success,
                  value: message.value,
                  error: typeof message.error === "string" ? message.error : undefined,
                };
                return;
              }
              throw new Error("Generated-skill worker sent an unknown protocol message");
            })
            .catch((error) => finishError(error as Error));
        }
      });
      child.on("close", (exitCode, signal) => {
        terminationController.abort();
        void protocolChain.finally(() => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
          if (finished) return;
          finished = true;
          if (stdout.length > 0) {
            reject(new Error("Generated-skill worker exited with an incomplete protocol message"));
            return;
          }
          if (!result) {
            reject(
              new Error(
                `Generated-skill sandbox exited without a result (code=${exitCode}, signal=${signal ?? "none"}): ${stderr.trim()}`,
              ),
            );
            return;
          }
          if (result.success && (exitCode !== 0 || signal !== null)) {
            reject(
              new Error(
                `Generated-skill worker claimed success but exited unsuccessfully (code=${exitCode}, signal=${signal ?? "none"})`,
              ),
            );
            return;
          }
          resolve({ ...result, requests, sha256: codeHash, policyHash });
        });
      });

      const policyPipe = child.stdio[3];
      if (!policyPipe || typeof policyPipe === "string" || !("end" in policyPipe)) {
        finishError(new Error("Generated-skill sandbox could not create the seccomp policy pipe"));
        return;
      }
      policyPipe.on("error", () => {});
      policyPipe.end(policy);
    });
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
