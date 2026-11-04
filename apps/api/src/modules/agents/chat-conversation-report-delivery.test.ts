import { afterEach, describe, expect, it } from 'vitest';
import { createDb, initializeDatabase, agentExecutions, agentToolCalls, chatProjectTasks, chatSubmissions, externalChats, type Database } from '@worklite/db';
import type { ChatProgressReport } from '@worklite/contracts';
import { AgentExecutionsService } from './agent-executions.service';
import type { ChatProjectTasksService } from './chat-project-tasks.service';
import type { HostNotificationsService } from '../notifications/host-notifications.service';

// Exercises the gap where a background report (project task settlement, periodic active-work
// progress) appended its reply only to the execution's own message history: the WeChat/Feishu
// delivery sweep only redelivers chatSubmissions rows with settled=false, and nothing reopened
// that window for a 'conversation'-kind submission outside of a brand-new user message. These
// tests assert that reportProjectTaskSettled (private, invoked through its public entry points)
// and reportActiveWorkProgress now leave a fresh settled=false row a channel adapter can pick up.
const WORKSPACE_ID = 'workspace_personal';
const CHAT_AGENT_ID = 'agt_system_helper_chat';

const dbs: Database[] = [];

async function setup() {
  const db = createDb(':memory:');
  dbs.push(db);
  await initializeDatabase(db);
  // Minimal stand-ins: the code paths under test never call these collaborators.
  const unused = {} as never;
  const projectTasks = { subscriptionsFor: () => [], list: () => [] } as unknown as ChatProjectTasksService;
  // schedule() fires the model turn in the background (fire-and-forget); these tests only assert
  // on the synchronous settlement-transaction side effect, so a rejecting getWorkspace is fine as
  // long as it is observed (avoids an unhandled-rejection warning from the untested background path).
  const workspaces = { getWorkspace: async () => { throw new Error('not exercised by this test'); } };
  // A stub sender keeps these tests from posting real host notifications when a snapshot publishes.
  const hostNotifications = { notify: () => {} } as unknown as HostNotificationsService;
  const service = new AgentExecutionsService(db, workspaces as never, unused, unused, unused, unused, unused, unused, unused, projectTasks, unused, unused, hostNotifications, unused);
  return { db, service };
}

function insertExecution(db: Database, id: string, status: 'running' | 'completed' | 'failed' | 'cancelled' = 'completed') {
  db.insert(agentExecutions).values({ id, workspaceId: WORKSPACE_ID, agentId: CHAT_AGENT_ID, status }).run();
}

function bindWechatChat(db: Database, chatId: string, executionId: string) {
  db.insert(externalChats).values({ id: chatId, workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: 'user-a', userId: 'user-a', executionId }).run();
}

function insertProjectTask(db: Database, taskId: string, executionId: string, status: 'succeeded' | 'failed' | 'waiting_for_input') {
  db.insert(agentToolCalls).values({
    id: taskId, executionId, workspaceId: WORKSPACE_ID, agentId: CHAT_AGENT_ID, toolCallId: `tc_${taskId}`,
    toolName: 'builtin', workingDirectory: '/tmp/project', mcpToolName: 'project_task',
  }).run();
  db.insert(chatProjectTasks).values({
    id: taskId, workspaceId: WORKSPACE_ID, executionId, goal: '修复进度提醒', projectDirectory: '/tmp/project', model: '',
    snapshot: {} as never, status, activities: [],
  }).run();
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.$client.close();
});

describe('AgentExecutionsService project task settlement opens a conversation delivery window', () => {
  it('leaves a settled=false conversation submission a channel adapter can redeliver', async () => {
    const { db, service } = await setup();
    insertExecution(db, 'aex_1', 'completed');
    bindWechatChat(db, 'wechat:user-a', 'aex_1');
    insertProjectTask(db, 'acall_1', 'aex_1', 'succeeded');

    await (service as unknown as { reportProjectTaskSettled(workspaceId: string, executionId: string, taskId: string): Promise<void> })
      .reportProjectTaskSettled(WORKSPACE_ID, 'aex_1', 'acall_1');

    const rows = db.select().from(chatSubmissions).all() as Array<{ chatId: string | null; executionId: string | null; settled: boolean; reference: { kind: string } | null }>;
    const opened = rows.filter((row) => row.executionId === 'aex_1' && row.reference?.kind === 'conversation');
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every((row) => row.settled === false)).toBe(true);
    expect(opened.some((row) => row.chatId === 'wechat:user-a')).toBe(true);
  });

  it('does nothing when the conversation has no bound external chat', async () => {
    const { db, service } = await setup();
    insertExecution(db, 'aex_2', 'completed');
    insertProjectTask(db, 'acall_2', 'aex_2', 'succeeded');

    await (service as unknown as { reportProjectTaskSettled(workspaceId: string, executionId: string, taskId: string): Promise<void> })
      .reportProjectTaskSettled(WORKSPACE_ID, 'aex_2', 'acall_2');

    const rows = db.select().from(chatSubmissions).all();
    expect(rows).toHaveLength(0);
  });
});

describe('AgentExecutionsService.reportActiveWorkProgress opens a conversation delivery window', () => {
  it('leaves a settled=false conversation submission a channel adapter can redeliver', async () => {
    const { db, service } = await setup();
    insertExecution(db, 'aex_3', 'completed');
    bindWechatChat(db, 'wechat:user-b', 'aex_3');
    const report: ChatProgressReport = { items: [{ kind: 'task', id: 'acall_3', title: '进度', status: 'running' }] };

    const result = await service.reportActiveWorkProgress(WORKSPACE_ID, 'aex_3', '[活跃工作进展提醒] ...', report);

    expect(result).toBe('reported');
    const rows = db.select().from(chatSubmissions).all() as Array<{ chatId: string | null; executionId: string | null; settled: boolean; reference: { kind: string } | null }>;
    const opened = rows.filter((row) => row.executionId === 'aex_3' && row.reference?.kind === 'conversation');
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every((row) => row.settled === false)).toBe(true);
    expect(opened.some((row) => row.chatId === 'wechat:user-b')).toBe(true);
  });

  it('reports busy without opening a window while the execution is already running', async () => {
    const { db, service } = await setup();
    insertExecution(db, 'aex_4', 'running');
    bindWechatChat(db, 'wechat:user-c', 'aex_4');
    const report: ChatProgressReport = { items: [{ kind: 'task', id: 'acall_4', title: '进度', status: 'running' }] };

    const result = await service.reportActiveWorkProgress(WORKSPACE_ID, 'aex_4', '[活跃工作进展提醒] ...', report);

    expect(result).toBe('busy');
    const rows = db.select().from(chatSubmissions).all();
    expect(rows).toHaveLength(0);
  });
});
