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
  "guide.md": "# 实际界面截图\n\n这是内置 Markdown 文档。\n\n![预览图片](picture.png)\n\n[打开 HTML](page.html)\n\n[播放 GIF](animation.gif)\n\n[打开 PPT](slides.pptx)\n",
  "page.html": "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><link rel='stylesheet' href='style.css'><h1>HTML 预览成功</h1><img width='160' src='picture.png'><p id='state'>静态模式</p><button onclick=\"document.querySelector('#state').textContent='交互成功'\">测试交互</button>",
  "style.css": "body{font:24px system-ui;background:#e5f4ef;padding:20px;color:#126154}img{border:3px solid #126154}",
})) await fs.writeFile(path.join(root, name), content);
await fs.copyFile(new URL("../../../docs/design/screenshots/light-home.png", import.meta.url), path.join(root, "picture.png"));
await fs.writeFile(path.join(root, "animation.gif"), Buffer.from("47494638396101000100800000000000ffffff21ff0b4e45545343415045322e30030100000021f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b", "hex"));
await fs.copyFile(new URL("fixtures/preview.pptx", import.meta.url), path.join(root, "slides.pptx"));
const queue = new MessageQueue({ file: path.join(root, "queue.json"), inspect: async () => ({ busy: true }), send: async () => { throw new Error("Fixture never dispatches real turns"); } });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const match = url.pathname.match(/^\/api\/threads\/([^/]+)\/queue$/);
  if (match) {
    try {
      let result;
      if (req.method === "GET") result = await queue.list(match[1]);
      else {
        let text = ""; for await (const chunk of req) text += chunk;
        const data = JSON.parse(text);
        result = data.action ? await queue.update(match[1], data) : await queue.add(match[1], data);
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
    } catch (error) { errorResponse(res, error); }
    return;
  }
  if (url.pathname !== "/api/file") { res.writeHead(404); res.end(); return; }
  for (const key of ["path", "previewRoot"]) {
    const value = url.searchParams.get(key);
    if (value?.startsWith("/ui/")) url.searchParams.set(key, path.join(root, value.slice(4)));
    else if (value === "/ui") url.searchParams.set(key, root);
  }
  handle(req, res, url).catch(error => errorResponse(res, error));
});
server.listen(18089, "127.0.0.1", () => console.log("Preview fixture: 127.0.0.1:18089"));
process.on("SIGTERM", () => server.close(async () => { await fs.rm(root, { recursive: true, force: true }); process.exit(0); }));
