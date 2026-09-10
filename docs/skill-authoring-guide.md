# Skill authoring guide

A skill turns one high-level action into deterministic Mineflayer operations. Start with a
TypeScript skill when you want typed parameters, progress updates, and cooperative cancellation.
Voyager and generated skills are JavaScript functions adapted to the same runtime registry.

## The TypeScript contract

Read [`Skill`, `SkillResult`, and `SkillProgress`](../src/skills/types.ts) before starting.
A built-in skill exports a **`Skill` object**, not a function returning a string:

- `name`: the unique action name, conventionally `snake_case`.
- `description` and `params`: information for the LLM prompt. Each parameter has a `type` and
  `description`; these descriptors are not runtime validation. Validate values in your skill.
- `estimateMaterials(bot, params)`: item names and counts for the executor's gathering phase.
  Return `{}` when no gathering is needed. Only request materials the gathering implementation
  supports; see [`materials.ts`](../src/skills/materials.ts).
- `execute(bot, params, signal, onProgress): Promise<SkillResult>`: do the work without LLM calls.
  Return `{ success, message }`, optionally with numeric `stats`. Expected failures should explain
  what is missing or what the bot can try next.
- Optional `timeoutMs`: the execution watchdog budget, normally 240,000 ms. Increase it only for a
  genuinely longer journey whose individual operations are also bounded.

[`runSkill`](../src/skills/executor.ts) gathers materials, calls `execute`, reports progress,
records the outcome, and returns a message to the action dispatcher. Execution progress is remapped
from your 0–1 range into the final 70% of the overall progress bar.

### Cancellation and cleanup

Check `signal.aborted` before acting, after awaited operations, and inside loops. Return an
unsuccessful result when interrupted. A signal is cooperative: it does not automatically cancel
`bot.dig`, a timer, or a pathfinder promise. Release listeners, timers, movement controls, and other
resources your skill owns in `finally` blocks. Do not leave work running after returning.

The executor's watchdog is a backstop, not a substitute for bounded operations. Prefer the shared
[`safeGoto`](../src/bot/navigation.ts) helper for navigation and give other potentially hanging
operations an explicit deadline with appropriate cleanup. An outer timeout can return control to
the brain without magically terminating every promise created inside a skill.

## Create a first skill

This small, read-only example counts an item already in inventory. It lets you exercise the full
interface without a server-side building setup. Create `src/skills/count-supplies.ts`:

```typescript
import type { Skill } from "./types.js";

export const countSuppliesSkill: Skill = {
  name: "count_supplies",
  description: "Count a named inventory item, such as oak_sapling, before planning work.",
  params: {
    item: { type: "string", description: "Exact Minecraft item name, for example oak_sapling" },
  },
  estimateMaterials: () => ({}),
  async execute(bot, params, signal, onProgress) {
    if (signal.aborted) return { success: false, message: "Inventory count interrupted." };
    const item = params.item;
    if (typeof item !== "string" || item.trim().length === 0) {
      return { success: false, message: "Provide an item name, such as oak_sapling." };
    }
    const count = bot.inventory.items()
      .filter((stack) => stack.name === item)
      .reduce((total, stack) => total + stack.count, 0);
    const message = `Inventory contains ${count} ${item}.`;
    onProgress({
      skillName: "count_supplies", phase: "Done", progress: 1, message, active: false,
    });
    return { success: true, message, stats: { count } };
  },
};
```

Counting zero items is a successful observation, not a crash. The example deliberately does not
request materials: a counting skill should not gather items to make its answer nonzero.

### Test it without a Minecraft server

Create `src/skills/count-supplies.test.ts`. Only the inventory surface needs a fake for this skill:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "mineflayer";
import type { SkillProgress } from "./types.js";
import { countSuppliesSkill } from "./count-supplies.js";

const bot = {
  inventory: {
    items: () => [
      { name: "oak_sapling", count: 3 },
      { name: "dirt", count: 20 },
      { name: "oak_sapling", count: 2 },
    ],
  },
} as unknown as Bot;

test("counts matching stacks and reports completion", async () => {
  const progress: SkillProgress[] = [];
  const result = await countSuppliesSkill.execute(
    bot, { item: "oak_sapling" }, new AbortController().signal, (p) => progress.push(p),
  );
  assert.equal(result.success, true);
  assert.equal(result.stats?.count, 5);
  assert.equal(progress.at(-1)?.active, false);
});

