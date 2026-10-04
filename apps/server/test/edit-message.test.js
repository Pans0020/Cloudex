import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// Run the real HTTP route with an isolated filesystem and an in-memory Codex
// peer. A rejected boundary is atomic, matching native thread/fork semantics.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudex-edit-message-"));
Object.assign(process.env, {
  AUTH_TOKEN: "edit-only", CLOUDEX_AGENT_PROVIDER: "codex", CLOUDEX_HISTORY_SOURCE: "api-only",
  CLOUDEX_STATE_DIR: root, FILE_ROOTS: root, DEFAULT_CWD: root,
  CODEX_BIN: "/not-a-real-codex", CODEX_SESSIONS_DIR: path.join(root, "no-sessions"),
});
const { CodexClient, CodexError } = await import("../src/codex-client.js");
const image = path.join(root, "original.png");
const document = path.join(root, "notes.txt");
await Promise.all([fs.writeFile(image, "fixture"), fs.writeFile(document, "fixture")]);
const original = {
  id: "original", cwd: root, model: "gpt-6-sol", status: { type: "idle" },
  turns: [
    { id: "first", status: "completed", items: [{ type: "userMessage", id: "first-user", content: [{ type: "text", text: "earlier context" }] }] },
    { id: "edit-target", status: "completed", items: [
      { type: "userMessage", id: "target-user", content: [{ type: "text", text: "old question" }, { type: "localImage", path: image }] },
      { type: "agentMessage", id: "old-answer", text: "old answer" },
    ] },
    { id: "later", status: "completed", items: [{ type: "userMessage", id: "later-user", content: [{ type: "text", text: "later question" }] }] },
  ],
};
const originalSnapshot = structuredClone(original);
const threads = new Map([[original.id, original], ["child", { ...structuredClone(original), id: "child", parentThreadId: "original" }]]);
const calls = [];
let transport;
let nextFork = 0;
let turnFailure;
let forkFailure;
CodexClient.prototype.ensureConnected = async () => {};
CodexClient.prototype.connectWithRetry = async () => { throw new Error("Real Codex connections forbidden in this test"); };
CodexClient.prototype.request = async function(method, params = {}) {
  transport = this;
  calls.push({ method, params: structuredClone(params) });
  if (method === "thread/list") return { data: [...threads.values()].map(({ turns, ...thread }) => thread), nextCursor: null };
  if (method === "thread/unsubscribe") return {};
  if (method === "collaborationMode/list") return { data: [{ mode: "plan", model: null }] };
  const thread = threads.get(params.threadId);
  if (!thread) throw new CodexError("Thread not found", { error: { code: -32602 } });
  if (method === "thread/read" || method === "thread/resume") {
    const copy = structuredClone(thread);
    if (params.includeTurns === false) delete copy.turns;
    return { thread: copy };
  }
  if (method === "thread/fork") {
    if (forkFailure) throw forkFailure;
    const boundary = params.beforeTurnId || params.lastTurnId;
    const index = thread.turns.findIndex(turn => turn.id === boundary);
    if (index < 0) throw new CodexError("Turn not found", { error: { code: -32602 } });
    const copy = { ...structuredClone(thread), id: `fork-${++nextFork}`, forkedFromId: thread.id,
      turns: structuredClone(thread.turns.slice(0, params.beforeTurnId ? index : index + 1)), status: { type: "idle" } };
    threads.set(copy.id, copy);
    const response = structuredClone(copy);
    if (params.excludeTurns) response.turns = [];
    return { thread: response };
  }
  if (method === "turn/start") {
    if (turnFailure) throw turnFailure;
    const turn = { id: `edited-${thread.id}`, status: "inProgress", items: [{ type: "userMessage", id: `user-${thread.id}`, content: structuredClone(params.input) }] };
    thread.turns.push(turn);
    thread.status = { type: "active" };
    return { turn: structuredClone(turn) };
  }
  throw new Error(`Unexpected protocol method ${method}`);
};
const { handle, errorResponse } = await import("../src/server.js");
const server = http.createServer((req, res) => handle(req, res, new URL(req.url, "http://localhost")).catch(error => errorResponse(res, error)));
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function request(body, id = "original", action = "fork") {
  const res = await fetch(`${base}/api/threads/${id}/${action}`, {
    method: "POST", headers: { authorization: "Bearer edit-only", "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(3000),
  });
  return { status: res.status, data: await res.json() };
}
async function read(route) {
  const res = await fetch(base + route, { headers: { authorization: "Bearer edit-only" }, signal: AbortSignal.timeout(3000) });
  return { status: res.status, data: await res.json() };
}
function complete(id) {
  const thread = threads.get(id);
  thread.status = { type: "idle" };
  const turn = thread.turns.at(-1);
  turn.status = "completed";
  transport.emit("notification", { method: "turn/completed", params: { threadId: id, turn: structuredClone(turn) } });
}
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});

