import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import { CodexClient, CodexError } from "./codex-client.js";
import { archiveCliThread, listCliThreads, readCliThreadById, threadIdFromPath, watchCliSessions } from "./cli-sessions.js";
import {
  isWindowsPlatform,
  resumeThread as resumeWindowsThread,
  startNewThread as startWindowsThread,
  stopThread as stopWindowsThread,
} from "./windows-cli.js";
import { printConnectionQRCode } from "./connection-qr.js";
import { isPathInside, normalizeAllowedPath } from "./file-roots.js";
import { listModelsViaStdio } from "./app-server-stdio.js";
import { QwenProvider } from "./qwen-provider.js";
import { ClaudeProvider } from "./claude-provider.js";
import { mediaAttachments } from "./media-attachments.js";
import { collaborationModeParams } from "./collaboration-mode.js";
import { MessageQueue } from "./message-queue.js";
import { createInlineMediaCache } from "./inline-media.js";
import { agentStatus, flattenThreads, observedThreadIds, threadAgentStatus, threadRelationship, threadsWithHierarchy } from "./thread-hierarchy.js";

const client = new CodexClient();
const qwenProvider = new QwenProvider();
const claudeProvider = new ClaudeProvider();
const execFile = promisify(execFileCallback);
const subscribers = new Map();
const unsubscribeTimers = new Map();
const ownedRunningThreads = new Set();
const unconfirmedForkWrites = new Set();
const streamLeaseTimers = new Map();
const globalSubscribers = new Set();
const eventHistory = new Map();
const pendingApprovals = new Map();
const pendingInputs = new Map();
const EVENT_HISTORY_LIMIT = 250;
const APPROVAL_HISTORY_FILE = path.join(config.stateDir, "approval-history.json");
const UPLOAD_ROOT = path.join(config.stateDir, "uploads");
const INLINE_MEDIA_ROOT = path.join(config.stateDir, "inline-media");
const inlineMedia = createInlineMediaCache(INLINE_MEDIA_ROOT);
const eventEpoch = crypto.randomUUID();
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const messageQueue = new MessageQueue({
  file: path.join(config.stateDir, "message-queue.json"),
  send: sendThreadMessage,
  inspect: async threadId => ({ ...await readThreadDetail(threadId), busy: ownedRunningThreads.has(threadId) }),
  changed: (threadId, queue) => broadcastGlobal("queue/changed", { threadId, ...queue }),
});
let approvalHistory = null;
let approvalHistoryLoadPromise = null;
let approvalHistoryWrite = Promise.resolve();
let eventSequence = 0;
let latestThreadSignature = "";
let latestProjectSnapshot = null;
let syncInFlight = false;
let syncAgainReason = null;
let syncTimer = null;
let syncInterval = null;
let stopWatchingSessions = null;
let archiveRevision = 0;
let historyChangeTimer = null;
const changedHistoryThreads = new Set();
let latestThreadHierarchy = [];
const apiAgentStatusCache = new Map();
const runtimeSubagentStates = new Map();

async function loadApprovalHistory() {
  if (approvalHistory) return approvalHistory;
  if (!approvalHistoryLoadPromise) {
    approvalHistoryLoadPromise = (async () => {
      try {
        const value = JSON.parse(await fs.readFile(APPROVAL_HISTORY_FILE, "utf8"));
        approvalHistory = Array.isArray(value) ? value : [];
      } catch {
        approvalHistory = [];
      }
      return approvalHistory;
    })();
  }
  return approvalHistoryLoadPromise;
}

function approvalResolutionText(approval, decision) {
  const title = decision === "decline"
    ? "用户已禁止操作"
    : (decision === "acceptForSession" ? "用户已永久允许当前会话" : "用户已允许操作");
  const details = [];
  if (approval.reason) details.push(`说明：${approval.reason}`);
  const context = approval.networkApprovalContext;
  if (context?.host) {
    const scheme = context.protocol ? `${context.protocol}://` : "";
    const port = context.port ? `:${context.port}` : "";
    details.push(`网络：${scheme}${context.host}${port}`);
  }
  if (approval.permissionSummary) details.push(`权限：${approval.permissionSummary}`);
  if (approval.command) details.push(`命令：${approval.command}`);
  const targetPath = approval.grantRoot || approval.cwd;
  if (targetPath) details.push(`路径：${targetPath}`);
  return details.length > 0 ? `${title}\n${details.join("\n")}` : title;
}

async function recordApprovalResolution(approval, decision) {
  if (!approval?.threadId || !approval?.turnId || !decision) return;
  const history = await loadApprovalHistory();
  const id = `approval-${approval.id}-${decision}`;
  const record = {
    id,
    threadId: approval.threadId,
    turnId: approval.turnId,
    item: {
      type: "commandExecution",
      id,
      command: approvalResolutionText(approval, decision),
      activity: "approval",
      status: decision === "decline" ? "declined" : "completed",
      exitCode: null,
      duration: null,
      createdAt: Date.now() / 1000,
    },
  };
  const existingIndex = history.findIndex((value) => value.id === id);
  if (existingIndex >= 0) history[existingIndex] = record;
  else history.push(record);
  if (history.length > 2000) history.splice(0, history.length - 2000);
  approvalHistoryWrite = approvalHistoryWrite.then(async () => {
    await fs.mkdir(path.dirname(APPROVAL_HISTORY_FILE), { recursive: true });
    await fs.writeFile(APPROVAL_HISTORY_FILE, JSON.stringify(history), "utf8");
  });
  await approvalHistoryWrite;
}

async function mergeApprovalHistory(threadId, turns) {
  const history = await loadApprovalHistory();
  const byTurn = new Map();
  for (const record of history) {
    if (record.threadId !== threadId || !record.turnId || !record.item) continue;
    if (!byTurn.has(record.turnId)) byTurn.set(record.turnId, []);
    byTurn.get(record.turnId).push(record.item);
  }
  return turns.map((turn) => {
    const approvalItems = byTurn.get(turn.id) || [];
    if (approvalItems.length === 0) return turn;
    const items = [...(turn.items || [])];
    const existingIDs = new Set(items.map((item) => item.id).filter(Boolean));
    items.push(...approvalItems.filter((item) => !existingIDs.has(item.id)));
    const orderedItems = items.map((item, index) => ({ item, index })).sort((left, right) => {
      const leftTime = left.item.createdAt ?? Number.MAX_SAFE_INTEGER;
      const rightTime = right.item.createdAt ?? Number.MAX_SAFE_INTEGER;
      return leftTime === rightTime ? left.index - right.index : leftTime - rightTime;
    }).map(({ item }) => item);
    return { ...turn, items: orderedItems };
  });
}

function configuredCodexReasoningEffort() {
  try {
    const raw = syncFs.readFileSync(config.codexConfigPath, "utf8");
    return raw.match(/^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m)?.[1] || null;
  } catch {
    return null;
  }
}

function normalizeModel(model, configuredDefault = null) {
  const id = model?.id || model?.model || model?.slug;
  if (!id) return null;
  const rawLevels = model.supportedReasoningEfforts
    || model.supportedReasoningLevels
    || model.supported_reasoning_levels
    || [];
  const supportedReasoningEfforts = rawLevels
    .map((level) => {
      if (typeof level === "string") return { reasoningEffort: level, description: null };
      const reasoningEffort = level?.reasoningEffort || level?.effort || level?.reasoning_level || level?.level;
      return reasoningEffort
        ? { reasoningEffort, description: level.description || null }
        : null;
    })
    .filter(Boolean);
  const supportedReasoningLevels = supportedReasoningEfforts.map(({ reasoningEffort, description }) => ({
    effort: reasoningEffort,
    description,
  }));
  const configuredSupportedDefault = configuredDefault
    && supportedReasoningEfforts.some(({ reasoningEffort }) => reasoningEffort === configuredDefault)
    ? configuredDefault
    : null;
  const defaultReasoningEffort = configuredSupportedDefault
    || model.defaultReasoningEffort
    || model.defaultReasoningLevel
    || model.default_reasoning_level
    || supportedReasoningEfforts[0]?.reasoningEffort
    || null;
  return {
    ...model,
    id,
    model: model.model || id,
    displayName: model.displayName || model.display_name || id,
    defaultReasoningLevel: defaultReasoningEffort,
    supportedReasoningLevels,
    defaultReasoningEffort,
    supportedReasoningEfforts,
    hidden: model.hidden ?? model.visibility === "hide",
  };
}

function usesWindowsCliFallback() {
  return isWindowsPlatform() && (!client.socket || client.socket.closed);
}

function usesQwenProvider() {
  return config.agentProvider === "qwen";
}

function usesClaudeProvider() {
  return config.agentProvider === "claude";
}

function usesBothProviders() {
  return config.agentProvider === "both";
}

function usesAllProviders() {
  return config.agentProvider === "all";
}

function hasCodexProvider() {
  return ["codex", "both", "all"].includes(config.agentProvider);
}

async function isQwenThread(threadId) {
  return usesQwenProvider() || usesBothProviders() && await qwenProvider.hasThread(threadId) || usesAllProviders() && await qwenProvider.hasThread(threadId);
}

async function isClaudeThread(threadId) {
  return usesClaudeProvider() || usesAllProviders() && await claudeProvider.hasThread(threadId);
}

function normalizeModelsResponse(result, configuredDefault = null) {
  const data = Array.isArray(result?.data)
    ? result.data
    : (Array.isArray(result?.models) ? result.models : []);
  return {
    ...result,
    data: data.map((model) => normalizeModel(model, configuredDefault)).filter(Boolean),
  };
}

