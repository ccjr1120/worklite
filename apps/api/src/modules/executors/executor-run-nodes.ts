import type {
  AgentTeamRunCurrentNode,
  AgentTeamRunNode,
  AgentTeamRunNodeStep,
  AgentTeamRunNodeStepKind,
  AgentTeamRunStatus,
  GatewayAttributionGroup,
  GatewayRequestLogTimeline,
  TokenAttribution,
  TokenAttributionReason,
} from '@worklite/contracts';
import type { StoredAgentTeamVersionSnapshot, executorOperations, executorTaskAttempts } from '@worklite/db';
import { taskRoleName } from './executor-run-summary';

export type AttemptRow = typeof executorTaskAttempts.$inferSelect;
export type ActivityRow = { runId: string; sequence: number; payload: unknown; createdAt: Date };

/** Isolated roles journal tool operations instead of emitting engine activity events. */
type OperationActivity = Pick<typeof executorOperations.$inferSelect, 'key' | 'runId' | 'taskAttemptId' | 'toolName' | 'status' | 'createdAt' | 'updatedAt'>;
export function operationActivities(operations: readonly OperationActivity[]): ActivityRow[] {
  return operations.flatMap((operation, index) => {
    const itemId = `operation:${operation.key}`;
    const payload = { taskAttemptId: operation.taskAttemptId, itemId, itemType: 'tool_call', summary: operation.toolName };
    const start = { runId: operation.runId, sequence: -(index * 2 + 2), createdAt: operation.createdAt, payload: { ...payload, phase: 'claude.tool_started' } };
    if (operation.status === 'reserved') return [start];
    return [start, { runId: operation.runId, sequence: -(index * 2 + 1), createdAt: operation.updatedAt, payload: { ...payload, phase: 'claude.tool_completed' } }];
  });
}

const IN_FLIGHT_ATTEMPT_STATUSES: ReadonlySet<AttemptRow['status']> = new Set(['running', 'waiting_for_input', 'waiting_for_recovery']);
const SETTLED_RUN_STATUSES: ReadonlySet<AgentTeamRunStatus> = new Set(['succeeded', 'failed', 'cancelled']);
const ACTION_TEXT_LIMIT = 200;
// Newest steps kept per node; a long Codex turn can report thousands of item events.
const NODE_STEP_LIMIT = 300;

export function isRunInProgress(status: AgentTeamRunStatus): boolean {
  return !SETTLED_RUN_STATUSES.has(status);
}

export function unavailableTokens(reason: TokenAttributionReason): TokenAttribution {
  return { tokens: null, source: 'unavailable', reason };
}

export function durationBetween(start: Date | null, end: Date | null, nowMs: number): number | null {
  if (!start) return null;
  return Math.max(0, (end?.getTime() ?? nowMs) - start.getTime());
}

/**
 * A Run's total from Gateway statistics grouped by team_run. The total is exact whenever
 * the Run has statistics rows, including Runs recorded before node attribution existed.
 */
export function runTotalTokens(group: GatewayAttributionGroup | undefined): TokenAttribution {
  if (!group) return unavailableTokens('no_gateway_traffic');
  if (group.totalTokens === null) return unavailableTokens('usage_not_reported');
  return { tokens: group.totalTokens, source: 'exact' };
}

type ActivityPayload = {
  taskAttemptId?: unknown;
  phase?: unknown;
  itemId?: unknown;
  itemType?: unknown;
  summary?: unknown;
  text?: unknown;
};

function payloadOf(row: ActivityRow): ActivityPayload | null {
  return row.payload && typeof row.payload === 'object' ? row.payload as ActivityPayload : null;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function singleLine(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > ACTION_TEXT_LIMIT ? `${line.slice(0, ACTION_TEXT_LIMIT - 1)}…` : line;
}

/** What one activity says the node is doing, or null when it carries nothing readable. */
function activitySummary(payload: ActivityPayload): string | null {
  const summary = stringField(payload.summary);
  const itemType = stringField(payload.itemType);
  if (summary && summary !== 'error') return singleLine(itemType && !summary.includes(itemType) ? `${itemType} · ${summary}` : summary);
  const text = stringField(payload.text);
  if (text) return singleLine(text);
  return itemType ? singleLine(itemType) : null;
}

/** Activity rows grouped by the attempt they report on, in sequence order. */
export function activitiesByAttempt(rows: readonly ActivityRow[]): Map<string, ActivityRow[]> {
  const grouped = new Map<string, ActivityRow[]>();
  for (const row of [...rows].sort((a, b) => a.sequence - b.sequence)) {
    const attemptId = stringField(payloadOf(row)?.taskAttemptId);
    if (!attemptId) continue;
    const list = grouped.get(attemptId) ?? [];
    list.push(row);
    grouped.set(attemptId, list);
  }
  return grouped;
}

export function latestActivity(rows: readonly ActivityRow[] | undefined): string | null {
  if (!rows) return null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const payload = payloadOf(rows[index]);
    const summary = payload ? activitySummary(payload) : null;
    if (summary) return summary;
  }
  return null;
}

