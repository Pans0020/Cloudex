import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CodexClient, ProxyWebSocket } from "../src/codex-client.js";
import { listModelsViaStdio } from "../src/app-server-stdio.js";

function proxyChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => { child.killed = true; };
  return child;
}

test("control socket validates the upgrade and handles fragmented UTF-8 frames", async () => {
  const child = proxyChild();
  const socket = new ProxyWebSocket(child, 100);
  const connected = socket.connect();
  const key = child.stdin.read().toString().match(/Sec-WebSocket-Key: (.+)\r\n/)[1];
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  const header = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
  child.stdout.write(header.slice(0, 12));
  child.stdout.write(header.slice(12));
  await connected;
  const messages = [];
  socket.on("message", (message) => messages.push(message));
  const text = Buffer.from("实时更新");
  child.stdout.write(Buffer.concat([Buffer.from([0x01, 2]), text.subarray(0, 2)]));
  child.stdout.write(Buffer.from([0x89, 0])); // Ping must not disrupt a fragmented message.
  child.stdout.write(Buffer.concat([Buffer.from([0x80, text.length - 2]), text.subarray(2)]));
  assert.deepEqual(messages, ["实时更新"]);
  socket.close();
});

test("invalid, stalled and explicitly closed upgrades reject and release their process", async () => {
  for (const mode of ["invalid", "timeout", "close"]) {
    const child = proxyChild();
    const socket = new ProxyWebSocket(child, 10);
    const connected = socket.connect();
    if (mode === "invalid") child.stdout.write("HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: forged\r\n\r\n");
    if (mode === "close") socket.close();
    await assert.rejects(connected, /upgrade|upgrading/i);
    assert.equal(child.killed, true);
  }
});

test("concurrent RPC waits for initialize and initialized on the same connection", async () => {
  const client = new CodexClient({ requestTimeoutMs: 1000 });
  const sent = [];
  client.connectProxy = async () => {
    client.socket = { closed: false, close() {}, send(raw) {
      const message = JSON.parse(raw);
      sent.push(message);
      if (message.method === "model/list") client.onMessage(JSON.stringify({ id: message.id, result: { data: [] } }));
    } };
  };
  const starting = client.start();
  const models = client.request("model/list");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.map((message) => message.method), ["initialize"]);
  client.onMessage(JSON.stringify({ id: sent[0].id, result: {} }));
  await Promise.all([starting, models]);
  assert.deepEqual(sent.map((message) => message.method), ["initialize", "initialized", "model/list"]);
  await client.stop();
  await assert.rejects(client.request("turn/start"), /shutting down/);
});

test("RPC timeout leaves the write unconfirmed without replay and preserves structured errors", async () => {
  const client = new CodexClient({ requestTimeoutMs: 10 });
  const sent = [];
  client.socket = { closed: false, close() {}, send(raw) { sent.push(JSON.parse(raw)); } };
  await assert.rejects(client.request("turn/start", { threadId: "one" }), { code: "CODEX_REQUEST_TIMEOUT" });
  assert.equal(sent.length, 1);
  assert.equal(client.pending.size, 0);
  client.onMessage(JSON.stringify({ id: sent[0].id, result: {} }));
  client.onMessage("null");
  const result = client.request("thread/resume");
  await Promise.resolve();
  await Promise.resolve();
  client.onMessage(JSON.stringify({ id: sent.at(-1).id, error: { code: -32001, message: "Server overloaded", data: { retry: true } } }));
  await assert.rejects(result, (error) => error.code === -32001 && error.data.retry === true);
  await client.stop();
});

