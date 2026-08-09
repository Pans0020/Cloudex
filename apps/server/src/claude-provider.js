import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { commandActivity } from "./cli-sessions.js";

function now() { return Date.now() / 1000; }
function words(value) { return String(value || "").trim().split(/\s+/).filter(Boolean); }
function configuredModel(value) { return value && value !== "claude-code-default" ? value : null; }
function usableSessionModel(value) {
  const model = configuredModel(value);
  return model && !/^<synthetic>$/i.test(model) ? model : null;
}
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.text || (part?.type === "text" ? part.text : "")).join("");
}
function isLocalCommandText(text) {
  const value = String(text || "").trim();
  return value.startsWith("<local-command-caveat>");
}
function localCommandOutput(text) {
  const match = String(text || "").match(/^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/i);
  return match ? match[1].replace(/\x1b\[[0-9;]*m/g, "").trim() : null;
}
function normalizeCommandText(text) {
  const match = String(text || "").match(/<command-name>\s*([^<]+?)\s*<\/command-name>/i);
  if (!match) return String(text || "");
  const command = match[1].trim();
  return command.startsWith("/") ? command : `/${command}`;
}
function isSyntheticNoResponse(text) {
  return String(text || "").trim().toLowerCase() === "no response requested.";
}
function preview(turns) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const item = (turns[index].items || []).find((candidate) => candidate.type === "userMessage");
    const text = item?.content?.map((part) => part.text || "").join("").trim();
    if (text) return text.slice(0, 240);
  }
  return null;
}
function eventText(event) {
  if (event.type === "assistant" || event.type === "user") {
    const text = contentText(event.message?.content);
    return localCommandOutput(text) ?? text;
  }
  const content = typeof event.content === "string" ? event.content : contentText(event.message?.content);
  return localCommandOutput(content) ?? (event.result || event.text || event.delta || content || "");
}
function isTool(event) {
  const type = String(event.type || "").toLowerCase();
  return type.includes("tool") || type.includes("command") || type === "assistant" && (event.message?.content || []).some((part) => part.type === "tool_use");
}
function toolUseCommands(event) {
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  return content
    .filter((part) => part?.type === "tool_use")
    .map((part) => ({
      id: part.id || crypto.randomUUID(),
      name: part.name || "Claude tool",
      command: typeof part.input?.command === "string" ? part.input.command : null,
    }))
    .filter((tool) => tool.command);
}
async function readCliModelChoices() {
  const args = ["--print", "--output-format", "json", "--no-session-persistence", "--", "/model"];
  return await new Promise((resolve) => {
    const child = spawn(config.claudeBin, args, { cwd: config.defaultCwd, stdio: ["ignore", "pipe", "ignore"], env: process.env });
    let output = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve([]); }, 15000);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", () => { clearTimeout(timer); resolve([]); });
    child.once("close", () => {
      clearTimeout(timer);
      let text = output;
      try { text = JSON.parse(output).result || text; } catch {}
      const match = String(text).match(/Available:\s*(.+?)(?:\.|$)/i);
      if (!match) return resolve([]);
      resolve(match[1].split(",").map((value) => value.trim()).filter((value) => value && !/^or a full model id$/i.test(value)));
    });
  });
}

export class ClaudeProvider {
  constructor({ stateFile = path.join(config.stateDir, "claude-threads.json") } = {}) {
    this.stateFile = stateFile;
    this.state = null;
    this.loadPromise = null;
    this.writePromise = Promise.resolve();
    this.children = new Map();
  }

  async load() {
    if (this.state) return this.state;
    this.loadPromise ||= fs.readFile(this.stateFile, "utf8")
      .then((raw) => JSON.parse(raw))
      .catch(() => ({ version: 1, threads: [] }))
      .then((value) => { this.state = { version: 1, threads: Array.isArray(value.threads) ? value.threads : [] }; return this.state; });
    const state = await this.loadPromise;
    await this.importSessions(state);
    return state;
  }

