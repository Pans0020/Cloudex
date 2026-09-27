import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudex-preview-test-"));
process.env.HOST = "127.0.0.1"; process.env.AUTH_TOKEN = "fixture-only";
process.env.FILE_ROOTS = path.join(root, "allowed");
process.env.CODEX_SESSIONS_DIR = path.join(root, "sessions");
process.env.CLOUDEX_STATE_DIR = path.join(root, "state");
process.env.CLOUDEX_AGENT_PROVIDER = "codex";
const { handle, errorResponse } = await import("../src/server.js");
test("file preview verifies auth, canonical roots, HTML boundary and size", async t => {
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const allowed = path.join(root, "allowed");
  await fs.mkdir(path.join(allowed, "doc"), { recursive: true });
  await fs.writeFile(path.join(allowed, "doc", "文档 space.md"), "# Works");
  await fs.writeFile(path.join(allowed, "sibling.txt"), "sibling");
  await fs.writeFile(path.join(root, "secret.txt"), "secret");
  await fs.symlink(path.join(root, "secret.txt"), path.join(allowed, "escape.txt"));
  async function get(file, options = {}) {
    const request = { method: "GET", headers: { authorization: options.auth === false ? "" : "Bearer fixture-only" } };
    const response = new EventEmitter();
    response.writeHead = (code, headers) => { response.code = code; response.headers = headers; };
    response.end = data => { response.data = data?.toString(); };
    const url = new URL("http://localhost/api/file"); url.searchParams.set("path", file);
    if (options.previewRoot) url.searchParams.set("previewRoot", options.previewRoot);
    try { await handle(request, response, url); } catch (error) { errorResponse(response, error); }
    return response;
  }
  assert.equal((await get(path.join(allowed, "doc", "文档 space.md"))).code, 200);
  assert.equal((await get(path.join(allowed, "doc", "文档 space.md"), { auth: false })).code, 401);
  const escape = await get(path.join(allowed, "escape.txt"));
  assert.equal(escape.code, 403); assert.ok(!escape.data.includes('"secret"'));
  assert.equal((await get(path.join(allowed, "sibling.txt"), { previewRoot: path.join(allowed, "doc") })).code, 403);
  const large = path.join(allowed, "large.bin"); const file = await fs.open(large, "w");
  await file.truncate(50 * 1024 * 1024 + 1); await file.close();
  assert.equal((await get(large)).code, 413);
});
