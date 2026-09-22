import { pathToFileURL } from "node:url";
import { createParticipantPipes } from "./participant-pipes.mjs";
import { runParticipant } from "./oak-participant.mjs";

const TRIAL_ID = "collect-oak-log-v1";
const ACTION_ID = "collect-01";
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
    values["--trial-id"] !== TRIAL_ID ||
    values["--action-id"] !== ACTION_ID ||
    !["forward", "stationary"].includes(values["--movement"])
  )
    throw new Error("invalid arguments");
  return { trialId: TRIAL_ID, actionId: ACTION_ID, movement: values["--movement"] };
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
  let pipes, timer;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await runParticipantProcess({
    argv: process.argv.slice(2),
    input: process.stdin,
    output: reserveProtocolStdout(process.stdout),
    error: process.stderr,
    hardExitOnWatchdog: true,
  });
  process.exit(code);
}
