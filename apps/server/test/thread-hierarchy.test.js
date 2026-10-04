import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { agentStatus, observedThreadIds, threadAgentStatus, threadRelationship, threadsWithHierarchy } from "../src/thread-hierarchy.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudex-hierarchy-"));
Object.assign(process.env, { CODEX_HOME: root, CODEX_SESSIONS_DIR: path.join(root, "sessions"),
  CLOUDEX_STATE_DIR: path.join(root, "state"), CLOUDEX_HISTORY_SOURCE: "cli-local", CLOUDEX_AGENT_PROVIDER: "codex",
  AUTH_TOKEN: "fixture-only", CODEX_BIN: "/not-a-real-codex", CLOUDEX_INCLUDE_SUBAGENTS: "true" });
await fs.mkdir(process.env.CODEX_SESSIONS_DIR);
after(() => fs.rm(root, { recursive: true, force: true }));
const { archiveCliThread, listCliThreads, readCliThreadById, watchCliSessions } = await import("../src/cli-sessions.js");
const { handle, notifyHistoryChanged } = await import("../src/server.js");
const parentId = "20000000-0000-4000-8000-000000000001";
const childId = "20000000-0000-4000-8000-000000000002";
const archivedChildId = "20000000-0000-4000-8000-000000000003";
const grandchildId = "20000000-0000-4000-8000-000000000004";
const file = id => path.join(process.env.CODEX_SESSIONS_DIR, `rollout-2026-10-03T00-00-00-${id}.jsonl`);
const line = (type, payload, timestamp = new Date().toISOString()) => JSON.stringify({ timestamp, type, payload }) + "\n";
const meta = (id, parent = null) => ({ id, cwd: "/fixture-project", thread_source: parent ? "subagent" : "user",
  source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_nickname: "Ada", agent_path: "/root/test" } } } : "vscode" });
const req = { method: "GET", headers: { authorization: "Bearer fixture-only" } };
function response() {
  const res = new EventEmitter();
  res.chunks = [];
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.write = chunk => res.chunks.push(chunk);
  res.end = chunk => { if (chunk) res.chunks.push(chunk); };
  return res;
}
async function get(route) {
  const res = response();
  await handle(req, res, new URL(`http://localhost${route}`));
  assert.equal(res.status, 200);
  return JSON.parse(res.chunks.join(""));
}

test("hierarchy uses explicit ancestry, preserves forks, and hides missing parents and cycles", () => {
  const source = { subAgent: { thread_spawn: { parent_thread_id: "main", agent_nickname: "Ada", agent_role: "reviewer", agent_path: "/root/review", depth: 1 } } };
  assert.equal(threadRelationship({ source }).parentThreadId, "main");
  const tree = threadsWithHierarchy([
    { id: "main", cwd: "/main", updatedAt: 1 },
    { id: "child", source, status: { type: "idle" }, turns: [{ status: "completed" }] },
    { id: "nested", parentThreadId: "child", status: { type: "active", activeFlags: ["waitingOnApproval"] } },
    { id: "fork", forkedFromId: "main", cwd: "/main" },
    { id: "orphan", source: { subagent: { thread_spawn: { parent_thread_id: "missing" } } } },
    { id: "legacy", threadSource: "subagent", cwd: "/main" },
    { id: "cycle-a", parentThreadId: "cycle-b" }, { id: "cycle-b", parentThreadId: "cycle-a" },
  ]);
  assert.deepEqual(tree.map(thread => thread.id), ["main", "fork"]);
  const child = tree[0].subagents[0];
  assert.equal(child.agentNickname, "Ada");
  assert.equal(child.agentStatus, "completed");
  assert.equal(child.canAcceptDirectInput, false);
  assert.equal(child.turns, undefined);
  assert.equal(child.source, "subagent");
  assert.equal(child.subagents[0].agentStatus, "waiting");
  assert.deepEqual(observedThreadIds(tree, ["main"]).sort(), ["main", "child", "nested"].sort());
});

