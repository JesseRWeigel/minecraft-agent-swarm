import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("an early smoke failure releases its duration timer", () => {
  const helper = new URL("./paper-smoke-timer.mjs", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { waitForSmokeStop } from ${JSON.stringify(helper)};
     await waitForSmokeStop(60_000, Promise.resolve());
     console.log('stopped');`,
  ], { encoding: "utf8", timeout: 2000 });
  assert.equal(output.trim(), "stopped");
});

test("the duration deadline still completes without a failure", async () => {
  const { waitForSmokeStop } = await import("./paper-smoke-timer.mjs");
  await waitForSmokeStop(10, new Promise(() => {}));
});
