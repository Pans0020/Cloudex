import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudex-archive-state-"));
process.env.CLOUDEX_STATE_DIR = stateDir;
const { archiveCliThread, readArchiveSet } = await import("../src/cli-sessions.js");

test("concurrent archives preserve both sessions and readable state", async () => {
  try {
    const writes = Promise.all([archiveCliThread("first"), archiveCliThread("second")]);
    for (let index = 0; index < 20; index += 1) await readArchiveSet();
    await writes;
    assert.deepEqual([...await readArchiveSet()].sort(), ["first", "second"]);
    const raw = JSON.parse(await fs.readFile(path.join(stateDir, "archived-cli-threads.json"), "utf8"));
    assert.deepEqual(raw.archivedThreadIds, ["first", "second"]);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
