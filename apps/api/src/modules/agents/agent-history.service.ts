import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Request } from 'express';
import type { AgentRunDetailView, AgentRunListView, AgentRunView } from '@worklite/contracts';
import { agentCapabilityResults, agentExecutions, agentRuntimeEvents, agentRuntimeRuns, agentRuntimeSessions, agents, agentToolCalls, artifacts, auditLogs, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';

@Injectable()
export class AgentHistoryService {
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly workspaces: WorkspaceService) {}

  async list(request: Request, agentId: string, offset = 0): Promise<AgentRunListView> {
    const { id: workspaceId } = await this.workspaces.getWorkspace(request, 'personal');
    const agent = this.agent(workspaceId, agentId);
    const take = offset + 21;
    const recorded = this.db.select().from(auditLogs).where(and(eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.action, 'agent.invocation'), sql`json_extract(${auditLogs.metadata}, '$.agentId') = ${agentId}`)).orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(take).all();
    const direct = this.db.select().from(agentExecutions).where(and(eq(agentExecutions.workspaceId, workspaceId), eq(agentExecutions.agentId, agentId), sql`not exists (select 1 from audit_logs a where a.workspace_id = ${workspaceId} and a.action = 'agent.invocation' and a.resource = ${agentExecutions.id} and json_extract(a.metadata, '$.agentId') = ${agentId})`)).orderBy(desc(agentExecutions.createdAt), desc(agentExecutions.id)).limit(take).all();
    const legacy = this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.workspaceId, workspaceId), eq(agentToolCalls.mcpToolName, 'run_agent'), sql`json_extract(${agentToolCalls.input}, '$.__backgroundExecutionId') is null`, sql`json_extract(${agentToolCalls.input}, '$.agentId') = ${agentId}`, sql`not exists (select 1 from audit_logs a where a.workspace_id = ${workspaceId} and a.action = 'agent.invocation' and a.resource = ${agentToolCalls.executionId} and json_extract(a.metadata, '$.agentId') = ${agentId})`)).orderBy(desc(agentToolCalls.createdAt), desc(agentToolCalls.id)).limit(take).all();
    const items = [...legacy.map((row) => this.legacy(row, agentId, agent.name)), ...recorded.map((row) => this.record(row)), ...direct.map((row) => this.execution(row, agent.name))]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { items: items.slice(offset, offset + 20).map((run) => ({ ...run, output: '' })), hasMore: items.length > offset + 20 };
  }

  async detail(request: Request, agentId: string, runId: string): Promise<AgentRunDetailView> {
    const { id: workspaceId } = await this.workspaces.getWorkspace(request, 'personal');
    const agent = this.agent(workspaceId, agentId);
    const row = this.db.select().from(auditLogs).where(and(eq(auditLogs.id, runId), eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.action, 'agent.invocation'), sql`json_extract(${auditLogs.metadata}, '$.agentId') = ${agentId}`)).get();
    let run: AgentRunView;
    let invocations: AgentRunView[];
    if (row) {
      run = this.record(row);
      const all = this.db.select().from(auditLogs).where(and(eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.action, 'agent.invocation'), eq(auditLogs.resource, run.executionId))).orderBy(auditLogs.createdAt, auditLogs.id).all().map((item) => this.record(item));
      const ids = new Set([run.id]);
      // Parent and child can share timestamps; traverse independently of row ordering.
      for (let changed = true; changed;) {
        changed = false;
        for (const item of all) if (item.parentRunId && ids.has(item.parentRunId) && !ids.has(item.id)) { ids.add(item.id); changed = true; }
      }
      invocations = all.filter((item) => ids.has(item.id));
    } else {
      const execution = this.db.select().from(agentExecutions).where(and(eq(agentExecutions.id, runId), eq(agentExecutions.workspaceId, workspaceId), eq(agentExecutions.agentId, agentId))).get();
      const legacy = execution ? undefined : this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.id, runId), eq(agentToolCalls.workspaceId, workspaceId), eq(agentToolCalls.mcpToolName, 'run_agent'), sql`json_extract(${agentToolCalls.input}, '$.agentId') = ${agentId}`)).get();
      if (!execution && !legacy) throw new NotFoundException('Agent run not found.');
      run = execution ? this.execution(execution, agent.name) : this.legacy(legacy!, agentId, agent.name);
      invocations = [run];
    }
    const calls = this.db.select({ output: agentToolCalls.output, input: agentToolCalls.input, status: agentToolCalls.status, toolName: agentToolCalls.mcpToolName }).from(agentToolCalls).where(and(eq(agentToolCalls.workspaceId, workspaceId), eq(agentToolCalls.executionId, run.executionId))).all();
    const invocationIds = new Set(invocations.map((item) => item.id));
    const refs = calls.flatMap((call) => {
      const input = call.input as { __agentRunId?: string } | null;
      if (row && (!input?.__agentRunId || !invocationIds.has(input.__agentRunId))) return [];
      try { const value = JSON.parse(call.output) as { resultRef?: string }; return typeof value.resultRef === 'string' ? [value.resultRef] : []; }
      catch { return []; }
    });
    const results = refs.length ? this.db.select({ value: agentCapabilityResults.value }).from(agentCapabilityResults).where(and(eq(agentCapabilityResults.executionId, run.executionId), inArray(agentCapabilityResults.id, refs))).all() : [];
    const artifactIds = new Set<string>();
    for (const result of results) collectArtifactIds(result.value, artifactIds);
    const saved = this.db.select().from(auditLogs).where(and(eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.action, 'agent.artifact'), eq(auditLogs.resource, run.executionId))).all();
    for (const entry of saved) if (!row || invocationIds.has(String(entry.metadata.invocationId))) {
      if (typeof entry.metadata.artifactId === 'string') artifactIds.add(entry.metadata.artifactId);
      collectArtifactIds(entry.metadata.artifacts, artifactIds);
    }
    const outputs = artifactIds.size ? this.db.select({ id: artifacts.id, name: artifacts.name }).from(artifacts).where(and(eq(artifacts.workspaceId, workspaceId), inArray(artifacts.id, [...artifactIds]))).all() : [];
    const withActivity = (item: AgentRunView): AgentRunView => {
      if (item.status !== 'running' || item.currentActivity) return item;
      const active = calls.filter((call) => call.status === 'running' && (!row || (call.input as { __agentRunId?: string } | null)?.__agentRunId === item.id));
      return { ...item, currentActivity: active.length ? { phase: 'tool', toolName: active.map((call) => call.toolName ?? 'tool').join(', ') } : { phase: 'model' } };
    };
    return { run: withActivity(run), invocations: invocations.map(withActivity), artifacts: outputs };
  }

  private agent(workspaceId: string, agentId: string) {
    const agent = this.db.select({ name: agents.name }).from(agents).where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId))).get();
    if (!agent) throw new NotFoundException('Agent not found.');
    return agent;
  }

  private record(row: typeof auditLogs.$inferSelect): AgentRunView {
    const run = row.metadata as AgentRunView;
    // A killed process cannot complete its invocation's final audit write.
    if (run.status !== 'running') return run;
    const owner = this.db.select({ status: agentExecutions.status, error: agentExecutions.error }).from(agentExecutions).where(and(eq(agentExecutions.workspaceId, row.workspaceId), eq(agentExecutions.id, run.executionId))).get();
    return owner && ['failed', 'cancelled'].includes(owner.status) ? { ...run, status: owner.status, error: owner.error, currentActivity: null } : run;
  }

  private legacy(row: typeof agentToolCalls.$inferSelect, agentId: string, name: string): AgentRunView {
    const input = row.input as { task?: unknown } | null;
    return { id: row.id, executionId: row.executionId, agentId, agentName: name, parentRunId: null, task: typeof input?.task === 'string' ? input.task : JSON.stringify(input?.task) ?? '',
      status: row.status, usage: null, output: row.status === 'completed' ? row.output : '', error: row.status === 'failed' ? row.output : null, createdAt: row.createdAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null };
  }

  private runtimeUsage(workspaceId: string, executionId: string): AgentRunView['usage'] {
    const session = this.db.select().from(agentRuntimeSessions).where(and(eq(agentRuntimeSessions.id, executionId), eq(agentRuntimeSessions.workspaceId, workspaceId))).get();
    if (!session) return null;
    const rows = this.db.select({ runId: agentRuntimeEvents.runId, data: agentRuntimeEvents.data }).from(agentRuntimeEvents).innerJoin(agentRuntimeRuns, eq(agentRuntimeRuns.id, agentRuntimeEvents.runId)).where(eq(agentRuntimeRuns.sessionId, executionId)).orderBy(agentRuntimeRuns.createdAt, agentRuntimeEvents.sequence).all();
    const byRun = new Map<string, NonNullable<AgentRunView['usage']>>();
    for (const row of rows) if (row.data.kind === 'activity' && row.data.usage) byRun.set(row.runId, row.data.usage);
    const usages = [...byRun.values()];
    if (session.runtime === 'codex') return usages.at(-1) ?? null;
    if (!usages.length) return null;
    return usages.reduce((sum, usage) => ({ inputTokens: sum.inputTokens === null || usage.inputTokens === null ? null : sum.inputTokens + usage.inputTokens, outputTokens: sum.outputTokens === null || usage.outputTokens === null ? null : sum.outputTokens + usage.outputTokens, totalTokens: sum.totalTokens === null || usage.totalTokens === null ? null : sum.totalTokens + usage.totalTokens }));
  }

  private execution(row: typeof agentExecutions.$inferSelect, name: string): AgentRunView {
    return { id: row.id, executionId: row.id, agentId: row.agentId, agentName: name, parentRunId: null, task: row.displayMessages.find((message) => message.role === 'user')?.content ?? '', status: row.status, usage: this.runtimeUsage(row.workspaceId, row.id),
      output: row.displayMessages.filter((message) => message.role === 'assistant').map((message) => message.content).join('\n\n'), error: row.error, createdAt: row.createdAt.toISOString(), finishedAt: ['running', 'waiting_for_input'].includes(row.status) ? null : row.updatedAt.toISOString() };
  }
}

function collectArtifactIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) { for (const item of value) collectArtifactIds(item, ids); }
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (key === 'artifactId' && typeof item === 'string' && (value as Record<string, unknown>).type === 'artifact') ids.add(item);
    else if (key === 'artifactIds' && Array.isArray(item) && (value as Record<string, unknown>).type === 'artifact') for (const id of item) { if (typeof id === 'string') ids.add(id); }
    else collectArtifactIds(item, ids);
  }
}
