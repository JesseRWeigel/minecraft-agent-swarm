const MAX_TOTAL_BYTES = 4096;
const MAX_LINE_BYTES = 512;
const ID_PATTERN = /[A-Za-z0-9][A-Za-z0-9._-]{0,63}/;
const FIELD_PATTERN = /"([a-z_]+)"[ \t\r]*:[ \t\r]*(1|"[A-Za-z0-9._-]{1,64}")/gy;

const genericFailure = () => new Error("participant pipe failed");

function validId(value) {
  return typeof value === "string" && ID_PATTERN.exec(value)?.[0] === value;
}

function parseCommand(line, expectedType, trialId, actionId) {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(line);
  let cursor = 0;
  const pairs = [];
  const open = /^[ \t\r]*\{[ \t\r]*/y;
  open.lastIndex = cursor;
  const opened = open.exec(text);
  if (!opened) throw genericFailure();
  cursor = open.lastIndex;
  while (pairs.length < 4) {
    FIELD_PATTERN.lastIndex = cursor;
    const match = FIELD_PATTERN.exec(text);
    if (!match) throw genericFailure();
    pairs.push([match[1], match[2] === "1" ? 1 : match[2].slice(1, -1)]);
    cursor = FIELD_PATTERN.lastIndex;
    const separator = pairs.length === 4 ? /[ \t\r]*\}[ \t\r]*$/y : /[ \t\r]*,[ \t\r]*/y;
    separator.lastIndex = cursor;
    if (!separator.exec(text)) throw genericFailure();
    cursor = separator.lastIndex;
  }
  const value = Object.fromEntries(pairs);
  const keys = pairs.map(([key]) => key);
  if (
    new Set(keys).size !== 4 ||
    !keys.every((key) => ["schema_version", "type", "trial_id", "action_id"].includes(key))
  )
    throw genericFailure();
  if (
    value.schema_version !== 1 ||
    value.type !== expectedType ||
    value.trial_id !== trialId ||
    value.action_id !== actionId
  )
    throw genericFailure();
  return Object.freeze(value);
}

export function createParticipantPipes({ input, output, trialId, actionId } = {}) {
  if (!input?.on || !output?.write) throw new TypeError("participant streams required");
  if (!validId(trialId) || !validId(actionId)) throw new RangeError("invalid supervisor ID");

  let state = "before_ready";
  let buffer = Buffer.alloc(0);
  let totalBytes = 0;
  let failure;
  let pendingCommand;
  let waiting;
  let closed = false;

  const fail = () => {
    if (!failure) failure = genericFailure();
    waiting?.reject(failure);
    waiting = undefined;
    pendingCommand = undefined;
    return failure;
  };

  const acceptLine = (raw) => {
    const expected = state === "awaiting_begin" ? "begin" : state === "awaiting_finalize" ? "finalize" : undefined;
    if (!expected || pendingCommand || waiting?.settled) throw fail();
    let command;
    try {
      command = parseCommand(raw, expected, trialId, actionId);
    } catch {
      throw fail();
    }
    state = expected === "begin" ? "before_action_finished" : "complete";
    if (waiting) {
      waiting.settled = true;
      waiting.resolve(command);
      waiting = undefined;
    } else {
      pendingCommand = command;
    }
  };

  const onData = (chunk) => {
    if (failure || closed) return;
    try {
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
      totalBytes += chunk.length;
      if (totalBytes > MAX_TOTAL_BYTES) throw fail();
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) {
          if (buffer.length > MAX_LINE_BYTES) throw fail();
          break;
        }
        if (newline > MAX_LINE_BYTES) throw fail();
        const raw = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (raw.length === 0) throw fail();
        acceptLine(raw);
      }
    } catch {
      fail();
    }
  };
  const onEnd = () => {
    if (buffer.length || state !== "complete") fail();
  };
  const onError = () => fail();
  input.on("data", onData);
  input.on("end", onEnd);
  input.on("error", onError);
  output.on?.("error", onError);

  const sendMessage = async (message) => {
    if (closed) throw fail();
    if (failure) throw failure;
    const expected =
      state === "before_ready" ? "ready" : state === "before_action_finished" ? "action_finished" : undefined;
    if (!expected || !message || Object.getPrototypeOf(message) !== Object.prototype) throw fail();
    const keys = Object.keys(message);
    if (
      keys.length !== 4 ||
      !keys.every((key) => ["schema_version", "type", "trial_id", "action_id"].includes(key)) ||
      message.schema_version !== 1 ||
      message.type !== expected ||
      message.trial_id !== trialId ||
      message.action_id !== actionId
    )
      throw fail();
    const serialized = `${JSON.stringify(message)}\n`;
    state = expected === "ready" ? "awaiting_begin" : "awaiting_finalize";
    await new Promise((resolve, reject) => {
      try {
        output.write(serialized, (error) => (error ? reject(fail()) : resolve()));
      } catch {
        reject(fail());
      }
    });
    if (failure) throw failure;
  };

  const waitForCommand = async () => {
    if (closed) throw fail();
    if (failure) throw failure;
    if (pendingCommand) {
      const command = pendingCommand;
      pendingCommand = undefined;
      return command;
    }
    if (!["awaiting_begin", "awaiting_finalize"].includes(state) || waiting) throw fail();
    return new Promise((resolve, reject) => {
      waiting = { resolve, reject, settled: false };
    });
  };

  const close = async () => {
    if (closed) return;
    await new Promise((resolve) => setImmediate(resolve));
    if (buffer.length || (state !== "complete" && !failure)) fail();
    closed = true;
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("error", onError);
    output.off?.("error", onError);
    if (waiting) fail();
    input.pause?.();
    if (failure) throw failure;
  };

  return Object.freeze({ sendMessage, waitForCommand, close });
}
