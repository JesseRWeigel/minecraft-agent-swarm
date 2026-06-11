> **Historical document** — this was the original 2026-02 upgrade plan. It has been largely implemented (and exceeded); see README.md for the current architecture and `docs/plans/` for session logs.

# Mineflayer AI Bot - Upgrade Plan

## Vision
Transform this from a simple ChatGPT-powered Minecraft chatbot into a **fully autonomous AI Minecraft player that livestreams 24/7 on Twitch/YouTube**, powered by a local LLM running on an RTX 5090, with real-time chat interaction.

## Current State
- Basic Mineflayer bot that responds to in-game chat via OpenAI API
- Single `index.js` file
- Uses `openai` npm v3 (outdated)
- No game autonomy — only responds to chat messages
- No streaming, no local LLM support

---

## Phase 1: Local LLM + Modern Architecture (Week 1)

### 1.1 Replace OpenAI with Local LLM via Ollama
- [ ] Install Ollama and pull recommended models:
  - Primary: `qwen3:32b-q4_K_M` (~19GB VRAM, ~61 tok/s on 5090)
  - Fast fallback: `mistral-small3:24b-q4_K_M` (~15GB VRAM, ~80 tok/s)
  - Ultra-fast: `llama3.1:8b` (~16GB VRAM FP16, ~213 tok/s)
- [ ] Create an LLM abstraction layer supporting both Ollama and OpenAI APIs
- [ ] Implement function calling / tool use for structured game commands
- [ ] Add system prompt with Minecraft knowledge and bot personality

### 1.2 Project Restructure
```
mineflayer-chatgpt/
├── src/
│   ├── bot/
│   │   ├── index.ts          # Bot initialization and lifecycle
│   │   ├── actions.ts        # Minecraft actions (mine, build, fight, etc.)
│   │   ├── perception.ts     # World state reading (nearby blocks, entities, etc.)
│   │   └── goals.ts          # Autonomous goal system
│   ├── llm/
│   │   ├── index.ts          # LLM abstraction layer
│   │   ├── ollama.ts         # Ollama backend
│   │   ├── openai.ts         # OpenAI backend (fallback)
│   │   ├── prompts.ts        # System prompts and templates
│   │   └── tools.ts          # Function/tool definitions for the LLM
│   ├── stream/
│   │   ├── twitch.ts         # Twitch chat via tmi.js
│   │   ├── youtube.ts        # YouTube chat via masterchat
│   │   ├── chatRouter.ts     # Message queue, rate limiting, selection
│   │   └── obs.ts            # OBS WebSocket control
│   ├── tts/
│   │   └── index.ts          # Text-to-speech for voice output
│   ├── safety/
│   │   └── contentFilter.ts  # Content filtering for livestream safety
│   └── index.ts              # Main entry point
├── config/
│   ├── bot.json              # Bot personality, model selection
│   └── stream.json           # Twitch/YouTube/OBS config
├── package.json
└── tsconfig.json
```

### 1.3 Migrate to TypeScript
- [ ] Convert `index.js` to TypeScript
- [ ] Add proper types for Mineflayer, LLM responses, chat events
- [ ] Set up build pipeline (tsup or esbuild)

### 1.4 Update Dependencies
- [ ] Update `mineflayer` to latest
- [ ] Replace `openai` v3 with Ollama HTTP client (or keep as fallback)
- [ ] Remove `axios` (use native fetch)
- [ ] Add `tmi.js`, `@stu43005/masterchat`, `obs-websocket-js`

---

## Phase 2: Autonomous Gameplay (Week 1-2)

