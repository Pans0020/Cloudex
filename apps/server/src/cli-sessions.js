import os from "node:os";
import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { mediaAttachments } from "./media-attachments.js";
import crypto from "node:crypto";
import { config } from "./config.js";
import { agentStatus, threadRelationship } from "./thread-hierarchy.js";

const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_FILE_RE = new RegExp(`^rollout-.*-(${UUID_RE})(?:_(${UUID_RE}))?\\.jsonl$`, "i");
const ARCHIVE_FILE = path.join(config.stateDir, "archived-cli-threads.json");
const SESSION_INDEX_FILE = path.join(config.codexHome || path.join(os.homedir(), ".codex"), "session_index.jsonl");
const ARCHIVED_SESSION_DIR = process.env.CODEX_ARCHIVED_SESSIONS_DIR || path.join(path.dirname(config.codexSessionsDir), "archived_sessions");
const threadSummaryCache = new Map();
const detailCaches = new Map();
const detailReads = new Map();
const summaryReads = new Map();
let sessionFileSnapshot = null;
let sessionScan = null;
let sessionInventoryVersion = 0;
let sessionWatchCount = 0;
let archiveWrite = Promise.resolve();
let sessionIndexSignature = "";
let sessionIndexNames = new Map();
let sessionIndexRead = null;

async function readSessionIndexNames() {
  if (sessionIndexRead) return sessionIndexRead;
  sessionIndexRead = loadSessionIndexNames().finally(() => { sessionIndexRead = null; });
  return sessionIndexRead;
}

async function loadSessionIndexNames() {
  try {
    const stat = await fs.stat(SESSION_INDEX_FILE);
    const signature = `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`;
    if (signature === sessionIndexSignature) return sessionIndexNames;

    const names = new Map();
    const raw = await fs.readFile(SESSION_INDEX_FILE, "utf8");
    for (const line of raw.split("\n")) {
      const record = safeJson(line);
      const id = typeof record?.id === "string" ? record.id.trim() : "";
      const name = [record?.thread_name, record?.name, record?.title]
        .find((value) => typeof value === "string" && value.trim());
      if (id && name) names.set(id, name.trim());
    }
    sessionIndexSignature = signature;
    sessionIndexNames = names;
  } catch {
    sessionIndexSignature = "";
    sessionIndexNames = new Map();
  }
  return sessionIndexNames;
}

