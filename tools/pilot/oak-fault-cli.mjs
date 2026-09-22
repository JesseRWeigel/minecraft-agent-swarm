import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const REQUEST_BYTES = 4096;
const RESULT_BYTES = 65_536;
const CONNECT_TIMEOUT_MS = 5000;
const MAX_OPERATION_TIMEOUT_MS = 15_000;
const TOTAL_WATCHDOG_MS = 25_000;
const REQUEST_KEYS = ["action_id", "mode", "operation_timeout_ms", "password", "schema_version", "trial_id"];
const TRIAL_ID = "collect-oak-log-v1";
const ACTION_ID = "collect-01";

const COMMANDS = Object.freeze({
  mid_action_disconnect: Object.freeze(["kick PilotProbe Oak qualification disconnect"]),
  item_only: Object.freeze(["give PilotProbe minecraft:oak_log 1"]),
  item_and_block: Object.freeze([
    "give PilotProbe minecraft:oak_log 1",
    "execute in minecraft:overworld run setblock 0 200 3 minecraft:air",
  ]),
});

class FaultFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function genericFailure(error) {
  try {
    error.write("oak fault failed\n");
  } catch {}
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
    if (bytes > REQUEST_BYTES) throw new FaultFailure("invalid_request");
    chunks.push(value);
  }
  if (bytes === 0) throw new FaultFailure("invalid_request");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new FaultFailure("invalid_request");
  }
  if (hasDuplicateKeys(text)) throw new FaultFailure("invalid_request");
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    throw new FaultFailure("invalid_request");
  }
  if (!request || Array.isArray(request) || typeof request !== "object") throw new FaultFailure("invalid_request");
  if (JSON.stringify(Object.keys(request).sort()) !== JSON.stringify(REQUEST_KEYS)) throw new FaultFailure("invalid_request");
  if (
    request.schema_version !== 1 ||
    typeof request.mode !== "string" ||
    !Object.hasOwn(COMMANDS, request.mode) ||
    request.trial_id !== TRIAL_ID ||
    request.action_id !== ACTION_ID ||
    typeof request.password !== "string" ||
    request.password.length === 0 ||
    request.password.includes("\0") ||
    !Number.isInteger(request.operation_timeout_ms) ||
    request.operation_timeout_ms < 1 ||
    request.operation_timeout_ms > MAX_OPERATION_TIMEOUT_MS
  )
    throw new FaultFailure("invalid_request");
  return request;
}

function bounded(operation, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new FaultFailure("timeout")), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => clearTimeout(timer));
}

function validateReply(reply) {
  if (typeof reply !== "string" || reply.length === 0 || Buffer.byteLength(reply, "utf8") > RESULT_BYTES)
    throw new FaultFailure("invalid_response");
  if (/(?:unknown or incomplete command|incorrect argument|no entity was found|cannot find|exception|permission|not allowed|failed)/i.test(reply))
    throw new FaultFailure("command_failed");
}

async function writeResult(output, value, password) {
  const line = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(line, "utf8") > RESULT_BYTES || line.includes(password)) throw new FaultFailure("invalid_result");
  await new Promise((resolve, reject) => {
    let settled = false;
    const complete = (error) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve();
    };
    try {
      output.write(line, complete);
    } catch (error) {
      complete(error);
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

export async function runOakFaultProcess({
  input = process.stdin,
  output = process.stdout,
  error = process.stderr,
  connect,
  send = (rcon, command) => rcon.send(command),
  nowMonotonic = performance.now.bind(performance),
  watchdogMs = TOTAL_WATCHDOG_MS,
} = {}) {
  let rcon;
  let request;
  let emitted = false;
  if (typeof send !== "function" || typeof nowMonotonic !== "function" || !Number.isInteger(watchdogMs) || watchdogMs < 1 || watchdogMs > TOTAL_WATCHDOG_MS) {
    genericFailure(error);
    return 1;
  }
  try {
    request = await bounded(() => readRequest(input), watchdogMs);
    const execute = async () => {
      const options = { host: "127.0.0.1", port: 25595, password: request.password, timeout: CONNECT_TIMEOUT_MS, maxPending: 1 };
      if (connect) rcon = await bounded(() => connect(options), CONNECT_TIMEOUT_MS);
      else {
        const { Rcon } = await import("rcon-client");
        rcon = new Rcon(options);
        rcon.on?.("error", () => {});
        await bounded(() => rcon.connect(), CONNECT_TIMEOUT_MS);
      }
      let last = null;
      const clock = () => {
        const value = nowMonotonic();
        if (typeof value !== "number" || !Number.isFinite(value) || (last !== null && value < last))
          throw new FaultFailure("clock_invalid");
        last = value;
        return value;
      };
      const result = {
        schema_version: 1,
        status: "failed",
        mode: request.mode,
        commands: [],
        durationMs: null,
      };
      let started;
      let deadline;
      try {
        started = clock();
        deadline = started + request.operation_timeout_ms;
        for (const command of COMMANDS[request.mode]) {
          const commandStarted = clock();
          const receipt = {
            command,
            outcome: "pending",
            startedMonotonicMs: commandStarted,
            finishedMonotonicMs: null,
            durationMs: null,
            responseType: null,
            responseBytes: null,
          };
          result.commands.push(receipt);
          try {
            const available = deadline - commandStarted;
            if (available <= 0) throw new FaultFailure("timeout");
            const reply = await bounded(() => send(rcon, command), available);
            receipt.responseType = typeof reply;
            receipt.responseBytes = typeof reply === "string" ? Buffer.byteLength(reply, "utf8") : null;
            validateReply(reply);
            receipt.outcome = "issued";
          } catch (cause) {
            receipt.outcome = cause instanceof FaultFailure ? cause.code : "command_failed";
            throw cause;
          } finally {
            const finished = clock();
            receipt.finishedMonotonicMs = finished;
            receipt.durationMs = finished - commandStarted;
          }
          if (clock() >= deadline) throw new FaultFailure("timeout");
        }
        result.status = "completed";
      } catch (cause) {
        result.errorCode = cause instanceof FaultFailure ? cause.code : "fault_execution_failed";
      } finally {
        try {
          const finished = clock();
          result.durationMs = started === undefined ? null : finished - started;
          if (deadline !== undefined && finished >= deadline) {
            result.status = "failed";
            result.errorCode = "timeout";
          }
        } catch {
          result.status = "failed";
          result.errorCode = "clock_invalid";
        }
      }
      await writeResult(output, result, request.password);
      emitted = true;
      return result.status === "completed" ? 0 : 1;
    };
    const code = await bounded(execute, watchdogMs);
    if (code !== 0) genericFailure(error);
    return code;
  } catch {
    if (request && !emitted) {
      const result = { schema_version: 1, status: "failed", mode: request.mode, commands: [], durationMs: null, errorCode: "fault_execution_failed" };
      try {
        await writeResult(output, result, request.password);
      } catch {}
    }
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
  const code = await runOakFaultProcess({ input: process.stdin, output: protocolOutput, error: process.stderr });
  clearTimeout(watchdog);
  process.exit(code);
}
