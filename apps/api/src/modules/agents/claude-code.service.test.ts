import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanUseTool, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeCodeError, ClaudeCodeService } from './claude-code.service';
import type { PreparedProjectExecution, ProjectExecutorRequest } from './project-executor.types';

// The Agent SDK's query() is mocked at the module boundary: these tests drive the executor through
// the same SDKMessage shapes the real SDK emits (confirmed against @anthropic-ai/claude-agent-sdk
// 0.3.316 with a real Gateway session; see docs/claude-agent-sdk-implementation.md) and assert on
// canUseTool behavior, activity ordering, and the mapped options, without a live SDK or network call.
const captured = vi.hoisted(() => ({ lastOptions: undefined as Options | undefined, lastCanUseTool: undefined as CanUseTool | undefined, lastPrompt: undefined as AsyncIterable<unknown> | undefined }));
const fakeQuery = vi.hoisted(() => ({ impl: undefined as ((options: Options) => FakeQuery) | undefined }));

// A queue-based fake. By default it ends naturally once its initial message list is drained,
// matching how the real SDK's non-persisted single-turn stream ends on its own. `interactive: true`
// keeps it open past that so a test can call canUseTool (as the real SDK would, mid-stream, as a
// side effect of a tool_use the fake has already yielded) and only then push() the message that
// depends on canUseTool's answer, or let close() end it like a real cancel would.
class FakeQuery implements AsyncIterable<SDKMessage> {
  closed = false;
  interrupted = false;
  private readonly pending: SDKMessage[] = [];
  private readonly interactive: boolean;
  private wake?: () => void;
  constructor(initial: SDKMessage[] = [], options: { interactive?: boolean } = {}) {
    this.pending.push(...initial);
    this.interactive = options.interactive ?? false;
  }
  push(message: SDKMessage): void { this.pending.push(message); this.wake?.(); this.wake = undefined; }
  async interrupt() { this.interrupted = true; return undefined; }
  close() { this.closed = true; this.wake?.(); this.wake = undefined; }
  setPermissionMode = vi.fn();
  setMcpPermissionModeOverride = vi.fn();
  setModel = vi.fn();
  setMaxThinkingTokens = vi.fn();
  setMcpServers = vi.fn();
  streamInput = vi.fn();
  stopTask = vi.fn();
  backgroundTasks = vi.fn();
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.pending.length) { yield this.pending.shift()!; continue; }
      if (this.closed) return;
      if (!this.interactive) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

// The WorkLite Claude config directory lives under homedir(), which follows HOME; tests that
// inspect it point HOME at a throwaway directory.
function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'worklite-home-'));
  const saved = process.env.HOME;
  process.env.HOME = home;
  return run(home).finally(() => {
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });
}

// execute() prepares the config directory before it calls query(); wait for that call.
const queryStarted = () => vi.waitFor(() => { if (!captured.lastCanUseTool) throw new Error('query() not called yet'); });

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { options: Options; prompt: AsyncIterable<unknown> }) => {
    captured.lastOptions = params.options;
    captured.lastCanUseTool = params.options.canUseTool;
    captured.lastPrompt = params.prompt;
    return fakeQuery.impl!(params.options);
  },
}));

afterEach(() => {
  captured.lastOptions = undefined;
  captured.lastCanUseTool = undefined;
  captured.lastPrompt = undefined;
  fakeQuery.impl = undefined;
  vi.clearAllMocks();
});

function systemInit(sessionId = 'session_fake'): SDKMessage {
  return { type: 'system', subtype: 'init', session_id: sessionId, claude_code_version: '2.1.316', apiKeySource: 'none', cwd: '/', tools: [], mcp_servers: [], model: 'claude-sonnet-5', permissionMode: 'bypassPermissions', slash_commands: [], output_style: 'default', skills: [], plugins: [], uuid: 'u1' } as unknown as SDKMessage;
}

function assistantText(text: string): SDKMessage {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null, uuid: 'u2', session_id: 's' } as unknown as SDKMessage;
}