test("model listing follows cursors and rejects a repeated cursor", async () => {
  const client = new CodexClient();
  const cursors = [];
  client.request = async (method, params) => {
    assert.equal(method, "model/list");
    cursors.push(params.cursor);
    return params.cursor ? { data: [{ id: "second" }], nextCursor: null }
      : { data: [{ id: "first" }], nextCursor: "next" };
  };
  assert.deepEqual((await client.listModels()).data.map((model) => model.id), ["first", "second"]);
  assert.deepEqual(cursors, [undefined, "next"]);
  client.request = async () => ({ data: [], nextCursor: "same" });
  await assert.rejects(client.listModels(), /repeated.*cursor/);
});

test("resuming excludes history and old terminal events cannot clear a newer turn", async () => {
  const client = new CodexClient();
  client.ensureConnected = async () => {};
  client.request = async (method, params) => {
    assert.equal(method, "thread/resume");
    assert.deepEqual(params, { threadId: "thread", excludeTurns: true });
    return { thread: { id: "thread" } };
  };
  await client.subscribeThread("thread");
  client.setActiveTurn("thread", "new");
  client.trackNotification({ method: "turn/completed", params: { threadId: "thread", turn: { id: "old" } } });
  assert.equal(client.getActiveTurn("thread"), "new");
  client.trackNotification({ method: "thread/status/changed", params: { threadId: "thread", status: { type: "notLoaded" } } });
  assert.equal(client.getActiveTurn("thread"), undefined);
  assert.equal(client.subscribedThreads.has("thread"), false);
});

test("stdio models preserve split UTF-8, complete pagination and handle failed children", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudex-protocol-test-"));
  const scriptPath = path.join(directory, "provider.mjs");
  try {
    await fs.writeFile(scriptPath, `
      import readline from "node:readline";
      let initialized = false;
      readline.createInterface({ input: process.stdin }).on("line", line => {
        const request = JSON.parse(line);
        const send = result => process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
        if (request.method === "initialize") send({});
        if (request.method === "initialized") initialized = true;
        if (request.method === "model/list") {
          if (!initialized) process.exit(2);
          if (request.params.cursor) return send({ data: [{ id: "second" }], nextCursor: null });
          const bytes = Buffer.from(JSON.stringify({ id: request.id, result: { data: [{ id: "模型" }], nextCursor: "next" } }) + "\\n");
          const split = bytes.indexOf(Buffer.from("模")) + 1;
          process.stdout.write(bytes.subarray(0, split));
          setTimeout(() => process.stdout.write(bytes.subarray(split)), 10);
        }
      });
    `);
    const result = await listModelsViaStdio({ codexBin: process.execPath, commandArgs: [scriptPath], timeoutMs: 1000 });
    assert.deepEqual(result.data.map((model) => model.id), ["模型", "second"]);
    await assert.rejects(listModelsViaStdio({ codexBin: path.join(directory, "missing"), timeoutMs: 100 }), { code: "ENOENT" });
    await assert.rejects(listModelsViaStdio({ codexBin: process.execPath, commandArgs: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 20 }), /Timed out/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Codex home scopes config, history and control socket while explicit paths win", () => {
  const home = path.join(os.tmpdir(), "cloudex-isolated-home");
  const script = `import { config } from ${JSON.stringify(new URL("../src/config.js", import.meta.url).href)}; console.log(JSON.stringify([config.codexHome, config.codexConfigPath, config.codexSessionsDir, config.controlSocketPath]));`;
  const env = { ...process.env, CODEX_HOME: home, CODEX_CONFIG_PATH: "", CODEX_SESSIONS_DIR: "", CODEX_CONTROL_SOCKET: "" };
  const read = (overrides) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...env, ...overrides }, encoding: "utf8" }));
  assert.deepEqual(read({}), [home, path.join(home, "config.toml"), path.join(home, "sessions"), path.join(home, "app-server-control", "app-server-control.sock")]);
  assert.deepEqual(read({ CODEX_CONFIG_PATH: "/custom/config", CODEX_SESSIONS_DIR: "/custom/sessions", CODEX_CONTROL_SOCKET: "/custom/socket" }), [home, "/custom/config", "/custom/sessions", "/custom/socket"]);
});
