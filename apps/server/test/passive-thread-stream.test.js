import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

process.env.AUTH_TOKEN = "test-token";
process.env.CLOUDEX_AGENT_PROVIDER = "codex";
const { CodexClient, CodexError } = await import("../src/codex-client.js");
const { errorResponse, handle, scheduleThreadUnsubscribe } = await import("../src/server.js");

function response() {
  const res = new EventEmitter();
  res.chunks = [];
  res.writeHead = (status) => { res.status = status; };
  res.write = (chunk) => { res.chunks.push(chunk); };
  res.end = (chunk) => { if (chunk) res.chunks.push(chunk); };
  return res;
}

test("opening a Codex thread stream remains read-only", async () => {
  const res = response();
  try {
    await handle(
      { method: "GET", headers: { authorization: "Bearer test-token" } },
      res,
      new URL("http://localhost/api/threads/not-loaded/stream"),
    );
    assert.equal(res.status, 200);
    assert.match(res.chunks.join(""), /event: read-only/);
    assert.doesNotMatch(res.chunks.join(""), /event: error/);
  } finally {
    res.emit("close");
  }
});

test("writer conflicts return a useful 409 instead of a raw Codex error", () => {
  const res = response();
  errorResponse(res, new CodexError("thread example already has an active writer"));
  assert.equal(res.status, 409);
  assert.match(JSON.parse(res.chunks.join("")).error, /其他客户端占用/);
  assert.match(JSON.parse(res.chunks.join("")).error, /切换电脑端对话不会释放/);
});

test("an open read-only phone stream does not retain the writer", async (t) => {
  const calls = [];
  t.mock.method(CodexClient.prototype, "unsubscribeThread", async (threadId, shouldRelease) => {
    calls.push([threadId, shouldRelease()]);
  });
  const res = response();
  await handle(
    { method: "GET", headers: { authorization: "Bearer test-token" } },
    res,
    new URL("http://localhost/api/threads/open-stream/stream"),
  );
  scheduleThreadUnsubscribe("open-stream", 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, [["open-stream", true]]);
  res.emit("close");
});