test("idle is unknown and late parent activity cannot turn failure or a live runtime into done", () => {
  assert.equal(threadAgentStatus({ status: { type: "idle" } }), "unknown");
  assert.equal(threadAgentStatus({ status: { type: "notLoaded" }, turns: [{ status: "interrupted" }] }), "interrupted");
  assert.equal(agentStatus("shutdown"), "closed");
  const parent = { id: "main", _subagentStates: { child: { status: "completed", updatedAt: 12, evidence: "activity" } } };
  for (const status of ["failed", "interrupted", "closed"]) {
    const tree = threadsWithHierarchy([parent, { id: "child", parentThreadId: "main", agentStatus: status, _agentStatusUpdatedAt: 11 }]);
    assert.equal(tree[0].subagents[0].agentStatus, status);
  }
  assert.equal(threadsWithHierarchy([parent, { id: "child", parentThreadId: "main", status: { type: "active" }, _agentStatusUpdatedAt: 11 }])[0].subagents[0].agentStatus, "active");
});

test("forked child metadata survives inherited parent metadata and remains inside its parent", async () => {
  await fs.writeFile(file(parentId), line("session_meta", meta(parentId)) + line("event_msg", { type: "task_complete", turn_id: "parent" }));
  await fs.writeFile(file(childId), line("session_meta", meta(childId, parentId)) +
    line("session_meta", meta(parentId)) +
    line("event_msg", { type: "user_message", turn_id: "inherited", message: "Inherited fixture conversation" }) +
    line("event_msg", { type: "task_complete", turn_id: "inherited" }) +
    line("event_msg", { type: "task_started", turn_id: "child-task" }));
  await fs.writeFile(file(archivedChildId), line("session_meta", meta(archivedChildId, parentId)) + line("event_msg", { type: "task_complete", turn_id: "archived-child" }));
  await archiveCliThread(archivedChildId);
  await fs.writeFile(file(grandchildId), line("session_meta", meta(grandchildId, childId)) + line("event_msg", { type: "turn_aborted", turn_id: "nested-task" }));
  const detail = await readCliThreadById(childId);
  assert.equal(detail.thread.parentThreadId, parentId);
  assert.equal(detail.thread.agentNickname, "Ada");
  assert.equal(detail.thread.source, "subagent");
  assert.ok(detail.turns.some(turn => turn.items.some(item => item.content?.[0]?.text === "Inherited fixture conversation")));
  const projects = await get("/api/projects");
  assert.equal(projects.total, 1, "include-subagents configuration cannot promote children to the homepage");
  const parent = projects.data[0].threads[0];
  assert.equal(parent.id, parentId);
  assert.deepEqual(parent.subagents.map(thread => thread.id), [childId, archivedChildId]);
  assert.equal(parent.subagents[0].agentStatus, "active");
  assert.equal(parent.subagents[0].subagents[0].agentStatus, "interrupted");
  assert.equal(parent.subagents[1].agentStatus, "completed");
  assert.equal((await get(`/api/threads/${parentId}?limit=1`)).thread.subagents.length, 2);
  assert.equal((await get(`/api/threads/${childId}?limit=1`)).thread.canAcceptDirectInput, false);
  assert.deepEqual((await get("/api/threads")).data.map(thread => thread.id), [parentId]);
});

test("native archived parent and child histories are grouped and still readable", async () => {
  const archivedParentId = "20000000-0000-4000-8000-000000000005";
  const nativeChildId = "20000000-0000-4000-8000-000000000006";
  const archived = path.join(root, "archived_sessions");
  await fs.mkdir(archived);
  for (const [id, parent] of [[archivedParentId, null], [nativeChildId, archivedParentId]]) {
    await fs.writeFile(path.join(archived, path.basename(file(id))), line("session_meta", meta(id, parent)) + line("event_msg", { type: "task_complete", turn_id: id }));
  }
  assert.ok(!(await get("/api/threads")).data.some(thread => thread.id === archivedParentId));
  const archivedThreads = (await get("/api/threads?archived=true")).data;
  assert.equal(archivedThreads.length, 1);
  assert.equal(archivedThreads[0].subagents[0].id, nativeChildId);
  assert.equal((await get(`/api/threads/${nativeChildId}`)).turns[0].status, "completed");
});

