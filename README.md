# Atlas — Autonomous AI Minecraft Bot Team

A team of autonomous AI agents that play Minecraft together, powered by a local LLM (Ollama) with a hybrid skill system: hand-crafted TypeScript skills, 57 Voyager-style JavaScript skills, and dynamic skill generation at runtime.

Each bot specializes in a different area — exploring, farming, mining, building, or combat — and they coordinate through shared context and a central resource stash.

Designed for live streaming: includes a Mission Control dashboard, per-bot 3D viewers, OBS overlays, TTS, and Twitch integration.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│              Event-Driven Brain (per bot, src/bot/brain.ts)   │
│  events: idle(10s)→strategic · hostiles/damage→reactive ·     │
│  action done→critic · chat→reply                              │
│  World Context + Team Bulletin + TECH TREE → LLM → Action     │
│            (single Ollama MoE: qwen3.6:35b-a3b)               │
└────────────────────────┬─────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
   TypeScript Skills  Voyager Skills  Neural Combat
   (build_house,      (57 JS skills   (Python TCP server
    craft_gear,        in vm sandbox)  heuristic policy)
    strip_mine, …)
          │              │              │
          └──────────────┴──────────────┘
                         │
          ┌──────────────▼──────────────┐
          │     Per-Bot Memory (.json)  │
          │  (structures, deaths, ores, │
          │   skill success rates)      │
          └──────────────┬──────────────┘
                         │
          ┌──────────────▼──────────────┐
          │     Team Bulletin (shared)  │
          │  (each bot's action, pos,   │
          │   thought — injected into   │
          │   every LLM prompt)         │
          └─────────────────────────────┘
```

### Bot Team

| Bot | Role | Specialty | Leash Radius |
|-----|------|-----------|-------------|
| **Atlas** | Scout / Explorer | Roams far, discovers ores/biomes, maps terrain | 500 blocks |
| **Flora** | Farmer / Crafter | Grows crops, breeds animals, processes materials | 100 blocks |
| **Forge** | Miner / Smelter | Strip mines, digs tunnels, smelts ores | 250 blocks |
| **Mason** | Builder | Builds houses, bridges, lights areas, manages stash | 150 blocks |
| **Blade** | Combat / Guard | Patrols perimeter, kills hostiles, hunts animals | 300 blocks |

Each bot has its own personality, allowed actions, allowed skills, memory file, and leash radius. They share a central stash of chests for resource exchange and see each other's status via the Team Bulletin.

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| Brain (decision engine) | `src/bot/brain.ts` | Event-driven: strategic/reactive/critic/chat handlers |
| Bot lifecycle | `src/bot/index.ts` | Connection, spawn safety, plugin loading |
| Scoreboard | `src/bot/scoreboard.ts` | Per-session metrics + tech milestones → `logs/sessions/` |
| Curriculum | `src/bot/curriculum.ts` | Inventory-driven tech-tree next-goal injection |
| Skill reliability | `src/skills/reliability.ts` | Team-wide success rates; auto-retires broken skills |
| Trajectory capture | `src/bot/trajectory.ts` | Logs prompt→decision→outcome for fine-tuning |
| Navigation helpers | `src/bot/navigation.ts` | safeGoto, drop collection, movement presets |
| Role configs | `src/bot/role.ts` | Per-bot personality, actions, skills, leash |
| Team bulletin | `src/bot/bulletin.ts` | Shared status between bots |
| World perception | `src/bot/perception.ts` | Builds context string for LLM |
| Action executor | `src/bot/actions.ts` | Routes JSON actions to implementations |
| LLM client | `src/llm/index.ts` | Ollama API with retry + JSON repair |
| Skill executor | `src/skills/executor.ts` | Runs skills with abort support |
| Voyager loader | `src/skills/dynamic-loader.ts` | Runs JS skills in vm sandbox |
| Skill generator | `src/skills/generator.ts` | LLM generates new JS skills |
| Memory | `src/bot/memory.ts` | Per-bot persistent JSON |
| Stash actions | `src/skills/stash.ts` | Deposit/withdraw from shared chests |
| Neural combat | `src/neural/combat.ts` | 50ms tick loop using TCP server |
| Neural server | `neural_server.py` | Python heuristic/VPT policy server |
| Dashboard | `src/stream/dashboard.ts` | Mission Control on port 3010 |
| Stream viewer | `src/stream/viewer.ts` | Per-bot prismarine-viewer |
| OBS overlay | `src/stream/overlay.ts` | Per-bot WebSocket overlay for OBS |
| TTS | `src/stream/tts.ts` | Text-to-speech for bot thoughts |
| Safety filter | `src/safety/filter.ts` | Blocks harmful chat/thoughts |

---

## Setup

### Requirements

- Node.js 20+
- [Ollama](https://ollama.ai) with `qwen3.6:35b-a3b` pulled (one MoE model serves all decision types)
- Minecraft Java Edition server (1.21.4) with 5+ player slots
- Python 3.10+ (for neural combat server)

### Install

```bash
git clone https://github.com/JesseRWeigel/mineflayer-chatgpt.git
cd mineflayer-chatgpt
npm install
pip install -r requirements.txt   # for neural server
```

### Configure

Create a `.env` file:

```env
# Minecraft server
MC_HOST=localhost
MC_PORT=25565
MC_USERNAME=Atlas
MC_USERNAME_2=Flora
MC_USERNAME_3=Forge
MC_USERNAME_4=Mason
MC_USERNAME_5=Blade
MC_VERSION=1.21.4
MC_AUTH=offline

