import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentCapabilityResults, agentExecutions, agentRuntimeEvents, agentRuntimeRuns, agentRuntimeSessions, agents, agentToolCalls, artifacts, auditLogs, createDb, initializeDatabase, type Database } from '@worklite/db';
import type { AgentRunView } from '@worklite/contracts';
import type { Request } from 'express';
import type { WorkspaceService } from '../teams/teams.service';
import { AgentHistoryService } from './agent-history.service';
import type { PortkeyGatewayService } from '../model-providers/portkey-gateway.service';

let db: Database;
let service: AgentHistoryService;
const request = {} as Request;
const workspaceId = 'workspace_personal';
function record(id: string, agentId: string, parentRunId: string | null = null, executionId = 'execution') {
  const run: AgentRunView = { id, executionId, agentId, agentName: agentId, parentRunId, task: `Task ${id}`, status: 'completed', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, output: `Output ${id}`, error: null, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
  db.insert(auditLogs).values({ id, workspaceId, action: 'agent.invocation', resource: executionId, metadata: { ...run } }).run();
}
beforeEach(async () => {
  db = createDb(':memory:'); await initializeDatabase(db);
  for (const id of ['lead', 'child', 'sibling']) db.insert(agents).values({ id, workspaceId, name: id, kind: 'custom', responsibility: '', systemPrompt: '', model: '' }).run();
  db.insert(agentExecutions).values({ id: 'execution', workspaceId, agentId: 'lead', status: 'completed', displayMessages: [{ id: 'message', role: 'user', content: 'Original task', createdAt: new Date().toISOString() }] }).run();
  service = new AgentHistoryService(db, { getWorkspace: async () => ({ id: workspaceId }) } as unknown as WorkspaceService);
});
afterEach(() => db.$client.close());

describe('Agent history', () => {
  it('shows the latest Codex thread snapshot across resumed turns without Gateway traffic or double counting', async () => {
    db.insert(agentRuntimeSessions).values({ id: 'execution', workspaceId, runtime: 'codex', launch: { executor: 'codex', commandArguments: ['codex'], model: null }, resourceDirectory: '/tmp/session' }).run();
    const createdAt = new Date('2026-11-05T00:00:00Z');
    // Same timestamp and fewer events in the second turn reproduce the ordering boundary.
    for (const id of ['first-turn', 'second-turn', 'failed-without-usage']) db.insert(agentRuntimeRuns).values({ id, sessionId: 'execution', status: id.startsWith('failed') ? 'failed' : 'completed', createdAt }).run();
    const usage = (inputTokens: number, outputTokens: number, cacheReadTokens: number) => ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens, cacheCreationTokens: null });
    for (const [id, runId, sequence, value] of [
      ['first-usage', 'first-turn', 8, usage(100, 20, 80)],
      ['second-usage', 'second-turn', 1, usage(150, 30, 120)],
      ['duplicate', 'second-turn', 2, usage(150, 30, 120)],
    ] as const) db.insert(agentRuntimeEvents).values({ id, runId, sequence, data: { kind: 'activity', phase: 'codex.usage', usage: value } }).run();
    db.update(agentExecutions).set({ status: 'failed' }).where(eq(agentExecutions.id, 'execution')).run();
    const detail = await service.detail(request, 'lead', 'execution');
    expect(detail.run.usage).toEqual(usage(150, 30, 120));
    expect(detail.gatewayUsage?.status).toBe('unavailable');
    expect((await service.usage(request, 'execution')).invocations[0].usage?.totalTokens).toBe(180);
    expect((await service.list(request, 'lead')).items[0].usage?.totalTokens).toBe(180);
  });

  it('resolves an execution id to its recorded invocation tree and excludes sibling Gateway usage from a child', async () => {
    record('root', 'lead'); record('child-run', 'child', 'root'); record('sibling-run', 'sibling', 'root');
    const group = (agentRunId: string, totalTokens: number) => ({ key: agentRunId, agentRunId, agentExecutionId: 'execution', executor: agentRunId === 'root' ? null : 'codex', surface: 'agent', requests: 1, successful: 1, failed: 0, averageLatencyMs: 10, promptTokens: totalTokens, completionTokens: 0, cacheReadTokens: null, cacheCreationTokens: null, totalTokens, usageRequests: 1 });
    const stats = vi.fn(async () => ({ attribution: { groups: [group('root', 100), group('child-run', 200), group('sibling-run', 300)] } }));
    service = new AgentHistoryService(db, { getWorkspace: async () => ({ id: workspaceId }) } as unknown as WorkspaceService, { stats } as unknown as PortkeyGatewayService);
    const root = await service.detail(request, 'lead', 'execution');
    expect(root.run.id).toBe('root');
    expect(root.invocations).toHaveLength(3);
    expect(root.gatewayUsage?.summary?.totalTokens).toBe(600);
    expect(stats).toHaveBeenCalledWith(expect.objectContaining({ agentExecutionId: 'execution', groupBy: 'agent_run' }), { startGateway: false, timeoutMs: 3000 });
    const child = await service.detail(request, 'child', 'child-run');
    expect(child.gatewayUsage?.groups.map((item) => item.agentRunId)).toEqual(['child-run']);
    expect(child.gatewayUsage?.summary).toMatchObject({ totalTokens: 200, cacheReadTokens: null, cacheCreationTokens: null });
    expect(child.run.usage?.totalTokens).toBe(120);
  });

  it('keeps historical empty Gateway usage unknown and saved runtime usage readable during an outage', async () => {
    record('root', 'lead');
    const stats = vi.fn().mockResolvedValueOnce({ attribution: { groups: [] } }).mockRejectedValueOnce(new Error('unavailable'));
    service = new AgentHistoryService(db, { getWorkspace: async () => ({ id: workspaceId }) } as unknown as WorkspaceService, { stats } as unknown as PortkeyGatewayService);
    expect((await service.detail(request, 'lead', 'root')).gatewayUsage).toEqual({ status: 'available', summary: null, groups: [] });
    const detail = await service.detail(request, 'lead', 'root');
    expect(detail.gatewayUsage).toEqual({ status: 'unavailable', summary: null, groups: [] });
    expect(detail.run.usage?.totalTokens).toBe(120);
  });

  it('resolves usage using only a run id, including a private child, without returning task output', async () => {
    record('root', 'lead'); record('child-run', 'child', 'root'); record('sibling-run', 'sibling', 'root');
    expect((await service.usage(request, 'execution')).invocations).toHaveLength(3);
    const child = await service.usage(request, 'child-run');
    expect(child.invocations.map((run) => run.id)).toEqual(['child-run']);
    expect(child.run.usage?.totalTokens).toBe(120);
    expect(child.run).not.toHaveProperty('output');
    await expect(service.usage(request, 'missing')).rejects.toThrow('Agent run not found');
    const otherWorkspace = new AgentHistoryService(db, { getWorkspace: async () => ({ id: 'other' }) } as unknown as WorkspaceService);
    await expect(otherWorkspace.usage(request, 'root')).rejects.toThrow('Agent run not found');
  });

  it('does not duplicate a background launch as a legacy Chat invocation', async () => {
    db.insert(agentExecutions).values({ id: 'chat', workspaceId, agentId: 'agt_system_helper_chat', status: 'completed' }).run();
    db.insert(agentToolCalls).values({ id: 'launch', executionId: 'chat', workspaceId, agentId: 'agt_system_helper_chat', toolCallId: 'launch', toolName: 'builtin', mcpToolName: 'run_agent', workingDirectory: '', input: { agentId: 'lead', __backgroundExecutionId: 'execution' }, status: 'completed' }).run();
    record('background-root', 'lead');
    expect((await service.list(request, 'lead')).items.map((item) => item.id)).toEqual(['background-root']);
  });

  it('lists recorded calls without duplicating their owning execution and includes older direct runs', async () => {
    record('root', 'lead');
    record('child-call', 'child', 'root');
    expect((await service.list(request, 'lead')).items.map((run) => run.id)).toEqual(['root']);
    expect((await service.list(request, 'child')).items[0]).toMatchObject({ id: 'child-call', output: '', usage: { totalTokens: 120 } });
    db.insert(agentExecutions).values({ id: 'older', workspaceId, agentId: 'lead', status: 'completed' }).run();
    expect((await service.detail(request, 'lead', 'older')).run.usage).toBeNull();
    expect((await service.list(request, 'lead')).items).toHaveLength(2);
  });

  it('retains repeated child calls and scopes child detail and artifacts to its own subtree', async () => {
    record('root', 'lead'); record('child-1', 'child', 'root'); record('child-2', 'child', 'root'); record('sibling', 'sibling', 'root');
    for (const id of ['child-1', 'sibling']) {
      db.insert(artifacts).values({ id: `artifact-${id}`, workspaceId, name: id, format: 'text', content: id }).run();
      db.insert(agentCapabilityResults).values({ id: `result-${id}`, executionId: 'execution', value: { output: { type: 'artifact', artifactId: `artifact-${id}` } } }).run();
      db.insert(agentToolCalls).values({ id: `call-${id}`, executionId: 'execution', workspaceId, agentId: 'lead', toolCallId: id, toolName: 'builtin', workingDirectory: '', input: { __agentRunId: id }, output: JSON.stringify({ resultRef: `result-${id}` }) }).run();
    }
    expect((await service.detail(request, 'lead', 'root')).invocations).toHaveLength(4);
    const child = await service.detail(request, 'child', 'child-1');
    expect(child.invocations.map((run) => run.id)).toEqual(['child-1']);
    expect(child.artifacts).toEqual([{ id: 'artifact-child-1', name: 'child-1' }]);
    await expect(service.detail(request, 'child', 'root')).rejects.toThrow('Agent run not found');
  });

  it('reports an active tool for older direct executions and clears activity after cancellation', async () => {
    db.update(agentExecutions).set({ status: 'running' }).where(eq(agentExecutions.id, 'execution')).run();
    db.insert(agentToolCalls).values({ id: 'active-tool', executionId: 'execution', workspaceId, agentId: 'lead', toolCallId: 'active-tool', toolName: 'builtin', mcpToolName: 'bash', workingDirectory: '', status: 'running' }).run();
    expect((await service.detail(request, 'lead', 'execution')).run.currentActivity).toEqual({ phase: 'tool', toolName: 'bash' });
    db.update(agentExecutions).set({ status: 'cancelled' }).where(eq(agentExecutions.id, 'execution')).run();
    const detail = await service.detail(request, 'lead', 'execution');
    expect(detail.run.status).toBe('cancelled');
    expect(detail.run.currentActivity).toBeFalsy();
  });

  it('shows historical Chat delegations with unknown usage and paginates the directory', async () => {
    db.insert(agentToolCalls).values({ id: 'legacy', executionId: 'execution', workspaceId, agentId: 'lead', toolCallId: 'legacy', toolName: 'builtin', mcpToolName: 'run_agent', workingDirectory: '', input: { agentId: 'child', task: 'Old task' }, output: 'Old result', status: 'completed' }).run();
    expect((await service.detail(request, 'child', 'legacy')).run).toMatchObject({ task: 'Old task', output: 'Old result', usage: null });
    db.insert(agentExecutions).values({ id: 'new-execution', workspaceId, agentId: 'lead', status: 'completed' }).run();
    for (let i = 0; i < 22; i++) record(`run-${i}`, 'child', null, 'new-execution');
    const first = await service.list(request, 'child');
    const next = await service.list(request, 'child', 20);
    expect(first.items).toHaveLength(20); expect(first.hasMore).toBe(true);
    expect(next.items).toHaveLength(3); expect(next.hasMore).toBe(false);
    expect(new Set([...first.items, ...next.items].map((run) => run.id)).size).toBe(23);
  });
});
