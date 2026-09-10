import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const STORE_VERSION = 1;
const MAX_CODE_BYTES = 64 * 1024;
const NAME_PATTERN = /^[a-z][A-Za-z0-9_]{0,39}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROTOTYPE_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype));

export type CandidateProvenance = {
  kind: "generation" | "refinement";
  task: string;
  model: string;
  sourceName?: string;
};

export type GeneratedCandidate = {
  version: 1;
  id: string;
  name: string;
  sha256: string;
  createdAt: string;
  provenance: CandidateProvenance;
};

export type VerificationCheck = { name: string; passed: boolean; detail?: string };

export type GeneratedVerification = {
  version: 1;
  candidateId: string;
  sha256: string;
  policyHash: string;
  passed: boolean;
  checks: VerificationCheck[];
  verifiedAt: string;
};

type ApprovedVersion = {
  candidateId: string;
  sha256: string;
  policyHash: string;
  promotedAt: string;
};

type ApprovedEntry = ApprovedVersion & { history: ApprovedVersion[] };
type ApprovedManifest = { version: 1; skills: Record<string, ApprovedEntry> };

export function getGeneratedPaths(root: string) {
  return {
    root,
    blobs: path.join(root, "blobs"),
    candidates: path.join(root, "candidates"),
    verifications: path.join(root, "verifications"),
    approved: path.join(root, "approved"),
    manifest: path.join(root, "approved", "manifest.json"),
    lock: path.join(root, "approved", ".lock"),
  };
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertName(name: string, reservedNames: ReadonlySet<string> = new Set()): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      "Generated skill name must start with a lowercase letter and contain at most 40 ASCII letters, digits, or underscores",
    );
  }
  if (PROTOTYPE_KEYS.has(name)) throw new Error(`Generated skill name '${name}' is reserved`);
  if (reservedNames.has(name)) throw new Error(`Generated skill name '${name}' is reserved by a trusted skill`);
}

function assertHash(value: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Error("Expected SHA-256 must be 64 lowercase hexadecimal characters");
}

async function ensureStore(root: string): Promise<void> {
  const p = getGeneratedPaths(root);
  await Promise.all([
    mkdir(p.blobs, { recursive: true, mode: 0o700 }),
    mkdir(p.candidates, { recursive: true, mode: 0o700 }),
    mkdir(p.verifications, { recursive: true, mode: 0o700 }),
    mkdir(p.approved, { recursive: true, mode: 0o700 }),
  ]);
}

async function writeJsonExclusive(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(tmp, filePath);
  } finally {
    await rm(tmp, { force: true });
  }
}

