import { createReadStream, createWriteStream, fstatSync } from "node:fs";
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
    !["forward", "stationary", "mine_only", "blocked", "model"].includes(values["--movement"])
  )
    throw new Error("invalid arguments");
  return { trialId: TRIAL_ID, actionId: ACTION_ID, movement: values["--movement"] };
}

function writeGenericFailure(error) {
  try {
    error.write("participant failed\n");
  } catch {}
}

function openDedicatedActionStreams() {
  const read = fstatSync(3),
    write = fstatSync(4);
  const lifecycle = [0, 1, 2].map((fd) => fstatSync(fd));
  if (
    lifecycle.some((existing) =>
      [read, write].some((action) => action.dev === existing.dev && action.ino === existing.ino),
    )
  )
    throw new Error("action descriptor aliases lifecycle");
  if (!read.isFIFO() || !write.isFIFO() || (read.dev === write.dev && read.ino === write.ino))
    throw new Error("dedicated action pipes required");
  const input = createReadStream(null, { fd: 3, autoClose: true, highWaterMark: 4097 });
  try {
    return { input, output: createWriteStream(null, { fd: 4, autoClose: true }) };
  } catch (error) {
    input.destroy();
    throw error;
  }
}

export async function runParticipantProcess({
  argv,
  input = process.stdin,
  output = process.stdout,
  error = process.stderr,
  openActionStreams = openDedicatedActionStreams,
  loadMineflayer = () => import("mineflayer"),
  run = runParticipant,
  watchdogMs = TOTAL_WATCHDOG_MS,
  hardExitOnWatchdog = false,
} = {}) {
  let pipes, timer, actionStreams;
  try {
    const options = parseArguments(argv);
    if (!Number.isInteger(watchdogMs) || watchdogMs < 1 || watchdogMs > TOTAL_WATCHDOG_MS)
      throw new Error("invalid watchdog");
    if (options.movement === "model") {
      const streams = openActionStreams();
      if (
        !streams?.input?.on ||
        !streams?.output?.write ||
        streams.input === streams.output ||
        [input, output, error].includes(streams.input) ||
        [input, output, error].includes(streams.output)
      )
        throw new Error("action streams must be separate");
      actionStreams = streams;
      actionStreams.input.on("error", () => {});
      actionStreams.output.on("error", () => {});
    }
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
        ...(actionStreams ? { actionInput: actionStreams.input, actionOutput: actionStreams.output } : {}),
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
    actionStreams?.input.destroy();
    actionStreams?.output.destroy();
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
