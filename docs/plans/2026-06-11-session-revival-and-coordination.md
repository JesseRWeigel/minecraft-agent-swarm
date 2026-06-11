# 2026-06-11 — Session: CI fix, environment revival, team coordination

Goal: get the project working again after ~6 weeks idle, fix the failing GitHub
run, modernize models/deps, and get the bot team visibly accomplishing things.

## Successes

### 1. CI fixed (main is green again)
- Root cause: PR #21 (unit tests) and PR #22 (Prettier config) merged in
  parallel — four test files were never formatted with the new config, so the
  `format:check` step failed on every push since the merge.
- Also bumped `actions/checkout` and `actions/setup-node` to v5 ahead of the
  June 16 Node-20 runner deprecation.

### 2. The "broken project" was mostly a VRAM squatter
- A forgotten ComfyUI instance (running since the day before, port 8188) held
  **21 GB of the RTX 5090's 32 GB**. Ollama fell back to 70% CPU and
  `qwen3:32b` generated at **4 tok/s** — decisions took up to 2 minutes, which
  reads as "bots are brain-dead."
- After freeing VRAM: `qwen3:32b` 65 tok/s, `qwen3.6:35b-a3b` **147 tok/s**,
  `qwen3:8b` 211 tok/s.

### 3. Model modernization — one MoE for everything
- Switched both `OLLAMA_MODEL` and `OLLAMA_FAST_MODEL` to `qwen3.6:35b-a3b`
  (MoE, ~3B active params). Faster than the old dense-32b strategic path AND
  smarter than the old 8b reactive path.
- Two models don't fit in 32 GB together (MoE alone reserves 26-27 GB); a
  single resident model eliminates 3-13s eviction/reload thrash per swap.
- Added `format: "json"` to all decision-path Ollama calls — kills the
  malformed-JSON failure class. NOTE: full JSON-schema constrained output is
  silently ignored for qwen3.6 on ollama 0.20.2 (returns prose).

### 4. Team coordination bugs fixed (observed live, then fixed)
Observed a full 5-bot session before changing anything. Failure patterns:
- `stashPos` was `undefined` for every bot → every `deposit_stash` failed and
  `setup_stash` got hallucinated coordinates. Fix: shared `STASH_POS` constant;
  brain injects real coords into `setup_stash`.
- **Capability deadlock**: Mason's #1 priority needs logs, but no action he was
  allowed to use could produce logs. Fix: Mason gets `gather_wood`.
- Bots couldn't hear each other (all bot chat filtered) — Mason literally asked
  Flora for planks and she never received it. Fix: bots hear teammates who
  address them **by name**, 45s per-sender cooldown to prevent loops.
- LLM kept emitting param-less actions (`place_block` with no blockType,
  `chat` with no message → said "undefined" in game). Fix: per-action param
  signatures in the strategic prompt + hard errors instead of garbage output.
- `setup_stash` now ground-snaps Y so chests don't float/bury.

### 5. Dependency updates + a phantom dependency unmasked
- `npm update`: mineflayer 4.34→4.37.1, custom-pvp 1.7.16, tooling bumps.
- This **broke craft**: `minecraft-data` was imported directly but never
  declared in package.json. The update re-hoisted node_modules and the root
  copy became the ancient 2.221.0 (from mineflayer-trajectories), which
  doesn't know MC 1.21.4 → `Cannot read properties of null (itemsByName)`.
  Fix: declare `minecraft-data@^3.110.2` explicitly.

## Failures / open issues
- Ollama 0.20.2 + qwen3.6: JSON-schema `format` silently ignored (prose
  comes back). Plain `format:"json"` works. Re-test after ollama upgrade —
  schema mode would let us constrain `action` to an enum of allowed actions.
- Pathfinder still times out on some goals ("Navigation timed out") — bots
  recover via critic re-plan, but it wastes turns.
- Dynamic skill `collectBamboo` hit the minecraft-data null too (fixed by the
  phantom-dep fix).

## Experiment log
- **Run 1** (old code, 5 bots): bots role-play well, Forge mines, Atlas
  explores, but stash coordination 100% broken; Mason deadlocked; bot-to-bot
  chat unheard.
- **Run 2** (coordination fixes): aborted early — dep update broke craft
  mid-run (phantom dep).
- **Run 3** (all fixes): clean start, wiped bot playerdata + inventories.
  Season goal injected via temporary "Director" connection using `!goal set`:
  *"Build a village at The Stash (286, 70, -314): stash chests, a wood house,
  a wheat farm, torches at night, stock the stash, defend the site."*

- **Run 3 result (~15 min)**: net team assets were 3 logs + 12 dirt. Bots
  role-played beautifully but produced almost nothing. Ground-truth inventory
  check via RCON (`data get entity <bot> Inventory`) exposed the root cause:

### 6. THE big one — bots never picked up their drops
`gather_wood` / `mine_block` / build-skill material gathering all did
`bot.dig(block)` and reported success immediately. The drop stayed on the
ground. Bots "gathered 5 logs" with empty inventories, then every craft
failed, and the LLM reasoned correctly from false observations — which looks
exactly like "the bot is dumb." Fixed with `collectNearbyDrops()` (walk to
item entities after digging) + inventory-delta verification in gather_wood.
`mineflayer-collectblock` was in package.json all along but never loaded.

- **Run 4**: drop collection v1 still failed ("Chopped 5 logs but couldn't
  pick up the drops") — the collector gave up on ALL drops at the first
  unreachable one, and chased drops that were still falling. The new honest
  result message made the failure visible immediately, which v1's
  predecessor ("Gathered 5 logs!") had been hiding all along.
- **Drop collection v2**: per-drop retry with a tried-set, 800ms settle
  delay, GoalBlock (stand ON the drop) instead of GoalNear r=1. Verified
  live with a probe bot + RCON-summoned drops: **5/6 collected** (v1: 0/6).
- **Run 5**: wood pickup confirmed live ("Atlas: Gathered 5 logs" → 16
  oak_planks in real inventory). New problem class exposed: **Forge
  strip-mined the village site into pits and Mason fell in and was
  permanently stuck** — safeMoves can neither dig nor tower, so every go_to
  failed forever.
- **Fixes**: go_to rescue retry (dig + 1x1 towers when safe movement finds
  no path); mine_block refuses blocks within 12 of The Stash; RCON-filled
  the existing pits.
- **Run 6 — the breakthrough run**: full economy chain worked end to end:
  logs → planks → sticks → crafting table → **wooden pickaxe + axe**
  (first tools ever), house built to 76/174 blocks ("It has... character"),
  and Mason **deposited 17 items at the stash chest**. Bot-to-bot name
  mentions and viewer steering (Director chat) both functioned.
- Remaining LLM weakness: Mason never chose setup_stash on his own (placed
  chests by hand instead). Added a deterministic stash-bootstrap override in
  the brain — same pattern as the leash override.
- **Run 7**: all fixes live; merged to main and pushed (CI green).

## Recommendations for Jesse
- Upgrade Ollama (needs sudo): `curl -fsSL https://ollama.com/install.sh | sh`
  (0.20.2 → 0.30.x). Then re-test JSON-schema outputs; if fixed, constrain
  `action` to each bot's allowlist enum and delete a whole class of prompt
  nudging.
- ComfyUI was stopped this session to free 21 GB VRAM — restart it if needed,
  but don't leave it running while bots stream.

(continued below as the session progresses)
