import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudex-history-http-'));
Object.assign(process.env, { AUTH_TOKEN: 'fixture-only', CLOUDEX_AGENT_PROVIDER: 'codex',
  CLOUDEX_HISTORY_SOURCE: 'api-only', CLOUDEX_STATE_DIR: root, CODEX_HOME: root,
  CODEX_SESSIONS_DIR: path.join(root, 'sessions'), CODEX_BIN: '/not-a-real-codex' });
const { CodexClient } = await import('../src/codex-client.js');
const { handle, notifyHistoryChanged } = await import('../src/server.js');
after(() => fs.rm(root, { recursive: true, force: true }));
const turns = Array.from({ length: 30 }, (_, index) => ({ id: `turn-${index}`, status: 'completed', items: [
  { type: 'userMessage', id: `user-${index}`, content: [{ type: 'text', text: `Question ${index}` }] },
  { type: 'reasoning', id: `reason-${index}`, content: ['reasoning '.repeat(1000)] },
  { type: 'plan', id: `plan-${index}`, text: `Plan ${index}` },
] }));
const thread = { id: 'example', cwd: '/example', status: { type: 'idle' }, turns };
function response() {
  const res = new EventEmitter();
  res.chunks = [];
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.write = chunk => { res.chunks.push(chunk); };
  res.end = chunk => { if (chunk) res.chunks.push(chunk); };
  return res;
}
const req = { method: 'GET', headers: { authorization: 'Bearer fixture-only' } };
test('real compact HTTP pages keep cursors and plans without embedding the complete history', async t => {
  t.mock.method(CodexClient.prototype, 'request', async (method) => {
    assert.equal(method, 'thread/read');
    return { thread };
  });
  const res = response();
  await handle(req, res, new URL('http://localhost/api/threads/example?limit=3&view=compact'));
  const detail = JSON.parse(res.chunks.join(''));
  assert.equal(detail.thread.turns, undefined);
  assert.equal(detail.hasMoreBefore, true);
  assert.equal(detail.nextBefore, 'turn-27');
  assert.deepEqual(detail.turns.map(turn => turn.id), ['turn-27', 'turn-28', 'turn-29']);
  assert.deepEqual(detail.turns[0].items.map(item => item.type), ['userMessage', 'plan']);
  assert.equal(detail.turns[0].processItemCount, 1);
  assert.ok(res.chunks.join('').length < 2500, 'compact response must stay proportional to its page');
  const older = response();
  await handle(req, older, new URL('http://localhost/api/threads/example?limit=3&view=compact&before=turn-27'));
  assert.deepEqual(JSON.parse(older.chunks.join('')).turns.map(turn => turn.id), ['turn-24', 'turn-25', 'turn-26']);
  const index = response();
  await handle(req, index, new URL('http://localhost/api/threads/example/message-index'));
  assert.ok(JSON.parse(index.chunks.join('')).data.some(item => item.text === 'Plan 29'));
  assert.equal(thread.turns.length, 30, 'pagination must not mutate the stored history');
});
test('SSE tells reverse proxies to deliver events immediately', async () => {
  const res = response();
  try {
    await handle(req, res, new URL('http://localhost/api/threads/example/stream'));
    assert.equal(res.headers['x-accel-buffering'], 'no');
    assert.match(res.headers['cache-control'], /no-transform/);
    assert.match(res.chunks.join(''), /event: replay-complete/);
  } finally { res.emit('close'); }
});

test('pagination does not scan media or process items outside the requested page', async t => {
  const oldTurn = { id: 'old', get items() { throw new Error('old history must not be processed'); } };
  t.mock.method(CodexClient.prototype, 'request', async () => ({ thread: { ...thread, turns: [oldTurn, turns.at(-1)] } }));
  const res = response();
  await handle(req, res, new URL('http://localhost/api/threads/example?limit=1&view=compact'));
  assert.deepEqual(JSON.parse(res.chunks.join('')).turns.map(turn => turn.id), ['turn-29']);
});

