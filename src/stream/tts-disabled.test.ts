import { test } from "node:test";
import assert from "node:assert/strict";
import { MsEdgeTTS } from "msedge-tts";
import { generateSpeech } from "./tts.js";
test("disabled speech returns without opening an external speech connection", async () => {
  const old = process.env.TTS_ENABLED;
  const original = MsEdgeTTS.prototype.setMetadata;
  let called = false;
  MsEdgeTTS.prototype.setMetadata = async function () {
    called = true;
    throw new Error("external speech forbidden");
  };
  process.env.TTS_ENABLED = "false";
  try {
    assert.equal(await generateSpeech("local test"), null);
    assert.equal(called, false);
  } finally {
    MsEdgeTTS.prototype.setMetadata = original;
    if (old === undefined) delete process.env.TTS_ENABLED;
    else process.env.TTS_ENABLED = old;
  }
});
