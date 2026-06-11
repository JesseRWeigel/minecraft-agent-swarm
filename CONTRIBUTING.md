# Contributing to Atlas — Autonomous AI Minecraft Bot Team

Thanks for your interest in contributing! This guide will help you get started.

## Getting Started

### Prerequisites

- Node.js 20+
- [Ollama](https://ollama.ai) with `qwen3.6:35b-a3b` pulled (or any compatible model)
- A Minecraft Java Edition server (1.21.4) — [Aternos](https://aternos.org) works for testing
- Python 3.10+ (only needed for neural combat features)

### Setup

```bash
git clone https://github.com/JesseRWeigel/mineflayer-chatgpt.git
cd mineflayer-chatgpt
npm install
cp .env.example .env   # then edit .env with your server details
```

### Development

```bash
npm run dev     # Run with hot reload
npm test        # Run tests
npm run build   # Type-check and compile
```

## How to Contribute

### Reporting Bugs

Open an issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your environment (OS, Node version, Minecraft version)

### Suggesting Features

Open an issue describing the feature and why it would be useful. Check existing issues first to avoid duplicates.

### Submitting Code

1. **Find an issue** — Look for issues labeled `good first issue` or `help wanted`, or open a new issue describing what you want to work on.

2. **Fork and branch** — Create a branch from `main` using this naming convention:
   - `feat/short-description` — new features
   - `fix/short-description` — bug fixes
   - `docs/short-description` — documentation
   - `test/short-description` — adding or fixing tests
   - `refactor/short-description` — code cleanup

3. **Make your changes** — Keep PRs focused on a single concern. If you find unrelated issues along the way, open a separate PR for those.

4. **Write tests** — If you're adding or changing functionality, add tests. We use Node.js built-in test runner (`node:test`).

5. **Make sure CI passes** — Before submitting:
   ```bash
   npm run build   # Must compile without errors
   npm test        # Must pass
   ```

6. **Open a PR** — Target the `main` branch. Include:
   - A clear description of what changed and why
   - Reference any related issues (e.g., "Closes #12")
   - Screenshots or logs if relevant

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add bed-sleeping skill for Flora
fix: prevent pathfinder timeout in strip mine
docs: add skill authoring guide
test: add unit tests for perception module
refactor: extract chest-finding logic from stash actions
chore: update mineflayer to 4.35.0
```

- Use imperative mood ("add" not "added")
- Keep the first line under 72 characters
- Add a body if the "why" isn't obvious from the subject line

## Code Style

- TypeScript with strict mode
- ESM modules (`import`/`export`, not `require`)
- Async/await over raw promises
- Descriptive variable names — the code should read clearly without excessive comments

## Project Structure at a Glance

| Directory | What lives there |
|-----------|-----------------|
| `src/bot/` | Core bot logic — decision loop, actions, perception, memory, roles |
| `src/llm/` | Ollama client, prompt templates, JSON parsing |
| `src/skills/` | TypeScript skills, Voyager loader, skill generator |
| `src/neural/` | Neural combat bridge and tick loop |
| `src/stream/` | Dashboard, viewers, overlays, TTS |
| `src/safety/` | Content filtering |
| `skills/voyager/` | 57 Voyager-style JS skills (run in VM sandbox) |
| `skills/generated/` | LLM-generated skills (created at runtime) |
| `dashboard/` | Mission Control frontend |
| `overlay/` | OBS overlay frontend |

See the [README](README.md) for full architecture details.

## Adding a New Skill

This is one of the easiest ways to contribute:

1. Create `src/skills/my-skill.ts` exporting an async function: `async function mySkill(bot: Bot): Promise<string>`
2. Register it in `src/skills/registry.ts`
3. Add it to the appropriate bot's `allowedSkills` in `src/bot/role.ts`
4. Add a test in `src/skills/my-skill.test.ts`

## Review Process

- All PRs are reviewed by the maintainer ([@JesseRWeigel](https://github.com/JesseRWeigel))
- Be patient — this is a solo-maintained project
- You may be asked to make changes; that's normal and not a reflection on the quality of your work
- Once approved, the maintainer will merge your PR

## Questions?

Open an issue or start a discussion. There are no bad questions — we'd rather help you contribute than have you stuck in silence.
