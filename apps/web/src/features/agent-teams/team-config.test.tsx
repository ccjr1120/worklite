import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import type { AgentTeamMemoryView, AgentTeamView, McpServerView } from '@worklite/contracts';
import { useAgentTeamMemoriesQuery, useAgentTeamQuery, useAgentTeamRecordsQuery, useAgentTeamsQuery, useMcpServersQuery } from '@/api/queries';
import { Route as LegacyAgentTeamConfigRoute } from '@/routes/agent-team-config';
import { Route as AgentTeamConfigRoute } from '@/routes/agent-teams/$teamId.config';
import { TeamConfig } from './team-config';

vi.mock('@/api/queries', () => ({
  useAgentTeamQuery: vi.fn(),
  useAgentTeamMemoriesQuery: vi.fn(),
  useMcpServersQuery: vi.fn(),
  useAgentTeamsQuery: vi.fn(),
  useAgentTeamRecordsQuery: vi.fn(),
}));

vi.mock('@/components/locale-provider', () => ({
  useLocale: () => ({ locale: 'zh-CN' }),
}));

vi.mock('@/components/workspace/workspace-chrome', () => ({
  WorkspaceChrome: ({ crumbs }: { crumbs: Array<{ label: string }> }) => <nav>{crumbs.map((crumb) => crumb.label).join(' / ')}</nav>,
}));

vi.mock('@tanstack/react-router', () => {
  const toHref = (to: string, params?: Record<string, string>) => Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to);
  return {
    Link: ({ children, to, params, ...props }: { children: React.ReactNode; to: string; params?: Record<string, string> }) => <a href={toHref(to, params)} {...props}>{children}</a>,
    Navigate: ({ to, params, replace }: { to: string; params?: Record<string, string>; replace?: boolean }) => <span data-testid="navigate" data-replace={String(Boolean(replace))}>{toHref(to, params)}</span>,
    createFileRoute: (path: string) => (options: { component: unknown }) => ({ path, options, useParams: () => ({ teamId: 'team_1' }) }),
  };
});

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

const otherTeam: AgentTeamView = { ...team, id: 'team_2', name: 'Applications', roles: [] };

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
  vi.mocked(useAgentTeamsQuery).mockReturnValue({ data: [options.team ?? team, otherTeam] } as unknown as ReturnType<typeof useAgentTeamsQuery>);
  vi.mocked(useAgentTeamRecordsQuery).mockReturnValue({ data: [] } as unknown as ReturnType<typeof useAgentTeamRecordsQuery>);
}

describe('TeamConfig', () => {
  it('renders the team overview, role configuration and memories read-only', () => {
    mockQueries();
    render(<TeamConfig teamId="team_1" />);

    const overview = screen.getByRole('heading', { name: '基本信息' }).closest('section') as HTMLElement;
    expect(within(overview).getByText('Delivery')).toBeInTheDocument();
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
    render(<TeamConfig teamId="team_1" />);
    expect(screen.getByText('Project info')).toBeInTheDocument();
    expect(screen.getByText('mcp_removed')).toBeInTheDocument();
  });

  it('keeps role instructions collapsed until the reader expands them verbatim', () => {
    mockQueries();
    render(<TeamConfig teamId="team_1" />);
    expect(screen.queryByText('Implement the assigned scope.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开指令' }));
    expect(screen.getByText('Implement the assigned scope.')).toBeInTheDocument();
  });

  it('links back to the same Team\'s Run records page', () => {
    mockQueries();
    render(<TeamConfig teamId="team_1" />);
    expect(screen.getByRole('link', { name: '返回记录' })).toHaveAttribute('href', '/agent-teams/team_1');
  });

  it('shows the Team switcher below the heading with links to each Team\'s configuration', () => {
    mockQueries();
    render(<TeamConfig teamId="team_1" />);
    const switcher = screen.getByRole('navigation', { name: '选择 Agent Team' });
    expect(within(switcher).getByRole('link', { name: /Delivery/ })).toHaveAttribute('aria-current', 'page');
    expect(within(switcher).getByRole('link', { name: /Applications/ })).toHaveAttribute('href', '/agent-teams/team_2/config');
  });

  it('is served per Team at /agent-teams/:teamId/config', () => {
    expect(AgentTeamConfigRoute.path).toBe('/agent-teams/$teamId/config');
    mockQueries();
    const Component = AgentTeamConfigRoute.options.component as React.ComponentType;
    render(<Component />);
    expect(vi.mocked(useAgentTeamQuery)).toHaveBeenLastCalledWith('team_1');
  });

  it('redirects the legacy /agent-team-config path to the default Team configuration', () => {
    expect(LegacyAgentTeamConfigRoute.path).toBe('/agent-team-config');
    const Component = LegacyAgentTeamConfigRoute.options.component as React.ComponentType;
    render(<Component />);
    expect(screen.getByTestId('navigate')).toHaveTextContent('/agent-teams/agent_team_bmad_tea/config');
    expect(screen.getByTestId('navigate')).toHaveAttribute('data-replace', 'true');
  });

  it('renders the empty memories state', () => {
    mockQueries({ memories: [] });
    render(<TeamConfig teamId="team_1" />);
    expect(screen.getByText('暂无 Team 记忆。')).toBeInTheDocument();
  });
});
