import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";

const standaloneCodexBin = path.join(os.homedir(), ".codex", "packages", "standalone", "current", "bin", "codex");
function codexFromPath() {
  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}
function qwenFromPath() {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "qwen");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}
function claudeFromPath() {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, process.platform === "win32" ? "claude.exe" : "claude");
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return null;
}
function bundledClaudeFromDesktop() {
  if (process.platform !== "darwin") return null;
  const root = path.join(os.homedir(), "Library", "Application Support", "Claude-3p", "claude-code");
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, "claude.app", "Contents", "MacOS", "claude"))
      .filter((candidate) => fs.existsSync(candidate))
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0] || null;
  } catch {
    return null;
  }
}
function windowsCodexBin() {
  if (process.platform !== "win32") return null;
  const root = path.join(os.homedir(), "AppData", "Local", "OpenAI", "Codex", "bin");
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, "codex.exe"))
      .filter((candidate) => fs.existsSync(candidate))
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0] || null;
  } catch {
    return null;
  }
}

const defaultCodexBin = process.env.CODEX_BIN
  || codexFromPath()
  || (fs.existsSync(standaloneCodexBin) ? standaloneCodexBin : null)
  // Desktop exports CODEX_CLI_PATH into child shells. Keep it as a final
  // fallback so a real CLI on PATH remains authoritative for Cloudex.
  || process.env.CODEX_CLI_PATH
  || windowsCodexBin()
  || "codex";
const defaultQwenBin = process.env.QWEN_BIN || qwenFromPath() || "qwen";
const detectedClaudeBin = claudeFromPath() || bundledClaudeFromDesktop();
const defaultClaudeBin = process.env.CLAUDE_BIN || detectedClaudeBin || "claude";
const requestedProvider = process.env.CLOUDEX_AGENT_PROVIDER;

const qwenModels = (process.env.QWEN_MODELS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const qwenHome = process.env.QWEN_HOME || path.join(os.homedir(), ".qwen");
const claudeHome = process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");

const host = process.env.HOST || "0.0.0.0";
const authToken = process.env.AUTH_TOKEN || "";
const fileRoots = (process.env.FILE_ROOTS || process.cwd())
  .split(path.delimiter)
  .map((item) => path.resolve(item))
  .filter(Boolean);

export const config = {
  agentProvider: ["codex", "qwen", "claude", "both", "all"].includes(requestedProvider)
    ? requestedProvider
    : (qwenFromPath() && detectedClaudeBin ? "all" : (qwenFromPath() ? "both" : (detectedClaudeBin ? "claude" : "codex"))),
  host,
  port: Number(process.env.PORT || 8890),
  authToken,
  codexBin: process.env.CODEX_BIN || defaultCodexBin,
  qwenBin: defaultQwenBin,
  claudeBin: defaultClaudeBin,
  qwenSessionsDir: process.env.QWEN_SESSIONS_DIR
    || path.join(qwenHome, "projects"),
  qwenModels,
  qwenDefaultModel: process.env.QWEN_DEFAULT_MODEL || qwenModels[0] || null,
  claudeModels: (process.env.CLAUDE_MODELS || "").split(",").map((value) => value.trim()).filter(Boolean),
  claudeDefaultModel: process.env.CLAUDE_DEFAULT_MODEL || null,
  // Qwen Code is versioned independently from Cloudex. These keep its CLI
  // invocation configurable without baking a particular release into the API.
  qwenCommandArgs: process.env.QWEN_COMMAND_ARGS || "--output-format stream-json --prompt",
  qwenResumeArgs: process.env.QWEN_RESUME_ARGS || "-r {sessionId}",
  qwenApprovalMode: process.env.QWEN_APPROVAL_MODE || null,
  claudeSessionsDir: process.env.CLAUDE_SESSIONS_DIR || path.join(claudeHome, "projects"),
  claudeCommandArgs: process.env.CLAUDE_COMMAND_ARGS || "--print --output-format stream-json --verbose",
  claudeResumeArgs: process.env.CLAUDE_RESUME_ARGS || "--resume {sessionId}",
  codexConfigPath: process.env.CODEX_CONFIG_PATH
    || path.join(os.homedir(), ".codex", "config.toml"),
  historySource: process.env.CLOUDEX_HISTORY_SOURCE || "cli-local",
  includeSubagents: process.env.CLOUDEX_INCLUDE_SUBAGENTS === "true",
  activeStaleSeconds: Number(process.env.CLOUDEX_ACTIVE_STALE_SECONDS || 4 * 60 * 60),
  codexSessionsDir: process.env.CODEX_SESSIONS_DIR
    || path.join(os.homedir(), ".codex", "sessions"),
  stateDir: process.env.CLOUDEX_STATE_DIR || path.join(process.cwd(), ".cloudex-state"),
  controlSocketPath: process.env.CODEX_CONTROL_SOCKET
    || path.join(os.homedir(), ".codex", "app-server-control", "app-server-control.sock"),
  fileRoots,
  defaultCwd: path.resolve(process.env.DEFAULT_CWD || process.cwd()),
  isLoopback: host === "127.0.0.1" || host === "localhost" || host === "::1",
  nodeVersion: process.version,
  machine: os.hostname(),
};

export function createDevToken() {
  return crypto.randomBytes(18).toString("base64url");
}
