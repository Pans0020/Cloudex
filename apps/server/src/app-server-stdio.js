import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 15000;

function protocolError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

export async function listAllModels(request) {
  const data = [];
  const cursors = new Set();
  let cursor;
  let result;
  do {
    result = await request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
    data.push(...(result?.data || result?.models || []));
    cursor = result?.nextCursor;
    if (cursor && cursors.has(cursor)) throw protocolError("Codex model list repeated its pagination cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return { ...result, data, nextCursor: null };
}

export async function listModelsViaStdio({
  codexBin,
  commandArgs = ["app-server"],
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!codexBin) throw new Error("CODEX_BIN is not configured");

  const child = spawn(codexBin, commandArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: process.platform === "win32",
    env: process.env,
  });
  const pending = new Map();
  let nextRequestID = 1;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let terminalError;

  const rejectPending = (error) => {
    terminalError ||= error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  const handleLine = (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object" || message.id === undefined || message.method || !pending.has(String(message.id))) return;
    const request = pending.get(String(message.id));
    pending.delete(String(message.id));
    if (message.error) {
      request.reject(protocolError(message.error.message || "Codex app-server request failed", {
        code: message.error.code,
        details: message.error,
      }));
    } else {
      request.resolve(message.result);
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf("\n")) >= 0) {
      handleLine(stdoutBuffer.slice(0, newlineIndex));
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    }
  });
  child.stdout.on("end", () => { if (stdoutBuffer.trim()) handleLine(stdoutBuffer); });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrBuffer = (stderrBuffer + chunk).slice(-16_384);
  });
  child.stdin.on("error", (error) => rejectPending(error));
  child.on("error", (error) => rejectPending(error));
  child.on("close", (code, signal) => {
    rejectPending(protocolError(`Codex app-server exited (${code ?? signal})${stderrBuffer ? `: ${stderrBuffer.trim()}` : ""}`));
  });

  const request = (method, params) => new Promise((resolve, reject) => {
    if (terminalError) return reject(terminalError);
    const id = nextRequestID;
    nextRequestID += 1;
    pending.set(String(id), { resolve, reject });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    } catch (error) {
      pending.delete(String(id));
      reject(error);
    }
  });

  const timeout = setTimeout(() => {
    rejectPending(protocolError(`Timed out waiting for Codex app-server model list${stderrBuffer ? `: ${stderrBuffer.trim()}` : ""}`));
  }, timeoutMs);

  try {
    await request("initialize", {
      clientInfo: {
        name: "cloudex-codex-control",
        title: "Cloudex local controller",
        version: "0.2.0",
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
    return await listAllModels(request);
  } finally {
    clearTimeout(timeout);
    rejectPending(protocolError("Codex app-server model request closed"));
    if (!child.killed) child.kill();
  }
}
