import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

process.env.AUTH_TOKEN = "test-token";
process.env.CLOUDEX_AGENT_PROVIDER = "codex";
const { CodexError } = await import("../src/codex-client.js");
const { errorResponse, handle } = await import("../src/server.js");

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
});