const TOOL_ITEM_TYPES = new Set(['commandExecution', 'mcpToolCall', 'fileChange', 'webSearch', 'dynamicToolCall']);

function stepKind(phase: string, itemType: string | null): AgentTeamRunNodeStepKind {
  if (phase.startsWith('claude.tool_')) return 'tool_call';
  if (phase.startsWith('codex.item_')) return itemType && TOOL_ITEM_TYPES.has(itemType) ? 'tool_call' : 'activity';
  if (phase === 'claude.agent_message') return 'activity';
  return 'step';
}

type StepDraft = { id: string; kind: AgentTeamRunNodeStepKind; label: string; start: number; end: number | null };

/**
 * Turns one attempt's activity into steps. Events that share an itemId (a tool call's start
 * and completion, a Codex item's start and completion) form one step that spans both; every
 * other event is its own step that lasts until the next step starts.
 */
function stepDrafts(rows: readonly ActivityRow[]): StepDraft[] {
  const drafts: StepDraft[] = [];
  const byItem = new Map<string, StepDraft>();
  for (const row of rows) {
    const payload = payloadOf(row);
    if (!payload) continue;
    const phase = stringField(payload.phase) ?? 'activity';
    const itemId = stringField(payload.itemId);
    const itemType = stringField(payload.itemType);
    const at = row.createdAt.getTime();
    const existing = itemId ? byItem.get(itemId) : undefined;
    if (existing) {
      existing.end = at;
      const label = activitySummary(payload);
      if (label) existing.label = label;
      continue;
    }
    const draft: StepDraft = {
      id: `${row.runId}:${row.sequence}`,
      kind: stepKind(phase, itemType),
      label: activitySummary(payload) ?? phase,
      start: at,
      end: itemId ? null : at,
    };
    drafts.push(draft);
    if (itemId) byItem.set(itemId, draft);
  }
  drafts.sort((a, b) => a.start - b.start);
  // A point event lasts until the next step starts; an open item ends with the node.
  for (let index = 0; index < drafts.length; index += 1) {
    const next = drafts[index + 1];
    if (drafts[index].end === drafts[index].start && next) drafts[index].end = next.start;
  }
  return drafts;
}

export type NodeTokenSources = {
  /** node_run statistics rows keyed by nodeRunId; null when Gateway statistics could not be read. */
  statsByNode: Map<string, GatewayAttributionGroup> | null;
  /** Run ids whose statistics include traffic with no node attribution. */
  runsWithUnattributedTraffic: Set<string>;
  /** Request timeline; null when it could not be read. */
  timeline: GatewayRequestLogTimeline | null;
  /** The timeline's requests grouped by nodeRunId, from timelineByNode(). */
  requestsByNode: Map<string, GatewayRequestLogTimeline['items']>;
};

export function timelineByNode(timeline: GatewayRequestLogTimeline | null): Map<string, GatewayRequestLogTimeline['items']> {
  const grouped = new Map<string, GatewayRequestLogTimeline['items']>();
  for (const item of timeline?.items ?? []) {
    if (!item.nodeRunId) continue;
    const list = grouped.get(item.nodeRunId) ?? [];
    list.push(item);
    grouped.set(item.nodeRunId, list);
  }
  return grouped;
}

function nodeTokens(runId: string, attemptId: string, sources: NodeTokenSources): TokenAttribution {
  if (!sources.statsByNode) return unavailableTokens('gateway_unavailable');
  const group = sources.statsByNode.get(attemptId);
  if (group) return group.totalTokens === null ? unavailableTokens('usage_not_reported') : { tokens: group.totalTokens, source: 'exact' };
  return unavailableTokens(sources.runsWithUnattributedTraffic.has(runId) ? 'no_node_attribution' : 'no_gateway_traffic');
}

/**
 * Spreads a node's request tokens over its steps: each request goes to the step whose start
 * is the latest one not after the request's start, so a model call is charged to the step it
 * began in. Requests before the first step go to the first step.
 */
