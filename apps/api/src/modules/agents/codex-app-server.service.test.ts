import { describe, expect, it } from 'vitest';
import { CodexAppServerService } from './codex-app-server.service';

describe('CodexAppServerService.captureLaunch', () => {
  const service = new CodexAppServerService({} as never);

  it('accepts a bare alias command word and keeps the configured model', async () => {
    const launch = await service.captureLaunch(['cxo'], 'gpt-6-luna');
    expect(launch).toEqual({ executor: 'codex', commandArguments: ['cxo'], model: 'gpt-6-luna' });
  });

  it('uses the native command and local config when no model is selected', async () => {
    const launch = await service.captureLaunch(['cx'], null);
    expect(launch.model).toBeNull();
    expect(launch.commandArguments).toEqual(['codex']);
  });

  it('keeps additional fixed arguments after the command word', async () => {
    const launch = await service.captureLaunch(['codex', '--some-flag'], 'provider/model');
    expect(launch.commandArguments).toEqual(['codex', '--some-flag']);
  });

  it('rejects an empty command', async () => {
    await expect(service.captureLaunch([], 'provider/model')).rejects.toThrow('A Codex command is required');
  });

  it('rejects a command word containing shell metacharacters', async () => {
    await expect(service.captureLaunch(['codex; rm -rf /'], 'provider/model')).rejects.toThrow('without shell syntax');
    await expect(service.captureLaunch(['codex && echo hi'], 'provider/model')).rejects.toThrow('without shell syntax');
    await expect(service.captureLaunch(['codex`whoami`'], 'provider/model')).rejects.toThrow('without shell syntax');
  });

  it('accepts a path-like command word', async () => {
    const launch = await service.captureLaunch(['/usr/local/bin/codex'], 'provider/model');
    expect(launch.commandArguments).toEqual(['/usr/local/bin/codex']);
  });
});

// A JSON-RPC peer exercises the real adapter without launching a model-backed process.
function rpcPeer(control?: { method: string; params: Record<string, unknown> }) {
  const sent: Array<{ id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown }> = [];
  let receive!: (event: { type: string; data: string }) => void;
  let complete!: (value: { status: string }) => void;
  const completion = new Promise<{ status: string }>((resolve) => { complete = resolve; });
  const emit = (message: unknown) => receive({ type: 'stdout', data: `${JSON.stringify(message)}\n` });
  const finish = () => {
    emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { id: 'answer', type: 'agentMessage', text: 'Done' } } });
    emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
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
              if (control) emit({ id: 'control-1', method: control.method, params: { threadId: 'thread-1', turnId: 'turn-1', ...control.params } });
              else finish();
            }
            if (message.id === 'control-1' && message.result) finish();
            if (message.method === 'turn/interrupt') emit({ id: message.id, result: {} });
          });
        },
        close: async () => { complete({ status: 'succeeded' }); },
      };
    },
    cancel: async () => { complete({ status: 'cancelled' }); },
  };
  return { sent, finish, crash: () => complete({ status: 'failed' }), service: new CodexAppServerService(commands as never) };
}

function runtimeRequest(): import('./project-executor.types').ProjectExecutorRequest {
  return { owner: 'agent', workspaceId: 'workspace', launch: { executor: 'codex', commandArguments: ['codex'], model: null }, model: null, systemPrompt: 'WorkLite', input: 'Continue', projectDirectory: '/tmp', skills: [], mcpServers: [], signal: new AbortController().signal };
}

const prepared = { directory: '/tmp/materialized', systemPrompt: 'WorkLite', mcpServers: [] };

describe('Codex app-server durable sessions', () => {
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
