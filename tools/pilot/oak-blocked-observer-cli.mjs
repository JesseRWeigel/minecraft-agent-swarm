import { pathToFileURL } from "node:url";

import { setupOakBlockedFixture } from "./oak-blocked-fixture.mjs";
import { verifyOakFixtureSample } from "./oak-fixture.mjs";
import { sampleOakTask } from "./oak-task.mjs";
import { runObserverProcess } from "./protected-observer-cli.mjs";

export function runOakBlockedObserverProcess(options = {}) {
  return runObserverProcess({
    ...options,
    setupFixture: setupOakBlockedFixture,
    sample: sampleOakTask,
    verifyFixture: verifyOakFixtureSample,
  });
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
  const watchdog = setTimeout(() => process.exit(1), 25_000);
  const code = await runOakBlockedObserverProcess({ input: process.stdin, output: protocolOutput, error: process.stderr });
  clearTimeout(watchdog);
  process.exit(code);
}