# LLM (Ollama)
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=qwen3.6:35b-a3b       # MoE: ~3B active params, ~150 tok/s on a 32GB GPU
OLLAMA_FAST_MODEL=qwen3.6:35b-a3b  # Same model — two models don't fit in 32GB together

# Bot identity
BOT_NAME=Atlas
BOT_IDLE_INTERVAL_MS=10000   # How often the brain re-plans when nothing is happening
BOT_CHAT_COOLDOWN_MS=3000

# Multi-bot mode
ENABLE_MULTI_BOT=true
BOT_COUNT=5                   # 1=Atlas only, 2=+Flora, 5=all bots

# Twitch (optional)
TWITCH_CHANNEL=your_channel
TWITCH_BOT_USERNAME=your_bot
TWITCH_OAUTH_TOKEN=oauth:...
```

### Run

```bash
# Start Minecraft server first, then:
npm run dev
```

The bots will:
1. Connect to the Minecraft server (staggered 10s apart)
2. Start the neural combat server automatically
3. Start the unified 3D viewer at `http://localhost:3000` (switch bots with keys 1-5; per-bot ports are a fallback)
4. Start Mission Control dashboard at `http://localhost:3010`
5. Begin autonomous decision loops

> **Note:** All bot usernames must be operators on the server (e.g. `/op Atlas`, `/op Flora`, etc.) so they can set gamerules and use teleport-based spawn safety.

> **Tip:** With `online-mode=false` you can join the world yourself — Direct Connect to `localhost:25565` with any username and watch the bots up close (`/gamemode spectator` for free-flight).

### Single-Bot Mode

To run just Atlas (original single-bot behavior):

```env
ENABLE_MULTI_BOT=false
```

---

## Features

### Multi-Bot Team Coordination

The 5 bots coordinate through **shared context** — no coordinator bot, no task assignment. Each bot's LLM prompt includes a Team Bulletin showing what every other bot is doing:

```
TEAM STATUS (live):
- Atlas: exploring north at (450, 72, -280) — "Found a massive cave system!"
- Flora: running build_farm at (285, 65, -318) — "Planting wheat row 3"
- Forge: running strip_mine at (290, 11, -315) — "Mining iron ore vein"
- Mason: running build_house at (282, 66, -322) — "Placing roof blocks"
- Blade: patrolling at (300, 68, -310) — "All clear"
```

This enables natural coordination: Flora sees Forge deposited raw iron and decides to smelt it. Mason sees Atlas found a good building spot and heads there. Blade sees Flora farming at night and patrols near her.

### Shared Stash

All bots share a central stash of categorized chests:

