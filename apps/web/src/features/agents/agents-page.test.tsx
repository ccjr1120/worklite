import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import { useAgentsQuery } from '@/api/queries';
import { Route } from '@/routes/agents/index';
vi.mock('@/api/queries', () => ({ useAgentsQuery: vi.fn() }));
vi.mock('@/components/workspace/workspace-chrome', () => ({ WorkspaceChrome: ({ actions }: { actions: React.ReactNode }) => <div>{actions}</div> }));
vi.mock('@tanstack/react-router', () => ({ createFileRoute: () => (options: { component: unknown }) => ({ options }), Link: ({ to, params, children, ...props }: { to: string; params: { agentId: string }; children: React.ReactNode }) => <a href={to.replace('$agentId', params.agentId)} {...props}>{children}</a> }));
afterEach(cleanup);
describe('unified Agents page', () => {
  it('shows only top-level Agents and never exposes children through search', () => {
    vi.mocked(useAgentsQuery).mockReturnValue({ data: [
      { id: 'child', name: 'Implementer', responsibility: '实现代码与测试', kind: 'custom', runtime: { kind: 'codex', projectDirectory: '' }, collaboration: { subAgentIds: [], capabilities: [] } },
      { id: 'lead', name: 'Project Agent', responsibility: '协调项目任务', kind: 'custom', runtime: { kind: 'native' }, collaboration: { subAgentIds: ['child'], capabilities: [] } },
      { id: 'other', name: 'Article Agent', responsibility: '撰写文章', kind: 'custom', collaboration: { subAgentIds: [] } },
      { id: 'chat', name: 'Chat', kind: 'system' },
    ] } as never);
    const Component = Route.options.component as React.ComponentType;
    render(<Component />);
    expect(screen.getByRole('link', { name: 'Project Agent' })).toHaveAttribute('href', '/agents/lead');
    expect(screen.queryByRole('link', { name: 'Implementer' })).not.toBeInTheDocument();
    expect(screen.queryByText('实现代码与测试')).not.toBeInTheDocument();
    expect(screen.getByText('协调项目任务')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '创建 Agent' })).toHaveAttribute('href', '/agents/new');
    expect(screen.queryByText('Coding Team')).not.toBeInTheDocument();
    expect(screen.queryByText('工作流')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Chat' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '实现代码' } });
    expect(screen.queryByRole('link', { name: 'Project Agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Implementer' })).not.toBeInTheDocument();
    expect(screen.getByText('没有找到匹配的 Agent')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Article Agent' })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(screen.getByRole('link', { name: 'Article Agent' })).toBeInTheDocument();
  });
});