### 2.1 World Perception System
- [ ] Nearby block scanning (what's around the bot)
- [ ] Entity awareness (players, mobs, animals)
- [ ] Inventory tracking
- [ ] Health/hunger/time-of-day awareness
- [ ] Death detection and respawn handling

### 2.2 Goal System
The LLM decides high-level goals. Mineflayer executes low-level actions.
```
LLM decides: "I should build a shelter before nightfall"
  → Goal: BUILD_SHELTER
    → Sub-goals: gather wood → craft planks → craft door → place blocks
      → Mineflayer actions: pathfind, dig, place, craft
```

- [ ] Implement goal queue (prioritized list of things to do)
- [ ] Survival basics: eat when hungry, sleep at night, fight when attacked
- [ ] Resource gathering: mine, chop trees, farm
- [ ] Building: simple structures from LLM-generated plans
- [ ] Exploration: explore new areas, remember visited locations
- [ ] Combat: fight mobs, flee when low health

### 2.3 LLM Tool Definitions
Define tools the LLM can call:
```typescript
const tools = [
  { name: "mine_block", params: { blockType: "string" } },
  { name: "go_to", params: { x: "number", y: "number", z: "number" } },
  { name: "craft_item", params: { item: "string", count: "number" } },
  { name: "build_structure", params: { description: "string" } },
  { name: "attack_entity", params: { entityName: "string" } },
  { name: "say_in_chat", params: { message: "string" } },
  { name: "equip_item", params: { item: "string" } },
  { name: "eat_food", params: {} },
  { name: "sleep", params: {} },
  { name: "explore", params: { direction: "string" } },
];
```

### 2.4 Memory System
- [ ] Short-term: current context (last 5 minutes of events)
- [ ] Long-term: persistent storage of discoveries, deaths, builds (JSON file or SQLite)
- [ ] The bot should remember: where it built things, where it died, what it learned

---

## Phase 3: Livestream Integration (Week 2-3)

### 3.1 Twitch Chat Integration
- [ ] Connect via `tmi.js` (anonymous read + authenticated write)
- [ ] Message queue: aggregate chat messages every 5-10 seconds
- [ ] Command system:
  - `!goal <description>` — suggest a new goal for the bot
  - `!vote 1/2/3` — vote on choices the bot presents
  - `!name <name>` — name the bot's next pet/tool/build
  - `!status` — bot reports current goal and stats
  - Regular chat messages — bot can respond conversationally

### 3.2 YouTube Chat Integration
- [ ] Connect via `@stu43005/masterchat` (no API key needed)
- [ ] Same message queue and command system as Twitch
- [ ] Super Chat detection for priority messages

### 3.3 Chat-Driven Gameplay
- [ ] Bot periodically presents choices to chat: "Should I explore the cave or build a farm? Vote !1 or !2"
- [ ] Popular vote wins after 30-second window
- [ ] High-engagement moments: boss fights, nether portal, ender dragon
- [ ] Chat can override bot's current goal with enough votes

### 3.4 OBS Integration
- [ ] Connect via `obs-websocket-js` (OBS WebSocket API v5)
- [ ] Scene switching: "gameplay", "death screen", "building montage"
- [ ] Overlays: current goal, chat commands, bot stats (health, level, inventory)
- [ ] Auto-start stream on bot launch

### 3.5 Text-to-Speech
- [ ] Local TTS engine (Piper TTS — fast, free, runs on CPU)
- [ ] Bot speaks its thoughts and responses aloud
- [ ] Different voice for reading chat messages vs. bot thoughts
- [ ] Volume ducking during intense gameplay

---

## Phase 4: 24/7 Reliability (Week 3)

### 4.1 Process Management
- [ ] PM2 configuration for auto-restart on crash
- [ ] Watchdog monitoring:
  - Is Ollama responding?
  - Is Mineflayer connected?
  - Is OBS streaming?
  - Is Twitch chat connected?
- [ ] Auto-reconnect logic for each component
- [ ] Graceful degradation: if LLM is slow, bot falls back to basic survival

### 4.2 Content Safety (CRITICAL)
- [ ] System prompt: strong instructions against harmful, political, sexual content
- [ ] Keyword/regex blocklist for output (before TTS and chat)
- [ ] Rate limiting on chat responses
- [ ] Moderation of incoming chat commands
- [ ] Log all LLM outputs for review
- [ ] Emergency "safe mode" — bot goes silent and just plays if filter triggers

### 4.3 Monitoring & Alerts
- [ ] Discord webhook for alerts (bot crashed, stream went down, safety trigger)
- [ ] Dashboard showing uptime, current status, recent events
- [ ] Log rotation to prevent disk fills

---

## Phase 5: Content & Growth (Week 4+)

### 5.1 Stream Polish
- [ ] Custom OBS overlays with bot status panel
- [ ] Highlight reel auto-detection (deaths, achievements, funny moments)
- [ ] Auto-clip creation for social media
- [ ] Title card / intro sequence

### 5.2 Social Content
- [ ] Auto-post highlight clips to Twitter/TikTok/YouTube Shorts
- [ ] "AI plays Minecraft" compilation videos
- [ ] Behind-the-scenes: how the AI works (dev stream content)

### 5.3 README & Documentation
- [ ] GIFs/video of the bot in action
- [ ] Architecture diagram
- [ ] Setup guide for others to run their own AI Minecraft streamer
- [ ] "Powered by RTX 5090" — hardware showcase angle

---

## Hardware Requirements (RTX 5090 Setup)

### VRAM Budget (32 GB)
| Component | VRAM |
|-----------|------|
| LLM (Qwen3 32B Q4_K_M) | ~19-20 GB |
| NVENC encoding (OBS) | ~0.3-0.5 GB |
| Minecraft client (spectator) | ~1-2 GB |
| KV cache overhead | ~1-3 GB |
| **Total** | **~22-26 GB** |

### System RAM: 32 GB minimum, 64 GB recommended
### CPU: 8+ core modern processor
### Storage: 100 GB free (models + Minecraft world + logs)
### Power: 1000W+ PSU (5090 draws up to 575W)
### Cooling: Ensure sustained GPU temps stay below 80C

### Software Stack
| Component | Tool |
|-----------|------|
| LLM Engine | Ollama |
| Model | Qwen3 32B Q4_K_M (or Mistral Small 3) |
| Bot Framework | Mineflayer |
| MC Server | Paper MC (local) |
| Streaming | OBS Studio (NVENC) |
| Twitch Chat | tmi.js |
| YouTube Chat | @stu43005/masterchat |
| TTS | Piper TTS |
| Process Mgmt | PM2 |
| Display | Xvfb (headless) or dummy HDMI plug |

---

## Stretch Goals
- [ ] Multi-bot: run 2-3 AI bots that talk to each other
- [ ] Viewer-controlled bot: chat has full control of a second bot
- [ ] Minecraft modded servers (with mods like Create, Botania)
- [ ] Cross-game: same AI personality plays different games
- [ ] Fine-tune a model on Minecraft gameplay data (like Mindcraft's Andy models)
