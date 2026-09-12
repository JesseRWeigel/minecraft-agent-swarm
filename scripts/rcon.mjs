#!/usr/bin/env node
// Send RCON commands to the local Paper server. Password read from server/server.properties.
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { Rcon } = createRequire(path.join(root, "package.json"))("rcon-client");
const props = fs.readFileSync(path.join(root, "server/server.properties"), "utf8");
const pw = props.match(/^rcon\.password=(.*)$/m)?.[1]?.trim();
const port = Number(props.match(/^rcon\.port=(\d+)$/m)?.[1] ?? 25575);
const rcon = await Rcon.connect({ host: "localhost", port, password: pw });
for (const cmd of process.argv.slice(2)) {
  const r = await rcon.send(cmd);
  console.log(`> ${cmd}\n${r}`);
}
await rcon.end();
