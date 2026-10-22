import { cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import type { AgentTeamRunSummary, AgentTeamView } from '@worklite/contracts';
import { useAgentTeamRecordsQuery, useAgentTeamsQuery } from '@/api/queries';
import { Route as AgentTeamsIndexRoute } from '@/routes/agent-teams/index';
import { TeamRecords } from './team-records';

vi.mock('@/api/queries', () => ({
  useAgentTeamsQuery: vi.fn(),
  useAgentTeamRecordsQuery: vi.fn(),
}));

vi.mock('@/components/locale-provider', () => ({
  useLocale: () => ({ locale: 'zh-CN' }),
}));

vi.mock('@/components/workspace/workspace-chrome', () => ({
  WorkspaceChrome: ({ crumbs }: { crumbs: Array<{ label: string }> }) => <div data-testid="crumbs">{crumbs.map((crumb) => crumb.label).join(' / ')}</div>,
}));

vi.mock('@tanstack/react-router', () => {
  const toHref = (to: string, params?: Record<string, string>) => Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to);
  return {
    Link: ({ children, to, params, ...props }: { children: React.ReactNode; to: string; params?: Record<string, string> }) => <a href={toHref(to, params)} {...props}>{children}</a>,
    Navigate: ({ to, params, replace }: { to: string; params?: Record<string, string>; replace?: boolean }) => <span data-testid="navigate" data-replace={String(Boolean(replace))}>{toHref(to, params)}</span>,
    createFileRoute: (path: string) => (options: { component: unknown }) => ({ path, options }),
  };
});

afterEach(cleanup);

function team(id: string, name: string, description: string, maxConcurrentRuns: number): AgentTeamView {
  return {
    id,
    name,
    description,
    processId: 'bmad-tea',
    processVersion: '1',
    roles: [],
    workingPractice: '',
    projectGitPolicy: '',
    maxConcurrentRuns,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
  };
}

function run(id: string, status: AgentTeamRunSummary['status']): AgentTeamRunSummary {
  return { id, intent: `Goal ${id}`, projectDirectory: '/repo', mode: 'implement_and_validate', modeRationale: null, modeDecidedAt: null, orchestrationVersion: 9, status, createdAt: '2026-10-21T08:00:00.000Z', finishedAt: null };
}

const teams = [
  team('agent_team_application', 'Application Development Team', 'Built-in team for planning and developing complete applications.', 2),
  team('agent_team_bmad_tea', 'Company Project Team', 'Built-in BMAD and TEA team for company projects and requirements.', 3),
];

const runsByTeam: Record<string, AgentTeamRunSummary[]> = {
  agent_team_application: [run('run_app', 'queued')],
  agent_team_bmad_tea: [run('run_1', 'running'), run('run_2', 'waiting_for_input'), run('run_3', 'queued'), run('run_4', 'succeeded')],
};

function mockQueries(records = runsByTeam) {
  vi.mocked(useAgentTeamsQuery).mockReturnValue({ data: teams } as unknown as ReturnType<typeof useAgentTeamsQuery>);
  vi.mocked(useAgentTeamRecordsQuery).mockImplementation((teamId: string) => ({
    isPending: false,
    isError: false,
    data: records[teamId] ?? [],
    refetch: vi.fn(),
  }) as unknown as ReturnType<typeof useAgentTeamRecordsQuery>);
}

describe('TeamRecords', () => {
  it('shows both Teams in the switcher with focus, concurrency and active/queued counts', () => {
    mockQueries();
    render(<TeamRecords teamId="agent_team_bmad_tea" />);

    const switcher = screen.getByRole('navigation', { name: '选择 Agent Team' });
    const company = within(switcher).getByRole('link', { name: /Company Project Team/ });
    const application = within(switcher).getByRole('link', { name: /Application Development Team/ });

    expect(within(company).getByText('面向已有公司仓库')).toBeInTheDocument();
    expect(within(application).getByText('面向全新应用开发')).toBeInTheDocument();
    expect(within(company).getByText('Built-in BMAD and TEA team for company projects and requirements.')).toBeInTheDocument();
    // running + waiting_for_input are active; queued is counted separately; succeeded is neither.
    expect(within(company).getByText('并发上限').nextSibling).toHaveTextContent('3');
    expect(within(company).getByText('运行中').nextSibling).toHaveTextContent('2');
    expect(within(company).getByText('排队中').nextSibling).toHaveTextContent('1');
    expect(within(application).getByText('运行中').nextSibling).toHaveTextContent('0');
    expect(within(application).getByText('排队中').nextSibling).toHaveTextContent('1');
  });

  it('highlights the selected Team and links each card to its own records URL', () => {
    mockQueries();
    render(<TeamRecords teamId="agent_team_application" />);

    const switcher = screen.getByRole('navigation', { name: '选择 Agent Team' });
    const application = within(switcher).getByRole('link', { name: /Application Development Team/ });
    const company = within(switcher).getByRole('link', { name: /Company Project Team/ });

    expect(application).toHaveAttribute('aria-current', 'page');
    expect(within(application).getByText('当前')).toBeInTheDocument();
    expect(company).not.toHaveAttribute('aria-current');
    expect(company).toHaveAttribute('href', '/agent-teams/agent_team_bmad_tea');
  });

  it('names the selected Team and renders only its Runs, each tagged with the owning Team', () => {
    mockQueries();
    render(<TeamRecords teamId="agent_team_application" />);

    expect(screen.getByRole('heading', { level: 1, name: 'Application Development Team' })).toBeInTheDocument();
    expect(screen.getByTestId('crumbs')).toHaveTextContent('Agent Team / Application Development Team');
    const runLink = screen.getByRole('link', { name: /Goal run_app/ });
    expect(runLink).toHaveAttribute('href', '/agent-team-runs/run_app');
    expect(within(runLink).getByText('Application Development Team')).toBeInTheDocument();
    expect(screen.queryByText('Goal run_1')).not.toBeInTheDocument();
  });

  it('opens the selected Team\'s configuration', () => {
    mockQueries();
    render(<TeamRecords teamId="agent_team_application" />);
    expect(screen.getByRole('link', { name: '查看配置' })).toHaveAttribute('href', '/agent-teams/agent_team_application/config');
  });

  it('keeps the switcher visible when the selected Team has no Runs', () => {
    mockQueries({ agent_team_bmad_tea: [] });
    render(<TeamRecords teamId="agent_team_bmad_tea" />);
    expect(screen.getByText('暂无执行记录。')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: '选择 Agent Team' })).getAllByRole('link')).toHaveLength(2);
  });

  it('opens the default Company Project Team from /agent-teams', () => {
    expect(AgentTeamsIndexRoute.path).toBe('/agent-teams/');
    const Component = AgentTeamsIndexRoute.options.component as React.ComponentType;
    render(<Component />);
    expect(screen.getByTestId('navigate')).toHaveTextContent('/agent-teams/agent_team_bmad_tea');
    expect(screen.getByTestId('navigate')).toHaveAttribute('data-replace', 'true');
  });
});