test("editing forks before the source turn, retaining selected attachments and settings without changing the original", async () => {
  const data = { turnId: "edit-target", position: "before", message: "  revised\n    code\n", model: "gpt-6-sol", effort: "high",
    collaborationMode: "plan", sandbox: "read-only", approvalPolicy: "never", approvalsReviewer: "guardian_subagent",
    files: [{ path: image, kind: "image" }, { path: document, kind: "file" }, { url: "https://example.com/retained.png", kind: "image" }] };
  const result = await request(data);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.sendError, undefined);
  const fork = calls.findLast(call => call.method === "thread/fork");
  assert.deepEqual(fork.params, { threadId: "original", excludeTurns: true, deferGoalContinuation: true, beforeTurnId: "edit-target" });
  const start = calls.findLast(call => call.method === "turn/start");
  assert.deepEqual(start.params.input, [
    { type: "text", text: `${data.message}\n\n[Attached local file: ${document}]` },
    { type: "localImage", path: image }, { type: "image", url: "https://example.com/retained.png" },
  ]);
  assert.equal(start.params.model, data.model);
  assert.equal(start.params.effort, data.effort);
  assert.equal(start.params.approvalPolicy, "never");
  assert.equal(start.params.approvalsReviewer, "guardian_subagent");
  assert.deepEqual(start.params.sandboxPolicy, { type: "readOnly" });
  assert.deepEqual(start.params.collaborationMode, { mode: "plan", settings: { model: "gpt-6-sol", reasoning_effort: "high", developer_instructions: null } });
  assert.deepEqual(threads.get(result.data.thread.id).turns.map(turn => turn.id), ["first", result.data.turn.id]);
  assert.deepEqual(original, originalSnapshot);
  assert.equal(calls.filter(call => call.method === "thread/read" && call.params.includeTurns !== false).length, 0);
  assert.deepEqual(result.data.thread.turns, []);
  complete(result.data.thread.id);
});

test("invalid edited input and unavailable attachments are rejected before any fork write", async () => {
  const count = calls.filter(call => call.method === "thread/fork").length;
  for (const invalid of [
    { message: "  " }, { message: { text: "bad" } }, { position: "unknown", message: "edit" },
    { message: "edit", files: {} }, { message: "edit", files: [null] },
    { message: "edit", files: [{ path: path.join(root, "missing.png") }] },
    { message: "edit", files: [{ path: root }] },
    { message: "edit", files: [{ url: "data:text/plain;base64,YQ==", kind: "image" }] },
    { message: "edit", files: [{ url: "https://example.com/file.pdf", kind: "file" }] },
    { files: [{ path: image }] },
  ]) {
    const result = await request({ turnId: "edit-target", position: "before", ...invalid });
    assert.equal(result.status, 422, JSON.stringify(result));
  }
  assert.equal(calls.filter(call => call.method === "thread/fork").length, count);
});

test("native turn-boundary rejection creates no fork and children remain read-only", async () => {
  const count = threads.size;
  const missing = await request({ turnId: "not-real", position: "before", message: "edit" });
  assert.equal(missing.status, 502);
  assert.equal(missing.data.sendUnconfirmed, false);
  const forkCalls = calls.filter(call => call.method === "thread/fork").length;
  const child = await request({ turnId: "edit-target", position: "before", message: "edit" }, "child");
  assert.equal(child.status, 403);
  assert.equal(calls.filter(call => call.method === "thread/fork").length, forkCalls);
  assert.equal(threads.size, count);
});

test("plain fork keeps through and default positions, and an explicit empty files list removes attachments", async () => {
  for (const position of [undefined, "through", "after"]) {
    const result = await request({ turnId: "edit-target", ...(position ? { position } : {}) });
    assert.equal(result.status, 201);
    assert.deepEqual(calls.findLast(call => call.method === "thread/fork").params, { threadId: "original", excludeTurns: true, lastTurnId: "edit-target" });
    assert.deepEqual(threads.get(result.data.thread.id).turns.map(turn => turn.id), ["first", "edit-target"]);
  }
  const edited = await request({ turnId: "edit-target", position: "before", message: "no attachments", files: [] });
  assert.equal(edited.status, 201);
  assert.deepEqual(calls.findLast(call => call.method === "turn/start").params.input, [{ type: "text", text: "no attachments" }]);
  complete(edited.data.thread.id);
});

