import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudex-continuation-"));
process.env.CODEX_SESSIONS_DIR = path.join(root, "sessions");
process.env.CLOUDEX_STATE_DIR = path.join(root, "state");
const { archiveCliThread, findSessionFiles, isContinuationPath, listCliThreads, readCliThreadById, threadIdFromPath } =
  await import("../src/cli-sessions.js");

test("continued Codex rollouts stay one thread with complete, incrementally updated history", async () => {
  const id = "01a0b5c4-87bf-7d62-8399-427cc487552e";
  const continuation = "01a0bf9e-df11-73f1-88e1-28f15fff7f4e";
  const base = path.join(process.env.CODEX_SESSIONS_DIR, "2026/09/19",
    `rollout-2026-09-19T02-25-51-${id}.jsonl`);
  const resumed = path.join(process.env.CODEX_SESSIONS_DIR, "2026/09/21",
    `rollout-2026-09-21T00-20-55-${id}_${continuation}.jsonl`);
  const line = (type, payload) => JSON.stringify({ timestamp: "2026-09-21T00:20:55Z", type, payload }) + "\n";
  try {
    await fs.mkdir(path.dirname(base), { recursive: true });
    await fs.mkdir(path.dirname(resumed), { recursive: true });
    await fs.writeFile(base,
      line("session_meta", { id, cwd: "/project", thread_source: "user" }) +
      line("event_msg", { type: "task_started", turn_id: "first" }) +
      line("event_msg", { type: "user_message", turn_id: "first", message: "older question" }));
    await fs.writeFile(resumed,
      line("session_meta", { id, cwd: "/project", thread_source: "user" }) +
      line("event_msg", { type: "task_complete", turn_id: "first" }) +
      line("event_msg", { type: "task_started", turn_id: "second" }) +
      line("event_msg", { type: "user_message", turn_id: "second", message: "latest question" }) +
      line("event_msg", { type: "agent_message", turn_id: "second", message: "latest answer", phase: "final_answer" }) +
      line("event_msg", { type: "task_complete", turn_id: "second" }));

    assert.equal(threadIdFromPath(resumed), id);
    assert.equal(isContinuationPath(resumed), true);
    assert.equal(isContinuationPath(base), false);
    assert.equal((await findSessionFiles()).length, 2);
    const listed = await listCliThreads();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, id);
    assert.equal(listed[0].status.type, "idle");

    const firstRead = await readCliThreadById(id);
    assert.deepEqual(firstRead.turns.map((turn) => [turn.id, turn.status]),
      [["first", "completed"], ["second", "completed"]]);
    assert.deepEqual(firstRead.turns.map((turn) => turn.items.map((item) => item.type)),
      [["userMessage"], ["userMessage", "agentMessage"]]);
    assert.strictEqual((await readCliThreadById(id)).turns[0], firstRead.turns[0]);

    await fs.appendFile(resumed,
      line("event_msg", { type: "task_started", turn_id: "third" }) +
      line("event_msg", { type: "user_message", turn_id: "third", message: "new append" }));
    const appended = await readCliThreadById(id);
    assert.deepEqual(appended.turns.map((turn) => turn.id), ["first", "second", "third"]);
    assert.equal((await listCliThreads()).length, 1);

    await archiveCliThread(id);
    assert.deepEqual(await listCliThreads(), []);
    assert.deepEqual((await listCliThreads({ archived: true })).map((thread) => thread.id), [id]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
