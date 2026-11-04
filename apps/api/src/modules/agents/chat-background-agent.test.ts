import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentExecutions, agents, agentToolCalls, auditLogs, workspaces, createDb, initializeDatabase, type Database } from '@worklite/db';
import { CHAT_AGENT_ID } from '@worklite/contracts';
import type { AgentCollaborationService } from './agent-collaboration.service';
import { AgentExecutionsService } from './agent-executions.service';

const gateway = vi.hoisted(() => ({ generateAgentStep: vi.fn() }));
vi.mock('@worklite/model-gateway', async (original) => ({ ...await original<typeof import('@worklite/model-gateway')>(), createModelGateway: () => gateway }));
let db: Database;
let service: AgentExecutionsService;
afterEach(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); db?.$client.close(); vi.restoreAllMocks(); gateway.generateAgentStep.mockReset(); });

async function setup() {
  db = createDb(':memory:'); await initializeDatabase(db);
  db.insert(agents).values({ id: 'lead', workspaceId: 'workspace_personal', name: 'qcoder', kind: 'custom', responsibility: 'Investigate', systemPrompt: 'Investigate', model: 'provider/model', collaboration: { subAgentIds: [], capabilities: [], publicModels: ['provider/model'] } }).run();
  db.insert(agentExecutions).values({ id: 'chat', workspaceId: 'workspace_personal', agentId: CHAT_AGENT_ID, status: 'running', phase: 'skill', capabilitySnapshot: { agent: { id: CHAT_AGENT_ID, providerId: 'provider', model: 'model', systemPrompt: 'Chat' }, skills: [] } as never, modelMessages: [{ role: 'user', content: 'Do the task' }, { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'model-call', toolName: 'run_agent', input: { agentId: 'lead', task: 'Investigate' } }] }] }).run();
  db.insert(agentToolCalls).values({ id: 'dispatch', executionId: 'chat', workspaceId: 'workspace_personal', agentId: CHAT_AGENT_ID, toolCallId: 'model-call', toolName: 'builtin', mcpToolName: 'run_agent', workingDirectory: '', input: { agentId: 'lead', task: 'Investigate' }, status: 'running' }).run();
  let finish!: (value: string) => void;
  let fail!: (error: Error) => void;
  const work = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  const collaboration = { list: () => [{ id: 'lead', name: 'qcoder' }], run: vi.fn<AgentCollaborationService['run']>(() => work) };
  const resources = { reconcileWorkspaceSkills: async () => {}, providerRuntime: async () => ({ provider: { id: 'provider', adapter: 'openai', apiKey: 'key' }, model: 'model', protocol: 'openai/responses' }) };
  const unused = {} as never;
  service = new AgentExecutionsService(db, { getWorkspace: async () => ({ id: 'workspace_personal' }) } as never, resources as never, unused, { discover: async () => [] } as never, unused, unused, unused, unused, { list: () => [], subscriptionsFor: () => [], activeForExecution: () => [] } as never, { describe: () => undefined, load: () => undefined } as never, unused, { notify: () => {} } as never, unused, collaboration as never);
  gateway.generateAgentStep.mockResolvedValue({ text: 'Accepted.', responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'Accepted.' }] }], toolCalls: [], finishReason: 'stop', contextDropped: 0 });
  const internal = service as unknown as {
    executeToolCall(request: unknown, slug: string, workspace: string, agent: string, execution: string, call: string): Promise<void>;
    reportBackgroundAgent(binding: string): Promise<void>;
  };
  return { internal, collaboration, finish, fail };
}

