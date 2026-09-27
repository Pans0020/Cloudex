#!/usr/bin/env node
// Run --restart only after finishing Desktop tasks. --check never stops anything.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const run = promisify(execFile);
const mode = process.argv[2] || '--check';
if (process.platform !== 'darwin' || !['--check', '--restart', '--rollback'].includes(mode)) {
  throw new Error('Usage on macOS: node apps/server/bin/connect-desktop.js --check|--restart|--rollback');
}
const app = '/Applications/ChatGPT.app';
const port = Number(process.env.CLOUDEX_DESKTOP_BRIDGE_PORT || 8891);
const state = process.env.CLOUDEX_STATE_DIR || path.resolve('.cloudex-state');
let url;
if (mode !== '--rollback') {
  const token = (await fs.readFile(path.join(state, 'desktop-bridge-token'), 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) throw new Error('Invalid bridge token');
  url = `ws://127.0.0.1:${port}/${token}`;
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error('共享服务初始化超时；没有重启 Desktop。')); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'cloudex-desktop-connect', version: '1' }, capabilities: { experimentalApi: true },
    } }));
    ws.onerror = () => { clearTimeout(timer); reject(new Error('本机桥接服务不可用；没有重启 Desktop。')); };
    ws.onmessage = event => {
      const reply = JSON.parse(event.data);
      if (reply.id !== 1) return;
      clearTimeout(timer);
      ws.onerror = () => {};
      ws.close();
      reply.error ? reject(new Error(reply.error.message)) : resolve();
    };
  });
  console.log('共享 app-server 初始化通过。');
}

async function desktopPID() {
  try {
    const { stdout } = await run('/usr/bin/pgrep', ['-f', '^/Applications/ChatGPT.app/Contents/MacOS/ChatGPT($| )']);
    return stdout.trim().split('\n')[0];
  } catch { return null; }
}
async function isConnected() {
  const pid = await desktopPID();
  if (!pid) return false;
  try {
    const { stdout } = await run('/usr/sbin/lsof', ['-nP', '-a', '-p', pid, `-iTCP:${port}`, '-sTCP:ESTABLISHED']);
    return stdout.includes('ESTABLISHED');
  } catch { return false; }
}

if (mode === '--check') {
  const connected = await isConnected();
  console.log(connected ? 'Desktop 已连接本机共享服务。' : 'Desktop 尚未连接共享服务；仅切换对话不会生效，需要完整重启 Desktop。');
  process.exitCode = connected ? 0 : 2;
} else {
  // Never force-kill: a failed/refused quit must not discard in-flight work.
  if (await desktopPID()) await run('/usr/bin/osascript', ['-e', 'tell application id "com.openai.codex" to quit']);
  for (let attempt = 0; attempt < 20 && await desktopPID(); attempt++) await delay(500);
  if (await desktopPID()) throw new Error('Desktop 仍在运行，停止切换；请结束任务并正常退出后重试。');
  if (mode === '--rollback') {
    await run('/bin/launchctl', ['unsetenv', 'CODEX_APP_SERVER_WS_URL']);
    await run('/usr/bin/open', ['-a', app]);
    console.log('已取消共享服务覆盖并重新打开 Desktop。');
  } else {
    await run('/bin/launchctl', ['setenv', 'CODEX_APP_SERVER_WS_URL', url]);
    await run('/usr/bin/open', ['-a', app, '--env', `CODEX_APP_SERVER_WS_URL=${url}`, '--env', 'CODEX_APP_SERVER_FORCE_CLI=0']);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await isConnected()) { console.log('已确认 Desktop 建立了共享服务连接。'); process.exit(0); }
      await delay(1000);
    }
    throw new Error('Desktop 已打开但尚未检测到共享连接；请检查桥日志，必要时运行 --rollback。');
  }
}
