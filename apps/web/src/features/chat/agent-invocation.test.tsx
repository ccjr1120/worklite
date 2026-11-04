import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentExecutionView, AgentToolCallView } from '@worklite/contracts';
import '@/i18n/config';
import { AssistantTurn, buildTimeline, ToolCallPanel } from './transcript';

vi.mock('@tanstack/react-router', () => ({ Link: ({ params, search, children }: { params: { agentId: string }; search: { runId: string }; children: React.ReactNode }) => <a href={`/agents/${params.agentId}?runId=${search.runId}`}>{children}</a> }));
afterEach(cleanup);

describe('Agent invocation display', () => {
  it('renders periodic Agent progress as a feedback card linked to the work record', () => {
    const message = { id: 'progress', role: 'assistant' as const, content: '进展', createdAt: new Date().toISOString(), progressReport: { items: [{ kind: 'agent' as const, id: 'background', title: 'wechat-article', agentId: 'article', runId: 'air_article', status: 'running', progress: '调研：已完成；写作：执行中' }] } };
    render(<AssistantTurn segments={[{ kind: 'message', item: message }]} working={false} markdownEnabled />);
    expect(screen.getByRole('link', { name: '@wechat-article' })).toHaveAttribute('href', '/agents/article?runId=air_article');
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

  it.each(['running', 'completed', 'cancelled', 'failed'] as const)('shows only the linked @Agent for a %s invocation', (status) => {
    render(<ToolCallPanel call={{ status, mcpToolName: 'run_agent', agentInvocation: { agentId: 'agent', agentName: 'qcoder', runId: 'air_run', task: '请根据真实热门数据撰写文章，包含 6–8 个分主题项目和趋势判断。' } } as AgentToolCallView} />);
    expect(screen.getByRole('link', { name: '@qcoder' })).toHaveAttribute('href', '/agents/agent?runId=air_run');
    expect(screen.getByText('请根据真实热门数据撰写文章，包含 6–8 个分主题项目和趋势判断。')).toBeVisible();
    expect(screen.queryByText('Skill 脚本')).not.toBeInTheDocument();
    expect(screen.queryByText(/run_agent/)).not.toBeInTheDocument();
  });
});
