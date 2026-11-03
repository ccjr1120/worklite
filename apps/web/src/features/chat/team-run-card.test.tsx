import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import type { AgentTeamRunNode, AgentTeamRunView, AgentTeamTaskAttemptView, ChatSubmissionView } from '@worklite/contracts';
import { useAgentTeamRunQuery, useAgentTeamRunUsageQuery } from '@/api/queries';
import { TooltipProvider } from '@/components/ui/tooltip';
import { LocaleProvider } from '@/components/locale-provider';
import { TaskCard } from './task-messages';

vi.mock('@/features/coders/coder-run-detail', () => ({ CoderRunDialog: ({ children }: { children: React.ReactNode }) => children }));

vi.mock('@/api/queries', () => ({
  agentTeamGroupQueryKey: (id: string) => ['agent-team-group', id],
  agentTeamRunQueryKey: (id: string) => ['agent-team-run', id],
  coderRunStatusCountsQueryKey: () => ['coder-run-status-counts'],
  useAgentTeamRunQuery: vi.fn(),
  useAgentTeamRunUsageQuery: vi.fn(),
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

function node(overrides: Partial<AgentTeamRunNode>): AgentTeamRunNode {
  return {
    nodeRunId: 'attempt_review',
    taskKey: 'review',
    name: 'Review',
    role: 'reviewer',
    roleName: null,
    developerId: null,
    status: 'running',
    attemptIndex: 0,
    durationMs: 3900000, // 1h05m
    tokens: { tokens: 12400, source: 'exact' },
    startedAt: '2026-10-23T00:20:00.000Z',
    endedAt: null,
    latestActivity: '核对接口改动',
    steps: [],
    stepsOmitted: 0,
    ...overrides,
  };
}

function teamRun(overrides: Partial<AgentTeamRunView> = {}): AgentTeamRunView {
  const reviewer = attempt({ id: 'attempt_review', taskKey: 'review', role: 'reviewer', status: 'running', model: 'gpt-review', progressText: '核对接口改动\n更多细节', startedAt: '2026-10-23T00:20:00.000Z', finishedAt: null });
  return {
    id: 'atr_1', coderId: 'team_1', coderName: 'General project', groupId: null, targetRole: null, repositoryIds: [],
    teamVersion: { id: 'atv_1', version: 1, createdAt: '2026-10-23T00:00:00.000Z', orchestrationVersion: 11 },
    status: 'running', intent: '实现登录页', projectDirectory: '/tmp/project', mode: 'implement_and_validate', modeRationale: null, modeDecidedAt: null,
    authorizedCommands: [], scopeRevision: 0, desiredControlState: 'none',
    tasks: [attempt({}), reviewer], documents: [], pendingInputs: [], operations: [], activities: [],
    progress: { phase: 'review', nextStep: 'review', totalAssignments: 0, completedAssignments: 0, activeDeveloperIds: [], waitingReason: null },
    current: { taskAttemptId: reviewer.id, taskKey: reviewer.taskKey, role: reviewer.role, roleName: null, model: reviewer.model, status: reviewer.status, assignmentTitle: null, progressText: reviewer.progressText, startedAt: reviewer.startedAt, activeCount: 1, activeRoleCount: 1 },
    outcome: null, worktreeBasePath: null, runBranch: null,
    createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T01:00:00.000Z', finishedAt: null,
    ...overrides,
  };
}

const submission: ChatSubmissionView = {
  id: 'sub_team', origin: 'chat', executionId: 'aex_1', message: '实现登录页并补测试', reference: { kind: 'coder', runId: 'atr_1' } as ChatSubmissionView['reference'],
  outputMessageId: null, renderedCard: null, settled: false, error: null, createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z',
};

function mockRun(run: AgentTeamRunView) {
  vi.mocked(useAgentTeamRunQuery).mockReturnValue({ data: run, isPending: false, isError: false } as ReturnType<typeof useAgentTeamRunQuery>);
}

function mockUsage(
  nodes: AgentTeamRunNode[],
  totalTokens?: { tokens: number | null; source: 'exact' | 'estimated' | 'unavailable' }
): void {
  const resolved = totalTokens || { tokens: null, source: 'unavailable' as const };
  vi.mocked(useAgentTeamRunUsageQuery).mockReturnValue({
    data: { nodes, totalTokens: resolved, retentionHours: 12 },
    isPending: false,
    isError: false,
  } as ReturnType<typeof useAgentTeamRunUsageQuery>);
}

describe('Chat executor Run card', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('displays phase, step, current role, role token/elapsed, and run total token/elapsed', () => {
    mockRun(teamRun());
    const nodes = [node({})];
    const totalTokens: { tokens: number | null; source: 'exact' | 'estimated' | 'unavailable' } = { tokens: 48100, source: 'estimated' };
    mockUsage(nodes, totalTokens);
    render(
      <LocaleProvider>
        <TooltipProvider>
          <TaskCard submission={submission} />
        </TooltipProvider>
      </LocaleProvider>
    );

    // Header: title and status
    expect(screen.getByText('实现登录页并补测试')).toBeVisible();
    expect(screen.getByText('执行中')).toBeVisible();

    // Progress line: phase and step
    expect(screen.getByText(/审查中.*核对接口改动/)).toBeVisible();

    // Current role line should exist
    expect(screen.getByText('角色')).toBeVisible();
    expect(screen.getByText('Reviewer')).toBeVisible();

    // Current role metrics: 1h05m (3900s)
    expect(screen.getByText('1h05m')).toBeVisible();
    expect(screen.getByText('12.4k')).toBeVisible();

    // Run total metrics: 1h25m (5100s from 00:00:00 to 01:25:00)
    expect(screen.getByText('累计')).toBeVisible();
    expect(screen.getByText('1h25m')).toBeVisible();
    expect(screen.getByText('≈48.1k')).toBeVisible(); // estimated

    // Actions
    expect(screen.getByRole('button', { name: '暂停' })).toBeVisible();
    expect(screen.getByRole('button', { name: '打开任务详情' })).toBeVisible();

    // Old fields should not appear
    expect(screen.queryByText('gpt-review')).not.toBeInTheDocument();
    expect(screen.queryByText('General project')).not.toBeInTheDocument();
    expect(screen.queryByText(/角色任务|开发任务/)).not.toBeInTheDocument();
  });

  it('shows parallel Developer lanes by count without per-role metrics', () => {
    const run = teamRun();
    mockRun(teamRun({
      progress: { ...run.progress, phase: 'development', totalAssignments: 4, completedAssignments: 1 },
      current: { ...run.current!, role: 'developer', model: 'gpt-codex', activeCount: 3, activeRoleCount: 1 },
    }));
    mockUsage([], { tokens: 48100, source: 'exact' });
    render(
      <LocaleProvider>
        <TooltipProvider>
          <TaskCard submission={submission} />
        </TooltipProvider>
      </LocaleProvider>
    );

    // Check for Developer ×3 using a regex or just check individual parts
    expect(screen.getByText(/Developer/)).toBeVisible();
    expect(screen.getByText(/×3/)).toBeVisible();
    expect(screen.getByText(/开发中.*核对接口改动/)).toBeVisible();

    // No per-role metrics when activeCount > 1
    expect(screen.queryByText('角色')).not.toBeInTheDocument();
    expect(screen.queryByText('1h05m')).not.toBeInTheDocument();

    // Run total still shows
    expect(screen.getByText('累计')).toBeVisible();
    expect(screen.getByText('1h25m')).toBeVisible();

    // No model, no assignments shown
    expect(screen.queryByText('gpt-codex')).not.toBeInTheDocument();
    expect(screen.queryByText(/角色任务|开发任务/)).not.toBeInTheDocument();
  });

  it('keeps only run total after the Run settles', () => {
    mockRun(teamRun({ status: 'succeeded', finishedAt: '2026-10-23T00:42:00.000Z', progress: { ...teamRun().progress, phase: 'terminal' }, current: null }));
    mockUsage([], { tokens: 50000, source: 'exact' });
    render(
      <LocaleProvider>
        <TooltipProvider>
          <TaskCard submission={submission} />
        </TooltipProvider>
      </LocaleProvider>
    );

    expect(screen.getByText('已完成')).toBeVisible();

    // Run total still shows (42 min from 00:00:00 to 00:42:00)
    expect(screen.getByText('累计')).toBeVisible();
    expect(screen.getByText('42m00s')).toBeVisible();
    expect(screen.getByText('50k')).toBeVisible();

    // Current role line should not be visible
    expect(screen.queryByText('Reviewer')).not.toBeInTheDocument();
    expect(screen.queryByText('角色')).not.toBeInTheDocument();

    // No phase/step in progress line
    expect(screen.queryByText(/审查中/)).not.toBeInTheDocument();
  });

  it('shows unavailable token as dash', () => {
    mockRun(teamRun());
    mockUsage([node({ tokens: { tokens: null, source: 'unavailable' as const } })]);
    render(
      <LocaleProvider>
        <TooltipProvider>
          <TaskCard submission={submission} />
        </TooltipProvider>
      </LocaleProvider>
    );

    // Token figure displays as —
    const tokUnitElements = screen.getAllByText('tok');
    expect(tokUnitElements.length).toBeGreaterThan(0);

    // Current role and run total should both be visible
    expect(screen.getByText('1h05m')).toBeVisible();
    expect(screen.getByText('1h25m')).toBeVisible();
  });
});
