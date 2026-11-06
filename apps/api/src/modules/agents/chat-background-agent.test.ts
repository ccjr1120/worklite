import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentCapabilityResults, agentExecutions, agents, agentToolCalls, auditLogs, workspaces, createDb, initializeDatabase, type Database } from '@worklite/db';
import { CHAT_AGENT_ID, type AgentExecutionStatus } from '@worklite/contracts';
import type { AgentCollaborationService } from './agent-collaboration.service';
import { AgentExecutionsService } from './agent-executions.service';
import { ChatConversationsService } from './chat-conversations.service';

const gateway = vi.hoisted(() => ({ generateAgentStep: vi.fn() }));
vi.mock('@worklite/model-gateway', async (original) => ({ ...await original<typeof import('@worklite/model-gateway')>(), createModelGateway: () => gateway }));
let db: Database;
let service: AgentExecutionsService;
afterEach(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); db?.$client.close(); vi.restoreAllMocks(); gateway.generateAgentStep.mockReset(); });

async function setup() {
  db = createDb(':memory:'); await initializeDatabase(db);
  db.insert(agents).values({ id: 'lead', workspaceId: 'workspace_personal', name: 'qcoder', kind: 'custom', responsibility: 'Investigate', systemPrompt: 'Investigate', model: 'provider/model', collaboration: { subAgentIds: [], capabilities: [], publicModels: ['provider/model'] } }).run();
  db.insert(agentExecutions).values({ id: 'chat', workspaceId: 'workspace_personal', agentId: CHAT_AGENT_ID, status: 'running', phase: 'skill', capabilitySnapshot: { agent: { id: CHAT_AGENT_ID, providerId: 'provider', model: 'model', systemPrompt: 'Chat' }, skills: [] } as never, modelMessages: [{ role: 'user', content: 'Do the task' }, { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'model-call', toolName: 'run_agent', input: { agentId: 'lead', task: 'Investigate', mode: 'new' } }] }] }).run();
  db.insert(agentToolCalls).values({ id: 'dispatch', executionId: 'chat', workspaceId: 'workspace_personal', agentId: CHAT_AGENT_ID, toolCallId: 'model-call', toolName: 'builtin', mcpToolName: 'run_agent', workingDirectory: '', input: { agentId: 'lead', task: 'Investigate', mode: 'new' }, status: 'running' }).run();
  let finish!: (value: string) => void;
  let fail!: (error: Error) => void;
  const work = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  const collaboration = { list: () => [{ id: 'lead', name: 'qcoder' }], run: vi.fn<AgentCollaborationService['run']>(() => work) };
  const resources = { reconcileWorkspaceSkills: async () => {}, providerRuntime: async () => ({ provider: { id: 'provider', adapter: 'openai', apiKey: 'key' }, model: 'model', protocol: 'openai/responses' }) };
  const unused = {} as never;
  service = new AgentExecutionsService(db, { getWorkspace: async () => ({ id: 'workspace_personal' }) } as never, resources as never, unused, { discover: async () => [] } as never, unused, unused, unused, { list: () => [], subscriptionsFor: () => [], activeForExecution: () => [] } as never, { describe: () => undefined, load: () => undefined } as never, unused, { notify: () => {} } as never, unused, collaboration as never);
  gateway.generateAgentStep.mockResolvedValue({ text: 'Accepted.', responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'Accepted.' }] }], toolCalls: [], finishReason: 'stop', contextDropped: 0 });
  const internal = service as unknown as {
    executeToolCall(request: unknown, slug: string, workspace: string, agent: string, execution: string, call: string): Promise<void>;
    reportBackgroundAgent(binding: string): Promise<void>;
    scheduleBackgroundAgentReports(): void;
  };
  return { internal, collaboration, finish, fail };
}

