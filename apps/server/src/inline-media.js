import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Chat pages carry small file references. Original images remain available
// through the authenticated file endpoint and survive controller restarts.
export function createInlineMediaCache(directory) {
  const writes = new Map();
  const ready = new Set();
  function externalize(attachments) {
    return attachments.map(attachment => {
      const match = attachment.path?.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/\r\n]*={0,2})$/);
      if (!match) return attachment;
      const digest = crypto.createHash("sha256").update(match[2]).digest("hex");
      const extension = match[1].slice(6).replace("jpeg", "jpg");
      const file = path.join(directory, `${digest}.${extension}`);
      if (!ready.has(file) && !writes.has(file)) {
        const write = (async () => {
          await fs.mkdir(directory, { recursive: true, mode: 0o700 });
          const data = Buffer.from(match[2], "base64");
          try {
            if ((await fs.stat(file)).size === data.length) return;
          } catch {}
          const temporary = `${file}.${crypto.randomUUID()}.tmp`;
          try {
            await fs.writeFile(temporary, data, { mode: 0o600 });
            await fs.rename(temporary, file);
          } finally { await fs.rm(temporary, { force: true }); }
        })();
        writes.set(file, write);
        void write.then(() => {
          ready.add(file);
          if (ready.size > 512) ready.delete(ready.values().next().value);
        }, () => {}).finally(() => writes.delete(file));
      }
      return { ...attachment, path: file };
    });
  }
  return { externalize, wait: file => writes.get(file) || Promise.resolve() };
}
