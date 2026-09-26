import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudex-shared-probe-'));
const binary = process.argv[2] || 'codex';
const useBridge = process.argv.includes('--unix-bridge');
const sockets = [];
const bridgeSockets = new Set();
let bridge;
let child;
let mockRequests = 0;
const mock = http.createServer(async (req, res) => {
  for await (const _ of req) {}
  mockRequests++;
  const id = `probe-${mockRequests}`;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const item = { id: `msg-${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'probe OK', annotations: [] }] };
  event('response.created', { response: { id, status: 'in_progress', output: [] } });
  event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'probe OK' });
  event('response.output_item.done', { output_index: 0, item });
  event('response.completed', { response: { id, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  res.end();
});
mock.listen(0, '127.0.0.1');
await once(mock, 'listening');
const reserve = net.createServer();
reserve.listen(0, '127.0.0.1');
await once(reserve, 'listening');
const port = reserve.address().port;
await new Promise(r => reserve.close(r));
const url = `ws://127.0.0.1:${port}`;
async function connect(name) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('connect')); });
  sockets.push(ws);
  const pending = new Map(); const events = []; let seq = 0;
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else events.push(m);
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await request('initialize', { clientInfo: { name, version: '0.1' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: 'initialized' }));
  return { request, events };
}
async function terminal(client, turnId) {
  for (let i = 0; i < 200; i++) {
    const found = client.events.find(m => m.method === 'turn/completed' && m.params?.turn?.id === turnId);
    if (found) return found.params.turn;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`No completion for ${turnId}`);
}
try {
  await fs.mkdir(path.join(root, 'codex'));
  const unixPath = path.join(root, 'rpc.sock');
  child = spawn(binary, ['-c', 'model_provider="probe"', '-c', 'model="probe"', '-c', `model_providers.probe={name="probe",base_url="http://127.0.0.1:${mock.address().port}/v1",wire_api="responses",requires_openai_auth=false}`, 'app-server', '--listen', useBridge ? `unix://${unixPath}` : url], {
    env: { ...process.env, CODEX_HOME: path.join(root, 'codex'), OPENAI_API_KEY: '', RUST_LOG: 'error' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = ''; child.stderr.on('data', d => { stderr += d; }); child.stdout.resume();
  if (useBridge) {
    // Test-only byte bridge, isolated from the user's actual daemon.
    bridge = net.createServer(local => {
      const remote = net.createConnection(unixPath);
      for (const socket of [local, remote]) {
        bridgeSockets.add(socket);
        socket.on('close', () => bridgeSockets.delete(socket));
        socket.on('error', () => { local.destroy(); remote.destroy(); });
      }
      local.pipe(remote).pipe(local);
    });
    bridge.listen(port, '127.0.0.1');
    await once(bridge, 'listening');
  }
  let a;
  for(let i=0;i<80;i++) { try { a = await connect('probe-desktop'); break; } catch { await new Promise(r=>setTimeout(r,100)); } }
  if (!a) throw new Error(`Unable to connect to ${useBridge ? 'Unix bridge' : 'WebSocket'}; binary=${binary}; exit=${child.exitCode}; root=${root}\n${stderr}`);
  const b = await connect('probe-phone');
  const started = await a.request('thread/start', { cwd: root, model: 'probe', modelProvider: 'probe', approvalPolicy: 'never', sandbox: 'read-only' });
  const threadId = started.thread.id;
  const initial = await a.request('turn/start', { threadId, input: [{ type: 'text', text: 'Reply probe OK without tools.' }] });
  assert.equal((await terminal(a, initial.turn.id)).status, 'completed');
  const resumed = await b.request('thread/resume', { threadId });
  assert.equal(resumed.thread.id, threadId);
  const first = await b.request('turn/start', { threadId, input: [{ type: 'text', text: 'Reply probe OK without tools.' }] });
  const bt = await terminal(b, first.turn.id);
  const at = await terminal(a, first.turn.id);
  assert.equal(bt.status, 'completed'); assert.equal(at.status, 'completed');
  await b.request('thread/unsubscribe', { threadId });
  const second = await a.request('turn/start', { threadId, input: [{ type: 'text', text: 'Reply probe OK again without tools.' }] });
  assert.equal((await terminal(a, second.turn.id)).status, 'completed');
  console.log(JSON.stringify({ binary, transport: useBridge ? 'loopback-byte-bridge-to-unix' : 'websocket', root, sameThreadResume: true, phoneTurn: bt.status, desktopReceivedPhoneCompletion: true, desktopTurnAfterPhoneUnsubscribe: true, mockRequests }, null, 2));
} catch(e) { console.error(e); process.exitCode = 1; }
finally { for(const ws of sockets) ws.close(); for (const socket of bridgeSockets) socket.destroy(); bridge?.close(); child?.kill('SIGTERM'); mock.closeAllConnections(); mock.close(); }
