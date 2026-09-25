import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudex-image-test-"));
process.env.CLOUDEX_STATE_DIR = stateDir;
const { saveUploadedImage } = await import("../src/server.js");

test("phone image uploads accept JPEG bytes and reject other content", async () => {
  try {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const file = await saveUploadedImage(bytes, "image/jpeg");
    assert.equal(file.type, "file");
    assert.equal(path.dirname(file.path), path.join(stateDir, "uploads"));
    assert.deepEqual(await fs.readFile(file.path), bytes);
    await assert.rejects(saveUploadedImage(Buffer.from("not an image"), "image/jpeg"),
      (error) => error.status === 415);
    await assert.rejects(saveUploadedImage(bytes, "text/plain"),
      (error) => error.status === 415);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
