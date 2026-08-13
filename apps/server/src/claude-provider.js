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
function configuredClaudePermissionMode(value) {
  const mode = String(value || "manual").trim();
  return ({ manual: "default", acceptEdits: "acceptEdits", plan: "plan", bypassPermissions: "bypassPermissions" })[mode] || "default";
}
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
function isRequestInterrupted(text) {
  return /^\[request interrupted by user\]$/i.test(String(text || "").trim());
}
function isTaskNotification(event, text = "") {
  return event?.origin?.kind === "task-notification"
    || event?.promptSource === "sdk" && String(text).trim().startsWith("<task-notification>")
    || String(text).trim().startsWith("<task-notification>");
}
function preview(turns) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const item = (turns[index].items || []).find((candidate) => candidate.type === "userMessage");
    const text = item?.content?.map((part) => part.text || "").join("").trim();
    if (text) return text.slice(0, 240);
  }
  return null;
}
function userMessageIDs(thread) {
  return (thread.turns || []).flatMap((turn) => turn.items || [])
    .filter((item) => item.type === "userMessage" && item.id)
    .map((item) => String(item.id));
}
function threadIdentityKeys(thread) {
  const keys = [];
  if (thread.claudeSessionId) keys.push(`session:${thread.claudeSessionId}`);
  // Claude can create several session files while resuming the same desktop
  // conversation. Stable user-event IDs identify those clones even though
  // their native session IDs differ. Include the shared two-event prefix so
  // a later fork may diverge at its third message without reappearing as a
  // duplicate row. Require two events to avoid collapsing unrelated
  // one-message conversations with identical prompts.
  const history = userMessageIDs(thread);
  if (history.length >= 2) keys.push(`history:${thread.cwd || ""}:${history.slice(0, 2).join(",")}`);
  return keys;
}
function dedupeThreads(threads) {
  const candidates = [...threads].sort((left, right) => {
    const activeDelta = Number(right.status?.type === "active") - Number(left.status?.type === "active");
    if (activeDelta) return activeDelta;
    const turnDelta = (right.turns?.length || 0) - (left.turns?.length || 0);
    if (turnDelta) return turnDelta;
    return (right.updatedAt || 0) - (left.updatedAt || 0);
  });
  const seen = new Set();
  const unique = candidates.filter((thread) => {
    const keys = threadIdentityKeys(thread);
    if (keys.some((key) => seen.has(key))) return false;
    keys.forEach((key) => seen.add(key));
    return true;
  });
  return unique.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
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
function toolCommandText(part) {
  const name = String(part?.name || "Claude tool").trim();
  const input = part?.input && typeof part.input === "object" ? part.input : {};
  const lower = name.toLowerCase();
  const value = (...keys) => keys.map((key) => input[key]).find((candidate) => typeof candidate === "string" && candidate.trim())?.trim() || "";
  if (lower === "bash" || lower === "shell" || lower === "shellcommand") return value("command", "cmd") || name;
  if (lower === "read") return `read ${value("file_path", "path", "file") || "files"}`;
  if (lower === "glob") return `search ${value("pattern", "path") || "workspace"}`;
  if (lower === "grep") return `search ${value("pattern", "query") || "workspace"}`;
  if (lower === "webfetch" || lower === "websearch" || lower === "browser") return `browse ${value("url", "query", "q") || "web"}`;
  if (lower === "edit" || lower === "write" || lower === "notebookedit") return `edit ${value("file_path", "path", "notebook_path", "file") || "files"}`;
  if (lower === "task" || lower === "agent") return `agent ${value("description", "prompt") || "task"}`;
  if (lower === "skill") return `skill ${value("skill") || "task"}`;
  return name.toLowerCase();
}
function toolUseCommands(event) {
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  return content
    .filter((part) => part?.type === "tool_use")
    .map((part) => ({
      id: part.id || crypto.randomUUID(),
      name: part.name || "Claude tool",
      command: toolCommandText(part),
    }))
    .filter((tool) => tool.command);
}
function toolActivity(command) {
  const operation = String(command || "").trim().split(/\s+/, 1)[0].toLowerCase();
  if (["read", "search", "browse", "glob", "grep", "ls", "list"].includes(operation)) return "explored";
  if (operation === "edit") return "edited";
  return commandActivity(command);
}
function thinkingTexts(event) {
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  return content
    .filter((part) => part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim())
    .map((part) => ({ id: part.signature ? `claude-thinking-${part.signature.slice(0, 16)}` : crypto.randomUUID(), text: part.thinking.trim() }));
}
function claudeUsageFromEvent(event, timestamp = now()) {
  const usage = event?.usage || event?.message?.usage;
  if (!usage || typeof usage !== "object") return null;
  const input = Number(usage.input_tokens ?? usage.inputTokens);
  const cached = Number(usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? usage.cachedInputTokens);
  const output = Number(usage.output_tokens ?? usage.outputTokens);
  if (![input, cached, output].some((value) => Number.isFinite(value) && value >= 0)) return null;
  const safeInput = Number.isFinite(input) ? input : 0;
  const safeCached = Number.isFinite(cached) ? cached : 0;
  const safeOutput = Number.isFinite(output) ? output : 0;
  return { last: { input_tokens: safeInput, cached_input_tokens: safeCached, output_tokens: safeOutput, total_tokens: safeInput + safeCached + safeOutput }, model_context_window: Number(event.model_context_window || event.modelContextWindow) || 200000, updatedAt: timestamp };
}
function desktopConfigRoot() {
  if (process.platform !== "darwin") return null;
  return path.join(os.homedir(), "Library", "Application Support", "Claude-3p", "configLibrary");
}

function normalizeDesktopModel(value) {
  if (!value || typeof value !== "object") return null;
  const name = String(value.name || value.id || "").trim();
  if (!name) return null;
  return {
    name,
    labelOverride: String(value.labelOverride || value.displayName || "").trim() || null,
    supports1m: value.supports1m === true,
  };
}

// Claude Desktop stores the model selector entries in the applied 3p profile.
// This is the closest representation of what its UI can actually select.
async function readDesktopModelChoices() {
  const root = desktopConfigRoot();
  if (!root) return [];
  let ids = [];
  try {
    const meta = JSON.parse(await fs.readFile(path.join(root, "_meta.json"), "utf8"));
    if (meta.appliedId) ids.push(String(meta.appliedId));
    ids.push(...(Array.isArray(meta.entries) ? meta.entries.map((entry) => entry?.id).filter(Boolean) : []));
  } catch {}
  if (!ids.length) {
    try { ids = (await fs.readdir(root)).filter((name) => name.endsWith(".json") && name !== "_meta.json").map((name) => name.slice(0, -5)); } catch { return []; }
  }
  const seenFiles = new Set();
  const models = [];
  for (const id of ids) {
    const file = path.join(root, `${id}.json`);
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    try {
      const profile = JSON.parse(await fs.readFile(file, "utf8"));
      if (!Array.isArray(profile.inferenceModels)) continue;
      for (const entry of profile.inferenceModels) {
        const model = normalizeDesktopModel(entry);
        if (model) models.push(model);
      }
      if (models.length && id === String(ids[0])) break;
    } catch {}
  }
  // Preserve duplicate provider mappings when the Desktop tiers point at the
  // same upstream model, but avoid duplicate rows in a malformed profile.
  const seen = new Set();
  return models.filter((model) => {
    const key = `${model.name}\u0000${model.labelOverride || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function readGatewayModelChoices() {
  if (typeof fetch !== "function" || process.env.CLAUDE_GATEWAY_MODEL_DISCOVERY === "0") return [];
  const root = desktopConfigRoot();
  if (!root) return [];
  let profile;
  try {
    const meta = JSON.parse(await fs.readFile(path.join(root, "_meta.json"), "utf8"));
    if (!meta.appliedId) return [];
    profile = JSON.parse(await fs.readFile(path.join(root, `${meta.appliedId}.json`), "utf8"));
  } catch { return []; }
  const base = String(profile.inferenceGatewayBaseUrl || "").replace(/\/+$/, "");
  if (!base) return [];
  const headers = {};
  const key = profile.inferenceGatewayApiKey;
  if (key) headers[profile.inferenceGatewayAuthScheme === "bearer" ? "authorization" : "x-api-key"] = profile.inferenceGatewayAuthScheme === "bearer" ? `Bearer ${key}` : key;
  try {
    const response = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(4000) });
    if (!response.ok) return [];
    const payload = await response.json();
    const values = Array.isArray(payload) ? payload : payload.data;
    return Array.isArray(values) ? values.map(normalizeDesktopModel).filter(Boolean) : [];
  } catch { return []; }
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
          if (imported.name) existing.name = imported.name;
          if (imported.cwd) existing.cwd = imported.cwd;
          if (imported.effort) existing.effort = imported.effort;
          if (imported.usage) existing.usage = imported.usage;
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
    let name = null;
    let usage = null;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      cwd ||= event.cwd || null;
      const eventModel = event.model || event.message?.model || null;
      if (usableSessionModel(eventModel)) model = eventModel;
      usage = claudeUsageFromEvent(event, Date.parse(event.timestamp || "") / 1000 || now()) || usage;
      effort ||= event.effort || null;
      const type = event.type;
      if (type === "custom-title" && typeof event.customTitle === "string" && event.customTitle.trim()) {
        name = event.customTitle.trim();
        continue;
      }
      if (!name && type === "ai-title" && typeof event.aiTitle === "string" && event.aiTitle.trim()) {
        name = event.aiTitle.trim();
        continue;
      }
      const isLocalCommand = type === "system" && event.subtype === "local_command";
      let text = event.message
        ? contentText(event.message.content).trim()
        : isLocalCommand || event.type === "result" ? String(event.content || event.result || "").trim() : "";
      if (isTaskNotification(event, text)) continue;
      if (event.isMeta === true || (!["user", "assistant", "result"].includes(type) && !isLocalCommand)) continue;
      if (isRequestInterrupted(text)) {
        if (!current) {
          const turnID = `claude-turn-${event.uuid || crypto.randomUUID()}`;
          current = { id: turnID, status: "interrupted", startedAt: Date.parse(event.timestamp || "") / 1000 || now(), items: [] };
          turns.push(current);
        }
        current.status = "interrupted";
        current.completedAt = Date.parse(event.timestamp || "") / 1000 || now();
        continue;
      }
      const commands = type === "assistant" ? toolUseCommands(event) : [];
      const thinking = type === "assistant" ? thinkingTexts(event) : [];
      for (const thought of thinking) {
        const turnID = current?.id || `claude-turn-${event.uuid || crypto.randomUUID()}`;
        if (!current) {
          current = { id: turnID, status: "completed", startedAt: Date.parse(event.timestamp || "") / 1000 || now(), items: [] };
          turns.push(current);
        }
        current.items.push({ id: thought.id, type: "thinking", text: thought.text, activity: "thinking", status: "completed", createdAt: Date.parse(event.timestamp || "") / 1000 || now() });
      }
      for (const tool of commands) {
        const turnID = current?.id || `claude-turn-${event.uuid || crypto.randomUUID()}`;
        if (!current) {
          current = { id: turnID, status: "completed", startedAt: Date.parse(event.timestamp || "") / 1000 || now(), items: [] };
          turns.push(current);
        }
        current.items.push({ id: tool.id, type: "commandExecution", command: tool.command, activity: toolActivity(tool.command), status: "completed", createdAt: Date.parse(event.timestamp || "") / 1000 || now() });
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
    return { id: sessionID, claudeSessionId: sessionID, name, cwd: cwd || config.defaultCwd, model, effort, usage, createdAt: turns[0].startedAt, updatedAt: stat.mtimeMs / 1000, archived: false, status: { type: "idle" }, turns };
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
    const explicitModelList = config.claudeModels.length > 0;
    const desktopModels = await readDesktopModelChoices();
    // Desktop's applied profile is authoritative. Gateway discovery is useful
    // for deployments that do not persist inferenceModels locally, but must
    // never replace the four explicitly configured Desktop selector entries.
    const gatewayModels = desktopModels.length ? [] : await readGatewayModelChoices();
    const sessionModels = explicitModelList ? [] : state.threads
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
    const desktopOrGateway = [...desktopModels, ...gatewayModels];
    const models = desktopOrGateway.length
      ? desktopOrGateway.map((model) => model.name)
      : [...new Set([
        ...config.claudeModels,
        ...sessionModels,
        ...configuredModels,
      ].map((model) => String(model).trim()).filter(Boolean))];
    if (!models.length) models.push(config.claudeDefaultModel || "claude-code-default");
    const desktopByName = new Map(desktopOrGateway.map((model) => [model.name, model]));
    const mapped = desktopOrGateway.length ? [] : Object.entries(tierMappings).map(([tier, actual]) => ({
      id: tier, model: actual, provider: "claude", displayName: `${tier} (${actual})`,
      isDefault: configuredDefault === tier, hidden: false,
      supportedReasoningEfforts: ["low", "medium", "high", "max"], defaultReasoningEffort: "medium",
    }));
    const mappedIDs = new Set(mapped.map((entry) => entry.id));
    const generic = models.filter((model, index, all) => !mappedIDs.has(model) && all.indexOf(model) === index).map((model) => {
      const desktop = desktopByName.get(model);
      const displayName = desktop?.labelOverride ? `${model} (${desktop.labelOverride})` : model;
      return {
      id: model,
      model,
      provider: "claude",
      displayName,
      isDefault: configuredDefault === model || (!configuredDefault && model === models[0]),
      hidden: false,
      supportedReasoningEfforts: ["low", "medium", "high", "max"],
      defaultReasoningEffort: "medium",
      supports1m: desktop?.supports1m === true,
    };
    });
    const data = [...mapped, ...generic];
    if (!data.some((entry) => entry.isDefault)) data[0].isDefault = true;
    return { data };
  }

  summary(thread) {
    return { id: thread.id, name: thread.name || null, preview: preview(thread.turns || []), cwd: thread.cwd, model: thread.model || null, usage: thread.usage || null, provider: "claude", modelProvider: "claude", createdAt: thread.createdAt, updatedAt: thread.updatedAt, syncRevision: String(thread.updatedAt || 0), source: "claude-code", threadSource: "cloudex-claude", status: thread.status || { type: "idle" }, canAcceptDirectInput: thread.status?.type !== "active" };
  }

  async listThreads({ archived = false } = {}) {
    const state = await this.load();
    await this.importSessions(state);
    const threads = state.threads.filter((thread) => Boolean(thread.archived) === archived);
    return dedupeThreads(threads).map((thread) => this.summary(thread));
  }
  async readThread(id) { const state = await this.load(); await this.importSessions(state); const thread = state.threads.find((candidate) => candidate.id === id); if (!thread) { const error = new Error("Claude Code session was not found"); error.status = 404; throw error; } return { thread: this.summary(thread), turns: thread.turns || [] }; }
  async hasThread(id) { try { await this.readThread(id); return true; } catch { return false; } }

  async startThread({ cwd, prompt, files = [], model = null, effort = null, permissionMode = "manual", onEvent }) {
    if (!String(prompt || "").trim()) { const error = new Error("prompt is required in Claude Code mode"); error.status = 422; throw error; }
    const thread = { id: `claude-${crypto.randomUUID()}`, cwd: cwd || config.defaultCwd, model: model || config.claudeDefaultModel, effort, claudeSessionId: null, createdAt: now(), updatedAt: now(), archived: false, status: { type: "active" }, turns: [] };
    (await this.load()).threads.push(thread);
    // Return the created turn immediately. The child process publishes its
    // progress through the thread SSE stream while it continues running.
    void this.beginTurn(thread, { prompt, files, model, effort, permissionMode, onEvent }).catch((error) => {
      const turn = thread.turns.at(-1);
      if (turn) { turn.status = "failed"; turn.error = { message: error.message || "Claude Code failed to start" }; }
      thread.status = { type: "idle" };
      void this.persist();
      onEvent?.({ method: "turn/failed", params: { threadId: thread.id, turnId: turn?.id, turn: { id: turn?.id, status: "failed", error: turn?.error } } });
    });
    return { thread: this.summary(thread), turn: thread.turns.at(-1) };
  }

  async sendMessage(id, { prompt, files = [], model = null, effort = null, permissionMode = "manual", onEvent }) {
    const state = await this.load();
    const thread = state.threads.find((candidate) => candidate.id === id && !candidate.archived);
    if (!thread) { const error = new Error("Claude Code session was not found"); error.status = 404; throw error; }
    if (thread.status?.type === "active") { const error = new Error("Claude Code is still running for this session"); error.status = 409; throw error; }
    thread.model = model || thread.model;
    thread.effort = effort || thread.effort;
    // Do not hold the HTTP request open until Claude exits; clients need the
    // response in order to subscribe and receive live item updates.
    void this.beginTurn(thread, { prompt, files, model: thread.model, effort: thread.effort, permissionMode, onEvent }).catch((error) => {
      const turn = thread.turns.at(-1);
      if (turn) { turn.status = "failed"; turn.error = { message: error.message || "Claude Code failed to start" }; }
      thread.status = { type: "idle" };
      void this.persist();
      onEvent?.({ method: "turn/failed", params: { threadId: thread.id, turnId: turn?.id, turn: { id: turn?.id, status: "failed", error: turn?.error } } });
    });
    return { thread: this.summary(thread), turn: thread.turns.at(-1) };
  }

  async beginTurn(thread, { prompt, files, model, effort, permissionMode = "manual", onEvent }) {
    const turn = { id: `claude-turn-${crypto.randomUUID()}`, status: "inProgress", startedAt: now(), items: [{ id: `claude-user-${crypto.randomUUID()}`, type: "userMessage", content: [{ type: "text", text: files.length ? `${prompt}\n\nAttached local files:\n${files.map((file) => `- ${file.path || file}`).join("\n")}` : prompt }] }] };
    thread.turns.push(turn); thread.status = { type: "active" }; thread.updatedAt = now(); await this.persist();
    onEvent?.({ method: "turn/started", params: { threadId: thread.id, turnId: turn.id, turn: { id: turn.id } } });
    const args = [...words(config.claudeCommandArgs)];
    if (thread.claudeSessionId) args.push(...words(config.claudeResumeArgs).map((arg) => arg.replaceAll("{sessionId}", thread.claudeSessionId)));
    if (configuredModel(model)) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    args.push("--permission-mode", configuredClaudePermissionMode(permissionMode));
    args.push("--", prompt);
    const child = spawn(config.claudeBin, args, { cwd: thread.cwd || config.defaultCwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    this.children.set(thread.id, child);
    let buffer = ""; let stderr = ""; let assistant = null;
  const append = async (text) => { if (!text || isSyntheticNoResponse(text) || isLocalCommandText(text)) return; assistant ||= { id: `claude-agent-${crypto.randomUUID()}`, type: "agentMessage", text: "", phase: "commentary", createdAt: now() }; if (!turn.items.includes(assistant)) turn.items.push(assistant); assistant.text += text; thread.updatedAt = now(); await this.persist(); onEvent?.({ method: "item/updated", params: { threadId: thread.id, turnId: turn.id, itemId: assistant.id, item: assistant } }); };
  const appendCommand = async (tool) => { const item = { id: tool.id || `claude-command-${crypto.randomUUID()}`, type: "commandExecution", command: tool.command, activity: toolActivity(tool.command), status: "completed", createdAt: now() }; turn.items.push(item); thread.updatedAt = now(); await this.persist(); onEvent?.({ method: "item/updated", params: { threadId: thread.id, turnId: turn.id, itemId: item.id, item } }); };
  const appendThinking = async (thought) => { const item = { id: thought.id || `claude-thinking-${crypto.randomUUID()}`, type: "thinking", text: thought.text, activity: "thinking", status: "completed", createdAt: now() }; turn.items.push(item); thread.updatedAt = now(); await this.persist(); onEvent?.({ method: "item/updated", params: { threadId: thread.id, turnId: turn.id, itemId: item.id, item } }); };
  child.stdout.on("data", (chunk) => { buffer += chunk.toString(); while (buffer.includes("\n")) { const index = buffer.indexOf("\n"); const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1); if (!line) continue; try { const event = JSON.parse(line); if (event.session_id && !thread.claudeSessionId) { thread.claudeSessionId = String(event.session_id); } const raw = eventText(event); if (isTaskNotification(event, raw)) continue; if (isRequestInterrupted(raw)) { turn.status = "interrupted"; turn.completedAt = now(); thread.status = { type: "idle" }; thread.updatedAt = now(); void this.persist(); onEvent?.({ method: "turn/interrupted", params: { threadId: thread.id, turnId: turn.id, turn: { id: turn.id, status: "interrupted" } } }); continue; } const thinking = thinkingTexts(event); const tools = toolUseCommands(event); thinking.forEach((thought) => appendThinking(thought)); tools.forEach((tool) => appendCommand(tool)); if (isTool(event) && !tools.length) { append(`\n${commandActivity(event.name || event.tool_name || "Claude tool")}\n`); } else if (!tools.length && !thinking.length) { if (event.type === "system" && event.subtype === "local_command" && /<command-name>/i.test(raw)) continue; const output = localCommandOutput(event.content || event.message?.content); const text = output ? `${output}\n` : (/<command-name>/i.test(raw) ? normalizeCommandText(raw) : raw); if (!isLocalCommandText(raw) && !isSyntheticNoResponse(text)) append(text); } } catch { append(`${line}\n`); } } });
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
