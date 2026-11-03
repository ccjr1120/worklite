import { describe, expect, it } from 'vitest';
import { deriveRunProgress } from './coder-runtime.service';

const run = { status: 'running', desiredControlState: 'none' } as Parameters<typeof deriveRunProgress>[0];
const row = (taskKey: string, role: string, status = 'running') => ({
  taskKey, role, active: true, status, result: null,
}) as Parameters<typeof deriveRunProgress>[1][number];

describe('Coder run progress', () => {
  it('reports Router coordination without an invented percentage', () => {
    const progress = deriveRunProgress(run, [row('group_router_0', 'router')]);
    expect(progress.phase).toBe('routing');
    expect(progress.nextStep).toBe('route_tasks');
    expect(progress).not.toHaveProperty('percent');
  });

  it('reports work role tasks and completion counts without inferring a fixed role phase', () => {
    const progress = deriveRunProgress(run, [row('group_router_0', 'router', 'completed'), row('group_1_implementer', 'implementer')]);
    expect(progress).toMatchObject({ phase: 'working', nextStep: 'await_task_results', totalTasks: 2, completedTasks: 1, activeTaskKeys: ['group_1_implementer'] });
  });

  it('does not present a failed run as complete progress', () => {
    const progress = deriveRunProgress({ ...run, status: 'failed' }, [row('group_router_0', 'router')]);
    expect(progress.phase).toBe('terminal');
    expect(progress).not.toHaveProperty('percent');
  });
});
