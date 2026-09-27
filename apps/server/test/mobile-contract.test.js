import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// Real HTTP handlers and journal; only Codex transport is replaced. Never spawn Codex.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudex-mobile-contract-"));
Object.assign(process.env, { AUTH_TOKEN: "contract-only", CLOUDEX_AGENT_PROVIDER: "codex",
  CLOUDEX_HISTORY_SOURCE: "api-only", CLOUDEX_STATE_DIR: root, FILE_ROOTS: root, DEFAULT_CWD: root,
  CODEX_BIN: "/not-a-real-codex", CODEX_SESSIONS_DIR: path.join(root, "no-sessions") });
const { CodexClient } = await import("../src/codex-client.js");
const calls = [];
const threads = new Map();
let transport;
let turnNumber = 0;
CodexClient.prototype.ensureConnected = async () => {};
CodexClient.prototype.connectWithRetry = async () => { throw new Error("Real Codex connections forbidden in this test"); };
CodexClient.prototype.request = async function(method, params = {}) {
  transport = this; calls.push({ method, params });
  if (method === "collaborationMode/list") return { data: [{ name: "Plan", mode: "plan", model: null }, { name: "Default", mode: "default", model: null }] };
  if (["thread/start", "thread/fork"].includes(method)) {
    const thread = { id: `contract-${threads.size}`, cwd: root, status: { type: "idle" }, turns: [] };
    threads.set(thread.id, thread); return { thread: structuredClone(thread) };
  }
  if (method === "thread/list") return { data: [...threads.values()], nextCursor: null };
  if (method === "thread/unsubscribe" || method === "thread/archive") return {};
  const thread = threads.get(params.threadId);
  if (!thread) throw Object.assign(new Error("thread not found"), { status: 404 });
  if (method === "thread/read" || method === "thread/resume") return { thread: structuredClone(thread) };
  if (method === "turn/start") {
    const turn = { id: `turn-${++turnNumber}`, status: "inProgress", items: [] };
    thread.turns.push(turn); thread.status = { type: "active" };
    return { turn: structuredClone(turn) };
  }
  if (method === "turn/interrupt") { complete(thread.id, "interrupted"); return {}; }
  throw new Error(`Unexpected protocol method ${method}`);
};
function complete(id, status = "completed") {
  const thread = threads.get(id); const turn = thread.turns.at(-1);
  turn.status = status; thread.status = { type: "idle" };
  transport.emit("notification", { method: "turn/completed", params: { threadId: id, turn: structuredClone(turn) } });
}
const { handle, errorResponse } = await import("../src/server.js");

test("mobile HTTP routes preserve Plan/default, queue files and permissions through Codex transport", async t => {
  const server = http.createServer((req, res) => handle(req, res, new URL(req.url, "http://localhost")).catch(error => errorResponse(res, error)));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, body, authenticated = true) {
    const res = await fetch(base + route, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(authenticated ? { authorization: "Bearer contract-only" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    return { status: res.status, data: await res.json() };
  }
  const mode = { model: "gpt-6-sol", effort: "high", collaborationMode: "plan", sandbox: "read-only", approvalPolicy: "on-request" };
  assert.equal((await request("/api/collaboration-modes", undefined, false)).status, 401);
  assert.equal((await request("/api/collaboration-modes")).data.data.length, 2);
  assert.equal((await request("/api/threads", { ...mode, prompt: "bad", collaborationMode: "unsupported" })).status, 422);
  assert.equal(calls.filter(c => c.method === "thread/start").length, 0);
  const created = await request("/api/threads", { ...mode, prompt: "plan this", cwd: root });
  assert.equal(created.status, 201);
  const id = created.data.thread.id;
  const route = `/api/threads/${id}`;
  assert.deepEqual(calls.findLast(c => c.method === "turn/start").params.collaborationMode, {
    mode: "plan", settings: { model: "gpt-6-sol", reasoning_effort: "high", developer_instructions: null },
  });
  complete(id);
  const continued = await request(`${route}/message`, { ...mode, collaborationMode: "default", message: "execute" });
  assert.equal(continued.status, 202, JSON.stringify(continued.data));
  assert.equal(calls.findLast(c => c.method === "turn/start").params.collaborationMode.mode, "default");
  complete(id);
  const fork = await request(`${route}/fork`, { ...mode, turnId: created.data.turn.id, message: "alternate" });
  assert.equal(fork.status, 201);
  assert.equal(calls.findLast(c => c.method === "turn/start").params.collaborationMode.mode, "plan");
  complete(fork.data.thread.id);

  await request(`${route}/queue`, { action: "pause" });
  const image = path.join(root, "image.png"); await fs.writeFile(image, "fixture");
  const payload = { ...mode, id: "queued-contract", message: "queued plan", files: [{ path: image }] };
  assert.equal((await request(`${route}/queue`, payload, false)).status, 401);
  assert.equal((await request(`${route}/queue`, payload)).status, 202);
  assert.equal((await request(`${route}/queue`, payload)).status, 202);
  assert.equal((await request(`${route}/queue`)).data.items.length, 1);
  assert.equal((await request(`${route}/message`, { message: "must not jump queue" })).status, 409);
  await request(`${route}/queue`, { action: "resume" });
  let snapshot;
  for (let i = 0; i < 100; i++) {
    snapshot = (await request(`${route}/queue`)).data;
    if (snapshot.items[0].status === "running") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(snapshot.items[0].status, "running");
  const turn = calls.findLast(c => c.method === "turn/start").params;
  assert.equal(turn.clientUserMessageId, payload.id);
  assert.equal(turn.collaborationMode.mode, "plan");
  assert.equal(turn.sandboxPolicy.type, "readOnly");
  assert.deepEqual(turn.input[1], { type: "localImage", path: image });
  assert.equal((await request(`${route}/stop`, {})).status, 200);
  assert.equal((await request(`${route}/queue`)).data.paused, true);
  assert.equal((await request(`${route}/archive`, {})).status, 200);
});
