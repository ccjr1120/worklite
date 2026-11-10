import { describe, expect, it } from 'vitest';
import { chatSuggestionContext, type AgentExecutionView, type AgentToolCallView } from './index';

function call(runId: string, status: 'running' | 'waiting_for_input' | 'completed', task = '调查输入框') {
  return { id: runId, agentInvocation: { agentId: 'agent', agentName: 'coder', runId, task, status, phase: 'model' } } as AgentToolCallView;
}
function execution(calls: AgentToolCallView[]): AgentExecutionView {
  return { id: 'chat', toolCalls: calls, messages: [], pendingQuestion: null } as unknown as AgentExecutionView;
}

describe('Chat suggestion rules', () => {
  it('uses live invocation status, not the dispatch receipt or Chat turn status', () => {
    expect(chatSuggestionContext(execution([call('a', 'completed')])).candidates).toEqual([]);
    expect(chatSuggestionContext(execution([call('a', 'running')])).candidates[0]?.text).toBe('这个任务目前进展如何？');
    expect(chatSuggestionContext(execution([{ id: 'old', status: 'completed' } as AgentToolCallView])).candidates).toEqual([]);
  });
  it('deduplicates continued runs and lets their latest settled state retire them', () => {
    const context = chatSuggestionContext(execution([call('a', 'running'), call('a', 'waiting_for_input')]));
    expect(context.tasks).toHaveLength(1);
    expect(context.candidates[0]?.id).toBe('a:input');
    expect(chatSuggestionContext(execution([call('a', 'running'), call('a', 'completed')])).candidates).toEqual([]);
  });
  it('prioritizes waiting input, then a multi-task overview and recently mentioned tasks', () => {
    const context = chatSuggestionContext(execution([call('a', 'running'), call('b', 'waiting_for_input')]));
    expect(context.candidates.map((item) => item.id).slice(0, 2)).toEqual(['b:input', 'all:progress']);
    expect(context.candidates.find((item) => item.id === 'all:progress')?.runIds).toEqual(['a', 'b']);
  });
  it('suspends recommendations during Chat clarification and ignores poll timestamps and tool phases', () => {
    const current = execution([call('a', 'running')]);
    const changed = { ...current, updatedAt: 'later', toolCalls: [{ ...current.toolCalls[0]!, agentInvocation: { ...current.toolCalls[0]!.agentInvocation!, phase: 'skill' as const } }] };
    expect(chatSuggestionContext(changed).contextVersion).toBe(chatSuggestionContext(current).contextVersion);
    expect(chatSuggestionContext({ ...current, pendingQuestion: { id: 'q', question: '批准？', options: [], createdAt: '' } }).candidates).toEqual([]);
  });
  it('changes context for meaningful conversation edits without claiming task-specific stages', () => {
    const current = execution([call('a', 'running', '不要部署，先调查测试')]);
    expect(chatSuggestionContext({ ...current, messages: [{ id: 'u', role: 'user', content: '先关注验证', createdAt: '' }] }).contextVersion)
      .not.toBe(chatSuggestionContext(current).contextVersion);
    expect(chatSuggestionContext(current).candidates[0]?.text).toBe('这个任务目前进展如何？');
  });
  it('does not regenerate on every Chat streaming delta while background tasks are active', () => {
    const current = { ...execution([call('a', 'running')]), status: 'running' as const, messages: [
      { id: 'u', role: 'user' as const, content: '看看任务', createdAt: '' },
      { id: 'a', role: 'assistant' as const, content: '正在', createdAt: '' },
    ] };
    const streaming = { ...current, messages: [current.messages[0]!, { ...current.messages[1]!, content: '正在检查任务状态' }] };
    expect(chatSuggestionContext(current).candidates).not.toHaveLength(0);
    expect(chatSuggestionContext(streaming).contextVersion).toBe(chatSuggestionContext(current).contextVersion);
    expect(chatSuggestionContext({ ...streaming, status: 'completed' }).contextVersion).not.toBe(chatSuggestionContext(current).contextVersion);
  });
});
