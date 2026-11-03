import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentTeamGroupRunContext, AgentTeamTaskRequest, AgentTeamTaskResult } from '@worklite/team-runtime';
import { createSqliteCheckpointer } from '@worklite/team-runtime';
import { createAgentTeamGroupGraph, type AgentTeamGroupGraphInitial, type AgentTeamGroupGraphState } from './coder-router-graph';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function groupContext(overrides: Partial<AgentTeamGroupRunContext> = {}): AgentTeamGroupRunContext {
  return {
    groupId: 'atgroup_test',
    initialMessageId: 'atmsg_test',
    initialMessage: '请检查项目现状',
    targetRole: 'router',
    repositories: [],
    memories: [],
    ...overrides,
  };
}

function baseInitial(overrides: Partial<AgentTeamGroupGraphInitial> = {}): AgentTeamGroupGraphInitial {
  return {
    runId: 'atrun_test',
    orchestrationVersion: 12,
    intent: '请检查项目现状',
    projectDirectory: '/tmp/worklite-test-project',
    outputDirectory: '/tmp/worklite-test-output',
    scopeRevision: 1,
    projectInstructions: [],
    groupContext: groupContext(),
    ...overrides,
  };
}

function newCheckpointer() {
  const dir = mkdtempSync(join(tmpdir(), 'worklite-coder-graph-v6-'));
  directories.push(dir);
  return createSqliteCheckpointer(join(dir, 'checkpoints.sqlite'));
}

describe('Router orchestration version 12', () => {
  it('keeps new v12 Runs at Router and persists parallel and dependent role results for Router', async () => {
    const checkpointer = newCheckpointer();
    const threadId = `atthread_${randomUUID()}`;
    const calls: AgentTeamTaskRequest[] = [];
    const workerResolvers: Array<() => void> = [];
    const initial = baseInitial({
      orchestrationVersion: 12,
      groupContext: groupContext({ targetRole: 'router', requestedRole: 'reviewer' }),
    });
    const executeTask = async (request: AgentTeamTaskRequest): Promise<AgentTeamTaskResult> => {
      calls.push(request);
      if (request.taskDefinition.role === 'router') {
        const routerTurns = calls.filter((call) => call.taskDefinition.role === 'router');
        if (routerTurns.length === 1) return {
          status: 'completed', completedWork: true, documents: [], unresolvedIssues: [], commandIds: [], changedFiles: [], criterionAssessments: [],
          routerPlan: { action: 'dispatch', assignments: [
            { id: 'review', role: 'reviewer', goal: 'Review the change', dependencyIds: [] },
            { id: 'tests', role: 'test_runner', goal: 'Run the focused checks', dependencyIds: [] },
            { id: 'plan', role: 'planner', goal: 'Summarize the findings', dependencyIds: ['review'] },
          ] },
        };
        expect(request.groupMessage).toContain('Review finished');
        expect(request.groupMessage).toContain('Checks passed');
        expect(request.groupMessage).toContain('Plan finished');
        return {
          status: 'completed', completedWork: true, documents: [], unresolvedIssues: [], commandIds: [], changedFiles: [], criterionAssessments: [],
          routerPlan: { action: 'finish' }, message: 'All role results considered.',
        };
      }

      if (request.taskDefinition.taskKey.endsWith('_review') || request.taskDefinition.taskKey.endsWith('_tests')) {
        await new Promise<void>((resolve) => {
          workerResolvers.push(resolve);
          if (workerResolvers.length === 2) workerResolvers.splice(0).forEach((complete) => complete());
        });
      }
      if (request.taskDefinition.taskKey.endsWith('_plan')) {
        expect(request.taskContextSummary).toContain('Review finished');
      }
      const message = request.taskDefinition.role === 'reviewer' ? 'Review finished'
        : request.taskDefinition.role === 'test_runner' ? 'Checks passed' : 'Plan finished';
      return { status: 'completed', completedWork: true, documents: [], unresolvedIssues: [], commandIds: [], changedFiles: [], criterionAssessments: [], message };
    };
    const graph = createAgentTeamGroupGraph({ executeTask }, checkpointer, initial);
    const stream = await graph.stream({} as never, { configurable: { thread_id: threadId } });
    for await (const _chunk of stream) { /* drain */ }

    const roles = calls.map((call) => call.taskDefinition.role);
    expect(roles[0]).toBe('router');
    expect(roles.slice(1)).toEqual(['reviewer', 'test_runner', 'planner', 'router']);
    expect(calls[0]?.groupContext?.requestedRole).toBe('reviewer');
    const finalState = await graph.getState({ configurable: { thread_id: threadId } });
    expect(finalState.values.finished).toBe(true);
    expect((finalState.values as AgentTeamGroupGraphState).routerHistory.map((entry) => entry.status)).toEqual(['completed', 'completed', 'completed']);
  });
});
