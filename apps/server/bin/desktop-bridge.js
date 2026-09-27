#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const socketPath = process.env.CODEX_CONTROL_SOCKET
  || path.join(os.homedir(), ".codex", "app-server-control", "app-server-control.sock");
const stateDir = process.env.CLOUDEX_STATE_DIR || path.resolve(".cloudex-state");
const port = Number(process.env.CLOUDEX_DESKTOP_BRIDGE_PORT || 8891);
const tokenFile = path.join(stateDir, "desktop-bridge-token");
const run = promisify(execFile);

await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
let token;
try {
  token = (await fs.readFile(tokenFile, "utf8")).trim();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  token = crypto.randomBytes(32).toString("base64url");
  try {
    await fs.writeFile(tokenFile, token, { flag: "wx", mode: 0o600 });
  } catch (writeError) {
    if (writeError.code !== "EEXIST") throw writeError;
    token = (await fs.readFile(tokenFile, "utf8")).trim();
  }
}
if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) throw new Error("Invalid desktop bridge token");

const server = net.createServer((client) => {
  let header = Buffer.alloc(0);
  const timeout = setTimeout(() => client.destroy(), 5_000);
  const onData = (chunk) => {
    header = Buffer.concat([header, chunk]);
    if (header.length > 16_384) return client.destroy();
    const end = header.indexOf("\r\n\r\n");
    if (end < 0) return;
    clearTimeout(timeout);
    client.pause();
    client.removeListener("data", onData);
    const firstLine = header.toString("ascii", 0, header.indexOf("\r\n"));
    const candidate = firstLine.match(/^GET \/([A-Za-z0-9_-]+) HTTP\/1\.1$/)?.[1] || "";
    const supplied = Buffer.from(candidate);
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = net.createConnection(socketPath);
    const connectTimeout = setTimeout(() => { upstream.destroy(); client.destroy(); }, 5_000);
    upstream.once("connect", () => {
      clearTimeout(connectTimeout);
      upstream.write(header);
      client.pipe(upstream).pipe(client);
    });
    upstream.on("error", () => client.destroy());
    upstream.on("close", () => { clearTimeout(connectTimeout); client.destroy(); });
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  };
  client.on("data", onData);
  client.on("error", () => {});
  client.on("close", () => clearTimeout(timeout));
});
server.listen(port, "127.0.0.1", async () => {
  const url = `ws://127.0.0.1:${port}/${token}`;
  if (process.platform === "darwin" && process.env.CLOUDEX_BRIDGE_SETENV !== "0") {
    try {
      await run("/bin/launchctl", ["setenv", "CODEX_APP_SERVER_WS_URL", url]);
    } catch (error) {
      console.error(`Desktop bridge could not set launch environment: ${error.message}`);
      process.exitCode = 1;
      server.close();
      return;
    }
  }
  console.log(`Desktop bridge listening on 127.0.0.1:${port}`);
});