test("a rejected send returns the created fork and explicit retry continues that same fork", async () => {
  const message = "  recover me\n    code\n";
  turnFailure = new CodexError("Model unavailable", { error: { code: -32602 } });
  const result = await request({ turnId: "edit-target", position: "before", message, files: [{ path: image }] });
  turnFailure = null;
  assert.equal(result.status, 201);
  assert.equal(result.data.sendError, "Model unavailable");
  assert.equal(result.data.sendUnconfirmed, false);
  assert.equal(result.data.turn, null);
  assert.ok(threads.has(result.data.thread.id));
  const count = calls.filter(call => call.method === "thread/fork").length;
  const retry = await request({ message, files: [{ path: image }] }, result.data.thread.id, "message");
  assert.equal(retry.status, 202, JSON.stringify(retry.data));
  assert.equal(calls.filter(call => call.method === "thread/fork").length, count);
  assert.equal(calls.findLast(call => call.method === "turn/start").params.threadId, result.data.thread.id);
  assert.equal(calls.findLast(call => call.method === "turn/start").params.input[0].text, message);
  assert.deepEqual(original, originalSnapshot);
  complete(result.data.thread.id);
});

test("image-only and document-only edits and retries retain attachments without an empty text input", async () => {
  for (const [files, input] of [
    [[{ path: image, kind: "image" }], [{ type: "localImage", path: image }]],
    [[{ path: document, kind: "file" }], [{ type: "text", text: `[Attached local file: ${document}]` }]],
  ]) {
    turnFailure = new CodexError("Model unavailable", { error: { code: -32602 } });
    const result = await request({ turnId: "edit-target", position: "before", message: "", files });
    turnFailure = null;
    assert.equal(result.status, 201);
    assert.equal(result.data.sendUnconfirmed, false);
    assert.deepEqual(calls.findLast(call => call.method === "turn/start").params.input, input);
    const retry = await request({ message: "", files }, result.data.thread.id, "message");
    assert.equal(retry.status, 202, JSON.stringify(retry.data));
    assert.deepEqual(calls.findLast(call => call.method === "turn/start").params.input, input);
    complete(result.data.thread.id);
  }
});

test("lost turn and fork replies are marked unconfirmed and are never replayed", async () => {
  const timeout = new CodexError("Codex turn/start timed out; its result is unconfirmed", { code: "CODEX_REQUEST_TIMEOUT" });
  const count = calls.filter(call => call.method === "turn/start").length;
  turnFailure = timeout;
  const result = await request({ turnId: "edit-target", position: "before", message: "check history" });
  turnFailure = null;
  assert.equal(result.status, 201);
  assert.equal(result.data.sendUnconfirmed, true);
  assert.ok(threads.has(result.data.thread.id));
  assert.equal(calls.filter(call => call.method === "turn/start").length, count + 1);
  assert.equal((await read("/api/health")).data.ownedRunningThreadCount, 1);
  transport.emit("disconnected");
  assert.equal((await read("/api/health")).data.ownedRunningThreadCount, 1);
  assert.equal((await request({ message: "unsafe retry" }, result.data.thread.id, "message")).status, 409);
  transport.emit("notification", { method: "thread/status/changed", params: { threadId: result.data.thread.id, status: { type: "idle" } } });
  assert.equal((await read("/api/health")).data.ownedRunningThreadCount, 0);
  turnFailure = timeout;
  const inspect = await request({ turnId: "edit-target", position: "before", message: "check history first" });
  turnFailure = null;
  assert.equal((await read("/api/health")).data.ownedRunningThreadCount, 1);
  assert.equal((await read(`/api/threads/${inspect.data.thread.id}`)).status, 200);
  assert.equal((await read("/api/health")).data.ownedRunningThreadCount, 0);
  const forkCount = calls.filter(call => call.method === "thread/fork").length;
  forkFailure = new CodexError("Codex thread/fork timed out; its result is unconfirmed", { code: "CODEX_REQUEST_TIMEOUT" });
  const unknown = await request({ turnId: "edit-target", position: "before", message: "unknown fork" });
  forkFailure = null;
  assert.equal(unknown.status, 502);
  assert.equal(unknown.data.sendUnconfirmed, true);
  assert.equal(calls.filter(call => call.method === "thread/fork").length, forkCount + 1);
});

test("retry message errors expose whether the write is confirmed or unknown", async () => {
  for (const [error, unconfirmed] of [
    [new CodexError("Model unavailable", { error: { code: -32602 } }), false],
    [new CodexError("Managed Codex app-server connection closed"), true],
  ]) {
    turnFailure = error;
    const result = await request({ message: "retry" }, "original", "message");
    turnFailure = null;
    assert.equal(result.status, 502);
    assert.equal(result.data.sendUnconfirmed, unconfirmed);
  }
});
