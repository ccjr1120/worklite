import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Request } from 'express';
import { createDb, initializeDatabase, coderRuns, coderVersions, coderTaskAttempts, coderRunEvents, coderGroupMessages, coders, chatSubmissions, type Database } from '@worklite/db';
import { AgentTeamGroupsService } from './coder-groups.service';
import { CodersService } from './coders.service';
import type { AgentTeamConfigurationService } from './coder-configuration.service';
import type { AgentTeamRuntimeService } from './coder-runtime.service';
import type { WorkspaceService } from '../teams/teams.service';

// Chat dispatch always enters the Router; a user-named role stays as routing context.

let db: Database | undefined;
const directories: string[] = [];

afterEach(() => {
  db?.$client.close();
  db = undefined;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function role(id: string) {
  return { role: id, publicModelId: '', instructions: `${id} instructions`, entryPoints: [], skills: [], mcpServers: [], toolNames: [] };
}

async function setup() {
  db = createDb(':memory:');
  await initializeDatabase(db);
  const now = new Date();
  await db.insert(coders).values({
    id: 'agent_team_test',
    workspaceId: 'workspace_personal',
    name: 'Test Coder',
    description: 'test',
    processId: 'bmad-tea',
    processVersion: '1',
    roles: [role('router'), role('planner'), role('reviewer')],
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(coderVersions).values({ id: 'atver_mock', workspaceId: 'workspace_personal', coderId: 'agent_team_test', version: 99, snapshot: { processId: 'bmad-tea', processVersion: '1', coderName: 'Test Coder', projectExecutorLaunches: {}, orchestrationVersion: 12, roles: [] } as never, createdAt: now });
  const created: Array<Parameters<AgentTeamRuntimeService['createGroupRun']>[1]> = [];
  const stoppedTasks: Array<{ runId: string; taskAttemptId: string }> = [];
  const runtime = {
    assertRouterRun: async () => undefined,
    readGroupProjectInstructions: async () => [],
    createGroupRun: async (_workspaceId: string, request: Parameters<AgentTeamRuntimeService['createGroupRun']>[1], acceptance: Parameters<AgentTeamRuntimeService['createGroupRun']>[2]) => {
      created.push(request);
      // Like the real runtime, the Run row commits together with its acceptance.
      const at = new Date();
      db!.transaction((transaction) => {
        transaction.insert(coderRuns).values({ id: acceptance.runId, workspaceId: 'workspace_personal', coderId: request.coderId, coderVersionId: 'atver_mock', intent: request.intent, projectDirectory: '', langGraphThreadId: `atthread_${acceptance.runId}`, groupId: request.groupId, groupMessageId: request.groupMessageId, targetRole: request.targetRole, repositoryIds: request.repositoryIds, groupContext: request.groupContext, createdAt: at, updatedAt: at }).run();
        acceptance.accept(transaction, acceptance.runId);
      });
    },
    stopTaskAttempt: async (runId: string, taskAttemptId: string) => {
      stoppedTasks.push({ runId, taskAttemptId });
      await db!.update(coderTaskAttempts).set({ status: 'stopped', finishedAt: new Date() })
        .where(and(eq(coderTaskAttempts.id, taskAttemptId), eq(coderTaskAttempts.runId, runId)));
    },
  } as unknown as AgentTeamRuntimeService;
  const workspaces = { getWorkspace: async () => ({ id: 'workspace_personal' }) } as unknown as WorkspaceService;
  const project = mkdtempSync(join(tmpdir(), 'worklite-team-dispatch-'));
  directories.push(project);
  return { service: new AgentTeamGroupsService(db, workspaces, runtime), created, stoppedTasks, project };
}

const request = {} as Request;

describe('AgentTeamGroupsService.dispatchFromChat', () => {
  it('dispatches without a mode and addresses the Router by default', async () => {
    const { service, created, project } = await setup();
    await service.dispatchFromChat(request, 'personal', 'agent_team_test', {
      message: '帮我看看这个项目', projectDirectory: project, submissionId: 'sub_default', runId: 'atrun_default',
    }, { runId: 'atrun_default', accept: () => undefined });

    expect(created).toHaveLength(1);
    expect(created[0]!.targetRole).toBe('router');
    expect(created[0]).not.toHaveProperty('mode');
  });

  it('keeps a user-named initial role', async () => {
    const { service, created, project } = await setup();
    await service.dispatchFromChat(request, 'personal', 'agent_team_test', {
      message: '请评审', projectDirectory: project, role: 'reviewer', submissionId: 'sub_named', runId: 'atrun_named',
    }, { runId: 'atrun_named', accept: () => undefined });

    expect(created[0]!.targetRole).toBe('router');
    expect(created[0]!.groupContext.requestedRole).toBe('reviewer');
  });
});

describe('AgentTeamGroupsService.control', () => {
  async function dispatchedRun() {
    const context = await setup();
    const groupId = `atgroup_chat_${createHash('sha256').update('workspace_personal:sub_team').digest('hex')}`;
    await db!.insert(chatSubmissions).values({ id: 'sub_team', workspaceId: 'workspace_personal', executionId: 'aex_chat', message: '修复重考状态', target: { kind: 'coder', coderId: 'agent_team_test', projectDirectory: context.project } });
    await context.service.dispatchFromChat(request, 'personal', 'agent_team_test', {
      message: '修复重考状态', projectDirectory: context.project, submissionId: 'sub_team', runId: 'atrun_first',
    }, { runId: 'atrun_first', accept: (transaction, runId) => {
      // Chat stores the group id with the Run reference (see ChatDispatchService).
      const reference = { kind: 'coder' as const, coderId: 'agent_team_test', runId, groupId };
      transaction.update(chatSubmissions).set({ reference }).run();
    } });
    await db!.update(coderRuns).set({ status: 'cancelled', finishedAt: new Date() });
    return { ...context, groupId };
  }

  it('binds a re-executed Chat Run to the same conversation as a new task submission', async () => {
    const { service, groupId } = await dispatchedRun();
    await service.control(request, 'personal', groupId, { operation: 'reexecute', runIds: ['atrun_first'] });

    const rows = await db!.select().from(chatSubmissions);
    expect(rows).toHaveLength(2);
    const original = rows.find((row) => row.id === 'sub_team');
    const replacement = rows.find((row) => row.id !== 'sub_team');
    expect(original!.reference).toMatchObject({ kind: 'coder', runId: 'atrun_first' });
    expect(replacement).toMatchObject({ executionId: 'aex_chat', chatId: null, message: '修复重考状态', target: original!.target, settled: false });
    expect(replacement!.reference).toMatchObject({ kind: 'coder', coderId: 'agent_team_test', groupId });
    expect((replacement!.reference as { runId: string }).runId).not.toBe('atrun_first');
  });

  it('re-executes a Run without a Chat binding without creating a submission', async () => {
    const { service, groupId } = await dispatchedRun();
    await db!.delete(chatSubmissions);
    await service.control(request, 'personal', groupId, { operation: 'reexecute', runIds: ['atrun_first'] });

    expect(await db!.select().from(chatSubmissions)).toHaveLength(0);
  });

  it('stops only the exact selected role task and returns its persisted status', async () => {
    const { service, groupId, stoppedTasks } = await dispatchedRun();
    const now = new Date();
    await db!.insert(coderTaskAttempts).values([
      { id: 'attempt_same_role_1', workspaceId: 'workspace_personal', runId: 'atrun_first', taskKey: 'group_0_review_a', attemptIndex: 0, role: 'reviewer', inputRevision: {}, inputFingerprint: 'fingerprint_1', status: 'running', createdAt: now, startedAt: now },
      { id: 'attempt_same_role_2', workspaceId: 'workspace_personal', runId: 'atrun_first', taskKey: 'group_0_review_b', attemptIndex: 0, role: 'reviewer', inputRevision: {}, inputFingerprint: 'fingerprint_2', status: 'running', createdAt: now, startedAt: now },
    ]);

    const view = await service.control(request, 'personal', groupId, {
      operation: 'stop_task', runId: 'atrun_first', taskAttemptId: 'attempt_same_role_2',
    });

    expect(stoppedTasks).toEqual([{ runId: 'atrun_first', taskAttemptId: 'attempt_same_role_2' }]);
    expect(view.runs[0]?.tasks).toEqual([
      { taskAttemptId: 'attempt_same_role_1', role: 'reviewer', status: 'running' },
      { taskAttemptId: 'attempt_same_role_2', role: 'reviewer', status: 'stopped' },
    ]);
  });

  it('continues a stopped task with its saved goal, progress and file references, idempotently', async () => {
    const { service, groupId, created } = await dispatchedRun();
    const now = new Date();
    await db!.insert(coderTaskAttempts).values({
      id: 'attempt_continue', workspaceId: 'workspace_personal', runId: 'atrun_first', taskKey: 'group_0_review',
      attemptIndex: 0, role: 'reviewer', status: 'stopped', assignmentTitle: 'Inspect the regression',
      inputRevision: { taskDefinition: { goal: 'Inspect the regression in the repository' }, fileReferences: [{ documentId: 'atdoc_saved', revision: 2, title: 'Review notes' }] },
      inputFingerprint: 'fingerprint_continue', error: 'The task was stopped.', active: false, createdAt: now, startedAt: now, finishedAt: now,
    });
    await db!.insert(coderRunEvents).values({
      runId: 'atrun_first', sequence: 1, type: 'task.activity',
      payload: { taskAttemptId: 'attempt_continue', phase: 'inspection', message: 'Found the failing branch.' }, createdAt: now,
    });

    await service.control(request, 'personal', groupId, { operation: 'continue_task', runId: 'atrun_first', taskAttemptId: 'attempt_continue' });
    await service.control(request, 'personal', groupId, { operation: 'continue_task', runId: 'atrun_first', taskAttemptId: 'attempt_continue' });

    expect(created).toHaveLength(2);
    const runs = await db!.select().from(coderRuns).where(eq(coderRuns.groupId, groupId)).orderBy(coderRuns.createdAt);
    const continuationRun = runs.find((run) => run.id !== 'atrun_first')!;
    expect(continuationRun.targetRole).toBe('router');
    expect(continuationRun.groupContext).toMatchObject({
      requestedRole: 'reviewer',
      continuation: {
        sourceRunId: 'atrun_first', sourceTaskAttemptId: 'attempt_continue', taskKey: 'group_0_review', role: 'reviewer',
        goal: 'Inspect the regression in the repository',
        savedProgress: expect.stringContaining('Found the failing branch.'),
        fileReferences: [{ documentId: 'atdoc_saved', revision: 2, title: 'Review notes' }],
      },
    });
    const messages = await db!.select().from(coderGroupMessages).where(eq(coderGroupMessages.groupId, groupId));
    expect(messages.filter((message) => message.body.startsWith('继续 reviewer 的任务'))).toHaveLength(1);
  });
});

describe('CodersService.statusCounts', () => {
  it('counts queued and active Runs per Coder in one grouped read, matching per-Coder filtering', async () => {
    await setup();
    const now = new Date();
    await db!.insert(coders).values({ id: 'agent_team_other', workspaceId: 'workspace_personal', name: 'Other Coder', description: 'test', processId: 'bmad-tea', processVersion: '1', roles: [], createdAt: now, updatedAt: now });
    await db!.insert(coderVersions).values({ id: 'atver_other', workspaceId: 'workspace_personal', coderId: 'agent_team_other', version: 1, snapshot: { processId: 'bmad-tea', processVersion: '1', coderName: 'Other Coder', projectExecutorLaunches: {}, orchestrationVersion: 12, roles: [] } as never, createdAt: now });
    const statuses = [
      ['agent_team_test', 'running'], ['agent_team_test', 'running'], ['agent_team_test', 'waiting_for_input'], ['agent_team_test', 'queued'],
      ['agent_team_test', 'succeeded'], ['agent_team_test', 'failed'],
      ['agent_team_other', 'waiting_for_input'], ['agent_team_other', 'queued'], ['agent_team_other', 'queued'], ['agent_team_other', 'cancelled'],
    ] as const;
    await db!.insert(coderRuns).values(statuses.map(([coderId, status], index) => ({
      id: `atrun_count_${index}`, workspaceId: 'workspace_personal', coderId, coderVersionId: coderId === 'agent_team_test' ? 'atver_mock' : 'atver_other',
      intent: 'goal', projectDirectory: '/repo', langGraphThreadId: `atthread_count_${index}`, status, createdAt: now, updatedAt: now,
    })));
    const workspaces = { getWorkspace: async () => ({ id: 'workspace_personal' }) } as unknown as WorkspaceService;
    const teams = new CodersService(db!, workspaces, {} as AgentTeamRuntimeService, {} as AgentTeamConfigurationService);

    const counts = await teams.statusCounts(request, 'personal');
    const count = (coderId: string, wanted: string[]) => counts.filter((row) => row.coderId === coderId && wanted.includes(row.status)).reduce((total, row) => total + row.count, 0);
    const active = ['running', 'waiting_for_input'];
    // The cards used to filter each Coder's full Run list; the grouped counts must agree.
    for (const coderId of ['agent_team_test', 'agent_team_other']) {
      const runs = statuses.filter(([id]) => id === coderId).map(([, status]) => ({ status: status as string }));
      expect(count(coderId, active)).toBe(runs.filter((run) => active.includes(run.status)).length);
      expect(count(coderId, ['queued'])).toBe(runs.filter((run) => run.status === 'queued').length);
    }
    expect(count('agent_team_test', active)).toBe(3);
    expect(count('agent_team_other', ['queued'])).toBe(2);
    expect(counts.some((row) => row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled')).toBe(false);
  });
});

describe('CodersService Run lists', () => {
  it('reads the captured name and orchestration version without the snapshot process files', async () => {
    await setup();
    const now = new Date();
    await db!.insert(coderVersions).values({ id: 'atver_files', workspaceId: 'workspace_personal', coderId: 'agent_team_test', version: 3, createdAt: now,
      snapshot: { processId: 'bmad-tea', processVersion: '1', coderName: 'Captured', projectExecutorLaunches: {}, orchestrationVersion: 12, roles: [{ role: 'planner', displayName: 'Planner' }], processFiles: [{ path: 'big.md', content: 'x'.repeat(10_000) }] } as never });
    await db!.insert(coderRuns).values({ id: 'atrun_files', workspaceId: 'workspace_personal', coderId: 'agent_team_test', coderVersionId: 'atver_files', intent: 'goal', projectDirectory: '/repo', langGraphThreadId: 'atthread_files', status: 'succeeded', createdAt: now, updatedAt: now });
    const workspaces = { getWorkspace: async () => ({ id: 'workspace_personal' }) } as unknown as WorkspaceService;
    const teams = new CodersService(db!, workspaces, {} as AgentTeamRuntimeService, { getTeam: async () => ({}) } as unknown as AgentTeamConfigurationService);

    const page = await teams.listRuns(request, 'personal', ['agent_team_test'], undefined, 10);
    expect(page.items[0]).toMatchObject({ id: 'atrun_files', coderName: 'Captured', orchestrationVersion: 12 });
    const [record] = await teams.records(request, 'personal', 'agent_team_test');
    expect(record).toMatchObject({ id: 'atrun_files', orchestrationVersion: 12 });
  });
});
