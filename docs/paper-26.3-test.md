# Isolated Paper 26.3 test (Ubuntu/WSL2)

This is an **experimental ViaBackwards bridge**, not native 26.3 protocol support. Never point these commands at an existing server or world. Paper 26.3 needs Java 25; this repository needs Node.js 22.13+ within the 22.x release line. The heuristic Python combat server uses the standard library on Python 3.10+; Python 3.14 with optional VPT/MineStudio has not been qualified.

```bash
node --version
java -version
python3 --version
git clone https://github.com/JesseRWeigel/minecraft-agent-swarm.git
cd minecraft-agent-swarm
npm ci
npm run typecheck
npm test -- src/minecraft-compat.test.ts
mkdir -p local-paper-263/plugins
curl -fL https://fill-data.papermc.io/v1/objects/a9dad541bf083d5a5f0b65b6a6a98263c55344f22f254c31628b528cf22b9423/paper-26.3-214.jar -o local-paper-263/paper.jar
echo 'a9dad541bf083d5a5f0b65b6a6a98263c55344f22f254c31628b528cf22b9423  local-paper-263/paper.jar' | sha256sum -c -
curl -fL https://github.com/ViaVersion/ViaVersion/releases/download/5.12.1/ViaVersion-5.12.1.jar -o local-paper-263/plugins/ViaVersion.jar
curl -fL https://github.com/ViaVersion/ViaBackwards/releases/download/5.12.1/ViaBackwards-5.12.1.jar -o local-paper-263/plugins/ViaBackwards.jar
printf 'server-ip=127.0.0.1\nserver-port=25576\nonline-mode=false\nenforce-secure-profile=false\nwhite-list=false\nmax-players=5\nspawn-protection=0\n' > local-paper-263/server.properties
```

After reading and accepting the Minecraft EULA yourself, create `local-paper-263/eula.txt` containing `eula=true`. In a second terminal, start the dedicated server:

```bash
cd minecraft-agent-swarm/local-paper-263
java -Xms512M -Xmx2G -jar paper.jar --nogui
```

Run these from the repository root in the first terminal. The smoke uses offline-mode test names, sends ordinary movement only, and fails on kicks, disconnects, or no measured movement. It **does not** run the swarm AI or test mining, crafting, storage, combat, or reconnects.

```bash
MC_HOST=127.0.0.1 MC_PORT=25576 MC_VERSION=26.3 MC_PROTOCOL_VERSION=26.1 MC_VIABACKWARDS=true BOT_COUNT=1 SMOKE_SECONDS=120 node scripts/paper-263-protocol-smoke.mjs
MC_HOST=127.0.0.1 MC_PORT=25576 MC_VERSION=26.3 MC_PROTOCOL_VERSION=26.1 MC_VIABACKWARDS=true BOT_COUNT=5 SMOKE_SECONDS=120 node scripts/paper-263-protocol-smoke.mjs
```

For actual swarm testing, create a private `.env` from `.env.example`, set the same four `MC_*` connection values, `ALLOW_INTERVENTIONS=false`, and first `ENABLE_MULTI_BOT=false`, `BOT_COUNT=1`. Select an available Ollama or other supported LLM, start it separately, and run `npm start`. Observe one bot for at least five minutes: login, walking, mining and collecting a block, crafting and placing a block. Then stop the swarm, set `ENABLE_MULTI_BOT=true`, `BOT_COUNT=5`, rerun `npm start`, and observe all five roles, task execution and shared storage. Check both the Paper console and bot logs. Do not grant bot accounts OP, use `/give` or `/tp`, or copy an existing production world. The five-bot smoke above does **not** substitute for this functional test.

Stop Paper with `stop` in its console. The server binds to loopback, but WSL localhost forwarding can still make it reachable from the Windows host. Do not treat that binding as host isolation. Use a separate network namespace when stronger isolation is required, and adjust the test network deliberately if a separate real Minecraft client must connect.

## Bounded integration verification (2026-11-03)

Maintainer verification used Node.js 22.22.0 on WSL Ubuntu with the locked dependencies. Native Paper 1.21.4 ran on the existing Java 21 runtime in a new test world. The bridge used Paper 26.3 build 214, Temurin Java 25.0.5+8, and ViaVersion/ViaBackwards 5.12.1 in a separate new world. Both ran inside private network namespaces; the user's existing world and server were not used.

The checks called the real application `createBot` and action handlers, with the decision loop explicitly disabled. They passed plugin startup for all five role configurations, movement, oak-log mining and pickup, plank crafting and placement, transfer between two bot identities through a shared chest, and reconnecting the same identity through a new `createBot` call. Shared storage used fixture-seeded raw iron; the test platform, chest and log were fixture setup, not autonomous survival achievements. The bridge clients reported protocol 26.1. The intervention-disabled path left the server's inventory gamerule unchanged.

This is broader than the standalone protocol smoke, but it is not a full autonomous `npm start` run. LLM-selected role cooperation, Mission Control, automatic restart scheduling, farming, combat, long-duration survival and 26.3-only mechanics remain unverified. Treat the bridge as experimental and opt-in.

The supported runtime is Node.js 22.13+ within 22.x. Local Node 24.13 testing exposed an existing scratch-root replacement test failure and containment-worker startup failures under the current limits; Node 24 is not qualified. The containment limits and tests were not relaxed to accommodate it.
