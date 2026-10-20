import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentTeamGroupRunContext, AgentTeamTaskRequest, AgentTeamTaskResult } from '@worklite/team-runtime';
import { Command, createSqliteCheckpointer } from '@worklite/team-runtime';
import { createAgentTeamGroupGraph, type AgentTeamGroupGraphInitial } from './agent-team-graph-v6';

// Regression test for the orchestration-v8 "Received no input writes for __start__" defect:
// a brand-new group Run (no prior checkpoint) was always started with a `null` graph input
// because resumeInput() treated every group-orchestration Run (v6/v7/v8) as resuming from an
// existing checkpoint. LangGraph only replays a null/undefined input when its checkpoint
// already has channel versions (i.e. the thread has executed at least one step); on a fresh
// thread this produced an EmptyInputError instead of invoking the "start" node, and the Run
// failed silently in ~40ms with zero task attempts and no readable reason.

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function groupContext(overrides: Partial<AgentTeamGroupRunContext> = {}): AgentTeamGroupRunContext {
  return {
    groupId: 'atgroup_test',
    initialMessageId: 'atmsg_test',
    initialMessage: '请检查项目现状',
    targetRole: 'planner',
    mode: 'validate_existing',
    repositories: [],
    memories: [],
    ...overrides,
  };
}

function baseInitial(overrides: Partial<AgentTeamGroupGraphInitial> = {}): AgentTeamGroupGraphInitial {
  return {
    runId: 'atrun_test',
    intent: '请检查项目现状',
    mode: 'validate_existing',
    projectDirectory: '/tmp/worklite-test-project',
    outputDirectory: '/tmp/worklite-test-output',
    scopeRevision: 1,
    authorizedCommands: [],
    projectInstructions: [],
    groupContext: groupContext(),
    ...overrides,
  };
}

function newCheckpointer() {
  const dir = mkdtempSync(join(tmpdir(), 'worklite-agent-team-graph-v6-'));
  directories.push(dir);
  return createSqliteCheckpointer(join(dir, 'checkpoints.sqlite'));
}

describe('createAgentTeamGroupGraph first dispatch (v8 no-history scenario)', () => {
  it('reproduces EmptyInputError when a fresh thread streams a null input (the historical bug)', async () => {
    const checkpointer = newCheckpointer();
    const threadId = `atthread_${randomUUID()}`;
    const executeTask = async (): Promise<AgentTeamTaskResult> => ({
      status: 'completed',
      documents: [],
      unresolvedIssues: [],
      commandIds: [],
      changedFiles: [],
      completedAssignedWork: true,
      criterionAssessments: [],
    });
    const graph = createAgentTeamGroupGraph({ executeTask }, checkpointer, baseInitial());

    // A brand-new thread has no checkpoint at all, so no channel versions exist yet;
    // LangGraph's isResuming check is therefore false and a null input never reaches
    // the "__start__" channel. This is exactly the pre-fix behavior of resumeInput().
    await expect((async () => {
      const stream = await graph.stream(null, { configurable: { thread_id: threadId } });
      for await (const _chunk of stream) {
        // Draining the stream is what surfaces the EmptyInputError from the engine.
      }
    })()).rejects.toMatchObject({ name: 'EmptyInputError', message: expect.stringContaining('__start__') });
  });

  it('starts the Planner role when a fresh thread streams a non-null placeholder input (the fix)', async () => {
    const checkpointer = newCheckpointer();
    const threadId = `atthread_${randomUUID()}`;
    const calls: AgentTeamTaskRequest[] = [];
    const executeTask = async (request: AgentTeamTaskRequest): Promise<AgentTeamTaskResult> => {
      calls.push(request);
      return {
        status: 'completed',
        documents: [],
        unresolvedIssues: [],
        commandIds: [],
        changedFiles: [],
        completedAssignedWork: true,
        criterionAssessments: [],
        message: 'done',
      };
    };
    const initial = baseInitial();
    const graph = createAgentTeamGroupGraph({ executeTask }, checkpointer, initial);

    // This mirrors the fixed resumeInput(): a fresh thread (no usable checkpoint state)
    // gets a non-null placeholder instead of null, which lets LangGraph schedule the
    // "__start__" -> "start" task for step 0. The "start" node ignores its input and
    // seeds the real state from the `initial` closure captured above.
    const stream = await graph.stream({} as never, { configurable: { thread_id: threadId } });
    for await (const _chunk of stream) {
      // drain
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.taskDefinition.role).toBe('planner');
    expect(calls[0]?.intent).toBe(initial.intent);
    expect(calls[0]?.groupMessage).toBe(initial.groupContext.initialMessage);

    const state = await graph.getState({ configurable: { thread_id: threadId } });
    expect(state.values.finished).toBe(true);
  });

  it('still resumes an in-progress checkpoint with a null input (no regression for later steps)', async () => {
    const checkpointer = newCheckpointer();
    const threadId = `atthread_${randomUUID()}`;
    let callCount = 0;
    const executeTask = async (): Promise<AgentTeamTaskResult> => {
      callCount += 1;
      if (callCount === 1) {
        return { status: 'waiting_for_input', pendingInput: { id: 'atpending_1', question: '需要确认哪个目录？', scopeRevision: 1 } };
      }
      return {
        status: 'completed',
        documents: [],
        unresolvedIssues: [],
        commandIds: [],
        changedFiles: [],
        completedAssignedWork: true,
        criterionAssessments: [],
      };
    };
    const initial = baseInitial();
    const graph = createAgentTeamGroupGraph({ executeTask }, checkpointer, initial);

    // First dispatch (fixed behavior): non-null placeholder starts the graph, which then
    // raises a pending input and pauses (LangGraph interrupt).
    const firstStream = await graph.stream({} as never, { configurable: { thread_id: threadId } });
    for await (const _chunk of firstStream) {
      // drain
    }
    const pausedState = await graph.getState({ configurable: { thread_id: threadId } });
    expect(pausedState.values.pendingInput?.id).toBe('atpending_1');

    // Resuming that same thread after an answer is recorded uses a Command, matching the
    // runtime's answer path; this is unaffected by the fix and still works.
    const resumeStream = await graph.stream(new Command({ resume: { answer: 'ok', authorizedCommands: [] } }), {
      configurable: { thread_id: threadId },
    });
    for await (const _chunk of resumeStream) {
      // drain
    }
    const finalState = await graph.getState({ configurable: { thread_id: threadId } });
    expect(finalState.values.finished).toBe(true);
    expect(callCount).toBe(2);
  });
});
