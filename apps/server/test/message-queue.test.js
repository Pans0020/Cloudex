import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MessageQueue } from "../src/message-queue.js";
import { collaborationModeParams } from "../src/collaboration-mode.js";
import { mediaAttachments } from "../src/media-attachments.js";

async function fixture(t, send) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudex-queue-unit-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [];
  let busy = true;
  let turns = [];
  const options = { file: path.join(dir, "queue.json"), inspect: async () => ({ busy, turns }),
    send: async (thread, body) => { calls.push([thread, body]); return send ? send(thread, body) : { turn: { id: body.id, status: "inProgress" } }; } };
  const queue = new MessageQueue(options);
  return { queue, calls, options, idle: () => { busy = false; }, turns: value => { turns = value; } };
}
test("durable FIFO keeps independent attachments/modes, deduplicates retries and survives phone closure", async t => {
  const f = await fixture(t);
  const first = { id: "message-0001", message: "one", files: [{ path: "/a.png" }], collaborationMode: "plan", model: "gpt-6-sol" };
  await f.queue.add("a", first);
  await f.queue.add("a", { ...first, message: "retry must not overwrite" });
  await f.queue.add("a", { id: "message-0002", message: "two", files: [{ path: "/b.png" }], collaborationMode: "default" });
  await f.queue.tick();
  assert.equal((await f.queue.list("a")).items.length, 2);
  const restarted = new MessageQueue(f.options);
  f.idle(); await restarted.tick();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0][1].files, first.files);
  assert.equal(f.calls[0][1].collaborationMode, "plan");
  await restarted.finish("a", "old-turn", "completed");
  await restarted.tick(); assert.equal(f.calls.length, 1);
  await restarted.finish("a", "message-0001", "completed");
  await restarted.tick();
  assert.equal(f.calls[1][1].message, "two");
  assert.equal(f.calls[1][1].collaborationMode, "default");
  await restarted.add("a", first); await restarted.tick();
  assert.equal(f.calls.length, 2, "Completed IDs remain idempotent");
});
test("timeout and restart in dispatch do not resend uncertain turns", async t => {
  const f = await fixture(t, async () => { throw new Error("transport timeout after acceptance"); });
  await f.queue.add("a", { id: "message-0001", message: "one" });
  f.idle(); await f.queue.tick(); await f.queue.tick();
  assert.equal(f.calls.length, 1);
  assert.equal((await f.queue.list("a")).items[0].status, "unconfirmed");
  await assert.rejects(f.queue.update("a", { action: "resume" }), /核对/);
  const restarted = new MessageQueue(f.options); await restarted.tick();
  assert.equal(f.calls.length, 1);
  await fs.writeFile(f.options.file, JSON.stringify({ threads: { b: { paused: false, items: [{ id: "crashed-0001", status: "dispatching", body: { message: "unknown" } }] } } }));
  const crashed = new MessageQueue(f.options); await crashed.tick();
  assert.equal((await crashed.list("b")).items[0].status, "unconfirmed");
});
test("pause, reorder, edit and failure are scoped; active messages cannot be edited", async t => {
  const f = await fixture(t);
  await f.queue.add("a", { id: "message-0001", message: "one", files: [{ path: "/a.png" }] });
  await f.queue.add("a", { id: "message-0002", message: "two" });
  await f.queue.update("a", { action: "up", id: "message-0002" });
  await f.queue.update("a", { action: "edit", id: "message-0001", message: "updated" });
  await f.queue.update("a", { action: "pause" }); f.idle(); await f.queue.tick();
  assert.equal(f.calls.length, 0);
  await f.queue.update("a", { action: "resume" }); await f.queue.tick();
  assert.equal(f.calls[0][1].id, "message-0002");
  await assert.rejects(f.queue.update("a", { action: "edit", id: "message-0002", message: "bad" }), /editable/);
  await f.queue.finish("a", "message-0002", "failed"); await f.queue.tick();
  assert.equal(f.calls.length, 1); assert.equal((await f.queue.list("a")).paused, true);
  await f.queue.add("b", { id: "message-0001", message: "other thread" }); await f.queue.tick();
  assert.equal(f.calls[1][0], "b");
});
test("writer conflicts pause safely and explicit resume retries only rejected messages", async t => {
  let reject = true;
  const f = await fixture(t, async (_, body) => {
    if (reject) throw Object.assign(new Error("already has an active writer"), { status: 409 });
    return { turn: { id: body.id } };
  });
  await f.queue.add("a", { id: "message-0001", message: "one" }); f.idle(); await f.queue.tick();
  assert.equal((await f.queue.list("a")).items[0].status, "blocked");
  await f.queue.tick(); assert.equal(f.calls.length, 1);
  reject = false; await f.queue.update("a", { action: "resume" }); await f.queue.tick();
  assert.equal(f.calls.length, 2);
});
test("corrupt journal is not silently replaced", async t => {
  const f = await fixture(t); await fs.writeFile(f.options.file, "broken");
  await assert.rejects(f.queue.list("a"));
  assert.equal(await fs.readFile(f.options.file, "utf8"), "broken");
});
test("cancellation tombstones prevent a delayed enqueue, revisions reject stale snapshots", async t => {
  const f = await fixture(t);
  const cancelled = await f.queue.update("a", { action: "cancel", id: "cancelled-0001" });
  const retried = await f.queue.add("a", { id: "cancelled-0001", message: "late request" });
  assert.ok(retried.revision > cancelled.revision);
  assert.equal(retried.items[0].status, "cancelled");
  f.idle(); await f.queue.tick(); assert.equal(f.calls.length, 0);
  await assert.rejects(f.queue.update("__proto__", { action: "pause" }), /Invalid thread/);
  await f.queue.add("a", { id: "failed-00001", message: "fails" }); await f.queue.tick();
  await f.queue.finish("a", "failed-00001", "failed");
  await assert.rejects(f.queue.update("a", { action: "edit", id: "failed-00001", message: "retry" }), /只能移除/);
});
test("collaboration mode uses the real preset with explicit model and builtin instructions", () => {
  const presets = [{ name: "Plan", mode: "plan", model: "fallback" }, { name: "Default", mode: "default" }];
  assert.deepEqual(collaborationModeParams({ collaborationMode: "plan", model: "chosen", effort: "high" }, presets), {
    collaborationMode: { mode: "plan", settings: { model: "chosen", reasoning_effort: "high", developer_instructions: null } },
  });
  assert.throws(() => collaborationModeParams({ collaborationMode: "fake" }, presets));
  assert.throws(() => collaborationModeParams({ collaborationMode: "default" }, presets));
  assert.deepEqual(collaborationModeParams({}, []), {});
});
test("image artifacts use documented paths and typed MCP blocks only", () => {
  assert.equal(mediaAttachments({ type: "ImageGeneration", saved_path: "/output/a.png", result: "opaque" })[0].path, "/output/a.png");
  assert.deepEqual(mediaAttachments({ type: "imageGeneration", result: "/not-a-guaranteed-path.png" }), []);
  assert.equal(mediaAttachments({ type: "mcpToolCall", result: { content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] } })[0].kind, "image");
  assert.deepEqual(mediaAttachments({ result: { content: [{ type: "text", text: "/private/secret.png" }] } }), []);
});
