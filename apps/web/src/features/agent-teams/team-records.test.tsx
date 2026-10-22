import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import type { AgentTeamRunSummary, AgentTeamView } from '@worklite/contracts';
import { useAgentTeamRecordsQuery, useAgentTeamsQuery } from '@/api/queries';
import { Route as AgentTeamsIndexRoute } from '@/routes/agent-teams/index';
import { filterRuns, TeamRecords } from './team-records';
import { TeamSwitcher } from './team-switcher';

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

// Radix Select needs pointer-capture and scroll APIs jsdom does not implement.
Object.assign(Element.prototype, { hasPointerCapture: () => false, setPointerCapture: () => undefined, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });

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

function run(id: string, status: AgentTeamRunSummary['status'], intent = `Goal ${id}`, createdAt = '2026-10-21T08:00:00.000Z'): AgentTeamRunSummary {
  return { id, intent, projectDirectory: '/repo', mode: 'implement_and_validate', modeRationale: null, modeDecidedAt: null, orchestrationVersion: 9, status, createdAt, finishedAt: null };
}

const teams = [
  team('agent_team_application', 'Application Development Team', 'Built-in team for planning and developing complete applications.', 2),
  team('agent_team_bmad_tea', 'Company Project Team', 'Built-in BMAD and TEA team for company projects and requirements.', 3),
];

const runsByTeam: Record<string, AgentTeamRunSummary[]> = {
  agent_team_application: [run('run_app', 'queued')],
  agent_team_bmad_tea: [
    run('run_old', 'succeeded', 'Old release', '2026-10-01T08:00:00.000Z'),
    run('run_new', 'running', '## Ship the **login** flow\n\nLong body that must not reach the list row.', '2026-10-21T09:00:00.000Z'),
    run('run_mid', 'failed', 'Fix billing export', '2026-10-10T08:00:00.000Z'),
    run('run_q', 'queued', 'Queued cleanup', '2026-10-15T08:00:00.000Z'),
  ],
};

function mockQueries(records = runsByTeam, state: { isPending?: boolean } = {}) {
  vi.mocked(useAgentTeamsQuery).mockReturnValue({ data: teams } as unknown as ReturnType<typeof useAgentTeamsQuery>);
  vi.mocked(useAgentTeamRecordsQuery).mockImplementation((teamId: string) => ({
    isPending: state.isPending ?? false,
    isError: false,
    data: state.isPending ? undefined : records[teamId] ?? [],
    refetch: vi.fn(),
  }) as unknown as ReturnType<typeof useAgentTeamRecordsQuery>);
}

describe('filterRuns', () => {
  const runs = runsByTeam.agent_team_bmad_tea;

  it('orders Runs newest first across the whole Team', () => {
    expect(filterRuns(runs, 'all', '').map((item) => item.id)).toEqual(['run_new', 'run_q', 'run_mid', 'run_old']);
  });

  it('filters by status and by case-insensitive title keyword, and combines both', () => {
    expect(filterRuns(runs, 'failed', '').map((item) => item.id)).toEqual(['run_mid']);
    expect(filterRuns(runs, 'all', 'BILLING').map((item) => item.id)).toEqual(['run_mid']);
    expect(filterRuns(runs, 'queued', 'billing')).toEqual([]);
  });

  it('matches the single-line title, not the hidden body of a multi-line intent', () => {
    expect(filterRuns(runs, 'all', 'login').map((item) => item.id)).toEqual(['run_new']);
    expect(filterRuns(runs, 'all', 'Long body')).toEqual([]);
  });
});

