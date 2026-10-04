import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";

test("about recognizes the control socket and session directory", { skip: process.platform === "win32" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudex-about-"));
  const socketPath = path.join(dir, "control.sock");
  const configPath = path.join(dir, "config.toml");
  const socket = net.createServer();
  try {
    await fs.writeFile(configPath, "");
    socket.listen(socketPath);
    await once(socket, "listening");
    const { stdout } = await promisify(execFile)(process.execPath,
      [new URL("../bin/cloudex.js", import.meta.url).pathname, "about", "--json"], {
        env: { ...process.env, CODEX_BIN: process.execPath, CODEX_CONTROL_SOCKET: socketPath,
          CODEX_SESSIONS_DIR: dir, CODEX_CONFIG_PATH: configPath, CLOUDEX_STATE_DIR: dir, PORT: "0" },
        timeout: 10_000,
      });
    const info = JSON.parse(stdout);
    assert.equal(info.codexExists, true);
    assert.equal(info.controlSocketExists, true);
    assert.equal(info.sessionsDirExists, true);
    assert.equal(info.configFileExists, true);
  } finally {
    await new Promise((resolve) => socket.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
