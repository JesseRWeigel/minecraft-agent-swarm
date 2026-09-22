import { pathToFileURL } from "node:url";
import { sampleActor } from "./protected-observer.mjs";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REQUEST_BYTES = 4096;
const RESULT_BYTES = 65536;
const CONNECT_TIMEOUT_MS = 5000;
const SAMPLE_TIMEOUT_MS = 5000;
// Leave the sampler time to serialize its bounded partial timeout result.
// The independent process watchdog remains the final lifetime bound.
const SAMPLE_RESULT_TIMEOUT_MS = SAMPLE_TIMEOUT_MS + 1000;
const FIXTURE_TIMEOUT_MS = 15000;
const TOTAL_WATCHDOG_MS = 25000;
const REQUEST_KEYS = ["action_id", "password", "phase", "schema_version", "trial_id"];

function genericFailure(error) {
  try {
    error.write("observer failed\n");
  } catch {}
}

function bounded(operation, timeoutMs, onTimeout) {
  let timer;
  const pending = Promise.resolve().then(operation);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error("observer timeout"));
    }, timeoutMs);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

function hasDuplicateKeys(text) {
  const keys = new Set();
  const matcher = /"((?:\\.|[^"\\])*)"\s*:/g;
  for (const match of text.matchAll(matcher)) {
    let key;
    try {
      key = JSON.parse(`"${match[1]}"`);
    } catch {
      return true;
    }
    if (keys.has(key)) return true;
    keys.add(key);
  }
  return false;
}

async function readRequest(input) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > REQUEST_BYTES) throw new Error("invalid request");
    chunks.push(value);
  }
  if (bytes === 0) throw new Error("invalid request");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error("invalid request");
  }
  if (hasDuplicateKeys(text)) throw new Error("invalid request");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("invalid request");
  }
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("invalid request");
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(REQUEST_KEYS)) throw new Error("invalid request");
  if (value.schema_version !== 1 || !["fixture", "before", "terminal"].includes(value.phase))
    throw new Error("invalid request");
  if (
    typeof value.trial_id !== "string" ||
    typeof value.action_id !== "string" ||
    !ID_PATTERN.test(value.trial_id) ||
    !ID_PATTERN.test(value.action_id)
  )
    throw new Error("invalid request");
  if (typeof value.password !== "string" || value.password.length === 0 || value.password.includes("\0"))
    throw new Error("invalid request");
  return value;
}

function containsCredential(value, password) {
  if (typeof value === "string") return value === password;
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((item) => containsCredential(item, password));
}

async function writeResult(output, result, password) {
  const line = `${JSON.stringify(result)}\n`;
  if (Buffer.byteLength(line) > RESULT_BYTES || containsCredential(result, password)) throw new Error("invalid result");
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve();
    };
    try {
      output.write(line, finish);
    } catch (error) {
      finish(error);
    }
  });
}

async function closeRcon(rcon) {
  if (!rcon) return;
  try {
    await bounded(() => rcon.end?.(), 1000);
  } catch {}
  try {
    rcon.socket?.destroy?.();
  } catch {}
}

export async function runObserverProcess({
  input = process.stdin,
  output = process.stdout,
  error = process.stderr,
  connect,
  setupFixture,
  sample = sampleActor,
  verifyFixture,
  watchdogMs = TOTAL_WATCHDOG_MS,
} = {}) {
  let rcon;
  let request;
  let cancelled = false;
  try {
    if (!Number.isInteger(watchdogMs) || watchdogMs < 1 || watchdogMs > TOTAL_WATCHDOG_MS)
      throw new Error("invalid watchdog");
    const execution = async () => {
      request = await readRequest(input);
      if (cancelled) throw new Error("observer cancelled");
      if (!connect) {
        const { Rcon } = await import("rcon-client");
        const options = {
          host: "127.0.0.1",
          port: 25595,
          password: request.password,
          timeout: CONNECT_TIMEOUT_MS,
          maxPending: 1,
        };
        rcon = new Rcon(options);
        rcon.on?.("error", () => {});
        await bounded(
          () => rcon.connect(),
          CONNECT_TIMEOUT_MS,
          () => {
            cancelled = true;
          },
        );
      } else {
        const options = {
          host: "127.0.0.1",
          port: 25595,
          password: request.password,
          timeout: CONNECT_TIMEOUT_MS,
          maxPending: 1,
        };
        const pendingConnection = Promise.resolve().then(() => connect(options));
        pendingConnection.then(
          (connection) => {
            if (cancelled) void closeRcon(connection);
            else rcon = connection;
          },
          () => {},
        );
        rcon = await bounded(
          () => pendingConnection,
          CONNECT_TIMEOUT_MS,
          () => {
            cancelled = true;
          },
        );
      }
      if (cancelled) throw new Error("observer cancelled");
      if (request.phase === "fixture") {
        if (!setupFixture || !verifyFixture) {
          const fixture = await import("./movement-fixture.mjs");
          setupFixture ??= fixture.setupMovementFixture;
          verifyFixture ??= fixture.verifyFixtureSample;
        }
        const setup = await bounded(
          () => setupFixture({ rcon, operationTimeoutMs: FIXTURE_TIMEOUT_MS }),
          FIXTURE_TIMEOUT_MS,
        );
        const baseline = await bounded(
          () =>
            sample({
              rcon,
              phase: "before",
              trialId: request.trial_id,
              actionId: request.action_id,
              operationTimeoutMs: SAMPLE_TIMEOUT_MS,
            }),
          SAMPLE_RESULT_TIMEOUT_MS,
        );
        const baselineVerification = verifyFixture(baseline);
        const result = { schema_version: 1, phase: "fixture", setup, baseline, baselineVerification };
        if (cancelled) throw new Error("observer cancelled");
        await writeResult(output, result, request.password);
        return setup?.status === "configured" &&
          baseline?.status === "sampled" &&
          baselineVerification?.status === "verified"
          ? 0
          : 1;
      }
      const result = await bounded(
        () =>
          sample({
            rcon,
            phase: request.phase,
            trialId: request.trial_id,
            actionId: request.action_id,
            operationTimeoutMs: SAMPLE_TIMEOUT_MS,
          }),
        SAMPLE_RESULT_TIMEOUT_MS,
      );
      if (cancelled) throw new Error("observer cancelled");
      await writeResult(output, result, request.password);
      return result?.schemaVersion === 1 && result?.status === "sampled" ? 0 : 1;
    };
    const code = await bounded(execution, watchdogMs, () => {
      cancelled = true;
    });
    if (code !== 0) genericFailure(error);
    return code;
  } catch {
    cancelled = true;
    genericFailure(error);
    return 1;
  } finally {
    await closeRcon(rcon);
  }
}

function reserveProtocolStdout(stdout) {
  const write = stdout.write.bind(stdout);
  stdout.write = (...args) => {
    const callback =
      args.findLast?.((value) => typeof value === "function") ?? args.find((value) => typeof value === "function");
    if (callback) queueMicrotask(callback);
    return true;
  };
  return Object.freeze({ write, on: stdout.on.bind(stdout), off: stdout.off.bind(stdout) });
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  const protocolOutput = reserveProtocolStdout(process.stdout);
  const watchdog = setTimeout(() => process.exit(1), TOTAL_WATCHDOG_MS);
  const code = await runObserverProcess({ input: process.stdin, output: protocolOutput, error: process.stderr });
  clearTimeout(watchdog);
  process.exit(code);
}
