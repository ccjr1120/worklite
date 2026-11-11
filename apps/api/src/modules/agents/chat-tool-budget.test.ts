import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentExecutionColumns, executionUpdates, CHAT_DELEGATION_RULE, agentCapabilityResults, agentExecutions, agentToolCalls, externalChats, platformSkillPackageFiles, createDb, initializeDatabase, type Database } from '@worklite/db';
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
  const restartService = () => new AgentExecutionsService(db, workspaces as never, resources as never, unused, mcpRuntime as never, unused, unused, unused, projectTasks, attachments as never, unused, hostNotifications, unused);
  return { db, service: restartService(), restartService };
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
    gateway.generateAgentStep.mockResolvedValueOnce({ text: '', responseMessages: [{ role: 'assistant', content: [1, 2].map((index) => ({ type: 'tool-call', toolCallId: `next_${index}`, toolName: 'discover_tools', input: {} })) }], toolCalls: [
      { toolCallId: 'next_1', toolName: 'discover_tools', input: {} },
      { toolCallId: 'next_2', toolName: 'discover_tools', input: {} },
    ], finishReason: 'tool-calls', contextDropped: 0 }).mockResolvedValueOnce({ text: 'Done.', responseMessages: [], toolCalls: [], finishReason: 'stop', contextDropped: 0 });
    await advance(service);
    await vi.waitFor(() => expect(db.select(agentExecutionColumns).from(agentExecutions).get()?.status).toBe('completed'));
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
    const saved = db.select(agentExecutionColumns).from(agentExecutions).get();
    expect(saved).toMatchObject({ status: 'failed', modelMessages: original, errorCode: 'invalid_request', error: 'Context summary was empty; original history was retained.' });
    expect(db.select().from(agentCapabilityResults).all()).toEqual([]);
    expect(gateway.generateAgentStep).not.toHaveBeenCalled();
  });

  // Regression: a reasoning model (e.g. a GLM model behind an openai/responses-compatible
  // gateway) can spend its entire output budget thinking before writing any summary text,
  // leaving finishReason 'length' with an empty reply. The compaction request must give it
  // room to both think and answer, and ask for the lowest supported reasoning effort so a
  // mechanical summarization task does not spend that room on deep thinking by default.
  it('gives the compaction summary call a large output budget and the lowest reasoning effort', async () => {
    const { db, service } = await setup(0);
    const original = history(24000);
    db.update(agentExecutions).set(executionUpdates('aex_budget', { modelMessages: original as never })).run();
    gateway.streamText.mockReturnValue({ result: Promise.resolve({ text: 'Preserved task state.', finishReason: 'stop' }) });
    gateway.generateAgentStep.mockResolvedValue(done);
    await advance(service);
    expect(db.select(agentExecutionColumns).from(agentExecutions).get()?.status).toBe('completed');
    const [request] = gateway.streamText.mock.calls[0]!;
    expect(request.maxOutputTokens).toBeGreaterThanOrEqual(16_000);
    expect(request.candidates[0].modelParameters?.reasoningEffort).toBe('minimal');
  });

  it("keeps the agent's own low reasoning effort for the compaction call instead of overriding it", async () => {
    const { db, service } = await setup(0);
    const original = history(24000);
    db.update(agentExecutions).set(executionUpdates('aex_budget', { modelMessages: original as never, capabilitySnapshot: { agent: { id: CHAT_AGENT_ID, providerId: 'provider', model: 'model', systemPrompt: 'You are Chat.', modelParameters: { reasoningEffort: 'low' } }, skills: [] } as never })).run();
    gateway.streamText.mockReturnValue({ result: Promise.resolve({ text: 'Preserved task state.', finishReason: 'stop' }) });
    gateway.generateAgentStep.mockResolvedValue(done);
    await advance(service);
    const [request] = gateway.streamText.mock.calls[0]!;
    expect(request.candidates[0].modelParameters?.reasoningEffort).toBe('low');
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

describe('native Chat progressive tool exposure', () => {
  const done = { text: 'Done.', responseMessages: [], toolCalls: [], finishReason: 'stop', contextDropped: 0 };
  const step = (id: string, toolName: string, input: unknown) => ({ text: '', responseMessages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName, input }] }], toolCalls: [{ toolCallId: id, toolName, input }], finishReason: 'tool-calls', contextDropped: 0 });
  function capturePlatform(db: Database) {
    const skill = { id: 'sk_worklite_platform', name: 'worklite-platform', instructions: '' };
    const files = platformSkillPackageFiles();
    const snapshot = db.select(agentExecutionColumns).from(agentExecutions).get()!.capabilitySnapshot!;
    db.update(agentExecutions).set({ capabilitySnapshot: { ...snapshot, skills: [{ id: skill.id, name: skill.name, instructions: skill.instructions, files }] } }).run();
    return { skill, files };
  }
  const names = (request: { builtinTools: Array<{ name: string }>; skillScripts: Array<{ tool?: { name: string } }> }) => [...request.builtinTools.map((tool) => tool.name), ...request.skillScripts.flatMap((script) => script.tool ? [script.tool.name] : [])];

  it('reduces the real platform catalog to ten default tools and loads a group on the next step', async () => {
    const { db, service } = await setup(0);
    const { files } = capturePlatform(db);
    gateway.generateAgentStep.mockResolvedValueOnce(step('discover_files', 'discover_tools', { groups: ['files'] })).mockResolvedValue(done);
    await advance(service);
    await vi.waitFor(() => expect(db.select(agentExecutionColumns).from(agentExecutions).get()!.status).toBe('completed'));
    expect(names(gateway.generateAgentStep.mock.calls[0][0])).toHaveLength(10);
    expect(names(gateway.generateAgentStep.mock.calls[0][0])).not.toContain('upload_local_images');
    expect(names(gateway.generateAgentStep.mock.calls[1][0])).toContain('upload_local_images');
    expect(names(gateway.generateAgentStep.mock.calls[1][0])).toContain('upload_local_files');
    expect(names(gateway.generateAgentStep.mock.calls[1][0])).not.toContain('wait_project_task');
    const manifest = JSON.parse(files.find((file) => file.path === 'scripts/tools.json')!.content);
    const request = gateway.generateAgentStep.mock.calls[0][0];
    const exposed = [...request.builtinTools, ...request.skillScripts.map((script: { tool: unknown }) => script.tool)];
    expect(JSON.stringify(exposed).length).toBeLessThan(JSON.stringify(Object.values(manifest)).length * 0.6);
    const call = db.select().from(agentToolCalls).where(eq(agentToolCalls.toolCallId, 'discover_files')).get()!;
    expect(call).toMatchObject({ status: 'completed', resultAppended: true, commandExecutionId: null });
    expect(JSON.parse(call.output).toolNames).toEqual(expect.arrayContaining(['upload_local_images', 'upload_local_files']));
  });

  it('recovers loaded tools after compaction and a service restart, then resets at a new user turn', async () => {
    const { db, service, restartService } = await setup(0);
    capturePlatform(db);
    db.update(agentExecutions).set(executionUpdates('aex_budget', { displayMessages: [{ id: 'user1', role: 'user', content: 'Send files', createdAt: new Date().toISOString() }] })).run();
    gateway.generateAgentStep.mockResolvedValueOnce(step('discover_files', 'discover_tools', { groups: ['files'] })).mockResolvedValue(done);
    await advance(service);
    await vi.waitFor(() => expect(db.select(agentExecutionColumns).from(agentExecutions).get()!.status).toBe('completed'));
    db.update(agentExecutions).set(executionUpdates('aex_budget', { status: 'running', modelMessages: [{ role: 'user', content: 'Compacted checkpoint' }] })).run();
    gateway.generateAgentStep.mockResolvedValue(done);
    await advance(restartService());
    expect(names(gateway.generateAgentStep.mock.calls.at(-1)![0])).toContain('upload_local_images');
    db.update(agentExecutions).set(executionUpdates('aex_budget', { status: 'running', displayMessages: [{ id: 'user2', role: 'user', content: 'Next request', createdAt: new Date().toISOString() }], modelMessages: [{ role: 'user', content: 'Next request' }] })).run();
    await advance(restartService());
    expect(names(gateway.generateAgentStep.mock.calls.at(-1)![0])).not.toContain('upload_local_images');
  });

  it.each(['web_fetch', 'update_plan'])('removes %s from the catalog, discovery and execution', async (removed) => {
    const { db, service } = await setup(0);
    const { skill } = capturePlatform(db);
    const attempted = removed === 'update_plan'
      ? { toolCallId: 'removed_call', toolName: removed, input: { steps: [{ step: 'Work', status: 'in_progress' }, { step: 'Report', status: 'pending' }] } }
      : { toolCallId: 'removed_call', toolName: 'skill_script', modelToolName: removed, skillId: skill.id, scriptPath: 'scripts/web-fetch.mjs', input: { url: 'https://example.com' }, arguments: ['{"url":"https://example.com"}'] };
    gateway.generateAgentStep.mockResolvedValueOnce(step('catalog', 'discover_tools', {}))
      .mockResolvedValueOnce(step('reload_removed', 'discover_tools', { toolNames: [removed] }))
      .mockResolvedValueOnce({ ...step('removed_call', removed, attempted.input), toolCalls: [attempted] })
      .mockResolvedValue(done);
    await advance(service);
    await vi.waitFor(() => expect(db.select(agentExecutionColumns).from(agentExecutions).get()!.status).toBe('completed'));
    for (const [request] of gateway.generateAgentStep.mock.calls) expect(names(request)).not.toContain(removed);
    expect(db.select(agentExecutionColumns).from(agentExecutions).get()!.plan).toEqual([]);
    const catalog = db.select().from(agentToolCalls).where(eq(agentToolCalls.toolCallId, 'catalog')).get()!;
    expect(catalog.output).not.toContain(removed);
    for (const id of ['reload_removed', 'removed_call']) expect(db.select().from(agentToolCalls).where(eq(agentToolCalls.toolCallId, id)).get()).toMatchObject({ status: 'failed', commandExecutionId: null, resultAppended: true });
  });

  it('executes a discovered tool with its captured contract and keeps discovery failures recoverable', async () => {
    const { db, service } = await setup(0);
    const { skill } = capturePlatform(db);
    const internal = service as unknown as {
      executeToolCall(request: unknown, slug: string, workspace: string, agent: string, execution: string, callId: string): Promise<void>;
    };
    const execute = internal.executeToolCall.bind(internal);
    const effects: string[] = [];
    vi.spyOn(internal, 'executeToolCall').mockImplementation(async (...args) => {
      const call = db.select().from(agentToolCalls).where(eq(agentToolCalls.id, args[5])).get()!;
      if (call.mcpToolName !== 'upload_local_images') return execute(...args);
      effects.push(call.mcpToolName);
      db.update(agentToolCalls).set({ status: 'completed', output: 'Registered requested image.' }).where(eq(agentToolCalls.id, call.id)).run();
    });
    const image = { files: [{ path: '/tmp/screenshot.png', description: 'Screenshot' }] };
    gateway.generateAgentStep
      .mockResolvedValueOnce(step('invalid_discovery', 'discover_tools', { toolNames: ['unknown_tool'] }))
      .mockResolvedValueOnce(step('valid_discovery', 'discover_tools', { toolNames: ['upload_local_images'] }))
      .mockResolvedValueOnce({ ...step('send_image', 'upload_local_images', image), toolCalls: [{ toolCallId: 'send_image', toolName: 'skill_script', modelToolName: 'upload_local_images', skillId: skill.id, scriptPath: 'scripts/upload-local-images.mjs', input: image, arguments: [JSON.stringify(image)] }] })
      .mockResolvedValue(done);
    await advance(service);
    await vi.waitFor(() => expect(db.select(agentExecutionColumns).from(agentExecutions).get()!.status).toBe('completed'));
    expect(effects).toEqual(['upload_local_images']);
    expect(names(gateway.generateAgentStep.mock.calls[1][0])).not.toContain('upload_local_images');
    const failed = db.select().from(agentToolCalls).where(eq(agentToolCalls.toolCallId, 'invalid_discovery')).get()!;
    expect(failed).toMatchObject({ status: 'failed', resultAppended: true });
    expect(failed.output).toContain('unknown_tool');
    expect(names(gateway.generateAgentStep.mock.calls[3][0])).toContain('upload_local_images');
  });

  it('rejects an undiscovered script without starting it and explains how to load it', async () => {
    const { db, service } = await setup(0);
    const { skill } = capturePlatform(db);
    const call = { toolCallId: 'hidden', toolName: 'skill_script', modelToolName: 'upload_local_images', skillId: skill.id, scriptPath: 'scripts/upload-local-images.mjs', input: { files: [] }, arguments: ['{"files":[]}'] };
    gateway.generateAgentStep.mockResolvedValueOnce({ ...step('hidden', 'upload_local_images', call.input), toolCalls: [call] }).mockResolvedValue(done);
    await advance(service);
    const saved = db.select().from(agentToolCalls).where(eq(agentToolCalls.toolCallId, 'hidden')).get()!;
    expect(saved).toMatchObject({ status: 'failed', resultAppended: true, commandExecutionId: null });
    expect(JSON.stringify(gateway.generateAgentStep.mock.calls[1][0].messages)).toContain('discover_tools');
    expect(names(gateway.generateAgentStep.mock.calls[1][0])).not.toContain('upload_local_images');
  });
});
