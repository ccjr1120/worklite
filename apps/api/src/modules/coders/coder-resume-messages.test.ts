import { describe, expect, it } from 'vitest';
import { createDb, initializeDatabase } from '@worklite/db';

describe('resumed Coder messages', () => {
  it('allows repeated questions followed by one completion for the same attempt', async () => {
    const db = createDb(':memory:');
    try {
      await initializeDatabase(db);
      db.$client.pragma('foreign_keys = OFF');
      const insert = db.$client.prepare('INSERT INTO coder_group_messages (id, workspace_id, group_id, sequence, sender, kind, body, task_attempt_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      insert.run('q1', 'workspace_personal', 'g', 1, 'role', 'question', 'First question', 'attempt');
      insert.run('q2', 'workspace_personal', 'g', 2, 'role', 'question', 'Second question', 'attempt');
      insert.run('done', 'workspace_personal', 'g', 3, 'role', 'result', 'Completed', 'attempt');
      expect(() => insert.run('duplicate', 'workspace_personal', 'g', 4, 'role', 'text', 'Duplicate', 'attempt')).toThrow(/UNIQUE/);
      expect(db.$client.prepare('SELECT count(*) AS count FROM coder_group_messages WHERE task_attempt_id = ?').get('attempt')).toEqual({ count: 3 });
    } finally {
      db.$client.close();
    }
  });
});
