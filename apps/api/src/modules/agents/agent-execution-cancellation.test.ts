// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentExecutionColumns, agentExecutions, agents, agentToolCalls, auditLogs, workspaces, createDb, initializeDatabase, type Database } from '@worklite/db';
import type { IsolatedAgentInvocationService } from './isolated-agent-invocation.service';
import { AgentCollaborationService } from './agent-collaboration.service';
import { AgentExecutionsService } from './agent-executions.service';
import { AgentsController } from './agents.controller';

type Invocation = Parameters<IsolatedAgentInvocationService['execute']>[0];
let db: Database;
afterEach(() => { db?.$client.close(); vi.restoreAllMocks(); });

async function setup() {
  db = createDb(':memory:'); await initializeDatabase(db);
  for (const id of ['lead', 'child', 'sibling']) db.insert(agents).values({ id, workspaceId: 'workspace_personal', name: id, kind: 'custom', responsibility: id, systemPrompt: id, model: 'provider/model', collaboration: { subAgentIds: id === 'lead' ? ['child', 'sibling'] : [], capabilities: [], publicModels: ['provider/model'] } }).run();
  const execute = vi.fn<(request: Invocation) => Promise<string>>();
  const resources = { resolveSkillIds: async (_workspace: string, ids: string[]) => ids, reconcileWorkspaceSkills: async () => {}, workflowMcpRuntimes: async () => [] } as never;
  const collaboration = new AgentCollaborationService(db, resources, { execute } as never, {} as never);
  const executions = new AgentExecutionsService(db, { getWorkspace: async () => ({ id: 'workspace_personal' }) } as never, resources, {} as never, {} as never, {} as never, {} as never, {} as never, { list: () => [], subscriptionsFor: () => [], activeForExecution: () => [] } as never, {} as never, {} as never, {} as never, {} as never, collaboration);
  const controller = new AgentsController({} as never, executions, {} as never);
  return { executions, collaboration, execute, controller };
}

function waitForAbort(request: Invocation): Promise<string> {
  return new Promise((_, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    if (request.signal.aborted) reject(request.signal.reason);
  });
}

const request = {} as never;
const runs = () => db.select().from(auditLogs).where(eq(auditLogs.action, 'agent.invocation')).all().map((row) => row.metadata);

