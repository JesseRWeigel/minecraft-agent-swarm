import { copyFile, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist", import.meta.url), { recursive: true });
await copyFile(
  new URL("../src/skills/generated-worker.mjs", import.meta.url),
  new URL("../dist/generated-worker.mjs", import.meta.url),
);
