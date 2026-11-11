import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentExecutionColumns, executionUpdates, CHAT_DELEGATION_RULE, agentCapabilityResults, agentExecutions, agentToolCalls, externalChats, createDb, initializeDatabase, type Database } from '@worklite/db';
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
  gateway.streamText.mockReset();
});

async function setup(priorToolCalls: number) {
  const db = createDb(':memory:');
  dbs.push(db);
  await initializeDatabase(db);
  const calls = Array.from({ length: priorToolCalls }, (_, index) => `call_${index}`);
  db.insert(agentExecutions).values({
    id: 'aex_budget', workspaceId: WORKSPACE_ID, agentId: CHAT_AGENT_ID, status: 'running', phase: 'model',
    capabilitySnapshot: { agent: { id: CHAT_AGENT_ID, providerId: 'provider', model: 'model', systemPrompt: 'You are Chat.' }, skills: [] } as never,
    modelMessages: [
      { role: 'user', content: 'Look into how Claude Code and Codex handle conditional tasks.' },
      ...calls.flatMap((toolCallId) => [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName: 'run_host_command', input: {} }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName: 'run_host_command', output: { type: 'text', value: 'ok' } }] },
      ]),
    ] as never,
  }).run();
  for (const toolCallId of calls) {
    db.insert(agentToolCalls).values({
      id: `acall_${toolCallId}`, executionId: 'aex_budget', workspaceId: WORKSPACE_ID, agentId: CHAT_AGENT_ID, toolCallId,
      toolName: 'builtin', mcpToolName: 'run_host_command', workingDirectory: '/tmp', status: 'completed', resultAppended: true,
    }).run();
  }
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

async function advance(service: AgentExecutionsService) {
  return (service as unknown as { advance(request: unknown, slug: string, id: string): Promise<{ status: string; error: string | null }> })
    .advance({}, 'personal', 'aex_budget');
}

