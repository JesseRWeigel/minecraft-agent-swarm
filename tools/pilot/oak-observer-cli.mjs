import { pathToFileURL } from "node:url";

import { setupOakFixture, verifyOakFixtureSample } from "./oak-fixture.mjs";
import { sampleOakTask } from "./oak-task.mjs";
import { runObserverProcess } from "./protected-observer-cli.mjs";

export function runOakObserverProcess(options = {}) {
  return runObserverProcess({
    ...options,
    setupFixture: setupOakFixture,
    sample: sampleOakTask,
    verifyFixture: verifyOakFixtureSample,
  });
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  const watchdog = setTimeout(() => process.exit(1), 25_000);
  const code = await runOakObserverProcess();
  clearTimeout(watchdog);
  process.exit(code);
}
