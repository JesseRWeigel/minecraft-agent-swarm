const PREFIX = "PilotProbe has the following entity data: ";
const MAX_REPLY_LENGTH = 65_536;
const MAX_ENTRIES = 41;
const ALLOWED_SLOTS = new Set([
  ...Array.from({ length: 36 }, (_value, index) => index),
  ...Array.from({ length: 4 }, (_value, index) => index + 100),
  -106,
]);
const ITEM_ID = /^minecraft:[a-z0-9._/-]+$/;

function invalidInventoryReply() {
  throw new Error("invalid inventory reply");
}

class Parser {
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  skipWhitespace() {
    while (" \t\r\n".includes(this.text[this.index])) this.index += 1;
  }

  consume(character) {
    this.skipWhitespace();
    if (this.text[this.index] !== character) invalidInventoryReply();
    this.index += 1;
  }

  word() {
    this.skipWhitespace();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.index));
    if (!match) invalidInventoryReply();
    this.index += match[0].length;
    return match[0];
  }

  digits({ byte = false } = {}) {
    this.skipWhitespace();
    const match = /^-?\d+/.exec(this.text.slice(this.index));
    if (!match) invalidInventoryReply();
    this.index += match[0].length;
    if (byte) {
      if (this.text[this.index] !== "b") invalidInventoryReply();
      this.index += 1;
    }
    const value = Number(match[0]);
    if (!Number.isSafeInteger(value)) invalidInventoryReply();
    return value;
  }

  quotedString() {
    this.skipWhitespace();
    if (this.text[this.index] !== '"') invalidInventoryReply();
    this.index += 1;
    const start = this.index;
    while (this.index < this.text.length && this.text[this.index] !== '"') {
      const character = this.text[this.index];
      if (character === "\\" || character < " " || character > "~") invalidInventoryReply();
      this.index += 1;
    }
    if (this.index === start || this.text[this.index] !== '"') invalidInventoryReply();
    const value = this.text.slice(start, this.index);
    this.index += 1;
    return value;
  }

  compound() {
    this.consume("{");
    const values = {};
    const seen = new Set();
    for (let first = true; ; first = false) {
      this.skipWhitespace();
      if (this.text[this.index] === "}") {
        this.index += 1;
        break;
      }
      if (!first) this.consume(",");
      const key = this.word();
      if (!new Set(["Slot", "id", "count"]).has(key) || seen.has(key)) invalidInventoryReply();
      seen.add(key);
      this.consume(":");
      if (key === "Slot") values.slot = this.digits({ byte: true });
      else if (key === "count") values.count = this.digits();
      else values.id = this.quotedString();
    }
    if (seen.size !== 3 || !ALLOWED_SLOTS.has(values.slot)) invalidInventoryReply();
    if (values.count < 1 || values.count > 64 || !ITEM_ID.test(values.id)) invalidInventoryReply();
    return values;
  }

  list() {
    this.consume("[");
    const inventory = [];
    const slots = new Set();
    for (let first = true; ; first = false) {
      this.skipWhitespace();
      if (this.text[this.index] === "]") {
        this.index += 1;
        break;
      }
      if (!first) this.consume(",");
      if (inventory.length >= MAX_ENTRIES) invalidInventoryReply();
      const entry = this.compound();
      if (slots.has(entry.slot)) invalidInventoryReply();
      slots.add(entry.slot);
      inventory.push(entry);
    }
    return inventory;
  }
}

export function parseInventoryReply(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_REPLY_LENGTH || !text.startsWith(PREFIX)) {
    invalidInventoryReply();
  }
  const parser = new Parser(text.slice(PREFIX.length));
  const inventory = parser.list();
  parser.skipWhitespace();
  if (parser.index !== parser.text.length) invalidInventoryReply();
  return inventory;
}
