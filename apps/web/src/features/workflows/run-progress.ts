import type { RunProgressEvent, RunView, WorkflowNodeActivityEventPayload, WorkflowNodeActivityView } from '@worklite/contracts';
import { queryClient } from '@/lib/query-client';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function updateNodeRun(runId: string, nodeRunId: string, update: (nodeRun: RunView['nodeRuns'] extends Array<infer T> | undefined ? T : never) => typeof nodeRun): boolean {
  const current = queryClient.getQueryData<RunView>(['run', runId]);
  if (!current?.nodeRuns?.some((nodeRun) => nodeRun.id === nodeRunId)) return false;
  queryClient.setQueryData<RunView>(['run', runId], {
    ...current,
    nodeRuns: current.nodeRuns.map((nodeRun) => nodeRun.id === nodeRunId ? update(nodeRun) : nodeRun),
  });
  return true;
}

/**
 * Applies a streamed run event to cached Run detail in place.
 *
 * Returns true when the event was fully applied, so the caller can skip
 * refetching. Activity multiplies the event count for one Run, so refetching
 * per event would let a Run's own timeline stall the surface reading it.
 */
function applyRunProgressEvent(runId: string, event: RunProgressEvent): boolean {
  if (event.type === 'node.delta') {
    const payload = asRecord(event.payload);
    const nodeRunId = typeof payload?.nodeRunId === 'string' ? payload.nodeRunId : null;
    const delta = typeof payload?.delta === 'string' ? payload.delta : '';
    if (!nodeRunId || !delta) return true;
    updateNodeRun(runId, nodeRunId, (nodeRun) => ({ ...nodeRun, streamedOutput: (nodeRun.streamedOutput ?? '') + delta }));
    return true;
  }

  if (event.type === 'node.activity') {
    const payload = asRecord(event.payload) as (WorkflowNodeActivityEventPayload & Record<string, unknown>) | null;
    if (!payload || typeof payload.nodeRunId !== 'string') return true;
    const activity: WorkflowNodeActivityView = {
      nodeId: payload.nodeId,
      nodeRunId: payload.nodeRunId,
      phase: payload.phase,
      detail: payload.detail,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
    };
    const applied = updateNodeRun(runId, payload.nodeRunId, (nodeRun) => nodeRun.activity.some((item) => item.sequence === activity.sequence)
      ? nodeRun
      : { ...nodeRun, activity: [...nodeRun.activity, activity].sort((left, right) => left.sequence - right.sequence) });
    // A node run absent from the cache means the entry itself is new, so the
    // caller still needs to load it.
    return applied;
  }

  return false;
}

export { applyRunProgressEvent };
