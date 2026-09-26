import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("desktop bridge accepts only the paired local WebSocket and forwards frames", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudex-desktop-bridge-"));
  const upstreamPath = path.join(dir, "upstream.sock");
  const token = crypto.randomBytes(32).toString("base64url");
  await fs.writeFile(path.join(dir, "desktop-bridge-token"), token);
  const upstreamSockets = new Set();
  const upstream = net.createServer((socket) => {
    upstreamSockets.add(socket);
    socket.on("close", () => upstreamSockets.delete(socket));
    let data = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf("\r\n\r\n");
      if (end < 0) return;
      assert.match(data.toString("ascii", 0, end), new RegExp(`GET /${token} HTTP/1.1`));
      const key = data.toString("ascii", 0, end).match(/Sec-WebSocket-Key: ([^\r\n]+)/i)?.[1];
      const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.removeAllListeners("data");
      socket.on("data", (frame) => {
        if ((frame[0] & 0x0f) === 1) socket.write(Buffer.from([0x81, 0x02, 0x4f, 0x4b]));
      });
    });
  });
  upstream.listen(upstreamPath);
  await once(upstream, "listening");
  const reserve = net.createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const bridge = spawn(process.execPath, [new URL("../bin/desktop-bridge.js", import.meta.url).pathname], {
    cwd: dir,
    env: { ...process.env, CLOUDEX_STATE_DIR: dir, CODEX_CONTROL_SOCKET: upstreamPath,
      CLOUDEX_DESKTOP_BRIDGE_PORT: String(port), CLOUDEX_BRIDGE_SETENV: "0" },
  });
  try {
    await new Promise((resolve, reject) => {
      bridge.stdout.once("data", resolve);
      bridge.once("exit", (code) => reject(new Error(`bridge exited ${code}`)));
    });
    const denied = await new Promise((resolve) => {
      const socket = net.createConnection(port, "127.0.0.1");
      socket.once("data", (data) => { socket.destroy(); resolve(data.toString()); });
      socket.once("connect", () => socket.write("GET /wrong HTTP/1.1\r\nHost: localhost\r\n\r\n"));
    });
    assert.match(denied, /^HTTP\/1\.1 403/);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${token}`);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const reply = new Promise((resolve, reject) => { ws.onmessage = (event) => resolve(event.data); ws.onerror = reject; });
    ws.send("ping");
    assert.equal(await reply, "OK");
    ws.close();
  } finally {
    bridge.kill("SIGTERM");
    for (const socket of upstreamSockets) socket.destroy();
    upstream.close();
  }
});
