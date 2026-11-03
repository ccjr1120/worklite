import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import type { AgentTeamRunView, AgentTeamTaskAttemptView, ChatSubmissionView } from '@worklite/contracts';
import { useAgentTeamRunQuery } from '@/api/queries';
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

function attempt(overrides: Partial<AgentTeamTaskAttemptView>): AgentTeamTaskAttemptView {
  return {
    id: 'attempt_plan', taskKey: 'planning', attemptIndex: 0, role: 'planner', status: 'completed', inputFingerprint: '', result: null, error: null,
    assignmentTitle: null, progressText: '', roleName: null, model: 'gpt-planner',
    createdAt: '2026-10-23T00:00:00.000Z', startedAt: '2026-10-23T00:00:00.000Z', finishedAt: '2026-10-23T00:10:00.000Z',
    ...overrides,
  };
}

function teamRun(overrides: Partial<AgentTeamRunView> = {}): AgentTeamRunView {
  const reviewer = attempt({ id: 'attempt_review', taskKey: 'review', role: 'reviewer', status: 'running', model: 'gpt-review', progressText: '核对接口改动\n更多细节', startedAt: '2026-10-23T00:20:00.000Z', finishedAt: null });
  return {
    id: 'atr_1', coderId: 'team_1', coderName: 'General project', groupId: null, targetRole: null, repositoryIds: [],
    teamVersion: { id: 'atv_1', version: 1, coderName: 'General project', createdAt: '2026-10-23T00:00:00.000Z', projectExecutorLaunches: {}, orchestrationVersion: 12 },
    status: 'running', intent: '实现登录页', projectDirectory: '/tmp/project',
    scopeRevision: 0, desiredControlState: 'none',
    tasks: [attempt({}), reviewer], documents: [], pendingInputs: [], operations: [], activities: [],
    progress: { phase: 'working', nextStep: 'await_task_results', totalTasks: 0, completedTasks: 0, activeTaskKeys: [], waitingReason: null },
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

describe('Chat executor Run card', () => {
  it('shows the executor checklist and keeps completed steps visible', () => {
    const run = teamRun();
    run.tasks[1]!.checklist = [
      { step: '修改登录表单', status: 'completed' },
      { step: '补充测试', status: 'in_progress' },
      { step: '验证结果', status: 'pending' },
    ];
    mockRun(run);
    render(<LocaleProvider><TooltipProvider><TaskCard submission={submission} /></TooltipProvider></LocaleProvider>);
    expect(screen.getByText('修改登录表单')).toBeVisible();
    expect(screen.getByText('补充测试')).toBeVisible();
    expect(screen.getByText('验证结果')).toBeVisible();
    expect(screen.getByText('已完成：')).toBeInTheDocument();
    expect(screen.getByText('执行中：')).toBeInTheDocument();
    expect(screen.getByText('补充测试').parentElement?.querySelector('.animate-spin, .motion-safe\\:animate-spin')).toBeInTheDocument();
    expect(screen.queryByText('累计')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消执行' })).toBeVisible();
  });

  it('replaces the spinning indicator with the animated check when a step completes', () => {
    const run = teamRun();
    run.tasks[1]!.checklist = [{ step: '补充测试', status: 'in_progress' }];
    mockRun(run);
    const view = render(<LocaleProvider><TooltipProvider><TaskCard submission={submission} /></TooltipProvider></LocaleProvider>);
    expect(screen.getByText('补充测试').parentElement?.querySelector('.lucide-loader-circle')).toHaveClass('motion-safe:animate-spin');
    run.tasks[1]!.checklist = [{ step: '补充测试', status: 'completed' }];
    mockRun({ ...run });
    view.rerender(<LocaleProvider><TooltipProvider><TaskCard submission={submission} /></TooltipProvider></LocaleProvider>);
    expect(screen.getByText('补充测试').parentElement?.querySelector('.wl-check-pop')).toBeInTheDocument();
    expect(screen.getByText('补充测试').parentElement?.querySelector('.lucide-loader-circle')).toBeNull();
  });

  it('shows progress when no checklist is available', () => {
    mockRun(teamRun());
    render(<LocaleProvider><TooltipProvider><TaskCard submission={submission} /></TooltipProvider></LocaleProvider>);
    expect(screen.getByText(/核对接口改动/)).toBeVisible();
  });
});
