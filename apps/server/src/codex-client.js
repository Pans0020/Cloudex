import crypto from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { config } from "./config.js";
import { listAllModels } from "./app-server-stdio.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const execFile = promisify(execFileCallback);

async function waitForControlSocket(timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(config.controlSocketPath);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Codex app-server control socket was not created: ${config.controlSocketPath}`);
}

async function bootstrapManagedAppServer() {
  // Windows intentionally keeps the existing CLI fallback. Its app-server
  // daemon is not required for starting turns or listing models there.
  if (process.platform === "win32") return;

  try {
    await execFile(config.codexBin, ["app-server", "daemon", "bootstrap"], {
      env: process.env,
      timeout: 15_000,
      windowsHide: true,
    });
  } catch (error) {
    const output = [error.stdout, error.stderr, error.message]
      .filter(Boolean)
      .map((value) => String(value))
      .join("\n");
    // Codex reports this as a non-zero result when an unmanaged app-server is
    // already running. The proxy can still connect to that existing daemon.
    if (!output.includes("app server is running but is not managed by codex app-server daemon")) {
      throw error;
    }
  }
  await waitForControlSocket();
}

export class CodexError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CodexError";
    Object.assign(this, details);
  }
}

// `codex app-server proxy` is intentionally a byte proxy. The app-server
// control socket speaks WebSocket, so this small transport performs the
// standard client handshake/framing without adding a third-party dependency.
export class ProxyWebSocket extends EventEmitter {
  constructor(child, timeoutMs = 5_000) {
    super();
    this.child = child;
    this.buffer = Buffer.alloc(0);
    this.handshakeDone = false;
    this.closed = false;
    this.fragments = [];
    this.timeoutMs = timeoutMs;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const fail = (error) => {
        if (this.handshakeDone || this.closed) return;
        clearTimeout(timeout);
        reject(error);
        this.close(error);
      };
      const timeout = setTimeout(() => fail(new CodexError("Timed out upgrading Codex control socket")), this.timeoutMs);
      this.once("open", () => { clearTimeout(timeout); resolve(); });
      this.once("close", (error) => { clearTimeout(timeout); reject(error || new CodexError("Control socket closed during upgrade")); });
      this.once("handshakeError", fail);
      this.child.stdout.on("data", (chunk) => this.receive(Buffer.from(chunk)));
      this.child.on("error", (error) => { fail(error); this.close(error); });
      this.child.on("exit", (code, signal) => {
        const error = new CodexError(`Codex proxy exited (${code ?? signal})`);
        if (!this.handshakeDone) fail(error);
        this.close(error);
      });
      this.child.stdin.on("error", (error) => { fail(error); this.close(error); });

      const key = crypto.randomBytes(16).toString("base64");
      this.expectedAccept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      const request = [
        "GET / HTTP/1.1",
        "Host: localhost",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "\r\n",
      ].join("\r\n");
      this.child.stdin.write(request);
    });
  }

  receive(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshakeDone) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        if (this.buffer.length > 16_384) this.emit("handshakeError", new CodexError("Control socket upgrade header is too large"));
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      this.buffer = this.buffer.subarray(headerEnd + 4);
      if (!/^HTTP\/1\.1 101\b/m.test(header)) {
        this.emit("handshakeError", new CodexError(`Control socket rejected WebSocket upgrade: ${header.split("\r\n")[0]}`));
        return;
      }
      const headers = new Map(header.split("\r\n").slice(1).map((line) => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
      }));
      if (headers.get("sec-websocket-accept") !== this.expectedAccept
        || headers.get("upgrade")?.toLowerCase() !== "websocket"
        || !headers.get("connection")?.toLowerCase().split(/\s*,\s*/).includes("upgrade")) {
        this.emit("handshakeError", new CodexError("Control socket returned an invalid WebSocket upgrade"));
        return;
      }
      this.handshakeDone = true;
      this.emit("open");
    }
    this.readFrames();
  }

  readFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      let offset = 2;
      let length = second & 0x7f;
      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const longLength = this.buffer.readBigUInt64BE(offset);
        if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.close(new CodexError("Control socket frame is too large"));
          return;
        }
        length = Number(longLength);
        offset += 8;
      }
      const masked = (second & 0x80) !== 0;
      let mask;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (masked) payload = Buffer.from(payload.map((value, index) => value ^ mask[index % 4]));

      const opcode = first & 0x0f;
      const final = (first & 0x80) !== 0;
      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) {
        this.sendFrame(0xA, payload);
        continue;
      }
      if (opcode === 0x0) this.fragments.push(payload);
      else if (opcode === 0x1) this.fragments = [payload];
      else continue;
      if (final) {
        this.emit("message", Buffer.concat(this.fragments).toString("utf8"));
        this.fragments = [];
      }
    }
  }

  send(text) {
    this.sendFrame(0x1, Buffer.from(text));
  }

  sendFrame(opcode, payload) {
    if (this.closed || !this.handshakeDone) throw new CodexError("Control socket is not connected");
    const length = payload.length;
    let header;
    if (length < 126) header = Buffer.from([0x80 | opcode, 0x80 | length]);
    else if (length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
    this.child.stdin.write(Buffer.concat([header, mask, masked]));
  }

  close(error) {
    if (this.closed) return;
    this.closed = true;
    try { this.child.stdin.end(); } catch {}
    if (!this.child.killed) this.child.kill("SIGTERM");
    this.emit("close", error);
  }
}

export class CodexClient extends EventEmitter {
  constructor({ requestTimeoutMs = 30_000, connectTimeoutMs = 5_000 } = {}) {
    super();
    this.socket = null;
    this.child = null;
    this.connecting = null;
    this.nextId = 1;
    this.pending = new Map();
    this.pendingServerRequests = new Map();
    this.activeTurns = new Map();
    this.subscribedThreads = new Set();
    this.subscriptionRequests = new Map();
    this.unsubscribeRequests = new Map();
    this.requestTimeoutMs = requestTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.stopped = false;
  }

  async start() {
    this.stopped = false;
    await this.ensureConnected();
  }

  async ensureConnected() {
    if (this.stopped) throw new CodexError("Controller shutting down");
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.closed) return;
    this.connecting = this.connectWithRetry().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async connectWithRetry() {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (this.stopped) throw new CodexError("Controller shutting down");
        // Reuse the running CLI/Desktop server before installing or starting a daemon.
        if (attempt === 1) await bootstrapManagedAppServer();
        if (this.stopped) throw new CodexError("Controller shutting down");
        await this.connectProxy();
        await this.sendRequest("initialize", {
          clientInfo: { name: "cloudex-codex-control", title: "Cloudex local controller", version: "0.2.0" },
          capabilities: { experimentalApi: true },
        });
        this.notify("initialized", {});
        this.emit("ready");
        return;
      } catch (error) {
        lastError = error;
        this.closeProxy();
        if (this.stopped) throw error;
        if (attempt < 2) await sleep(150 * (attempt + 1));
      }
    }
    throw new CodexError(`Unable to connect to managed Codex app-server: ${lastError?.message || "unknown error"}`);
  }

  async connectProxy() {
    this.child = spawn(config.codexBin, ["app-server", "proxy", "--sock", config.controlSocketPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });
    this.child.stderr.on("data", (chunk) => this.emit("log", chunk.toString()));
    const socket = new ProxyWebSocket(this.child, this.connectTimeoutMs);
    socket.on("message", (raw) => this.onMessage(raw));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.subscribedThreads.clear();
      this.subscriptionRequests.clear();
      this.unsubscribeRequests.clear();
      this.pendingServerRequests.clear();
      this.activeTurns.clear();
      this.rejectPending(new CodexError("Managed Codex app-server connection closed"));
      this.emit("disconnected");
    });
    this.socket = socket;
    await socket.connect();
  }

  onMessage(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (!message || typeof message !== "object") return;
    if (message.id !== undefined && message.method) {
      this.pendingServerRequests.set(String(message.id), message);
      this.emit("serverRequest", message);
      return;
    }
    if (message.id !== undefined && this.pending.has(String(message.id))) {
      const pending = this.pending.get(String(message.id));
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new CodexError(message.error.message || "Codex request failed", { error: message.error, code: message.error.code, data: message.error.data }));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      if (message.method === "serverRequest/resolved") {
        const requestId = message.params?.requestId;
        if (requestId !== undefined) this.pendingServerRequests.delete(String(requestId));
      }
      this.trackNotification(message);
      this.emit("notification", message);
    }
  }

  trackNotification(message) {
    const params = message.params || {};
    const threadId = params.threadId || params.thread?.id;
    if ((message.method === "thread/closed" || message.method === "thread/status/changed" && params.status?.type === "notLoaded") && threadId) {
      this.subscribedThreads.delete(threadId);
      this.activeTurns.delete(threadId);
    }
    if (message.method === "turn/started" && threadId && params.turn?.id) this.activeTurns.set(threadId, params.turn.id);
    if ([
      "turn/completed",
      "turn/failed",
      "turn/interrupted",
      "turn/cancelled",
    ].includes(message.method) && threadId) {
      const turnId = params.turn?.id || params.turnId;
      if (!turnId || this.activeTurns.get(threadId) === turnId) this.activeTurns.delete(threadId);
    }
  }

  request(method, params = {}) {
    return this.ensureConnected().then(() => this.sendRequest(method, params));
  }

  sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = String(this.nextId++);
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        // A timed-out write may still finish upstream; never replay it automatically.
        reject(new CodexError(`Codex ${method} timed out; its result is unconfirmed`, { code: "CODEX_REQUEST_TIMEOUT" }));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }

  listModels() {
    return listAllModels((method, params) => this.request(method, params));
  }

  notify(method, params = {}) {
    if (!this.socket || this.socket.closed) throw new CodexError("Managed Codex app-server connection is closed");
    this.socket.send(JSON.stringify({ method, params }));
  }

  respondServerRequest(id, result) {
    if (!this.socket || this.socket.closed) throw new CodexError("Managed Codex app-server connection is closed");
    const key = String(id);
    const request = this.pendingServerRequests.get(key);
    if (!request) throw new CodexError("Codex approval request is no longer pending");
    this.socket.send(JSON.stringify({ id: request.id, result }));
    this.pendingServerRequests.delete(key);
  }

  async subscribeThread(threadId) {
    await this.ensureConnected();
    await this.unsubscribeRequests.get(threadId)?.catch(() => {});
    if (this.subscribedThreads.has(threadId)) return;
    if (this.subscriptionRequests.has(threadId)) return this.subscriptionRequests.get(threadId);
    const request = this.request("thread/resume", { threadId, excludeTurns: true })
      .then((result) => {
        this.subscribedThreads.add(threadId);
        return result;
      })
      .finally(() => this.subscriptionRequests.delete(threadId));
    this.subscriptionRequests.set(threadId, request);
    return request;
  }

  unsubscribeThread(threadId, shouldRelease = () => true) {
    if (this.unsubscribeRequests.has(threadId)) return this.unsubscribeRequests.get(threadId);
    const request = (async () => {
      await this.subscriptionRequests.get(threadId)?.catch(() => {});
      if (!shouldRelease() || !this.subscribedThreads.has(threadId)) return;
      await this.request("thread/unsubscribe", { threadId });
      this.subscribedThreads.delete(threadId);
      this.activeTurns.delete(threadId);
    })().finally(() => this.unsubscribeRequests.delete(threadId));
    this.unsubscribeRequests.set(threadId, request);
    return request;
  }

  markThreadSubscribed(threadId) {
    this.subscribedThreads.add(threadId);
  }

  rejectPending(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  getActiveTurn(threadId) {
    return this.activeTurns.get(threadId);
  }

  setActiveTurn(threadId, turnId) {
    if (threadId && turnId) this.activeTurns.set(threadId, turnId);
  }

  clearActiveTurn(threadId) {
    this.activeTurns.delete(threadId);
  }

  closeProxy() {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    if (this.child && !this.child.killed) this.child.kill("SIGTERM");
    this.child = null;
    this.subscribedThreads.clear();
    this.subscriptionRequests.clear();
    this.unsubscribeRequests.clear();
    this.pendingServerRequests.clear();
    this.activeTurns.clear();
  }

  async stop() {
    this.stopped = true;
    this.rejectPending(new CodexError("Controller shutting down"));
    this.closeProxy();
  }
}
