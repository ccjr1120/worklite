import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunView, AgentView } from '@worklite/contracts';
import '@/i18n/config';
import { api } from '@/api/client';
import { AgentOverview } from './agent-overview';
vi.mock('@/components/locale-provider', () => ({ useLocale: () => ({ locale: 'zh-CN' }) }));
vi.mock('@/api/client', () => ({ api: { agentHistory: vi.fn(), agentRun: vi.fn() } }));
vi.mock('@/components/workspace/workspace-chrome', () => ({ WorkspaceChrome: () => null }));
vi.mock('@/components/ai/streaming-markdown', () => ({ StreamingMarkdown: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ to, params, search, children }: { to: string; params?: { artifactId: string }; search?: Record<string, string>; children: React.ReactNode }) => <a href={to === '/chat' ? `/chat?${new URLSearchParams(search)}` : `/artifacts/${params?.artifactId}`}>{children}</a> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const agent = { id: 'lead', name: '项目 Agent', responsibility: '协调开发与验证' } as AgentView;
function run(id: string, agentName: string): AgentRunView { return { id, agentId: 'lead', agentName, executionId: 'execution', parentRunId: null, task: `任务 ${id}`, status: 'completed', usage: null, output: '', error: null, createdAt: '2026-11-04T00:00:00.000Z', finishedAt: '2026-11-04T00:01:00.000Z' }; }
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onConfigure = vi.fn();
  render(<QueryClientProvider client={client}><AgentOverview agent={agent} onConfigure={onConfigure} /></QueryClientProvider>);
  return { onConfigure, client };
}
describe('Agent run overview', () => {
  it('opens run details, separates child token usage, links artifacts and switches records', async () => {
    const first = run('first', '项目 Agent'); const second = run('second', '项目 Agent');
    vi.mocked(api.agentHistory).mockResolvedValue({ items: [first, second], hasMore: false });
    vi.mocked(api.agentRun).mockImplementation(async (_agentId, id) => ({ run: { ...(id === 'first' ? first : second), output: id === 'first' ? '交付文档' : '第二次交付' }, invocations: [{ ...(id === 'first' ? first : second), output: id === 'first' ? '交付文档' : '第二次交付' }, { ...run('child', '开发 Agent'), usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }], artifacts: [{ id: 'document', name: '项目报告' }] }));
    const { onConfigure, client } = mount();
    await screen.findByRole('link', { name: '项目报告' });
    expect(screen.queryByText('交付文档')).not.toBeInTheDocument();
    expect(screen.getByText('协调开发与验证')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '在 Chat 中继续' })).toHaveAttribute('href', '/chat?view=conversation&agentId=lead&agentRunId=first&agentExecutionId=execution');
    const table = screen.getByRole('table');
    expect(within(table).getByRole('row', { name: /开发 Agent 0.1k 0.02k 0.12k/ })).toBeInTheDocument();
    expect(within(table).getAllByText('未记录')).toHaveLength(3);
    expect(screen.getByRole('link', { name: '项目报告' })).toHaveAttribute('href', '/api/artifact-previews/document/open');
    expect(screen.getByRole('link', { name: '项目报告' })).toHaveAttribute('target', '_blank');
    const taskDetails = screen.getByText('任务', { selector: 'summary' }).closest('details')!;
    expect(taskDetails).not.toHaveAttribute('open');
    const usage = screen.getByRole('heading', { name: 'Token 消耗' });
    const records = screen.getByRole('heading', { name: 'Agent 执行记录' });
    const outputs = screen.getByRole('heading', { name: '产物' });
    expect(taskDetails.compareDocumentPosition(records) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(records.compareDocumentPosition(outputs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(outputs.compareDocumentPosition(usage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(taskDetails).getByText('任务', { selector: 'summary' }));
    expect(taskDetails).toHaveAttribute('open');

    fireEvent.click(screen.getByRole('button', { name: /任务 second/ }));
    await waitFor(() => expect(api.agentRun).toHaveBeenLastCalledWith('lead', 'second'));
    expect(screen.queryByText('第二次交付')).not.toBeInTheDocument();
    expect((await screen.findByText('任务', { selector: 'summary' })).closest('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByRole('button', { name: '配置 Agent' })); expect(onConfigure).toHaveBeenCalledOnce();
    client.clear();
  });
  it('shows current work without inline output, then offers continuation after cancellation', async () => {
    const active = { ...run('active', '项目 Agent'), status: 'running' as const, currentActivity: { phase: 'tool' as const, toolName: 'run_sub_agent' } };
    const child = { ...run('child', '研究 Agent'), parentRunId: active.id, status: 'running' as const, currentActivity: { phase: 'model' as const }, output: '已找到资料，正在整理' };
    vi.mocked(api.agentHistory).mockResolvedValue({ items: [active], hasMore: false });
    vi.mocked(api.agentRun).mockResolvedValue({ run: { ...active, output: '我先' }, invocations: [{ ...active, output: '我先' }, child], artifacts: [] });
    const { client } = mount();
    await screen.findByText('暂无产物');
    const outputs = screen.getByRole('heading', { name: '产物' }).closest('section')!;
    expect(within(outputs).queryByText('我先')).not.toBeInTheDocument();
    expect(screen.queryByText('我先')).not.toBeInTheDocument();
    expect(screen.getAllByText('正在调用 run_sub_agent…').length).toBeGreaterThan(0);
    expect(screen.getByText('正在生成回复或规划下一步…')).toBeVisible();
    expect(screen.queryByText('已找到资料，正在整理')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '在 Chat 中继续' })).not.toBeInTheDocument();
    vi.mocked(api.agentRun).mockResolvedValue({ run: { ...active, status: 'cancelled' }, invocations: [], artifacts: [] });
    await client.invalidateQueries({ queryKey: ['agent-run'] });
    expect(await screen.findByRole('link', { name: '在 Chat 中继续' })).toHaveAttribute('href', expect.stringContaining('agentExecutionId=execution'));
    expect(screen.queryByText('正在调用 run_sub_agent…')).not.toBeInTheDocument();
    client.clear();
  });

  it('shows empty and failed history without fabricating runs', async () => {
    vi.mocked(api.agentHistory).mockResolvedValue({ items: [], hasMore: false });
    const { client } = mount();
    expect(await screen.findByText('暂无运行记录')).toBeInTheDocument();
    expect(api.agentRun).not.toHaveBeenCalled();
    vi.mocked(api.agentHistory).mockRejectedValue(new Error('offline'));
    await client.invalidateQueries({ queryKey: ['agent-history'] });
    await waitFor(() => expect(screen.getByText('无法加载运行记录。')).toBeInTheDocument());
    client.clear();
  });
});