describe('Chat tool execution', () => {
  it.each(['wechat', 'feishu', 'web'] as const)('supplies the actual %s delivery channel to Chat', async (channel) => {
    const { db, service } = await setup(0);
    if (channel !== 'web') db.insert(externalChats).values({ id: `${channel}:user`, workspaceId: WORKSPACE_ID, channel, externalId: 'user', userId: 'user', executionId: 'aex_budget' }).run();
    gateway.generateAgentStep.mockResolvedValueOnce({ text: 'Done.', responseMessages: [], toolCalls: [], finishReason: 'stop', contextDropped: 0 });
    await advance(service);
    expect(gateway.generateAgentStep.mock.calls[0]![0].systemPrompt).toContain(`Current conversation delivery channel: ${channel}.`);
  });

  it('applies delegation boundaries even to an existing Chat capability snapshot', async () => {
    const { service } = await setup(0);
    gateway.generateAgentStep.mockResolvedValueOnce({ text: '', responseMessages: [], toolCalls: [], finishReason: 'stop', contextDropped: 0 });

    await advance(service);

    const request = gateway.generateAgentStep.mock.calls[0]![0] as { systemPrompt: string; builtinTools: Array<{ name: string; description: string }> };
    expect(request.systemPrompt).toContain(CHAT_DELEGATION_RULE);
    expect(request.systemPrompt).toContain('cancellation does not delete the instance');
    expect(request.systemPrompt).toContain('Native Agent continuation reads the latest saved configuration');
    expect(request.systemPrompt).toContain('GET /agents/:agentId/history/:runId');
    expect(request.systemPrompt).toContain('A user-requested status check is allowed');
    expect(request.builtinTools.find((tool) => tool.name === 'run_agent')?.description).toContain('the selected Agent decides how to fulfill the goal');
  });

  it.each([11, 12, 30])('keeps accepting tools after %i prior calls', async (count) => {
    const { db, service } = await setup(count);
    const steps = [{ step: 'Investigate', status: 'completed' }, { step: 'Report', status: 'in_progress' }];
    gateway.generateAgentStep.mockResolvedValueOnce({ text: '', responseMessages: [{ role: 'assistant', content: [1, 2].map((index) => ({ type: 'tool-call', toolCallId: `next_${index}`, toolName: 'update_plan', input: { steps } })) }], toolCalls: [
      { toolCallId: 'next_1', toolName: 'update_plan', input: { steps } },
      { toolCallId: 'next_2', toolName: 'update_plan', input: { steps } },
    ], finishReason: 'tool-calls', contextDropped: 0 }).mockResolvedValueOnce({ text: 'Done.', responseMessages: [], toolCalls: [], finishReason: 'stop', contextDropped: 0 });
    await advance(service);
    expect(db.select().from(agentToolCalls).all().filter((call) => call.toolCallId.startsWith('next_')).map((call) => call.status)).toEqual(['completed', 'completed']);
    expect(db.select(agentExecutionColumns).from(agentExecutions).get()?.status).toBe('completed');
    for (const [request] of gateway.generateAgentStep.mock.calls) {
      expect(request).toMatchObject({ toolsDisabled: false, parallelToolCalls: true });
      expect(request.maxToolRounds).toBeUndefined();
      expect(request.systemPrompt).not.toContain('12 tool calls');
      expect(JSON.stringify(request.messages)).not.toContain('tool budget for this turn is exhausted');
    }
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('runs tools concurrently and joins the batch once (%s)', async (outcome) => {
    const { db, service } = await setup(12);
    const internal = service as unknown as {
      executeToolCall(request: unknown, slug: string, workspace: string, agent: string, execution: string, callId: string): Promise<void>;
      resumeAfterToolCalls(request: unknown, slug: string, workspace: string, agent: string, execution: string): Promise<unknown>;
    };
    const pending = new Map<string, () => void>();
    const completions: Promise<void>[] = [];
    vi.spyOn(internal, 'executeToolCall').mockImplementation(async (...args) => {
      const callId = args[5];
      const call = db.select().from(agentToolCalls).where(eq(agentToolCalls.id, callId)).get()!;
      const gate = new Promise<void>((resolve) => pending.set(call.toolCallId, resolve));
      const completion = gate.then(async () => {
        db.update(agentToolCalls).set({ status: call.toolCallId === 'parallel_2' && outcome === 'failed' ? 'failed' : 'completed', output: call.toolCallId }).where(eq(agentToolCalls.id, callId)).run();
        await internal.resumeAfterToolCalls(...args.slice(0, 5) as [unknown, string, string, string, string]);
      });
      completions.push(completion);
      await completion;
    });
    const toolCalls = [1, 2, 3].map((index) => ({ toolCallId: `parallel_${index}`, toolName: 'inspect_agents', input: {} }));
    gateway.generateAgentStep.mockResolvedValueOnce({ text: '', responseMessages: [{ role: 'assistant', content: toolCalls.map((call) => ({ type: 'tool-call', ...call })) }], toolCalls, finishReason: 'tool-calls', contextDropped: 0 })
      .mockResolvedValueOnce({ text: 'Done.', responseMessages: [], toolCalls: [], finishReason: 'stop', contextDropped: 0 });
    await advance(service);
    expect([...pending.keys()]).toEqual(['parallel_1', 'parallel_2', 'parallel_3']);
    try {
      pending.get('parallel_3')!();
      await completions[2];
      expect(gateway.generateAgentStep).toHaveBeenCalledTimes(1);
      if (outcome === 'cancelled') db.update(agentExecutions).set({ status: 'cancelled' }).where(eq(agentExecutions.id, 'aex_budget')).run();
    } finally {
      for (const release of pending.values()) release();
      await Promise.all(completions);
      await vi.waitFor(() => expect((service as unknown as { activeNativeBatches: Map<string, unknown> }).activeNativeBatches.size).toBe(0));
      if (outcome !== 'cancelled') await vi.waitFor(() => expect(db.select(agentExecutionColumns).from(agentExecutions).get()!.status).toBe('completed'));
    }
    expect(gateway.generateAgentStep).toHaveBeenCalledTimes(outcome === 'cancelled' ? 1 : 2);
    if (outcome !== 'cancelled') {
      const messages = db.select(agentExecutionColumns).from(agentExecutions).get()!.modelMessages;
      const results = messages.flatMap((message) => message.role === 'tool' ? message.content : []).filter((part) => part.toolCallId.startsWith('parallel_'));
      expect(results.map((part) => part.toolCallId)).toEqual(['parallel_1', 'parallel_2', 'parallel_3']);
      expect(db.select().from(agentToolCalls).all().every((call) => call.resultAppended)).toBe(true);
    }
  });
});


describe('native Chat message queues', () => {
  const request = {} as never;
  const done = { text: 'Done.', responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }], toolCalls: [], finishReason: 'stop', contextDropped: 0 };
  const enqueue = (service: AgentExecutionsService, message: string, mode: 'steering' | 'follow_up', messageId = message) => service.queueMessage(request, 'personal', CHAT_AGENT_ID, 'aex_budget', { message, mode, messageId });

  it('injects steering at the next model boundary and drains follow-ups FIFO after natural completion', async () => {
    const { db, service } = await setup(0);
    let finish!: () => void;
    gateway.generateAgentStep.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(done); })).mockResolvedValue(done);
    const running = advance(service);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await enqueue(service, 'follow 1', 'follow_up');
    await enqueue(service, 'steer now', 'steering');
    await enqueue(service, 'follow 2', 'follow_up');
    expect(gateway.generateAgentStep).toHaveBeenCalledTimes(1);
    expect(db.select(agentExecutionColumns).from(agentExecutions).get()!.queuedMessages).toHaveLength(3);
    finish();
    await running;
    expect(gateway.generateAgentStep.mock.calls.slice(1).map(([input]) => input.messages.at(-1).content)).toEqual(['steer now', 'follow 1', 'follow 2']);
    const saved = db.select(agentExecutionColumns).from(agentExecutions).get()!;
    expect(saved.queuedMessages).toEqual([]);
    expect(saved.status).toBe('completed');
    expect(saved.displayMessages.filter((entry) => entry.role === 'user').map((entry) => entry.content)).toEqual(['steer now', 'follow 1', 'follow 2']);
  });

  it('waits for tool results before steering, and keeps follow-up pending during further tool work', async () => {
    const { db, service } = await setup(0);
    const internal = service as unknown as { executeToolCall(...args: unknown[]): Promise<void>; resumeAfterToolCalls(...args: unknown[]): Promise<unknown> };
    let finishTool!: () => Promise<unknown>;
    vi.spyOn(internal, 'executeToolCall').mockImplementation(async (...args) => {
      finishTool = async () => {
        db.update(agentToolCalls).set({ status: 'completed', output: 'tool evidence' }).where(eq(agentToolCalls.id, String(args[5]))).run();
        return internal.resumeAfterToolCalls(...args.slice(0, 5));
      };
    });
    const toolCalls = [{ toolCallId: 'inspect', toolName: 'inspect_agents', input: {} }];
    gateway.generateAgentStep.mockResolvedValueOnce({ text: '', responseMessages: [{ role: 'assistant', content: toolCalls.map((call) => ({ type: 'tool-call', ...call })) }], toolCalls, finishReason: 'tool-calls', contextDropped: 0 }).mockResolvedValue(done);
    await advance(service);
    await enqueue(service, 'later', 'follow_up');
    await enqueue(service, 'change direction', 'steering');
    expect(gateway.generateAgentStep).toHaveBeenCalledTimes(1);
    await finishTool();
    expect(gateway.generateAgentStep.mock.calls[1][0].messages.at(-1).content).toBe('change direction');
    expect(JSON.stringify(gateway.generateAgentStep.mock.calls[1][0].messages)).toContain('tool evidence');
    expect(gateway.generateAgentStep.mock.calls[2][0].messages.at(-1).content).toBe('later');
  });

  it('deduplicates accepted and consumed messages, supports removal and rejects invalid modes', async () => {
    const { db, service } = await setup(0);
    await enqueue(service, 'same', 'steering', 'stable');
    await enqueue(service, 'same', 'steering', 'stable');
    await expect(enqueue(service, 'different', 'steering', 'stable')).rejects.toThrow('different message');
    expect(db.select(agentExecutionColumns).from(agentExecutions).get()!.queuedMessages).toHaveLength(1);
    await service.removeQueuedMessage(request, 'personal', CHAT_AGENT_ID, 'aex_budget', 'queued_stable');
    expect(db.select(agentExecutionColumns).from(agentExecutions).get()!.queuedMessages).toEqual([]);
    await expect(enqueue(service, 'bad', 'invalid' as never)).rejects.toThrow('Choose steering');
    await enqueue(service, 'same', 'steering', 'stable');
    gateway.generateAgentStep.mockResolvedValue(done);
    await advance(service);
    await enqueue(service, 'same', 'steering', 'stable');
    expect(db.select(agentExecutionColumns).from(agentExecutions).get()!.queuedMessages).toEqual([]);
    expect(gateway.generateAgentStep).toHaveBeenCalledTimes(1);
  });

  it('retains pending messages after failure without automatically replaying them', async () => {
    const { db, service } = await setup(0);
    await enqueue(service, 'later', 'follow_up');
    gateway.generateAgentStep.mockRejectedValue(new Error('Provider unavailable'));
    await advance(service);
    expect(gateway.generateAgentStep).toHaveBeenCalledTimes(1);
    expect(db.select(agentExecutionColumns).from(agentExecutions).get()).toMatchObject({ status: 'failed', queuedMessages: [expect.objectContaining({ message: 'later' })] });
    await service.cancel(request, 'personal', CHAT_AGENT_ID, 'aex_budget');
    expect(db.select(agentExecutionColumns).from(agentExecutions).get()!.queuedMessages).toEqual([]);
  });

  it('starts a queued message accepted just after the previous turn completes', async () => {
    const { db, service } = await setup(0);
    db.update(agentExecutions).set({ status: 'completed' }).where(eq(agentExecutions.id, 'aex_budget')).run();
    gateway.generateAgentStep.mockResolvedValue(done);
    await enqueue(service, 'next turn', 'follow_up');
    await vi.waitFor(() => {
      expect(gateway.generateAgentStep).toHaveBeenCalledTimes(1);
      expect(db.select(agentExecutionColumns).from(agentExecutions).get()).toMatchObject({ status: 'completed', queuedMessages: [] });
    });
  });

  it('preserves queued messages across database initialization without replaying work', async () => {
    const { db, service } = await setup(0);
    await enqueue(service, 'persist me', 'follow_up');
    await initializeDatabase(db);
    const view = await service.get(request, 'personal', CHAT_AGENT_ID, 'aex_budget');
    expect(view.queuedMessages).toEqual([expect.objectContaining({ message: 'persist me', mode: 'follow_up' })]);
    expect(gateway.generateAgentStep).not.toHaveBeenCalled();
    await expect(service.queueMessage(request, 'personal', CHAT_AGENT_ID, 'missing', { message: 'x', mode: 'steering' })).rejects.toThrow('not found');
  });

  it('cancels an active model request and discards pending input without starting follow-ups', async () => {
    const { db, service } = await setup(0);
    let finish!: () => void;
    gateway.generateAgentStep.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(done); }));
    const running = advance(service);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await enqueue(service, 'later', 'follow_up');
    await service.cancel(request, 'personal', CHAT_AGENT_ID, 'aex_budget');
    finish();
    await running;
    expect(db.select(agentExecutionColumns).from(agentExecutions).get()).toMatchObject({ status: 'cancelled', queuedMessages: [] });
    expect(gateway.generateAgentStep).toHaveBeenCalledTimes(1);
  });
});

