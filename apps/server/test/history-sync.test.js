import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudex-history-sync-'));
process.env.CODEX_HOME = root;
process.env.CODEX_SESSIONS_DIR = path.join(root, 'sessions');
process.env.CLOUDEX_STATE_DIR = path.join(root, 'state');
await fs.mkdir(process.env.CODEX_SESSIONS_DIR);
const { listCliThreads, readCliThread, readCliThreadById, watchCliSessions } = await import('../src/cli-sessions.js');
after(() => fs.rm(root, { recursive: true, force: true }));
const id = '01a0b5c4-87bf-7d62-8399-427cc487552e';
const file = path.join(process.env.CODEX_SESSIONS_DIR, `rollout-2026-10-03T00-00-00-${id}.jsonl`);
const line = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n';

test('summary reads append only, follow index renames, and agree with full history', async t => {
  await fs.writeFile(file, line('session_meta', { id, cwd: '/project', cli_version: '0.160.0' }) +
    line('event_msg', { type: 'task_started', turn_id: 't1' }) +
    line('event_msg', { type: 'user_message', message: '你好，实时同步', turn_id: 't1' }) +
    line('response_item', { type: 'function_call', call_id: 'cmd', name: 'exec_command', arguments: JSON.stringify({ cmd: 'rg sample' }) }) +
    line('response_item', { type: 'function_call_output', call_id: 'cmd', output: 'large output '.repeat(50000) }));
  const [summary] = await listCliThreads();
  const detail = await readCliThreadById(id);
  assert.equal(summary.preview, detail.thread.preview);
  assert.equal(summary.status.type, 'active');
  assert.equal(summary.turns, undefined);
  const originalOpen = fs.open;
  const offsets = [];
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => { offsets.push(readArgs[3]); return originalRead(...readArgs); };
    return handle;
  });
  const index = path.join(root, 'session_index.jsonl');
  await fs.writeFile(index, JSON.stringify({ id, thread_name: '新标题' }) + '\n');
  assert.equal((await listCliThreads())[0].name, '新标题');
  assert.deepEqual(offsets, [], 'unchanged rollout must not be read after index rename');
  const previousSize = (await fs.stat(file)).size;
  await fs.appendFile(file, line('event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: '完成' }));
  const [first, second] = await Promise.all([listCliThreads(), listCliThreads()]);
  assert.equal(first[0].status.type, 'idle');
  assert.equal(second[0].status.type, 'idle');
  assert.deepEqual(offsets, [0, previousSize - 256, previousSize],
    'overlapping refreshes share the append guards and one incremental read');
  const completed = await readCliThreadById(id);
  assert.equal(completed.turns[0].status, 'completed');
  assert.equal(completed.turns[0].items.at(-1).text, '完成');
});

test('partial UTF-8 records, truncation, and atomic replacement do not lose history', async () => {
  const prefix = line('session_meta', { id, cwd: '/project' });
  const message = Buffer.from(line('event_msg', { type: 'user_message', turn_id: 't2', message: '分块中文🙂' }));
  const split = message.indexOf(Buffer.from('中')) + 1;
  await fs.writeFile(file, Buffer.concat([Buffer.from(prefix), message.subarray(0, split)]));
  assert.equal((await readCliThreadById(id)).turns.length, 0);
  await fs.appendFile(file, message.subarray(split));
  let detail = await readCliThreadById(id);
  assert.equal(detail.turns[0].items[0].content[0].text, '分块中文🙂');
  const replacement = file + '.tmp';
  await fs.writeFile(replacement, prefix + line('event_msg', { type: 'user_message', turn_id: 'new', message: '替换后的历史' }));
  await fs.rename(replacement, file);
  detail = await readCliThreadById(id);
  assert.deepEqual(detail.turns.map(turn => turn.id), ['new']);
  assert.equal((await listCliThreads())[0].preview, '替换后的历史');
});

test('session and title changes are observed without the polling interval', async () => {
  let stop;
  let timeout;
  try {
    const changed = new Promise((resolve, reject) => {
      stop = watchCliSessions(resolve);
      timeout = setTimeout(() => reject(new Error('session watch timed out')), 2000);
    });
    await fs.appendFile(file, line('event_msg', { type: 'task_complete', turn_id: 'new' }));
    await changed;
  } finally {
    clearTimeout(timeout);
    stop?.();
  }
});

