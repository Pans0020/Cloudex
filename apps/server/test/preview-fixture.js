// Isolated UI files, never starts Codex or indexes real sessions.
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MessageQueue } from "../src/message-queue.js";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudex-preview-fixture-"));
process.env.HOST = "127.0.0.1"; process.env.FILE_ROOTS = root;
process.env.AUTH_TOKEN = "";
process.env.CLOUDEX_STATE_DIR = path.join(root, "state");
process.env.CODEX_SESSIONS_DIR = path.join(root, "no-sessions");
process.env.CLOUDEX_AGENT_PROVIDER = "codex";
const { handle, errorResponse } = await import("../src/server.js");
process.removeAllListeners("SIGTERM");
for (const [name, content] of Object.entries({
  "guide.md": "# 实际界面截图\n\n这是内置 Markdown 文档。\n\n![预览图片](picture.png)\n\n[打开 HTML](page.html)\n\n[播放 GIF](animation.gif)\n\n[打开 PPT](slides.pptx)\n\n[预览失败后重试](retry.html)\n",
  "retry.html": "<h1>重试预览成功</h1><p id='network'>尚未执行脚本</p><script>fetch('http://127.0.0.1:18089/forbidden-network').then(()=>document.querySelector('#network').textContent='不应允许网络').catch(()=>document.querySelector('#network').textContent='网络已隔离')</script>",
  "page.html": "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><link rel='stylesheet' href='style.css'><h1>HTML 预览成功</h1><img width='160' src='picture.png'><p id='state'>静态模式</p><button onclick=\"document.querySelector('#state').textContent='交互成功'\">测试交互</button>",
  "style.css": "body{font:24px system-ui;background:#e5f4ef;padding:20px;color:#126154}img{border:3px solid #126154}",
})) await fs.writeFile(path.join(root, name), content);
await fs.copyFile(new URL("../../../docs/design/screenshots/light-home.png", import.meta.url), path.join(root, "picture.png"));
await fs.copyFile(new URL("fixtures/preview.gif", import.meta.url), path.join(root, "animation.gif"));
await fs.copyFile(new URL("fixtures/preview.pptx", import.meta.url), path.join(root, "slides.pptx"));
let sequence = 0;
const makeQueue = () => new MessageQueue({ file: path.join(root, `queue-${sequence++}.json`), inspect: async () => ({ busy: true }), send: async () => { throw new Error("Fixture never dispatches real turns"); } });
let queue = makeQueue();
let fault = {};
let forbiddenRequests = 0;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/fixture-control") {
    if (req.method === "POST") {
      let text = ""; for await (const chunk of req) text += chunk;
      const input = JSON.parse(text);
      if (input.reset) { queue = makeQueue(); forbiddenRequests = 0; }
      fault = input;
    }
    const snapshot = await queue.list("ui-CV");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ forbiddenRequests, items: snapshot.items })); return;
  }
  if (url.pathname === "/forbidden-network") { forbiddenRequests++; res.end("forbidden"); return; }
  const match = url.pathname.match(/^\/api\/threads\/([^/]+)\/queue$/);
  if (match) {
    try {
      let result;
      if (req.method === "GET") result = await queue.list(match[1]);
      else {
        let text = ""; for await (const chunk of req) text += chunk;
        const data = JSON.parse(text);
        if (!data.action && fault.delayFirstEnqueue) {
          fault.delayFirstEnqueue = false;
          await new Promise(resolve => setTimeout(resolve, 4500));
        }
        result = data.action ? await queue.update(match[1], data) : await queue.add(match[1], data);
        if (fault.dropQueueReplies) { res.destroy(); return; }
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
    } catch (error) { errorResponse(res, error); }
    return;
  }
  if (url.pathname !== "/api/file") { res.writeHead(404); res.end(); return; }
  if (fault.failHTMLResource && url.searchParams.get("path") === "/ui/retry.html" && url.searchParams.has("previewRoot")) {
    fault.failHTMLResource = false;
    res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "模拟文件请求失败" })); return;
  }
  for (const key of ["path", "previewRoot"]) {
    const value = url.searchParams.get(key);
    if (value?.startsWith("/ui/")) url.searchParams.set(key, path.join(root, value.slice(4)));
    else if (value === "/ui") url.searchParams.set(key, root);
  }
  handle(req, res, url).catch(error => errorResponse(res, error));
});
server.listen(18089, "127.0.0.1", () => console.log("Preview fixture: 127.0.0.1:18089"));
process.on("SIGTERM", () => server.close(async () => { await fs.rm(root, { recursive: true, force: true }); process.exit(0); }));
