import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import type { AgentTeamRunView, AgentTeamTaskAttemptView, ChatSubmissionView } from '@worklite/contracts';
import { useAgentTeamRunQuery } from '@/api/queries';
import { TaskCard } from './task-messages';

vi.mock('@/api/queries', () => ({
  agentTeamGroupQueryKey: (id: string) => ['agent-team-group', id],
  agentTeamRunQueryKey: (id: string) => ['agent-team-run', id],
  useAgentTeamRunQuery: vi.fn(),
  useRunQuery: vi.fn(() => ({ data: undefined })),
  useWorkliteUpgradeQuery: vi.fn(() => ({ data: undefined })),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params, ...props }: { children: React.ReactNode; to: string; params?: Record<string, string> }) => <a href={Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)} {...props}>{children}</a>,
}));

afterEach(cleanup);

const NOW = Date.parse('2026-10-23T01:25:00.000Z');

function attempt(overrides: Partial<AgentTeamTaskAttemptView>): AgentTeamTaskAttemptView {
  return {
    id: 'attempt_plan', taskKey: 'planning', attemptIndex: 0, role: 'planner', status: 'completed', inputFingerprint: '', result: null, error: null,
    retryable: false, developerId: null, assignmentTitle: null, progressText: '', roleName: null, model: 'gpt-planner',
    createdAt: '2026-10-23T00:00:00.000Z', startedAt: '2026-10-23T00:00:00.000Z', finishedAt: '2026-10-23T00:10:00.000Z',
    ...overrides,
  };
}

function teamRun(overrides: Partial<AgentTeamRunView> = {}): AgentTeamRunView {
  const reviewer = attempt({ id: 'attempt_review', taskKey: 'review', role: 'reviewer', status: 'running', model: 'gpt-review', progressText: '核对接口改动\n更多细节', startedAt: '2026-10-23T00:20:00.000Z', finishedAt: null });
  return {
    id: 'atr_1', teamId: 'team_1', groupId: null, targetRole: null, repositoryIds: [],
    teamVersion: { id: 'atv_1', version: 1, createdAt: '2026-10-23T00:00:00.000Z', orchestrationVersion: 11 },
    status: 'running', intent: '实现登录页', projectDirectory: '/tmp/project', mode: 'implement', modeRationale: null, modeDecidedAt: null,
    authorizedCommands: [], scopeRevision: 0, desiredControlState: 'none',
    tasks: [attempt({}), reviewer], documents: [], pendingInputs: [], operations: [], activities: [],
    progress: { phase: 'review', nextStep: 'review', totalAssignments: 0, completedAssignments: 0, activeDeveloperIds: [], waitingReason: null, percent: 80 },
    current: { taskAttemptId: reviewer.id, taskKey: reviewer.taskKey, role: reviewer.role, roleName: null, model: reviewer.model, status: reviewer.status, assignmentTitle: null, progressText: reviewer.progressText, startedAt: reviewer.startedAt, activeCount: 1, activeRoleCount: 1 },
    outcome: null, worktreeBasePath: null, runBranch: null,
    createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T01:00:00.000Z', finishedAt: null,
    ...overrides,
  };
}

const submission: ChatSubmissionView = {
  id: 'sub_team', origin: 'chat', executionId: 'aex_1', message: '实现登录页并补测试', reference: { kind: 'team', runId: 'atr_1' } as ChatSubmissionView['reference'],
  outputMessageId: null, renderedCard: null, settled: false, error: null, createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z',
};

function mockRun(run: AgentTeamRunView) {
  vi.mocked(useAgentTeamRunQuery).mockReturnValue({ data: run, isPending: false, isError: false } as ReturnType<typeof useAgentTeamRunQuery>);
}

describe('Chat Team Run card', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('collapses to goal, status, phase, current role, its model and elapsed times', () => {
    mockRun(teamRun());
    render(<TaskCard submission={submission} />);

    expect(screen.getByText('实现登录页并补测试')).toBeVisible();
    expect(screen.getByText('执行中')).toBeVisible();
    expect(screen.getByText('审查中 · 80%')).toBeVisible();
    expect(screen.getByText('核对接口改动')).toBeVisible();
    expect(screen.getByText('Reviewer')).toBeVisible();
    expect(screen.getByText('gpt-review')).toBeVisible();
    expect(screen.getByText('本角色 1 小时 5 分钟')).toBeVisible();
    expect(screen.getByText('总耗时 1 小时 25 分钟')).toBeVisible();
    expect(screen.getByRole('button', { name: '暂停' })).toBeVisible();
    expect(screen.queryByText('角色任务')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '展开团队任务详情' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows parallel Developer lanes by count with assignment progress', () => {
    const run = teamRun();
    mockRun(teamRun({
      progress: { ...run.progress, phase: 'development', totalAssignments: 4, completedAssignments: 1 },
      current: { ...run.current!, role: 'developer', model: 'gpt-codex', activeCount: 3 },
    }));
    render(<TaskCard submission={submission} />);

    expect(screen.getByText('Developer ×3')).toBeVisible();
    expect(screen.getByText('gpt-codex')).toBeVisible();
    expect(screen.getByText('开发任务 1/4')).toBeVisible();
    expect(screen.queryByText(/本角色/)).not.toBeInTheDocument();
  });

  it('lists role tasks with model and elapsed time only after expanding', () => {
    mockRun(teamRun());
    render(<TaskCard submission={submission} />);
    fireEvent.click(screen.getByRole('button', { name: '展开团队任务详情' }));

    expect(screen.getByText('角色任务')).toBeVisible();
    expect(screen.getByText('Planner · planning · gpt-planner · 10 分钟')).toBeVisible();
    expect(screen.getByRole('link', { name: '打开任务详情' })).toHaveAttribute('href', '/agent-team-runs/atr_1');
  });

  it('keeps only the total elapsed time once the Run settles', () => {
    mockRun(teamRun({ status: 'succeeded', finishedAt: '2026-10-23T00:42:00.000Z', progress: { ...teamRun().progress, phase: 'terminal', percent: 100 } }));
    render(<TaskCard submission={submission} />);

    expect(screen.getByText('已完成')).toBeVisible();
    expect(screen.getByText('总耗时 42 分钟')).toBeVisible();
    expect(screen.queryByText('Reviewer')).not.toBeInTheDocument();
    expect(screen.queryByText(/80%/)).not.toBeInTheDocument();
  });
});
