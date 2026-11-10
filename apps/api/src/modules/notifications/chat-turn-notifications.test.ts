// @vitest-environment node
import { Logger } from '@nestjs/common';
import { createDb, type Database } from '@worklite/db';
import { CHAT_AGENT_ID, type AgentExecutionView } from '@worklite/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentExecutionsService } from '../agents/agent-executions.service';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.$client.close(); });

function fixture(enabled = true) {
  const db = createDb(':memory:');
  databases.push(db);
  db.$client.exec('CREATE TABLE chat_bot_configurations (workspace_id text, revision integer, turn_notifications_enabled integer, turn_notification_sound text)');
  db.$client.prepare('INSERT INTO chat_bot_configurations VALUES (?, ?, ?, ?)').run('workspace', 100, enabled ? 1 : 0, 'Glass');
  const notify = vi.fn();
  // Isolate the real terminal-state hook; no model, file-store or live task is started.
  const service = Object.assign(Object.create(AgentExecutionsService.prototype), {
    db, hostNotifications: { notify }, notifiedTurnStates: new Map(), logger: new Logger('notification-test'),
  }) as { notifyChatTurnSettled(workspace: string, view: AgentExecutionView): void };
  const view = { id: 'chat', agentId: CHAT_AGENT_ID, status: 'completed', messages: [{ id: 'a', role: 'assistant', content: '处理完成', createdAt: '' }], pendingQuestion: null } as AgentExecutionView;
  const publish = async (change: Partial<AgentExecutionView> = {}) => {
    service.notifyChatTurnSettled('workspace', { ...view, ...change });
    await new Promise((done) => setImmediate(done));
  };
  return { notify, publish };
}

describe('Chat terminal-state host notification hook', () => {
  it.each(['completed', 'failed', 'waiting_for_input'] as const)('notifies on %s with the saved sound setting', async (status) => {
    const { notify, publish } = fixture();
    await publish({ status });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'WorkLite', sound: 'Glass' }));
  });
  it('does not notify for a cancelled turn, another Agent, or periodic progress', async () => {
    const { notify, publish } = fixture();
    await publish({ status: 'cancelled' });
    await publish({ agentId: 'background-agent' });
    await publish({ messages: [{ id: 'p', role: 'assistant', content: '进展', createdAt: '', progressReport: { items: [] } }] });
    expect(notify).not.toHaveBeenCalled();
  });
  it('honors disabled configuration and deduplicates snapshots while allowing the next turn', async () => {
    const disabled = fixture(false);
    await disabled.publish();
    expect(disabled.notify).not.toHaveBeenCalled();
    const enabled = fixture();
    await enabled.publish();
    await enabled.publish();
    expect(enabled.notify).toHaveBeenCalledTimes(1);
    await enabled.publish({ status: 'running' });
    await enabled.publish();
    expect(enabled.notify).toHaveBeenCalledTimes(2);
  });
});
