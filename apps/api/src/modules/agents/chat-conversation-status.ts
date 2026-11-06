import { and, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import { agentExecutions, auditLogs, chatProjectTasks, chatSubmissions, coderRuns, workflowRuns, type Database } from '@worklite/db';
import type { AgentExecutionStatus } from '@worklite/contracts';

/** Background work is independent of the Chat turn that launched it. Use live owning
 * executions, never launch receipts, report delivery markers or historical invocation states.
 * A paused sub-Agent keeps its owning execution running; restart recovery settles that owner.
 */
export async function activeChatBackgroundExecutionIds(db: Database, workspaceId: string, executionIds: string[]): Promise<Set<string>> {
  if (!executionIds.length) return new Set();
  const conversationId = sql<string>`json_extract(${auditLogs.metadata}, '$.conversationId')`;
  const [tasks, teamRuns, workflows, agentRuns] = await Promise.all([
    db.select({ executionId: chatProjectTasks.executionId }).from(chatProjectTasks)
      .where(and(eq(chatProjectTasks.workspaceId, workspaceId), inArray(chatProjectTasks.executionId, executionIds), inArray(chatProjectTasks.status, ['running', 'waiting_for_input']))),
    db.select({ executionId: chatSubmissions.executionId }).from(chatSubmissions)
      .innerJoin(coderRuns, and(eq(coderRuns.workspaceId, chatSubmissions.workspaceId), sql`${coderRuns.id} = json_extract(${chatSubmissions.reference}, '$.runId')`))
      .where(and(eq(chatSubmissions.workspaceId, workspaceId), inArray(chatSubmissions.executionId, executionIds), isNotNull(chatSubmissions.executionId),
        sql`json_extract(${chatSubmissions.reference}, '$.kind') = 'coder'`, notInArray(coderRuns.status, ['succeeded', 'failed', 'cancelled']))),
    db.select({ executionId: chatSubmissions.executionId }).from(chatSubmissions)
      .innerJoin(workflowRuns, and(eq(workflowRuns.workspaceId, chatSubmissions.workspaceId), sql`${workflowRuns.id} = json_extract(${chatSubmissions.reference}, '$.runId')`))
      .where(and(eq(chatSubmissions.workspaceId, workspaceId), inArray(chatSubmissions.executionId, executionIds), isNotNull(chatSubmissions.executionId),
        sql`json_extract(${chatSubmissions.reference}, '$.kind') = 'workflow'`, notInArray(workflowRuns.status, ['succeeded', 'failed', 'cancelled', 'timed_out']))),
    db.select({ executionId: conversationId }).from(auditLogs)
      .innerJoin(agentExecutions, and(eq(agentExecutions.id, auditLogs.resource), eq(agentExecutions.workspaceId, auditLogs.workspaceId)))
      .where(and(eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.action, 'chat_agent.dispatched'), inArray(conversationId, executionIds),
        inArray(agentExecutions.status, ['running', 'waiting_for_input']))),
  ]);
  return new Set([...tasks, ...teamRuns, ...workflows, ...agentRuns].map((row) => row.executionId).filter((id): id is string => typeof id === 'string'));
}

export function chatConversationStatus(turnStatus: AgentExecutionStatus, hasActiveBackgroundWork: boolean): AgentExecutionStatus {
  // Pending questions and failures remain on the turn, while unfinished background work
  // takes precedence for the whole conversation. This does not change turn controls.
  return hasActiveBackgroundWork ? 'running' : turnStatus;
}
