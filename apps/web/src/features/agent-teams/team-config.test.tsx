import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import type { AgentTeamMemoryView, AgentTeamView, McpServerView } from '@worklite/contracts';
import { useAgentTeamMemoriesQuery, useAgentTeamQuery, useMcpServersQuery } from '@/api/queries';
import { Route as AgentTeamConfigRoute } from '@/routes/agent-team-config';
import { TeamConfig } from './team-config';

vi.mock('@/api/queries', () => ({
  useAgentTeamQuery: vi.fn(),
  useAgentTeamMemoriesQuery: vi.fn(),
  useMcpServersQuery: vi.fn(),
}));

vi.mock('@/components/locale-provider', () => ({
  useLocale: () => ({ locale: 'zh-CN' }),
}));

vi.mock('@/components/workspace/workspace-chrome', () => ({
  WorkspaceChrome: ({ crumbs }: { crumbs: Array<{ label: string }> }) => <nav>{crumbs.map((crumb) => crumb.label).join(' / ')}</nav>,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params }: { children: React.ReactNode; to: string; params?: Record<string, string> }) => {
    const href = Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to);
    return <a href={href}>{children}</a>;
  },
  createFileRoute: (path: string) => (options: { component: unknown }) => ({ path, options }),
}));

afterEach(cleanup);

const team: AgentTeamView = {
  id: 'team_1',
  name: 'Delivery',
  description: '',
  processId: 'proc_delivery',
  processVersion: '3',
  roles: [
    {
      role: 'developer',
      displayName: 'Builder',
      publicModelId: 'GLM/glm-5.3',
      instructions: 'Implement the assigned scope.',
      entryPoints: ['src/index.ts'],
      skillIds: [],
      mcpServerIds: ['mcp_1', 'mcp_removed'],
      toolNames: ['read_project_file'],
    },
  ],
  workingPractice: '',
  projectGitPolicy: '',
  maxConcurrentRuns: 3,
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-10T08:00:00.000Z',
};

const memories: AgentTeamMemoryView[] = [
  {
    id: 'mem_1',
    repositoryId: null,
    repositoryName: null,
    repositoryDirectory: null,
    role: null,
    content: 'Prefer pnpm scripts over direct node invocations.',
    sourceMessageId: null,
    createdAt: '2026-10-02T08:00:00.000Z',
    updatedAt: '2026-10-02T08:00:00.000Z',
  },
];

function mockQueries(options: { team?: AgentTeamView; memories?: AgentTeamMemoryView[]; mcpServers?: Array<Pick<McpServerView, 'id' | 'name'>> } = {}) {
  vi.mocked(useAgentTeamQuery).mockReturnValue({
    isPending: false,
    isError: false,
    data: options.team ?? team,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useAgentTeamQuery>);
  vi.mocked(useAgentTeamMemoriesQuery).mockReturnValue({
    isPending: false,
    isError: false,
    data: options.memories ?? memories,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useAgentTeamMemoriesQuery>);
  vi.mocked(useMcpServersQuery).mockReturnValue({
    data: (options.mcpServers ?? [{ id: 'mcp_1', name: 'Project info' }]) as McpServerView[],
  } as unknown as ReturnType<typeof useMcpServersQuery>);
}

describe('TeamConfig', () => {
  it('renders the team overview, role configuration and memories read-only', () => {
    mockQueries();
    render(<TeamConfig />);

    expect(screen.getByText('Delivery')).toBeInTheDocument();
    expect(screen.getByText('proc_delivery')).toBeInTheDocument();
    expect(screen.getByText('Builder')).toBeInTheDocument();
    expect(screen.getByText('GLM/glm-5.3')).toBeInTheDocument();
    expect(screen.getByText('read_project_file')).toBeInTheDocument();
    expect(screen.getByText('Prefer pnpm scripts over direct node invocations.')).toBeInTheDocument();

    // Empty fields render the configured placeholder instead of blank space.
    expect(screen.getAllByText('未设置').length).toBeGreaterThan(0);

    // No write controls exist anywhere on the page.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /保存|删除|新增|添加/ })).not.toBeInTheDocument();
  });

  it('maps MCP server ids to workspace server names and falls back to the id', () => {
    mockQueries();
    render(<TeamConfig />);
    expect(screen.getByText('Project info')).toBeInTheDocument();
    expect(screen.getByText('mcp_removed')).toBeInTheDocument();
  });

  it('keeps role instructions collapsed until the reader expands them verbatim', () => {
    mockQueries();
    render(<TeamConfig />);
    expect(screen.queryByText('Implement the assigned scope.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开指令' }));
    expect(screen.getByText('Implement the assigned scope.')).toBeInTheDocument();
  });

  it('links back to the Run records page', () => {
    mockQueries();
    render(<TeamConfig />);
    expect(screen.getByRole('link', { name: '返回记录' })).toHaveAttribute('href', '/agent-teams/agent_team_bmad_tea');
  });

  it('is served at the fixed /agent-team-config route', () => {
    expect(AgentTeamConfigRoute.path).toBe('/agent-team-config');
    expect(AgentTeamConfigRoute.options.component).toBe(TeamConfig);
  });

  it('renders the empty memories state', () => {
    mockQueries({ memories: [] });
    render(<TeamConfig />);
    expect(screen.getByText('暂无 Team 记忆。')).toBeInTheDocument();
  });
});
