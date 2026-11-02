import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentTeamMode, AgentTeamTaskRequest, AgentTeamTaskResult } from '@worklite/team-runtime';
import { createSqliteCheckpointer } from '@worklite/team-runtime';
import { createAgentTeamGroupGraph, type AgentTeamGroupGraphInitial } from './coder-graph-v6';
import { CODER_DISPATCHER_ROLE, initialAgentTeamModeForRole } from './coder-configuration';

// Orchestration v10 starts at the Coder Dispatcher, which decides the Run mode.
// The graph enforces that decision regardless of the handoffs roles attempt.

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type RoleReply = Partial<Extract<AgentTeamTaskResult, { status: 'completed' }>>;

function completed(reply: RoleReply = {}): AgentTeamTaskResult {
  return {
    status: 'completed',
    documents: [],
    unresolvedIssues: [],
    commandIds: [],
    changedFiles: [],
    completedAssignedWork: true,
    criterionAssessments: [],
    ...reply,
  };
}

function initial(targetRole: string, mode: AgentTeamMode, orchestrationVersion: 9 | 10): AgentTeamGroupGraphInitial {
  return {
    runId: 'atrun_v10_test',
    intent: '请处理这个需求',
    mode,
    projectDirectory: '/tmp/worklite-test-project',
    outputDirectory: '/tmp/worklite-test-output',
    scopeRevision: 1,
    projectInstructions: [],
    groupContext: {
      groupId: 'atgroup_v10_test',
      initialMessageId: 'atmsg_v10_test',
      initialMessage: '请处理这个需求',
      targetRole,
      mode,
      repositories: [],
      memories: [],
    },
    orchestrationVersion,
  };
}

async function run(start: AgentTeamGroupGraphInitial, replies: Record<string, RoleReply>) {
  const dir = mkdtempSync(join(tmpdir(), 'worklite-agent-team-graph-v10-'));
  directories.push(dir);
  const calls: AgentTeamTaskRequest[] = [];
  const graph = createAgentTeamGroupGraph({
    executeTask: async (request) => {
      calls.push(request);
      return completed(replies[request.taskDefinition.role]);
    },
  }, createSqliteCheckpointer(join(dir, 'checkpoints.sqlite')), start);
  const config = { configurable: { thread_id: `atthread_${randomUUID()}` } };
  for await (const _chunk of await graph.stream({} as never, config)) {
    // drain
  }
  const state = await graph.getState(config);
  return { roles: calls.map((call) => call.taskDefinition.role), modes: calls.map((call) => call.mode), state: state.values };
}

describe('Planner development assignments without a handoff', () => {
  function plannerStart(): AgentTeamGroupGraphInitial {
    return { ...initial('planner', 'implement_and_validate', 10), implementationRoleId: 'implementer' };
  }

  it('runs the implementation role when the Planner assigns work but omits the handoff', async () => {
    const { roles, state } = await run(plannerStart(), {
      planner: { message: 'Plan ready.', developmentAssignments: [{ title: 'Render PNGs', scopeSummary: 'Render the mascot PNGs.', ownedPaths: ['render.mjs'] }] },
    });
    expect(roles).toEqual(['planner', 'implementer']);
    expect((state as { finished?: boolean }).finished).toBe(true);
  });

  it('still finishes after a Planner that answers directly with no assignments', async () => {
    const { roles } = await run(plannerStart(), { planner: { message: 'Read-only answer.' } });
    expect(roles).toEqual(['planner']);
  });
});

describe('orchestration v10 Dispatcher routing', () => {
  it('ends a plan_only Run after the Planner even when the Planner hands off to Developer', async () => {
    const result = await run(initial(CODER_DISPATCHER_ROLE, 'plan_only', 10), {
      dispatcher: { dispatchDecision: { mode: 'plan_only', rationale: 'The user only asked for a plan.' }, handoff: { role: 'developer', goal: 'ignored' } },
      planner: { handoff: { role: 'developer', goal: 'implement' } },
    });
    expect(result.roles).toEqual(['dispatcher', 'planner']);
    expect(result.state.mode).toBe('plan_only');
    expect(result.state.finished).toBe(true);
  });

  it('routes validate_existing to Test Designer and refuses an implementation handoff', async () => {
    const result = await run(initial(CODER_DISPATCHER_ROLE, 'plan_only', 10), {
      dispatcher: { dispatchDecision: { mode: 'validate_existing', rationale: 'The user asked to assess current behavior.' } },
      test_designer: { handoff: { role: 'test_runner', goal: 'run checks' } },
      test_runner: { handoff: { role: 'developer', goal: 'fix it' } },
    });
    expect(result.roles).toEqual(['dispatcher', 'test_designer', 'test_runner']);
    expect(result.modes.slice(1)).toEqual(['validate_existing', 'validate_existing']);
    expect(result.state.finished).toBe(true);
  });

  it('routes implement_and_validate to Planner and allows the implementation chain', async () => {
    const result = await run(initial(CODER_DISPATCHER_ROLE, 'plan_only', 10), {
      dispatcher: { dispatchDecision: { mode: 'implement_and_validate', rationale: 'The request clearly needs a code change.' } },
      planner: { handoff: { role: 'developer', goal: 'implement' } },
      developer: { handoff: { role: 'reviewer', goal: 'review' } },
    });
    expect(result.roles).toEqual(['dispatcher', 'planner', 'developer', 'reviewer']);
    expect(result.modes.slice(1)).toEqual(['implement_and_validate', 'implement_and_validate', 'implement_and_validate']);
  });

  it('never lets a role hand work back to the Dispatcher', async () => {
    const result = await run(initial(CODER_DISPATCHER_ROLE, 'plan_only', 10), {
      dispatcher: { dispatchDecision: { mode: 'implement_and_validate', rationale: 'Needs a change.' } },
      planner: { handoff: { role: CODER_DISPATCHER_ROLE, goal: 'decide again' } },
    });
    expect(result.roles).toEqual(['dispatcher', 'planner']);
  });

  it('fails the Run when the Dispatcher completes without a decision', async () => {
    await expect(run(initial(CODER_DISPATCHER_ROLE, 'plan_only', 10), { dispatcher: { handoff: { role: 'planner', goal: 'plan' } } }))
      .rejects.toThrow('dispatchDecision');
  });

  it('keeps v9 routing unchanged: a plan_only v9 Planner still follows its handoff', async () => {
    const result = await run(initial('planner', 'plan_only', 9), {
      planner: { handoff: { role: 'developer', goal: 'implement' } },
    });
    expect(result.roles).toEqual(['planner', 'developer']);
  });
});

describe('initialAgentTeamModeForRole', () => {
  it('holds a placeholder for the Dispatcher and keeps named roles on their path', () => {
    expect(initialAgentTeamModeForRole(CODER_DISPATCHER_ROLE)).toBe('plan_only');
    expect(initialAgentTeamModeForRole('reviewer')).toBe('validate_existing');
    expect(initialAgentTeamModeForRole('test_designer')).toBe('validate_existing');
    expect(initialAgentTeamModeForRole('planner')).toBe('implement_and_validate');
    expect(initialAgentTeamModeForRole('developer')).toBe('implement_and_validate');
  });
});
