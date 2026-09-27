import fs from "node:fs/promises";
import path from "node:path";

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const terminal = new Set(["completed", "failed", "interrupted", "cancelled", "canceled"]);

// One journal per controller. Per-thread workers never dispatch two turns concurrently.
export class MessageQueue {
  constructor({ file, send, inspect, changed = () => {} }) {
    this.file = file; this.send = send; this.inspect = inspect; this.changed = changed;
    this.state = { threads: {} }; this.serial = Promise.resolve(); this.workers = new Map();
    this.loaded = null;
  }
  load() {
    return this.loaded ||= (async () => {
      try {
        const state = JSON.parse(await fs.readFile(this.file, "utf8"));
        if (!state?.threads || typeof state.threads !== "object") throw new Error("Invalid queue journal");
        this.state = state;
        for (const thread of Object.values(this.state.threads)) {
          for (const item of thread.items) if (item.status === "dispatching") {
            item.status = "unconfirmed"; item.error = "服务器在发送期间重启，请先核对会话"; thread.paused = true;
          }
        }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    })();
  }
  async mutate(threadId, change) {
    if (typeof threadId !== "string" || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(threadId) || ["__proto__", "constructor", "prototype"].includes(threadId)) throw fail("Invalid thread ID", 422);
    await this.load();
    const operation = this.serial.then(async () => {
      const next = structuredClone(this.state);
      const thread = next.threads[threadId] ||= { paused: false, items: [] };
      change(thread);
      thread.revision = (thread.revision || 0) + 1;
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await fs.rename(temporary, this.file);
      this.state = next;
      const snapshot = this.snapshot(threadId);
      this.changed(threadId, snapshot);
      return snapshot;
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
  snapshot(threadId) { return structuredClone(this.state.threads[threadId] || { paused: false, items: [] }); }
  async list(threadId) { await this.load(); await this.serial; return this.snapshot(threadId); }
  async add(threadId, data) {
    if (typeof data.id !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(data.id)) throw fail("A stable message ID is required", 422);
    if (typeof data.message !== "string" || !data.message.trim() || data.message.length > 100000) throw fail("Invalid queued message", 422);
    const snapshot = await this.mutate(threadId, thread => {
      if (thread.items.some(item => item.id === data.id)) return; // Retry acknowledges the original snapshot.
      if (thread.items.filter(item => !["completed", "cancelled"].includes(item.status)).length >= 100) throw fail("Queue limit is 100 messages", 422);
      thread.items.push({ id: data.id, body: structuredClone(data), status: "pending", createdAt: Date.now(), turnId: null, error: null });
    });
    this.kick(threadId);
    return snapshot;
  }
  async update(threadId, data) {
    const result = await this.mutate(threadId, thread => {
      if (data.action === "pause") { thread.paused = true; return; }
      if (data.action === "resume") {
        if (thread.items.some(item => item.status === "unconfirmed")) throw fail("先核对待确认消息；不能自动重发");
        thread.paused = false;
        for (const item of thread.items) if (item.status === "blocked") { item.status = "pending"; item.error = null; }
        return;
      }
      const index = thread.items.findIndex(item => item.id === data.id);
      const item = thread.items[index];
      if (!item && data.action === "cancel" && /^[a-zA-Z0-9-]{8,80}$/.test(data.id || "")) {
        thread.items.push({ id: data.id, body: { message: String(data.message || "") }, status: "cancelled", createdAt: Date.now(), turnId: null });
        return;
      }
      if (!item) throw fail("Queued message not found", 404);
      if (data.action === "cancel" && item.status === "cancelled") return;
      if (["running", "dispatching", "completed", "cancelled"].includes(item.status)) throw fail("This message is no longer editable");
      if (data.action === "cancel") { item.status = "cancelled"; return; }
      if (item.status === "failed") throw fail("失败消息只能移除；需要重试时请新建消息");
      if (item.status === "unconfirmed") throw fail("发送结果待确认，请先核对会话；取消只会停止追踪，不撤销已发送消息");
      if (data.action === "edit") {
        if (typeof data.message !== "string" || !data.message.trim() || data.message.length > 100000) throw fail("Invalid message", 422);
        item.body.message = data.message;
      } else if (data.action === "up") {
        const previous = thread.items.findLastIndex((value, i) => i < index && ["pending", "blocked"].includes(value.status));
        if (previous >= 0) [thread.items[index], thread.items[previous]] = [thread.items[previous], thread.items[index]];
      } else throw fail("Unsupported queue action", 422);
    });
    this.kick(threadId); return result;
  }
  kick(threadId) {
    if (this.workers.has(threadId)) return this.workers.get(threadId);
    const worker = this.step(threadId).catch(error => console.warn("Queue:", error.message)).finally(() => this.workers.delete(threadId));
    this.workers.set(threadId, worker); return worker;
  }
  async tick() {
    await this.load();
    await Promise.all(Object.keys(this.state.threads).map(id => this.kick(id)));
  }
  async step(threadId) {
    let thread = await this.list(threadId);
    if (!thread.items.some(item => ["pending", "running"].includes(item.status))) return;
    const running = thread.items.find(item => item.status === "running");
    if (!running && (thread.paused || thread.items.some(item => ["dispatching", "unconfirmed", "blocked"].includes(item.status)))) return;
    const detail = await this.inspect(threadId);
    if (running) {
      const turn = detail.turns?.find(turn => turn.id === running.turnId);
      if (turn && terminal.has(turn.status)) await this.finish(threadId, turn.id, turn.status);
      return;
    }
    if (thread.paused || thread.items.some(item => ["dispatching", "unconfirmed", "blocked"].includes(item.status))) return;
    if (detail.busy || detail.thread?.status?.type === "active" || detail.turns?.some(turn => turn.status === "inProgress")) return;
    let claimed;
    await this.mutate(threadId, current => {
      if (current.paused || current.items.some(item => ["running", "dispatching", "unconfirmed", "blocked"].includes(item.status))) return;
      const item = current.items.find(item => item.status === "pending");
      if (!item) return;
      item.status = "dispatching"; claimed = structuredClone(item);
    });
    if (!claimed) return;
    try {
      const result = await this.send(threadId, { ...claimed.body, clientUserMessageId: claimed.id });
      const turn = result.turn;
      if (!turn?.id) throw new Error("发送结果缺少轮次 ID，请核对会话");
      await this.mutate(threadId, current => {
        const item = current.items.find(item => item.id === claimed.id);
        item.status = "running"; item.turnId = turn.id;
      });
      if (terminal.has(turn.status)) await this.finish(threadId, turn.id, turn.status);
    } catch (error) {
      await this.mutate(threadId, current => {
        const item = current.items.find(item => item.id === claimed.id);
        // Transport errors can happen after Codex accepted the turn. Never retry them automatically.
        item.status = (error.status >= 400 && error.status < 500) || /active writer/i.test(error.message) ? "blocked" : "unconfirmed";
        item.error = error.message; current.paused = true;
      });
    }
  }
  async finish(threadId, turnId, status) {
    await this.load();
    if (!turnId || !terminal.has(status) || !this.state.threads[threadId]?.items.some(item => item.turnId === turnId && item.status === "running")) return;
    await this.mutate(threadId, thread => {
      const item = thread.items.find(item => item.turnId === turnId && item.status === "running");
      if (!item) return;
      item.status = status === "completed" ? "completed" : "failed";
      if (status !== "completed") { item.error = `任务${status}，后续队列已暂停`; thread.paused = true; }
    });
  }
}