test("handles absent items, invalid input, and cancellation", async () => {
  const controller = new AbortController();
  const run = (item: unknown) => countSuppliesSkill.execute(
    bot, { item }, controller.signal, () => {},
  );
  assert.equal((await run("birch_sapling")).stats?.count, 0);
  assert.equal((await run(undefined)).success, false);
  controller.abort();
  assert.equal((await run("oak_sapling")).success, false);
});
```

Run the focused test with `node --import tsx --test src/skills/count-supplies.test.ts`, then
`npm run build` and `npm test` before opening a PR. For skills that change the world, also test
missing tools/materials, unreachable targets, rejected operations, and interruption between steps.
Finish with a real development-server check; fake inventory tests do not prove navigation or block
placement works in Minecraft.

## Register the skill and assign a role

In [`src/skills/registry.ts`](../src/skills/registry.ts), add an import beside the existing imports:

```typescript
import { countSuppliesSkill } from "./count-supplies.js";
```

Then add `register(countSuppliesSkill);` beside the other registrations. `register` is local to that
module. Check that your name is unique: registration uses `Map.set`, so a collision replaces an
existing entry rather than warning.

Add `"count_supplies"` to the appropriate `allowedSkills` list in
[`src/bot/role.ts`](../src/bot/role.ts), for example Flora's list. Role configuration supplies prompt
context and participates in the brain's action routing. Do not add a new skill to every role just
to make it selectable. Give it a description and parameter names the LLM can use unambiguously.

Restart the bot after adding the import and registration. `npm run dev` uses `tsx watch`, which
restarts the process; it is not granular skill reloading. The example is a tutorial to copy into
your branch, not a built-in action supplied by this guide.

## Voyager JavaScript skills and the VM context

Place a plain JavaScript file in `skills/voyager/`, for example `countOakSaplings.js`:

```javascript
async function countOakSaplings(bot) {
  const count = bot.inventory.items()
    .filter((item) => item.name === "oak_sapling")
    .reduce((total, item) => total + item.count, 0);
  bot.chat(`I have ${count} oak saplings.`);
}
```

Use a top-level named function matching the filename exactly. Do not use TypeScript, ESM imports,
or `export` statements: the loader evaluates the file as a VM script. The wrapper calls the
function with `bot` only; it does not pass your TypeScript parameter object, progress callback, or
abort signal. The JavaScript return value is ignored. Throw an error for a failed operation so the
wrapper can return an unsuccessful `SkillResult` rather than reporting completion.

[`dynamic-loader.ts`](../src/skills/dynamic-loader.ts) scans `.js` files in `skills/voyager/` and
then `skills/generated/`. Syntax errors are rejected at load time; the expected callable is checked
when executed. Startup calls `loadDynamicSkills()`. Adding a file does not itself create a watcher;
restart or explicitly reload through that loader. Avoid duplicate filenames across both directories
and built-in names because later entries overwrite registry keys.

Each execution gets a VM context containing `bot`, `Vec3`, `mcData`, `require`, console, timers,
and standard JavaScript objects. Voyager primitives such as `mineBlock`, `placeItem`, `craftItem`,
`smeltItem`, `killMob`, and `exploreUntil` are injected, followed by the Voyager helper bundle, so
skills can call library helpers. Inspect those implementations before depending on their arguments.
The wrapper also supplies compatibility shims for older Voyager calls.

**This VM is not a security boundary.** It exposes real bot capabilities and a require wrapper;
load only code you have reviewed and trust. Its asynchronous execution is raced against a
120-second watchdog, inside the regular skill executor. That timeout is not proof that all work or
timers created by a skill have stopped. Prefer TypeScript for operations that need explicit
cooperative cancellation and cleanup.

## Dynamically generated skills

The `generate_skill` action calls [`generateSkill(task)`](../src/skills/generator.ts), which:

1. Derives a camelCase name from the task and rejects an empty result.
2. Requests one JavaScript function from the configured Ollama model.
3. Strips Markdown fences, saves the function under `skills/generated/<name>.js`, and reloads
   dynamic skills into the registry.

Generated skills run through the same loader as Voyager files; generation is not a separate,
trusted execution mode. Saving a file does not prove it accomplishes the requested task. In
particular, the generator can save a chat-only fallback when the expected function signature is
missing. Inspect the code and exercise it before relying on it.

The [`invoke_skill` action path](../src/bot/actions.ts) can request refinement after a code-error
failure. [`refineSkill`](../src/skills/generator.ts) limits attempts to two per skill per process,
looks for generated code before Voyager code, and reloads the replacement. This is a recovery
mechanism, not a replacement for tests of a contributed skill.

## Practical Mineflayer tips

- Use `bot.inventory.items()` and check the result of `find` before `bot.equip(item, "hand")`.
  Match Minecraft item names rather than display names, and account for multiple stacks.
- Check `bot.blockAt(position)` for `null`: the relevant chunk may not be loaded. Recheck the world
  after travel instead of assuming a block observed earlier is still there.
- Prefer shared navigation helpers. Avoid an unbounded `pathfinder.goto`; use an appropriate goal
  and deadline, and stop only movement your operation still owns.
- For placement, verify the support block and empty destination, equip the right item, and await
  the Mineflayer operation. Handle failure explicitly instead of claiming a completed structure.
- Keep work finite and resumable. Report partial progress accurately if materials run out or an
  action is interrupted. Avoid commands that grant items or teleport bots to bypass the task.
- Read [`build-farm.ts`](../src/skills/build-farm.ts) for a multi-phase example,
  [`materials.ts`](../src/skills/materials.ts) for gathering capabilities, and
  [Mineflayer's API reference](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md)
  for operation arguments. Check APIs against the version installed in your checkout.


## Generated skills are a separate security domain

Files in `skills/voyager/` are authored, reviewed code. They retain the existing
Mineflayer-compatible API and trusted in-process loader. Do not put model output
there.

Model-generated and refined code uses the narrow `api.observe`, `api.navigate`,
`api.mine`, `api.craft`, `api.equip`, `api.consume`, `api.place`, `api.look`,
`api.attack`, and `api.wait` interface. It is stored as an inert candidate and
cannot replace an authored or built-in skill name. Verification runs exact
candidate bytes in the OS sandbox, and promotion requires the candidate ID plus
the exact SHA-256. Runtime also rechecks the current successful verification and
sandbox-policy fingerprint before every execution.

Generated execution is disabled by default and fails closed without Linux x64,
Bubblewrap, `prlimit`, and the configured Node executable. Operators must run
the separate, fail-closed `npm run test:sandbox` preflight before enabling it. Generation and refinement never promote, rewrite an
authored skill, or hot reload a candidate. Restart the application after an
operator promotes or rolls back an approved generated skill.


A capability timeout ends the invocation and rejects further capability calls,
even if generated code catches the timeout. Cancellation stops supported local
movement and digging operations. Already-issued Minecraft server actions, such
as placement, consumption or crafting, cannot be rolled back by terminating a
worker; operators must account for those effects when reviewing a candidate.
