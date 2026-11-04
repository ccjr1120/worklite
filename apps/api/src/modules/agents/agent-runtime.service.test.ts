// @vitest-environment node
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, agentExecutions, agentRuntimeSessions, agentRuntimeRuns, agentRuntimeInteractions, agentRuntimeEvents, createDb, initializeDatabase, type Database } from '@worklite/db';
import { AgentRuntimeService } from './agent-runtime.service';
import type { ProjectExecutorRequest } from './project-executor.types';

let db: Database;
let root: string;
let runtime: AgentRuntimeService;
const workspaceId = 'workspace_personal';
const sessionId = 'aex_runtime';

afterEach(async () => {
  await runtime?.onModuleDestroy();
  db?.$client.close();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function setup(execute: (request: ProjectExecutorRequest) => Promise<string>) {
  root = await mkdtemp(join(tmpdir(), 'worklite-runtime-test-'));
  vi.stubEnv('WORKLITE_AGENT_RUNTIME_DIR', root);
  db = createDb(':memory:');
  await initializeDatabase(db);
  db.insert(agents).values({ id: 'agt_runtime', workspaceId, name: 'Test', responsibility: '', model: '' }).run();
  db.insert(agentExecutions).values({ id: sessionId, workspaceId, agentId: 'agt_runtime' }).run();
  const executor = {
    captureLaunch: vi.fn(async (engine: 'claude' | 'codex', model: string | null) => ({ executor: engine, model, commandArguments: [] })),
    requireModel: vi.fn(async () => {}),
    execute: vi.fn(execute),
    capabilities: vi.fn(() => ({ resume: true, steer: true, liveQuestions: true })),
  };
  runtime = new AgentRuntimeService(db, executor as never);
  return executor;
}

const request = (signal = new AbortController().signal) => ({
  sessionId, workspaceId, runtime: 'codex' as const, model: null,
  projectDirectory: '/tmp', systemPrompt: 'test', input: 'first message', skills: [], mcpServers: [], signal,
  onInteraction: vi.fn(async (_id: string, _question: string) => {}),
});

describe('AgentRuntimeService', () => {
  it('resumes native context using a stable resource directory and only the new input', async () => {
    const executor = await setup(async (request) => {
      await request.runtimeSession!.onSession('native-thread-1');
      await request.onTextDelta?.('done');
      await request.onEvent?.({ phase: 'codex.item_completed', itemId: 'item-1', summary: 'not archived', text: 'not archived' });
      return 'done';
    });
    await expect(runtime.executeTurn(request())).resolves.toBe('done');
    await runtime.executeTurn({ ...request(), input: 'second message' });
    const [first, second] = executor.execute.mock.calls.map(([call]) => call);
    expect(first.runtimeSession?.resumeId).toBeUndefined();
    expect(second.runtimeSession?.resumeId).toBe('native-thread-1');
    expect(second.resourceDirectory).toBe(first.resourceDirectory);
    expect(second.input).toBe('second message');
    expect(executor.captureLaunch).toHaveBeenCalledOnce();
    expect(db.select().from(agentRuntimeRuns).all().map((run) => run.status)).toEqual(['completed', 'completed']);
    const events = db.select().from(agentRuntimeEvents).all();
    expect(events.filter((event) => event.data.kind === 'settled')).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('not archived');
    expect(db.select().from(agentRuntimeSessions).get()?.status).toBe('idle');
  });

  it('answers a live question once without restarting the executor', async () => {
    const executor = await setup(async (request) => {
      await request.runtimeSession!.onSession('thread');
      return (await request.onQuestion!('Which branch?'))!;
    });
    const turn = request();
    const running = runtime.executeTurn(turn);
    await vi.waitFor(() => expect(turn.onInteraction).toHaveBeenCalledOnce());
    const interaction = db.select().from(agentRuntimeInteractions).get()!;
    expect(db.select().from(agentRuntimeRuns).get()?.status).toBe('waiting_for_input');
    await expect(runtime.executeTurn(turn)).rejects.toThrow('already running');
    await expect(runtime.answer('wrong-workspace', sessionId, interaction.id, 'main', () => {})).rejects.toThrow('not found');
    await runtime.answer(workspaceId, sessionId, interaction.id, 'main', () => {});
    await expect(running).resolves.toBe('main');
    await expect(runtime.answer(workspaceId, sessionId, interaction.id, 'again', () => {})).rejects.toThrow('no longer active');
    expect(executor.execute).toHaveBeenCalledOnce();
    expect(db.select().from(agentRuntimeInteractions).get()).toMatchObject({ status: 'answered', answer: 'main' });
  });

  it('cancels a pending question and releases the session', async () => {
    await setup(async (request) => (await request.onQuestion!('Waiting'))!);
    const controller = new AbortController();
    const turn = request(controller.signal);
    const running = runtime.executeTurn(turn);
    const failure = expect(running).rejects.toThrow('stop');
    await vi.waitFor(() => expect(turn.onInteraction).toHaveBeenCalledOnce());
    controller.abort(new Error('stop'));
    await failure;
    expect(db.select().from(agentRuntimeRuns).get()?.status).toBe('cancelled');
    expect(db.select().from(agentRuntimeInteractions).get()?.status).toBe('cancelled');
    const resourceDirectory = db.select().from(agentRuntimeSessions).get()!.resourceDirectory;
    await runtime.closeSession(workspaceId, sessionId);
    await expect(stat(resourceDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(runtime.executeTurn(request())).rejects.toThrow('closed');
  });

  it('denies approvals unless explicitly approved and records the interaction kind', async () => {
    await setup(async (request) => String(await request.onApproval!('Execute command?')));
    const turn = request();
    const running = runtime.executeTurn({ ...turn, approvalPolicy: 'ask' });
    await vi.waitFor(() => expect(turn.onInteraction).toHaveBeenCalledOnce());
    const interaction = db.select().from(agentRuntimeInteractions).get()!;
    expect(interaction.kind).toBe('approval');
    await runtime.answer(workspaceId, sessionId, interaction.id, 'decline', () => {});
    await expect(running).resolves.toBe('false');
  });

  it('marks lost runs and waiters interrupted at restart without executing work', async () => {
    const executor = await setup(async () => 'done');
    await runtime.executeTurn(request());
    db.insert(agentRuntimeRuns).values({ id: 'lost-run', sessionId, status: 'waiting_for_input' }).run();
    db.insert(agentRuntimeInteractions).values({ id: 'lost-question', runId: 'lost-run', question: 'q', status: 'pending' }).run();
    db.update(agentExecutions).set({ status: 'waiting_for_input' }).where(eq(agentExecutions.id, sessionId)).run();
    await runtime.onModuleInit();
    expect(executor.execute).toHaveBeenCalledOnce();
    expect(db.select().from(agentRuntimeRuns).where(eq(agentRuntimeRuns.id, 'lost-run')).get()?.status).toBe('interrupted');
    expect(db.select().from(agentRuntimeInteractions).get()?.status).toBe('interrupted');
    expect(db.select().from(agentExecutions).get()).toMatchObject({ status: 'failed', errorCode: 'restarted', pendingQuestion: null });
  });

  it('delivers steering only through a live supported turn', async () => {
    let release!: (output: string) => void;
    const deliver = vi.fn(async (text: string) => { release(text); return true; });
    await setup(async (request) => {
      request.steerPort!.deliver = deliver;
      return new Promise<string>((resolve) => { release = resolve; });
    });
    const running = runtime.executeTurn(request());
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(runtime.steer('wrong-workspace', sessionId, 'stop')).rejects.toThrow('not found');
    await expect(runtime.steer(workspaceId, sessionId, 'Only investigate')).resolves.toBe(true);
    await expect(running).resolves.toBe('Only investigate');
    await expect(runtime.steer(workspaceId, sessionId, 'Too late')).resolves.toBe(false);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('does not restart or switch backends after a failed execution', async () => {
    const executor = await setup(async () => { throw new Error('engine failed'); });
    await expect(runtime.executeTurn(request())).rejects.toThrow('engine failed');
    expect(executor.execute).toHaveBeenCalledOnce();
    expect(db.select().from(agentRuntimeRuns).get()?.status).toBe('failed');
    await expect(runtime.executeTurn({ ...request(), runtime: 'claude' })).rejects.toThrow('cannot switch runtimes');
    expect(executor.execute).toHaveBeenCalledOnce();
  });
});
