import { describe, expect, it } from 'vitest';
import { chatSuggestionContext, type AgentExecutionView, type AgentToolCallView } from './index';

function call(runId: string, status: 'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled', task = '调查输入框') {
  return { id: runId, agentInvocation: { agentId: 'agent', agentName: 'coder', runId, task, status, phase: 'model' } } as AgentToolCallView;
}
function execution(calls: AgentToolCallView[]): AgentExecutionView {
  return { id: 'chat', toolCalls: calls, messages: [], pendingQuestion: null } as unknown as AgentExecutionView;
}

describe('Chat suggestion rules', () => {
  it('uses live invocation status, not the dispatch receipt or Chat turn status', () => {
    expect(chatSuggestionContext(execution([call('a', 'completed')])).candidates[0]?.id).toBe('a:result');
    expect(chatSuggestionContext(execution([call('a', 'running')])).candidates[0]?.text).toBe('这个任务目前进展如何？');
    expect(chatSuggestionContext(execution([{ id: 'old', status: 'completed' } as AgentToolCallView])).tasks).toEqual([]);
  });
  it('deduplicates continued runs and switches from progress to reviewing their settled result', () => {
    const context = chatSuggestionContext(execution([call('a', 'running'), call('a', 'waiting_for_input')]));
    expect(context.tasks).toHaveLength(1);
    expect(context.candidates[0]?.id).toBe('a:input');
    const completed = chatSuggestionContext(execution([call('a', 'running'), call('a', 'completed')]));
    expect(completed.tasks).toHaveLength(1);
    expect(completed.candidates[0]?.id).toBe('a:result');
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
  it('provides an opening prompt without execution state and a follow-up without delegated tasks', () => {
    expect(chatSuggestionContext(null).candidates[0]).toMatchObject({ id: 'new:start', runIds: [], text: '帮我梳理目标，并拆成可以执行的任务。' });
    const ordinary = { ...execution([]), status: 'completed' as const, messages: [{ id: 'a', role: 'assistant' as const, content: '已整理方案。', createdAt: '' }] };
    expect(chatSuggestionContext(ordinary).candidates[0]?.id).toBe('conversation:next');
  });
  it('keeps completed, failed and cancelled tasks in a multi-task overview', () => {
    const context = chatSuggestionContext(execution([call('done', 'completed', '修改页面'), call('failed', 'failed', '运行测试'), call('cancelled', 'cancelled', '部署'), call('live', 'running', '检查日志')]));
    expect(context.tasks.map((task) => task.runId)).toEqual(['done', 'failed', 'cancelled', 'live']);
    expect(context.candidates[0]).toMatchObject({ id: 'all:overview', runIds: ['cancelled', 'done', 'failed', 'live'] });
    expect(context.candidates.find((candidate) => candidate.id === 'done:result')?.text).toContain('「修改页面」');
    expect(context.candidates.find((candidate) => candidate.id === 'failed:failure')?.text).toContain('失败的原因');
    expect(context.candidates.find((candidate) => candidate.id === 'cancelled:cancelled')?.text).toContain('取消前');
  });
  it('prioritizes pending input above a mixed task overview and keeps settled-only conversations useful', () => {
    const mixed = chatSuggestionContext(execution([call('done', 'completed'), call('waiting', 'waiting_for_input')]));
    expect(mixed.candidates.slice(0, 2).map((candidate) => candidate.id)).toEqual(['waiting:input', 'all:overview']);
    const done = chatSuggestionContext(execution([call('first', 'completed'), call('second', 'completed')]));
    expect(done.candidates[0]?.id).toBe('all:overview');
    expect(done.candidates.some((candidate) => candidate.id.endsWith(':progress'))).toBe(false);
  });
  it('includes project tasks and their final results without using tool receipt status', () => {
    const projectCall = { id: 'receipt', status: 'completed', projectTask: {
      id: 'project', goal: '完成发布验证', status: 'succeeded', result: '测试通过，尚未发布', error: null,
    } } as AgentToolCallView;
    const context = chatSuggestionContext(execution([projectCall]));
    expect(context.tasks[0]).toMatchObject({ runId: 'project', status: 'completed', result: '测试通过，尚未发布' });
    expect(context.candidates[0]?.id).toBe('project:result');
    expect(chatSuggestionContext(execution([{ ...projectCall, projectTask: { ...projectCall.projectTask!, result: '所有验证已通过' } }])).contextVersion).not.toBe(context.contextVersion);
  });
});
