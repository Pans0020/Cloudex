import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudex-hierarchy-api-"));
Object.assign(process.env, { AUTH_TOKEN: "fixture-only", CLOUDEX_AGENT_PROVIDER: "codex", CLOUDEX_HISTORY_SOURCE: "api-only",
  CLOUDEX_STATE_DIR: root, CODEX_HOME: root, CODEX_SESSIONS_DIR: path.join(root, "sessions"), CODEX_BIN: "/not-a-real-codex" });
const { CodexClient } = await import("../src/codex-client.js");
const { handle } = await import("../src/server.js");
after(() => fs.rm(root, { recursive: true, force: true }));
const req = { method: "GET", headers: { authorization: "Bearer fixture-only" } };
async function get(route) {
  const res = new EventEmitter();
  const chunks = [];
  res.writeHead = status => { res.status = status; };
  res.write = chunk => chunks.push(chunk);
  res.end = chunk => { if (chunk) chunks.push(chunk); };
  await handle(req, res, new URL(`http://localhost${route}`));
  assert.equal(res.status, 200);
  return JSON.parse(chunks.join(""));
}
const main = { id: "main", cwd: "/fixture-project", status: { type: "idle" }, updatedAt: 1 };
const child = (id, status = { type: "notLoaded" }) => ({ id, cwd: "/different-child-cwd", parentThreadId: "main",
  source: { subAgent: { thread_spawn: { parent_thread_id: "main", depth: 1, agent_nickname: id } } }, status, updatedAt: 1 });

test("API lists explicitly fetch child source kinds, paginate, and retain archived children", async t => {
  const requests = [];
  const statuses = { done: "completed", failed: "failed", interrupted: "interrupted", archived: "completed" };
  t.mock.method(CodexClient.prototype, "request", async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/list") {
      assert.ok(params.sourceKinds.includes("subAgentThreadSpawn"));
      if (params.archived) return { data: [child("archived")], nextCursor: null };
      if (!params.cursor) return { data: [main, child("done"), child("waiting", { type: "active", activeFlags: ["waitingOnUserInput"] })], nextCursor: "second" };
      return { data: [child("failed"), child("interrupted"), { ...child("orphan"), parentThreadId: "missing" }, { id: "fork", forkedFromId: "main", cwd: "/fixture-project", updatedAt: 2 }], nextCursor: null };
    }
    if (method === "thread/turns/list") {
      assert.equal(params.limit, 1);
      assert.equal(params.itemsView, "notLoaded");
      return { data: [{ id: "latest", status: statuses[params.threadId] }] };
    }
    if (method === "thread/read") return { thread: params.threadId === "main" ? { ...main, turns: [] } : { ...child(params.threadId), turns: [{ id: "latest", status: statuses[params.threadId], items: [] }] } };
    throw new Error(`unexpected ${method}`);
  });
  const projects = await get("/api/projects");
  assert.equal(projects.total, 2);
  assert.equal(projects.data.length, 1, "children in another cwd cannot become a project");
  const parent = projects.data[0].threads.find(thread => thread.id === "main");
  assert.deepEqual(Object.fromEntries(parent.subagents.map(thread => [thread.id, thread.agentStatus])),
    { archived: "completed", done: "completed", failed: "failed", interrupted: "interrupted", waiting: "waiting" });
  assert.ok(!requests.some(request => request.params.threadId === "orphan"), "hidden orphans do not trigger lifecycle history reads");
  const lifecycleReads = requests.filter(request => request.method === "thread/turns/list").length;
  assert.equal(lifecycleReads, 4);
  await get("/api/projects");
  assert.equal(requests.filter(request => request.method === "thread/turns/list").length, lifecycleReads, "unchanged children reuse the small lifecycle result");
  assert.equal((await get("/api/threads/main")).thread.subagents.length, 5);
  const detail = await get("/api/threads/done");
  assert.equal(detail.thread.parentThreadId, "main");
  assert.equal(detail.thread.canAcceptDirectInput, false);
  assert.equal(detail.turns[0].status, "completed");
});