  async importSessions(state) {
    let projects;
    try { projects = await fs.readdir(config.claudeSessionsDir, { withFileTypes: true }); } catch { return; }
    for (const project of projects.filter((entry) => entry.isDirectory())) {
      let files;
      try { files = await fs.readdir(path.join(config.claudeSessionsDir, project.name)); } catch { continue; }
      for (const name of files.filter((entry) => entry.endsWith(".jsonl"))) {
        const sessionID = name.slice(0, -6);
        const imported = await this.parseSession(path.join(config.claudeSessionsDir, project.name, name), sessionID);
        if (!imported) continue;
        const existing = state.threads.find((thread) => thread.claudeSessionId === sessionID);
        if (!existing) {
          state.threads.push(imported);
        } else {
          const model = usableSessionModel(imported.model);
          if (model) existing.model = model;
          if (imported.cwd) existing.cwd = imported.cwd;
          if (imported.effort) existing.effort = imported.effort;
          if (!this.children.has(existing.id)) {
            existing.turns = imported.turns;
            existing.createdAt = imported.createdAt;
            existing.updatedAt = imported.updatedAt;
            existing.status = { type: "idle" };
          }
        }
      }
    }
  }

  async parseSession(filePath, sessionID) {
    let raw;
    try { raw = await fs.readFile(filePath, "utf8"); } catch { return null; }
    const turns = [];
    const turnIDs = new Set();
    let current = null;
    let cwd = null;
    let model = null;
    let effort = null;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      cwd ||= event.cwd || null;
      const eventModel = event.model || event.message?.model || null;
      if (usableSessionModel(eventModel)) model = eventModel;
      effort ||= event.effort || null;
      const type = event.type;
      const isLocalCommand = type === "system" && event.subtype === "local_command";
      let text = event.message
        ? contentText(event.message.content).trim()
        : isLocalCommand || event.type === "result" ? String(event.content || event.result || "").trim() : "";
      if (event.isMeta === true || (!["user", "assistant", "result"].includes(type) && !isLocalCommand)) continue;
      const commands = type === "assistant" ? toolUseCommands(event) : [];
      for (const tool of commands) {
        const turnID = current?.id || `claude-turn-${event.uuid || crypto.randomUUID()}`;
        if (!current) {
          current = { id: turnID, status: "completed", startedAt: Date.parse(event.timestamp || "") / 1000 || now(), items: [] };
          turns.push(current);
        }
        current.items.push({ id: tool.id, type: "commandExecution", command: tool.command, activity: "ran", status: "completed", createdAt: Date.parse(event.timestamp || "") / 1000 || now() });
      }
      if (!text) continue;
      const commandOutput = localCommandOutput(text);
      const commandName = /<command-name>/i.test(text);
      const normalizedType = commandOutput ? "assistant" : (commandName ? "user" : (type === "result" ? "assistant" : type));
      text = commandOutput ?? normalizeCommandText(text);
      if (isSyntheticNoResponse(text)) continue;
      if (normalizedType === "user" || !current) {
        let turnID = `claude-turn-${event.uuid || crypto.randomUUID()}`;
        while (turnIDs.has(turnID)) turnID = `claude-turn-${crypto.randomUUID()}`;
        turnIDs.add(turnID);
        current = { id: turnID, status: "completed", startedAt: Date.parse(event.timestamp || "") / 1000 || now(), items: [] };
        turns.push(current);
      }
      current.items.push({
        id: event.uuid || crypto.randomUUID(),
        type: normalizedType === "user" ? "userMessage" : "agentMessage",
        ...(normalizedType === "user" ? { content: [{ type: "text", text }] } : { text, phase: "final_answer" }),
        createdAt: Date.parse(event.timestamp || "") / 1000 || now(),
      });
    }
    if (!turns.length) return null;
    const stat = await fs.stat(filePath).catch(() => ({ mtimeMs: Date.now() }));
    return { id: sessionID, claudeSessionId: sessionID, cwd: cwd || config.defaultCwd, model, effort, createdAt: turns[0].startedAt, updatedAt: stat.mtimeMs / 1000, archived: false, status: { type: "idle" }, turns };
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
    const state = await this.load();
    await this.importSessions(state);
    const sessionModels = state.threads
      .map((thread) => usableSessionModel(thread.model))
      .filter(Boolean);
    let configuredModels = [];
    let tierMappings = {};
    let configuredDefault = null;
    try {
      const settings = JSON.parse(await fs.readFile(path.join(os.homedir(), ".claude", "settings.json"), "utf8"));
      if (typeof settings.model === "string" && settings.model.trim()) configuredDefault = settings.model.trim();
      const env = settings.env && typeof settings.env === "object" ? settings.env : {};
      for (const tier of ["haiku", "sonnet", "opus", "fable"]) {
        const key = `ANTHROPIC_DEFAULT_${tier.toUpperCase()}_MODEL_NAME`;
        if (typeof env[key] === "string" && env[key].trim()) tierMappings[tier] = env[key].trim();
      }
      configuredModels.push(...Object.keys(tierMappings));
    } catch {}
    const cliModels = await readCliModelChoices();
    const models = [...new Set([
      ...config.claudeModels,
      ...sessionModels,
      ...configuredModels,
      ...cliModels,
    ].map((model) => String(model).trim()).filter(Boolean))];
    if (!models.length) models.push(config.claudeDefaultModel || "claude-code-default");
    const mapped = Object.entries(tierMappings).map(([tier, actual]) => ({
      id: tier,
      model: actual,
      provider: "claude",
      displayName: `${tier} (${actual})`,
      isDefault: configuredDefault === tier,
      hidden: false,
      supportedReasoningEfforts: ["low", "medium", "high", "max"],
      defaultReasoningEffort: "medium",
    }));
    const mappedIDs = new Set(mapped.map((entry) => entry.id));
    const generic = models.filter((model) => !mappedIDs.has(model)).map((model) => ({
      id: model,
      model,
      provider: "claude",
      displayName: model,
      isDefault: !configuredDefault && model === models[0],
      hidden: false,
      supportedReasoningEfforts: ["low", "medium", "high", "max"],
      defaultReasoningEffort: "medium",
    }));
    const data = [...mapped, ...generic];
    if (!data.some((entry) => entry.isDefault)) data[0].isDefault = true;
    return { data };
  }

  summary(thread) {
    return { id: thread.id, name: thread.name || null, preview: preview(thread.turns || []), cwd: thread.cwd, model: thread.model || null, provider: "claude", modelProvider: "claude", createdAt: thread.createdAt, updatedAt: thread.updatedAt, syncRevision: String(thread.updatedAt || 0), source: "claude-code", threadSource: "cloudex-claude", status: thread.status || { type: "idle" }, canAcceptDirectInput: thread.status?.type !== "active" };
  }

  async listThreads({ archived = false } = {}) { const state = await this.load(); await this.importSessions(state); return state.threads.filter((thread) => Boolean(thread.archived) === archived).map((thread) => this.summary(thread)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); }
  async readThread(id) { const state = await this.load(); await this.importSessions(state); const thread = state.threads.find((candidate) => candidate.id === id); if (!thread) { const error = new Error("Claude Code session was not found"); error.status = 404; throw error; } return { thread: this.summary(thread), turns: thread.turns || [] }; }
  async hasThread(id) { try { await this.readThread(id); return true; } catch { return false; } }

  async startThread({ cwd, prompt, files = [], model = null, effort = null, onEvent }) {
    if (!String(prompt || "").trim()) { const error = new Error("prompt is required in Claude Code mode"); error.status = 422; throw error; }
    const thread = { id: `claude-${crypto.randomUUID()}`, cwd: cwd || config.defaultCwd, model: model || config.claudeDefaultModel, effort, claudeSessionId: null, createdAt: now(), updatedAt: now(), archived: false, status: { type: "active" }, turns: [] };
    (await this.load()).threads.push(thread);
    await this.beginTurn(thread, { prompt, files, model, effort, onEvent });
    return { thread: this.summary(thread), turn: thread.turns.at(-1) };
  }

  async sendMessage(id, { prompt, files = [], model = null, effort = null, onEvent }) {
    const state = await this.load();
    const thread = state.threads.find((candidate) => candidate.id === id && !candidate.archived);
    if (!thread) { const error = new Error("Claude Code session was not found"); error.status = 404; throw error; }
    if (thread.status?.type === "active") { const error = new Error("Claude Code is still running for this session"); error.status = 409; throw error; }
    thread.model = model || thread.model;
    thread.effort = effort || thread.effort;
    await this.beginTurn(thread, { prompt, files, model: thread.model, effort: thread.effort, onEvent });
    return { thread: this.summary(thread), turn: thread.turns.at(-1) };
  }

  async beginTurn(thread, { prompt, files, model, effort, onEvent }) {
    const turn = { id: `claude-turn-${crypto.randomUUID()}`, status: "inProgress", startedAt: now(), items: [{ id: `claude-user-${crypto.randomUUID()}`, type: "userMessage", content: [{ type: "text", text: files.length ? `${prompt}\n\nAttached local files:\n${files.map((file) => `- ${file.path || file}`).join("\n")}` : prompt }] }] };
    thread.turns.push(turn); thread.status = { type: "active" }; thread.updatedAt = now(); await this.persist();
    onEvent?.({ method: "turn/started", params: { threadId: thread.id, turnId: turn.id, turn: { id: turn.id } } });
    const args = [...words(config.claudeCommandArgs)];
    if (thread.claudeSessionId) args.push(...words(config.claudeResumeArgs).map((arg) => arg.replaceAll("{sessionId}", thread.claudeSessionId)));
    if (configuredModel(model)) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    args.push("--", prompt);
    const child = spawn(config.claudeBin, args, { cwd: thread.cwd || config.defaultCwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    this.children.set(thread.id, child);
    let buffer = ""; let stderr = ""; let assistant = null;
  const append = async (text) => { if (!text || isSyntheticNoResponse(text) || isLocalCommandText(text)) return; assistant ||= { id: `claude-agent-${crypto.randomUUID()}`, type: "agentMessage", text: "", phase: "commentary", createdAt: now() }; if (!turn.items.includes(assistant)) turn.items.push(assistant); assistant.text += text; thread.updatedAt = now(); await this.persist(); onEvent?.({ method: "item/updated", params: { threadId: thread.id, turnId: turn.id, itemId: assistant.id, item: assistant } }); };
  const appendCommand = async (tool) => { const item = { id: tool.id || `claude-command-${crypto.randomUUID()}`, type: "commandExecution", command: tool.command, activity: "ran", status: "completed", createdAt: now() }; turn.items.push(item); thread.updatedAt = now(); await this.persist(); onEvent?.({ method: "item/updated", params: { threadId: thread.id, turnId: turn.id, itemId: item.id, item } }); };
  child.stdout.on("data", (chunk) => { buffer += chunk.toString(); while (buffer.includes("\n")) { const index = buffer.indexOf("\n"); const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1); if (!line) continue; try { const event = JSON.parse(line); if (event.session_id && !thread.claudeSessionId) { thread.claudeSessionId = String(event.session_id); } const tools = toolUseCommands(event); if (tools.length) { tools.forEach((tool) => appendCommand(tool)); } if (isTool(event) && !tools.length) { append(`\n${commandActivity(event.name || event.tool_name || "Claude tool")}\n`); } else if (!tools.length) { const raw = eventText(event); if (event.type === "system" && event.subtype === "local_command" && /<command-name>/i.test(raw)) continue; const output = localCommandOutput(event.content || event.message?.content); const text = output ? `${output}\n` : (/<command-name>/i.test(raw) ? normalizeCommandText(raw) : raw); if (!isLocalCommandText(raw) && !isSyntheticNoResponse(text)) append(text); } } catch { append(`${line}\n`); } } });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const result = await new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
    });
    this.children.delete(thread.id); if (turn.status === "interrupted") return;
    turn.completedAt = now(); turn.status = result.code === 0 ? "completed" : "failed"; thread.status = { type: "idle" }; thread.updatedAt = now();
    if (assistant) assistant.phase = "final_answer";
    if (result.code !== 0) turn.error = { message: stderr.trim() || result.error?.message || `Claude Code exited (${result.code ?? result.signal})` };
    await this.persist(); onEvent?.({ method: result.code === 0 ? "turn/completed" : "turn/failed", params: { threadId: thread.id, turnId: turn.id, turn: { id: turn.id, status: turn.status } } });
  }

  async stopThread(id) { const child = this.children.get(id); if (!child) return false; child.kill("SIGTERM"); return true; }
  async archiveThread(id) { const thread = (await this.load()).threads.find((candidate) => candidate.id === id); if (!thread) { const error = new Error("Claude Code session was not found"); error.status = 404; throw error; } thread.archived = true; thread.updatedAt = now(); await this.persist(); return { archived: true, threadId: id }; }
  async stop() { for (const child of this.children.values()) child.kill("SIGTERM"); this.children.clear(); }
}
