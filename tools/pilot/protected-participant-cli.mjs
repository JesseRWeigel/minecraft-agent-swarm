import { pathToFileURL } from "node:url";
import { createParticipantPipes } from "./participant-pipes.mjs";
import { runParticipant } from "./protected-participant.mjs";

const ID_PATTERN = /[A-Za-z0-9][A-Za-z0-9._-]{0,63}/;
const TOTAL_WATCHDOG_MS = 90_000;

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 6) throw new Error("invalid arguments");
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!["--trial-id", "--action-id", "--movement"].includes(name) || name in values)
      throw new Error("invalid arguments");
    values[name] = argv[index + 1];
  }
  if (
    ID_PATTERN.exec(values["--trial-id"] ?? "")?.[0] !== values["--trial-id"] ||
    ID_PATTERN.exec(values["--action-id"] ?? "")?.[0] !== values["--action-id"]
  )
    throw new Error("invalid arguments");
  if (!["forward", "stationary"].includes(values["--movement"])) throw new Error("invalid arguments");
  return { trialId: values["--trial-id"], actionId: values["--action-id"], movement: values["--movement"] };
}

function writeGenericFailure(error) {
  try {
    error.write("participant failed\n");
  } catch {}
}

export async function runParticipantProcess({
  argv,
  input = process.stdin,
  output = process.stdout,
  error = process.stderr,
  loadMineflayer = () => import("mineflayer"),
  run = runParticipant,
  watchdogMs = TOTAL_WATCHDOG_MS,
  hardExitOnWatchdog = false,
} = {}) {
  let pipes;
  let timer;
  try {
    const options = parseArguments(argv);
    if (!Number.isInteger(watchdogMs) || watchdogMs < 1 || watchdogMs > TOTAL_WATCHDOG_MS)
      throw new Error("invalid watchdog");
    pipes = createParticipantPipes({ input, output, ...options });
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (hardExitOnWatchdog) {
          writeGenericFailure(error);
          process.exit(1);
        }
        reject(new Error("participant watchdog"));
      }, watchdogMs);
    });
    const execution = (async () => {
      const mineflayer = await loadMineflayer();
      if (typeof mineflayer?.createBot !== "function") throw new Error("invalid mineflayer");
      return run({
        ...options,
        createBot: mineflayer.createBot,
        sendMessage: pipes.sendMessage,
        waitForCommand: pipes.waitForCommand,
      });
    })();
    const result = await Promise.race([execution, watchdog]);
    if (result?.schema_version !== 1 || result?.status !== "protocol_completed") throw new Error("participant failed");
    await pipes.close();
    pipes = undefined;
    return 0;
  } catch {
    writeGenericFailure(error);
    return 1;
  } finally {
    clearTimeout(timer);
    try {
      await pipes?.close();
    } catch {}
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
  const code = await runParticipantProcess({
    argv: process.argv.slice(2),
    input: process.stdin,
    output: protocolOutput,
    error: process.stderr,
    hardExitOnWatchdog: true,
  });
  process.exit(code);
}
