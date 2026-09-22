import fs from "node:fs";
import path from "node:path";
import { scoreOakTask } from "./oak-task.mjs";
import { verifyOakFixtureSample } from "./oak-fixture.mjs";
try {
  if (process.argv.length > 3) throw new Error("args");
  const root = process.argv[2] ?? process.cwd();
  if (!path.isAbsolute(root)) throw new Error("path");
  function read(name) {
    const fd = fs.openSync(path.join(root, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > 65536) throw new Error("size");
      const b = Buffer.alloc(65537);
      let n = 0,
        got;
      while ((got = fs.readSync(fd, b, n, b.length - n, null)) > 0) {
        n += got;
        if (n > 65536) throw new Error("size");
      }
      const x = JSON.parse(b.subarray(0, n).toString("utf8"));
      if (x.returncode !== 0 || x.error !== null) throw new Error("capture");
      return x.result;
    } finally {
      fs.closeSync(fd);
    }
  }
  const before = read("observer-before.json"),
    terminal = read("observer-terminal.json");
  console.log(
    JSON.stringify({
      endpoint: scoreOakTask({ before, terminal, trialId: "collect-oak-log-v1", actionId: "collect-01" }),
      baselineVerification: verifyOakFixtureSample(before),
    }),
  );
} catch {
  process.stderr.write("oak scoring failed\n");
  process.exitCode = 1;
}