describe('TeamRecords', () => {
  it('renders one fixed-height single-line row per Run, newest first, linking to the Run detail', () => {
    mockQueries();
    render(<TeamRecords teamId="agent_team_bmad_tea" />);

    const links = screen.getAllByRole('link').filter((link) => link.getAttribute('href')?.startsWith('/agent-team-runs/'));
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/agent-team-runs/run_new', '/agent-team-runs/run_q', '/agent-team-runs/run_mid', '/agent-team-runs/run_old']);
    expect(links.every((link) => link.className.includes('h-12'))).toBe(true);
    // The Markdown heading collapses to one plain line; the body stays in the detail page and the tooltip.
    const title = within(links[0]).getByText('Ship the login flow');
    expect(title).toHaveClass('truncate');
    expect(title).toHaveAttribute('title', expect.stringContaining('Long body'));
    expect(within(links[0]).queryByText(/Long body/)).not.toBeInTheDocument();
    expect(within(links[0]).getByText('运行中')).toBeInTheDocument();
    expect(within(links[0]).getByText(/2026/)).toBeInTheDocument();
    expect(within(links[0]).queryByText('/repo')).not.toBeInTheDocument();
  });

  it('filters by keyword and keeps the list shape', () => {
    mockQueries();
    render(<TeamRecords teamId="agent_team_bmad_tea" />);

    fireEvent.change(screen.getByRole('textbox', { name: '按标题搜索' }), { target: { value: 'billing' } });
    expect(screen.getByRole('link', { name: /Fix billing export/ })).toBeInTheDocument();
    expect(screen.queryByText('Queued cleanup')).not.toBeInTheDocument();
  });

  it('filters by status', () => {
    mockQueries();
    render(<TeamRecords teamId="agent_team_bmad_tea" />);

    fireEvent.keyDown(screen.getByRole('combobox', { name: '按状态筛选' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: '排队中' }));
    expect(screen.getByText('Queued cleanup')).toBeInTheDocument();
    expect(screen.queryByText('Fix billing export')).not.toBeInTheDocument();
  });

  it('shows a single-line empty state when no Run matches the filters', () => {
    mockQueries();
    render(<TeamRecords teamId="agent_team_bmad_tea" />);

    fireEvent.change(screen.getByRole('textbox', { name: '按标题搜索' }), { target: { value: 'nothing like this' } });
    expect(screen.getByText('没有符合筛选条件的记录。').parentElement).toHaveClass('h-12');
    expect(screen.queryByRole('link', { name: /Ship the login flow/ })).not.toBeInTheDocument();
  });

  it('shows a single-line empty state for a Team without Runs', () => {
    mockQueries({ agent_team_bmad_tea: [] });
    render(<TeamRecords teamId="agent_team_bmad_tea" />);
    expect(screen.getByText('暂无执行记录。').parentElement).toHaveClass('h-12');
  });

  it('keeps the heading, Team tabs and filters mounted behind fixed-height skeleton rows while loading', () => {
    mockQueries(runsByTeam, { isPending: true });
    render(<TeamRecords teamId="agent_team_bmad_tea" />);

    expect(screen.getByRole('heading', { level: 1, name: 'Company Project Team' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '选择 Agent Team' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '按标题搜索' })).toBeDisabled();
    const rows = [...screen.getByRole('status').querySelectorAll('li')];
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => row.className.includes('h-12'))).toBe(true);
  });

  it('offers both Teams as tabs and highlights the selected one', () => {
    mockQueries();
    render(<TeamRecords teamId="agent_team_application" />);

    const tabs = screen.getByRole('navigation', { name: '选择 Agent Team' });
    const application = within(tabs).getByRole('link', { name: 'Application Development Team' });
    const company = within(tabs).getByRole('link', { name: 'Company Project Team' });
    expect(application).toHaveAttribute('aria-current', 'page');
    expect(company).not.toHaveAttribute('aria-current');
    expect(company).toHaveAttribute('href', '/agent-teams/agent_team_bmad_tea');
  });

  it('names the selected Team and renders only its Runs', () => {
    mockQueries();
    render(<TeamRecords teamId="agent_team_application" />);

    expect(screen.getByRole('heading', { level: 1, name: 'Application Development Team' })).toBeInTheDocument();
    expect(screen.getByTestId('crumbs')).toHaveTextContent('Agent Team / Application Development Team');
    expect(screen.getByRole('link', { name: /Goal run_app/ })).toHaveAttribute('href', '/agent-team-runs/run_app');
    expect(screen.queryByText('Ship the login flow')).not.toBeInTheDocument();
  });

  it('puts the configuration entry in the page header for the selected Team', () => {
    mockQueries();
    render(<TeamRecords teamId="agent_team_application" />);
    expect(screen.getByRole('link', { name: '查看配置' })).toHaveAttribute('href', '/agent-teams/agent_team_application/config');
  });

  it('opens the default Company Project Team from /agent-teams', () => {
    expect(AgentTeamsIndexRoute.path).toBe('/agent-teams/');
    const Component = AgentTeamsIndexRoute.options.component as React.ComponentType;
    render(<Component />);
    expect(screen.getByTestId('navigate')).toHaveTextContent('/agent-teams/agent_team_bmad_tea');
    expect(screen.getByTestId('navigate')).toHaveAttribute('data-replace', 'true');
  });
});

describe('TeamSwitcher (configuration view)', () => {
  it('shows both Teams as cards with focus, concurrency and active/queued counts, linking to their configuration', () => {
    mockQueries();
    render(<TeamSwitcher teamId="agent_team_bmad_tea" />);

    const switcher = screen.getByRole('navigation', { name: '选择 Agent Team' });
    const company = within(switcher).getByRole('link', { name: /Company Project Team/ });
    const application = within(switcher).getByRole('link', { name: /Application Development Team/ });

    expect(company).toHaveAttribute('aria-current', 'page');
    expect(application).toHaveAttribute('href', '/agent-teams/agent_team_application/config');
    expect(within(company).getByText('面向已有公司仓库')).toBeInTheDocument();
    expect(within(application).getByText('面向全新应用开发')).toBeInTheDocument();
    expect(within(company).getByText('并发上限').nextSibling).toHaveTextContent('3');
    // running is active; queued is counted separately; terminal Runs are neither.
    expect(within(company).getByText('运行中').nextSibling).toHaveTextContent('1');
    expect(within(company).getByText('排队中').nextSibling).toHaveTextContent('1');
    expect(within(application).getByText('排队中').nextSibling).toHaveTextContent('1');
  });
});
