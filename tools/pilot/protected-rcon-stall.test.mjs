import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { Readable, PassThrough } from "node:stream";
import { test } from "node:test";
import { runObserverProcess } from "./protected-observer-cli.mjs";

// Test-only endpoint; production observer endpoints and requests are unchanged.
const { Rcon } = await import(process.env.PILOT_TEST_RCON_MODULE || "rcon-client");

function reply(id, type, text) {
  const payload = Buffer.from(text);
  const packet = Buffer.alloc(payload.length + 14);
  packet.writeInt32LE(payload.length + 10, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  payload.copy(packet, 12);
  return packet;
}

function sink() {
  const stream = new PassThrough();
  let text = "";
  stream.on("data", chunk => { text += chunk.toString(); });
  return { stream, text: () => text };
}

test("real RCON query stall retains the completed observation and closes its socket", { timeout: 12000 }, async () => {
  const commands = [];
  const sockets = new Set();
  let serverError;
  let authenticated = false;
  let clientClosed;
  const closed = new Promise(resolve => { clientClosed = resolve; });
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => { sockets.delete(socket); clientClosed(); });
    socket.on("error", error => { serverError = error; });
    let pending = Buffer.alloc(0);
    socket.on("data", chunk => {
      try {
        pending = Buffer.concat([pending, chunk]);
        assert.ok(pending.length <= 4096);
        while (pending.length >= 4) {
          const length = pending.readInt32LE(0);
          assert.ok(length >= 10 && length <= 4092);
          if (pending.length < length + 4) break;
          const frame = pending.subarray(0, length + 4);
          pending = pending.subarray(length + 4);
          const id = frame.readInt32LE(4), type = frame.readInt32LE(8);
          const text = frame.subarray(12, frame.length - 2).toString();
          if (type === 3) {
            assert.equal(text, "synthetic-rcon-secret");
            authenticated = true;
            socket.write(reply(id, 2, ""));
          } else {
            assert.equal(type, 2);
            assert.ok(authenticated);
            commands.push(text);
            if (commands.length === 1) {
              assert.equal(text, "data get entity PilotProbe Pos");
              socket.write(reply(id, 0, "PilotProbe has the following entity data: [0.5d, 200d, 0.5d]"));
            } else {
              assert.equal(commands.length, 2);
              assert.equal(text, "data get entity PilotProbe Dimension");
              // Deliberately retain an open TCP connection without a reply.
            }
          }
        }
      } catch (error) { serverError = error; socket.destroy(); }
    });
  });
  const output = sink(), error = sink();
  let connection;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const started = performance.now();
    const code = await runObserverProcess({
      input: Readable.from([JSON.stringify({schema_version: 1, phase: "terminal", trial_id: "stall-01", action_id: "walk-01", password: "synthetic-rcon-secret"})]),
      output: output.stream, error: error.stream,
      connect: async options => {
        assert.equal(options.host, "127.0.0.1");
        assert.equal(options.port, 25595);
        connection = new Rcon({...options, port: server.address().port});
        connection.on("error", () => {});
        await connection.connect();
        return connection;
      },
    });
    assert.equal(serverError, undefined);
    assert.equal(code, 1);
    assert.deepEqual(commands, ["data get entity PilotProbe Pos", "data get entity PilotProbe Dimension"]);
    assert.equal(output.text().trim().split("\n").length, 1);
    assert.ok(output.text().trim(), "structured partial observation must survive the deadline");
    const result = JSON.parse(output.text());
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "timeout");
    assert.deepEqual(result.observations, {position: {x: 0.5, y: 200, z: 0.5}});
    assert.equal(result.sample.queryWindows[0].outcome, "completed");
    assert.equal(result.sample.queryWindows[1].outcome, "timeout");
    assert.equal(error.text(), "observer failed\n");
    assert.doesNotMatch(output.text() + error.text(), /synthetic-rcon-secret/);
    assert.ok(performance.now() - started < 9000);
    assert.ok(connection.socket === null || connection.socket.destroyed);
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("server socket remained open")), 1000).unref())]);
  } finally {
    connection?.socket?.destroy();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
});
