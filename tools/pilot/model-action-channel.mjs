// Dedicated action streams only. Never connect these to lifecycle stdin/stdout.
export function runModelActionChannel({ input, output, session, signal, timeoutMs = 20000 } = {}) {
  if (
    !input?.on ||
    !input?.off ||
    !output?.on ||
    !output?.write ||
    typeof session?.execute !== "function" ||
    typeof session?.close !== "function" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 20000 ||
    (signal !== undefined && !(signal instanceof AbortSignal))
  )
    throw new TypeError("invalid model action channel");
  let state = "reading",
    buffer = Buffer.alloc(0),
    queued = null,
    ended = false,
    finish = false,
    settled = false;
  let inputBytes = 0,
    outputBytes = 0,
    requests = 0,
    timer,
    resolveDone,
    rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const detach = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", fail);
    input.off("data", onData);
    input.off("end", onEnd);
    input.pause?.();
  };
  const fail = () => {
    if (settled) return;
    settled = true;
    const error = new Error("model action channel failed");
    error.diagnostics = { stage: state, inputBytes, outputBytes, requests };
    state = "failed";
    buffer = Buffer.alloc(0);
    queued = null;
    detach();
    try {
      const p = session.close();
      p?.catch?.(() => {});
    } catch {}
    rejectDone(error);
  };
  const succeed = () => {
    if (settled) return;
    if (!finish || !ended || buffer.length || queued) return fail();
    settled = true;
    state = "finished";
    detach();
    resolveDone({ status: "finished", requests, inputBytes, outputBytes });
  };
  const replyWritten = (error) => {
    if (settled) return;
    if (error) return fail();
    if (finish) {
      state = "awaiting_eof";
      if (ended) succeed();
      return;
    }
    if (queued) {
      const raw = queued;
      queued = null;
      void execute(raw);
    } else if (ended) fail();
    else state = "reading";
  };
  async function execute(raw) {
    if (settled) return;
    state = "executing";
    requests++;
    if (requests > 25) return fail();
    try {
      const result = await session.execute(raw);
      if (settled) return;
      if (
        !result ||
        Object.getPrototypeOf(result) !== Object.prototype ||
        result.schema_version !== 1 ||
        result.sequence !== requests ||
        !["completed", "finished"].includes(result.status) ||
        Object.keys(result).some((k) => !["schema_version", "sequence", "status", "observation"].includes(k))
      )
        throw new Error();
      if ("observation" in result && (!result.observation || result.observation.source !== "participant_bot"))
        throw new Error();
      finish = result.status === "finished";
      const line = Buffer.from(JSON.stringify(result) + "\n");
      if (line.length > 20480 || outputBytes + line.length > 25 * 20480) throw new Error();
      outputBytes += line.length;
      state = "writing";
      let called = false;
      output.write(line, (error) => {
        if (called) return;
        called = true;
        replyWritten(error);
      });
    } catch {
      fail();
    }
  }
  function onData(chunk) {
    if (settled) return;
    try {
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) return fail();
      if (!chunk.byteLength) return;
      if (ended || finish || state === "executing" || queued) return fail();
      inputBytes += chunk.byteLength;
      if (inputBytes > 25 * 4097 || buffer.length + chunk.byteLength > 4097) return fail();
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) {
        if (buffer.length > 4096) fail();
        return;
      }
      if (newline === 0 || newline > 4096 || newline !== buffer.length - 1) return fail();
      const raw = buffer.subarray(0, newline);
      buffer = Buffer.alloc(0);
      if (state === "writing") queued = raw;
      else if (state === "reading") void execute(raw);
      else fail();
    } catch {
      fail();
    }
  }
  function onEnd() {
    if (settled) return;
    ended = true;
    if (buffer.length) return fail();
    if (state === "awaiting_eof") succeed();
    else if (state === "reading") fail();
  }
  // Keep bounded no-op-on-settlement error handlers on the dedicated streams;
  // a late error after cancellation must not become an unhandled stream error.
  timer = setTimeout(fail, timeoutMs);
  signal?.addEventListener("abort", fail, { once: true });
  if (signal?.aborted) {
    fail();
    return done;
  }
  input.on("error", fail);
  output.on("error", fail);
  input.on("end", onEnd);
  input.on("data", onData);
  return done;
}
