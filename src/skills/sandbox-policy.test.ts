import { test } from "node:test";
import assert from "node:assert/strict";
import { createSandboxSeccompPolicy } from "./sandbox-policy.js";

// Independent classic-BPF interpreter exercises the serialized kernel program,
// rather than reusing the policy builder's branch/deny helpers.
function verdict(nr: number, flags = 0, arch = 0xc000003e): number {
  const program = createSandboxSeccompPolicy("linux", "x64");
  const input = Buffer.alloc(64);
  input.writeUInt32LE(nr >>> 0, 0);
  input.writeUInt32LE(arch >>> 0, 4);
  input.writeUInt32LE(flags >>> 0, 16);
  let accumulator = 0;
  for (let pc = 0; pc < program.length / 8; pc++) {
    const offset = pc * 8;
    const code = program.readUInt16LE(offset);
    const yes = program.readUInt8(offset + 2);
    const no = program.readUInt8(offset + 3);
    const k = program.readUInt32LE(offset + 4);
    if (code === 0x20) accumulator = input.readUInt32LE(k);
    else if (code === 0x15) pc += accumulator === k ? yes : no;
    else if (code === 0x35) pc += accumulator >= k ? yes : no;
    else if (code === 0x45) pc += (accumulator & k) !== 0 ? yes : no;
    else if (code === 0x06) return k;
    else assert.fail(`Unexpected BPF opcode ${code}`);
  }
  return assert.fail("Policy fell through without a verdict");
}

test("sandbox policy refuses unsupported platforms and architectures", () => {
  assert.throws(() => createSandboxSeccompPolicy("win32", "x64"), /Linux x64/);
  assert.throws(() => createSandboxSeccompPolicy("linux", "arm64"), /Linux x64/);
});

test("sandbox policy rejects foreign ABI and x32 syscall numbers", () => {
  assert.equal(verdict(0, 0, 0x40000003), 0x80000000);
  assert.equal(verdict(0x40000000), 0x80000000);
});

test("sandbox policy denies processes while permitting shared-memory Node threads", () => {
  for (const nr of [57, 58]) assert.equal(verdict(nr), 0x00050001);
  assert.equal(verdict(56, 0), 0x00050001);
  assert.equal(verdict(56, 0x10000), 0x7fff0000);
  assert.equal(verdict(435), 0x00050026, "clone3 must signal ENOSYS for pthread fallback");
});

test("sandbox policy denies namespace, kernel and persistent-memory escape routes", () => {
  for (const nr of [
    29, 30, 64, 68, 69, 101, 155, 165, 166, 169, 175, 176, 240, 241, 248, 249, 250, 272, 298, 300, 303, 308, 310, 311,
    313, 319, 321, 322, 323, 428, 429, 430, 431, 432, 433, 442, 447,
  ]) {
    assert.equal(verdict(nr), 0x00050001, `syscall ${nr} must be denied`);
  }
});

test("sandbox policy allows bootstrap and ordinary runtime IO", () => {
  for (const nr of [0, 1, 2, 3, 9, 10, 11, 12, 13, 14, 59, 60, 202, 231, 257]) {
    assert.equal(verdict(nr), 0x7fff0000, `syscall ${nr} should remain available inside namespaces`);
  }
});