function timestampSeconds(value) {
  if (typeof value === "number") return value > 1_000_000_000_000 ? Math.floor(value / 1000) : value;
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function timestampPrecise(value) {
  if (typeof value === "number") return value > 1_000_000_000_000 ? value / 1000 : value;
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed / 1000 : 0;
}

function safeJson(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function redactCommand(command) {
  return String(command || "")
    .replace(/(Authorization:\s*Bearer\s+)[^'"\s]+/gi, "$1[REDACTED]")
    .replace(/\b(OPENAI_API_KEY|AUTH_TOKEN|CODEX_API_KEY)=(["'])?(?!\$\()[^\s"']+\2/gi, "$1=[REDACTED]");
}

function commandResult(output) {
  const value = String(output || "");
  const exitCodeMatch = value.match(/Process exited with code\s+(-?\d+)|Exit code:\s*(-?\d+)/i);
  const durationMatch = value.match(/Wall time:\s*([^\n\r]+)/i);
  const exitCode = exitCodeMatch ? Number(exitCodeMatch[1] ?? exitCodeMatch[2]) : null;
  let status = "completed";
  if (exitCode !== null) status = exitCode === 0 ? "completed" : "failed";
  else if (/Process running with session ID|Script running with cell ID/i.test(value)) status = "inProgress";
  return { status, exitCode, duration: durationMatch?.[1]?.trim() || null };
}

function jsStringProperty(source, property) {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(source || "").match(new RegExp(`(?:^|[,{\\s])['\"]?${escapedProperty}['\"]?\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`));
  if (!match) return null;
  const literal = match[1];
  if (literal.startsWith('"')) {
    try { return JSON.parse(literal); } catch { return null; }
  }
  return literal.slice(1, -1)
    .replace(/\\'/g, "'")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

function jsNumberProperty(source, property) {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(source || "").match(new RegExp(`(?:^|[,{\\s])['\"]?${escapedProperty}['\"]?\\s*:\\s*(\\d+)`));
  return match ? Number(match[1]) : null;
}

function jsAssignedString(source, variable) {
  const match = String(source || "").match(new RegExp(`\\b(?:const|let|var)\\s+${variable}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")`));
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

export function commandActivity(command) {
  const value = String(command || "").trim();
  const mutating = /(^|[;&|]\s*)(npm|npx|node|xcodebuild|make|kill|mv|cp|rm|mkdir|touch|chmod|git\s+(add|commit|push|pull|checkout|switch|restore|reset)|curl\b[^\n]*(--request|-X)\s*(POST|PUT|PATCH|DELETE))\b/i;
  if (mutating.test(value)) return "ran";
  const explored = /(^|[;&|]\s*|\b)(rg|grep|find|fd|ls|pwd|head|tail|cat|wc|stat|which|ps\s+aux|sed\s+-n|git\s+(status|diff|log|show)|command\s+-v)\b/i;
  return explored.test(value) ? "explored" : "ran";
}

function editedFiles(patch) {
  const sections = editedPatchSections(patch);
  return editedFilesFromSections(sections);
}

function editedFilesFromSections(sections) {
  if (sections.length === 0) return "files";
  return sections.map((section) => {
    const title = `${section.name} +${section.additions} -${section.deletions}`;
    if (section.snippets.length === 0) return title;
    return `${title}\n${section.snippets.join("\n")}`;
  }).join("\n");
}

function editedPatchSections(patch) {
  const sections = [];
  let current = null;
  for (const line of String(patch || "").split(/\r?\n/)) {
    const header = line.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/);
    if (header) {
    current = { name: path.basename(header[1].trim()), lines: [] };
    sections.push(current);
    continue;
  }
    if (!current || line.startsWith("*** ")) continue;
    if (line.startsWith("*** Move to:")) continue;
    current.lines.push(line);
  }
  return sections.map((section) => ({
    name: section.name,
    additions: section.lines.filter((line) => line.trimStart().startsWith("+")).length,
    deletions: section.lines.filter((line) => line.trimStart().startsWith("-")).length,
    snippets: patchSnippets(section.lines),
    lines: patchDiffLines(section.lines),
  })).filter((section) => section.name);
}

function patchSnippets(lines) {
  const changedIndexes = lines
    .map((line, index) => (/^[+-]/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  const snippets = [];
  let cursor = 0;
  while (cursor < changedIndexes.length && snippets.length < 10) {
    const start = changedIndexes[cursor];
    let end = start;
    cursor += 1;
    while (cursor < changedIndexes.length && changedIndexes[cursor] <= end + 1) {
      end = changedIndexes[cursor];
      cursor += 1;
    }
    const from = Math.max(0, start - 1);
    const to = Math.min(lines.length - 1, end + 1);
    for (let index = from; index <= to; index += 1) {
      const rendered = renderPatchLine(lines[index]);
      const text = stringifyPatchLine(rendered);
      if (text && !snippets.includes(text)) snippets.push(text);
    }
  }
  return snippets;
}

function patchDiffLines(lines) {
  const result = [];
  let oldLineNumber = 1;
  let newLineNumber = 1;
  for (const rawLine of lines) {
    if (rawLine.startsWith("@@")) {
      result.push({ kind: "header", text: rawLine.trim(), lineNumber: null });
      const range = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (range) {
        oldLineNumber = Number(range[1]);
        newLineNumber = Number(range[2]);
      }
      continue;
    }
    const parsed = renderPatchLine(rawLine);
    if (!parsed) continue;
    const kind = parsed.kind;
    if (kind === "context") {
      result.push({ kind, text: parsed.text, lineNumber: newLineNumber });
      oldLineNumber += 1;
      newLineNumber += 1;
    } else if (kind === "addition") {
      result.push({ kind, text: parsed.text, lineNumber: newLineNumber });
      newLineNumber += 1;
    } else if (kind === "deletion") {
      result.push({ kind, text: parsed.text, lineNumber: oldLineNumber });
      oldLineNumber += 1;
    }
  }
  return result;
}

function stringifyPatchLine(line) {
  if (!line) return "";
  if (line.kind === "addition") return `  + ${line.text}`;
  if (line.kind === "deletion") return `  - ${line.text}`;
  if (line.kind === "context") return `    ${line.text}`;
  return line.text || "";
}

function renderPatchLine(line) {
  if (!line) return "";
  const prefix = line[0];
  const value = line.slice(1).trimEnd();
  if (prefix === "+") return { kind: "addition", text: value };
  if (prefix === "-") return { kind: "deletion", text: value };
  if (prefix === " ") return { kind: "context", text: value.trimEnd() };
  return { kind: "context", text: line.trimEnd() };
}

function nestedExecInvocation(input) {
  if (input && typeof input === "object") {
    const command = input.cmd || input.command || input.arguments?.cmd || input.arguments?.command;
    if (typeof command === "string" && command.trim()) return { type: "command", command };
    const patch = input.patch || input.arguments?.patch;
    if (typeof patch === "string") return { type: "edit", patch };
    const sessionId = input.session_id ?? input.sessionId ?? input.arguments?.session_id ?? input.arguments?.sessionId;
    if (Number.isFinite(Number(sessionId))) return { type: "resume", sessionId: Number(sessionId) };
  }
  const source = String(input || "");
  try {
    const parsed = JSON.parse(source);
    if (parsed && parsed !== input) return nestedExecInvocation(parsed);
  } catch { /* Legacy tool inputs are source snippets, not JSON. */ }
  if (/tools\.apply_patch\s*\(/.test(source)) {
    return { type: "edit", patch: jsAssignedString(source, "patch") || "" };
  }
  if (/tools\.exec_command\s*\(/.test(source)) {
    return { type: "command", command: jsStringProperty(source, "cmd") };
  }
  if (/tools\.write_stdin\s*\(/.test(source)) {
    return { type: "resume", sessionId: jsNumberProperty(source, "session_id") };
  }
  return null;
}

function outputParts(output) {
  if (typeof output === "string") return [output];
  if (!Array.isArray(output)) return [];
  return output.map((item) => item?.text || item?.value || item?.input_text || item?.output_text || "").filter(Boolean);
}

function embeddedResultObjects(output) {
  const objects = [];
  for (const part of outputParts(output)) {
    const candidates = [part.trim(), ...part.split("\n").map((line) => line.trim())];
    for (const candidate of candidates) {
      if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
      try {
        const value = JSON.parse(candidate);
        if (value && typeof value === "object") objects.push(value);
      } catch { /* The output line is not a standalone JSON result. */ }
    }
  }
  return objects;
}

function customToolResult(output) {
  const text = outputParts(output).join("\n");
  const result = embeddedResultObjects(output).find((value) =>
    Number.isFinite(value.exit_code) || Number.isFinite(value.session_id) || Number.isFinite(value.wall_time_seconds));
  if (result) {
    const exitCode = Number.isFinite(result.exit_code) ? result.exit_code : null;
    return {
      status: exitCode === null ? "inProgress" : (exitCode === 0 ? "completed" : "failed"),
      exitCode,
      duration: Number.isFinite(result.wall_time_seconds) ? `${result.wall_time_seconds} seconds` : null,
      sessionId: Number.isFinite(result.session_id) ? result.session_id : null,
    };
  }
  return { ...commandResult(text), sessionId: null };
}

function textFromContent(content = []) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => item.text || item.value || item.input_text || item.output_text || "").join("").trim();
}

function outputTextFromResponse(payload) {
  if (!payload) return "";
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.text === "string") return payload.text;
  return textFromContent(payload.content);
}

function threadNameFromPayload(payload) {
  const candidates = [
    payload?.thread?.name,
    payload?.thread?.title,
    payload?.name,
    payload?.title,
    payload?.thread_name,
    payload?.threadName,
  ];
  return candidates
    .map((value) => typeof value === "string" ? value.trim() : "")
    .find((value) => value && !["exec", "apply_patch"].includes(value.toLowerCase())) || null;
}

function errorFromPayload(error) {
  if (!error) return null;
  if (typeof error === "string") return { message: error };
  return {
    message: error.message || JSON.stringify(error),
    codexErrorInfo: error.codexErrorInfo || error.codex_error_info || error.code || error.type || null,
    additionalDetails: error.additionalDetails || error.additional_details || null,
  };
}

function itemPlainText(item) {
  if (!item) return "";
  if (item.type === "userMessage") return textFromContent(item.content);
  if (item.type === "commandExecution") return item.command || "";
  return item.text || "";
}

function addUniqueItem(turn, item) {
  if (!item?.text && !item?.attachments?.length && item.type !== "userMessage" && item.type !== "commandExecution") return;
  if (turn.items.some((existing) => existing.id === item.id)) return;
  const text = itemPlainText(item).trim();
  const duplicate = text && item.type !== "commandExecution"
    ? turn.items.find((existing) => existing.type === item.type && itemPlainText(existing).trim() === text)
    : null;
  if (duplicate) {
    if (item.type === "userMessage" && item.content?.some((part) => part.type === "image")) {
      duplicate.content = item.content;
    }
    return;
  }
  turn.items.push(item);
}

function removeCompactionSummary(state, compactionMessage) {
  const wrapper = String(compactionMessage || "");
  for (let turnIndex = state.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = state.turns[turnIndex];
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex];
      if (item.type !== "agentMessage") continue;
      const text = itemPlainText(item).trim();
      if (!text) continue;
      const normalized = text.replace(/^\s+/, "");
      const looksLikeHandoff = /^(?:#+\s*|\*\*)?handoff summary\b/i.test(normalized);
      if (!looksLikeHandoff && !wrapper.includes(text)) continue;
      turn.items.splice(itemIndex, 1);
      turn.compressed = true;
      return;
    }
  }
  const currentTurn = state.currentTurnId ? state.turnMap.get(state.currentTurnId) : null;
  if (currentTurn) currentTurn.compressed = true;
}

function previewFromTurns(turns) {
  for (const turn of turns) {
    for (const item of turn.items || []) {
      if (item.type === "userMessage") {
        const text = textFromContent(item.content).trim();
        if (text) return text.slice(0, 180);
      }
    }
  }
  const firstAssistant = turns.flatMap((turn) => turn.items || []).find((item) => item.type === "agentMessage" && item.text);
  return firstAssistant?.text?.slice(0, 180) || "未命名对话";
}

function getOrCreateTurn(state, turnId, timestamp = 0) {
  const id = turnId || state.currentTurnId || `turn-${state.turns.length + 1}`;
  let turn = state.turnMap.get(id);
  if (!turn) {
    turn = {
      id,
      items: [],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: timestamp || state.createdAt || 0,
      completedAt: null,
      durationMs: null,
    };
    state.turnMap.set(id, turn);
    state.turns.push(turn);
  }
  state.currentTurnId = id;
  return turn;
}

function statusFromTurns(turns, updatedAt) {
  const latest = turns[turns.length - 1];
  if (!latest) return { type: "idle" };
  if (latest.status === "inProgress") {
    const ageSeconds = Math.floor(Date.now() / 1000) - (updatedAt || latest.startedAt || 0);
    return ageSeconds <= config.activeStaleSeconds ? { type: "active" } : { type: "idle" };
  }
  return { type: "idle" };
}

function usageFromPayload(payload, timestamp) {
  const info = payload?.info || {};
  const total = info.total_token_usage || null;
  const last = info.last_token_usage || null;
  if (!total && !last && !payload?.rate_limits) return null;
  return {
    total,
    last,
    modelContextWindow: info.model_context_window || null,
    rateLimits: payload.rate_limits || null,
    updatedAt: timestamp,
  };
}

function parseSessionLine(state, record) {
  if (!record) return;
  const timestamp = timestampSeconds(record.timestamp);
  const createdAt = timestampPrecise(record.timestamp) || timestamp;
  if (timestamp) {
    state.createdAt ||= timestamp;
    state.updatedAt = Math.max(state.updatedAt || 0, timestamp);
  }

  const payload = record.payload || {};
  if (record.type === "compacted") {
    // Codex writes its internal handoff summary as an assistant final_answer
    // immediately before the compaction record. It is model context, not a
    // user-facing reply, so remove it while keeping every earlier turn/item.
    removeCompactionSummary(state, payload.message);
    return;
  }
  if (record.type === "session_meta") {
    // fork_turns=all copies the ancestor's session_meta after the new child's
    // own metadata. Its messages remain history, but its identity is not ours.
    if (payload.id && state.id && payload.id !== state.id) return;
    state.identityCreatedAt ||= createdAt;
    state.sessionId = payload.session_id || payload.id || state.sessionId || state.id;
    state.cwd = payload.cwd || state.cwd;
    state.name = threadNameFromPayload(payload) || state.name;
    state.cliVersion = payload.cli_version || payload.cliVersion || state.cliVersion;
    state.source = payload.source || payload.originator || state.source;
    state.modelProvider = payload.model_provider || payload.modelProvider || state.modelProvider;
    state.historyMode = payload.history_mode || payload.historyMode || state.historyMode;
    state.threadSource = payload.thread_source || payload.threadSource || state.threadSource;
    Object.assign(state, threadRelationship({ ...payload, source: state.source, threadSource: state.threadSource }));
    return;
  }

  if (record.type === "turn_context") {
    const turnId = payload.turn_id || payload.turnId;
    const turn = getOrCreateTurn(state, turnId, timestamp);
    state.cwd = payload.cwd || state.cwd;
    turn.startedAt ||= timestamp;
    if (!state.isSubagent || createdAt >= state.identityCreatedAt) {
      state.agentLastTurnId = turn.id;
      state.agentStatusUpdatedAt = createdAt;
    }
    return;
  }

  if (record.type === "response_item") {
    const attachments = mediaAttachments(payload);
    if (attachments.length) {
      const turn = getOrCreateTurn(state, state.currentTurnId || payload.internal_chat_message_metadata_passthrough?.turn_id, timestamp);
      addUniqueItem(turn, { type: "imageArtifact", id: `${payload.call_id || payload.id || turn.id}-images`, attachments, createdAt });
    }
    const metadataTurnId = payload.internal_chat_message_metadata_passthrough?.turn_id;
    // Model response metadata may carry an internal ID, not an app-server
    // turn ID. Keep those items in the task established by lifecycle events.
    const turnId = state.turnMap.has(metadataTurnId)
      ? metadataTurnId
      : state.currentTurnId || metadataTurnId;
    if (payload.type === "custom_tool_call" && ["exec", "exec_command"].includes(payload.name)) {
      const invocation = nestedExecInvocation(payload.input);
      if (invocation?.type === "command" && invocation.command) {
        const turn = getOrCreateTurn(state, turnId, timestamp);
        const item = {
          type: "commandExecution",
          id: payload.call_id || payload.id || `${turn.id}-command-${turn.items.length}`,
          command: redactCommand(invocation.command).trim(),
          activity: commandActivity(invocation.command),
          status: "inProgress",
          exitCode: null,
          duration: null,
          createdAt,
        };
        addUniqueItem(turn, item);
        if (payload.call_id) state.toolCallMap.set(payload.call_id, item);
      } else if (invocation?.type === "edit") {
        const turn = getOrCreateTurn(state, turnId, timestamp);
        const diff = editedPatchSections(invocation.patch);
        const item = {
          type: "commandExecution",
          id: payload.call_id || payload.id || `${turn.id}-edit-${turn.items.length}`,
          command: editedFilesFromSections(diff),
          diff,
          activity: "edited",
          status: "inProgress",
          exitCode: null,
          duration: null,
          createdAt,
        };
        addUniqueItem(turn, item);
        if (payload.call_id) state.toolCallMap.set(payload.call_id, item);
      } else if (invocation?.type === "resume" && invocation.sessionId !== null) {
        const item = state.sessionCommandMap.get(invocation.sessionId);
        if (item && payload.call_id) state.toolCallMap.set(payload.call_id, item);
      }
      return;
    }
    if (payload.type === "custom_tool_call" && payload.name === "apply_patch") {
      const turn = getOrCreateTurn(state, turnId, timestamp);
      const diff = editedPatchSections(payload.input);
      const item = {
        type: "commandExecution",
        id: payload.call_id || payload.id || `${turn.id}-edit-${turn.items.length}`,
        command: editedFilesFromSections(diff),
        diff,
        activity: "edited",
        status: "inProgress",
        exitCode: null,
        duration: null,
        createdAt,
      };
      addUniqueItem(turn, item);
      if (payload.call_id) state.toolCallMap.set(payload.call_id, item);
      return;
    }
    if (payload.type === "custom_tool_call_output") {
      const item = state.toolCallMap.get(payload.call_id);
      if (item) {
        const result = customToolResult(payload.output);
        item.status = result.status;
        item.exitCode = result.exitCode;
        item.duration = result.duration || item.duration;
        if (result.sessionId !== null) state.sessionCommandMap.set(result.sessionId, item);
      }
      return;
    }
    if (payload.type === "function_call" && ["exec_command", "exec", "shell", "shell_command"].includes(payload.name)) {
      const args = typeof payload.arguments === "object"
        ? payload.arguments
        : (safeJson(payload.arguments) || {});
      const command = redactCommand(args.cmd || args.command || args.input).trim();
      if (!command) return;
      const turn = getOrCreateTurn(state, turnId, timestamp);
      const item = {
        type: "commandExecution",
        id: payload.call_id || payload.id || `${turn.id}-command-${turn.items.length}`,
        command,
        activity: commandActivity(command),
        status: "inProgress",
        exitCode: null,
        duration: null,
        createdAt,
      };
      addUniqueItem(turn, item);
      if (payload.call_id) state.toolCallMap.set(payload.call_id, item);
      return;
    }
    if (payload.type === "function_call_output") {
      const item = state.toolCallMap.get(payload.call_id);
      if (item) Object.assign(item, commandResult(payload.output));
      return;
    }
    if (payload.type === "message" && payload.role === "user") {
      // New rollouts store user input alongside injected instructions.
      // Only explicitly tagged user text and images belong in the chat.
      const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds || [];
      const content = (payload.content || []).flatMap((part, index) => {
        if (kinds[index] === "user.text") return [{ type: "text", text: part.text || "" }];
        if (kinds[index] === "user.image") return [{
          type: "image", name: `图片 ${index + 1}`, path: part.path || null,
          url: part.image_url || null,
        }];
        return [];
      });
      if (!content.some((part) => part.type === "image" || part.text?.trim())) return;
      const turn = getOrCreateTurn(state, turnId, timestamp);
      addUniqueItem(turn, {
        type: "userMessage",
        id: payload.id || `${turn.id}-user-${turn.items.length}`,
        content,
        createdAt,
      });
      return;
    }
    if (payload.type !== "message" || payload.role !== "assistant") return;
    const text = outputTextFromResponse(payload);
    if (!text || text.startsWith("<turn_aborted>")) return;
    const turn = getOrCreateTurn(state, turnId, timestamp);
    addUniqueItem(turn, {
      type: "agentMessage",
      id: payload.id || `${turn.id}-${payload.role}-${turn.items.length}`,
      text,
      phase: payload.phase || null,
      createdAt,
    });
    return;
  }

  if (record.type !== "event_msg") return;
  state.name = threadNameFromPayload(payload) || state.name;
  if (payload.type === "item_completed") {
    const completed = payload.item || {};
    if (["SubAgentActivity", "subAgentActivity", "CollabAgentToolCall", "collabAgentToolCall"].includes(completed.type)) {
      state.subagentStates ||= {};
      const childId = completed.agent_thread_id || completed.agentThreadId;
      if (childId && ["started", "completed"].includes(completed.kind)) {
        state.subagentStates[childId] = { status: agentStatus(completed.kind), updatedAt: createdAt, evidence: "activity" };
      }
      for (const [id, value] of Object.entries(completed.agents_states || completed.agentsStates || {})) {
        state.subagentStates[id] = { status: agentStatus(value.status), updatedAt: createdAt };
      }
      return;
    }
    const attachments = mediaAttachments(completed);
    if (attachments.length) {
      const turn = getOrCreateTurn(state, payload.turn_id, timestamp);
      addUniqueItem(turn, { type: "imageArtifact", id: `${completed.id || turn.id}-images`, attachments, createdAt });
    }
    if (!["McpToolCall", "FileChange"].includes(completed.type)) return;
    const turn = getOrCreateTurn(state, payload.turn_id, timestamp);
    if (completed.type === "McpToolCall") {
      addUniqueItem(turn, {
        type: "commandExecution",
        id: completed.id || `${turn.id}-mcp-${turn.items.length}`,
        command: `${completed.server || "MCP"}.${completed.tool || "tool"}`,
        activity: "ran",
        status: completed.status || "completed",
        createdAt,
      });
    } else {
      const files = Object.keys(completed.changes || {});
      if (!files.length) return;
      const existingEdit = turn.items.findLast((item) => item.activity === "edited"
        && files.some((file) => item.command?.includes(path.basename(file)))
        && (item.status === "inProgress" || Math.abs((item.createdAt || 0) - createdAt) < 10));
      if (existingEdit) {
        existingEdit.status = completed.status || "completed";
        return;
      }
      addUniqueItem(turn, {
        type: "commandExecution",
        id: completed.id || `${turn.id}-edit-${turn.items.length}`,
        command: files.map((file) => path.basename(file)).join(", "),
        activity: "edited",
        status: completed.status || "completed",
        createdAt,
      });
    }
    return;
  }
  if (payload.type === "token_count") {
    state.usage = usageFromPayload(payload, timestamp);
    return;
  }
  if (payload.type === "thread_settings_applied") {
    const settings = payload.thread_settings || {};
    state.cwd = settings.cwd || state.cwd;
    state.model = settings.model || state.model;
    state.modelProvider = settings.model_provider_id || state.modelProvider;
    return;
  }
  if (payload.type === "task_started") {
    const turn = getOrCreateTurn(state, payload.turn_id, timestampSeconds(payload.started_at) || timestamp);
    if (!state.isSubagent || createdAt >= state.identityCreatedAt) {
      state.agentLastTurnId = turn.id;
      state.agentStatusUpdatedAt = createdAt;
    }
    turn.status = "inProgress";
    turn.startedAt = timestampSeconds(payload.started_at) || turn.startedAt || timestamp;
    turn.completedAt = null;
    turn.error = null;
    return;
  }
  if (payload.type === "task_complete") {
    const turn = getOrCreateTurn(state, payload.turn_id, timestampSeconds(payload.started_at) || timestamp);
    if (!state.isSubagent || createdAt >= state.identityCreatedAt) {
      state.agentLastTurnId = turn.id;
      state.agentStatusUpdatedAt = timestampPrecise(payload.completed_at) || createdAt;
    }
    turn.completedAt = timestampSeconds(payload.completed_at) || timestamp;
    turn.durationMs = payload.duration_ms ?? turn.durationMs;
    turn.error = errorFromPayload(payload.error);
    turn.status = turn.error ? "failed" : "completed";
    if (payload.last_agent_message) {
      addUniqueItem(turn, {
        type: "agentMessage",
        id: `${turn.id}-last-agent-message`,
        text: String(payload.last_agent_message),
        phase: "final_answer",
        createdAt: timestampPrecise(payload.completed_at) || createdAt,
      });
    }
    return;
  }
  if (payload.type === "turn_aborted") {
    const turn = getOrCreateTurn(state, payload.turn_id, timestampSeconds(payload.started_at) || timestamp);
    if (!state.isSubagent || createdAt >= state.identityCreatedAt) {
      state.agentLastTurnId = turn.id;
      state.agentStatusUpdatedAt = timestampPrecise(payload.completed_at) || createdAt;
    }
    turn.completedAt = timestampSeconds(payload.completed_at) || timestamp;
    turn.durationMs = payload.duration_ms ?? turn.durationMs;
    turn.status = "interrupted";
    return;
  }
  if (payload.type === "user_message") {
    const turn = getOrCreateTurn(state, payload.turn_id || state.currentTurnId, timestamp);
    const text = payload.message || "";
    addUniqueItem(turn, {
      type: "userMessage",
      id: `${turn.id}-event-user-${turn.items.length}`,
      content: [{ type: "text", text }],
      createdAt,
    });
    return;
  }
  if (payload.type === "agent_message") {
    const turn = getOrCreateTurn(state, payload.turn_id || state.currentTurnId, timestamp);
    addUniqueItem(turn, {
      type: "agentMessage",
      id: `${turn.id}-event-agent-${turn.items.length}`,
      text: payload.message || "",
      phase: payload.phase || "commentary",
      createdAt,
    });
  }
}

export function threadIdFromPath(filePath) {
  const match = path.basename(filePath).match(SESSION_FILE_RE);
  return match?.[1] || null;
}

export function isContinuationPath(filePath) {
  return Boolean(path.basename(filePath).match(SESSION_FILE_RE)?.[2]);
}

export async function findSessionFiles(root = config.codexSessionsDir) {
  const cached = root === config.codexSessionsDir && sessionWatchCount > 0;
  if (cached && sessionFileSnapshot?.version === sessionInventoryVersion
    && Date.now() - sessionFileSnapshot.scannedAt < 1000) return [...sessionFileSnapshot.files];
  if (root === config.codexSessionsDir && sessionScan) return sessionScan;
  const scanning = scanSessionFiles(root);
  if (root !== config.codexSessionsDir) return scanning;
  sessionScan = scanning.finally(() => { sessionScan = null; });
  return sessionScan;
}

async function scanSessionFiles(root) {
  const version = sessionInventoryVersion;
  const results = [];
  async function walk(dir) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(fullPath);
      if (entry.isFile() && entry.name.endsWith(".jsonl") && threadIdFromPath(fullPath)) results.push(fullPath);
    }));
  }
  await Promise.all([walk(root), ...(root === config.codexSessionsDir ? [walk(ARCHIVED_SESSION_DIR)] : [])]);
  if (root === config.codexSessionsDir) {
    const byId = new Map();
    for (const file of results) {
      const id = threadIdFromPath(file);
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(file);
    }
    sessionFileSnapshot = { version, scannedAt: Date.now(), files: new Set(results), byId };
  }
  return results;
}

export async function readCliThread(filePath, { includeTurns = true } = {}) {
  const files = [...(Array.isArray(filePath) ? filePath : [filePath])]
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)) || left.localeCompare(right));
  const reads = includeTurns ? detailReads : summaryReads;
  const key = files[0];
  const signature = files.join("\n");
  const previous = reads.get(key);
  if (previous?.signature === signature) return previous.reading;
  const reading = (previous?.reading.catch(() => {}) || Promise.resolve())
    .then(() => readCliThreadUnqueued(files, includeTurns))
    .finally(() => { if (reads.get(key)?.reading === reading) reads.delete(key); });
  reads.set(key, { signature, reading });
  return reading;
}

function parseSummaryLine(state, record) {
  const payload = record?.payload || {};
  if (record?.type === "response_item") {
    if (payload.type !== "message") return;
    if (payload.role === "user" && state.userPreview) return;
    if (payload.role === "assistant" && (state.userPreview || state.agentPreview)) return;
  } else if (record?.type === "event_msg") {
    if (payload.type === "item_completed" && !["SubAgentActivity", "subAgentActivity", "CollabAgentToolCall", "collabAgentToolCall"].includes(payload.item?.type)) return;
    if (payload.type === "user_message" && state.userPreview) return;
    if (payload.type === "agent_message" && (state.userPreview || state.agentPreview)) return;
  }
  parseSessionLine(state, record);
  const turn = state.turnMap.get(state.currentTurnId);
  for (const item of turn?.items || []) {
    if (item.type === "userMessage") state.userPreview ||= textFromContent(item.content).trim().slice(0, 180);
    if (item.type === "agentMessage") state.agentPreview ||= item.text?.slice(0, 180);
  }
  // Lists need metadata and lifecycle state, not retained tool output or message bodies.
  if (turn) turn.items = [];
}

// Only skip headers whose canonical structure is already complete. Unusual key
// orders and message records still go through JSON.parse below.
function skipSummaryRecord(bytes) {
  const header = bytes.subarray(0, 1024).toString("utf8").match(
    /^\s*\{\s*"timestamp"\s*:\s*"(?:\\.|[^"\\])*"\s*,\s*"type"\s*:\s*"([^"\\]*)"\s*,\s*"payload"\s*:\s*\{\s*"type"\s*:\s*"([^"\\]*)"/);
  return header?.[1] === "response_item" && header[2] !== "message"
    || header?.[1] === "event_msg" && header[2] === "item_completed"
      && !/"item"\s*:\s*\{\s*"type"\s*:\s*"(?:SubAgentActivity|subAgentActivity|CollabAgentToolCall|collabAgentToolCall)"/.test(bytes.subarray(0, 1024).toString("utf8"));
}

async function appendMatches(filePath, previous) {
  // ponytail: sample the original header and append boundary. Detect arbitrary
  // edits in the middle only if the writer supplies a revision or an index.
  const handle = await fs.open(filePath, "r");
  try {
    for (const [position, expected] of [[0, previous.head], [previous.position - previous.tail.length, previous.tail]]) {
      const actual = Buffer.allocUnsafe(expected.length);
      const { bytesRead } = await handle.read(actual, 0, actual.length, position);
      if (bytesRead !== actual.length || !actual.equals(expected)) return false;
    }
    return true;
  } finally { await handle.close(); }
}

async function parseSessionFile(state, filePath, stat, previous, includeTurns) {
  const start = previous?.position || 0;
  const bytes = Buffer.allocUnsafe(Math.min(256 * 1024, Math.max(1, stat.size - start)));
  const handle = await fs.open(filePath, "r");
  try {
    let position = start;
    let offset = previous?.offset || 0;
    let fragments = previous?.fragments || [];
    let fragmentBytes = previous?.fragmentBytes || 0;
    let skipping = previous?.skipping || false;
    let head = previous?.head;
    let tail = previous?.tail;
    const parse = includeTurns ? parseSessionLine : parseSummaryLine;
    while (position < stat.size) {
      const result = await handle.read(bytes, 0, Math.min(bytes.length, stat.size - position), position);
      if (result.bytesRead === 0) break;
      position += result.bytesRead;
      const chunk = bytes.subarray(0, result.bytesRead);
      head ||= Buffer.from(chunk.subarray(0, 4096));
      tail = Buffer.from(chunk.subarray(Math.max(0, chunk.length - 256)));
      let from = 0;
      let newline;
      while ((newline = chunk.indexOf(10, from)) >= 0) {
        const end = chunk.subarray(from, newline);
        if (!skipping && (includeTurns || fragments.length || !skipSummaryRecord(end))) {
          const line = fragments.length ? Buffer.concat([...fragments, end], fragmentBytes + end.length) : end;
          parse(state, safeJson(line.toString("utf8")));
        }
        offset = position - chunk.length + newline + 1;
        fragments = [];
        fragmentBytes = 0;
        skipping = false;
        from = newline + 1;
      }
      if (from < chunk.length) {
        if (!includeTurns && !fragmentBytes && !skipping) skipping = skipSummaryRecord(chunk.subarray(from));
        if (!skipping) {
          fragments.push(Buffer.from(chunk.subarray(from)));
          fragmentBytes += chunk.length - from;
        }
      }
    }
    // Some complete rollouts omit the final newline. A partial JSON record
    // (including a split UTF-8 character) stays uncommitted until the next read.
    if (fragmentBytes && /}\s*$/.test(fragments.at(-1).toString("utf8"))) {
      const record = safeJson(Buffer.concat(fragments, fragmentBytes).toString("utf8"));
      if (record) {
        parse(state, record);
        offset = position;
        fragments = [];
        fragmentBytes = 0;
      }
    }
    return { offset, position, fragments, fragmentBytes, skipping,
      head: head || Buffer.alloc(0), tail: tail || Buffer.alloc(0) };
  } finally {
    await handle.close();
  }
}

async function readCliThreadUnqueued(files, includeTurns) {
  const idFromPath = threadIdFromPath(files[0]);
  const fileStats = await Promise.all(files.map(async (filePath) => ({
    filePath, stat: await fs.stat(filePath),
  })));
  const latest = fileStats.at(-1);
  const indexedNames = await readSessionIndexNames();
  const updatedAt = Math.max(...fileStats.map(({ stat }) => stat.mtimeMs / 1000));
  const syncRevision = fileStats.map(({ stat }) => `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`).join("|");
  const detailCache = (includeTurns ? detailCaches : threadSummaryCache).get(files[0]);
  let reusable = detailCache?.files.length <= files.length
    && detailCache.files.every((cached, index) => {
      const { filePath, stat } = fileStats[index];
      return cached.filePath === filePath && cached.ino === stat.ino && cached.dev === stat.dev
        && (index === detailCache.files.length - 1 && stat.size > cached.size
          || stat.size === cached.size && stat.mtimeMs === cached.mtimeMs && stat.ctimeMs === cached.ctimeMs);
    });
  if (reusable) {
    const growing = fileStats.find(({ stat }, index) => detailCache.files[index] && stat.size > detailCache.files[index].size);
    if (growing) reusable = await appendMatches(growing.filePath, detailCache.files[fileStats.indexOf(growing)]);
  }
  const state = reusable ? detailCache.state : {
    id: idFromPath,
    cwd: null,
    cliVersion: null,
    source: "codex-cli",
    modelProvider: null,
    model: null,
    historyMode: "legacy",
    threadSource: "cli-local",
    sessionId: idFromPath,
    createdAt: 0,
    updatedAt,
    currentTurnId: null,
    turnMap: new Map(),
    toolCallMap: new Map(),
    sessionCommandMap: new Map(),
    turns: [],
    usage: null,
  };
  const cachedFiles = [];
  for (const [index, { filePath, stat }] of fileStats.entries()) {
    const previous = reusable ? detailCache.files[index] : null;
    const parsed = !previous || stat.size > previous.size
      ? await parseSessionFile(state, filePath, stat, previous, includeTurns)
      : previous;
    cachedFiles.push({ ...parsed, filePath, ino: stat.ino, dev: stat.dev,
      size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
  }
  const cache = includeTurns ? detailCaches : threadSummaryCache;
  cache.delete(files[0]);
  const unchanged = reusable && cachedFiles.every((file, index) => file.size === detailCache.files[index]?.size);
  const retainedBytes = includeTurns ? unchanged ? detailCache.retainedBytes
    : historyBytes(state.turns) + state.toolCallMap.size * 128 + cachedFiles.reduce((sum, file) => sum + file.fragmentBytes, 0) : 0;
  cache.set(files[0], { files: cachedFiles, state, retainedBytes });
  if (includeTurns) {
    // ponytail: four histories / about 128 MiB of retained items, keeping at least the
    // current history so a large active thread still gets incremental reads.
    // Use an indexed store if one parsed history becomes too large for memory.
    let bytes = [...cache.values()].reduce((sum, entry) => sum + entry.retainedBytes, 0);
    while (cache.size > 1 && (cache.size > 4 || bytes > 128 * 1024 * 1024)) {
      const key = cache.keys().next().value;
      bytes -= cache.get(key).retainedBytes;
      cache.delete(key);
    }
  }
  const createdAt = state.createdAt || fileStats[0].stat.birthtimeMs / 1000 || state.updatedAt;
  const recencyAt = Math.max(state.updatedAt || 0, updatedAt);
  const activityTurns = state.isSubagent ? state.agentLastTurnId ? [state.turnMap.get(state.agentLastTurnId)] : [] : state.turns;
  const thread = {
    id: state.id,
    extra: null,
    sessionId: state.sessionId || state.id,
    forkedFromId: null,
    parentThreadId: state.parentThreadId || null,
    preview: includeTurns ? previewFromTurns(state.turns) : state.userPreview || state.agentPreview || "未命名对话",
    ephemeral: false,
    isPinned: false,
    historyMode: state.historyMode,
    modelProvider: state.modelProvider,
    model: state.model,
    createdAt,
    updatedAt: recencyAt,
    syncRevision,
    recencyAt,
    status: statusFromTurns(activityTurns, recencyAt),
    path: latest.filePath,
    cwd: state.cwd || "未指定项目目录",
    cliVersion: state.cliVersion,
    source: state.source || "codex-cli",
    canAcceptDirectInput: !state.isSubagent,
    threadSource: state.threadSource || "cli-local",
    agentNickname: state.agentNickname || null,
    agentRole: state.agentRole || null,
    agentPath: state.agentPath || null,
    ...(state.isSubagent ? {
      agentStatus: activityTurns.at(-1)?.status === "inProgress"
        ? statusFromTurns(activityTurns, recencyAt).type === "active" ? "active" : "unknown"
        : activityTurns.length ? agentStatus(activityTurns.at(-1).status) : "pending",
      _agentStatusUpdatedAt: state.agentStatusUpdatedAt || state.updatedAt || createdAt,
    } : {}),
    _subagentStates: state.subagentStates || {},
    _statusFromHistory: true,
    gitInfo: null,
    name: indexedNames.get(state.id) || state.name || null,
    usage: state.usage,
    ...(includeTurns ? { turns: state.turns } : {}),
  };
  return { thread, turns: includeTurns ? state.turns : [] };
}

function historyBytes(value) {
  if (typeof value === "string") return value.length * 2;
  if (!value || typeof value !== "object") return 0;
  return 64 + Object.values(value).reduce((bytes, child) => bytes + historyBytes(child), 0);
}

export async function readArchiveSet() {
  try {
    const data = JSON.parse(await fs.readFile(ARCHIVE_FILE, "utf8"));
    return new Set(Array.isArray(data.archivedThreadIds) ? data.archivedThreadIds : []);
  } catch (error) {
    if (error.code === "ENOENT") return new Set();
    throw error;
  }
}

export async function writeArchiveSet(archiveSet) {
  await fs.mkdir(path.dirname(ARCHIVE_FILE), { recursive: true });
  const temporaryFile = `${ARCHIVE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryFile, JSON.stringify({
      archivedThreadIds: [...archiveSet].sort(),
      updatedAt: new Date().toISOString(),
    }, null, 2));
    await fs.rename(temporaryFile, ARCHIVE_FILE);
  } finally {
    await fs.rm(temporaryFile, { force: true });
  }
}

export async function archiveCliThread(threadId) {
  const operation = archiveWrite.then(async () => {
    const archiveSet = await readArchiveSet();
    archiveSet.add(threadId);
    await writeArchiveSet(archiveSet);
    return { archived: true, threadId };
  });
  archiveWrite = operation.catch(() => {});
  return operation;
}

export async function listCliThreads({ archived = false, includeSubagents = config.includeSubagents, includeArchivedSubagents = false } = {}) {
  const archiveSet = await readArchiveSet();
  const files = await findSessionFiles();
  for (const file of files) {
    const relative = path.relative(ARCHIVED_SESSION_DIR, file);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) archiveSet.add(threadIdFromPath(file));
  }
  const groups = new Map();
  for (const file of files) {
    const id = threadIdFromPath(file);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(file);
  }
  const presentFiles = new Set(files);
  for (const key of threadSummaryCache.keys()) if (!presentFiles.has(key)) threadSummaryCache.delete(key);
  const groupedFiles = [...groups.entries()]
    .filter(([id]) => archived === null || includeArchivedSubagents || (archived ? archiveSet.has(id) : !archiveSet.has(id)))
    .map(([, group]) => group);
  const settled = [];
  // Bound concurrent buffers when histories contain large inline images.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, groupedFiles.length) }, async () => {
    while (next < groupedFiles.length) {
      const group = groupedFiles[next++];
      const [result] = await Promise.allSettled([readCliThread(group, { includeTurns: false })]);
      settled.push(result);
    }
  }));
  return settled
    .filter((item) => item.status === "fulfilled")
    .map((item) => item.value.thread)
    .filter((thread) => includeSubagents || !threadRelationship(thread).isSubagent)
    .filter((thread) => archived === null || includeArchivedSubagents && threadRelationship(thread).isSubagent || (archived ? archiveSet.has(thread.id) : !archiveSet.has(thread.id)))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function watchCliSessions(onChange, { getObservedThreadIds = () => [] } = {}) {
  const watchers = new Map();
  const sessionDir = path.resolve(config.codexSessionsDir);
  let stopped = false;
  const changed = (event, candidate) => {
    if (!candidate || event === "rename" || !sessionFileSnapshot?.files.has(candidate)) sessionInventoryVersion += 1;
    onChange(candidate);
  };
  function attach(directory, recursive, listener) {
    try {
      const watcher = watch(directory, { recursive, persistent: false }, (event, filename) => {
        listener(event, filename ? path.join(directory, String(filename)) : null);
      });
      watchers.set(watcher, recursive && directory === sessionDir);
      if (watchers.get(watcher)) sessionWatchCount += 1;
      watcher.on("error", () => { close(watcher); changed("rename", null); });
      return watcher;
    } catch { return null; }
  }
  function close(watcher) {
    if (!watchers.has(watcher)) return;
    if (watchers.get(watcher)) sessionWatchCount -= 1;
    watchers.delete(watcher);
    watcher.close();
  }
  let sessionWatcher;
  let archiveSessionWatcher;
  function attachSessions() {
    if (sessionWatcher) close(sessionWatcher);
    if (archiveSessionWatcher) close(archiveSessionWatcher);
    if (!stopped) sessionWatcher = attach(sessionDir, true, changed);
    if (!stopped) archiveSessionWatcher = attach(ARCHIVED_SESSION_DIR, true, changed);
  }
  sessionInventoryVersion += 1;
  attachSessions();
  const directories = new Set([path.dirname(sessionDir), path.dirname(ARCHIVED_SESSION_DIR), path.dirname(SESSION_INDEX_FILE), path.dirname(ARCHIVE_FILE)]);
  for (const directory of directories) {
    const listener = (event, candidate) => {
      if (!candidate || candidate === sessionDir || candidate === ARCHIVED_SESSION_DIR) {
        attachSessions();
        changed(event, candidate);
      } else if (candidate === SESSION_INDEX_FILE || candidate === ARCHIVE_FILE) onChange(candidate);
    };
    let parent = directory;
    // A missing sessions/state directory can appear after startup. Watching the
    // nearest existing ancestor observes its creation as well as its contents.
    while (!attach(parent, parent !== directory, listener) && path.dirname(parent) !== parent) parent = path.dirname(parent);
  }
  let pollInFlight = false;
  let signatures = new Map();
  const signature = (stat) => stat ? `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}` : "missing";
  async function pollObservedFiles() {
    if (stopped || pollInFlight) return;
    pollInFlight = true;
    try {
      const observed = [...new Set(getObservedThreadIds())];
      const known = new Map();
      const candidates = new Set([SESSION_INDEX_FILE, ARCHIVE_FILE]);
      for (const id of observed) {
        const files = [...(sessionFileSnapshot?.byId.get(id) || [])]
          .sort((left, right) => path.basename(left).localeCompare(path.basename(right)) || left.localeCompare(right));
        const cached = detailCaches.get(files[0]) || threadSummaryCache.get(files[0]);
        for (const file of files) { candidates.add(file); candidates.add(path.dirname(file)); }
        for (const file of cached?.files || []) known.set(file.filePath, signature(file));
      }
      candidates.add(sessionDir);
      candidates.add(ARCHIVED_SESSION_DIR);
      const now = new Date();
      for (const date of [
        [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()],
        [now.getFullYear(), now.getMonth() + 1, now.getDate()],
      ]) {
        let directory = sessionDir;
        for (const part of date) {
          directory = path.join(directory, String(part).padStart(2, "0"));
          candidates.add(directory);
        }
      }
      const next = new Map();
      await Promise.all([...candidates].map(async candidate => {
        const stat = await fs.stat(candidate).catch(() => null);
        const current = signature(stat);
        next.set(candidate, current);
        const previous = signatures.get(candidate) ?? known.get(candidate);
        if (previous !== undefined && previous !== current && !stopped) {
          changed(stat?.isDirectory() || !stat ? "rename" : "change", candidate);
        }
      }));
      signatures = next;
    } finally { pollInFlight = false; }
  }
  // Recursive fs.watch can silently stall on existing macOS session trees.
  // Stat only observed rollouts and the few directories that can gain a new
  // thread or continuation; the regular server poll reconciles the full list.
  const pollTimer = setInterval(() => { void pollObservedFiles().catch(() => {}); }, 250);
  pollTimer.unref();
  void pollObservedFiles().catch(() => {});
  return () => {
    stopped = true;
    clearInterval(pollTimer);
    for (const watcher of [...watchers.keys()]) close(watcher);
  };
}

export async function readCliThreadById(threadId, options = {}) {
  const files = await findSessionFiles();
  const matches = files.filter((candidate) => threadIdFromPath(candidate) === threadId);
  if (matches.length === 0) {
    const error = new Error("CLI session not found");
    error.status = 404;
    throw error;
  }
  return readCliThread(matches, options);
}
