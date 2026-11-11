import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerService } from './codex-app-server.service';

describe('CodexAppServerService.captureLaunch', () => {
  const service = new CodexAppServerService({} as never);

  it.each([null, 'gpt-6-luna', 'provider/model'])('uses the built-in command for model %s without plugin configuration', async (model) => {
    expect(await service.captureLaunch(model)).toEqual({ executor: 'codex', commandArguments: ['codex'], model });
  });
});

// A JSON-RPC peer exercises the real adapter without launching a model-backed process.
function rpcPeer(control?: { method: string; params: Record<string, unknown> }, notifications: unknown[] = [], turnStatus = 'completed', options: { holdTurn?: boolean; holdInterrupt?: boolean } = {}) {
  const sent: Array<{ id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown }> = [];
  let receive!: (event: { type: string; data: string }) => void;
  let complete!: (value: { status: string }) => void;
  const completion = new Promise<{ status: string }>((resolve) => { complete = resolve; });
  const emit = (message: unknown) => receive({ type: 'stdout', data: `${JSON.stringify(message)}\n` });
  let interruptId: number | undefined;
  let cancelled = false;
  const finish = () => {
    emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { id: 'answer', type: 'agentMessage', text: 'Done' } } });
    emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: turnStatus } } });
  };
  const commands = {
    openStdioProcess: async (_args: unknown, _cwd: unknown, _env: unknown, listener: typeof receive) => {
      receive = listener;
      return {
        executionId: 'command-1', completion,
        write: async (line: string) => {
          const message = JSON.parse(line);
          sent.push(message);
          queueMicrotask(() => {
            if (message.method === 'initialize') emit({ id: message.id, result: { userAgent: 'codex/0.163.0' } });
            if (message.method === 'thread/start' || message.method === 'thread/resume') emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
            if (message.method === 'turn/start') {
              emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
              for (const notification of notifications) emit(notification);
              if (control) emit({ id: 'control-1', method: control.method, params: { threadId: 'thread-1', turnId: 'turn-1', ...control.params } });
              else if (!options.holdTurn) finish();
            }
            if (message.id === 'control-1' && message.result) finish();
            if (message.method === 'turn/interrupt') {
              interruptId = message.id;
              if (!options.holdInterrupt) emit({ id: message.id, result: {} });
            }
          });
        },
        close: async () => { complete({ status: 'succeeded' }); },
      };
    },
    cancel: async () => { cancelled = true; complete({ status: 'cancelled' }); },
  };
  return { sent, finish, acknowledgeInterrupt: () => emit({ id: interruptId, result: {} }), wasCancelled: () => cancelled, crash: () => complete({ status: 'failed' }), service: new CodexAppServerService(commands as never) };
}

function runtimeRequest(): import('./project-executor.types').ProjectExecutorRequest {
  return { owner: 'agent', workspaceId: 'workspace', launch: { executor: 'codex', commandArguments: ['codex'], model: null }, model: null, systemPrompt: 'WorkLite', input: 'Continue', projectDirectory: '/tmp', skills: [], mcpServers: [], signal: new AbortController().signal };
}

const prepared = { directory: '/tmp/materialized', systemPrompt: 'WorkLite', mcpServers: [] };

const usageUpdate = (total: Record<string, unknown>, threadId = 'thread-1') => ({
  method: 'thread/tokenUsage/updated', params: { threadId, turnId: 'turn-1', tokenUsage: { total, last: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } },
});

describe('Codex executor-reported token usage', () => {
  it('reads cumulative usage with an empty model, ignores foreign threads and duplicate notifications, and keeps cache inside input', async () => {
    const total = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 80, cacheWriteInputTokens: 5, reasoningOutputTokens: 10 };
    const peer = rpcPeer(undefined, [usageUpdate({ inputTokens: 30, outputTokens: 5, totalTokens: 35 }), usageUpdate(total), usageUpdate(total), usageUpdate({ totalTokens: 999 }, 'other-thread')]);
    const activities: import('./project-executor.types').ProjectExecutorActivity[] = [];
    await peer.service.execute({ ...runtimeRequest(), onEvent: (event) => { activities.push(event); } }, prepared);
    const usages = activities.filter((event) => event.usage);
    expect(usages).toHaveLength(2);
    expect(usages.at(-1)).toMatchObject({ phase: 'codex.usage', commandExecutionId: 'command-1', threadId: 'thread-1', turnId: 'turn-1',
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 80, cacheCreationTokens: 5 } });
    expect(peer.sent.find((message) => message.method === 'thread/start')?.params?.model).toBeUndefined();
  });

  it.each(['failed', 'interrupted'])('waits for the final usage persistence before returning a %s turn', async (status) => {
    const peer = rpcPeer(undefined, [usageUpdate({ inputTokens: 10, outputTokens: 2 })], status);
    const saved: unknown[] = [];
    await expect(peer.service.execute({ ...runtimeRequest(), onEvent: async (event) => {
      if (event.usage) { await Promise.resolve(); saved.push(event.usage); }
    } }, prepared)).rejects.toThrow(status === 'failed' ? 'turn failed' : 'turn was interrupted');
    expect(saved).toEqual([{ inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: null, cacheCreationTokens: null }]);
  });

  it('preserves zero, leaves unreported counters unknown and discards invalid counts', async () => {
    const peer = rpcPeer(undefined, [usageUpdate({ inputTokens: -1, outputTokens: '4', totalTokens: 1.5 }), usageUpdate({ inputTokens: 0, outputTokens: 0 })]);
    const saved: unknown[] = [];
    await peer.service.execute({ ...runtimeRequest(), onEvent: (event) => { if (event.usage) saved.push(event.usage); } }, prepared);
    expect(saved).toEqual([{ inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: null, cacheCreationTokens: null }]);
  });
});

