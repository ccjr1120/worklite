import { agentExecutionColumns, agentExecutions, agentRuntimeRuns, createDb, initializeDatabase, type Database } from '@worklite/db';
// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { eq } from 'drizzle-orm';

import { AgentExecutionsService } from './agent-executions.service';
import { AgentsService } from './agents.service';
import { AgentRuntimeService } from './agent-runtime.service';
import { AgentHistoryService } from './agent-history.service';
import { WorkspaceService } from '../teams/teams.service';
import type { ProjectExecutorRequest } from './project-executor.types';

const request = {} as Request;
let db: Database;
let root: string;
let runtime: AgentRuntimeService;
let executions: AgentExecutionsService;

afterEach(async () => {
  await runtime?.onModuleDestroy();
  if (executions) await vi.waitFor(() => expect((executions as unknown as { scheduledExecutions: Set<string> }).scheduledExecutions.size).toBe(0));
  db?.$client.close();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup(execute: (request: ProjectExecutorRequest) => Promise<string>, runtimeKind: 'codex' | 'claude' = 'codex') {
  root = await mkdtemp(join(tmpdir(), 'worklite-agent-test-'));
  vi.stubEnv('WORKLITE_AGENT_RUNTIME_DIR', join(root, 'sessions'));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
  db = createDb(':memory:');
  await initializeDatabase(db);
  const workspaces = new WorkspaceService(db);
  const resources = { reconcileWorkspaceSkills: async () => {}, agentMcpRuntimes: async () => [] };
  const agents = new AgentsService(db, workspaces, resources as never);
  const adapter = { requireModel: async () => {}, captureLaunch: async (executor: string, model: string | null) => ({ executor, model, commandArguments: [] }), execute: vi.fn(execute) };
  runtime = new AgentRuntimeService(db, adapter as never);
  const unused = {} as never;
  executions = new AgentExecutionsService(db, workspaces, resources as never, unused, unused, unused, unused, unused, { list: () => [] } as never, unused, unused, { notify: () => {} } as never, runtime);
  const agent = await agents.create(request, 'personal', { name: 'Runtime Agent', responsibility: '', systemPrompt: 'Original instructions', runtime: { kind: runtimeKind, projectDirectory: root }, providerId: null, model: '', skillIds: [], mcpServerIds: [] });
  return { agents, agent, adapter };
}

async function settled(id: string) {
  await vi.waitFor(() => expect((executions as unknown as { scheduledExecutions: Set<string> }).scheduledExecutions.has(id)).toBe(false));
  return db.select(agentExecutionColumns).from(agentExecutions).where(eq(agentExecutions.id, id)).get()!;
}

describe('runtime-backed Agent execution API', () => {
  it.each(['codex', 'claude'] as const)('exposes %s lead reply chunks and tool work before the turn completes', async (runtimeKind) => {
    const partial = '验证结果'.repeat(1000); // Large enough to exercise the packed event column.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let notify!: () => void;
    const emitted = new Promise<void>((resolve) => { notify = resolve; });
    const { agent } = await setup(async (request) => {
      await request.runtimeSession!.onSession('saved-thread');
      await request.onTextDelta?.('我先检查测试');
      await request.onEvent?.({ phase: runtimeKind === 'codex' ? 'codex.item_completed' : 'claude.agent_message', itemType: runtimeKind === 'codex' ? 'agentMessage' : 'agent_message', text: '我先检查测试' });
      await request.onEvent?.({ phase: runtimeKind === 'codex' ? 'codex.item_started' : 'claude.tool_started', itemId: 'tool', itemType: runtimeKind === 'codex' ? 'commandExecution' : 'Bash', summary: 'pnpm test' });
      await request.onTextDelta?.(partial);
      notify();
      await gate;
      return '验证结果已确认';
    }, runtimeKind);
    const execution = await executions.create(request, 'personal', agent.id, { message: '检查测试' });
    try {
      await emitted;
      const history = new AgentHistoryService(db, new WorkspaceService(db));
      // The existing text batch flushes independently of the engine's turn completion.
      await vi.waitFor(async () => {
        const detail = await history.detail(request, agent.id, execution.id);
        expect(detail.run.currentActivity).toEqual({ phase: 'tool', toolName: 'pnpm test' });
        expect(detail.run.activities).toEqual([
          expect.objectContaining({ kind: 'message', text: '我先检查测试' }),
          expect.objectContaining({ kind: 'tool', summary: 'pnpm test', status: 'running' }),
          expect.objectContaining({ kind: 'message', text: partial }),
        ]);
      });
    } finally { release(); }
    expect((await settled(execution.id)).displayMessages.at(-1)?.content).toBe('验证结果已确认');
  });

  it('continues the captured backend and instructions after draft settings change', async () => {
    const { agents, agent, adapter } = await setup(async (request) => {
      await request.runtimeSession!.onSession('saved-thread');
      return `Reply: ${request.input}`;
    });
    const execution = await executions.create(request, 'personal', agent.id, { message: 'hello' });
    expect((await settled(execution.id)).status).toBe('completed');
    await agents.update(request, 'personal', agent.id, { runtime: { kind: 'claude', projectDirectory: root }, systemPrompt: 'Changed instructions' });
    await executions.continue(request, 'personal', agent.id, execution.id, { message: 'continue' });
    const row = await settled(execution.id);
    expect(row.status).toBe('completed');
    expect(row.displayMessages.map((message) => message.content)).toEqual(['hello', 'Reply: hello', 'continue', 'Reply: continue']);
    const second = adapter.execute.mock.calls[1][0];
    expect(second.launch.executor).toBe('codex');
    expect(second.systemPrompt).toBe('Original instructions');
    expect(second.runtimeSession?.resumeId).toBe('saved-thread');
    expect(second.input).toBe('continue');
    expect(db.select().from(agentRuntimeRuns).all()).toHaveLength(2);
  });

  it('routes the existing answers API back into the live session', async () => {
    const { agent, adapter } = await setup(async (request) => {
      await request.runtimeSession!.onSession('saved-thread');
      return `Selected: ${await request.onQuestion!('Which branch?')}`;
    });
    const execution = await executions.create(request, 'personal', agent.id, { message: 'work' });
    await vi.waitFor(async () => expect((await executions.get(request, 'personal', agent.id, execution.id)).status).toBe('waiting_for_input'));
    const waiting = await executions.get(request, 'personal', agent.id, execution.id);
    await executions.answer(request, 'personal', agent.id, execution.id, { questionId: waiting.pendingQuestion!.id, answer: 'main' });
    const row = await settled(execution.id);
    expect(row.status).toBe('completed');
    expect(row.displayMessages.at(-1)?.content).toBe('Selected: main');
    expect(row.pendingQuestion).toBeNull();
    expect(adapter.execute).toHaveBeenCalledOnce();
  });

  it('cancels waiting work, refuses blind retry and resumes only for a new explicit message', async () => {
    let attempt = 0;
    const { agent, adapter } = await setup(async (request) => {
      await request.runtimeSession!.onSession('saved-thread');
      if (++attempt === 1) return (await request.onQuestion!('Waiting'))!;
      return 'Continued';
    });
    const execution = await executions.create(request, 'personal', agent.id, { message: 'work' });
    await vi.waitFor(async () => expect((await executions.get(request, 'personal', agent.id, execution.id)).status).toBe('waiting_for_input'));
    await executions.cancel(request, 'personal', agent.id, execution.id);
    expect((await settled(execution.id)).status).toBe('cancelled');
    await executions.continue(request, 'personal', agent.id, execution.id, { message: 'Inspect prior work, then continue' });
    expect((await settled(execution.id)).status).toBe('completed');
    expect(adapter.execute.mock.calls[1][0].runtimeSession?.resumeId).toBe('saved-thread');
  });

  it('fails a waiting conversation and retires its question when the backend exits', async () => {
    const { agent } = await setup(async (request) => {
      const answer = request.onQuestion!('Waiting');
      void answer.catch(() => undefined);
      await Promise.resolve();
      throw new Error('Backend exited during question');
    });
    const execution = await executions.create(request, 'personal', agent.id, { message: 'work' });
    const row = await settled(execution.id);
    expect(row.status).toBe('failed');
    expect(row.pendingQuestion).toBeNull();
    expect(row.error).toContain('Backend exited during question');
    await vi.waitFor(() => expect((runtime as unknown as { answers: Map<string, unknown> }).answers.size).toBe(0));
  });

  it('closes resources and rejects further messages before starting another run', async () => {
    const { agent, adapter } = await setup(async () => 'done');
    const execution = await executions.create(request, 'personal', agent.id, { message: 'work' });
    await settled(execution.id);
    await executions.closeRuntimeSession(request, 'personal', agent.id, execution.id);
    await expect(executions.continue(request, 'personal', agent.id, execution.id, { message: 'again' })).rejects.toThrow('closed');
    expect(adapter.execute).toHaveBeenCalledOnce();
    expect(db.select(agentExecutionColumns).from(agentExecutions).where(eq(agentExecutions.id, execution.id)).get()?.status).toBe('completed');
  });

  it('records runtime failures and requires a new instruction instead of replaying the failed turn', async () => {
    const { agent, adapter } = await setup(async () => { throw new Error('Backend unavailable'); });
    const execution = await executions.create(request, 'personal', agent.id, { message: 'work' });
    const row = await settled(execution.id);
    expect(row.status).toBe('failed');
    expect(row.error).toContain('Backend unavailable');
    await expect(executions.retry(request, 'personal', agent.id, execution.id)).rejects.toThrow('cannot be replayed');
    expect(adapter.execute).toHaveBeenCalledOnce();
  });

  it('retains public text streamed before a backend failure', async () => {
    const { agent } = await setup(async (request) => {
      await request.onTextDelta?.('已经检查了配置，准备运行测试');
      throw new Error('Backend disconnected');
    });
    const execution = await executions.create(request, 'personal', agent.id, { message: '检查实现' });
    expect((await settled(execution.id)).status).toBe('failed');
    const detail = await new AgentHistoryService(db, new WorkspaceService(db)).detail(request, agent.id, execution.id);
    expect(detail.run.activities).toEqual([expect.objectContaining({ kind: 'message', text: '已经检查了配置，准备运行测试' })]);
    expect(detail.run.currentActivity).toBeNull();
  });
});

it('captures the selected model parameters for a runtime invocation and its continuation', async () => {
  const { agents, agent, adapter } = await setup(async (request) => {
    await request.runtimeSession!.onSession('saved-thread');
    return 'Done';
  });
  const modelParameters = { reasoningEffort: 'high' as const, serviceTier: 'fast' as const };
  await agents.update(request, 'personal', agent.id, { modelParameters });
  const execution = await executions.create(request, 'personal', agent.id, { message: 'Work' });
  expect((await settled(execution.id)).status).toBe('completed');
  expect(adapter.execute.mock.calls[0]?.[0].modelParameters).toEqual(modelParameters);
  await agents.update(request, 'personal', agent.id, { modelParameters: { reasoningEffort: 'low' } });
  await executions.continue(request, 'personal', agent.id, execution.id, { message: 'Continue' });
  expect((await settled(execution.id)).status).toBe('completed');
  expect(adapter.execute.mock.calls[1]?.[0].modelParameters).toEqual(modelParameters);
  const next = await executions.create(request, 'personal', agent.id, { message: 'New task' });
  expect((await settled(next.id)).status).toBe('completed');
  expect(adapter.execute.mock.calls[2]?.[0].modelParameters).toEqual({ reasoningEffort: 'low' });
});

it('captures a runtime model candidate and its own parameters from collaboration settings', async () => {
  const { agents, agent, adapter } = await setup(async () => 'Done');
  const parameters = { reasoningEffort: 'high' as const, serviceTier: 'fast' as const };
  await agents.update(request, 'personal', agent.id, { collaboration: { subAgentIds: [], capabilities: [], publicModels: ['provider/model'], modelParameters: { 'provider/model': parameters } } });
  const execution = await executions.create(request, 'personal', agent.id, { message: 'Work' });
  expect((await settled(execution.id)).status).toBe('completed');
  expect(adapter.execute.mock.calls[0]?.[0]).toMatchObject({ model: 'provider/model', modelParameters: parameters });
});
