import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentExecutionColumns, agentExecutions, agentToolCalls, createDb, initializeDatabase, type Database } from '@worklite/db';
import { AgentExecutionsService } from './agent-executions.service';
import type { ChatProjectTasksService } from './chat-project-tasks.service';
import type { HostNotificationsService } from '../notifications/host-notifications.service';

const gateway = vi.hoisted(() => ({ generateAgentStep: vi.fn(), streamText: vi.fn() }));
vi.mock('@worklite/model-gateway', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@worklite/model-gateway')>()),
  createModelGateway: () => ({ generateAgentStep: gateway.generateAgentStep, streamText: gateway.streamText }),
}));

const WORKSPACE_ID = 'workspace_personal';
const CHAT_AGENT_ID = 'agt_system_helper_chat';
const dbs: Database[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.$client.close();
  gateway.generateAgentStep.mockReset();
});

async function setup() {
  const db = createDb(':memory:');
  dbs.push(db);
  await initializeDatabase(db);
  db.insert(agentExecutions).values({
    id: 'aex_rewind', workspaceId: WORKSPACE_ID, agentId: CHAT_AGENT_ID, status: 'completed', phase: 'model',
    capabilitySnapshot: { agent: { id: CHAT_AGENT_ID, providerId: 'provider', model: 'model', systemPrompt: 'You are Chat.' }, skills: [] } as never,
    modelMessages: [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: [{ type: 'text', text: 'First answer' }] },
      { role: 'user', content: 'Second question' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'run_host_command', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'run_host_command', output: { type: 'text', value: 'ok' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Second answer' }] },
    ] as never,
    displayMessages: [
      { id: 'msg_1', role: 'user', content: 'First question', createdAt: '2024-01-01T00:00:00.000Z' },
      { id: 'msg_2', role: 'assistant', content: 'First answer', createdAt: '2024-01-01T00:00:01.000Z' },
      { id: 'msg_3', role: 'user', content: 'Second question', createdAt: '2024-01-01T00:00:02.000Z' },
      { id: 'msg_4', role: 'assistant', content: 'Second answer', createdAt: '2024-01-01T00:00:03.000Z' },
    ] as never,
  }).run();
  db.insert(agentToolCalls).values({
    id: 'acall_tc1', executionId: 'aex_rewind', workspaceId: WORKSPACE_ID, agentId: CHAT_AGENT_ID, toolCallId: 'tc1',
    toolName: 'builtin', mcpToolName: 'run_host_command', workingDirectory: '/tmp', status: 'completed', resultAppended: true,
  }).run();
  const workspaces = { getWorkspace: async () => ({ id: WORKSPACE_ID, slug: 'personal' }) };
  const resources = { providerRuntime: async () => ({ provider: { id: 'provider', adapter: 'openai', apiKey: 'key' }, model: 'model', protocol: 'openai/responses' }) };
  const projectTasks = { subscriptionsFor: () => [], list: () => [], activeForExecution: () => [] } as unknown as ChatProjectTasksService;
  const attachments = { describe: () => undefined, load: () => undefined };
  const hostNotifications = { notify: () => {} } as unknown as HostNotificationsService;
  const mcpRuntime = { discover: async () => [] };
  const unused = {} as never;
  const service = new AgentExecutionsService(db, workspaces as never, resources as never, unused, mcpRuntime as never, unused, unused, unused, projectTasks, attachments as never, unused, hostNotifications, unused);
  return { db, service };
}

describe('AgentExecutionsService.rewind', () => {
  it('edits a user message, discards everything after it, and reruns the turn', async () => {
    const { db, service } = await setup();
    gateway.generateAgentStep.mockResolvedValueOnce({ text: 'New answer.', responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'New answer.' }] }], toolCalls: [], finishReason: 'stop', contextDropped: 0 });
    const view = await service.rewind({} as never, 'personal', CHAT_AGENT_ID, 'aex_rewind', { messageId: 'msg_3', message: 'Edited second question' });
    expect(view.messages.map((message) => message.content)).toEqual(['First question', 'First answer', 'Edited second question']);
    await vi.waitFor(() => expect(db.select(agentExecutionColumns).from(agentExecutions).get()?.status).toBe('completed'));
    const settled = db.select(agentExecutionColumns).from(agentExecutions).get()!;
    expect(settled.modelMessages).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: [{ type: 'text', text: 'First answer' }] },
      { role: 'user', content: 'Edited second question' },
      { role: 'assistant', content: [{ type: 'text', text: 'New answer.' }] },
    ]);
    expect(settled.displayMessages.map((message) => message.content)).toEqual(['First question', 'First answer', 'Edited second question', 'New answer.']);
    // The discarded tool call row stays as inert evidence, not deleted.
    expect(db.select().from(agentToolCalls).all()).toHaveLength(1);
  });

  it('regenerates the reply after a user message without changing its text', async () => {
    const { db, service } = await setup();
    gateway.generateAgentStep.mockResolvedValueOnce({ text: 'Regenerated answer.', responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'Regenerated answer.' }] }], toolCalls: [], finishReason: 'stop', contextDropped: 0 });
    await service.rewind({} as never, 'personal', CHAT_AGENT_ID, 'aex_rewind', { messageId: 'msg_4' });
    await vi.waitFor(() => expect(db.select(agentExecutionColumns).from(agentExecutions).get()?.status).toBe('completed'));
    const settled = db.select(agentExecutionColumns).from(agentExecutions).get()!;
    expect(settled.modelMessages.at(-2)).toEqual({ role: 'user', content: 'Second question' });
    expect(settled.modelMessages.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Regenerated answer.' }] });
    expect(settled.displayMessages.map((message) => message.content)).toEqual(['First question', 'First answer', 'Second question', 'Regenerated answer.']);
  });

  it('rejects editing while the conversation has an unresolved project task', async () => {
    const { service } = await setup();
    await expect((async () => {
      const original = (service as unknown as { projectTasks: { activeForExecution(): unknown[] } }).projectTasks;
      original.activeForExecution = () => [{ id: 'task' }];
      return service.rewind({} as never, 'personal', CHAT_AGENT_ID, 'aex_rewind', { messageId: 'msg_1', message: 'x' });
    })()).rejects.toThrow('project task still in progress');
  });

  it('rejects an unknown messageId', async () => {
    const { service } = await setup();
    await expect(service.rewind({} as never, 'personal', CHAT_AGENT_ID, 'aex_rewind', { messageId: 'msg_missing', message: 'x' })).rejects.toThrow('no longer part of the conversation');
  });
});