describe('background Agent dispatch from Chat', () => {
  it.each([
    { projectDirectory: '', message: 'runtime.projectDirectory is required' },
    { projectDirectory: '/worklite-missing-project-directory', message: 'runtime.projectDirectory must be an existing directory' },
  ])('preserves the startup validation reason without accepting a launch: $projectDirectory', async ({ projectDirectory, message }) => {
    const { internal } = await setup();
    db.update(agents).set({ runtime: { kind: 'codex', projectDirectory } }).where(eq(agents.id, 'lead')).run();
    await internal.executeToolCall({}, 'personal', 'workspace_personal', CHAT_AGENT_ID, 'chat', 'dispatch');
    const call = db.select().from(agentToolCalls).where(eq(agentToolCalls.id, 'dispatch')).get()!;
    expect(call.status).toBe('failed');
    expect(JSON.parse(call.output)).toMatchObject({ failure: { stage: 'start', code: 'PLATFORM_START_FAILED', effect: 'not_started', evidence: { exceptionType: 'BadRequestException', message: expect.stringContaining(message) } } });
    expect(db.select().from(agentExecutions).all()).toHaveLength(1);
    expect(db.select().from(auditLogs).where(eq(auditLogs.action, 'chat_agent.dispatched')).all()).toEqual([]);
    expect(db.select().from(auditLogs).where(eq(auditLogs.action, 'platform.tool_failure')).get()!.metadata).toMatchObject({ failure: { evidence: { message: expect.stringContaining(message) } } });
  });

  it('uses the task directory when a Codex Agent has an empty saved default', async () => {
    const { internal } = await setup();
    vi.spyOn(service, 'schedule').mockImplementation(() => {});
    db.update(agents).set({ runtime: { kind: 'codex', projectDirectory: '' } }).where(eq(agents.id, 'lead')).run();
    db.update(agentToolCalls).set({ input: { agentId: 'lead', mode: 'new', task: 'Work', projectDirectory: process.cwd() } }).where(eq(agentToolCalls.id, 'dispatch')).run();
    await internal.executeToolCall({}, 'personal', 'workspace_personal', CHAT_AGENT_ID, 'chat', 'dispatch');
    const call = db.select().from(agentToolCalls).where(eq(agentToolCalls.id, 'dispatch')).get()!;
    expect(call.status).toBe('completed');
    const receipt = JSON.parse(call.output);
    expect(db.select().from(agentExecutions).where(eq(agentExecutions.id, receipt.executionId)).get()!.projectDirectory).toBe(process.cwd());
  });

  it('rejects direct execution of a private child before creating any execution', async () => {
    await setup();
    db.insert(agents).values({ id: 'private', workspaceId: 'workspace_personal', name: 'Private', responsibility: '', systemPrompt: '', model: '', runtime: { kind: 'codex', projectDirectory: process.cwd() } }).run();
    db.update(agents).set({ collaboration: { subAgentIds: ['private'], capabilities: [] } }).where(eq(agents.id, 'lead')).run();
    await expect(service.create({} as never, 'personal', 'private', { message: 'Work' })).rejects.toThrow('Only top-level');
    expect(db.select().from(agentExecutions).all()).toHaveLength(1);
  });

  it('does not let a saved external runtime snapshot bypass private-child dispatch restrictions', async () => {
    await setup();
    const snapshot = { agent: { id: 'lead', runtime: { kind: 'codex', projectDirectory: process.cwd() }, providerId: null, model: '', systemPrompt: 'Work' }, skills: [], mcpServers: [] };
    db.insert(agentExecutions).values({ id: 'old-top-level', workspaceId: 'workspace_personal', agentId: 'lead', status: 'completed', capabilitySnapshot: snapshot as never }).run();
    db.insert(agents).values({ id: 'new-owner', workspaceId: 'workspace_personal', name: 'Owner', responsibility: '', model: '', systemPrompt: '', collaboration: { subAgentIds: ['lead'], capabilities: [] } }).run();
    await expect(service.continue({} as never, 'personal', 'lead', 'old-top-level', { message: 'Resume privately' })).rejects.toThrow('Only top-level');
    expect(db.select().from(agentExecutions).where(eq(agentExecutions.id, 'old-top-level')).get()!.status).toBe('completed');
  });

  async function savedInstance(status: AgentExecutionStatus = 'failed') {
    const context = await setup();
    vi.spyOn(service, 'schedule').mockImplementation(() => {});
    db.insert(agentExecutions).values({ id: 'saved', workspaceId: 'workspace_personal', agentId: 'lead', status, modelMessages: [{ role: 'user', content: 'Original article' }, { role: 'assistant', content: [{ type: 'text', text: 'Research complete' }] }], displayMessages: [{ id: 'original', role: 'user', content: 'Original article', createdAt: new Date().toISOString() }] }).run();
    db.insert(agentToolCalls).values({ id: 'research', executionId: 'saved', workspaceId: 'workspace_personal', agentId: 'lead', toolCallId: 'research', toolName: 'builtin', mcpToolName: 'run_sub_agent', workingDirectory: '', status: 'completed', resultAppended: true, output: '{"resultRef":"saved-research"}' }).run();
    db.insert(auditLogs).values({ id: 'saved-binding', workspaceId: 'workspace_personal', action: 'chat_agent.dispatched', resource: 'saved', metadata: { conversationId: 'chat', invocationId: 'air_saved', reportedStatus: status, reportedKey: status } }).run();
    db.update(agentToolCalls).set({ input: { agentId: 'lead', task: 'Continue writing', mode: 'continue', continuationReason: 'Revise the same article', resumeCancelled: true, executionId: 'saved' } }).where(eq(agentToolCalls.id, 'dispatch')).run();
    return context;
  }

  it.each(['running', 'waiting_for_input', 'completed', 'failed', 'cancelled'] as const)('uses the live %s Agent state consistently across conversation reads and events', async (status) => {
    const { internal } = await savedInstance(status);
    vi.spyOn(internal, 'scheduleBackgroundAgentReports').mockImplementation(() => {});
    db.update(agentExecutions).set({ status: 'completed' }).where(eq(agentExecutions.id, 'chat')).run();
    const conversations = new ChatConversationsService(db, { getWorkspace: async () => ({ id: 'workspace_personal' }) } as never, service, {} as never);
    const expected = status === 'running' || status === 'waiting_for_input' ? 'running' : 'completed';
    expect(await service.get({} as never, 'personal', CHAT_AGENT_ID, 'chat')).toMatchObject({ status: 'completed', conversationStatus: expected });
    expect((await conversations.list({} as never, {})).items.find((item) => item.id === 'chat')?.status).toBe(expected);
    expect((await conversations.get({} as never, 'chat')).conversation.status).toBe(expected);
    expect((await conversations.records({} as never, 'chat')).conversation.status).toBe(expected);
    await service.publishSnapshotForExecution('workspace_personal', 'saved');
    const events = await service.events({} as never, 'personal', CHAT_AGENT_ID, 'chat');
    expect(events.filter((event) => event.data.kind === 'snapshot').at(-1)?.data).toMatchObject({ execution: { status: 'completed', conversationStatus: expected } });
    expect(events.filter((event) => event.data.kind === 'status').at(-1)?.data).toMatchObject({ status: 'completed', conversationStatus: expected });
    expect(gateway.generateAgentStep).not.toHaveBeenCalled();
  });

  it('keeps the conversation active until the last Agent settles and becomes active again on continuation', async () => {
    const { internal } = await savedInstance('running');
    vi.spyOn(internal, 'scheduleBackgroundAgentReports').mockImplementation(() => {});
    db.update(agentExecutions).set({ status: 'completed' }).where(eq(agentExecutions.id, 'chat')).run();
    db.insert(agentExecutions).values({ id: 'second', workspaceId: 'workspace_personal', agentId: 'lead', status: 'running' }).run();
    db.insert(auditLogs).values({ id: 'second-binding', workspaceId: 'workspace_personal', action: 'chat_agent.dispatched', resource: 'second', metadata: { conversationId: 'chat', reportedStatus: 'completed' } }).run();
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      db.update(agentExecutions).set({ status }).where(eq(agentExecutions.id, 'saved')).run();
      expect((await service.get({} as never, 'personal', CHAT_AGENT_ID, 'chat')).conversationStatus).toBe('running');
    }
    db.update(agentExecutions).set({ status: 'failed', errorCode: 'restarted' }).where(eq(agentExecutions.id, 'second')).run();
    // Historical running/paused invocation metadata cannot keep a recovered execution alive.
    for (const status of ['running', 'paused']) db.insert(auditLogs).values({ id: `stale-${status}`, workspaceId: 'workspace_personal', action: 'agent.invocation', resource: 'second', metadata: { parentRunId: 'root', status } }).run();
    expect((await service.get({} as never, 'personal', CHAT_AGENT_ID, 'chat')).conversationStatus).toBe('completed');
    db.update(agentExecutions).set({ status: 'running', errorCode: null }).where(eq(agentExecutions.id, 'second')).run();
    expect((await service.get({} as never, 'personal', CHAT_AGENT_ID, 'chat')).conversationStatus).toBe('running');
  });

  it.each(['failed', 'cancelled', 'waiting_for_input'] as const)('preserves %s turn controls while a background Agent runs', async (status) => {
    await savedInstance('running');
    db.update(agentExecutions).set({ status }).where(eq(agentExecutions.id, 'chat')).run();
    expect(await service.get({} as never, 'personal', CHAT_AGENT_ID, 'chat')).toMatchObject({ status, conversationStatus: 'running' });
    db.update(agentExecutions).set({ status: 'completed' }).where(eq(agentExecutions.id, 'saved')).run();
    expect(await service.get({} as never, 'personal', CHAT_AGENT_ID, 'chat')).toMatchObject({ status, conversationStatus: status });
  });

  it('ignores missing, unrelated and foreign-workspace Agent executions', async () => {
    await savedInstance('running');
    db.update(agentExecutions).set({ status: 'completed' }).where(eq(agentExecutions.id, 'chat')).run();
    db.insert(workspaces).values({ id: 'workspace_foreign', slug: 'foreign', name: 'Foreign' }).run();
    db.update(agentExecutions).set({ workspaceId: 'workspace_foreign' }).where(eq(agentExecutions.id, 'saved')).run();
    db.insert(agentExecutions).values({ id: 'unrelated', workspaceId: 'workspace_personal', agentId: 'lead', status: 'running' }).run();
    db.insert(auditLogs).values({ id: 'missing-binding', workspaceId: 'workspace_personal', action: 'chat_agent.dispatched', resource: 'missing', metadata: { conversationId: 'chat' } }).run();
    expect((await service.get({} as never, 'personal', CHAT_AGENT_ID, 'chat')).conversationStatus).toBe('completed');
  });

  it.each(['failed', 'completed', 'cancelled'] as const)('wakes the same %s instance and retains its history and saved tools', async (status) => {
    const { internal } = await savedInstance(status);
    await internal.executeToolCall({}, 'personal', 'workspace_personal', CHAT_AGENT_ID, 'chat', 'dispatch');
    expect(db.select().from(agentExecutions).all()).toHaveLength(2);
    const saved = db.select().from(agentExecutions).where(eq(agentExecutions.id, 'saved')).get()!;
    expect(saved.status).toBe('running');
    expect(saved.modelMessages[0]).toEqual({ role: 'user', content: 'Original article' });
    expect(saved.modelMessages).toHaveLength(3);
    expect(JSON.stringify(saved.modelMessages)).not.toContain('[Saved instance tool evidence]');
    expect(db.select().from(agentToolCalls).where(eq(agentToolCalls.id, 'research')).get()!.output).toContain('saved-research');
    expect(saved.modelMessages.at(-1)).toEqual({ role: 'user', content: 'Continue writing' });
    const call = db.select().from(agentToolCalls).where(eq(agentToolCalls.id, 'dispatch')).get()!;
    expect(JSON.parse(call.output)).toMatchObject({ executionId: 'saved', runId: 'air_saved', continued: true });
    expect(db.select().from(auditLogs).where(eq(auditLogs.id, 'saved-binding')).get()!.metadata).not.toHaveProperty('reportedKey');
  });

  it('does not infer continuation from an old instance mention for a new task', async () => {
    const { internal } = await savedInstance();
    db.update(agentExecutions).set({ displayMessages: [{ id: 'mention', role: 'user', content: '[@qcoder](/agents/lead?runId=air_saved&executionId=saved) A different task', createdAt: new Date().toISOString() }] }).where(eq(agentExecutions.id, 'chat')).run();
    db.update(agentToolCalls).set({ input: { agentId: 'lead', task: 'A different task', mode: 'new' } }).where(eq(agentToolCalls.id, 'dispatch')).run();
    await internal.executeToolCall({}, 'personal', 'workspace_personal', CHAT_AGENT_ID, 'chat', 'dispatch');
    const receipt = JSON.parse(db.select().from(agentToolCalls).where(eq(agentToolCalls.id, 'dispatch')).get()!.output);
    expect(receipt.executionId).not.toBe('saved');
    expect(receipt.continued).toBeUndefined();
    expect(db.select().from(agentExecutions).where(eq(agentExecutions.id, 'saved')).get()!.status).toBe('failed');
  });

  it.each([
    { agentId: 'lead', task: 'Status?' },
    { agentId: 'lead', task: 'Continue', mode: 'continue', executionId: 'saved' },
    { agentId: 'lead', task: 'Different task', mode: 'new', executionId: 'saved' },
    { agentId: 'lead', task: 'Continue', mode: 'continue', continuationReason: 'Same task' },
  ])('rejects ambiguous or conflicting dispatch without waking an instance: %j', async (input) => {
    const { internal } = await savedInstance();
    db.update(agentToolCalls).set({ input }).where(eq(agentToolCalls.id, 'dispatch')).run();
    await internal.executeToolCall({}, 'personal', 'workspace_personal', CHAT_AGENT_ID, 'chat', 'dispatch');
    expect(db.select().from(agentExecutions).all()).toHaveLength(2);
    expect(db.select().from(agentExecutions).where(eq(agentExecutions.id, 'saved')).get()!.status).toBe('failed');
    expect(db.select().from(agentToolCalls).where(eq(agentToolCalls.id, 'dispatch')).get()!.status).toBe('failed');
  });

  it('requires explicit resumption for a cancelled task', async () => {
    const { internal } = await savedInstance('cancelled');
    db.update(agentToolCalls).set({ input: { agentId: 'lead', task: 'Continue', mode: 'continue', continuationReason: 'Same task', executionId: 'saved' } }).where(eq(agentToolCalls.id, 'dispatch')).run();
    await internal.executeToolCall({}, 'personal', 'workspace_personal', CHAT_AGENT_ID, 'chat', 'dispatch');
    expect(db.select().from(agentExecutions).where(eq(agentExecutions.id, 'saved')).get()!.status).toBe('cancelled');
    expect(db.select().from(agentToolCalls).where(eq(agentToolCalls.id, 'dispatch')).get()!.status).toBe('failed');
  });

  it('archives legacy evidence once, retains user requirements and scopes archive reads', async () => {
    const { internal } = await savedInstance();
    const legacy = '[Saved instance tool evidence] [{"callId":"research"}]\nContinue this instance with the saved results and resultRef references.';
    db.update(agentExecutions).set({ modelMessages: [{ role: 'user', content: 'Original article' }, { role: 'user', content: legacy }, { role: 'user', content: legacy }] }).where(eq(agentExecutions.id, 'saved')).run();
    await internal.executeToolCall({}, 'personal', 'workspace_personal', CHAT_AGENT_ID, 'chat', 'dispatch');
    const saved = db.select().from(agentExecutions).where(eq(agentExecutions.id, 'saved')).get()!;
    expect(JSON.stringify(saved.modelMessages)).not.toContain(legacy);
    expect(saved.modelMessages.at(-1)).toEqual({ role: 'user', content: 'Continue writing' });
    const archives = db.select().from(agentCapabilityResults).all();
    expect(archives).toHaveLength(1);
    const page = await service.readHistoryArchive({} as never, 'personal', 'lead', 'saved', archives[0]!.id, 0, 50);
    expect(page.text).toHaveLength(50);
    expect(page.nextOffset).toBe(50);
    await expect(service.readHistoryArchive({} as never, 'personal', CHAT_AGENT_ID, 'chat', archives[0]!.id)).rejects.toThrow('not found');
    await expect(service.readHistoryArchive({} as never, 'personal', 'lead', 'saved', archives[0]!.id, -1)).rejects.toThrow('Invalid');
    db.update(agentExecutions).set({ status: 'completed' }).where(eq(agentExecutions.id, 'saved')).run();
    await service.continue({} as never, 'personal', 'lead', 'saved', { message: 'Another correction' });
    expect(db.select().from(agentCapabilityResults).all()).toHaveLength(1);
    expect(db.select().from(agentExecutions).where(eq(agentExecutions.id, 'saved')).get()!.modelMessages.at(-1)).toEqual({ role: 'user', content: 'Another correction' });
  });

  it('honors an instance-bound @mention even when the model omits executionId', async () => {
    const { internal } = await savedInstance();
    db.update(agentExecutions).set({ displayMessages: [{ id: 'mention', role: 'user', content: '[@qcoder](/agents/lead?runId=air_saved&executionId=saved) Continue writing', createdAt: new Date().toISOString() }] }).where(eq(agentExecutions.id, 'chat')).run();
    db.update(agentToolCalls).set({ input: { agentId: 'lead', task: 'Continue writing', mode: 'continue', continuationReason: 'Revise the same article', resumeCancelled: true } }).where(eq(agentToolCalls.id, 'dispatch')).run();
    await internal.executeToolCall({}, 'personal', 'workspace_personal', CHAT_AGENT_ID, 'chat', 'dispatch');
    expect(db.select().from(agentExecutions).all()).toHaveLength(2);
    expect(JSON.parse(db.select().from(agentToolCalls).where(eq(agentToolCalls.id, 'dispatch')).get()!.output)).toMatchObject({ continued: true, executionId: 'saved' });
  });

  it.each(['running', 'wrong-agent', 'wrong-workspace', 'missing'] as const)('rejects a %s instance without starting a replacement', async (scenario) => {
    const { internal } = await savedInstance(scenario === 'running' ? 'running' : 'failed');
    if (scenario === 'wrong-agent') db.update(agentToolCalls).set({ input: { agentId: 'lead', task: 'Continue', mode: 'continue', continuationReason: 'Same task', executionId: 'chat' } }).where(eq(agentToolCalls.id, 'dispatch')).run();
    if (scenario === 'wrong-workspace') { db.insert(workspaces).values({ id: 'workspace_foreign', slug: 'foreign', name: 'Foreign' }).run(); db.update(agentExecutions).set({ workspaceId: 'workspace_foreign' }).where(eq(agentExecutions.id, 'saved')).run(); }
    if (scenario === 'missing') db.update(agentToolCalls).set({ input: { agentId: 'lead', task: 'Continue', mode: 'continue', continuationReason: 'Same task', executionId: 'absent' } }).where(eq(agentToolCalls.id, 'dispatch')).run();
    await internal.executeToolCall({}, 'personal', 'workspace_personal', CHAT_AGENT_ID, 'chat', 'dispatch');
    expect(db.select().from(agentExecutions).all()).toHaveLength(2);
    expect(db.select().from(agentToolCalls).where(eq(agentToolCalls.id, 'dispatch')).get()!.status).toBe('failed');
    expect(gateway.generateAgentStep).toHaveBeenCalledTimes(1);
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
    expect(gateway.generateAgentStep).not.toHaveBeenCalled();
    expect(db.select().from(agentExecutions).where(eq(agentExecutions.id, 'chat')).get()?.displayMessages).toEqual([]);
    const chatView = await service.get({} as never, 'personal', CHAT_AGENT_ID, 'chat');
    expect(chatView.toolCalls.find((item) => item.id === 'dispatch')?.agentInvocation).toMatchObject({ agentName: 'qcoder', task: 'Investigate', status: 'running' });
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