test('a large single JSONL record is assembled once rather than copied for every block', async t => {
  const content = '大图片和工具输出🙂'.repeat(180000);
  await fs.appendFile(file, line('event_msg', { type: 'task_started', turn_id: 'large' }) +
    line('event_msg', { type: 'user_message', turn_id: 'large', message: content }));
  const size = (await fs.stat(file)).size;
  const concat = Buffer.concat;
  let copied = 0;
  t.mock.method(Buffer, 'concat', (buffers, length) => {
    copied += length ?? buffers.reduce((total, buffer) => total + buffer.length, 0);
    return concat(buffers, length);
  });
  const detail = await readCliThreadById(id);
  assert.ok(detail.turns.find(turn => turn.id === 'large').items[0].content[0].text === content, 'large record text must stay intact');
  assert.ok(copied <= size * 2, `copied ${copied} bytes for ${size} source bytes`);
});

test('partial records resume at the last byte read and a continuation keeps the parsed base', async t => {
  const threadId = '10000000-0000-4000-8000-000000000001';
  const base = path.join(process.env.CODEX_SESSIONS_DIR, `rollout-2026-10-03T01-00-00-${threadId}.jsonl`);
  const message = '分块内容🙂'.repeat(100000);
  const record = Buffer.from(line('event_msg', { type: 'user_message', turn_id: 'next', message }));
  const split = record.length - 37;
  await fs.writeFile(base, Buffer.concat([Buffer.from(line('session_meta', { id: threadId }) +
    line('event_msg', { type: 'user_message', turn_id: 'first', message: 'first' })), record.subarray(0, split)]));
  const initial = await readCliThread(base);
  assert.deepEqual(initial.turns.map(turn => turn.id), ['first']);
  const previousSize = (await fs.stat(base)).size;
  const originalOpen = fs.open;
  const reads = [];
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      reads.push({ path: args[0], position: readArgs[3], length: readArgs[2] });
      return originalRead(...readArgs);
    };
    return handle;
  });
  await fs.appendFile(base, record.subarray(split));
  const complete = await readCliThread(base);
  assert.strictEqual(complete.turns[0], initial.turns[0]);
  assert.equal(complete.turns[1].items[0].content[0].text, message);
  assert.deepEqual(reads.map(read => read.position), [0, previousSize - 256, previousSize]);
  assert.ok(reads.reduce((sum, read) => sum + read.length, 0) < 5000, 'a partial multi-megabyte record must not be reread');
  reads.length = 0;
  const continuation = path.join(process.env.CODEX_SESSIONS_DIR,
    `rollout-2026-10-03T02-00-00-${threadId}_20000000-0000-4000-8000-000000000001.jsonl`);
  await fs.writeFile(continuation, line('event_msg', { type: 'task_complete', turn_id: 'next' }));
  const continued = await readCliThreadById(threadId);
  assert.strictEqual(continued.turns[0], initial.turns[0]);
  assert.equal(continued.turns[1].status, 'completed');
  assert.ok(reads.every(read => read.path === continuation), 'a new continuation must only read its new file');
});

test('same-inode rewrites and preserved mtime replacements invalidate history and title revisions', async () => {
  const threadId = '10000000-0000-4000-8000-000000000002';
  const target = path.join(process.env.CODEX_SESSIONS_DIR, `rollout-2026-10-03T03-00-00-${threadId}.jsonl`);
  const prefix = line('session_meta', { id: threadId });
  const history = (message, turn = 'turn') => prefix + line('event_msg', { type: 'user_message', turn_id: turn, message });
  await fs.writeFile(target, history('old'));
  const old = await readCliThread(target);
  const oldStat = await fs.stat(target);
  await fs.writeFile(target, history('a longer replacement', 'replacement'));
  assert.equal((await fs.stat(target)).ino, oldStat.ino);
  let rewritten = await readCliThread(target);
  assert.deepEqual(rewritten.turns.map(turn => turn.id), ['replacement']);
  assert.equal(rewritten.thread.preview, 'a longer replacement');
  const fixedTime = new Date('2026-10-03T00:00:00.000Z');
  await fs.utimes(target, fixedTime, fixedTime);
  const beforeCorrection = await readCliThread(target);
  const stat = await fs.stat(target);
  await fs.writeFile(target, history('a longer overwritten', 'replacement'));
  await fs.utimes(target, fixedTime, fixedTime);
  const correctionStat = await fs.stat(target);
  assert.equal(correctionStat.size, stat.size);
  assert.equal(correctionStat.mtimeMs, stat.mtimeMs);
  rewritten = await readCliThread(target);
  assert.equal(rewritten.thread.preview, 'a longer overwritten');
  assert.notEqual(rewritten.thread.syncRevision, beforeCorrection.thread.syncRevision,
    'equal-size, equal-mtime rewrites must publish a different revision');
  assert.notEqual(rewritten.thread.syncRevision, old.thread.syncRevision);
  const index = path.join(root, 'session_index.jsonl');
  await fs.writeFile(index, JSON.stringify({ id: threadId, thread_name: 'TitleA' }) + '\n');
  assert.equal((await readCliThread(target)).thread.name, 'TitleA');
  const indexStat = await fs.stat(index);
  const replacement = index + '.replacement';
  await fs.writeFile(replacement, JSON.stringify({ id: threadId, thread_name: 'TitleB' }) + '\n');
  await fs.utimes(replacement, indexStat.atime, indexStat.mtime);
  await fs.rename(replacement, index);
  assert.equal((await readCliThread(target)).thread.name, 'TitleB');
});

