// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, initializeDatabase, type Database } from './client';
import { agentExecutionColumns } from './stored-arrays';
import { migrateNativeChat } from './migrate-native-chat';
import { agents, chatConfigurations, agentExecutions, agentExecutionEvents, agentToolCalls, agentRuntimeSessions, agentRuntimeRuns, agentRuntimeInteractions } from './schema';

let db: Database;
afterEach(() => db?.$client.close());
const workspaceId = 'workspace_personal';
const chat = 'agt_system_helper_chat';

describe('native Chat migration', () => {
  it.each(['claude', 'codex'] as const)('retires %s Chat callbacks and preserves history and independent Agents across restarts', async (kind) => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    const runtime = { kind, projectDirectory: '/tmp' };
    db.update(agents).set({ runtime, providerId: 'saved-provider', model: 'saved-model' }).where(eq(agents.id, chat)).run();
    db.update(chatConfigurations).set({ runtime, skillIds: ['saved-skill'] }).run();
    db.insert(agents).values({ id: 'worker', workspaceId, name: 'Worker', responsibility: '', model: '', runtime }).run();
    const snapshot = { revision: 1, agent: { id: chat, providerId: 'saved-provider', model: 'saved-model', systemPrompt: 'Preserved prompt '.repeat(2000), runtime }, skills: [], mcpServers: [] };
    const modelMessages = [{ role: 'user' as const, content: 'Original request' }];
    const displayMessages = [{ id: 'msg', role: 'user' as const, content: 'Original request', createdAt: new Date().toISOString() }];
    db.insert(agentExecutions).values({ id: 'chat-history', workspaceId, agentId: chat, status: 'waiting_for_input', capabilitySnapshot: snapshot, modelMessages, displayMessages,
      pendingQuestion: { id: 'interaction', runtimeInteractionId: 'interaction', question: 'Which?', options: [], createdAt: new Date().toISOString() } }).run();
    db.insert(agentExecutions).values({ id: 'agent-history', workspaceId, agentId: 'worker', status: 'completed', capabilitySnapshot: { ...snapshot, agent: { ...snapshot.agent, id: 'worker' } } }).run();
    for (const id of ['chat-history', 'agent-history']) {
      db.insert(agentRuntimeSessions).values({ id, workspaceId, runtime: kind, externalSessionId: 'saved-thread', resourceDirectory: '/tmp', launch: kind === 'codex' ? { executor: kind, model: null, commandArguments: [] } : { executor: kind, model: null, commandArguments: [], baseUrl: 'http://localhost' }, status: 'idle' }).run();
    }
    db.insert(agentRuntimeRuns).values({ id: 'run', sessionId: 'chat-history', status: 'waiting_for_input' }).run();
    db.insert(agentRuntimeInteractions).values({ id: 'interaction', runId: 'run', question: 'Which?', status: 'pending' }).run();
    db.insert(agentToolCalls).values({ id: 'pending-tool', executionId: 'chat-history', workspaceId, agentId: chat, toolCallId: 'pending-tool', toolName: 'builtin', mcpToolName: 'run_host_command', workingDirectory: '/tmp', status: 'running' }).run();
    db.insert(agentExecutionEvents).values({ executionId: 'chat-history', sequence: 1, kind: 'message_delta', data: { kind: 'message_delta', messageId: 'partial', delta: 'Partial reply' } }).run();

    await initializeDatabase(db);
    const migrated = db.select().from(agentExecutions).where(eq(agentExecutions.id, 'chat-history')).get()!;
    expect(migrated).toMatchObject({ status: 'failed', pendingQuestion: null, capabilitySnapshot: { agent: { runtime: { kind: 'native' }, systemPrompt: snapshot.agent.systemPrompt } } });
    expect(db.select(agentExecutionColumns).from(agentExecutions).where(eq(agentExecutions.id, 'chat-history')).get()).toMatchObject({ modelMessages, displayMessages });
    expect(db.select().from(agentExecutionEvents).get()?.data).toMatchObject({ delta: 'Partial reply' });
    expect(db.select().from(agentToolCalls).get()).toMatchObject({ status: 'failed', resultAppended: true, output: expect.stringContaining('unknown') });
    expect(db.select().from(agentRuntimeInteractions).get()?.status).toBe('interrupted');
    expect(db.select().from(agentRuntimeRuns).get()?.status).toBe('interrupted');
    expect(db.select().from(agentRuntimeSessions).where(eq(agentRuntimeSessions.id, 'chat-history')).get()).toMatchObject({ status: 'closed', externalSessionId: 'saved-thread' });
    expect(db.select().from(agentRuntimeSessions).where(eq(agentRuntimeSessions.id, 'agent-history')).get()?.status).toBe('idle');
    expect(db.select().from(agents).where(eq(agents.id, 'worker')).get()?.runtime).toEqual(runtime);
    expect(db.select().from(agentExecutions).where(eq(agentExecutions.id, 'agent-history')).get()?.capabilitySnapshot?.agent.runtime).toEqual(runtime);
    expect(db.select().from(agents).where(eq(agents.id, chat)).get()).toMatchObject({ runtime: { kind: 'native' }, providerId: 'saved-provider', model: 'saved-model' });
    expect(db.select().from(chatConfigurations).get()).toMatchObject({ runtime: { kind: 'native' }, skillIds: ['saved-skill'] });
    migrateNativeChat(db.$client);
    expect(db.select().from(agentExecutions).where(eq(agentExecutions.id, 'chat-history')).get()).toEqual(migrated);
  });
});
