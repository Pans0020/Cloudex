import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCliThread } from '../src/cli-sessions.js';

test('internal response IDs do not create phantom active turns', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudex-turn-'));
  const file = path.join(dir, 'rollout-2026-09-25-01a0d7e2-1b3c-7ea1-9c38-3913a8e36e26.jsonl');
  const records = [];
  const add = (type, payload) => records.push({ timestamp: new Date().toISOString(), type, payload });
  try {
    for (const id of ['first', 'second']) {
      add('event_msg', { type: 'task_started', turn_id: id });
      add('turn_context', { turn_id: id });
      add('response_item', { type: 'message', role: 'user',
        internal_chat_message_metadata_passthrough: { turn_id: id,
          content_item_kinds: ['agents_md.instructions', 'user.text', 'environments.environment_context'] },
        content: [{ type: 'input_text', text: 'Hidden instructions' },
          { type: 'input_text', text: `Hello ${id}` }, { type: 'input_text', text: 'Hidden environment' }] });
      // Older rollouts can contain both representations; show the input once.
      if (id === 'first') add('event_msg', { type: 'user_message', turn_id: id, message: `Hello ${id}` });
      add('response_item', { type: 'message', role: 'assistant', phase: 'final_answer',
        internal_chat_message_metadata_passthrough: { turn_id: `internal-${id}` },
        content: [{ type: 'output_text', text: 'OK' }] });
      await fs.writeFile(file, records.map(JSON.stringify).join('\n'));
      const active = await readCliThread(file);
      assert.equal(active.thread.status.type, 'active');
      assert.equal(active.turns.at(-1).id, id);
      add('event_msg', { type: 'task_complete', turn_id: id });
    }
    await fs.writeFile(file, records.map(JSON.stringify).join('\n'));
    const done = await readCliThread(file);
    assert.equal(done.thread.status.type, 'idle');
    assert.deepEqual(done.turns.map(t => [t.id, t.status]), [['first', 'completed'], ['second', 'completed']]);
    for (const turn of done.turns) {
      assert.equal(turn.items.length, 2);
      assert.equal(turn.items[0].type, 'userMessage');
      assert.equal(turn.items[0].content[0].text, `Hello ${turn.id}`);
      assert.equal(turn.items[1].text, 'OK');
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
