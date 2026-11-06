import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentExecutionView, AgentToolCallView } from '@worklite/contracts';
import '@/i18n/config';
import { AssistantTurn, buildTimeline, ToolCallPanel } from './transcript';

vi.mock('@tanstack/react-router', () => ({ Link: ({ params, search, children }: { params: { agentId: string }; search: { runId: string }; children: React.ReactNode }) => <a href={`/agents/${params.agentId}?runId=${search.runId}`}>{children}</a> }));
afterEach(cleanup);

describe('Agent invocation display', () => {
  it('does not infer a running Agent from a completed launch with missing execution state', () => {
    render(<ToolCallPanel call={{ status: 'completed', agentInvocation: { agentId: 'agent', agentName: 'qcoder', runId: 'air_run', task: '修复任务卡片' } } as AgentToolCallView} />);
    expect(screen.getByText('状态未知')).toBeVisible();
    expect(screen.queryByText('进行中')).not.toBeInTheDocument();
    expect(screen.queryByText('已完成')).not.toBeInTheDocument();
  });

  it.each(['waiting_for_input', 'paused'] as const)('retains the %s Agent state without showing a completed launch as task completion', (status) => {
    render(<ToolCallPanel call={{ status: 'completed', agentInvocation: { agentId: 'agent', agentName: 'qcoder', runId: 'air_run', task: '修复任务卡片', status } } as AgentToolCallView} />);
    expect(screen.getByText(status === 'paused' ? '已暂停' : '等待输入')).toBeVisible();
    expect(screen.queryByText('已完成')).not.toBeInTheDocument();
  });

  it('renders periodic Agent progress as a feedback card linked to the work record', () => {
    const message = { id: 'progress', role: 'assistant' as const, content: '进展', createdAt: new Date().toISOString(), progressReport: { items: [{ kind: 'agent' as const, id: 'background', title: 'wechat-article', agentId: 'article', runId: 'air_article', task: '撰写趋势文章', status: 'running', progress: '调研：已完成；写作：执行中' }] } };
    render(<AssistantTurn segments={[{ kind: 'message', item: message }]} working={false} markdownEnabled />);
    expect(screen.getByRole('link', { name: '@wechat-article' })).toHaveAttribute('href', '/agents/article?runId=air_article');
    expect(screen.getByRole('link', { name: '@wechat-article' }).parentElement).toHaveTextContent('@wechat-article 撰写趋势文章');
    expect(screen.getByText('进行中')).toBeVisible();
    expect(screen.getByText('调研：已完成；写作：执行中')).toBeVisible();
  });

  it('places a dispatch in a separate timeline message between Chat replies', () => {
    const timeline = buildTimeline({ execution: { messages: [
      { id: 'before', role: 'assistant', content: '已找到资料', createdAt: '2026-11-04T00:00:00Z' },
      { id: 'after', role: 'assistant', content: '另一条回复', createdAt: '2026-11-04T00:00:02Z' },
    ], toolCalls: [{ id: 'dispatch', createdAt: '2026-11-04T00:00:01Z', agentInvocation: { agentId: 'agent', agentName: 'wechat-article', runId: 'air_run', task: '写文章' } }] } as AgentExecutionView, submissions: [], workflowRun: null, receipts: [], question: null, cancelled: false, failed: false });
    expect(timeline.map((entry) => entry.kind)).toEqual(['assistant', 'agentInvocation', 'assistant']);
    expect(timeline[1]).toMatchObject({ kind: 'agentInvocation', call: { agentInvocation: { task: '写文章', runId: 'air_run' } } });
  });

  it.each(['running', 'completed', 'cancelled', 'failed'] as const)('shows the task summary beside @Agent and the actual %s execution status', (status) => {
    render(<ToolCallPanel call={{ status: 'completed', mcpToolName: 'run_agent', agentInvocation: { agentId: 'agent', agentName: 'qcoder', runId: 'air_run', task: '请根据真实热门数据撰写文章，包含 6–8 个分主题项目和趋势判断。', status, phase: 'model' } } as AgentToolCallView} />);
    expect(screen.getByRole('link', { name: '@qcoder' })).toHaveAttribute('href', '/agents/agent?runId=air_run');
    expect(screen.getByRole('link', { name: '@qcoder' }).parentElement).toHaveTextContent('@qcoder 请根据真实热门数据撰写文章，包含 6–8 个分主题项目和趋势判断。');
    expect(screen.getByText(({ running: '进行中', completed: '已完成', cancelled: '已取消', failed: '失败' })[status])).toBeVisible();
    if (status === 'running') expect(screen.getByText('正在分析与处理任务')).toBeVisible();
    else expect(screen.queryByText('正在分析与处理任务')).not.toBeInTheDocument();
    expect(screen.queryByText('Skill 脚本')).not.toBeInTheDocument();
    expect(screen.queryByText(/run_agent/)).not.toBeInTheDocument();
  });

  it('keeps multiline task instructions out of the step line', () => {
    render(<ToolCallPanel call={{ status: 'completed', agentInvocation: { agentId: 'agent', agentName: 'qcoder', runId: 'air_run', task: '## 修复任务卡片\n保留现有改动', status: 'running', phase: 'skill' } } as AgentToolCallView} />);
    expect(screen.getByRole('link', { name: '@qcoder' }).parentElement).toHaveTextContent('@qcoder 修复任务卡片');
    expect(screen.getByText('正在执行工具')).toBeVisible();
    expect(screen.queryByText('保留现有改动')).not.toBeInTheDocument();
  });
});