it('rejects shell syntax in a historical launch before opening the app server', async () => {
  const peer = rpcPeer();
  await expect(peer.service.execute({ ...runtimeRequest(), model: 'provider/model', launch: { executor: 'codex', commandArguments: ['codex; echo unsafe'], model: 'provider/model' } }, prepared)).rejects.toThrow('without shell syntax');
  expect(peer.sent).toEqual([]);
});

describe('Codex app-server durable sessions', () => {
  it('waits for native interrupt acknowledgement and turn completion before stopping the transport', async () => {
    const peer = rpcPeer(undefined, [], 'interrupted', { holdTurn: true, holdInterrupt: true });
    const controller = new AbortController();
    let ready = false;
    const running = peer.service.execute({ ...runtimeRequest(), signal: controller.signal,
      runtimeSession: { onSession: async () => {} }, onEvent: (event) => { if (event.phase === 'codex.turn_started') ready = true; },
    }, prepared);
    const stopped = expect(running).rejects.toThrow('New direction');
    await vi.waitFor(() => expect(ready).toBe(true));
    controller.abort(new Error('New direction'));
    await vi.waitFor(() => expect(peer.sent.some((message) => message.method === 'turn/interrupt')).toBe(true));
    expect(peer.wasCancelled()).toBe(false);
    peer.acknowledgeInterrupt();
    await Promise.resolve();
    expect(peer.wasCancelled()).toBe(false);
    peer.finish();
    await stopped;
    expect(peer.wasCancelled()).toBe(true);
    expect(peer.sent.find((message) => message.method === 'turn/interrupt')?.params).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
  });

  it('creates a persisted thread and resumes it for the next turn', async () => {
    const first = rpcPeer();
    let saved = '';
    await expect(first.service.execute({ ...runtimeRequest(), runtimeSession: { onSession: async (id) => { saved = id; } } }, prepared)).resolves.toBe('Done');
    expect(saved).toBe('thread-1');
    expect(first.sent.find((message) => message.method === 'thread/start')?.params?.ephemeral).toBe(false);
    const second = rpcPeer();
    await second.service.execute({ ...runtimeRequest(), runtimeSession: { resumeId: saved, onSession: async () => {} } }, prepared);
    expect(second.sent.find((message) => message.method === 'thread/resume')?.params?.threadId).toBe(saved);
    expect(second.sent.some((message) => message.method === 'thread/start')).toBe(false);
  });

  it('answers each native question in the same turn instead of interrupting it', async () => {
    const peer = rpcPeer({ method: 'item/tool/requestUserInput', params: { questions: [{ id: 'branch', question: 'Which branch?' }, { id: 'tests', question: 'Run tests?' }] } });
    const asked: string[] = [];
    await peer.service.execute({ ...runtimeRequest(), onQuestion: async (question) => { asked.push(question); return question === 'Which branch?' ? 'main' : 'yes'; } }, prepared);
    expect(asked).toEqual(['Which branch?', 'Run tests?']);
    expect(peer.sent.find((message) => message.id === 'control-1')?.result).toEqual({ answers: { branch: { answers: ['main'] }, tests: { answers: ['yes'] } } });
    expect(peer.sent.some((message) => message.method === 'turn/interrupt')).toBe(false);
  });

  it('returns the user approval decision to the native protocol', async () => {
    const peer = rpcPeer({ method: 'item/commandExecution/requestApproval', params: { command: 'npm test', reason: 'Run project tests' } });
    let description = '';
    await peer.service.execute({ ...runtimeRequest(), approvalPolicy: 'ask', onApproval: async (text) => { description = text; return false; } }, prepared);
    expect(description).toContain('npm test');
    expect(peer.sent.find((message) => message.id === 'control-1')?.result).toEqual({ decision: 'decline' });
    expect(peer.sent.find((message) => message.method === 'thread/start')?.params).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  });
});


it('does not hang on a pending question if the native process stops after completing the turn', async () => {
  const peer = rpcPeer({ method: 'item/tool/requestUserInput', params: { questions: [{ id: 'branch', question: 'Which branch?' }] } });
  let answer!: (value: string) => void;
  let asked!: () => void;
  const questionStarted = new Promise<void>((resolve) => { asked = resolve; });
  const running = peer.service.execute({ ...runtimeRequest(), onQuestion: () => { asked(); return new Promise<string>((resolve) => { answer = resolve; }); } }, prepared);
  const failure = expect(running).rejects.toThrow('stopped before completing');
  await questionStarted;
  peer.finish();
  peer.crash();
  await failure;
  answer('main');
});

it('passes use-site effort and fast into new and resumed Codex turns', async () => {
  for (const resumeId of [undefined, 'thread-1']) {
    const peer = rpcPeer();
    await peer.service.execute({ ...runtimeRequest(), model: 'provider/model', modelParameters: { reasoningEffort: 'high', serviceTier: 'fast' }, runtimeSession: { resumeId, onSession: async () => {} } }, prepared);
    expect(peer.sent.find((message) => message.method === 'turn/start')?.params).toMatchObject({ effort: 'high', serviceTier: 'priority' });
  }
});
