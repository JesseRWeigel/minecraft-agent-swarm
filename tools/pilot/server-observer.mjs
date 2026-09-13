import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BOT = /^[A-Za-z0-9_]{1,16}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 65536;
const FIELDS = ["Pos", "Dimension", "Health", "Inventory"];
export function validateRequest(r) {
  if (!r || r.host !== "127.0.0.1" || !Number.isInteger(r.port) || r.port < 1024 || r.port > 65535 || r.port === 25575)
    throw new Error("Explicit isolated loopback RCON port required; production port 25575 is forbidden");
  if (
    !["trialId", "actionId", "botId", "phase", "snapshotSha256", "serverVersion"].every(
      (key) => typeof r[key] === "string",
    ) ||
    !ID.test(r.trialId ?? "") ||
    !ID.test(r.actionId ?? "") ||
    !BOT.test(r.botId ?? "") ||
    !["before", "after"].includes(r.phase) ||
    !SHA.test(r.snapshotSha256 ?? "") ||
    !ID.test(r.serverVersion ?? "")
  )
    throw new Error("Invalid bounded trial, action, entity, phase, snapshot or version identity");
}
async function bounded(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function parseState(replies, botId) {
  const prefix = `${botId} has the following entity data: `;
  const value = (field) => {
    const reply = replies.find((q) => q.field === field && q.status === "captured")?.response;
    return reply?.startsWith(prefix) ? reply.slice(prefix.length) : null;
  };
  const number = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
  const pos = value("Pos")?.match(new RegExp(`^\\[(${number})d?,\\s*(${number})d?,\\s*(${number})d?\\]$`));
  const dimension = value("Dimension")?.match(/^"(minecraft:(?:overworld|the_nether|the_end))"$/)?.[1] ?? null;
  const xyz = pos?.slice(1).map(Number);
  const healthMatch = value("Health")?.match(new RegExp(`^(${number})f?$`));
  const health = healthMatch ? Number(healthMatch[1]) : null;
  return {
    position: xyz?.every(Number.isFinite) ? { x: xyz[0], y: xyz[1], z: xyz[2], dimension } : null,
    health: Number.isFinite(health) && health >= 0 ? health : null,
    inventoryParsed: false,
  };
}
/** Only fixed read-only server commands; injected transports make tests offline.
 * Parsed state never establishes task success or a verified world reset. */
export async function collectServerObservation(request, transport, { timeoutMs = 2000 } = {}) {
  validateRequest(request);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error("Invalid bounded timeout");
  const startedAt = new Date().toISOString();
  const queries = [];
  for (const field of FIELDS) {
    const command = `data get entity ${request.botId} ${field}`;
    const query = { field, command, startedAt: new Date().toISOString() };
    try {
      const response = await bounded(
        Promise.resolve().then(() => transport.send(command)),
        timeoutMs,
      );
      if (typeof response !== "string" || Buffer.byteLength(response, "utf8") > MAX_RESPONSE_BYTES) {
        queries.push({ ...query, status: "response_unavailable_or_oversize", finishedAt: new Date().toISOString() });
        break;
      }
      queries.push({
        ...query,
        status: "captured",
        response,
        responseSha256: createHash("sha256").update(response, "utf8").digest("hex"),
        finishedAt: new Date().toISOString(),
      });
    } catch {
      queries.push({ ...query, status: "transport_failure_or_timeout", finishedAt: new Date().toISOString() });
      break;
    }
  }
  const state = parseState(queries, request.botId);
  return {
    schemaVersion: 1,
    observationId: randomUUID(),
    source: "minecraft_server_rcon",
    trialId: request.trialId,
    actionId: request.actionId,
    botId: request.botId,
    phase: request.phase,
    startedAt,
    finishedAt: new Date().toISOString(),
    identity: {
      host: request.host,
      port: request.port,
      snapshotSha256: request.snapshotSha256,
      snapshotVerified: false,
      serverVersion: request.serverVersion,
      serverVersionVerified: false,
    },
    atomicSnapshot: false,
    rawCaptureComplete: queries.length === FIELDS.length && queries.every((q) => q.status === "captured"),
    navigationStateAvailable: state.position !== null && state.position.dimension !== null,
    state,
    queries,
    claimsTaskSuccess: false,
    claimsLiveBenchmarkResult: false,
  };
}
async function main() {
  const { values } = parseArgs({
    options: {
      host: { type: "string" },
      port: { type: "string" },
      trial: { type: "string" },
      action: { type: "string" },
      bot: { type: "string" },
      phase: { type: "string" },
      snapshot: { type: "string" },
      version: { type: "string" },
      output: { type: "string" },
      observe: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      "Read-only isolated server capture: --observe --host 127.0.0.1 --port PORT --trial ID --action ID --bot NAME --phase before|after --snapshot SHA256 --version ID --output NEW_FILE. Password: PILOT_RCON_PASSWORD environment only. No server is started or reset.",
    );
    return;
  }
  if (!values.observe) throw new Error("--observe is required to contact an explicitly configured isolated server");
  const request = {
    host: values.host,
    port: Number(values.port),
    trialId: values.trial,
    actionId: values.action,
    botId: values.bot,
    phase: values.phase,
    snapshotSha256: values.snapshot,
    serverVersion: values.version,
  };
  validateRequest(request);
  const password = process.env.PILOT_RCON_PASSWORD;
  if (!password) throw new Error("PILOT_RCON_PASSWORD must be supplied; production credentials are never read");
  if (!values.output) throw new Error("A new output file is required");
  const output = path.resolve(values.output);
  const parent = path.dirname(output);
  if (fs.realpathSync(parent) !== parent) throw new Error("Output parent must not traverse symlinks");
  const fd = fs.openSync(output, "wx", 0o600);
  let client;
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({ schemaVersion: 1, status: "capture_started", claimsTaskSuccess: false }) + "\n",
    );
    const { Rcon } = await import("rcon-client");
    client = new Rcon({ host: request.host, port: request.port, password, timeout: 2000, maxPending: 1 });
    client.on("error", () => {});
    await bounded(client.connect(), 3000);
    const report = await collectServerObservation(request, client);
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, JSON.stringify(report, null, 2) + "\n", 0, "utf8");
    fs.fsyncSync(fd);
    console.log(
      JSON.stringify({
        output,
        rawCaptureComplete: report.rawCaptureComplete,
        navigationStateAvailable: report.navigationStateAvailable,
        claimsTaskSuccess: false,
      }),
    );
    if (!report.rawCaptureComplete || !report.navigationStateAvailable) process.exitCode = 2;
  } catch {
    fs.ftruncateSync(fd, 0);
    fs.writeSync(
      fd,
      JSON.stringify({
        schemaVersion: 1,
        status: "capture_failed",
        claimsTaskSuccess: false,
        reason: "connection_or_capture_failed",
      }) + "\n",
      0,
      "utf8",
    );
    process.exitCode = 1;
    console.error("Server observation failed; diagnostic output retained without connection credentials.");
  } finally {
    client?.socket?.destroy();
    fs.closeSync(fd);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error("Invalid observer request or output; use --help.");
    process.exitCode = 1;
  });