async function readRegularFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Refusing non-regular generated-skill file: ${filePath}`);
    if (info.size > maxBytes) throw new Error(`Generated-skill file exceeds ${maxBytes} bytes`);
    // A regular file can grow after stat. Never allocate or read beyond the cap plus one sentinel byte.
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error(`Generated-skill file exceeds ${maxBytes} bytes`);
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse((await readRegularFile(filePath, MAX_CODE_BYTES)).toString("utf8")) as T;
}

async function readCandidateBytes(root: string, candidate: GeneratedCandidate): Promise<Buffer> {
  const p = getGeneratedPaths(root);
  const bytes = await readRegularFile(path.join(p.blobs, `${candidate.sha256}.js`), MAX_CODE_BYTES);
  if (sha256(bytes) !== candidate.sha256) throw new Error("Candidate blob hash does not match its recorded SHA-256");
  return bytes;
}

export async function readGeneratedCandidateArtifact(
  root: string,
  candidateId: string,
): Promise<{ candidate: GeneratedCandidate; code: Buffer }> {
  const candidate = await readGeneratedCandidate(root, candidateId);
  return { candidate, code: await readCandidateBytes(root, candidate) };
}

export async function createGeneratedCandidate(
  root: string,
  input: {
    name: string;
    code: string;
    provenance: CandidateProvenance;
    reservedNames?: ReadonlySet<string>;
  },
): Promise<GeneratedCandidate> {
  assertName(input.name, input.reservedNames);
  const bytes = Buffer.from(input.code, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_CODE_BYTES) {
    throw new Error(`Generated skill code must contain 1-${MAX_CODE_BYTES} UTF-8 bytes`);
  }
  if (!input.provenance.task.trim() || !input.provenance.model.trim()) {
    throw new Error("Generated skill provenance requires a task and model");
  }
  await ensureStore(root);
  const p = getGeneratedPaths(root);
  const digest = sha256(bytes);
  const blobPath = path.join(p.blobs, `${digest}.js`);
  try {
    await writeFile(blobPath, bytes, { flag: "wx", mode: 0o400 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readRegularFile(blobPath, MAX_CODE_BYTES);
    if (sha256(existing) !== digest || !existing.equals(bytes)) {
      throw new Error("Existing content-addressed blob does not match its filename", { cause: error });
    }
  }
  await chmod(blobPath, 0o400);
  const candidate: GeneratedCandidate = {
    version: STORE_VERSION,
    id: randomUUID(),
    name: input.name,
    sha256: digest,
    createdAt: new Date().toISOString(),
    provenance: { ...input.provenance },
  };
  await writeJsonExclusive(path.join(p.candidates, `${candidate.id}.json`), candidate);
  return candidate;
}

export async function readGeneratedCandidate(root: string, candidateId: string): Promise<GeneratedCandidate> {
  if (!/^[a-f0-9-]{36}$/.test(candidateId)) throw new Error("Invalid generated candidate ID");
  const candidate = await readJson<GeneratedCandidate>(
    path.join(getGeneratedPaths(root).candidates, `${candidateId}.json`),
  );
  if (candidate.version !== STORE_VERSION || candidate.id !== candidateId)
    throw new Error("Malformed generated candidate record");
  assertName(candidate.name);
  assertHash(candidate.sha256);
  return candidate;
}

export async function recordGeneratedVerification(
  root: string,
  input: Omit<GeneratedVerification, "version" | "verifiedAt">,
): Promise<GeneratedVerification> {
  const candidate = await readGeneratedCandidate(root, input.candidateId);
  assertHash(input.sha256);
  if (candidate.sha256 !== input.sha256) throw new Error("Verification hash does not match candidate SHA-256");
  await readCandidateBytes(root, candidate);
  if (!input.policyHash.trim()) throw new Error("Verification requires a sandbox policy hash");
  if (input.checks.length === 0) throw new Error("Verification requires at least one check");
  if (input.passed !== input.checks.every((check) => check.passed)) {
    throw new Error("Verification result conflicts with its checks");
  }
  const verification: GeneratedVerification = {
    version: STORE_VERSION,
    ...input,
    checks: input.checks.map((check) => ({ ...check })),
    verifiedAt: new Date().toISOString(),
  };
  await ensureStore(root);
  await writeJsonAtomic(path.join(getGeneratedPaths(root).verifications, `${candidate.id}.json`), verification);
  return verification;
}

async function readManifest(root: string): Promise<ApprovedManifest> {
  try {
    const manifest = await readJson<ApprovedManifest>(getGeneratedPaths(root).manifest);
    if (manifest.version !== STORE_VERSION || !manifest.skills || typeof manifest.skills !== "object") {
      throw new Error("Malformed generated-skill approval manifest");
    }
    return manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: STORE_VERSION, skills: {} };
    throw error;
  }
}

async function withManifestLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  await ensureStore(root);
  const lockPath = getGeneratedPaths(root).lock;
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Another generated-skill promotion or rollback is in progress", { cause: error });
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

async function requireSuccessfulVerification(
  root: string,
  candidate: GeneratedCandidate,
  policyHash: string,
): Promise<GeneratedVerification> {
  let verification: GeneratedVerification;
  try {
    verification = await readJson<GeneratedVerification>(
      path.join(getGeneratedPaths(root).verifications, `${candidate.id}.json`),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("Candidate has no verification record", { cause: error });
    throw error;
  }
  if (
    !verification ||
    verification.version !== STORE_VERSION ||
    verification.candidateId !== candidate.id ||
    verification.sha256 !== candidate.sha256 ||
    verification.policyHash !== policyHash ||
    verification.passed !== true ||
    !Array.isArray(verification.checks) ||
    verification.checks.length === 0 ||
    verification.checks.some(
      (check) => !check || check.passed !== true || typeof check.name !== "string" || !check.name.trim(),
    )
  ) {
    throw new Error("Candidate verification did not pass for these exact bytes and current policy");
  }
  return verification;
}

async function readVerifiedApproval(root: string, name: string, entry: ApprovedVersion): Promise<Buffer> {
  assertHash(entry.sha256);
  if (typeof entry.policyHash !== "string" || !entry.policyHash.trim()) throw new Error("Malformed approval policy");
  const candidate = await readGeneratedCandidate(root, entry.candidateId);
  if (candidate.name !== name || candidate.sha256 !== entry.sha256) {
    throw new Error("Approved candidate name or hash does not match its approval");
  }
  await requireSuccessfulVerification(root, candidate, entry.policyHash);
  return readCandidateBytes(root, candidate);
}

export async function promoteGeneratedCandidate(
  root: string,
  input: {
    candidateId: string;
    expectedSha256: string;
    policyHash: string;
    reservedNames?: ReadonlySet<string>;
  },
): Promise<ApprovedVersion> {
  assertHash(input.expectedSha256);
  if (!input.policyHash.trim()) throw new Error("Promotion requires the current sandbox policy hash");
  return withManifestLock(root, async () => {
    const candidate = await readGeneratedCandidate(root, input.candidateId);
    assertName(candidate.name, input.reservedNames);
    if (candidate.sha256 !== input.expectedSha256) throw new Error("Expected hash does not match candidate SHA-256");
    await readCandidateBytes(root, candidate);
    const verification = await requireSuccessfulVerification(root, candidate, input.policyHash);
    const manifest = await readManifest(root);
    const prior = manifest.skills[candidate.name];
    const approved: ApprovedVersion = {
      candidateId: candidate.id,
      sha256: candidate.sha256,
      policyHash: verification.policyHash,
      promotedAt: new Date().toISOString(),
    };
    manifest.skills[candidate.name] = {
      ...approved,
      history: prior
        ? [
            ...prior.history,
            {
              candidateId: prior.candidateId,
              sha256: prior.sha256,
              policyHash: prior.policyHash,
              promotedAt: prior.promotedAt,
            },
          ]
        : [],
    };
    await writeJsonAtomic(getGeneratedPaths(root).manifest, manifest);
    return approved;
  });
}

export async function readApprovedGeneratedSkill(
  root: string,
  name: string,
  policyHash?: string,
): Promise<ApprovedVersion & { name: string; code: string }> {
  assertName(name);
  const entry = (await readManifest(root)).skills[name];
  if (!entry) throw new Error(`Generated skill '${name}' is not approved`);
  if (policyHash !== undefined && entry.policyHash !== policyHash) {
    throw new Error(`Generated skill '${name}' was approved under a different sandbox policy`);
  }
  const bytes = await readVerifiedApproval(root, name, entry);
  return {
    name,
    candidateId: entry.candidateId,
    sha256: entry.sha256,
    policyHash: entry.policyHash,
    promotedAt: entry.promotedAt,
    code: bytes.toString("utf8"),
  };
}

export async function listApprovedGeneratedSkills(
  root: string,
  policyHash?: string,
): Promise<Array<ApprovedVersion & { name: string; code: string }>> {
  const manifest = await readManifest(root);
  return Promise.all(Object.keys(manifest.skills).map((name) => readApprovedGeneratedSkill(root, name, policyHash)));
}

export async function rollbackGeneratedSkill(
  root: string,
  name: string,
  policyHash?: string,
): Promise<ApprovedVersion> {
  assertName(name);
  return withManifestLock(root, async () => {
    const manifest = await readManifest(root);
    const current = manifest.skills[name];
    if (!current || current.history.length === 0)
      throw new Error(`Generated skill '${name}' has no approved rollback target`);
    const previous = current.history[current.history.length - 1];
    if (policyHash !== undefined && previous.policyHash !== policyHash) {
      throw new Error("Rollback target was approved under a different sandbox policy");
    }
    await readVerifiedApproval(root, name, previous);
    manifest.skills[name] = { ...previous, history: current.history.slice(0, -1) };
    await writeJsonAtomic(getGeneratedPaths(root).manifest, manifest);
    return previous;
  });
}

export async function listGeneratedCandidates(root: string): Promise<GeneratedCandidate[]> {
  await ensureStore(root);
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(getGeneratedPaths(root).candidates);
  const candidates = await Promise.all(
    files.filter((file) => file.endsWith(".json")).map((file) => readGeneratedCandidate(root, file.slice(0, -5))),
  );
  return candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