test('a stalled history read does not block another thread and duplicate reads share work', async t => {
  const slow = path.join(root, 'rollout-2026-10-03T04-00-00-10000000-0000-4000-8000-000000000003.jsonl');
  const fast = path.join(root, 'rollout-2026-10-03T04-00-00-10000000-0000-4000-8000-000000000004.jsonl');
  await fs.writeFile(slow, line('event_msg', { type: 'user_message', message: 'slow' }));
  await fs.writeFile(fast, line('event_msg', { type: 'user_message', message: 'fast' }));
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const originalOpen = fs.open;
  let slowOpens = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === slow) {
      slowOpens += 1;
      const originalRead = handle.read.bind(handle);
      handle.read = async (...readArgs) => { started(); await gate; return originalRead(...readArgs); };
    }
    return handle;
  });
  const first = readCliThread(slow);
  await entered;
  const duplicate = readCliThread(slow);
  let timeout;
  try {
    const completed = await Promise.race([readCliThread(fast), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('unrelated history read was blocked')), 1000);
    })]);
    assert.equal(completed.thread.preview, 'fast');
  } finally { clearTimeout(timeout); release(); }
  assert.strictEqual(await duplicate, await first);
  assert.equal(slowOpens, 1);
});

test('discarded tool output does not evict another history or get decoded for a summary', async t => {
  const targets = [5, 6].map(value => path.join(root,
    `rollout-2026-10-03T05-00-00-10000000-0000-4000-8000-${String(value).padStart(12, '0')}.jsonl`));
  const output = line('response_item', { type: 'function_call_output', call_id: 'tool-only', output: 'x'.repeat(33 * 1024 * 1024) });
  for (const target of targets) {
    await fs.writeFile(target, line('event_msg', { type: 'user_message', message: 'small retained history' }) + output);
    await readCliThread(target);
  }
  let opens = 0;
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (...args) => { opens += 1; return originalOpen(...args); });
  assert.equal((await readCliThread(targets[0])).thread.preview, 'small retained history');
  assert.equal(opens, 0, 'large discarded output must not cause repeated detail reparses');
  let largeParses = 0;
  const parse = JSON.parse;
  t.mock.method(JSON, 'parse', (...args) => {
    if (typeof args[0] === 'string' && args[0].length > 256 * 1024) largeParses += 1;
    return parse(...args);
  });
  assert.equal((await readCliThread(targets[0], { includeTurns: false })).thread.preview, 'small retained history');
  assert.equal(largeParses, 0, 'summary reads should skip a known tool-output record before decoding it');
});

test('two image-sized retained histories stay warm within the controller memory budget', async t => {
  const targets = [7, 8].map(value => path.join(root,
    `rollout-2026-10-03T05-00-00-10000000-0000-4000-8000-${String(value).padStart(12, '0')}.jsonl`));
  const record = line('event_msg', { type: 'user_message', message: 'x'.repeat(20 * 1024 * 1024) });
  for (const target of targets) { await fs.writeFile(target, record); await readCliThread(target); }
  let opens = 0;
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (...args) => { opens += 1; return originalOpen(...args); });
  await readCliThread(targets[0]);
  assert.equal(opens, 0, 'alternating two histories with about 80MiB of retained strings must not trigger a reparse');
});

