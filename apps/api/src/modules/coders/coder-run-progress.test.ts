import { describe, expect, it } from 'vitest';
import { deriveRunProgress } from './coder-runtime.service';

const run = { status: 'running', desiredControlState: 'none' } as Parameters<typeof deriveRunProgress>[0];
const row = (taskKey: string) => ({
  taskKey, active: true, status: 'running', result: null, developerId: null,
}) as Parameters<typeof deriveRunProgress>[1][number];

describe('Coder run progress', () => {
  it('reports the actual group planner phase without an invented percentage', () => {
    const progress = deriveRunProgress(run, [row('group_0_planner')]);
    expect(progress.phase).toBe('planning');
    expect(progress.nextStep).toBe('dispatch_assignments');
    expect(progress).not.toHaveProperty('percent');
  });

  it.each([
    ['group_1_executor', 'development'],
    ['group_2_test_runner', 'test_execution'],
    ['group_3_reviewer', 'review'],
    ['group_4_custom_role', 'working'],
  ] as const)('maps %s to %s', (taskKey, phase) => {
    expect(deriveRunProgress(run, [row(taskKey)]).phase).toBe(phase);
  });

  it('does not present a failed run as complete progress', () => {
    const progress = deriveRunProgress({ ...run, status: 'failed' }, [row('group_0_planner')]);
    expect(progress.phase).toBe('terminal');
    expect(progress).not.toHaveProperty('percent');
  });
});