describe('native Chat context and truncated calls', () => {
  const done = { text: 'Done.', responseMessages: [], toolCalls: [], finishReason: 'stop', contextDropped: 0 };
  const history = (size: number) => [{ role: 'user', content: 'Original requirement' }, { role: 'assistant', content: [{ type: 'text', text: 'Evidence '.repeat(size) }] }, { role: 'user', content: 'Latest exact requirement' }];

  it('archives original evidence atomically and exposes bounded execution-owned retrieval', async () => {
    const { db, service } = await setup(0);
    const original = history(24000);
    db.update(agentExecutions).set(executionUpdates('aex_budget', { modelMessages: original as never })).run();
    gateway.streamText.mockReturnValue({ result: Promise.resolve({ text: 'Original requirement; verified evidence; work remains.', finishReason: 'stop' }) });
    gateway.generateAgentStep.mockResolvedValue(done);
    await advance(service);
    const archive = db.select().from(agentCapabilityResults).get()!;
    expect(archive.value).toMatchObject({ kind: 'native-context', messages: original });
    const saved = db.select(agentExecutionColumns).from(agentExecutions).get()!;
    expect(saved.status).toBe('completed');
    expect(JSON.stringify(saved.modelMessages)).toContain(archive.id);
    expect(saved.modelMessages.at(-1)?.content).toBe('Latest exact requirement');
    expect(saved.displayMessages).toHaveLength(1);
    const page = await service.historyArchive({} as never, 'personal', CHAT_AGENT_ID, 'aex_budget', archive.id, 0, 100);
    expect(page.content).toHaveLength(100);
    expect(page.nextOffset).toBe(100);
    await expect(service.historyArchive({} as never, 'personal', CHAT_AGENT_ID, 'different_execution', archive.id)).rejects.toThrow();
  });

  it('retains original history when summarization fails', async () => {
    const { db, service } = await setup(0);
    const original = history(24000);
    db.update(agentExecutions).set(executionUpdates('aex_budget', { modelMessages: original as never })).run();
    gateway.streamText.mockReturnValue({ result: Promise.resolve({ text: '', finishReason: 'stop' }) });
    await advance(service);
    expect(db.select(agentExecutionColumns).from(agentExecutions).get()).toMatchObject({ status: 'failed', modelMessages: original });
    expect(db.select().from(agentCapabilityResults).all()).toEqual([]);
    expect(gateway.generateAgentStep).not.toHaveBeenCalled();
  });

  it('retries only the model once after a provider context overflow', async () => {
    const { db, service } = await setup(0);
    db.update(agentExecutions).set(executionUpdates('aex_budget', { modelMessages: history(4000) as never })).run();
    gateway.streamText.mockReturnValue({ result: Promise.resolve({ text: 'Preserved task state.', finishReason: 'stop' }) });
    gateway.generateAgentStep.mockRejectedValueOnce(new Error('context_length_exceeded')).mockResolvedValue(done);
    await advance(service);
    expect(gateway.generateAgentStep).toHaveBeenCalledTimes(2);
    expect(db.select(agentExecutionColumns).from(agentExecutions).get()!.status).toBe('completed');
    expect(db.select().from(agentToolCalls).all()).toEqual([]);
    expect(db.select().from(agentCapabilityResults).all()).toHaveLength(1);
  });

  it('rejects truncated tool parameters without executing side effects', async () => {
    const { db, service } = await setup(0);
    const execute = vi.spyOn(service as unknown as { executeToolCall(): Promise<void> }, 'executeToolCall');
    const call = { toolCallId: 'truncated', toolName: 'inspect_agents', input: {} };
    gateway.generateAgentStep.mockResolvedValueOnce({ text: '', toolCalls: [call], responseMessages: [{ role: 'assistant', content: [{ type: 'tool-call', ...call }] }], finishReason: 'length', contextDropped: 0 }).mockResolvedValue(done);
    await advance(service);
    expect(execute).not.toHaveBeenCalled();
    expect(db.select().from(agentToolCalls).get()).toMatchObject({ status: 'failed', resultAppended: true });
    expect(gateway.generateAgentStep).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(gateway.generateAgentStep.mock.calls[1][0].messages)).toContain('truncated');
  });
});
