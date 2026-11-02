import { describe, expect, it } from 'vitest';
import type { GatewayAttributionGroup } from '@worklite/contracts';
import { activitiesByAttempt, operationActivities, runTotalFromNodeStats } from './coder-run-nodes';

describe('isolated Coder operations in node timelines', () => {
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

function statsGroup(teamRunId: string, nodeRunId: string | null, totalTokens: number | null): GatewayAttributionGroup {
  return {
    key: `${teamRunId}:${nodeRunId ?? '-'}`, surface: null, conversationId: null, executor: null, coderId: null,
    teamRunId, workflowId: null, workflowRunId: null, nodeRunId,
    requests: 1, successful: 1, failed: 0, averageLatencyMs: null,
    promptTokens: null, completionTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
    totalTokens, usageRequests: totalTokens === null ? 0 : 1,
  };
}

describe('Run token total from node statistics', () => {
  it('is unavailable when Gateway statistics could not be read', () => {
    expect(runTotalFromNodeStats(null, 'run')).toEqual({ tokens: null, source: 'unavailable', reason: 'gateway_unavailable' });
  });

  it('reports no traffic when the Run has no statistics group', () => {
    expect(runTotalFromNodeStats([statsGroup('other', 'node', 10)], 'run')).toEqual({ tokens: null, source: 'unavailable', reason: 'no_gateway_traffic' });
  });

  it('reports missing usage when every group of the Run has no total', () => {
    expect(runTotalFromNodeStats([statsGroup('run', 'a', null), statsGroup('run', null, null)], 'run')).toEqual({ tokens: null, source: 'unavailable', reason: 'usage_not_reported' });
  });

  it('sums every group of the Run, including traffic outside any node', () => {
    const groups = [statsGroup('run', 'a', 100), statsGroup('run', 'b', null), statsGroup('run', null, 40), statsGroup('other', 'c', 999)];
    const total = runTotalFromNodeStats(groups, 'run');
    expect(total).toEqual({ tokens: 140, source: 'exact' });
    const nodeSum = groups.filter((group) => group.teamRunId === 'run' && group.nodeRunId).reduce((sum, group) => sum + (group.totalTokens ?? 0), 0);
    expect(total.tokens!).toBeGreaterThan(nodeSum);
  });
});