function assistantToolUse(id: string, name: string, input: Record<string, unknown>): SDKMessage {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null, uuid: 'u3', session_id: 's' } as unknown as SDKMessage;
}

function userToolResult(toolUseId: string, isError = false): SDKMessage {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError }] }, parent_tool_use_id: null, uuid: 'u4', session_id: 's' } as unknown as SDKMessage;
}

function resultSuccess(result: string): SDKMessage {
  return { type: 'result', subtype: 'success', is_error: false, result, duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: null, total_cost_usd: 0, usage: {} as never, modelUsage: {}, permission_denials: [], uuid: 'u5', session_id: 's' } as unknown as SDKMessage;
}

function resultError(subtype: 'error_during_execution' | 'error_max_turns', errors: string[] = []): SDKMessage {
  return { type: 'result', subtype, is_error: true, duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: null, total_cost_usd: 0, usage: {} as never, modelUsage: {}, permission_denials: [], errors, uuid: 'u6', session_id: 's' } as unknown as SDKMessage;
}

function buildRequest(overrides: Partial<ProjectExecutorRequest> = {}): { request: ProjectExecutorRequest; prepared: PreparedProjectExecution } {
  const request: ProjectExecutorRequest = {
    owner: 'chat',
    workspaceId: 'ws',
    launch: { executor: 'claude', commandArguments: [], baseUrl: 'http://127.0.0.1:23392', model: null },
    model: null,
    systemPrompt: 'system',
    input: 'goal',
    projectDirectory: '/tmp/project',
    skills: [],
    mcpServers: [],
    signal: new AbortController().signal,
    ...overrides,
  };
  return { request, prepared: { directory: '/tmp/exec', systemPrompt: 'system', mcpServers: [] } };
}

function service(): ClaudeCodeService {
  const mcp = { discover: async () => [] };
  return new ClaudeCodeService(mcp as never);
}