| Row | Category | Example Items |
|-----|----------|--------------|
| 1 | Building | logs, planks, cobblestone, glass |
| 2 | Metals & Ores | raw iron, iron ingots, copper, coal |
| 3 | Food & Farming | wheat, seeds, bread, cooked meat |
| 4 | Tools & Combat | swords, pickaxes, armor, arrows |
| 5+ | Overflow | anything else |

Mason bootstraps the first chest on spawn. When chests fill up, Mason crafts and places more. Bots deposit excess items and withdraw what they need via `deposit_stash` / `withdraw_stash` actions.

### Mission Control Dashboard

Access at `http://localhost:3010` — a single page showing all bots at a glance:

- **Bot cards** at top: real-time health, current action, last thought, position
- **3D viewer** in center: click any bot to switch the live view
- **Stash status** sidebar: inventory summary across all stash chests
- **Auto-cycle** button: toggles automatic switching between bots (30s each)
- **Keyboard shortcuts**: 1-5 to select a bot, C to toggle auto-cycle

### Port Allocation

All bots share the unified viewer at `:3000`. Per-bot ports below are the legacy fallback when the unified viewer is unavailable:

| Bot | 3D Viewer (fallback) | Overlay |
|-----|-----------|---------|
| Atlas | :3000 | :3001 |
| Flora | :3002 | :3003 |
| Forge | :3004 | :3005 |
| Mason | :3006 | :3007 |
| Blade | :3008 | :3009 |
| Dashboard | :3010 | — |

### Autonomous Decision Making

The brain is **event-driven**, not a polling loop:
- **Strategic** (every ~10s idle, or on goal completion): full world context + team bulletin + memory + tech-tree curriculum → goal-setting decision
- **Reactive** (hostiles spotted, damage taken, low health/hunger): tiny prompt, fast response
- **Critic** (after every action): verifies the result, suggests the next step or triggers a re-plan
- **Chat** (player/viewer/teammate message): in-character reply