describe('background Agent dispatch from Chat', () => {
  async function savedInstance(status: 'failed' | 'completed' | 'cancelled' | 'running' = 'failed') {
    const context = await setup();
    vi.spyOn(service, 'schedule').mockImplementation(() => {});
    db.insert(agentExecutions).values({ id: 'saved', workspaceId: 'workspace_personal', agentId: 'lead', status, modelMessages: [{ role: 'user', content: 'Original article' }, { role: 'assistant', content: [{ type: 'text', text: 'Research complete' }] }], displayMessages: [{ id: 'original', role: 'user', content: 'Original article', createdAt: new Date().toISOString() }] }).run();
    db.insert(agentToolCalls).values({ id: 'research', executionId: 'saved', workspaceId: 'workspace_personal', agentId: 'lead', toolCallId: 'research', toolName: 'builtin', mcpToolName: 'run_sub_agent', workingDirectory: '', status: 'completed', resultAppended: true, output: '{"resultRef":"saved-research"}' }).run();
    db.insert(auditLogs).values({ id: 'saved-binding', workspaceId: 'workspace_personal', action: 'chat_agent.dispatched', resource: 'saved', metadata: { conversationId: 'chat', invocationId: 'air_saved', reportedStatus: status, reportedKey: status } }).run();
    db.update(agentToolCalls).set({ input: { agentId: 'lead', task: 'Continue writing', executionId: 'saved' } }).where(eq(agentToolCalls.id, 'dispatch')).run();
    return context;
  }

  it.each(['failed', 'completed', 'cancelled'] as const)('wakes the same %s instance and retains its history and saved tools', async (status) => {
    const { internal } = await savedInstance(status);
    await internal.executeToolCall({}, 'personal', 'workspace_personal', CHAT_AGENT_ID, 'chat', 'dispatch');
    expect(db.select().from(agentExecutions).all()).toHaveLength(2);
    const saved = db.select().from(agentExecutions).where(eq(agentExecutions.id, 'saved')).get()!;
    expect(saved.status).toBe('running');
    expect(saved.modelMessages[0]).toEqual({ role: 'user', content: 'Original article' });
    expect(saved.modelMessages.at(-2)).toMatchObject({ content: expect.stringContaining('saved-research') });
    expect(saved.modelMessages.at(-1)).toEqual({ role: 'user', content: 'Continue writing' });
    const call = db.select().from(agentToolCalls).where(eq(agentToolCalls.id, 'dispatch')).get()!;
    expect(JSON.parse(call.output)).toMatchObject({ executionId: 'saved', runId: 'air_saved', continued: true });
    expect(db.select().from(auditLogs).where(eq(auditLogs.id, 'saved-binding')).get()!.metadata).not.toHaveProperty('reportedKey');
  });

  it('honors an instance-bound @mention even when the model omits executionId', async () => {
    const { internal } = await savedInstance();
    db.update(agentExecutions).set({ displayMessages: [{ id: 'mention', role: 'user', content: '[@qcoder](/agents/lead?runId=air_saved&executionId=saved) Continue writing', createdAt: new Date().toISOString() }] }).where(eq(agentExecutions.id, 'chat')).run();
    db.update(agentToolCalls).set({ input: { agentId: 'lead', task: 'Continue writing' } }).where(eq(agentToolCalls.id, 'dispatch')).run();
    await internal.executeToolCall({}, 'personal', 'workspace_personal', CHAT_AGENT_ID, 'chat', 'dispatch');
    expect(db.select().from(agentExecutions).all()).toHaveLength(2);
    expect(JSON.parse(db.select().from(agentToolCalls).where(eq(agentToolCalls.id, 'dispatch')).get()!.output)).toMatchObject({ continued: true, executionId: 'saved' });
  });

  it.each(['running', 'wrong-agent', 'wrong-workspace', 'missing'] as const)('rejects a %s instance without starting a replacement', async (scenario) => {
    const { internal } = await savedInstance(scenario === 'running' ? 'running' : 'failed');
    if (scenario === 'wrong-agent') db.update(agentToolCalls).set({ input: { agentId: 'lead', task: 'Continue', executionId: 'chat' } }).where(eq(agentToolCalls.id, 'dispatch')).run();
    if (scenario === 'wrong-workspace') { db.insert(workspaces).values({ id: 'workspace_foreign', slug: 'foreign', name: 'Foreign' }).run(); db.update(agentExecutions).set({ workspaceId: 'workspace_foreign' }).where(eq(agentExecutions.id, 'saved')).run(); }
    if (scenario === 'missing') db.update(agentToolCalls).set({ input: { agentId: 'lead', task: 'Continue', executionId: 'absent' } }).where(eq(agentToolCalls.id, 'dispatch')).run();
    await internal.executeToolCall({}, 'personal', 'workspace_personal', CHAT_AGENT_ID, 'chat', 'dispatch');
    expect(db.select().from(agentExecutions).all()).toHaveLength(2);
    expect(db.select().from(agentToolCalls).where(eq(agentToolCalls.id, 'dispatch')).get()!.status).toBe('failed');
  });

  it('reports a failed Agent separately from its successful launch receipt', async () => {
    const { internal, fail } = await setup();
    await internal.executeToolCall({}, 'personal', 'workspace_personal', CHAT_AGENT_ID, 'chat', 'dispatch');
    const schedule = vi.spyOn(service, 'schedule').mockImplementation(() => {});
    const background = db.select().from(agentExecutions).all().find((row) => row.agentId === 'lead')!;
    fail(new Error('Research failed'));
    await vi.waitFor(() => expect(db.select().from(agentExecutions).where(eq(agentExecutions.id, background.id)).get()?.status).toBe('failed'));
    const binding = db.select().from(auditLogs).where(eq(auditLogs.action, 'chat_agent.dispatched')).get()!;
    await internal.reportBackgroundAgent(binding.id);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(db.select().from(agentToolCalls).where(eq(agentToolCalls.id, 'dispatch')).get()?.status).toBe('completed');
    expect(db.select().from(agentExecutions).where(eq(agentExecutions.id, 'chat')).get()?.modelMessages.at(-1)).toMatchObject({ content: expect.stringContaining('failed') });
  });

  it('releases Chat before the Agent finishes, keeps execution independent, and reports once', async () => {
    const { internal, collaboration, finish } = await setup();
    await internal.executeToolCall({}, 'personal', 'workspace_personal', CHAT_AGENT_ID, 'chat', 'dispatch');
    expect(collaboration.run).toHaveBeenCalledTimes(1);
    const background = db.select().from(agentExecutions).all().find((row) => row.agentId === 'lead')!;
    expect(background.status).toBe('running');
    expect(db.select().from(agentExecutions).where(eq(agentExecutions.id, 'chat')).get()?.status).toBe('completed');
    const call = db.select().from(agentToolCalls).where(eq(agentToolCalls.id, 'dispatch')).get()!;
    expect(call).toMatchObject({ status: 'completed', resultAppended: true });
    expect(JSON.parse(call.output)).toMatchObject({ background: true, status: 'running', executionId: background.id });
    expect(collaboration.run.mock.calls[0]?.[8]).toBe(JSON.parse(call.output).runId);
    db.update(agentExecutions).set({ status: 'running' }).where(eq(agentExecutions.id, 'chat')).run();
    await service.cancel({} as never, 'personal', CHAT_AGENT_ID, 'chat');
    expect(collaboration.run.mock.calls[0]?.[4].aborted).toBe(false);
    const binding = db.select().from(auditLogs).where(eq(auditLogs.action, 'chat_agent.dispatched')).get()!;
    // A result that arrives during another Chat turn stays pending until that turn settles.
    db.update(agentExecutions).set({ status: 'running' }).where(eq(agentExecutions.id, 'chat')).run();
    finish('Investigation complete');
    await vi.waitFor(() => expect(db.select().from(agentExecutions).where(eq(agentExecutions.id, background.id)).get()?.status).toBe('completed'));
    await internal.reportBackgroundAgent(binding.id);
    expect(db.select().from(auditLogs).where(eq(auditLogs.id, binding.id)).get()?.metadata).not.toHaveProperty('reportedStatus');
    db.update(agentExecutions).set({ status: 'completed' }).where(eq(agentExecutions.id, 'chat')).run();
    const schedule = vi.spyOn(service, 'schedule').mockImplementation(() => {});
    await internal.reportBackgroundAgent(binding.id);
    await internal.reportBackgroundAgent(binding.id);
    expect(schedule).toHaveBeenCalledTimes(1);
    const chat = db.select().from(agentExecutions).where(eq(agentExecutions.id, 'chat')).get()!;
    expect(chat.modelMessages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('Investigation complete') });
    expect(db.select().from(auditLogs).where(eq(auditLogs.id, binding.id)).get()?.metadata).toHaveProperty('reportedStatus', 'completed');
  });
});