test('inline image bytes are fetched separately from history and SSE', async t => {
  const data = Buffer.from('fixture image '.repeat(100000));
  const item = { id: 'image', type: 'mcpToolCall', result: { content: [{ type: 'image', mimeType: 'image/png', data: data.toString('base64') }] } };
  t.mock.method(CodexClient.prototype, 'request', async () => ({ thread: { id: 'image-thread', turns: [{ id: 'images', status: 'inProgress', items: [item] }] } }));
  const res = response();
  await handle(req, res, new URL('http://localhost/api/threads/image-thread?limit=1&view=compact'));
  assert.ok(res.chunks.join('').length < 1000, 'chat response must not contain base64 or the original tool result');
  const file = JSON.parse(res.chunks.join('')).turns[0].items[0].attachments[0].path;
  assert.ok(file.startsWith(path.join(root, 'inline-media')));
  const download = response();
  await handle(req, download, new URL(`http://localhost/api/file?path=${encodeURIComponent(file)}`));
  assert.equal(download.status, 200);
  assert.equal(download.headers['content-type'], 'image/png');
  assert.deepEqual(download.chunks[0], data);
  let client;
  t.mock.method(CodexClient.prototype, 'listModels', async function() { client = this; return { data: [] }; });
  await handle(req, response(), new URL('http://localhost/api/models'));
  const stream = response();
  try {
    await handle(req, stream, new URL('http://localhost/api/threads/image-thread/stream'));
    client.emit('notification', { method: 'item/completed', params: { threadId: 'image-thread', item } });
    assert.ok(stream.chunks.join('').length < 2000, 'live event must also contain an image reference');
  } finally { stream.emit('close'); }
});

test('reconnect replays only missing events and reconciles gaps or server restarts', async t => {
  let client;
  t.mock.method(CodexClient.prototype, 'listModels', async function() { client = this; return { data: [] }; });
  await handle(req, response(), new URL('http://localhost/api/models'));
  const threadId = 'replay-fixture';
  const emit = delta => client.emit('notification', { method: 'item/agentMessage/delta', params: { threadId, delta } });
  const first = response();
  await handle(req, first, new URL(`http://localhost/api/threads/${threadId}/stream`));
  emit('before');
  const cursor = first.chunks.join('').match(/id: ([^\n]+)/)[1];
  first.emit('close');
  emit('after');
  const reconnect = response();
  try {
    await handle({ ...req, headers: { ...req.headers, 'last-event-id': cursor } }, reconnect, new URL(`http://localhost/api/threads/${threadId}/stream`));
    assert.doesNotMatch(reconnect.chunks.join(''), /"delta":"before"/);
    assert.match(reconnect.chunks.join(''), /"delta":"after"/);
    assert.match(reconnect.chunks.join(''), /"resetRequired":false/);
  } finally { reconnect.emit('close'); }
  for (let index = 0; index < 260; index++) emit(String(index));
  for (const stale of [cursor, 'previous-controller:1']) {
    const gap = response();
    try {
      await handle({ ...req, headers: { ...req.headers, 'last-event-id': stale } }, gap, new URL(`http://localhost/api/threads/${threadId}/stream`));
      assert.match(gap.chunks.join(''), /"resetRequired":true/);
      assert.match(gap.chunks.join(''), /event: history\/changed/);
      assert.doesNotMatch(gap.chunks.join(''), /event: notification/);
      assert.match(gap.chunks.join(''), /id: [^\n]+\nevent: replay-complete/);
    } finally { gap.emit('close'); }
  }
});

test('selected external history updates arrive without waiting for the project scan', async t => {
  t.mock.method(CodexClient.prototype, 'request', async method => {
    assert.equal(method, 'thread/list');
    return { data: [] };
  });
  const id = '11111111-1111-4111-8111-111111111111';
  const selected = response();
  const other = response();
  try {
    await handle(req, selected, new URL(`http://localhost/api/threads/${id}/stream`));
    await handle(req, other, new URL('http://localhost/api/threads/other/stream'));
    for (let index = 0; index < 5; index++) notifyHistoryChanged(`/fixture/rollout-2026-10-03-${id}.jsonl`);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((selected.chunks.join('').match(/event: history\/changed/g) || []).length, 1);
    assert.doesNotMatch(other.chunks.join(''), /event: history\/changed/);
  } finally { selected.emit('close'); other.emit('close'); }
});

test('disconnect clears approvals and questions whose upstream requests no longer exist', async t => {
  let client;
  t.mock.method(CodexClient.prototype, 'listModels', async function() { client = this; return { data: [] }; });
  await handle(req, response(), new URL('http://localhost/api/models'));
  client.emit('serverRequest', { id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'example', command: 'fixture' } });
  client.emit('serverRequest', { id: 2, method: 'tool/requestUserInput', params: { threadId: 'example', questions: [] } });
  for (const route of ['approvals', 'inputs']) {
    const res = response();
    await handle(req, res, new URL(`http://localhost/api/${route}`));
    assert.equal(JSON.parse(res.chunks.join('')).data.length, 1);
    if (route === 'inputs') assert.equal(JSON.parse(res.chunks.join('')).data[0].method, 'item/tool/requestUserInput');
  }
  client.emit('disconnected');
  for (const route of ['approvals', 'inputs']) {
    const res = response();
    await handle(req, res, new URL(`http://localhost/api/${route}`));
    assert.deepEqual(JSON.parse(res.chunks.join('')).data, []);
  }
});
