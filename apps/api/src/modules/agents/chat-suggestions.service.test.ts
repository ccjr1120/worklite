// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, installStoredArrayStorage, type Database } from '@worklite/db';
import { chatSuggestionContext, type AgentExecutionView, type AgentToolCallView } from '@worklite/contracts';
import { ChatSuggestionsService } from './chat-suggestions.service';

const databases: Database[] = [];
afterEach(() => { vi.useRealTimers(); for (const db of databases.splice(0)) db.$client.close(); });

function fixture() {
  const db = createDb(':memory:');
  databases.push(db);
  db.$client.exec(`CREATE TABLE agent_tool_calls (workspace_id text, execution_id text, mcp_tool_name text, input text);
    CREATE TABLE agent_executions (id text, workspace_id text, status text, display_messages text, model_messages text, pending_question text);`);
  installStoredArrayStorage(db.$client);
  let current = { id: 'chat', pendingQuestion: null, messages: [], toolCalls: [{ id: 'dispatch', agentInvocation: {
    agentId: 'coder', agentName: 'coder', runId: 'run', task: '调查输入框', status: 'waiting_for_input', phase: 'model',
  } } as AgentToolCallView] } as unknown as AgentExecutionView;
  db.$client.prepare('INSERT INTO agent_tool_calls VALUES (?, ?, ?, ?)').run('personal', 'chat', 'run_agent', JSON.stringify({ __agentInvocationId: 'run', __backgroundExecutionId: 'background' }));
  db.$client.prepare('INSERT INTO agent_tool_calls VALUES (?, ?, ?, ?)').run('other', 'chat', 'run_agent', JSON.stringify({ __agentInvocationId: 'run', __backgroundExecutionId: 'secret' }));
  db.$client.prepare('INSERT INTO agent_executions VALUES (?, ?, ?, ?, ?, ?)').run('background', 'personal', 'waiting_for_input', JSON.stringify([{ id: 'm', role: 'assistant', content: '需要确定交互方式', createdAt: '' }]), '[]', JSON.stringify({ question: '推荐是否只在空输入框出现？' }));
  const get = vi.fn(async () => current);
  const executeSystemOne = vi.fn(async (_input: unknown) => ({ answers: { suggestion: { type: 'choice', choice: 'run:input' }, useful: { type: 'noul', noul: 0.9 } } }));
  const service = new ChatSuggestionsService(db, { getWorkspace: async () => ({ id: 'personal' }) } as never, { get } as never, { executeSystemOne } as never);
  const suggest = () => service.suggest({} as never, 'chat', chatSuggestionContext(current).contextVersion);
  return { db, service, executeSystemOne, get, suggest, setCurrent: (next: AgentExecutionView) => { current = next; }, current };
}