test('selected rollout stat fallback detects changes when native watch has no event', async t => {
  await listCliThreads();
  const originalStat = fs.stat;
  let changed = false;
  let baselineRead;
  const baseline = new Promise(resolve => { baselineRead = resolve; });
  const sampledRollouts = new Set();
  t.mock.method(fs, 'stat', async (...args) => {
    const stat = await originalStat(...args);
    if (String(args[0]).endsWith('.jsonl') && String(args[0]).includes('rollout-')) sampledRollouts.add(args[0]);
    if (args[0] === file) {
      baselineRead();
      if (changed) return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ctimeMs: stat.ctimeMs + 1, size: stat.size + 1 });
    }
    return stat;
  });
  let stop;
  let timeout;
  try {
    const observed = new Promise((resolve, reject) => {
      stop = watchCliSessions(candidate => { if (candidate === file && changed) resolve(candidate); }, { getObservedThreadIds: () => [id] });
      timeout = setTimeout(() => reject(new Error('selected-file stat fallback timed out')), 1000);
    });
    await baseline;
    changed = true;
    assert.equal(await observed, file);
    assert.deepEqual([...sampledRollouts], [file], 'the fast fallback must only stat selected rollouts');
  } finally { clearTimeout(timeout); stop?.(); }
});

test('watching follows new subdirectories and a replaced sessions directory, with absolute paths', async () => {
  const sessions = process.env.CODEX_SESSIONS_DIR;
  const backup = sessions + '.backup';
  let wanted;
  let resolveChange;
  const stop = watchCliSessions(candidate => { if (candidate === wanted) resolveChange?.(candidate); });
  async function observe(candidate, operation) {
    wanted = candidate;
    let timeout;
    try {
      const changed = new Promise((resolve, reject) => {
        resolveChange = resolve;
        timeout = setTimeout(() => reject(new Error('new history path was not watched')), 1500);
      });
      await operation();
      assert.equal(await changed, candidate);
    } finally { clearTimeout(timeout); resolveChange = null; }
  }
  try {
    const nested = path.join(sessions, '2026/10/04', `rollout-2026-10-04T00-00-00-${id}.jsonl`);
    await observe(nested, async () => {
      await fs.mkdir(path.dirname(nested), { recursive: true });
      await fs.writeFile(nested, line('session_meta', { id }));
    });
    await fs.rename(sessions, backup);
    await fs.mkdir(sessions);
    const newFile = path.join(sessions, `rollout-2026-10-04T01-00-00-${id}.jsonl`);
    await observe(newFile, () => fs.writeFile(newFile, line('session_meta', { id })));
    assert.equal((await listCliThreads())[0].path, newFile);
  } finally {
    stop();
    if (await fs.stat(backup).catch(() => null)) {
      await fs.rm(sessions, { recursive: true, force: true });
      await fs.rename(backup, sessions);
    }
  }
});

test('an idle homepage discovers new histories without native watch events or selected threads', async t => {
  const now = new Date();
  const directory = path.join(process.env.CODEX_SESSIONS_DIR,
    String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0'));
  await fs.mkdir(directory, { recursive: true });
  await listCliThreads();
  const newID = '10000000-0000-4000-8000-000000000009';
  const target = path.join(directory, `rollout-2026-10-03T06-00-00-${newID}.jsonl`);
  const originalStat = fs.stat;
  let baselineRead;
  const baseline = new Promise(resolve => { baselineRead = resolve; });
  const stattedRollouts = new Set();
  t.mock.method(fs, 'stat', async (...args) => {
    const stat = await originalStat(...args);
    if (String(args[0]).includes('rollout-')) stattedRollouts.add(args[0]);
    if (args[0] === directory) baselineRead();
    return stat;
  });
  t.mock.method(syncFs, 'watch', () => {
    const watcher = new EventEmitter();
    watcher.close = () => {};
    return watcher;
  });
  syncBuiltinESMExports();
  let stop;
  let timeout;
  try {
    const changed = new Promise((resolve, reject) => {
      stop = watchCliSessions(candidate => { if (candidate === directory) resolve(); }, { getObservedThreadIds: () => [] });
      timeout = setTimeout(() => reject(new Error('idle homepage directory fallback timed out')), 1000);
    });
    await baseline;
    await fs.writeFile(target, line('session_meta', { id: newID }) +
      line('event_msg', { type: 'user_message', message: 'new homepage conversation' }));
    await changed;
    assert.deepEqual([...stattedRollouts], [], 'homepage discovery must only poll directories and metadata');
    assert.ok((await listCliThreads()).some(thread => thread.id === newID), 'directory changes must invalidate the discovery cache');
  } finally {
    clearTimeout(timeout);
    stop?.();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
