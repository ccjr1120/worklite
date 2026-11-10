import { getTableColumns } from 'drizzle-orm';
import { agentExecutionColumns, agentCapabilityResults, agentExecutionEvents, agentExecutions, agentRuntimeEvents, agentRuntimeRuns, agentRuntimeSessions, agents, agentToolCalls, artifacts, auditLogs, type Database } from '@worklite/db';
import { agentFiles } from './agent-file-store';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Request } from 'express';
import type { AgentExecutionEventData, AgentRunDetailView, AgentRunListView, AgentRunView } from '@worklite/contracts';

import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { PortkeyGatewayService } from '../model-providers/portkey-gateway.service';
import { appendRuntimeActivity, runtimeCurrentActivity, settleRuntimeActivities } from './agent-runtime-activity';

@Injectable()
export class AgentHistoryService {
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly workspaces: WorkspaceService, private readonly gateway?: PortkeyGatewayService) {}

  async usage(request: Request, runId: string) {
    const { id: workspaceId } = await this.workspaces.getWorkspace(request, 'personal');
    const invocation = this.db.select().from(auditLogs).where(and(eq(auditLogs.id, runId), eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.action, 'agent.invocation'))).get();
    const owner = this.db.select({ agentId: agentExecutions.agentId }).from(agentExecutions).where(and(eq(agentExecutions.id, invocation?.resource ?? runId), eq(agentExecutions.workspaceId, workspaceId))).get();
    if (!owner) throw new NotFoundException('Agent run not found.');
    const detail = await this.detail(request, owner.agentId, runId);
    const usage = ({ id, executionId, agentId, agentName, parentRunId, status, runtime, usage, commandExecutionId }: AgentRunView) => ({ id, executionId, agentId, agentName, parentRunId, status, runtime, usage, commandExecutionId });
    return { run: usage(detail.run), invocations: detail.invocations.map(usage), gatewayUsage: detail.gatewayUsage };
  }

  async list(request: Request, agentId: string, offset = 0): Promise<AgentRunListView> {
    const { id: workspaceId } = await this.workspaces.getWorkspace(request, 'personal');
    const agent = this.agent(workspaceId, agentId);
    // Merge only indexed identifiers in SQLite. Payloads and usage are loaded for one page.
    const candidates = this.db.$client.prepare(`
      SELECT id, created_at, 'record' AS source FROM audit_logs
          WHERE workspace_id = ? AND action = 'agent.invocation' AND json_extract(metadata, '$.agentId') = ?
        UNION ALL
        SELECT id, created_at, 'direct' AS source FROM agent_executions e
          WHERE workspace_id = ? AND agent_id = ? AND NOT EXISTS (
            SELECT 1 FROM audit_logs a WHERE a.workspace_id = e.workspace_id AND a.action = 'agent.invocation'
              AND a.resource = e.id AND json_extract(a.metadata, '$.agentId') = ?)
        UNION ALL
        SELECT id, created_at, 'legacy' AS source FROM agent_tool_calls c
          WHERE workspace_id = ? AND mcp_tool_name = 'run_agent'
            AND json_extract(input, '$.__backgroundExecutionId') IS NULL AND json_extract(input, '$.agentId') = ?
            AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.workspace_id = c.workspace_id
              AND a.action = 'agent.invocation' AND a.resource = c.execution_id AND json_extract(a.metadata, '$.agentId') = ?)
      ORDER BY created_at DESC, id DESC LIMIT 21 OFFSET ?
    `).all(workspaceId, agentId, workspaceId, agentId, agentId, workspaceId, agentId, agentId, Math.max(0, Math.floor(offset))) as Array<{ id: string; source: string }>;
    const items = candidates.slice(0, 20).map(({ id, source }) => {
      if (source === 'record') return { ...this.record(this.db.select().from(auditLogs).where(eq(auditLogs.id, id)).get()!), output: '', activities: undefined };
      if (source === 'legacy') return { ...this.legacy(this.db.select({ ...getTableColumns(agentToolCalls), packageFiles: sql<string>`'[]'`.mapWith(() => []), output: sql<string>`''` }).from(agentToolCalls).where(eq(agentToolCalls.id, id)).get()!, agentId, agent.name), output: '' };
      const row = this.db.select({
        id: agentExecutions.id, agentId: agentExecutions.agentId, workspaceId: agentExecutions.workspaceId,
        status: agentExecutions.status, error: agentExecutions.error, createdAt: agentExecutions.createdAt, updatedAt: agentExecutions.updatedAt,
        task: sql<string>`case when ${agentExecutions.displayMessages} <> '[]' then coalesce((select json_extract(value, '$.content') from json_each(${agentExecutions.displayMessages}) where json_extract(value, '$.role') = 'user' limit 1), '') else coalesce((select json_extract(value, '$.content') from stored_json_items where owner_id = ${agentExecutions.id} and kind = 'display' and json_extract(value, '$.role') = 'user' order by position limit 1), '') end`,
        runtime: sql<AgentRunView['runtime']>`worklite_runtime_kind(${agentExecutions.capabilitySnapshot})`,
      }).from(agentExecutions).where(eq(agentExecutions.id, id)).get()!;
      return { id: row.id, executionId: row.id, agentId: row.agentId, agentName: agent.name, parentRunId: null, runtime: row.runtime, task: row.task, status: row.status, usage: this.runtimeUsage(workspaceId, row.id), output: '', error: row.error, createdAt: row.createdAt.toISOString(), finishedAt: ['running', 'waiting_for_input'].includes(row.status) ? null : row.updatedAt.toISOString() };
    });
    return { items, hasMore: candidates.length > 20 };
  }

  async detail(request: Request, agentId: string, runId: string): Promise<AgentRunDetailView> {
    const { id: workspaceId } = await this.workspaces.getWorkspace(request, 'personal');
    const agent = this.agent(workspaceId, agentId);
    // An execution id resolves to its recorded root, including the child invocation tree.
    const row = this.db.select().from(auditLogs).where(and(
      sql`(${auditLogs.id} = ${runId} or (${auditLogs.resource} = ${runId} and json_extract(${auditLogs.metadata}, '$.parentRunId') is null))`,
      eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.action, 'agent.invocation'),
      sql`(json_extract(${auditLogs.metadata}, '$.agentId') = ${agentId} or exists (select 1 from agent_executions e where e.id = ${auditLogs.resource} and e.workspace_id = ${workspaceId} and e.agent_id = ${agentId}))`,
    )).orderBy(auditLogs.createdAt, auditLogs.id).get();
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
      const execution = this.db.select(agentExecutionColumns).from(agentExecutions).where(and(eq(agentExecutions.id, runId), eq(agentExecutions.workspaceId, workspaceId), eq(agentExecutions.agentId, agentId))).get();
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
      if (item.runtime === 'claude' || item.runtime === 'codex') {
        const activities = item.activities ?? [];
        // Direct engine sessions own runtime events; delegated invocations save their summaries in the audit record.
        if (!row) {
          const events = this.db.select({ data: agentRuntimeEvents.data, runId: agentRuntimeRuns.id, status: agentRuntimeRuns.status, createdAt: agentRuntimeRuns.createdAt }).from(agentRuntimeEvents)
            .innerJoin(agentRuntimeRuns, eq(agentRuntimeEvents.runId, agentRuntimeRuns.id))
            .innerJoin(agentRuntimeSessions, eq(agentRuntimeRuns.sessionId, agentRuntimeSessions.id))
            .where(and(eq(agentRuntimeSessions.id, item.executionId), eq(agentRuntimeSessions.workspaceId, workspaceId)))
            .orderBy(agentRuntimeRuns.createdAt, sql`${agentRuntimeRuns}.rowid`, agentRuntimeEvents.sequence).all();
          const turns = new Map<string, typeof events>();
          for (const event of events) {
            const turn = turns.get(event.runId) ?? [];
            turn.push(event);
            turns.set(event.runId, turn);
          }
          for (const [runId, turn] of turns) {
            const entries: NonNullable<AgentRunView['activities']> = [];
            for (const event of turn) if (event.data.kind === 'activity') appendRuntimeActivity(entries, event.data, runId);
            const stream = turn.find((event) => event.data.kind === 'message_stream')?.data;
            if (stream?.kind === 'message_stream' && turn[0].status !== 'completed') {
              // Decode through the column mapper: larger chunks may be packed JSON.
              const deltas = this.db.select({ data: agentExecutionEvents.data }).from(agentExecutionEvents)
                .where(and(eq(agentExecutionEvents.executionId, item.executionId), eq(agentExecutionEvents.kind, 'message_delta'), gte(agentExecutionEvents.createdAt, turn[0].createdAt)))
                .orderBy(agentExecutionEvents.sequence).all();
              let text = deltas.map(({ data }) => {
                const event = data as AgentExecutionEventData;
                return event.kind === 'message_delta' && event.messageId === stream.messageId ? event.delta : '';
              }).join('');
              for (const entry of entries) if (entry.kind === 'message' && text.startsWith(entry.text)) text = text.slice(entry.text.length);
              if (text.trim()) entries.push({ id: `${runId}:stream`, kind: 'message', text });
            }
            activities.push(...(['running', 'waiting_for_input'].includes(turn[0].status) ? entries : settleRuntimeActivities(entries)));
          }
        }
        const active = ['running', 'waiting_for_input'].includes(item.status);
        return { ...item, activities: active ? activities : settleRuntimeActivities(activities), currentActivity: active ? runtimeCurrentActivity(activities) : null };
      }
      if (item.status !== 'running' || item.currentActivity) return item;
      const active = calls.filter((call) => call.status === 'running' && (!row || (call.input as { __agentRunId?: string } | null)?.__agentRunId === item.id));
      return { ...item, currentActivity: active.length ? { phase: 'tool', toolName: active.map((call) => call.toolName ?? 'tool').join(', ') } : { phase: 'model' } };
    };
    const gatewayUsage = await this.gatewayUsage(run, invocations);
    const invocationViews = invocations.map(withActivity);
    return { run: invocationViews.find((item) => item.id === run.id) ?? withActivity(run), invocations: invocationViews, artifacts: outputs, gatewayUsage };
  }

  private async gatewayUsage(run: AgentRunView, invocations: AgentRunView[]): Promise<NonNullable<AgentRunDetailView['gatewayUsage']>> {
    try {
      if (!this.gateway) return { status: 'unavailable', summary: null, groups: [] };
      const stats = await this.gateway.stats({ from: run.createdAt, to: new Date().toISOString(), agentExecutionId: run.executionId, groupBy: 'agent_run' }, { startGateway: false, timeoutMs: 3000 });
      const ids = new Set(invocations.map((item) => item.id));
      const groups = stats.attribution.groups.filter((group) => group.agentRunId && ids.has(group.agentRunId));
      // Build the selected subtree's totals from SQL groups. Sibling requests must
      // not leak into a child detail, and an empty historical result is not zero usage.
      if (!groups.length) return { status: 'available', summary: null, groups };
      const total = (key: 'promptTokens' | 'completionTokens' | 'cacheReadTokens' | 'cacheCreationTokens' | 'totalTokens') => {
        const values = groups.map((group) => group[key]).filter((value): value is number => value !== null);
        return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
      };
      const requests = groups.reduce((sum, group) => sum + group.requests, 0);
      const successful = groups.reduce((sum, group) => sum + group.successful, 0);
      return { status: 'available', groups, summary: {
        requests, successful, failed: requests - successful, successRate: requests ? Math.round(successful / requests * 1000) / 10 : null,
        averageLatencyMs: requests ? Math.round(groups.reduce((sum, group) => sum + (group.averageLatencyMs ?? 0) * group.requests, 0) / requests) : null,
        promptTokens: total('promptTokens'), completionTokens: total('completionTokens'), cacheReadTokens: total('cacheReadTokens'), cacheCreationTokens: total('cacheCreationTokens'), totalTokens: total('totalTokens'),
        usageRequests: groups.reduce((sum, group) => sum + group.usageRequests, 0),
      } };
    } catch {
      // History and saved runtime usage remain readable during Gateway upgrades/outages.
      return { status: 'unavailable', summary: null, groups: [] };
    }
  }

  private agent(workspaceId: string, agentId: string) {
    const catalog = agentFiles(this.db);
    catalog?.refresh(workspaceId);
    if (catalog && catalog.get(agentId)?.parentId !== null) throw new NotFoundException('Agent not found.');
    const children = new Set(this.db.select().from(agents).where(eq(agents.workspaceId, workspaceId)).all().flatMap((row) => row.collaboration?.subAgentIds ?? []));
    if (!catalog && children.has(agentId)) throw new NotFoundException('Sub-Agent history belongs to its owning Agent.');
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
    // Durable per-turn summaries survive event expiry. Only a few small rows are read.
    const rows = this.db.select({ usage: agentRuntimeRuns.usage }).from(agentRuntimeRuns).where(eq(agentRuntimeRuns.sessionId, executionId)).orderBy(agentRuntimeRuns.createdAt, sql`${agentRuntimeRuns}.rowid`).all();
    const byRun = new Map<number, NonNullable<AgentRunView['usage']>>();
    rows.forEach((row, index) => { if (row.usage) byRun.set(index, row.usage); });
    const usages = [...byRun.values()];
    if (session.runtime === 'codex') return usages.at(-1) ?? null;
    if (!usages.length) return null;
    return usages.reduce((sum, usage) => ({ inputTokens: sum.inputTokens === null || usage.inputTokens === null ? null : sum.inputTokens + usage.inputTokens, outputTokens: sum.outputTokens === null || usage.outputTokens === null ? null : sum.outputTokens + usage.outputTokens, totalTokens: sum.totalTokens === null || usage.totalTokens === null ? null : sum.totalTokens + usage.totalTokens,
      cacheReadTokens: sum.cacheReadTokens == null || usage.cacheReadTokens == null ? null : sum.cacheReadTokens + usage.cacheReadTokens,
      cacheCreationTokens: sum.cacheCreationTokens == null || usage.cacheCreationTokens == null ? null : sum.cacheCreationTokens + usage.cacheCreationTokens }));
  }

  private execution(row: typeof agentExecutions.$inferSelect, name: string): AgentRunView {
    const runtime = row.capabilitySnapshot?.agent.runtime?.kind ?? this.db.select({ runtime: agentRuntimeSessions.runtime }).from(agentRuntimeSessions).where(and(eq(agentRuntimeSessions.id, row.id), eq(agentRuntimeSessions.workspaceId, row.workspaceId))).get()?.runtime;
    return { id: row.id, executionId: row.id, agentId: row.agentId, agentName: name, parentRunId: null, runtime, task: row.displayMessages.find((message) => message.role === 'user')?.content ?? '', status: row.status, usage: this.runtimeUsage(row.workspaceId, row.id),
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