function stepTokens(drafts: readonly StepDraft[], node: TokenAttribution, attemptStart: number | null, requests: GatewayRequestLogTimeline['items'], timeline: GatewayRequestLogTimeline | null): TokenAttribution[] {
  if (node.source === 'unavailable') return drafts.map(() => unavailableTokens(node.reason ?? 'no_gateway_traffic'));
  if (!timeline) return drafts.map(() => unavailableTokens('gateway_unavailable'));
  if (timeline.truncated) return drafts.map(() => unavailableTokens('request_logs_truncated'));
  const retainedFrom = Date.parse(timeline.retainedFrom);
  if (attemptStart !== null && Number.isFinite(retainedFrom) && attemptStart < retainedFrom) {
    return drafts.map(() => unavailableTokens('request_logs_expired'));
  }
  const totals = drafts.map(() => 0);
  for (const item of requests) {
    if (item.totalTokens === null) continue;
    const startedAt = Date.parse(item.startedAt);
    let target = 0;
    for (let index = 0; index < drafts.length && drafts[index].start <= startedAt; index += 1) target = index;
    totals[target] += item.totalTokens;
  }
  return totals.map((tokens) => ({ tokens, source: 'estimated' }));
}

export function nodeName(row: Pick<AttemptRow, 'assignmentTitle' | 'role' | 'taskKey'>, roleName: string | null): string {
  return row.assignmentTitle?.trim() || roleName || row.role;
}

export function buildRunNodes(
  runId: string,
  snapshot: StoredAgentTeamVersionSnapshot,
  attempts: readonly AttemptRow[],
  activities: Map<string, ActivityRow[]>,
  sources: NodeTokenSources,
  nowMs: number,
): AgentTeamRunNode[] {
  return attempts.map((row) => {
    const roleName = taskRoleName(snapshot, row.role);
    const rows = activities.get(row.id) ?? [];
    const startedAt = row.startedAt ?? row.createdAt;
    const tokens = nodeTokens(runId, row.id, sources);
    const allDrafts = stepDrafts(rows);
    const drafts = allDrafts.slice(-NODE_STEP_LIMIT);
    // An open step of a settled node ends with the node; a settled node without a recorded
    // finish ends at its last step.
    const nodeEnd = row.finishedAt?.getTime() ?? (IN_FLIGHT_ATTEMPT_STATUSES.has(row.status) ? null : drafts.at(-1)?.start ?? null);
    const shares = stepTokens(drafts, tokens, startedAt.getTime(), sources.requestsByNode.get(row.id) ?? [], sources.timeline);
    const steps: AgentTeamRunNodeStep[] = drafts.map((draft, index) => {
      const end = draft.end ?? nodeEnd;
      return {
        id: draft.id,
        kind: draft.kind,
        label: draft.label,
        startedAt: new Date(draft.start).toISOString(),
        endedAt: end === null ? null : new Date(end).toISOString(),
        durationMs: end === null ? Math.max(0, nowMs - draft.start) : Math.max(0, end - draft.start),
        tokens: shares[index],
      };
    });
    return {
      nodeRunId: row.id,
      taskKey: row.taskKey,
      attemptIndex: row.attemptIndex,
      name: nodeName(row, roleName),
      role: row.role,
      roleName,
      developerId: row.developerId,
      status: row.status,
      startedAt: startedAt.toISOString(),
      endedAt: row.finishedAt?.toISOString() ?? null,
      durationMs: durationBetween(startedAt, row.finishedAt, nowMs),
      tokens,
      latestActivity: latestActivity(rows),
      steps,
      stepsOmitted: allDrafts.length - drafts.length,
    };
  });
}

/** The node an in-progress Run is on: its most recently started in-flight attempt. */
export function currentRunNode(
  snapshot: StoredAgentTeamVersionSnapshot,
  attempts: readonly AttemptRow[],
  activities: Map<string, ActivityRow[]>,
): AgentTeamRunCurrentNode | undefined {
  const inFlight = attempts.filter((row) => IN_FLIGHT_ATTEMPT_STATUSES.has(row.status));
  if (!inFlight.length) return undefined;
  const started = (row: AttemptRow) => (row.startedAt ?? row.createdAt).getTime();
  const current = inFlight.reduce((latest, row) => started(row) >= started(latest) ? row : latest);
  const roleName = taskRoleName(snapshot, current.role);
  return {
    nodeRunId: current.id,
    name: nodeName(current, roleName),
    role: current.role,
    roleName,
    action: latestActivity(activities.get(current.id)),
  };
}
