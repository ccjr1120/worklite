import { describe, expect, it } from 'vitest';
import type { AgentTeamRunView } from '@worklite/contracts';
import { renderCard, teamRunMeta } from './feishu-cards';

function run(overrides: Partial<AgentTeamRunView>): AgentTeamRunView {
  return {
    status: 'running', createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z', finishedAt: null,
    progress: { phase: 'working', nextStep: 'await_task_results', totalTasks: 0, completedTasks: 0, activeTaskKeys: [], waitingReason: null },
    current: null,
    ...overrides,
  } as AgentTeamRunView;
}

const current = {
  taskAttemptId: 'a', taskKey: 'review', role: 'reviewer', roleName: null, model: 'gpt-review', status: 'running' as const,
  assignmentTitle: null, progressText: '', startedAt: '2026-10-23T00:20:00.000Z', activeCount: 1, activeRoleCount: 1,
};
const now = Date.parse('2026-10-23T01:25:00.000Z');

describe('Feishu Coder Run card summary', () => {
  it('shows the current role, its model, role elapsed and Run total', () => {
    expect(teamRunMeta(run({ current }), now)).toBe('Reviewer · gpt-review · 本角色 1 小时 5 分钟 · 总耗时 1 小时 25 分钟');
  });

  it('summarizes active role tasks and task progress', () => {
    const meta = teamRunMeta(run({
      current: { ...current, role: 'developer', model: 'gpt-codex', activeCount: 3 },
      progress: { ...run({}).progress, totalTasks: 4, completedTasks: 1 },
    }), now);
    expect(meta).toBe('Developer ×3 · gpt-codex · 任务 1/4 · 总耗时 1 小时 25 分钟');
  });

  it('keeps only the total once the Run settles', () => {
    expect(teamRunMeta(run({ status: 'succeeded', current, finishedAt: '2026-10-23T00:42:00.000Z' }), now)).toBe('总耗时 42 分钟');
  });

  it('keeps task details in the default-collapsed panel', () => {
    const { card } = renderCard('sub_1', { title: 'Chat · coders', status: '正在执行', meta: 'Reviewer · gpt-review', content: '目标', details: '- review', buttons: [] });
    const elements = card.body.elements;
    expect(elements.find((element) => element.element_id === 'meta')).toMatchObject({ text: { content: 'Reviewer · gpt-review' } });
    expect(elements.find((element) => element.element_id === 'details')).toMatchObject({ tag: 'collapsible_panel', expanded: false });
  });
});
