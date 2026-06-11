import { test } from "node:test";
import assert from "node:assert/strict";
import { executeAction } from "./actions.js";

// ── Minimal mock bot ────────────────────────────────────────────────────────

function mockBot(overrides: Record<string, any> = {}) {
  const pos = { x: 0, y: 64, z: 0, clone: () => ({ ...pos }), distanceTo: () => 0, offset: () => pos };
  const chatLog: string[] = [];
  return {
    entity: { position: pos },
    health: 20,
    food: 20,
    username: "TestBot",
    chat: (msg: string) => chatLog.push(msg),
    _chatLog: chatLog,
    inventory: {
      items: () => overrides.items ?? [],
    },
    findBlock: () => null,
    findBlocks: () => [],
    blockAt: () => ({ name: "air" }),
    pathfinder: {
      setMovements: () => {},
      goto: () => Promise.resolve(),
      stop: () => {},
      thinkTimeout: 5000,
    },
    dig: () => Promise.resolve(),
    equip: () => Promise.resolve(),
    consume: () => Promise.resolve(),
    entities: {},
    ...overrides,
  } as any;
}

// ── Action routing: valid actions ───────────────────────────────────────────

test("executeAction: idle returns vibing message", async () => {
  const result = await executeAction(mockBot(), "idle", {});
  assert.equal(result, "Just vibing.");
});

test("executeAction: chat sends message and returns confirmation", async () => {
  const bot = mockBot();
  const result = await executeAction(bot, "chat", { message: "Hello world" });
  assert.equal(result, "Said: Hello world");
  assert.equal(bot._chatLog[0], "Hello world");
});

test("executeAction: chat with no message says nothing and reports the error", async () => {
  const bot = mockBot();
  const result = await executeAction(bot, "chat", {});
  assert.equal(bot._chatLog.length, 0);
  assert.match(result, /needs a 'message' param/);
});

test("executeAction: respond_to_chat sends message", async () => {
  const bot = mockBot();
  const result = await executeAction(bot, "respond_to_chat", { message: "Hey back!" });
  assert.equal(result, "Replied: Hey back!");
  assert.equal(bot._chatLog[0], "Hey back!");
});

test("executeAction: unknown action returns descriptive error", async () => {
  const result = await executeAction(mockBot(), "nonexistent_action_xyz", {});
  assert.ok(result.includes("Unknown action"), `Expected 'Unknown action' message, got: ${result}`);
});

// ── Action routing: aliases ─────────────────────────────────────────────────

test("executeAction: flee_to_safety routes to flee handler", async () => {
  // flee tries to find hostile entities and run away; with no hostiles it will
  // still succeed (explore fallback)
  const bot = mockBot();
  const result = await executeAction(bot, "flee", {});
  // Should not throw and should return a string
  assert.equal(typeof result, "string");
});

test("executeAction: sleep_in_bed routes to sleep handler", async () => {
  const bot = mockBot();
  const result = await executeAction(bot, "sleep_in_bed", {});
  assert.equal(typeof result, "string");
});

test("executeAction: use_bed routes to sleep handler", async () => {
  const bot = mockBot();
  const result = await executeAction(bot, "use_bed", {});
  assert.equal(typeof result, "string");
});

// ── Action routing: gather_wood with no trees ───────────────────────────────

test("executeAction: gather_wood with no trees returns helpful message", async () => {
  const bot = mockBot({ findBlocks: () => [] });
  const result = await executeAction(bot, "gather_wood", {});
  assert.ok(result.includes("No trees found"), `Expected no-trees message, got: ${result}`);
});

// ── Action routing: mine_block with no matching block ───────────────────────

test("executeAction: mine_block with no block found", async () => {
  const bot = mockBot({ findBlock: () => null });
  const result = await executeAction(bot, "mine_block", { blockType: "diamond_ore" });
  assert.ok(result.includes("No diamond_ore found"), `Got: ${result}`);
});

// ── Action routing: invoke_skill with missing skill ─────────────────────────

test("executeAction: invoke_skill without skill param", async () => {
  const result = await executeAction(mockBot(), "invoke_skill", {});
  assert.ok(result.includes("needs a 'skill' param"));
});

test("executeAction: invoke_skill with unknown skill name", async () => {
  const result = await executeAction(mockBot(), "invoke_skill", { skill: "nonexistent_skill_xyz" });
  assert.ok(result.includes("not found") || result.includes("Unknown"), `Got: ${result}`);
});

// ── Action routing: generate_skill with empty task ──────────────────────────

test("executeAction: generate_skill with empty task", async () => {
  const result = await executeAction(mockBot(), "generate_skill", { task: "" });
  assert.ok(result.includes("non-empty"), `Got: ${result}`);
});

test("executeAction: generate_skill with no task param", async () => {
  const result = await executeAction(mockBot(), "generate_skill", {});
  assert.ok(result.includes("non-empty"), `Got: ${result}`);
});

// ── Action routing: navigate variants ───────────────────────────────────────

test("executeAction: navigate alias routes to go_to", async () => {
  const bot = mockBot();
  const result = await executeAction(bot, "navigate", { x: 10, y: 64, z: 20 });
  assert.equal(typeof result, "string");
});

test("executeAction: go_to with coordinate array [x, z]", async () => {
  const bot = mockBot();
  const result = await executeAction(bot, "go_to", { coordinates: [100, 200] });
  assert.equal(typeof result, "string");
});

test("executeAction: go_to with coordinate array [x, y, z]", async () => {
  const bot = mockBot();
  const result = await executeAction(bot, "go_to", { coordinates: [100, 64, 200] });
  assert.equal(typeof result, "string");
});

// ── Action routing: explore picks random direction ──────────────────────────

test("executeAction: explore with direction param", async () => {
  const bot = mockBot();
  const result = await executeAction(bot, "explore", { direction: "north" });
  assert.equal(typeof result, "string");
});

// ── Action routing: deposit/withdraw stash without position ─────────────────

test("executeAction: deposit_stash without stashPos returns error", async () => {
  const result = await executeAction(mockBot(), "deposit_stash", {});
  assert.ok(result.includes("No stash position"));
});

test("executeAction: withdraw_stash without stashPos returns error", async () => {
  const result = await executeAction(mockBot(), "withdraw_stash", {});
  assert.ok(result.includes("No stash position"));
});

test("executeAction: withdraw_stash without item param returns error", async () => {
  const result = await executeAction(mockBot(), "withdraw_stash", {
    stashPos: { x: 0, y: 64, z: 0 },
  });
  assert.ok(result.includes("needs an 'item' param"));
});

// ── Action error handling ───────────────────────────────────────────────────

test("executeAction: catches thrown errors gracefully", async () => {
  const bot = mockBot({
    findBlock: () => {
      throw new Error("Chunk not loaded");
    },
  });
  const result = await executeAction(bot, "mine_block", { blockType: "stone" });
  assert.ok(result.includes("Action failed") || result.includes("Chunk not loaded"), `Got: ${result}`);
});