async function listModels() {
  if (usesQwenProvider()) return qwenProvider.listModels();
  if (usesClaudeProvider()) return claudeProvider.listModels();
  if (usesBothProviders()) {
    const configuredDefault = configuredCodexReasoningEffort();
    const [codexResult, qwenResult] = await Promise.allSettled([
      (async () => normalizeModelsResponse(
        usesWindowsCliFallback()
          ? await listModelsViaStdio({ codexBin: config.codexBin })
          : await client.listModels(),
        configuredDefault,
      ))(),
      qwenProvider.listModels(),
    ]);
    const data = [];
    if (codexResult.status === "fulfilled") data.push(...(codexResult.value.data || []).map((model) => ({ ...model, provider: "codex" })));
    if (qwenResult.status === "fulfilled") data.push(...(qwenResult.value.data || []));
    return { data };
  }
  if (usesAllProviders()) {
    const [codexResult, qwenResult, claudeResult] = await Promise.allSettled([
      (usesWindowsCliFallback() ? listModelsViaStdio({ codexBin: config.codexBin }) : client.listModels())
        .then((result) => normalizeModelsResponse(result, configuredCodexReasoningEffort())),
      qwenProvider.listModels(),
      claudeProvider.listModels(),
    ]);
    const data = [];
    if (codexResult.status === "fulfilled") data.push(...(codexResult.value.data || []).map((model) => ({ ...model, provider: "codex" })));
    if (qwenResult.status === "fulfilled") data.push(...(qwenResult.value.data || []));
    if (claudeResult.status === "fulfilled") data.push(...(claudeResult.value.data || []));
    return { data };
  }
  if (usesWindowsCliFallback()) {
    return normalizeModelsResponse(await listModelsViaStdio({ codexBin: config.codexBin }), configuredCodexReasoningEffort());
  }
  return normalizeModelsResponse(
    await client.listModels(),
    configuredCodexReasoningEffort(),
  );
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function fileContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".ts": "text/plain; charset=utf-8",
    ".swift": "text/plain; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  })[extension] || "application/octet-stream";
}

