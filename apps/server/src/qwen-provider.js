import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { commandActivity } from "./cli-sessions.js";

function shellWords(value) {
  // Environment configuration intentionally accepts only simple, whitespace
  // separated arguments. Paths with spaces should be supplied by a wrapper.
  return String(value || "").trim().split(/\s+/).filter(Boolean);
}

function now() { return Date.now() / 1000; }

function configuredModel(value) {
  return value && value !== "qwen-code-default" ? value : null;
}

function threadPreview(turns) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const item = (turns[index].items || []).find((candidate) => candidate.type === "userMessage");
    const text = item?.content?.map((part) => part.text || "").join("").trim();
    if (text) return text.slice(0, 240);
  }
  return null;
}

function textFromEvent(event) {
  if (event.event && typeof event.event === "object") {
    const nested = textFromEvent(event.event);
    if (nested) return nested;
  }
  const candidates = [
    event.text, event.delta, event.content, event.message?.content,
    event.message?.text, event.message?.parts, event.response?.text, event.result?.text,
    event.delta?.text, event.content?.text, event.data?.text,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value) return value;
    if (value && typeof value === "object" && typeof value.text === "string") return value.text;
    if (Array.isArray(value)) {
      const text = value.map((part) => part?.text || part?.content || "").join("");
      if (text) return text;
    }
  }
  return "";
}

function isFinalEvent(event) {
  return ["result", "completed", "turn.completed", "response.completed", "done"].includes(String(event.type || "").toLowerCase());
}

function isToolEvent(event) {
  if (event.event && typeof event.event === "object") return isToolEvent(event.event);
  const type = String(event.type || "").toLowerCase();
  return type.includes("tool") || type.includes("function_call") || type.includes("command");
}

function toolCommand(event) {
  if (event.event && typeof event.event === "object") return toolCommand(event.event);
  const name = event.tool_name || event.toolName || event.name || event.command || "tool";
  const input = event.arguments || event.parameters || event.input || event.command || "";
  const serialized = typeof input === "string" ? input : JSON.stringify(input);
  return serialized ? `${name} ${serialized}` : String(name);
}

export class QwenProvider {
  constructor({ stateFile = path.join(config.stateDir, "qwen-threads.json") } = {}) {
    this.stateFile = stateFile;
    this.state = null;
    this.loadPromise = null;
    this.writePromise = Promise.resolve();
    this.children = new Map();
  }

  async load() {
    if (this.state) return this.state;
    if (!this.loadPromise) {
      this.loadPromise = fs.readFile(this.stateFile, "utf8")
        .then((raw) => JSON.parse(raw))
        .catch(() => ({ version: 1, threads: [] }))
        .then((value) => {
          this.state = { version: 1, threads: Array.isArray(value.threads) ? value.threads : [] };
          return this.state;
        });
    }
    const state = await this.loadPromise;
    await this.importQwenSessions(state);
    return state;
  }

  async importQwenSessions(state) {
    let projects;
    try { projects = await fs.readdir(config.qwenSessionsDir, { withFileTypes: true }); } catch { return; }
    for (const project of projects.filter((entry) => entry.isDirectory())) {
      let files;
      try { files = await fs.readdir(path.join(config.qwenSessionsDir, project.name, "chats")); } catch { continue; }
      for (const name of files.filter((entry) => entry.endsWith(".jsonl"))) {
        const filePath = path.join(config.qwenSessionsDir, project.name, "chats", name);
        const sessionId = name.slice(0, -".jsonl".length);
        if (state.threads.some((thread) => thread.qwenSessionId === sessionId)) continue;
        const imported = await this.parseQwenSession(filePath, sessionId);
        if (imported) state.threads.push(imported);
      }
    }
  }

