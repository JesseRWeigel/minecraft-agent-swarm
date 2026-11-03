// Protocol-only smoke against an operator-owned, isolated Paper test server.
// Does not run the AI, gather resources, craft, or mutate blocks.
import mineflayer from "mineflayer";
import { waitForSmokeStop } from "./paper-smoke-timer.mjs";

const count = Number(process.env.BOT_COUNT || 1);
const seconds = Number(process.env.SMOKE_SECONDS || 120);
if (!Number.isInteger(count) || count < 1 || count > 5 || !Number.isInteger(seconds) || seconds < 60) {
  throw new Error("BOT_COUNT must be 1..5 and SMOKE_SECONDS at least 60");
}

const host = process.env.MC_HOST || "127.0.0.1";
const port = Number(process.env.MC_PORT);
if (
  !["127.0.0.1", "localhost"].includes(host) ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  port === 25565 ||
  process.env.MC_VERSION !== "26.3" ||
  process.env.MC_PROTOCOL_VERSION !== "26.1" ||
  process.env.MC_VIABACKWARDS !== "true"
) {
  throw new Error(
    "Use an isolated loopback Paper 26.3 server on an explicit non-default port with the 26.1 ViaBackwards bridge",
  );
}
const version = "26.1";
const bots = [];
let failed = false;
let stopEarly;
const earlyFailure = new Promise((resolve) => (stopEarly = resolve));

for (let i = 0; i < count; i++) {
  const name = `SwarmSmoke${i + 1}`;
  const bot = mineflayer.createBot({ host, port, username: name, version, auth: "offline" });
  bots.push(bot);
  let spawned = false;
  let moved = false;
  let start;
  bot.once("spawn", () => {
    spawned = true;
    start = bot.entity.position.clone();
    console.log(`${name}: spawned at ${start}`);
    // A random natural spawn may face a wall. Try ordinary movement in each
    // direction before declaring a protocol/movement failure.
    void (async () => {
      const directions = ["forward", "back", "left", "right"];
      for (let attempt = 0; attempt < directions.length && !moved; attempt++) {
        bot.setControlState(directions[(i + attempt) % directions.length], true);
        bot.setControlState("jump", true);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        bot.clearControlStates();
      }
    })();
  });
  bot.on("move", () => {
    if (start && Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z) > 1) moved = true;
  });
  bot.on("kicked", (reason) => {
    failed = true;
    console.error(`${name}: kicked: ${reason}`);
    stopEarly();
  });
  bot.on("error", (error) => {
    failed = true;
    console.error(`${name}: ${error.message}`);
    stopEarly();
  });
  bot.on("end", () => {
    if (spawned && !bot._swarmSmokeClosing) {
      failed = true;
      console.error(`${name}: disconnected early`);
      stopEarly();
    }
  });
  bot._swarmSmokeResult = () => ({ name, spawned, moved });
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

await waitForSmokeStop(seconds * 1000, earlyFailure);
for (const bot of bots) {
  const result = bot._swarmSmokeResult();
  console.log(JSON.stringify(result));
  if (!result.spawned || !result.moved) failed = true;
  bot._swarmSmokeClosing = true;
  bot.quit();
}
process.exitCode = failed ? 1 : 0;