describe('user Agent execution cancellation', () => {
  it('stops a native execution tree, retains checkpoints and evidence, and does not replay after restart', async () => {
    const { executions, execute, controller } = await setup();
    execute.mockImplementation(async (invocation) => {
      await invocation.onMessages?.([{ role: 'user', content: 'saved context' }]);
      if (!invocation.systemPrompt.startsWith('lead')) {
        await invocation.onTextDelta?.('partial evidence');
        return waitForAbort(invocation);
      }
      await invocation.executeManagedTool!({ toolCallId: 'children', toolName: 'run_sub_agents', input: { tasks: [{ agentId: 'child', task: 'one' }, { agentId: 'sibling', task: 'two' }] } });
      return 'late result';
    });
    const execution = await executions.create(request, 'personal', 'lead', { message: 'work' });
    await vi.waitFor(async () => { expect((await executions.get(request, 'personal', 'lead', execution.id)).error).toBeNull(); expect(execute).toHaveBeenCalledTimes(3); });
    db.update(agentToolCalls).set({ output: 'Saved tool evidence' }).run();
    const result = await controller.cancelExecution(request, 'lead', execution.id);
    expect(result.status).toBe('cancelled');
    expect(result.pendingQuestion).toBeNull();
    expect(result.toolCalls[0]!.output).toBe('Saved tool evidence');
    expect(execute.mock.calls.every(([invocation]) => invocation.signal.aborted)).toBe(true);
    expect(runs()).toHaveLength(3);
    expect(runs().every((run) => run.status === 'cancelled' && run.finishedAt)).toBe(true);
    expect(runs().filter((run) => run.parentRunId).every((run) => run.output === 'partial evidence')).toBe(true);
    expect(db.select(agentExecutionColumns).from(agentExecutions).where(eq(agentExecutions.id, execution.id)).get()!.modelMessages).toEqual([{ role: 'user', content: 'saved context' }]);
    expect(db.select().from(agentToolCalls).all().every((call) => call.status === 'cancelled')).toBe(true);
    const history = runs();
    await controller.cancelExecution(request, 'lead', execution.id);
    expect(runs()).toEqual(history);
    await initializeDatabase(db);
    expect(db.select(agentExecutionColumns).from(agentExecutions).where(eq(agentExecutions.id, execution.id)).get()!.status).toBe('cancelled');
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('waits for native cleanup and rejects continuation until the stopped turn has settled', async () => {
    const { executions, execute } = await setup();
    let finish!: () => void;
    execute.mockImplementation(async (invocation) => {
      await waitForAbort(invocation).catch(() => {});
      await new Promise<void>((resolve) => { finish = resolve; });
      return 'late completion after abort';
    });
    const execution = await executions.create(request, 'personal', 'lead', { message: 'work' });
    await vi.waitFor(async () => { expect((await executions.get(request, 'personal', 'lead', execution.id)).error).toBeNull(); expect(execute).toHaveBeenCalledOnce(); });
    let stopped = false;
    const cancellation = executions.cancel(request, 'personal', 'lead', execution.id).then((result) => { stopped = true; return result; });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(stopped).toBe(false);
    await expect(executions.continue(request, 'personal', 'lead', execution.id, { message: 'continue' })).rejects.toThrow('still settling');
    finish();
    expect((await cancellation).status).toBe('cancelled');
    expect(runs()[0]).toMatchObject({ status: 'cancelled', output: '' });
  });

  it('cancels a waiting recovery question, closes its tool result and retains previous evidence', async () => {
    const { executions, execute } = await setup();
    db.insert(agentExecutions).values({ id: 'waiting', agentId: 'lead', workspaceId: 'workspace_personal', status: 'waiting_for_input', pendingQuestion: { id: 'question', question: 'Recover?', options: [], shellCallId: 'call', recovery: { operationKey: 'call' }, createdAt: new Date().toISOString() }, modelMessages: [{ role: 'user', content: 'work' }, { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tool', toolName: 'bash', input: {} }] }], displayMessages: [{ id: 'message', role: 'assistant', content: 'Saved output', createdAt: new Date().toISOString() }] }).run();
    db.insert(agentToolCalls).values({ id: 'call', executionId: 'waiting', agentId: 'lead', workspaceId: 'workspace_personal', toolCallId: 'tool', toolName: 'builtin', mcpToolName: 'bash', workingDirectory: '', status: 'failed', output: 'Saved command evidence', resultAppended: false }).run();
    const result = await executions.cancel(request, 'personal', 'lead', 'waiting');
    expect(result).toMatchObject({ status: 'cancelled', pendingQuestion: null, messages: [expect.objectContaining({ content: 'Saved output' })] });
    expect(result.toolCalls[0]).toMatchObject({ status: 'failed', output: 'Saved command evidence' });
    expect(db.select().from(agentToolCalls).get()!.resultAppended).toBe(true);
    expect(db.select(agentExecutionColumns).from(agentExecutions).where(eq(agentExecutions.id, 'waiting')).get()!.modelMessages.at(-1)).toMatchObject({ role: 'tool', content: [expect.objectContaining({ output: { type: 'error-text', value: 'Saved command evidence' } })] });
    expect(execute).not.toHaveBeenCalled();
  });

  it('cancels one native child without stopping its lead or sibling, and enforces ownership', async () => {
    const { executions, execute, controller } = await setup();
    let finishSibling!: (text: string) => void;
    execute.mockImplementation(async (invocation) => {
      if (invocation.systemPrompt.startsWith('child')) return waitForAbort(invocation);
      if (invocation.systemPrompt.startsWith('sibling')) return new Promise<string>((resolve) => { finishSibling = resolve; });
      await invocation.executeManagedTool!({ toolCallId: 'children', toolName: 'run_sub_agents', input: { tasks: [{ agentId: 'child', task: 'one' }, { agentId: 'sibling', task: 'two' }] } });
      return 'Lead finished';
    });
    const execution = await executions.create(request, 'personal', 'lead', { message: 'work' });
    await vi.waitFor(async () => { expect((await executions.get(request, 'personal', 'lead', execution.id)).error).toBeNull(); expect(execute).toHaveBeenCalledTimes(3); });
    const child = runs().find((run) => run.agentId === 'child')!;
    await expect(controller.cancelSubAgent(request, 'sibling', execution.id, child.id as string)).rejects.toThrow('not found');
    await expect(controller.cancelSubAgent(request, 'lead', execution.id, runs().find((run) => run.agentId === 'lead')!.id as string)).rejects.toThrow('not found');
    const result = await controller.cancelSubAgent(request, 'lead', execution.id, child.id as string);
    expect(result).toMatchObject({ agentId: 'child', status: 'cancelled' });
    expect(runs().find((run) => run.agentId === 'sibling')!.status).toBe('running');
    expect(execute.mock.calls[0]![0].signal.aborted).toBe(false);
    await controller.cancelSubAgent(request, 'lead', execution.id, child.id as string);
    finishSibling('Sibling finished');
    await vi.waitFor(async () => expect((await executions.get(request, 'personal', 'lead', execution.id)).status).toBe('completed'));
    expect(runs().find((run) => run.agentId === 'child')!.status).toBe('cancelled');
  });

  it('leaves terminal executions intact and rejects ids outside the owning Agent/workspace', async () => {
    const { executions } = await setup();
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      db.insert(agentExecutions).values({ id: status, agentId: 'lead', workspaceId: 'workspace_personal', status }).run();
      expect((await executions.cancel(request, 'personal', 'lead', status)).status).toBe(status);
    }
    await expect(executions.cancel(request, 'personal', 'sibling', 'completed')).rejects.toThrow('not found');
    await expect(executions.cancel(request, 'personal', 'lead', 'missing')).rejects.toThrow('not found');
    db.insert(workspaces).values({ id: 'foreign', slug: 'foreign', name: 'Foreign' }).run();
    db.insert(agents).values({ id: 'foreign-agent', workspaceId: 'foreign', name: 'Foreign', kind: 'custom', model: 'provider/model', responsibility: 'Work', systemPrompt: 'Work' }).run();
    db.insert(agentExecutions).values({ id: 'foreign-execution', workspaceId: 'foreign', agentId: 'foreign-agent', status: 'running' }).run();
    await expect(executions.cancel(request, 'personal', 'foreign-agent', 'foreign-execution')).rejects.toThrow('not found');
  });

  it('stops a child subtree and keeps the sibling active', async () => {
    const { executions, execute, controller } = await setup();
    db.insert(agents).values({ id: 'grandchild', name: 'grandchild', model: 'provider/model', workspaceId: 'workspace_personal', kind: 'custom', responsibility: 'Work', systemPrompt: 'grandchild', collaboration: { subAgentIds: [], capabilities: [], publicModels: ['provider/model'] } }).run();
    db.update(agents).set({ collaboration: { subAgentIds: ['grandchild'], capabilities: [], publicModels: ['provider/model'] } }).where(eq(agents.id, 'child')).run();
    let finishSibling!: (value: string) => void;
    execute.mockImplementation(async (invocation) => {
      if (invocation.systemPrompt.startsWith('grandchild')) return waitForAbort(invocation);
      if (invocation.systemPrompt.startsWith('sibling')) return new Promise<string>((resolve) => { finishSibling = resolve; });
      const child = invocation.systemPrompt.startsWith('child');
      const result = await invocation.executeManagedTool!({ toolCallId: 'children', toolName: 'run_sub_agents', input: { tasks: child ? [{ agentId: 'grandchild', task: 'nested' }] : [{ agentId: 'child', task: 'one' }, { agentId: 'sibling', task: 'two' }] } });
      if (!child) expect(JSON.parse(result).result[0]).toMatchObject({ status: 'cancelled', recovery: expect.stringContaining('do not restart') });
      return 'Finished';
    });
    const execution = await executions.create(request, 'personal', 'lead', { message: 'work' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(4));
    const child = runs().find((run) => run.agentId === 'child')!;
    expect(await controller.cancelSubAgent(request, 'lead', execution.id, child.id as string)).toMatchObject({ status: 'cancelled' });
    expect(runs().find((run) => run.agentId === 'grandchild')!.status).toBe('cancelled');
    expect(runs().find((run) => run.agentId === 'sibling')!.status).toBe('running');
    finishSibling('Sibling finished');
    await vi.waitFor(async () => expect((await executions.get(request, 'personal', 'lead', execution.id)).status).toBe('completed'));
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('settles orphaned child records without launching or replaying work', async () => {
    const { collaboration, execute } = await setup();
    db.insert(agentExecutions).values({ id: 'orphan', agentId: 'lead', workspaceId: 'workspace_personal', status: 'running' }).run();
    for (const [id, parentRunId] of [['root', null], ['child-run', 'root'], ['grandchild-run', 'child-run'], ['sibling-run', 'root']] as const) {
      db.insert(auditLogs).values({ id, workspaceId: 'workspace_personal', resource: 'orphan', action: 'agent.invocation', metadata: { id, parentRunId, agentId: 'child', status: id === 'child-run' ? 'paused' : 'running', output: 'Saved evidence' } }).run();
    }
    await collaboration.controlInstance('workspace_personal', 'orphan', 'child-run', 'cancel');
    expect(runs().filter((run) => ['child-run', 'grandchild-run'].includes(run.id as string))).toEqual([
      expect.objectContaining({ status: 'cancelled', output: 'Saved evidence' }),
      expect.objectContaining({ status: 'cancelled', output: 'Saved evidence' }),
    ]);
    expect(runs().filter((run) => ['root', 'sibling-run'].includes(run.id as string)).every((run) => run.status === 'running')).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});