async function sendFilePreview(res, candidate, previewRoot = null) {
  const filePath = await normalizeWorkspacePath(candidate);
  await inlineMedia.wait(filePath);
  const realFile = await fs.realpath(filePath);
  const roots = [...config.fileRoots, UPLOAD_ROOT, INLINE_MEDIA_ROOT, ...(latestProjectSnapshot?.projects || []).map(project => project.cwd).filter(Boolean)];
  const withinRealRoots = async values => {
    for (const root of values) {
      try { if (isPathInside(await fs.realpath(root), realFile)) return true; } catch {}
    }
    return false;
  };
  if (!await withinRealRoots(roots) && !await withinRealRoots(projectRootsFromThreads(await listAllThreads(false)))) {
    throw Object.assign(new Error("File target is outside allowed file roots"), { status: 403 });
  }
  if (previewRoot) {
    const root = await fs.realpath(await normalizeWorkspacePath(previewRoot));
    if (!isPathInside(root, realFile)) {
      const error = new Error("HTML resources must remain inside the document directory");
      error.status = 403;
      throw error;
    }
  }
  const metadata = await fs.stat(filePath);
  if (!metadata.isFile()) {
    const error = new Error("Path is not a file");
    error.status = 422;
    throw error;
  }
  if (metadata.size > 50 * 1024 * 1024) {
    const error = new Error("File is too large to preview (maximum 50 MB)");
    error.status = 413;
    throw error;
  }
  const data = await fs.readFile(filePath);
  res.writeHead(200, {
    "content-type": fileContentType(filePath),
    "content-length": data.length,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(data);
}

export function errorResponse(res, error) {
  const writerBusy = /already has an active writer/i.test(error.message || "");
  const status = writerBusy ? 409 : error.status || (error instanceof CodexError ? 502 : 400);
  json(res, status, { error: writerBusy
    ? "此会话正由其他客户端占用写入权。仅切换电脑端对话不会释放；请关闭占用该会话的客户端后重试。"
    : error.message || "Request failed",
    ...(error.sendUnconfirmed === undefined ? {} : { sendUnconfirmed: error.sendUnconfirmed }),
  });
}

function writeResultUnconfirmed(error) {
  // A JSON-RPC rejection is a confirmed failure; a lost transport reply may
  // have followed an accepted write and must never cause an automatic retry.
  return !error.error && !(error.status >= 400 && error.status < 500);
}

function isImage(filePath) {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filePath);
}

function normalizePath(candidate) {
  return normalizeAllowedPath(candidate, {
    defaultPath: config.defaultCwd,
    roots: config.fileRoots,
  });
}

function sandboxPolicyFor(sandbox) {
  switch (sandbox) {
  case "danger-full-access":
    return { type: "dangerFullAccess" };
  case "read-only":
    return { type: "readOnly" };
  default:
    return { type: "workspaceWrite" };
  }
}

function authOk(req, url) {
  if (!config.authToken) return config.isLoopback;
  const header = req.headers.authorization;
  const queryToken = url.searchParams.get("token");
  return header === `Bearer ${config.authToken}` || queryToken === config.authToken;
}

function body(req) {
  return new Promise((resolve, reject) => {
    let value = "";
    req.on("data", (chunk) => {
      value += chunk;
      if (value.length > 1024 * 1024) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      if (!value) return resolve({});
      try { resolve(JSON.parse(value)); } catch { reject(new Error("Request body must be valid JSON")); }
    });
    req.on("error", reject);
  });
}

async function imageBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) {
      const error = new Error("Image is larger than 10 MB");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function saveUploadedImage(data, contentType) {
  const formats = {
    "image/jpeg": { extension: "jpg", valid: data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff },
    "image/png": { extension: "png", valid: data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
    "image/webp": { extension: "webp", valid: data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP" },
  };
  const format = formats[contentType];
  if (!format?.valid || data.length === 0 || data.length > MAX_IMAGE_BYTES) {
    const error = new Error("Only PNG, JPEG or WebP images up to 10 MB are supported");
    error.status = 415;
    throw error;
  }
  await fs.mkdir(UPLOAD_ROOT, { recursive: true, mode: 0o700 });
  const name = `${crypto.randomUUID()}.${format.extension}`;
  const filePath = path.join(UPLOAD_ROOT, name);
  await fs.writeFile(filePath, data, { mode: 0o600 });
  return { name, path: filePath, type: "file", size: data.length, selectable: true };
}

function getThreadId(message) {
  const params = message.params || {};
  return params.threadId || params.thread?.id || params.turn?.threadId || null;
}

function writeSse(res, event, data, id = null) {
  if (res.destroyed || res.writableEnded) return;
  // A stalled phone reconnects and reconciles history instead of retaining an
  // unbounded queue of token events in the controller.
  if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
  res.write(`${id === null ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastGlobal(event, data) {
  for (const res of globalSubscribers) writeSse(res, event, data);
}

function remember(message) {
  const threadId = getThreadId(message);
  if (!threadId) return null;
  const history = eventHistory.get(threadId) || [];
  const record = { id: `${eventEpoch}:${++eventSequence}`, message };
  history.push(record);
  if (history.length > EVENT_HISTORY_LIMIT) history.splice(0, history.length - EVENT_HISTORY_LIMIT);
  eventHistory.set(threadId, history);
  return record;
}

function withMediaReferences(item) {
  const images = mediaAttachments(item);
  if (images.length) {
    const { result: _result, output: _output, ...metadata } = item;
    return { ...metadata, id: `${item.id}-images`, type: "imageArtifact", attachments: inlineMedia.externalize(images) };
  }
  return item.attachments?.length ? { ...item, attachments: inlineMedia.externalize(item.attachments) } : item;
}

function publish(message) {
  if (message.params?.item) {
    message = { ...message, params: { ...message.params, item: withMediaReferences(message.params.item) } };
  }
  const threadId = getThreadId(message);
  if (threadId && ["turn/started", "turn/completed", "turn/failed", "turn/interrupted", "turn/cancelled", "turn/canceled", "thread/status/changed"].includes(message.method)) apiAgentStatusCache.delete(threadId);
  const activity = message.params?.item;
  if (threadId && activity?.type === "collabAgentToolCall") {
    const states = runtimeSubagentStates.get(threadId) || {};
    for (const [id, value] of Object.entries(activity.agentsStates || {})) {
      states[id] = { status: agentStatus(value.status), updatedAt: Date.now() / 1000 };
      apiAgentStatusCache.delete(id);
    }
    runtimeSubagentStates.set(threadId, states);
    scheduleThreadSync("subagent-status", 100);
  }
  const record = remember(message);
  if (threadId && message.method === "thread/status/changed" && ["idle", "systemError"].includes(message.params?.status?.type)) {
    resolveUnconfirmedForkWrite(threadId);
  }
  if (threadId && ["turn/completed", "turn/failed", "turn/interrupted", "turn/cancelled", "turn/canceled"].includes(message.method)) {
    unconfirmedForkWrites.delete(threadId);
    ownedRunningThreads.delete(threadId);
    scheduleThreadUnsubscribe(threadId);
    const turnId = message.params?.turn?.id || message.params?.turnId;
    const status = message.params?.turn?.status || message.method.split("/")[1];
    void messageQueue.finish(threadId, turnId, status).then(() => messageQueue.kick(threadId)).catch(error => console.warn("Queue:", error.message));
  }
  // Keep the global bus lossless so other local clients (including a CLI
  // bridge) can observe the same live tool progress as thread subscribers.
  broadcastGlobal("notification", message);
  if ([
    "thread/started",
    "thread/archived",
    "thread/unarchived",
    "thread/status/changed",
    "thread/metadata/updated",
    "thread/name/updated",
    "turn/started",
    "turn/completed",
    "turn/failed",
    "turn/interrupted",
    "turn/cancelled",
    "turn/canceled",
  ].includes(message.method)) {
    scheduleThreadSync(`notification:${message.method}`, 200);
  }
  if (!threadId || !subscribers.has(threadId)) return;
  for (const res of subscribers.get(threadId)) {
    writeSse(res, "notification", message, record.id);
    if (message.method === "item/agentMessage/delta") {
      writeSse(res, "delta", { delta: message.params?.delta || "", raw: message }, record.id);
    }
  }
}

client.on("notification", publish);

function approvalFromRequest(message) {
  if (![
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
  ].includes(message.method)) return null;
  const params = message.params || {};
  const command = Array.isArray(params.command) ? params.command.join(" ") : params.command;
  const availableDecisions = Array.isArray(params.availableDecisions)
    ? params.availableDecisions.filter((value) => typeof value === "string")
    : [];
  const permissionSummary = [];
  if (params.permissions?.network?.enabled) permissionSummary.push("访问网络");
  const fileSystem = params.permissions?.fileSystem;
  if (fileSystem?.write?.length || fileSystem?.entries?.some((entry) => entry?.access === "write")) permissionSummary.push("写入额外文件路径");
  if (fileSystem?.read?.length || fileSystem?.entries?.some((entry) => entry?.access === "read")) permissionSummary.push("读取额外文件路径");
  return {
    id: String(message.id),
    method: message.method,
    threadId: params.threadId || null,
    turnId: params.turnId || null,
    itemId: params.itemId || null,
    reason: params.reason || null,
    command: command || null,
    cwd: params.cwd || null,
    grantRoot: params.grantRoot || null,
    commandActions: params.commandActions || null,
    networkApprovalContext: params.networkApprovalContext || null,
    availableDecisions: availableDecisions.length > 0 ? availableDecisions : ["accept", "acceptForSession", "decline"],
    permissionSummary: permissionSummary.join("、") || null,
    requestedAt: Date.now(),
  };
}

client.on("serverRequest", (message) => {
  if (["item/tool/requestUserInput", "tool/requestUserInput", "mcpServer/elicitation/request"].includes(message.method)) {
    const params = message.params || {};
    const fields = Object.entries(params.requestedSchema?.properties || {}).map(([key, value]) => {
      const schema = value && typeof value === "object" ? value : {};
      const options = schema.enum || schema.oneOf?.map((option) => option.const);
      return {
        key,
        title: schema.title || key,
        description: schema.description || null,
        type: typeof schema.type === "string" ? schema.type : "string",
        options: Array.isArray(options) ? options.filter((option) => typeof option === "string") : null,
        required: params.requestedSchema?.required?.includes(key) || false,
      };
    });
    const method = message.method === "tool/requestUserInput" ? "item/tool/requestUserInput" : message.method;
    const input = { ...params, id: String(message.id), method, fields };
    pendingInputs.set(input.id, input);
    broadcastGlobal("input/requested", input);
    return;
  }
  const approval = approvalFromRequest(message);
  if (!approval) return;
  pendingApprovals.set(approval.id, { approval, rpcId: message.id, requestParams: message.params || {} });
  console.log(`Cloudex approval requested: ${approval.method} (${approval.id})`);
  broadcastGlobal("approval/requested", approval);
});

client.on("notification", (message) => {
  if (message.method !== "serverRequest/resolved") return;
  const requestId = message.params?.requestId;
  if (requestId === undefined) return;
  const id = String(requestId);
  if (pendingInputs.delete(id)) broadcastGlobal("input/resolved", { id });
  const pendingApproval = pendingApprovals.get(id);
  if (!pendingApproval) return;
  pendingApprovals.delete(id);
  const decision = message.params?.decision
    || message.params?.response?.decision
    || message.params?.result?.decision
    || null;
  void recordApprovalResolution(pendingApproval.approval, decision).catch((error) => {
    console.error("Failed to persist approval history:", error.message);
  });
  broadcastGlobal("approval/resolved", {
    id,
    threadId: message.params?.threadId || pendingApproval.approval.threadId || null,
    decision,
    approval: pendingApproval.approval,
  });
});

client.on("disconnected", () => {
  ownedRunningThreads.clear();
  for (const threadId of unconfirmedForkWrites) ownedRunningThreads.add(threadId);
  for (const id of pendingInputs.keys()) broadcastGlobal("input/resolved", { id });
  pendingInputs.clear();
  for (const id of pendingApprovals.keys()) broadcastGlobal("approval/resolved", { id });
  pendingApprovals.clear();
});

function resolveUnconfirmedForkWrite(threadId) {
  if (!unconfirmedForkWrites.delete(threadId)) return;
  ownedRunningThreads.delete(threadId);
  scheduleThreadUnsubscribe(threadId);
}

export function scheduleThreadUnsubscribe(threadId, delay = 250) {
  if (!hasCodexProvider() || usesWindowsCliFallback() || ownedRunningThreads.has(threadId)) return;
  if (unsubscribeTimers.has(threadId)) clearTimeout(unsubscribeTimers.get(threadId));
  const timer = setTimeout(() => {
    unsubscribeTimers.delete(threadId);
    if (!ownedRunningThreads.has(threadId)) {
      client.unsubscribeThread(threadId, () => !ownedRunningThreads.has(threadId)).catch((error) =>
        console.warn(`Cloudex unsubscribe failed: ${error.message}`));
    }
  }, delay);
  unsubscribeTimers.set(threadId, timer);
}

export function renewThreadLease(threadId, delay = 20000) {
  if (!subscribers.has(threadId)) return;
  clearTimeout(streamLeaseTimers.get(threadId));
  const timer = setTimeout(() => {
    streamLeaseTimers.delete(threadId);
    for (const res of subscribers.get(threadId) || []) res.destroy();
    subscribers.delete(threadId);
    scheduleThreadUnsubscribe(threadId);
  }, delay);
  streamLeaseTimers.set(threadId, timer);
}

export function subscribe(threadId, res, leased = false) {
  if (!subscribers.has(threadId)) subscribers.set(threadId, new Set());
  subscribers.get(threadId).add(res);
  if (leased) renewThreadLease(threadId);
  const cleanup = () => {
    subscribers.get(threadId)?.delete(res);
    if (subscribers.get(threadId)?.size === 0) {
      subscribers.delete(threadId);
      clearTimeout(streamLeaseTimers.get(threadId));
      streamLeaseTimers.delete(threadId);
      scheduleThreadUnsubscribe(threadId);
    }
  };
  res.on("close", cleanup);
  return cleanup;
}

function subscribeGlobal(res) {
  globalSubscribers.add(res);
  const cleanup = () => globalSubscribers.delete(res);
  res.on("close", cleanup);
  return cleanup;
}

function replayEvents(threadId, res, cursor) {
  const history = eventHistory.get(threadId) || [];
  const cursorIndex = cursor ? history.findIndex(record => record.id === cursor) : -1;
  const resetRequired = Boolean(cursor && cursorIndex < 0);
  writeSse(res, "replay-start", { threadId, resumed: Boolean(cursor), resetRequired });
  const records = resetRequired ? [] : cursor ? history.slice(cursorIndex + 1) : history;
  for (const record of records) {
    const { message } = record;
    writeSse(res, "notification", message, record.id);
    if (message.method === "item/agentMessage/delta") {
      writeSse(res, "delta", { delta: message.params?.delta || "", raw: message }, record.id);
    }
  }
  if (resetRequired) writeSse(res, "history/changed", { threadId, reason: "replay-gap" });
  const latestEventId = history.at(-1)?.id || null;
  writeSse(res, "replay-complete", { threadId, resetRequired, latestEventId }, latestEventId);
}

async function fileListing(candidate) {
  const dir = await normalizeWorkspacePath(candidate);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const data = await Promise.all(entries
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map(async (entry) => {
      const filePath = path.join(dir, entry.name);
      const metadata = entry.isDirectory() ? null : await fs.stat(filePath);
      return {
        name: entry.name,
        path: filePath,
        type: entry.isDirectory() ? "directory" : "file",
        size: metadata?.size ?? null,
        modifiedAt: metadata?.mtime.toISOString() ?? null,
        selectable: true,
      };
    }));
  return { path: dir, entries: data };
}

async function runGit(cwd, args, { allowFailure = false } = {}) {
  try {
    return await execFile("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    if (allowFailure && (error.code === 1 || error.code === 128)) {
      return { stdout: error.stdout || "", stderr: error.stderr || "", code: error.code };
    }
    throw error;
  }
}

async function resolveReviewBase(gitRoot) {
  const candidates = [];
  try {
    const { stdout } = await runGit(gitRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if (stdout.trim()) candidates.push(stdout.trim());
  } catch {
    // Repositories without origin/HEAD are handled by the conventional names below.
  }
  candidates.push("origin/main", "origin/master");

  for (const candidate of [...new Set(candidates)]) {
    try {
      await runGit(gitRoot, ["rev-parse", "--verify", `${candidate}^{commit}`]);
      return candidate;
    } catch {
      // Try the next local origin ref.
    }
  }

  const error = new Error("未找到可用的 origin 分支");
  error.status = 409;
  throw error;
}

function parseGitNameStatus(value) {
  const tokens = value.split("\0").filter(Boolean);
  const records = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      records.push({ status: status.startsWith("R") ? "renamed" : "copied", oldPath: tokens[index++], path: tokens[index++] });
    } else {
      const statusCode = status[0];
      records.push({
        status: statusCode === "A" ? "added" : statusCode === "D" ? "deleted" : "modified",
        oldPath: null,
        path: tokens[index++],
      });
    }
  }
  return records;
}

function parseUnifiedDiff(value) {
  const blocks = [];
  let current = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const rawLine of value.split("\n")) {
    if (rawLine.startsWith("diff --git ")) {
      if (current) blocks.push(current);
      current = { lines: [], binary: false };
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (rawLine.startsWith("Binary files ") || rawLine.startsWith("GIT binary patch")) {
      current.binary = true;
      continue;
    }
    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || rawLine.startsWith("\\ No newline at end of file")) continue;
    const prefix = rawLine[0];
    if (prefix === "+") {
      current.lines.push({ kind: "addition", text: rawLine.slice(1), lineNumber: newLine++ });
    } else if (prefix === "-") {
      current.lines.push({ kind: "deletion", text: rawLine.slice(1), lineNumber: oldLine++ });
    } else if (prefix === " ") {
      current.lines.push({ kind: "context", text: rawLine.slice(1), lineNumber: newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function countTextLines(value) {
  if (!value) return 0;
  const normalized = value.replace(/\r\n/g, "\n");
  return normalized.split("\n").length - (normalized.endsWith("\n") ? 1 : 0);
}

async function gitTextFileLineCount(gitRoot, base, relativePath) {
  const result = await runGit(gitRoot, ["show", base + ":" + relativePath], { allowFailure: true });
  if (result.code) return null;
  return countTextLines(result.stdout);
}

async function workspaceTextFileLineCount(gitRoot, relativePath) {
  try {
    const value = await fs.readFile(path.resolve(gitRoot, relativePath), "utf8");
    return countTextLines(value);
  } catch {
    return null;
  }
}

async function projectReview(candidate) {
  const workspacePath = await normalizeWorkspacePath(candidate);
  const metadata = await fs.stat(workspacePath);
  if (!metadata.isDirectory()) {
    const error = new Error("审阅路径必须是目录");
    error.status = 422;
    throw error;
  }

  const { stdout: rootOutput } = await runGit(workspacePath, ["rev-parse", "--show-toplevel"]);
  const gitRoot = path.resolve(rootOutput.trim());
  const base = await resolveReviewBase(gitRoot);
  const scope = path.relative(gitRoot, workspacePath);
  const scopeArgs = scope ? [scope] : [];
  const diffArgs = ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--unified=3", base, "--", ...scopeArgs];
  const { stdout: nameStatusOutput } = await runGit(gitRoot, ["diff", "--name-status", "-z", "--find-renames", base, "--", ...scopeArgs]);
  const { stdout: diffOutput } = await runGit(gitRoot, diffArgs);
  const records = parseGitNameStatus(nameStatusOutput);
  const blocks = parseUnifiedDiff(diffOutput);

  const { stdout: untrackedOutput } = await runGit(gitRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...scopeArgs]);
  const untrackedPaths = untrackedOutput.split("\0").filter(Boolean);
  for (const relativePath of untrackedPaths) {
    const { stdout: untrackedDiff } = await runGit(gitRoot, ["diff", "--no-index", "--no-color", "--unified=3", "--", "/dev/null", relativePath], { allowFailure: true });
    const parsed = parseUnifiedDiff(untrackedDiff);
    records.push({ status: "added", oldPath: null, path: relativePath, untracked: true });
    blocks.push(parsed[0] || { lines: [], binary: false });
  }

  const files = await Promise.all(records.map(async (record, index) => {
    const block = blocks[index] || { lines: [], binary: false };
    const displayPath = path.relative(workspacePath, path.resolve(gitRoot, record.path)) || path.basename(record.path);
    const additions = block.lines.filter((line) => line.kind === "addition").length;
    const deletions = block.lines.filter((line) => line.kind === "deletion").length;
    const oldLineCount = block.binary || record.status === "added"
      ? (record.status === "added" && !record.untracked
        ? await gitTextFileLineCount(gitRoot, base, record.oldPath || record.path)
        : 0)
      : await gitTextFileLineCount(gitRoot, base, record.oldPath || record.path);
    const newLineCount = block.binary || record.status === "deleted"
      ? null
      : await workspaceTextFileLineCount(gitRoot, record.path);
    return {
      path: displayPath,
      status: record.status,
      additions,
      deletions,
      binary: block.binary,
      oldLineCount,
      newLineCount,
      lines: block.lines,
    };
  }));

  return { path: workspacePath, base, files, generatedAt: Date.now() };
}

async function listAllThreads(archived = false) {
  // Share visibility across projects, search, thread lists and SSE snapshots.
  const threads = threadsWithHierarchy(await listProviderThreads(archived)).filter((thread) => projectCwdForThread(thread) !== null);
  if (!archived) latestThreadHierarchy = threads;
  return threads;
}

const CODEX_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];
const SUBAGENT_SOURCE_KINDS = CODEX_SOURCE_KINDS.filter(source => source.startsWith("subAgent"));

async function listCodexThreads(archived) {
  if (config.historySource === "cli-local") return listCliThreads({ archived, includeSubagents: true, includeArchivedSubagents: true });
  const list = async (archiveFilter, sourceKinds) => {
    const threads = [];
    let cursor = null;
    do {
      const result = await client.request("thread/list", { limit: 100, archived: archiveFilter, cursor, sortDirection: "desc", sourceKinds });
      threads.push(...(result.data || []));
      cursor = result.nextCursor || null;
    } while (cursor);
    return threads;
  };
  // Completed child threads may be archived independently of their parent.
  const [current, otherChildren, local] = await Promise.all([
    list(archived, CODEX_SOURCE_KINDS), list(!archived, SUBAGENT_SOURCE_KINDS),
    listCliThreads({ archived: null, includeSubagents: true }).catch(() => []),
  ]);
  const localById = new Map(local.map(thread => [thread.id, thread]));
  const merged = new Map([...current, ...otherChildren].map(thread => {
    const persisted = localById.get(thread.id);
    if (!persisted) return [thread.id, { ...thread, _subagentStates: runtimeSubagentStates.get(thread.id) || {}, _statusFromHistory: false }];
    const relationship = threadRelationship(thread);
    return [thread.id, { ...persisted, ...thread,
      parentThreadId: relationship.parentThreadId || persisted.parentThreadId,
      agentNickname: relationship.agentNickname || persisted.agentNickname,
      agentRole: relationship.agentRole || persisted.agentRole,
      agentPath: relationship.agentPath || persisted.agentPath,
      agentStatus: thread.status?.type === "idle" && persisted.agentStatus === "active" ? "unknown" : persisted.agentStatus,
      syncRevision: persisted.syncRevision,
      _subagentStates: { ...persisted._subagentStates, ...runtimeSubagentStates.get(thread.id) },
      _agentStatusUpdatedAt: persisted._agentStatusUpdatedAt,
      _statusFromHistory: false,
    }];
  }));
  for (const thread of local) if (!merged.has(thread.id) && threadRelationship(thread).isSubagent) merged.set(thread.id, thread);
  const visibleChildren = flattenThreads(threadsWithHierarchy([...merged.values()])).filter(thread => thread.parentThreadId);
  const needsLifecycle = visibleChildren.filter(thread => ["unknown", "pending"].includes(thread.agentStatus) && thread.status?.type !== "active");
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, needsLifecycle.length) }, async () => {
    while (next < needsLifecycle.length) {
      const summary = needsLifecycle[next++];
      const thread = merged.get(summary.id);
      const revision = `${thread.updatedAt || 0}:${thread.status?.type || ""}`;
      let cached = apiAgentStatusCache.get(thread.id);
      if (!cached || cached.revision !== revision || cached.failed && Date.now() - cached.loadedAt > 30_000) {
        cached = { revision, loadedAt: Date.now(), failed: false };
        cached.reading = client.request("thread/turns/list", { threadId: thread.id, limit: 1, sortDirection: "desc", itemsView: "notLoaded" })
          .then(result => threadAgentStatus({ turns: result.data || [] }))
          .catch(() => { cached.failed = true; return "unknown"; });
        apiAgentStatusCache.set(thread.id, cached);
      }
      thread.agentStatus = await cached.reading;
    }
  }));
  for (const id of apiAgentStatusCache.keys()) if (!merged.has(id)) apiAgentStatusCache.delete(id);
  return [...merged.values()];
}

async function listProviderThreads(archived = false) {
  if (usesQwenProvider()) return qwenProvider.listThreads({ archived });
  if (usesClaudeProvider()) return claudeProvider.listThreads({ archived });
  if (usesBothProviders()) {
    const [codexResult, qwenResult] = await Promise.allSettled([
      listCodexThreads(archived),
      qwenProvider.listThreads({ archived }),
    ]);
    const codexThreads = codexResult.status === "fulfilled"
      ? codexResult.value.map((thread) => ({ ...thread, provider: "codex" }))
      : [];
    const qwenThreads = qwenResult.status === "fulfilled" ? qwenResult.value : [];
    return [...codexThreads, ...qwenThreads].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
  }
  if (usesAllProviders()) {
    const [codexResult, qwenResult, claudeResult] = await Promise.allSettled([
      listCodexThreads(archived), qwenProvider.listThreads({ archived }), claudeProvider.listThreads({ archived }),
    ]);
    const codexThreads = codexResult.status === "fulfilled" ? codexResult.value.map((thread) => ({ ...thread, provider: "codex" })) : [];
    return [...codexThreads, ...(qwenResult.status === "fulfilled" ? qwenResult.value : []), ...(claudeResult.status === "fulfilled" ? claudeResult.value : [])]
      .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
  }
  return listCodexThreads(archived);
}

async function readThreadDetail(threadId, { limit = Number.MAX_SAFE_INTEGER, before = null, around = null } = {}) {
  const fullDetail = await isQwenThread(threadId)
    ? await qwenProvider.readThread(threadId)
    : await isClaudeThread(threadId)
    ? await claudeProvider.readThread(threadId)
    : config.historySource === "cli-local"
    ? await readCliThreadById(threadId)
    : await client.request("thread/read", { threadId, includeTurns: true }).then((result) => {
        const thread = result.thread || result;
        return { thread, turns: thread.turns || [] };
      });
  if (unconfirmedForkWrites.has(threadId)) {
    // Persisted CLI history can lag an accepted write. Ask the live peer only
    // when opening an uncertain fork, without adding a background poll.
    const live = config.historySource === "cli-local"
      ? await client.request("thread/read", { threadId, includeTurns: false }).catch(() => null)
      : fullDetail;
    if (["idle", "systemError"].includes(live?.thread?.status?.type)) resolveUnconfirmedForkWrite(threadId);
  }
  const turns = fullDetail.turns || [];
  const aroundIndex = around ? turns.findIndex((turn) => turn.id === around) : -1;
  const beforeIndex = before ? turns.findIndex((turn) => turn.id === before) : turns.length;
  let end = beforeIndex >= 0 ? beforeIndex : turns.length;
  let start = Math.max(0, end - limit);
  if (aroundIndex >= 0) {
    start = Math.max(0, aroundIndex - Math.floor((limit - 1) / 2));
    end = Math.min(turns.length, start + limit);
    start = Math.max(0, end - limit);
  }
  const page = await mergeApprovalHistory(threadId, turns.slice(start, end).map(turn => ({
    ...turn, items: (turn.items || []).map(withMediaReferences),
  })));
  const { turns: _allTurns, ...thread } = fullDetail.thread;
  const known = flattenThreads(latestThreadHierarchy).find(summary => summary.id === threadId);
  const localHierarchy = known ? [] : threadsWithHierarchy(await listCliThreads({ archived: null, includeSubagents: true }).catch(() => []));
  const summary = known || flattenThreads(localHierarchy).find(summary => summary.id === threadId);
  const { isSubagent, ...relationship } = threadRelationship({ ...summary, ...thread, parentThreadId: thread.parentThreadId || summary?.parentThreadId });
  const useKnownAgentStatus = summary && thread.status?.type !== "active" && (summary.updatedAt || 0) >= (thread.updatedAt || 0)
    && summary.status?.type === thread.status?.type && !["unknown", "pending"].includes(summary.agentStatus);
  delete thread._subagentStates;
  delete thread._agentStatusUpdatedAt;
  delete thread._statusFromHistory;
  return {
    thread: { ...thread, ...relationship,
      ...(isSubagent ? { canAcceptDirectInput: false, agentStatus: useKnownAgentStatus ? summary.agentStatus : threadAgentStatus(fullDetail.thread) } : {}),
      subagents: summary?.subagents || [],
    },
    turns: page,
    hasMoreBefore: start > 0,
    nextBefore: start > 0 ? page[0]?.id || null : null,
  };
}

function itemText(item) {
  const contentText = (item.content || []).map((part) => part.text || part.value || "").join("");
  return String(item.type === "userMessage" ? contentText : (item.text || contentText)).trim();
}

function messageIndexFromDetail(detail) {
  const data = searchableConversationMessages(detail.turns).map((item) => ({
    ...item,
    text: item.text.slice(0, 240),
  }));
  return { data };
}

function searchableConversationMessages(turns = []) {
  const data = [];
  for (const turn of turns) {
    const items = turn.items || [];
    const finalAgentIndex = items.findLastIndex((item) => (item.type === "plan" || item.type === "agentMessage" && item.phase === "final_answer")) >= 0
      ? items.findLastIndex((item) => (item.type === "plan" || item.type === "agentMessage" && item.phase === "final_answer"))
      : items.findLastIndex((item) => ["agentMessage", "plan"].includes(item.type));
    items.forEach((item, index) => {
      if (item.type !== "userMessage" && index !== finalAgentIndex) return;
      const text = itemText(item);
      if (!text) return;
      data.push({
        id: item.id || `${turn.id}-${item.type}-${index}`,
        turnId: turn.id,
        role: item.type === "userMessage" ? "user" : "assistant",
        text: text.replace(/\s+/g, " "),
        createdAt: item.createdAt || turn.startedAt || null,
      });
    });
  }
  return data;
}

function searchSnippet(text, query) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const index = normalized.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return null;
  const start = Math.max(0, index - 70);
  const end = Math.min(normalized.length, index + query.length + 110);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

async function searchConversationMessages(query) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return [];
  const threads = await listAllThreads(false);
  const results = new Array(threads.length);
  let next = 0;
  let count = 0;
  // Background search must leave disk capacity for opening the selected chat.
  await Promise.all(Array.from({ length: Math.min(2, threads.length) }, async () => {
    while (next < threads.length && count < 500) {
      const index = next++;
      const thread = threads[index];
      try {
        const turns = Array.isArray(thread.turns) ? thread.turns
          : config.historySource === "cli-local" && !await isQwenThread(thread.id) && !await isClaudeThread(thread.id)
          ? (await readCliThreadById(thread.id)).turns : (await readThreadDetail(thread.id)).turns;
        results[index] = searchableConversationMessages(turns).flatMap((item) => {
          const snippet = searchSnippet(item.text, trimmed);
          if (!snippet) return [];
          return [{
            id: `${thread.id}:${item.id}`,
            threadId: thread.id,
            messageId: item.id,
            turnId: item.turnId,
            role: item.role,
            text: item.text.slice(0, 240),
            snippet,
            createdAt: item.createdAt,
          }];
        });
        count += results[index].length;
      } catch { results[index] = []; }
    }
  }));
  return results.flat().slice(0, 500);
}

function compactTurn(turn) {
  const items = turn.items || [];
  // An active turn has no stable "final" item yet. Compacting it to the last
  // assistant message makes a relaunched client lose all earlier commentary
  // and tool executions from the same task. Keep the active turn complete;
  // completed turns still use the lightweight representation below.
  if (turn.status === "inProgress") {
    return {
      ...turn,
      items,
      itemsView: "full",
      processItemCount: 0,
      detailsLoaded: true,
    };
  }
  const finalAgentIndex = items.findLastIndex((item) => (item.type === "plan" || item.type === "agentMessage" && item.phase === "final_answer")) >= 0
    ? items.findLastIndex((item) => (item.type === "plan" || item.type === "agentMessage" && item.phase === "final_answer"))
    : items.findLastIndex((item) => ["agentMessage", "plan"].includes(item.type));
  const visibleItems = items.filter((item, index) => item.type === "userMessage" || index === finalAgentIndex || item.attachments?.length);
  const processItemCount = Math.max(0, items.length - visibleItems.length);
  return {
    ...turn,
    items: visibleItems,
    processItemCount,
    detailsLoaded: processItemCount === 0,
  };
}

function compactThreadDetail(detail) {
  return {
    thread: detail.thread,
    turns: (detail.turns || []).map(compactTurn),
    hasMoreBefore: detail.hasMoreBefore,
    nextBefore: detail.nextBefore,
  };
}

const NO_PROJECT_CWD = "未指定项目目录";
const temporaryRoots = [os.tmpdir(), ...(process.platform === "darwin" ? ["/tmp"] : [])]
  .flatMap((root) => {
    try { return [path.resolve(root), syncFs.realpathSync(root)]; }
    catch { return [path.resolve(root)]; }
  });

function projectCwdForThread(thread) {
  const cwd = String(thread.cwd || "").trim();
  if (!cwd || cwd === NO_PROJECT_CWD) return NO_PROJECT_CWD;

  const resolved = path.resolve(cwd);
  const home = path.resolve(os.homedir());
  const codexScratchRoot = path.join(home, "Documents", "Codex");
  const codexStateRoot = path.join(home, ".codex");
  const applicationSupportRoot = path.join(home, "Library", "Application Support");
  const isInside = (root) => {
    const relative = path.relative(root, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  if (temporaryRoots.some(isInside)) return null;

  // Noninteractive helper runs can be labelled thread_source=user by Codex.
  // Runtime workspaces identify these; image-prefixed prompts alone do not.
  const isCodexExec = (!thread.provider || thread.provider === "codex")
    && ["exec", "codex_exec"].includes(thread.source);
  if (isCodexExec && (isInside(path.join(codexStateRoot, "pet-runs"))
    || (process.platform === "darwin" && isInside(applicationSupportRoot)))) return null;

  // Codex creates dated scratch directories when a conversation is started
  // without choosing a project. Their final path component looks like a
  // project name (for example bh-w or token-api-api), but it is not one.
  if (resolved === home || isInside(codexScratchRoot) || isInside(codexStateRoot)
    || (process.platform === "darwin" && isInside(applicationSupportRoot))) {
    return NO_PROJECT_CWD;
  }
  return cwd;
}

export function projectsFromThreads(threads) {
  const projects = new Map();
  for (const thread of threadsWithHierarchy(threads)) {
    const cwd = projectCwdForThread(thread);
    if (cwd === null) continue;
    if (!projects.has(cwd)) {
      projects.set(cwd, {
        id: cwd,
        name: cwd === NO_PROJECT_CWD ? "无项目" : path.basename(cwd) || cwd,
        cwd,
        threads: [],
        updatedAt: thread.updatedAt || thread.createdAt || 0,
      });
    }
    const project = projects.get(cwd);
    project.threads.push(thread);
    project.updatedAt = Math.max(project.updatedAt, thread.updatedAt || thread.createdAt || 0);
  }
  return [...projects.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function visibleThreadCount(projects) {
  return projects.reduce((count, project) => count + project.threads.length, 0);
}

function projectRootsFromThreads(threads) {
  return projectsFromThreads(threads)
    .map((project) => project.cwd)
    .filter((cwd) => cwd && cwd !== NO_PROJECT_CWD)
    .map((cwd) => path.resolve(cwd));
}

async function normalizeWorkspacePath(candidate) {
  if (isUploadedImagePath(candidate)) return path.resolve(candidate);
  if (candidate && path.dirname(path.resolve(candidate)) === INLINE_MEDIA_ROOT
      && /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(path.basename(candidate))) return path.resolve(candidate);
  try {
    return normalizePath(candidate);
  } catch (error) {
    if (error.status !== 403) throw error;
  }

  const cachedRoots = (latestProjectSnapshot?.projects || [])
    .map((project) => project.cwd)
    .filter((cwd) => cwd && cwd !== NO_PROJECT_CWD)
    .map((cwd) => path.resolve(cwd));
  try {
    return normalizeAllowedPath(candidate, {
      defaultPath: config.defaultCwd,
      roots: cachedRoots,
    });
  } catch (error) {
    if (error.status !== 403) throw error;
  }

  return normalizeAllowedPath(candidate, {
    defaultPath: config.defaultCwd,
    roots: projectRootsFromThreads(await listAllThreads(false)),
  });
}

function isUploadedImagePath(candidate) {
  const resolved = path.resolve(candidate);
  return isPathInside(UPLOAD_ROOT, resolved)
    && /^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(path.basename(resolved));
}

function threadSignature(threads) {
  return JSON.stringify(flattenThreads(threads).map((thread) => ({
    id: thread.id,
    cwd: thread.cwd || "",
    name: thread.name || "",
    preview: thread.preview || "",
    updatedAt: thread.updatedAt || 0,
    syncRevision: thread.syncRevision || "",
    status: thread.status?.type || "",
    activeFlags: thread.status?.activeFlags || [],
    parentThreadId: thread.parentThreadId || null,
    agentStatus: thread.agentStatus || "",
    agentNickname: thread.agentNickname || "",
    agentRole: thread.agentRole || "",
    agentPath: thread.agentPath || "",
  })));
}

function snapshotFromThreads(threads) {
  const projects = projectsFromThreads(threads);
  return {
    generatedAt: Date.now(),
    projects,
    total: visibleThreadCount(projects),
  };
}

function scheduleThreadSync(reason = "manual", delay = 0) {
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncThreads(reason).catch((error) => console.warn(`Cloudex sync failed: ${error.message}`));
  }, delay);
}

async function syncThreads(reason = "manual") {
  if (syncInFlight) {
    syncAgainReason = reason;
    return;
  }
  syncInFlight = true;
  try {
    void messageQueue.tick().catch(error => console.warn("Queue:", error.message));
    const revision = archiveRevision;
    const threads = await listAllThreads(false);
    if (revision !== archiveRevision) {
      syncAgainReason = "thread-archived";
      return;
    }
    const signature = threadSignature(threads);
    if (signature !== latestThreadSignature) {
      latestThreadSignature = signature;
      latestProjectSnapshot = snapshotFromThreads(threads);
      broadcastGlobal("threads/changed", { reason, ...latestProjectSnapshot });
    }
  } finally {
    syncInFlight = false;
    if (syncAgainReason) {
      const nextReason = syncAgainReason;
      syncAgainReason = null;
      scheduleThreadSync(nextReason, 100);
    }
  }
}

export function notifyHistoryChanged(file) {
  const threadId = file ? threadIdFromPath(file) : null;
  for (const id of threadId ? [threadId] : subscribers.keys()) changedHistoryThreads.add(id);
  if (!historyChangeTimer) historyChangeTimer = setTimeout(() => {
    historyChangeTimer = null;
    for (const id of changedHistoryThreads) {
      for (const res of subscribers.get(id) || []) writeSse(res, "history/changed", { threadId: id });
    }
    changedHistoryThreads.clear();
  }, 100);
  scheduleThreadSync("session-changed", 100);
}

function startThreadSync() {
  scheduleThreadSync("startup", 0);
  if (hasCodexProvider() && config.historySource === "cli-local") {
    stopWatchingSessions = watchCliSessions(notifyHistoryChanged, {
      getObservedThreadIds: () => observedThreadIds((latestProjectSnapshot?.projects || []).flatMap(project => project.threads || []), subscribers.keys()),
    });
  }
  syncInterval = setInterval(() => scheduleThreadSync("poll", 0), 3000);
}

function stopThreadSync() {
  stopWatchingSessions?.();
  stopWatchingSessions = null;
  if (syncTimer) clearTimeout(syncTimer);
  if (syncInterval) clearInterval(syncInterval);
  syncTimer = null;
  syncInterval = null;
  clearTimeout(historyChangeTimer);
  historyChangeTimer = null;
  changedHistoryThreads.clear();
}

async function normalizeThreadCwd(candidate) {
  const resolved = path.resolve(candidate || config.defaultCwd);
  try {
    return normalizePath(resolved);
  } catch (error) {
    if (error.status !== 403) throw error;
    const knownThreads = await listAllThreads(false);
    if (knownThreads.some((thread) => thread.cwd && path.resolve(thread.cwd) === resolved)) return resolved;
    throw error;
  }
}

async function inputFrom(bodyData, { checkFiles = false, preserveWhitespace = false } = {}) {
  const rawMessage = typeof bodyData.message === "string" ? bodyData.message : "";
  const message = preserveWhitespace ? rawMessage : rawMessage.trim();
  if (bodyData.message != null && typeof bodyData.message !== "string") {
    throw Object.assign(new Error("message must be a string"), { status: 422 });
  }
  if (bodyData.files != null && !Array.isArray(bodyData.files)) {
    throw Object.assign(new Error("files must be an array"), { status: 422 });
  }
  if (!message.trim() && !bodyData.files?.length) {
    const error = new Error("message is required");
    error.status = 422;
    throw error;
  }
  const input = message.trim() ? [{ type: "text", text: message }] : [];
  for (const file of bodyData.files || []) {
    const candidate = typeof file === "string" ? file : file?.url || file?.path;
    if (typeof candidate !== "string" || !candidate.trim()) {
      throw Object.assign(new Error("Attachment path or image URL is required"), { status: 422 });
    }
    if (/^(?:https?:\/\/|data:)/i.test(candidate)) {
      let valid = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]+$/i.test(candidate);
      if (/^https?:\/\//i.test(candidate)) {
        try { const url = new URL(candidate); valid = Boolean(url.hostname) && !url.username && !url.password; } catch { /* Invalid URL. */ }
      }
      if (!valid || file?.kind !== "image") {
        throw Object.assign(new Error("Only image attachments support HTTP(S) or image data URLs"), { status: 422 });
      }
      input.push({ type: "image", url: candidate });
      continue;
    }
    const filePath = await normalizeWorkspacePath(candidate);
    if (checkFiles) {
      const metadata = await fs.stat(filePath).catch(error => {
        if (["ENOENT", "ENOTDIR"].includes(error.code)) throw Object.assign(new Error("Attachment is no longer available"), { status: 422 });
        throw error;
      });
      if (!metadata.isFile()) throw Object.assign(new Error("Attachment path is not a file"), { status: 422 });
    }
    if (isImage(filePath)) input.push({ type: "localImage", path: filePath });
    else {
      if (input[0]?.type !== "text") input.unshift({ type: "text", text: "" });
      input[0].text += `${input[0].text ? "\n\n" : ""}[Attached local file: ${filePath}]`;
    }
  }
  return input;
}

async function collaborationFor(data) {
  if (!data.collaborationMode) return {};
  const modes = await client.request("collaborationMode/list", {});
  return collaborationModeParams(data, modes.data || []);
}

function isUnfinishedTurn(turn) {
  if (!turn?.id) return false;
  const status = String(turn.status || "").toLowerCase();
  if (["completed", "failed", "interrupted", "cancelled", "canceled"].includes(status)) return false;
  return status === "inprogress" || status === "in_progress" || status === "active" || !turn.completedAt;
}

function findActiveTurnId(thread) {
  const turns = thread?.turns || [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (isUnfinishedTurn(turns[index])) return turns[index].id;
  }
  return null;
}

async function resolveActiveTurn(threadId, { refresh = false } = {}) {
  const cachedTurnId = client.getActiveTurn(threadId);
  if (cachedTurnId && !refresh) return { turnId: cachedTurnId, source: "cache" };
  const result = await readThreadDetail(threadId);
  const thread = result.thread || result;
  const turnId = thread?.status?.type === "idle" ? null : findActiveTurnId(result);
  if (turnId) client.setActiveTurn(threadId, turnId);
  else client.clearActiveTurn(threadId);
  return {
    turnId,
    source: turnId ? (config.historySource === "cli-local" ? "cli-local" : "thread/read") : null,
    thread,
  };
}

function isStaleTurnError(error) {
  // A stale expectedTurnId can race with turn completion or a reconnect.
  // JSON-RPC method-not-found is a different failure and must remain visible.
  if (error?.error?.code === -32601) return false;
  const message = String(error?.message || "").toLowerCase();
  return message.includes("not found")
    || message.includes("no active turn")
    || message.includes("expected turn");
}

async function sendThreadMessage(threadId, data) {
  if (data.collaborationMode && (await isQwenThread(threadId) || await isClaudeThread(threadId) || usesWindowsCliFallback())) {
    throw Object.assign(new Error("This provider does not support Codex collaboration modes"), { status: 422 });
  }
  let thread = null;
  let turn = null;
  const qwenThread = await isQwenThread(threadId);
  if (qwenThread) {
    const input = await inputFrom(data);
    const prompt = input.map((part) => part.type === "text" ? part.text : "").join("\n").trim();
    const result = await qwenProvider.sendMessage(threadId, {
      prompt,
      files: input.filter((part) => part.type === "localImage"),
      model: data.model || null,
      onEvent: (message) => publish(message),
    });
    thread = result.thread;
    turn = result.turn;
  } else if (await isClaudeThread(threadId)) {
    const input = await inputFrom(data);
    const prompt = input.map((part) => part.type === "text" ? part.text : "").join("\n").trim();
    const result = await claudeProvider.sendMessage(threadId, {
      prompt,
      files: input.filter((part) => part.type === "localImage"),
      model: data.model || null,
      effort: data.effort || null,
      permissionMode: data.claudePermissionMode || "manual",
      onEvent: (message) => publish(message),
    });
    thread = result.thread;
    turn = result.turn;
  } else if (usesWindowsCliFallback()) {
    const input = await inputFrom(data);
    const prompt = input.map((part) => part.type === "text" ? part.text : "").join("\n").trim();
    const images = input.filter((part) => part.type === "localImage");
    const resumed = await resumeWindowsThread({
      threadId,
      prompt,
      files: images,
      model: data.model || null,
      effort: data.effort || null,
      sandbox: data.sandbox || "workspace-write",
      approvalPolicy: data.approvalPolicy || "on-request",
      approvalsReviewer: data.approvalsReviewer || "user",
      onAppMessage: (message) => publish(message),
    });
    turn = { id: resumed.turnId, status: "inProgress" };
  } else {
    const collaboration = await collaborationFor(data);
    if (ownedRunningThreads.has(threadId)) {
      const error = new Error("此会话已有正在执行的 Cloudex 任务，请等待完成或使用引导对话。");
      error.status = 409;
      throw error;
    }
    ownedRunningThreads.add(threadId);
    try {
      const resume = await client.subscribeThread(threadId);
      const turnResult = await client.request("turn/start", {
        threadId,
        input: await inputFrom(data, { preserveWhitespace: true }),
        clientUserMessageId: data.clientUserMessageId || null,
        ...collaboration,
        model: data.model || null,
        effort: data.effort || null,
        approvalPolicy: data.approvalPolicy || "on-request",
        approvalsReviewer: data.approvalsReviewer || "user",
        sandboxPolicy: sandboxPolicyFor(data.sandbox || "workspace-write"),
      });
      thread = resume?.thread || resume || null;
      turn = turnResult.turn || turnResult;
    } catch (error) {
      ownedRunningThreads.delete(threadId);
      throw error;
    } finally {
      scheduleThreadUnsubscribe(threadId, 2000);
    }
  }
  return { thread, turn };
}

export async function handle(req, res, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    });
    return res.end();
  }
  if (!authOk(req, url)) return json(res, 401, { error: "Unauthorized" });

  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, {
      ok: true,
      controller: "cloudex-codex-control",
      codexConnected: hasCodexProvider() && Boolean(client.socket && !client.socket.closed),
      qwenAvailable: usesBothProviders() || usesQwenProvider(),
      claudeAvailable: usesClaudeProvider() || usesAllProviders(),
      agentProvider: config.agentProvider,
      controlSocket: config.controlSocketPath,
      mode: usesQwenProvider()
        ? "qwen-cli"
        : (usesClaudeProvider()
          ? "claude-cli"
          : (usesAllProviders()
            ? "multi-provider"
            : (usesBothProviders()
              ? "multi-provider"
              : (config.historySource === "cli-local" ? "cli-local-history" : "api-only")))),
      historySource: config.historySource,
      codexSessionsDir: config.codexSessionsDir,
      host: config.host,
      port: config.port,
      fileRoots: config.fileRoots,
      messageQueue: true,
      ownedRunningThreadCount: ownedRunningThreads.size,
      pendingApprovalCount: pendingApprovals.size,
      pendingInputCount: pendingInputs.size,
    });
  }
  if (req.method === "GET" && url.pathname === "/api/models") {
    return json(res, 200, await listModels());
  }
  const queueMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/queue$/);
  if (queueMatch) {
    const threadId = decodeURIComponent(queueMatch[1]);
    if (req.method === "GET") return json(res, 200, await messageQueue.list(threadId));
    if (req.method === "POST") {
      const data = await body(req);
      if (data.action) return json(res, 200, await messageQueue.update(threadId, data));
      await readThreadDetail(threadId, { limit: 1 });
      await inputFrom(data);
      if (data.collaborationMode) await collaborationFor(data);
      return json(res, 202, await messageQueue.add(threadId, data));
    }
  }
  if (req.method === "GET" && url.pathname === "/api/collaboration-modes") {
    if (!hasCodexProvider() || isWindowsPlatform()) return json(res, 200, { data: [], supported: false });
    const result = await client.request("collaborationMode/list", {});
    return json(res, 200, { ...result, supported: true });
  }
  if (req.method === "GET" && url.pathname === "/api/projects") {
    const threads = await listAllThreads(false);
    const projects = projectsFromThreads(threads);
    return json(res, 200, { data: projects, total: visibleThreadCount(projects) });
  }
  if (req.method === "GET" && url.pathname === "/api/search/messages") {
    const query = url.searchParams.get("q") || "";
    return json(res, 200, { data: await searchConversationMessages(query) });
  }
  if (req.method === "GET" && url.pathname === "/api/threads") {
    const archived = url.searchParams.has("archived") ? url.searchParams.get("archived") === "true" : false;
    const data = await listAllThreads(archived);
    return json(res, 200, { data, nextCursor: null, total: data.length });
  }
  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    const cleanup = subscribeGlobal(res);
    writeSse(res, "ready", { mode: "api-only" });
    if (latestProjectSnapshot) writeSse(res, "threads/changed", { reason: "replay", ...latestProjectSnapshot });
    for (const { approval } of pendingApprovals.values()) writeSse(res, "approval/requested", approval);
    for (const input of pendingInputs.values()) writeSse(res, "input/requested", input);
    scheduleThreadSync("client-connected", 0);
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
    res.on("close", () => { clearInterval(keepAlive); cleanup(); });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/files") {
    return json(res, 200, await fileListing(url.searchParams.get("path")));
  }
  if (req.method === "POST" && url.pathname === "/api/uploads/image") {
    const file = await saveUploadedImage(await imageBody(req), req.headers["content-type"]?.split(";")[0]);
    return json(res, 201, file);
  }
  if (req.method === "GET" && url.pathname === "/api/review") {
    return json(res, 200, await projectReview(url.searchParams.get("path")));
  }
  if (req.method === "GET" && url.pathname === "/api/file") {
    return sendFilePreview(res, url.searchParams.get("path"), url.searchParams.get("previewRoot"));
  }
  if (req.method === "GET" && url.pathname === "/api/approvals") {
    return json(res, 200, { data: [...pendingApprovals.values()].map(({ approval }) => approval) });
  }
  if (req.method === "GET" && url.pathname === "/api/inputs") {
    return json(res, 200, { data: [...pendingInputs.values()] });
  }
  const inputMatch = url.pathname.match(/^\/api\/inputs\/([^/]+)\/respond$/);
  if (req.method === "POST" && inputMatch) {
    const id = decodeURIComponent(inputMatch[1]);
    const input = pendingInputs.get(id);
    if (!input) return json(res, 409, { error: "Input request is no longer pending" });
    const response = await body(req);
    if (["item/tool/requestUserInput", "tool/requestUserInput"].includes(input.method)) {
      if (!response.answers || typeof response.answers !== "object" || Array.isArray(response.answers)) {
        return json(res, 422, { error: "answers must be an object" });
      }
      for (const question of input.questions || []) {
        if (!Array.isArray(response.answers[question.id]?.answers)
          || !response.answers[question.id].answers.every((answer) => typeof answer === "string")) {
          return json(res, 422, { error: `Missing answer for ${question.id}` });
        }
      }
      client.respondServerRequest(id, { answers: response.answers });
    } else {
      if (!["accept", "decline", "cancel"].includes(response.action)) {
        return json(res, 422, { error: "Invalid elicitation action" });
      }
      if (response.action === "accept" && response.content !== undefined
        && (!response.content || typeof response.content !== "object" || Array.isArray(response.content))) {
        return json(res, 422, { error: "content must be an object" });
      }
      client.respondServerRequest(id, response.action === "accept"
        ? { action: "accept", content: response.content || {} }
        : { action: response.action });
    }
    pendingInputs.delete(id);
    broadcastGlobal("input/resolved", { id });
    return json(res, 200, { ok: true });
  }
  const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/respond$/);
  if (req.method === "POST" && approvalMatch) {
    const id = decodeURIComponent(approvalMatch[1]);
    const pendingApproval = pendingApprovals.get(id);
    if (!pendingApproval) {
      const error = new Error("Approval request is no longer pending");
      error.status = 409;
      throw error;
    }
    const data = await body(req);
    const decision = String(data.decision || "");
    const supported = new Set(["accept", "acceptForSession", "decline"]);
    if (!supported.has(decision)) {
      const error = new Error("decision must be accept, acceptForSession, or decline");
      error.status = 422;
      throw error;
    }
    if (pendingApproval.approval.method === "item/permissions/requestApproval") {
      const permissions = decision === "decline" ? {} : (pendingApproval.requestParams.permissions || {});
      const scope = decision === "acceptForSession" ? "session" : "turn";
      client.respondServerRequest(pendingApproval.rpcId, { permissions, scope });
    } else {
      client.respondServerRequest(pendingApproval.rpcId, { decision });
    }
    pendingApprovals.delete(id);
    await recordApprovalResolution(pendingApproval.approval, decision);
    broadcastGlobal("approval/resolved", {
      id,
      threadId: pendingApproval.approval.threadId,
      decision,
      approval: pendingApproval.approval,
    });
    scheduleThreadSync("approval-resolved", 100);
    return json(res, 200, { ok: true, id, decision });
  }
  const detailMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
  if (req.method === "GET" && detailMatch) {
    const threadId = decodeURIComponent(detailMatch[1]);
    const rawLimit = url.searchParams.get("limit");
    const requestedLimit = rawLimit === null ? 12 : Number.parseInt(rawLimit, 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(20, Math.max(1, requestedLimit)) : 12;
    const before = url.searchParams.get("before") || null;
    const around = url.searchParams.get("around") || null;
    const result = await readThreadDetail(threadId, { limit, before, around });
    return json(res, 200, url.searchParams.get("view") === "compact" ? compactThreadDetail(result) : result);
  }
  const turnDetailMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/turns\/([^/]+)$/);
  if (req.method === "GET" && turnDetailMatch) {
    const threadId = decodeURIComponent(turnDetailMatch[1]);
    const turnId = decodeURIComponent(turnDetailMatch[2]);
    const detail = await readThreadDetail(threadId, { limit: 1, around: turnId });
    const turn = detail.turns.find((candidate) => candidate.id === turnId);
    if (!turn) {
      const error = new Error("Turn not found");
      error.status = 404;
      throw error;
    }
    return json(res, 200, { turn: { ...turn, detailsLoaded: true, processItemCount: null } });
  }
  const messageIndexMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/message-index$/);
  if (req.method === "GET" && messageIndexMatch) {
    const threadId = decodeURIComponent(messageIndexMatch[1]);
    const detail = await readThreadDetail(threadId);
    return json(res, 200, messageIndexFromDetail(detail));
  }
  const streamMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/stream$/);
  const leaseMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/lease$/);
  if (req.method === "POST" && leaseMatch) {
    renewThreadLease(decodeURIComponent(leaseMatch[1]));
    return json(res, 200, {});
  }
  if (req.method === "GET" && streamMatch) {
    const threadId = decodeURIComponent(streamMatch[1]);
    const qwenThread = await isQwenThread(threadId);
    const claudeThread = await isClaudeThread(threadId);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    const cleanup = subscribe(threadId, res, url.searchParams.get("lease") === "1");
    writeSse(res, "ready", { threadId, mode: "api-only" });
    replayEvents(threadId, res, req.headers["last-event-id"]);
    if (qwenThread) {
      writeSse(res, "subscribed", { threadId, provider: "qwen" });
    } else if (claudeThread) {
      writeSse(res, "subscribed", { threadId, provider: "claude" });
    } else if (usesWindowsCliFallback()) {
      // Windows runs the Codex CLI as a child process. Its JSONL events are
      // bridged into publish() below, so the SSE channel stays open and the
      // app receives live notifications instead of polling only.
      writeSse(res, "subscribed", { threadId });
    } else {
      // Viewing history must not claim the Codex writer; sending a turn resumes the thread.
      writeSse(res, "read-only", { threadId });
    }
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
    res.on("close", () => { clearInterval(keepAlive); cleanup(); });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/threads") {
    const data = await body(req);
    if (data.collaborationMode && (usesQwenProvider() || usesClaudeProvider() || ["qwen", "claude"].includes(data.provider) || usesWindowsCliFallback())) {
      throw Object.assign(new Error("This provider does not support Codex collaboration modes"), { status: 422 });
    }
    const collaboration = data.collaborationMode ? await collaborationFor(data) : {};
    const noProject = data.noProject === true || data.cwd === NO_PROJECT_CWD;
    const cwd = noProject ? null : await normalizeThreadCwd(data.cwd || config.defaultCwd);
    let thread = null;
    let turn = null;
    if (usesQwenProvider() || (usesBothProviders() && data.provider === "qwen") || (usesAllProviders() && data.provider === "qwen")) {
      const result = await qwenProvider.startThread({
        cwd: cwd || config.defaultCwd,
        prompt: data.prompt,
        files: data.files || [],
        model: data.model || null,
        onEvent: (message) => publish(message),
      });
      thread = result.thread;
      turn = result.turn;
    } else if (usesClaudeProvider() || usesAllProviders() && data.provider === "claude") {
      const result = await claudeProvider.startThread({
        cwd: cwd || config.defaultCwd,
        prompt: data.prompt,
        files: data.files || [],
        model: data.model || null,
        effort: data.effort || null,
        permissionMode: data.claudePermissionMode || "manual",
        onEvent: (message) => publish(message),
      });
      thread = result.thread;
      turn = result.turn;
    } else if (usesWindowsCliFallback()) {
      const threadId = await startWindowsThread({
        cwd: cwd || config.defaultCwd,
        prompt: data.prompt,
        files: data.files,
        model: data.model || null,
        effort: data.effort || null,
        sandbox: data.sandbox || "workspace-write",
        approvalPolicy: data.approvalPolicy || "on-request",
        approvalsReviewer: data.approvalsReviewer || "user",
        onAppMessage: (message) => publish(message),
      });
      thread = (await readCliThreadById(threadId)).thread;
    } else {
      const params = {
        model: data.model || null,
        sandbox: data.sandbox || "workspace-write",
        approvalPolicy: data.approvalPolicy || "on-request",
        approvalsReviewer: data.approvalsReviewer || "user",
        personality: data.personality || null,
      };
      if (cwd) params.cwd = cwd;
      const result = await client.request("thread/start", params);
      thread = result.thread || result;
      // thread/start automatically subscribes this app-server connection. Record
      // that fact immediately so a phone opening the new thread does not issue a
      // redundant thread/resume before its first rollout has been persisted.
      client.markThreadSubscribed(thread.id);
      try {
        if (data.prompt) {
          ownedRunningThreads.add(thread.id);
          const turnResult = await client.request("turn/start", {
            threadId: thread.id,
            input: await inputFrom({ message: data.prompt, files: data.files }),
            ...collaboration,
            model: data.model || null,
            effort: data.effort || null,
            approvalPolicy: data.approvalPolicy || "on-request",
            approvalsReviewer: data.approvalsReviewer || "user",
            sandboxPolicy: sandboxPolicyFor(data.sandbox || "workspace-write"),
          });
          turn = turnResult.turn || turnResult;
        }
      } catch (error) {
        ownedRunningThreads.delete(thread.id);
        throw error;
      } finally {
        scheduleThreadUnsubscribe(thread.id, 2000);
      }
    }
    scheduleThreadSync("thread-created", 100);
    return json(res, 201, { thread, turn });
  }

  const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)(?:\/(message|steer|stop|archive|fork))?$/);
  if (threadMatch) {
    const threadId = decodeURIComponent(threadMatch[1]);
    const action = threadMatch[2];
    if (req.method === "POST" && action === "message") {
      const data = await body(req);
      const queue = await messageQueue.list(threadId);
      if (queue.items.some(item => ["pending", "running", "dispatching", "blocked", "unconfirmed"].includes(item.status))) {
        throw Object.assign(new Error("此会话已有排队消息，请加入队列或先处理现有队列"), { status: 409 });
      }
      let result;
      try { result = await sendThreadMessage(threadId, data); }
      catch (error) { error.sendUnconfirmed = writeResultUnconfirmed(error); throw error; }
      const { thread, turn } = result;
      scheduleThreadSync("message-sent", 100);
      return json(res, 202, { thread, turn });
    }
    if (req.method === "POST" && action === "steer") {
      if (await isQwenThread(threadId)) {
        const error = new Error("Qwen Code provider does not support turn steering");
        error.status = 501;
        throw error;
      }
      if (await isClaudeThread(threadId)) {
        const error = new Error("Claude Code provider does not support turn steering");
        error.status = 501;
        throw error;
      }
      if (usesWindowsCliFallback()) {
        const error = new Error("Codex turn steering is not supported by the Windows CLI fallback");
        error.status = 501;
        throw error;
      }
      const data = await body(req);
      let resolved = await resolveActiveTurn(threadId, { refresh: true });
      if (!resolved.turnId) {
        const status = resolved.thread?.status?.type ? ` (${resolved.thread.status.type})` : "";
        const error = new Error(`No active turn for this thread${status}`);
        error.status = 409;
        throw error;
      }
      const input = await inputFrom(data);
      let result;
      try {
        result = await client.request("turn/steer", {
          threadId,
          input,
          expectedTurnId: resolved.turnId,
        });
      } catch (error) {
        if (!isStaleTurnError(error)) throw error;
        const previousTurnId = resolved.turnId;
        client.clearActiveTurn(threadId);
        resolved = await resolveActiveTurn(threadId, { refresh: true });
        if (!resolved.turnId || resolved.turnId === previousTurnId) throw error;
        result = await client.request("turn/steer", {
          threadId,
          input,
          expectedTurnId: resolved.turnId,
        });
      }
      scheduleThreadSync("turn-steered", 100);
      return json(res, 202, {
        thread: resolved.thread,
        turn: result,
        turnId: resolved.turnId,
        source: resolved.source,
      });
    }
    if (req.method === "POST" && action === "fork") {
      if (await isQwenThread(threadId)) {
        const error = new Error("Qwen Code provider does not support thread forking");
        error.status = 501;
        throw error;
      }
      if (await isClaudeThread(threadId)) {
        const error = new Error("Claude Code provider does not support thread forking");
        error.status = 501;
        throw error;
      }
      if (usesWindowsCliFallback()) {
        const error = new Error("Fork is not supported on Windows CLI mode");
        error.status = 501;
        throw error;
      }
      const data = await body(req);
      const turnId = typeof data.turnId === "string" ? data.turnId.trim() : "";
      if (!turnId) {
        const error = new Error("turnId is required");
        error.status = 422;
        throw error;
      }
      const position = data.position ?? "through";
      if (!["before", "through", "after"].includes(position)) {
        throw Object.assign(new Error("position must be before or through"), { status: 422 });
      }
      const hasEditedMessage = Object.hasOwn(data, "message");
      const input = hasEditedMessage ? await inputFrom(data, { checkFiles: true, preserveWhitespace: true }) : null;
      if (!hasEditedMessage && data.files != null && (!Array.isArray(data.files) || data.files.length)) {
        throw Object.assign(new Error("message is required with attachments"), { status: 422 });
      }
      // Metadata is enough for API-only history: Codex validates the native
      // turn boundary before creating a fork. Avoid hydrating a large thread.
      const source = config.historySource === "cli-local"
        ? await readCliThreadById(threadId, { includeTurns: false })
        : await client.request("thread/read", { threadId, includeTurns: false });
      const sourceThread = source.thread || source;
      if (sourceThread.canAcceptDirectInput === false || threadRelationship(sourceThread).isSubagent) {
        throw Object.assign(new Error("Subagent conversations are read-only"), { status: 403 });
      }
      const forkParams = { threadId, excludeTurns: true, ...(input ? { deferGoalContinuation: true } : {}) };
      const collaboration = await collaborationFor(data);
      if (position === "before") forkParams.beforeTurnId = turnId;
      else forkParams.lastTurnId = turnId;
      let forkResult;
      try { forkResult = await client.request("thread/fork", forkParams); }
      catch (error) { error.sendUnconfirmed = writeResultUnconfirmed(error); throw error; }
      const forkedThread = forkResult.thread || forkResult;
      client.markThreadSubscribed(forkedThread.id);

      let turn = null;
      let sendError;
      let sendUnconfirmed;
      try {
        if (input) {
          ownedRunningThreads.add(forkedThread.id);
          const turnResult = await client.request("turn/start", {
            threadId: forkedThread.id,
            input,
            ...collaboration,
            model: data.model || null,
            effort: data.effort || null,
            approvalPolicy: data.approvalPolicy || "on-request",
            approvalsReviewer: data.approvalsReviewer || "user",
            sandboxPolicy: sandboxPolicyFor(data.sandbox || "workspace-write"),
          });
          turn = turnResult.turn || turnResult;
        }
      } catch (error) {
        sendError = error.message || "Failed to send edited message";
        sendUnconfirmed = writeResultUnconfirmed(error);
        if (sendUnconfirmed) {
          unconfirmedForkWrites.add(forkedThread.id);
          ownedRunningThreads.add(forkedThread.id);
        } else {
          ownedRunningThreads.delete(forkedThread.id);
        }
      } finally {
        scheduleThreadUnsubscribe(forkedThread.id, 2000);
      }
      scheduleThreadSync("thread-forked", 100);
      return json(res, 201, { thread: forkedThread, turn, ...(sendError ? { sendError, sendUnconfirmed } : {}) });
    }
    if (req.method === "POST" && action === "stop") {
      await messageQueue.update(threadId, { action: "pause" });
      if (await isQwenThread(threadId)) {
        const stopped = await qwenProvider.stopThread(threadId);
        if (!stopped) {
          const error = new Error("No active Qwen Code turn for this thread");
          error.status = 409;
          throw error;
        }
        scheduleThreadSync("turn-stopped", 100);
        return json(res, 200, { stopped: true, threadId, turnId: null, source: "qwen" });
      }
      if (await isClaudeThread(threadId)) {
        const stopped = await claudeProvider.stopThread(threadId);
        if (!stopped) {
          const error = new Error("No active Claude Code turn for this thread");
          error.status = 409;
          throw error;
        }
        scheduleThreadSync("turn-stopped", 100);
        return json(res, 200, { stopped: true, threadId, turnId: null, source: "claude" });
      }
      if (usesWindowsCliFallback()) {
        const stopped = stopWindowsThread(threadId);
        if (!stopped) {
          const error = new Error("No active turn for this thread");
          error.status = 409;
          throw error;
        }
        scheduleThreadSync("turn-stopped", 100);
        return json(res, 200, { stopped: true, threadId, turnId: null, source: "windows-cli" });
      }
      const { turnId, source, thread } = await resolveActiveTurn(threadId, { refresh: true });
      if (!turnId) {
        const status = thread?.status?.type ? ` (${thread.status.type})` : "";
        const error = new Error(`No active turn for this thread${status}`);
        error.status = 409;
        throw error;
      }
      const result = await client.request("turn/interrupt", { threadId, turnId });
      client.clearActiveTurn(threadId);
      scheduleThreadSync("turn-stopped", 100);
      return json(res, 200, { stopped: true, threadId, turnId, source, result });
    }
    if (req.method === "POST" && action === "archive") {
      await messageQueue.update(threadId, { action: "pause" });
      if (await isQwenThread(threadId)) {
        const result = await qwenProvider.archiveThread(threadId);
        archiveRevision += 1;
        scheduleThreadSync("thread-archived", 100);
        return json(res, 200, result);
      }
      if (await isClaudeThread(threadId)) {
        const result = await claudeProvider.archiveThread(threadId);
        archiveRevision += 1;
        scheduleThreadSync("thread-archived", 100);
        return json(res, 200, result);
      }
      if (config.historySource === "cli-local") {
        const result = await archiveCliThread(threadId);
        archiveRevision += 1;
        scheduleThreadSync("thread-archived", 100);
        return json(res, 200, result);
      }
      const result = await client.request("thread/archive", { threadId });
      archiveRevision += 1;
      scheduleThreadSync("thread-archived", 100);
      return json(res, 200, result);
    }
  }
  return json(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  handle(req, res, url).catch((error) => errorResponse(res, error));
});

export async function startServer() {
  if (!config.isLoopback && !config.authToken) {
    throw new Error("HOST is not loopback; set AUTH_TOKEN before exposing the controller");
  }
  // Show pairing information immediately. Starting the Codex control client
  // can take a moment, but the phone can already capture the connection data.
  printConnectionQRCode({ host: config.host, port: config.port, authToken: config.authToken });
  try {
    if (hasCodexProvider()) await client.start();
  } catch (error) {
    if (config.historySource !== "cli-local" && hasCodexProvider()) throw error;
    console.warn(`Codex app-server control unavailable; local history will still be served: ${error.message}`);
  }
  startThreadSync();
  server.listen(config.port, config.host, () => {
    console.log(`Cloudex controller listening on http://${config.host}:${config.port}`);
    console.log(`Agent provider: ${config.agentProvider}`);
    console.log(`History source: ${config.historySource}`);
    if (config.historySource === "cli-local") console.log(`Codex sessions: ${config.codexSessionsDir}`);
    console.log(`Allowed file roots: ${config.fileRoots.join(", ")}`);
    if (config.authToken) console.log("HTTP auth: Bearer token enabled");
  });
}

process.on("SIGINT", async () => { stopThreadSync(); await qwenProvider.stop(); await claudeProvider.stop(); await client.stop(); server.close(); process.exit(0); });
process.on("SIGTERM", async () => { stopThreadSync(); await qwenProvider.stop(); await claudeProvider.stop(); await client.stop(); server.close(); process.exit(0); });

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) {
  startServer().catch((error) => {
    console.error(error.message);
    stopThreadSync();
    client.stop().catch(() => {});
    process.exitCode = 1;
  });
}