test("child-only history changes update the parent snapshot without changing its history", async () => {
  const stream = response();
  const changed = async (predicate) => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const data = stream.chunks.join("").split("\n\n").filter(event => event.includes("event: threads/changed"))
        .map(event => JSON.parse(event.match(/data: (.*)/)[1]));
      if (data.some(predicate)) return data.findLast(predicate);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail("parent snapshot did not reconcile child state");
  };
  try {
    await handle(req, stream, new URL("http://localhost/api/events"));
    const first = await changed(data => data.projects[0]?.threads[0]?.subagents[0]?.agentStatus === "active");
    const parentUpdatedAt = first.projects[0].threads[0].updatedAt;
    await fs.appendFile(file(childId), line("event_msg", { type: "task_complete", turn_id: "child-task" }));
    assert.equal((await get(`/api/threads/${childId}?limit=1`)).thread.agentStatus, "completed", "fresh detail cannot reuse an older active overview");
    notifyHistoryChanged(file(childId));
    const latest = await changed(data => data.projects[0]?.threads[0]?.subagents[0]?.agentStatus === "completed");
    assert.equal(latest.total, 1);
    assert.equal(latest.projects[0].threads[0].updatedAt, parentUpdatedAt);
  } finally { stream.emit("close"); }
});

test("canonical small activity records preserve failure and same-second child followups", async () => {
  const id = "20000000-0000-4000-8000-000000000007";
  const moment = new Date();
  const timestamp = offset => new Date(Math.floor(moment.getTime() / 1000) * 1000 + offset).toISOString();
  await fs.writeFile(file(id), line("session_meta", meta(id, parentId), timestamp(0)) +
    line("event_msg", { type: "task_complete", turn_id: "failure", error: { message: "fixture failure" } }, timestamp(100)));
  await fs.appendFile(file(parentId), line("event_msg", { type: "item_completed", item: { type: "SubAgentActivity", kind: "completed", agent_thread_id: id } }, timestamp(200)));
  let tree = threadsWithHierarchy(await listCliThreads({ archived: null, includeSubagents: true }));
  assert.equal(tree.find(thread => thread.id === parentId).subagents.find(thread => thread.id === id).agentStatus, "failed");
  await fs.appendFile(file(id), line("event_msg", { type: "task_started", turn_id: "later" }, timestamp(300)));
  tree = threadsWithHierarchy(await listCliThreads({ archived: null, includeSubagents: true }));
  assert.equal(tree.find(thread => thread.id === parentId).subagents.find(thread => thread.id === id).agentStatus, "active");
  const pendingId = "20000000-0000-4000-8000-000000000008";
  await fs.writeFile(file(pendingId), line("session_meta", meta(pendingId, parentId)) +
    line("session_meta", meta(parentId), "2020-01-01T00:00:00Z") +
    line("event_msg", { type: "task_complete", turn_id: "inherited-done" }, "2020-01-01T00:00:01Z"));
  const pending = await readCliThreadById(pendingId);
  assert.equal(pending.turns[0].status, "completed", "inherited history remains readable");
  assert.equal(pending.thread.agentStatus, "pending", "inherited parent completion is not this agent's completion");
});

test("selected parent observes completed descendants when native watch is silent", async t => {
  const tree = threadsWithHierarchy(await listCliThreads({ archived: null, includeSubagents: true }));
  t.mock.method(syncFs, "watch", () => { const watcher = new EventEmitter(); watcher.close = () => {}; return watcher; });
  syncBuiltinESMExports();
  let stop;
  let timeout;
  try {
    const changed = new Promise((resolve, reject) => {
      stop = watchCliSessions(candidate => { if (candidate === file(childId)) resolve(); }, { getObservedThreadIds: () => observedThreadIds(tree, [parentId]) });
      timeout = setTimeout(() => reject(new Error("completed child followup was missed")), 1500);
    });
    await fs.appendFile(file(childId), line("event_msg", { type: "task_started", turn_id: "followup" }));
    await changed;
    assert.equal((await readCliThreadById(childId)).thread.agentStatus, "active");
  } finally { stop?.(); clearTimeout(timeout); t.mock.restoreAll(); syncBuiltinESMExports(); }
});
