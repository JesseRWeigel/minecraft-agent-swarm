import vm from "node:vm";
import readline from "node:readline";
import { randomBytes } from "node:crypto";

const MAX_MESSAGE_BYTES = 64 * 1024;
const METHODS = Object.freeze([
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
]);

const name = process.argv[2];
const candidatePath = process.argv[3];
if (!/^[a-z][A-Za-z0-9_]{0,39}$/.test(name || "")) {
  process.stderr.write("invalid generated skill name\n");
  process.exit(2);
}

const completionToken = randomBytes(32).toString("hex");
const writeProtocol = process.stdout.write.bind(process.stdout);
writeProtocol(JSON.stringify({ type: "ready", token: completionToken }) + "\n");

let nextId = 1;
const pending = new Map();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) process.exit(3);
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.exit(3);
  }
  if (!message || message.type !== "response" || !Number.isSafeInteger(message.id)) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.ok) waiter.resolve(message.value);
  else waiter.reject(new Error(typeof message.error === "string" ? message.error : "Capability rejected"));
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    writeProtocol(JSON.stringify({ type: "request", id, method, params: params ?? {} }) + "\n");
  });
}

const api = Object.create(null);
for (const method of METHODS) {
  Object.defineProperty(api, method, {
    value: (params = {}) => request(method, params),
    enumerable: true,
    writable: false,
    configurable: false,
  });
}
Object.freeze(api);

function serialisable(value) {
  if (value === undefined) return null;
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES) {
    throw new Error("Generated skill returned an oversized or non-serialisable value");
  }
  return JSON.parse(encoded);
}

try {
  const fs = await import("node:fs/promises");
  const code = await fs.readFile(candidatePath, "utf8");
  const context = vm.createContext(Object.create(null), {
    name: "generated-skill",
    codeGeneration: { strings: true, wasm: false },
  });
  new vm.Script(code, { filename: "/sandbox/candidate.js" }).runInContext(context, { timeout: 500 });
  const fn = context[name];
  if (typeof fn !== "function") throw new Error("Candidate must define the expected async function");
  const value = await fn(api);
  writeProtocol(
    JSON.stringify({ type: "result", token: completionToken, success: true, value: serialisable(value) }) + "\n",
  );
} catch (error) {
  writeProtocol(
    JSON.stringify({
      type: "result",
      token: completionToken,
      success: false,
      error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
    }) + "\n",
  );
  process.exitCode = 1;
} finally {
  input.close();
}
