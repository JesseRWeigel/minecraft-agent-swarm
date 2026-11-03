# Isolated Paper 26.3 test (Ubuntu/WSL2)

This is an **experimental ViaBackwards bridge**, not native 26.3 protocol support. Never point these commands at an existing server or world. Paper 26.3 needs Java 25; this repository needs Node.js 22.13+ within the 22.x release line. The heuristic Python combat server uses the standard library on Python 3.10+; Python 3.14 with optional VPT/MineStudio has not been qualified.

```bash
node --version
java -version
python3 --version
git clone --branch feature/minecraft-26.3 https://github.com/GerwinVerkerk/minecraft-agent-swarm.git
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

Stop Paper with `stop` in its console. The loopback-only test server is deliberately not reachable from Windows or other hosts; adjust the test network deliberately if a separate real Minecraft client must connect.