Each decision executes a gated action (restricted to the bot's allowed actions/skills), records success/failure, and updates memory, the team bulletin, the scoreboard, and the trajectory log.

**Stuck detection:** If the same action fails 2+ times in a row, the bot is forced to choose a different approach. Failed actions are injected into the next prompt.

**Goal persistence:** The LLM can set multi-step goals (e.g., "build a house") with a step count. The bot tracks progress across decision cycles.

**Leash enforcement:** Each bot has a max distance from home. At 80% of leash radius, the LLM is warned. At 150%, the bot is force-navigated home.

**Deterministic overrides:** Known-correct moves skip the LLM entirely — leash returns, water/buried escapes, and stash bootstrap (when a bot owns `setup_stash`, has materials, and no stash chest exists, it just runs it).

### Skill System

**TypeScript skills** (assigned per role):
- `build_house` — build a 7x7 shelter with doors, crafting table, torches
- `build_farm` — hoe dirt, plant wheat near water, harvest when ready
- `build_bridge` — bridge across water/gaps in facing direction
- `craft_gear` — craft best available tools and armor
- `strip_mine` — horizontal mining tunnel at current Y
- `smelt_ores` — smelt raw ore into ingots, crafts furnace if needed
- `light_area` — place torches in a radius
- `go_fishing` — cast and reel a fishing rod
- `setup_stash` — bootstrap shared chest area
- `neural_combat` — 50ms tick reactive combat via Python server

**Voyager JS skills** (57 skills, run in vm sandbox):
- Crafting: `craftWoodenPickaxe`, `craftIronPickaxe`, `craftCraftingTable`, `craftFurnace`, `craftChest`, `craftBucket`, and more
- Mining: `mineWoodLog`, `mineFiveCoalOres`, `mineFiveIronOres`, `mineTenCobblestone`, and more
- Smelting: `smeltFiveRawIron`, `smeltRawCopper`, and more
- Combat: `killOnePig`, `killOneZombie`, `killFourSheep`, and more
- Gathering: `collectBamboo`, `collectFiveCactusBlocks`, `fillBucketWithWater`

**Dynamic skill generation:** Bots can generate new JS skills at runtime when existing skills don't cover a task. Generated skills are saved to `skills/generated/` and reused.

### Persistent Memory

Each bot has its own memory file (e.g. `memory-atlas.json`, `memory-forge.json`):
- **Structures:** Location and type of every house/farm/furnace/mine built
- **Deaths:** Last 50 deaths with location and cause
- **Ore discoveries:** Locations of found ore veins
- **Skill history:** Success rate and average duration for every skill
- **Season goal:** Long-term mission set via `!goal set <text>` in-game
- **Broken skills:** Dynamic skills with 5+ failures permanently blocked

### Neural Combat

A Python TCP server (`neural_server.py`) on port 12345 responds to combat observations with: `attack`, `strafe_left`, `strafe_right`, `flee`, `use_item`, or `idle`.

Combat ticks run at 50ms intervals for up to 10 seconds per engagement. If the neural server is unreachable, bots fall back to `mineflayer-pvp`. Blade is the primary combat bot but all bots can flee from threats.

### Live Streaming

- **Mission Control** — All-bot dashboard at `http://localhost:3010`
- **Per-bot 3D viewers** — prismarine-viewer with follow/first-person/orbit camera modes
- **OBS overlays** — Per-bot WebSocket overlay showing health, food, position, inventory, thought, action
- **TTS** — Bot thoughts converted to speech and played through overlay
- **Twitch integration** — Reads Twitch chat; viewers can interact with the bots

### Self-Improvement Loop

The team measures and improves itself across sessions:

- **Scoreboard** (`logs/sessions/<id>.json`): per-bot success rates, deaths, stash throughput, and tech-tree milestone timestamps (first log → first tool → first iron...). Compare sessions to see whether a code change helped — and revert it if not.
- **Skill curation**: skill success rates are aggregated team-wide. Skills with ≥8 real (non-precondition) failures and <10% success are retired; the prompt's skill list is ranked and annotated (`setup_stash (67% of 27)`) so the LLM prefers what works.
- **Tech-tree curriculum**: every strategic prompt includes the bot's current tech stage and a concrete next step computed from its real inventory.
- **Skill refinement** (Voyager-style): a dynamic skill that fails with a code error gets its source + error fed back to the LLM for a fixed version (old kept as `.bak`, 2 attempts/session).
- **Fine-tuning pipeline** (`finetune/`): every strategic decision is logged (exact prompt → decision → outcome) to `logs/trajectories/`. `scripts/extract-finetune-dataset.mjs` turns successful trajectories into a chat-format dataset, and `finetune/train_lora.py` LoRA-tunes Qwen3-8B on the team's own gameplay — see `finetune/README.md` for the overnight recipe.

### Safety

All chat messages and bot thoughts are filtered:
- Blocks harmful/inappropriate content
- Detects and sanitizes prompt injection attempts from player chat
- Viewer messages filtered separately with tighter rules

---

## Project Structure

```
mineflayer-chatgpt/
├── src/
│   ├── bot/
│   │   ├── index.ts         # Bot lifecycle (connection, spawn safety)
│   │   ├── brain.ts         # Event-driven decision engine
│   │   ├── scoreboard.ts    # Session metrics + tech milestones
│   │   ├── curriculum.ts    # Tech-tree next-goal proposal
│   │   ├── trajectory.ts    # Fine-tuning data capture
│   │   ├── navigation.ts    # safeGoto, drop collection, movements
│   │   ├── actions.ts       # Action implementations
│   │   ├── perception.ts    # World context builder
│   │   ├── memory.ts        # Per-bot persistent memory (BotMemoryStore)
│   │   ├── memory-registry.ts # Bot → memory store mapping
│   │   ├── role.ts          # BotRoleConfig + all 5 bot configs
│   │   └── bulletin.ts      # Team bulletin (shared status)
│   ├── llm/
│   │   └── index.ts         # Ollama client + JSON repair + system prompt
│   ├── skills/
│   │   ├── executor.ts      # Skill runner (abort support)
│   │   ├── reliability.ts   # Team-wide skill stats + retirement
│   │   ├── generator.ts     # Dynamic skill generator
│   │   ├── dynamic-loader.ts# Voyager vm sandbox
│   │   ├── registry.ts      # Skill registration
│   │   ├── stash.ts         # Deposit/withdraw stash actions
│   │   ├── setup-stash.ts   # Bootstrap shared chest area
│   │   ├── build-house.ts
│   │   ├── build-farm.ts
│   │   ├── build-bridge.ts
│   │   ├── craft-gear.ts
│   │   ├── go-fishing.ts
│   │   ├── light-area.ts
│   │   ├── smelt-ores.ts
│   │   └── strip-mine.ts
│   ├── neural/
│   │   ├── bridge.ts        # TCP client for neural server
│   │   └── combat.ts        # 50ms tick combat loop
│   ├── stream/
│   │   ├── viewer.ts        # Per-bot prismarine-viewer
│   │   ├── viewer-client.html # 3D viewer with camera modes
│   │   ├── overlay.ts       # Per-bot OBS WebSocket overlay
│   │   ├── dashboard.ts     # Mission Control server
│   │   └── tts.ts           # Text-to-speech
│   ├── safety/
│   │   └── filter.ts        # Content safety filter
│   ├── config.ts            # Env-based config
│   └── index.ts             # Entry point — launches all bots
├── dashboard/
│   └── index.html           # Mission Control frontend
├── overlay/
│   └── index.html           # OBS overlay frontend
├── skills/
│   ├── voyager/             # 57 Voyager-style JS skills
│   └── generated/           # LLM-generated skills (runtime)
├── finetune/                # LoRA fine-tuning pipeline (see finetune/README.md)
├── scripts/                 # Dataset extraction, skill downloads
├── logs/
│   ├── sessions/            # Scoreboard JSON per session (git-ignored)
│   └── trajectories/        # Fine-tuning data JSONL (git-ignored)
├── neural_server.py         # Python combat policy server
├── memory-atlas.json        # Atlas memory (git-ignored)
├── memory-flora.json        # Flora memory (git-ignored)
├── memory-forge.json        # Forge memory (git-ignored)
├── memory-mason.json        # Mason memory (git-ignored)
├── memory-blade.json        # Blade memory (git-ignored)
└── .env                     # Local config (git-ignored)
```

---

## Known Issues

| Issue | Status |
|-------|--------|
| Ollama JSON-schema `format` ignored | qwen3.6 on ollama 0.20.x returns prose for schema-constrained requests; plain `format:"json"` works (used). Re-test after upgrading ollama |
| Pathfinder timeouts on some goals | Bots recover via critic re-plan, but turns are wasted |
| Farms unbuilt unless water is near | `build_farm` needs water within range of the village site |
| Neural combat untested in survival | Server is implemented and running; needs hostile mob environment |
| Generated skills may fail on first run | Mitigated: code-error failures now trigger automatic LLM refinement |

---

## Development

```bash
npm run dev     # Run with tsx watch (hot reload)
npm test        # Run tests
npm run build   # Compile TypeScript
```

### Adding a New TypeScript Skill

1. Create `src/skills/my-skill.ts` implementing `async function mySkill(bot: Bot): Promise<string>`
2. Register it in `src/skills/registry.ts`
3. Add it to the appropriate bot's `allowedSkills` in `src/bot/role.ts`

### Adding a Voyager Skill

Drop a `.js` file into `skills/voyager/`. The function name must match the filename (camelCase). It will be loaded automatically by the dynamic loader.

### Adding a New Bot

1. Add a new `BotRoleConfig` in `src/bot/role.ts` with personality, allowed actions/skills, leash radius
2. Add the config to the bot roster array in `src/index.ts`
3. Add `MC_USERNAME_N` to `.env`
4. Increment `BOT_COUNT`

---

## Credits

- Original mineflayer-chatgpt by Jesse Weigel
- Voyager skill library from [MineDreamer/Voyager](https://github.com/MineDreamer/Voyager)
- Autonomous agent architecture, neural combat, multi-bot team system, and streaming features added in 2024-2026