describe('Chat Jev suggestions', () => {
  it.skipIf(process.env.WORKLITE_LIVE_JEV_SMOKE !== '1')('ranks through the configured local Gateway and real Jev provider', async () => {
    const test = fixture();
    test.executeSystemOne.mockImplementation(async (input) => {
      const request = input as { model: string; state: unknown; questions: unknown; signal: AbortSignal };
      const response = await fetch(`http://127.0.0.1:${process.env.PORTKEY_GATEWAY_PORT ?? 23392}/v1/systemone`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: request.signal,
        body: JSON.stringify({ model: request.model, state: request.state, questions: request.questions }),
      });
      if (!response.ok) throw new Error(`Gateway returned ${response.status}`);
      return await response.json() as Awaited<ReturnType<typeof test.executeSystemOne>>;
    });
    const response = await test.suggest();
    expect(response.source).toBe('jev');
    expect(response.suggestion === null || chatSuggestionContext(test.current).candidates.some((candidate) => candidate.id === response.suggestion?.id)).toBe(true);
  });
  it('uses one Gateway Choice + Noul decision, scoped saved context, and coalesces identical requests', async () => {
    const test = fixture();
    const [first, second] = await Promise.all([test.suggest(), test.suggest()]);
    expect(first).toEqual(second);
    expect(first.source).toBe('jev');
    expect(first.suggestion?.text).toBe('这个任务需要我补充哪些信息？');
    expect(test.executeSystemOne).toHaveBeenCalledTimes(1);
    const input = test.executeSystemOne.mock.calls[0]![0] as { model: string; state: { tasks: Array<{ progress: string[]; pendingQuestion: string }> }; questions: Record<string, { type: string; criteria?: Record<string, string> }> };
    expect(input.model).toBe('typesafe/jev-latest');
    expect(input.state.tasks[0]?.pendingQuestion).toBe('推荐是否只在空输入框出现？');
    expect(input.state.tasks[0]?.progress).toEqual(['需要确定交互方式']);
    expect(input.questions.suggestion?.criteria?.['run:input']).toBe('这个任务需要我补充哪些信息？');
    expect(input.questions.useful?.type).toBe('noul');
    expect(JSON.stringify(input)).not.toContain('secret');
    await test.suggest();
    expect(test.executeSystemOne).toHaveBeenCalledTimes(1);
  });
  it('honors an explicit model abstention or negative Noul rather than falling back', async () => {
    for (const answers of [
      { suggestion: { type: 'choice', choice: 'none' }, useful: { type: 'noul', noul: 0.9 } },
      { suggestion: { type: 'choice', choice: 'run:input' }, useful: { type: 'noul', noul: 0.2 } },
    ]) {
      const test = fixture();
      test.executeSystemOne.mockResolvedValue({ answers });
      expect((await test.suggest()).suggestion).toBeNull();
    }
  });
  it('falls back for an unconfigured provider, an invalid choice, and an invalid gate', async () => {
    const missing = fixture();
    missing.executeSystemOne.mockRejectedValue(new Error('not configured'));
    expect((await missing.suggest()).source).toBe('rules');
    for (const answers of [
      { suggestion: { type: 'choice', choice: 'invented' }, useful: { type: 'noul', noul: 0.9 } },
      { suggestion: { type: 'choice', choice: 'run:input' }, useful: { type: 'noul', noul: NaN } },
    ]) {
      const test = fixture();
      test.executeSystemOne.mockResolvedValue({ answers });
      expect((await test.suggest()).suggestion?.id).toBe('run:input');
      expect((await test.suggest()).source).toBe('rules');
    }
  });
  it('times out even when the underlying provider ignores its abort signal', async () => {
    vi.useFakeTimers();
    const test = fixture();
    test.executeSystemOne.mockImplementation(() => new Promise(() => {}));
    const result = test.suggest();
    await vi.advanceTimersByTimeAsync(2_001);
    expect((await result).source).toBe('rules');
    expect((test.executeSystemOne.mock.calls[0]![0] as { signal: AbortSignal }).signal.aborted).toBe(true);
  });
  it('never calls Jev for a stale version or a Chat pending question', async () => {
    const test = fixture();
    expect((await test.service.suggest({} as never, 'chat', 'v1-old-version')).suggestion).toBeNull();
    test.setCurrent({ ...test.current, pendingQuestion: { id: 'q', question: '确认？', options: [], createdAt: '' } });
    expect((await test.suggest()).suggestion).toBeNull();
    expect(test.executeSystemOne).not.toHaveBeenCalled();
  });
  it('ranks completed tasks using their saved result, with accurate active and completed counts', async () => {
    const test = fixture();
    test.setCurrent({ ...test.current, status: 'completed', toolCalls: test.current.toolCalls.map((call) => ({ ...call, agentInvocation: { ...call.agentInvocation!, status: 'completed' } })) });
    test.db.$client.prepare('UPDATE agent_executions SET status = ?, display_messages = ?, pending_question = null WHERE id = ?').run('completed', JSON.stringify([{ id: 'm', role: 'assistant', content: '交互测试通过，等待检查结果', createdAt: '' }]), 'background');
    test.executeSystemOne.mockResolvedValue({ answers: { suggestion: { type: 'choice', choice: 'run:result' }, useful: { type: 'noul', noul: 0.9 } } });
    expect((await test.suggest()).suggestion?.id).toBe('run:result');
    const input = test.executeSystemOne.mock.calls[0]![0] as { state: { activeTaskCount: number; completedTaskCount: number; tasks: Array<{ status: string; progress: string[] }> } };
    expect(input.state.activeTaskCount).toBe(0);
    expect(input.state.completedTaskCount).toBe(1);
    expect(input.state.tasks[0]).toMatchObject({ status: 'completed', progress: ['交互测试通过，等待检查结果'] });
  });
  it('offers a conversation follow-up even when there are no delegated tasks', async () => {
    const test = fixture();
    test.setCurrent({ ...test.current, status: 'completed', toolCalls: [], messages: [{ id: 'a', role: 'assistant', content: '方案已整理。', createdAt: '' }] });
    test.executeSystemOne.mockRejectedValue(new Error('offline'));
    expect((await test.suggest()).suggestion?.id).toBe('conversation:next');
  });
  it('revalidates the task after the model finishes and does not return a stale suggestion', async () => {
    const test = fixture();
    test.executeSystemOne.mockImplementation(async () => {
      test.setCurrent({ ...test.current, toolCalls: [] });
      return { answers: { suggestion: { type: 'choice', choice: 'run:input' }, useful: { type: 'noul', noul: 0.9 } } };
    });
    expect((await test.suggest()).suggestion).toBeNull();
  });
});
