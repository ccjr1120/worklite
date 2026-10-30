import { describe, expect, it } from 'vitest';
import { activitiesByAttempt, operationActivities } from './executor-run-nodes';

describe('isolated executor operations in node timelines', () => {
  it('turns journaled tool calls into bounded step activity with start and finish', () => {
    const start = new Date('2026-10-30T00:00:00Z');
    const end = new Date('2026-10-30T00:00:02Z');
    const rows = operationActivities([{ key: 'run:planner:1', runId: 'run', taskAttemptId: 'attempt', toolName: 'read', status: 'completed', createdAt: start, updatedAt: end }]);
    const grouped = activitiesByAttempt(rows).get('attempt');
    expect(grouped).toHaveLength(2);
    expect(grouped?.[0]).toMatchObject({ createdAt: start, payload: { phase: 'claude.tool_started', summary: 'read' } });
    expect(grouped?.[1]).toMatchObject({ createdAt: end, payload: { phase: 'claude.tool_completed', summary: 'read' } });
  });

  it('keeps a pending tool call open', () => {
    const at = new Date();
    expect(operationActivities([{ key: 'a', runId: 'run', taskAttemptId: 'attempt', toolName: 'grep', status: 'reserved', createdAt: at, updatedAt: at }])).toHaveLength(1);
  });
});
