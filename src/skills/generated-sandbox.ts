import { spawn } from "node:child_process";
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
    );
  }
}

export async function getSandboxPolicyHash(
  options: {
    workerSource?: Buffer;
    limits?: Partial<SandboxLimits>;
  } = {},
): Promise<string> {
  const worker = options.workerSource ? Buffer.from(options.workerSource) : await defaultWorkerSource();
  const limits = resolvedLimits(options.limits);
  const policy = createSandboxSeccompPolicy();
  return hash([
    "minecraft-agent-swarm-generated-sandbox",
    String(GENERATED_CAPABILITY_SCHEMA_VERSION),
    JSON.stringify(limits),
    process.version,
    policy,
    worker,
  ]);
}

function assertPlainParams(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sandboxArguments(
  bwrapPath: string,
  nodePath: string,
  stagingDir: string,
  limits: SandboxLimits,
): { command: string; args: string[] } {
  const bwrap: string[] = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/lib",
    "/lib",
  ];
  if (process.arch === "x64") bwrap.push("--ro-bind", "/lib64", "/lib64");
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
    "--permission",
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
  capabilityHandler: GeneratedCapabilityHandler;
  bwrapPath: string;
  nodePath: string;
  limits?: Partial<SandboxLimits>;
  signal?: AbortSignal;
  workerSource?: Buffer;
}): Promise<SandboxResult> {
  if (!/^[a-z][A-Za-z0-9_]{0,39}$/.test(options.name)) throw new Error("Invalid generated skill name");
  const code = Buffer.from(options.code);
  if (code.length === 0 || code.length > 64 * 1024) throw new Error("Generated skill must contain 1-65536 bytes");
  const worker = options.workerSource ? Buffer.from(options.workerSource) : await defaultWorkerSource();
  const limits = resolvedLimits(options.limits);
  const policy = createSandboxSeccompPolicy();
  const policyHash = await getSandboxPolicyHash({ workerSource: worker, limits });
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
      let requests = 0;
      let readyToken: string | undefined;
      let result: Omit<SandboxResult, "requests" | "sha256" | "policyHash"> | undefined;
      let protocolChain = Promise.resolve();
      let finished = false;

      const finishError = (error: Error) => {
        if (finished) return;
        finished = true;
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
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-limits.maxMessageBytes);
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > limits.maxMessageBytes * 2) {
          finishError(new Error("Generated-skill worker exceeded its protocol output limit"));
          return;
        }
        let newline;
        while ((newline = stdout.indexOf("\n")) !== -1) {
          const line = stdout.slice(0, newline);
          stdout = stdout.slice(newline + 1);
          protocolChain = protocolChain
            .then(async () => {
              if (Buffer.byteLength(line) > limits.maxMessageBytes) {
                throw new Error("Generated-skill worker sent an oversized protocol message");
              }
              const message = JSON.parse(line) as Record<string, unknown>;
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
                if (
                  !Number.isSafeInteger(message.id) ||
                  typeof message.method !== "string" ||
                  !assertPlainParams(message.params)
                ) {
                  throw new Error("Generated-skill worker sent a malformed capability request");
                }
                if (!GENERATED_CAPABILITY_METHODS.includes(message.method as GeneratedCapabilityMethod)) {
                  throw new Error(`Generated-skill worker requested unsupported capability '${message.method}'`);
                }
                requests++;
                if (requests > limits.maxRequests)
                  throw new Error("Generated skill exceeded its capability request quota");
                try {
                  const value = await options.capabilityHandler(
                    message.method as GeneratedCapabilityMethod,
                    message.params,
                  );
                  const response = JSON.stringify({ type: "response", id: message.id, ok: true, value });
                  if (Buffer.byteLength(response) > limits.maxMessageBytes)
                    throw new Error("Capability response is too large");
                  child.stdin.write(`${response}\n`);
                } catch (error) {
                  const response = JSON.stringify({
                    type: "response",
                    id: message.id,
                    ok: false,
                    error: (error as Error).message.slice(0, 1000),
                  });
                  child.stdin.write(`${response}\n`);
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