describe('ClaudeCodeService', () => {
  it('persists Coder sessions without resuming the session for another task attempt', async () => {
    fakeQuery.impl = () => new FakeQuery([systemInit('saved-session'), resultSuccess('done')]);
    const { request, prepared } = buildRequest({ owner: 'coder', model: 'provider/model' });
    await service().execute(request, prepared);
    expect(captured.lastOptions).toMatchObject({ persistSession: true, model: 'provider/model' });
    expect(captured.lastOptions).not.toHaveProperty('resume');
    const firstMessage = await captured.lastPrompt![Symbol.asyncIterator]().next();
    expect(firstMessage.value).toMatchObject({ message: { content: request.input } });
  });

  it('records the session activity even when the SDK turn fails immediately', async () => {
    fakeQuery.impl = () => new FakeQuery([systemInit('failed-session'), resultError('error_during_execution', ['HTTP 500'])]);
    const events: Array<{ phase: string; sessionId?: string }> = [];
    const { request, prepared } = buildRequest({ owner: 'coder', onEvent: async (activity) => { await Promise.resolve(); events.push(activity); } });
    await expect(service().execute(request, prepared)).rejects.toThrow('HTTP 500');
    expect(events).toContainEqual(expect.objectContaining({ phase: 'claude.session_started', sessionId: 'failed-session' }));
  });

  it('maps the message stream to activities in order and returns the final text', async () => {
    fakeQuery.impl = () => new FakeQuery([
      systemInit('session_123'),
      assistantToolUse('tool_1', 'Bash', { command: 'ls' }),
      userToolResult('tool_1'),
      assistantText('All done.'),
      resultSuccess('All done.'),
    ]);
    const events: Array<{ phase: string }> = [];
    const { request, prepared } = buildRequest({ onEvent: (activity) => { events.push(activity); } });
    const output = await service().execute(request, prepared);
    expect(output).toBe('All done.');
    expect(events.map((event) => event.phase)).toEqual([
      'claude.started', 'claude.session_started', 'claude.tool_started', 'claude.tool_completed', 'claude.agent_message', 'claude.completed',
    ]);
    expect(events[1]).toMatchObject({ sessionId: 'session_123' });
    expect(events[2]).toMatchObject({ itemId: 'tool_1', itemType: 'Bash', summary: 'ls' });
    expect(events[3]).toMatchObject({ itemId: 'tool_1', itemType: 'Bash' });
  });

  it('streams text deltas as they arrive', async () => {
    const delta: SDKMessage = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } }, parent_tool_use_id: null, uuid: 'd1', session_id: 's' } as unknown as SDKMessage;
    fakeQuery.impl = () => new FakeQuery([systemInit(), delta, assistantText('Hello.'), resultSuccess('Hello.')]);
    const deltas: string[] = [];
    const { request, prepared } = buildRequest({ onTextDelta: (text) => { deltas.push(text); } });
    await service().execute(request, prepared);
    expect(deltas).toEqual(['Hel']);
  });

  it('passes bypassPermissions, the claude_code system prompt preset and Gateway settings for a Gateway model', async () => {
    fakeQuery.impl = () => new FakeQuery([systemInit(), assistantText('ok'), resultSuccess('ok')]);
    const { request, prepared } = buildRequest({ model: 'pp-cc/claude-sonnet-5', correlation: { surface: 'chat_project_task', executor: 'claude' } });
    await service().execute(request, prepared);
    const options = captured.lastOptions!;
    expect(options.permissionMode).toBe('bypassPermissions');
    expect(options.allowDangerouslySkipPermissions).toBe(true);
    expect(options.persistSession).toBe(false);
    expect(options.cwd).toBe('/tmp/project');
    expect(options.model).toBe('pp-cc/claude-sonnet-5');
    expect(options.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code', append: 'system' });
    // 'project' is required for CLAUDE.md discovery in the task's working directory (confirmed
    // live against the SDK: omitting it silently drops project instructions).
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    const settingsEnv = (options.settings as { env: Record<string, string> }).env;
    expect(settingsEnv.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:23392');
    expect(settingsEnv.ANTHROPIC_AUTH_TOKEN).toBe('worklite');
    expect(settingsEnv.ANTHROPIC_CUSTOM_HEADERS).toContain('x-worklite-surface: chat_project_task');
    expect(settingsEnv.ANTHROPIC_CUSTOM_HEADERS).toContain('x-worklite-executor: claude');
  });

  it('omits Gateway env for a non-Gateway model but still sends attribution headers', async () => {
    fakeQuery.impl = () => new FakeQuery([systemInit(), assistantText('ok'), resultSuccess('ok')]);
    const { request, prepared } = buildRequest({ launch: { executor: 'claude', commandArguments: [], baseUrl: 'http://127.0.0.1:23392', model: 'opus' }, model: null });
    await service().execute(request, prepared);
    const settingsEnv = (captured.lastOptions!.settings as { env: Record<string, string> }).env;
    expect(settingsEnv.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(settingsEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(settingsEnv.ANTHROPIC_CUSTOM_HEADERS).toBeTruthy();
  });

  it('answers AskUserQuestion through the live onQuestion channel and keeps the same session', async () => {
    // The fake stream replays a fixed message list; it does not itself invoke canUseTool (the real
    // SDK does, as a side effect of the model's tool_use). canUseTool is driven directly here,
    // exactly as the SDK would call it, with `questions` on the input exactly as AskUserQuestion
    // sends it; the resolved answer carries the same `questions` array back plus `answers` keyed by
    // question text, the SDK's AskUserQuestion answer format (confirmed live against 0.3.316).
    let fake!: FakeQuery;
    fakeQuery.impl = () => (fake = new FakeQuery([systemInit()], { interactive: true }));
    const onQuestion = vi.fn(async (question: string) => { expect(question).toBe('Which approach?'); return 'A'; });
    const { request, prepared } = buildRequest({ onQuestion });
    const executed = service().execute(request, prepared);
    await queryStarted();
    const result = await captured.lastCanUseTool!('AskUserQuestion', { questions: [{ question: 'Which approach?' }] }, { signal: new AbortController().signal, toolUseID: 't', requestId: 'r1' });
    expect(onQuestion).toHaveBeenCalledWith('Which approach?');
    expect(result).toEqual({ behavior: 'allow', updatedInput: { questions: [{ question: 'Which approach?' }], answers: { 'Which approach?': 'A' } } });
    fake.push(resultSuccess('Picked A.'));
    expect(await executed).toBe('Picked A.');
  });

  it('denies AskUserQuestion without interrupt when no live channel exists, degrading to the waiting_for_input JSON contract', async () => {
    // Denying with interrupt:true triggers a confirmed SDK-side error on 0.3.316 (a spurious
    // "model not configured" 400 from a malformed follow-up request); the deny must omit it. The
    // model still writes a final assistant turn after a plain deny (confirmed live); the degrade
    // JSON replaces that text as the task's actual result, driven by canUseTool directly since the
    // fake stream (a fixed message list) does not itself invoke canUseTool as a side effect.
    let fake!: FakeQuery;
    fakeQuery.impl = () => (fake = new FakeQuery([systemInit()], { interactive: true }));
    const { request, prepared } = buildRequest();
    const executed = service().execute(request, prepared);
    await queryStarted();
    const result = await captured.lastCanUseTool!('AskUserQuestion', { questions: [{ question: 'Which approach?' }] }, { signal: new AbortController().signal, toolUseID: 't', requestId: 'r1' });
    expect(result).toEqual({ behavior: 'deny', message: 'WorkLite forwarded this question to the user. Stop and wait for the answer.' });
    expect((result as { interrupt?: boolean }).interrupt).toBeUndefined();
    fake.push(resultSuccess('Waiting on your answer to "Which approach?"'));
    expect(await executed).toBe(JSON.stringify({ status: 'waiting_for_input', pendingInput: { question: 'Which approach?' } }));
  });

  it('resolves the live question wait with no answer when the task signal aborts', async () => {
    fakeQuery.impl = () => new FakeQuery([systemInit()], { interactive: true });
    const controller = new AbortController();
    const onQuestion = () => new Promise<string>(() => { /* never resolves on its own */ });
    const { request, prepared } = buildRequest({ signal: controller.signal, onQuestion });
    const canUseToolPromise = (async () => {
      await service().execute(request, prepared).catch(() => undefined);
    })();
    await queryStarted();
    const pending = captured.lastCanUseTool!('AskUserQuestion', { questions: [{ question: 'Pick?' }] }, { signal: new AbortController().signal, toolUseID: 't', requestId: 'r1' });
    controller.abort(new Error('cancelled'));
    const result = await pending;
    expect(result).toMatchObject({ behavior: 'deny' });
    await canUseToolPromise;
  });

  it('converts an error result into a ClaudeCodeError without relying on exit codes or CLI strings', async () => {
    fakeQuery.impl = () => new FakeQuery([systemInit(), resultError('error_during_execution', ['boom'])]);
    const { request, prepared } = buildRequest();
    await expect(service().execute(request, prepared)).rejects.toThrow(ClaudeCodeError);
    await expect(service().execute(request, prepared)).rejects.toThrow(/boom/);
  });

  it('fails with a readable error when the stream ends with no result message', async () => {
    fakeQuery.impl = () => new FakeQuery([systemInit(), assistantText('partial')]);
    const { request, prepared } = buildRequest();
    await expect(service().execute(request, prepared)).rejects.toThrow(/stopped before completing/);
  });

  it('fails with a readable error on an empty successful result', async () => {
    fakeQuery.impl = () => new FakeQuery([systemInit(), resultSuccess('')]);
    const { request, prepared } = buildRequest();
    await expect(service().execute(request, prepared)).rejects.toThrow(/empty task result/);
  });

  it('interrupts and closes the session when the signal aborts mid-stream', async () => {
    let fake!: FakeQuery;
    fakeQuery.impl = () => { fake = new FakeQuery([systemInit(), assistantText('working')], { interactive: true }); return fake; };
    const controller = new AbortController();
    const { request, prepared } = buildRequest({ signal: controller.signal });
    const executed = service().execute(request, prepared);
    await queryStarted();
    controller.abort(new Error('cancelled by user'));
    await expect(executed).rejects.toThrow('cancelled by user');
    expect(fake.interrupted).toBe(true);
    expect(fake.closed).toBe(true);
  });

  it('closes the session after a normal completion', async () => {
    let fake!: FakeQuery;
    fakeQuery.impl = () => { fake = new FakeQuery([systemInit(), assistantText('ok'), resultSuccess('ok')]); return fake; };
    const { request, prepared } = buildRequest();
    await service().execute(request, prepared);
    expect(fake.closed).toBe(true);
  });

  it('runs Claude Code in WorkLite\'s own config directory without inheriting ANTHROPIC_* or CLAUDE_* variables', () => withHome(async (home) => {
    const saved = { url: process.env.ANTHROPIC_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN, session: process.env.CLAUDE_CODE_SESSION_ID };
    process.env.ANTHROPIC_BASE_URL = 'http://operator.example';
    process.env.ANTHROPIC_AUTH_TOKEN = 'operator-token';
    process.env.CLAUDE_CODE_SESSION_ID = 'operator-session';
    try {
      fakeQuery.impl = () => new FakeQuery([systemInit(), assistantText('ok'), resultSuccess('ok')]);
      const { request, prepared } = buildRequest({ model: 'pp-cc/claude-sonnet-5' });
      await service().execute(request, prepared);
      const env = captured.lastOptions!.env!;
      expect(env.CLAUDE_CONFIG_DIR).toBe(join(home, '.worklite', 'claude'));
      expect(existsSync(join(home, '.worklite', 'claude'))).toBe(true);
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);

      // A non-Gateway model still reaches the Gateway, through the captured base URL.
      const native = buildRequest({ launch: { executor: 'claude', commandArguments: [], baseUrl: 'http://127.0.0.1:23392/', model: 'opus' }, model: null });
      await service().execute(native.request, native.prepared);
      expect(captured.lastOptions!.env).toMatchObject({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:23392/', ANTHROPIC_AUTH_TOKEN: 'worklite' });
    } finally {
      for (const [key, value] of [['ANTHROPIC_BASE_URL', saved.url], ['ANTHROPIC_AUTH_TOKEN', saved.token], ['CLAUDE_CODE_SESSION_ID', saved.session]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }));

  describe('captureLaunch', () => {
    it('routes a Gateway public model through the local Gateway base URL', async () => {
      const launch = await service().captureLaunch('pp-cc/claude-sonnet-5');
      expect(launch).toMatchObject({ executor: 'claude', baseUrl: 'http://127.0.0.1:23392', model: 'pp-cc/claude-sonnet-5' });
    });

    it('reads WorkLite\'s own Claude settings for a native model and never the operator ~/.claude', () => withHome(async (home) => {
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://operator.example' } }));
      // No WorkLite settings yet: defaults to the WorkLite Gateway; the operator file is ignored.
      expect(await service().captureLaunch('opus')).toMatchObject({ baseUrl: 'http://127.0.0.1:23392/' });
      mkdirSync(join(home, '.worklite', 'claude'), { recursive: true });
      writeFileSync(join(home, '.worklite', 'claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:23390' } }));
      expect(await service().captureLaunch('opus')).toMatchObject({ baseUrl: 'http://127.0.0.1:23390/' });
      writeFileSync(join(home, '.worklite', 'claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://elsewhere.example' } }));
      await expect(service().captureLaunch('opus')).rejects.toThrow('不属于当前 WorkLite Gateway');
    }));
  });
});