  async parseQwenSession(filePath, sessionId) {
    let raw;
    try { raw = await fs.readFile(filePath, "utf8"); } catch { return null; }
    const turns = [];
    let current = null;
    let cwd = null;
    let model = null;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      cwd ||= event.cwd || null;
      model ||= event.model || null;
      const type = String(event.type || "");
      const text = event.message?.parts?.map((part) => part.text || "").join("").trim();
      if (!text || !["user", "assistant"].includes(type)) continue;
      if (type === "user" || !current) {
        current = { id: `qwen-turn-${event.uuid || crypto.randomUUID()}`, status: "completed", startedAt: Date.parse(event.timestamp || "") / 1000 || now(), items: [] };
        turns.push(current);
      }
      current.items.push({
        id: event.uuid || crypto.randomUUID(),
        type: type === "user" ? "userMessage" : "agentMessage",
        ...(type === "user"
          ? { content: [{ type: "text", text }] }
          : { text, phase: "final_answer" }),
        createdAt: Date.parse(event.timestamp || "") / 1000 || now(),
      });
    }
    if (turns.length === 0) return null;
    const stat = await fs.stat(filePath).catch(() => ({ mtimeMs: Date.now() }));
    return {
      id: sessionId,
      qwenSessionId: sessionId,
      cwd: cwd || config.defaultCwd,
      model,
      createdAt: turns[0].startedAt,
      updatedAt: stat.mtimeMs / 1000,
      archived: false,
      status: { type: "idle" },
      turns,
    };
  }

  async persist() {
    await this.load();
    this.writePromise = this.writePromise.then(async () => {
      await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
      await fs.writeFile(this.stateFile, JSON.stringify(this.state, null, 2), "utf8");
    });
    await this.writePromise;
  }

  async listModels() {
    const models = config.qwenModels.length > 0 ? config.qwenModels : [config.qwenDefaultModel || "qwen-code-default"];
    return {
      data: models.map((model, index) => ({
        id: model,
        model,
        provider: "qwen",
        displayName: model,
        isDefault: index === 0,
        hidden: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
      })),
    };
  }

  async listThreads({ archived = false } = {}) {
    const state = await this.load();
    return state.threads
      .filter((thread) => Boolean(thread.archived) === archived)
      .map((thread) => this.summary(thread))
      .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
  }

  summary(thread) {
    return {
      id: thread.id,
      name: thread.name || null,
      preview: threadPreview(thread.turns || []),
      cwd: thread.cwd,
      model: thread.model || null,
      provider: "qwen",
      modelProvider: "qwen",
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      syncRevision: String(thread.updatedAt || 0),
      source: "qwen-code",
      threadSource: "cloudex-qwen",
      status: thread.status || { type: "idle" },
      canAcceptDirectInput: !(thread.status?.type === "active"),
    };
  }

  async readThread(threadId) {
    const state = await this.load();
    const thread = state.threads.find((candidate) => candidate.id === threadId);
    if (!thread) {
      const error = new Error("Qwen Code session was not found");
      error.status = 404;
      throw error;
    }
    return { thread: this.summary(thread), turns: thread.turns || [] };
  }

  async hasThread(threadId) {
    try {
      await this.readThread(threadId);
      return true;
    } catch {
      return false;
    }
  }

  async startThread({ cwd, prompt, files = [], model = null, onEvent = null } = {}) {
    if (!String(prompt || "").trim()) {
      const error = new Error("prompt is required in Qwen Code mode");
      error.status = 422;
      throw error;
    }
    const timestamp = now();
    const thread = {
      id: `qwen-${crypto.randomUUID()}`,
      cwd: cwd || config.defaultCwd,
      model: model || config.qwenDefaultModel,
      qwenSessionId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archived: false,
      status: { type: "active" },
      turns: [],
    };
    (await this.load()).threads.push(thread);
    await this.beginTurn(thread, { prompt, files, onEvent });
    return { thread: this.summary(thread), turn: thread.turns.at(-1) };
  }

  async sendMessage(threadId, { prompt, files = [], model = null, onEvent = null } = {}) {
    if (!String(prompt || "").trim()) {
      const error = new Error("message is required in Qwen Code mode");
      error.status = 422;
      throw error;
    }
    const state = await this.load();
    const thread = state.threads.find((candidate) => candidate.id === threadId && !candidate.archived);
    if (!thread) {
      const error = new Error("Qwen Code session was not found");
      error.status = 404;
      throw error;
    }
    if (thread.status?.type === "active") {
      const error = new Error("Qwen Code is still running for this session");
      error.status = 409;
      throw error;
    }
    if (model) thread.model = model;
    await this.beginTurn(thread, { prompt, files, onEvent });
    return { thread: this.summary(thread), turn: thread.turns.at(-1) };
  }

  async beginTurn(thread, { prompt, files, onEvent }) {
    const startedAt = now();
    const turn = {
      id: `qwen-turn-${crypto.randomUUID()}`,
      status: "inProgress",
      startedAt,
      items: [{
        id: `qwen-user-${crypto.randomUUID()}`,
        type: "userMessage",
        content: [{ type: "text", text: this.promptWithFiles(prompt, files) }],
        createdAt: startedAt,
      }],
    };
    thread.turns.push(turn);
    thread.status = { type: "active" };
    thread.updatedAt = startedAt;
    await this.persist();
    onEvent?.({ method: "turn/started", params: { threadId: thread.id, turnId: turn.id, turn: { id: turn.id } } });
    onEvent?.({ method: "item/started", params: { threadId: thread.id, turnId: turn.id, item: turn.items[0] } });
    this.runTurn(thread, turn, onEvent).catch(() => {});
  }

  promptWithFiles(prompt, files) {
    const attachments = files.map((file) => typeof file === "string" ? file : file?.path).filter(Boolean);
    return attachments.length ? `${prompt}\n\nAttached local files:\n${attachments.map((file) => `- ${file}`).join("\n")}` : prompt;
  }

  argsFor(thread, prompt) {
    const args = shellWords(config.qwenCommandArgs);
    if (thread.qwenSessionId) {
      for (const arg of shellWords(config.qwenResumeArgs)) {
        args.push(arg.replaceAll("{sessionId}", thread.qwenSessionId));
      }
    }
    if (configuredModel(thread.model)) args.push("--model", thread.model);
    if (config.qwenApprovalMode) args.push("--approval-mode", config.qwenApprovalMode);
    args.push(prompt);
    return args;
  }

  async runTurn(thread, turn, onEvent) {
    const prompt = turn.items[0].content[0].text;
    const child = spawn(config.qwenBin, this.argsFor(thread, prompt), {
      cwd: thread.cwd || config.defaultCwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    });
    this.children.set(thread.id, child);
    let stdout = "";
    let stderr = "";
    let assistant = null;
    const appendAssistant = async (text, { delta = false } = {}) => {
      if (!text) return;
      if (!assistant) {
        assistant = { id: `qwen-agent-${crypto.randomUUID()}`, type: "agentMessage", text: "", phase: "commentary", createdAt: now() };
        turn.items.push(assistant);
      }
      assistant.text = delta ? `${assistant.text}${text}` : text;
      thread.updatedAt = now();
      await this.persist();
      onEvent?.({ method: "item/updated", params: { threadId: thread.id, turnId: turn.id, itemId: assistant.id, item: assistant } });
    };
    const handleEvent = async (event) => {
      if (!event || typeof event !== "object") return;
      if (event.session_id && !thread.qwenSessionId) {
        thread.qwenSessionId = String(event.session_id);
        await this.persist();
      }
      if (event.event && typeof event.event === "object") {
        await handleEvent(event.event);
        return;
      }
      const type = String(event.type || "").toLowerCase();
      if (isToolEvent(event)) {
        const item = {
          id: `qwen-tool-${event.id || crypto.randomUUID()}`,
          type: "commandExecution",
          command: toolCommand(event),
          activity: commandActivity(toolCommand(event)),
          status: type.includes("result") || type.includes("completed") ? "completed" : "inProgress",
          createdAt: now(),
        };
        turn.items.push(item);
        await this.persist();
        onEvent?.({ method: item.status === "completed" ? "item/completed" : "item/started", params: { threadId: thread.id, turnId: turn.id, itemId: item.id, item } });
        return;
      }
      const text = textFromEvent(event);
      if (text) await appendAssistant(text, { delta: type.includes("delta") || type.includes("chunk") });
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      let index;
      while ((index = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, index).trim();
        stdout = stdout.slice(index + 1);
        if (!line) continue;
        try { handleEvent(JSON.parse(line)); } catch { appendAssistant(`${line}\n`, { delta: true }); }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const result = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    if (stdout.trim()) {
      try { await handleEvent(JSON.parse(stdout.trim())); } catch { await appendAssistant(stdout, { delta: true }); }
    }
    this.children.delete(thread.id);
    if (turn.status === "interrupted") return;
    turn.completedAt = now();
    turn.durationMs = Math.round((turn.completedAt - turn.startedAt) * 1000);
    if (result.code === 0) {
      if (assistant) assistant.phase = "final_answer";
      turn.status = "completed";
      thread.status = { type: "idle" };
      onEvent?.({ method: "turn/completed", params: { threadId: thread.id, turnId: turn.id, turn: { id: turn.id, status: "completed" } } });
    } else {
      const message = stderr.trim() || `Qwen Code exited (${result.code ?? result.signal})`;
      turn.status = "failed";
      turn.error = { message };
      thread.status = { type: "idle" };
      onEvent?.({ method: "turn/failed", params: { threadId: thread.id, turnId: turn.id, turn: { id: turn.id, status: "failed", error: { message } }, error: { message } } });
    }
    thread.updatedAt = now();
    await this.persist();
  }

  async stopThread(threadId) {
    const child = this.children.get(threadId);
    if (!child || child.exitCode !== null || child.signalCode !== null) return false;
    child.kill("SIGTERM");
    const { thread, turns } = await this.readThread(threadId);
    const state = await this.load();
    const stored = state.threads.find((candidate) => candidate.id === thread.id);
    const turn = turns.at(-1);
    if (stored && turn) {
      turn.status = "interrupted";
      turn.completedAt = now();
      stored.status = { type: "idle" };
      stored.updatedAt = now();
      await this.persist();
    }
    return true;
  }

  async archiveThread(threadId) {
    const state = await this.load();
    const thread = state.threads.find((candidate) => candidate.id === threadId);
    if (!thread) {
      const error = new Error("Qwen Code session was not found");
      error.status = 404;
      throw error;
    }
    thread.archived = true;
    thread.updatedAt = now();
    await this.persist();
    return { archived: true, threadId };
  }

  async stop() {
    for (const child of this.children.values()) child.kill("SIGTERM");
    this.children.clear();
  }
}
