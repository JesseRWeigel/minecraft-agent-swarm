const MAX_REQUEST_BYTES = 4096;
const TRIAL_ID = "collect-oak-log-v1";
const ACTION_ID = "collect-01";
const ROOT_KEYS = ["action", "action_id", "schema_version", "sequence", "trial_id"];
const DIRECTION = new Set(["forward", "back", "left", "right"]);
const MAX_WORLD_COORDINATE = 30_000_000;

function invalid() {
  throw new Error("invalid model action request");
}

function hasDuplicateKeys(text) {
  const keys = new Set();
  const matcher = /"((?:\\.|[^"\\])*)"\s*:/g;
  for (const match of text.matchAll(matcher)) {
    let key;
    try {
      key = JSON.parse(`"${match[1]}"`);
    } catch {
      return true;
    }
    if (keys.has(key)) return true;
    keys.add(key);
  }
  return false;
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys)
  );
}

function parseRaw(raw) {
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) invalid();
    return raw;
  }
  if (!Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) invalid();
  if (raw.byteLength > MAX_REQUEST_BYTES) invalid();
  const bytes = Buffer.from(raw);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    invalid();
  }
}

function validateAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action) || Object.getPrototypeOf(action) !== Object.prototype)
    invalid();
  if (action.kind === "observe" || action.kind === "finish") {
    if (!exactKeys(action, ["kind"])) invalid();
    return;
  }
  if (action.kind === "look") {
    if (
      !exactKeys(action, ["kind", "pitch", "yaw"]) ||
      typeof action.yaw !== "number" ||
      !Number.isFinite(action.yaw) ||
      action.yaw < -Math.PI ||
      action.yaw > Math.PI ||
      typeof action.pitch !== "number" ||
      !Number.isFinite(action.pitch) ||
      action.pitch < -Math.PI / 2 ||
      action.pitch > Math.PI / 2
    )
      invalid();
    return;
  }
  if (action.kind === "move") {
    if (!exactKeys(action, ["direction", "kind", "ticks"]) || !DIRECTION.has(action.direction) || !Number.isInteger(action.ticks) || action.ticks < 1 || action.ticks > 20)
      invalid();
    return;
  }
  if (action.kind === "dig") {
    if (
      !exactKeys(action, ["kind", "x", "y", "z"]) ||
      ![action.x, action.y, action.z].every(Number.isInteger) ||
      Math.abs(action.x) > MAX_WORLD_COORDINATE ||
      Math.abs(action.z) > MAX_WORLD_COORDINATE ||
      action.y < -64 ||
      action.y > 319
    )
      invalid();
    return;
  }
  invalid();
}

export function parseModelActionRequest(raw) {
  try {
    const text = parseRaw(raw);
    if (hasDuplicateKeys(text)) invalid();
    const value = JSON.parse(text);
    if (
      !exactKeys(value, ROOT_KEYS) ||
      value.schema_version !== 1 ||
      value.trial_id !== TRIAL_ID ||
      value.action_id !== ACTION_ID ||
      !Number.isInteger(value.sequence) ||
      value.sequence < 1 ||
      value.sequence > 25
    )
      invalid();
    validateAction(value.action);
    return value;
  } catch {
    invalid();
  }
}
