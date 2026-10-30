import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { createDb, initializeDatabase, coderRuns, coderVersions, coders, chatSubmissions, type Database } from '@worklite/db';
import { AgentTeamGroupsService } from './coder-groups.service';
import { CodersService } from './coders.service';
import type { AgentTeamConfigurationService } from './coder-configuration.service';
import { CODER_DISPATCHER_ROLE } from './coder-configuration';
import type { AgentTeamRuntimeService } from './coder-runtime.service';
import type { WorkspaceService } from '../teams/teams.service';

// Agent Teams no longer accept a mode: Chat dispatch addresses the Coder
// Dispatcher by default and never forwards a mode to the Run.

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
    roles: [role(CODER_DISPATCHER_ROLE), role('planner'), role('reviewer')],
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(coderVersions).values({ id: 'atver_mock', workspaceId: 'workspace_personal', coderId: 'agent_team_test', version: 99, snapshot: { processId: 'bmad-tea', processVersion: '1', manifestHash: '', developerExecution: { kind: 'codex_app_server' }, orchestrationVersion: 11, roles: [] } as never, createdAt: now });
  const created: Array<Parameters<AgentTeamRuntimeService['createGroupRun']>[1]> = [];
  const runtime = {
    readGroupProjectInstructions: async () => [],
    createGroupRun: async (_workspaceId: string, request: Parameters<AgentTeamRuntimeService['createGroupRun']>[1], acceptance: Parameters<AgentTeamRuntimeService['createGroupRun']>[2]) => {
      created.push(request);
      // Like the real runtime, the Run row commits together with its acceptance.
      const at = new Date();
      db!.transaction((transaction) => {
        transaction.insert(coderRuns).values({ id: acceptance.runId, workspaceId: 'workspace_personal', coderId: request.coderId, coderVersionId: 'atver_mock', intent: request.intent, projectDirectory: '', mode: 'plan_only', langGraphThreadId: `atthread_${acceptance.runId}`, groupId: request.groupId, groupMessageId: request.groupMessageId, targetRole: request.targetRole, repositoryIds: request.repositoryIds, createdAt: at, updatedAt: at }).run();
        acceptance.accept(transaction, acceptance.runId);
      });
    },
  } as unknown as AgentTeamRuntimeService;
  const workspaces = { getWorkspace: async () => ({ id: 'workspace_personal' }) } as unknown as WorkspaceService;
  const project = mkdtempSync(join(tmpdir(), 'worklite-team-dispatch-'));
  directories.push(project);
  return { service: new AgentTeamGroupsService(db, workspaces, runtime), created, project };
}

const request = {} as Request;

describe('AgentTeamGroupsService.dispatchFromChat', () => {
  it('dispatches without a mode and addresses the Coder Dispatcher by default', async () => {
    const { service, created, project } = await setup();
    await service.dispatchFromChat(request, 'personal', 'agent_team_test', {
      message: '帮我看看这个项目', projectDirectory: project, submissionId: 'sub_default', runId: 'atrun_default',
    }, { runId: 'atrun_default', accept: () => undefined });

    expect(created).toHaveLength(1);
    expect(created[0]!.targetRole).toBe(CODER_DISPATCHER_ROLE);
    expect(created[0]).not.toHaveProperty('mode');
  });

  it('ignores a deprecated mode from an older caller without failing', async () => {
    const { service, created, project } = await setup();
    const legacy = { message: '只出方案', projectDirectory: project, submissionId: 'sub_legacy', runId: 'atrun_legacy', mode: 'implement_and_validate' };
    await service.dispatchFromChat(request, 'personal', 'agent_team_test', legacy, { runId: 'atrun_legacy', accept: () => undefined });

    expect(created).toHaveLength(1);
    expect(created[0]!.targetRole).toBe(CODER_DISPATCHER_ROLE);
    expect(created[0]).not.toHaveProperty('mode');
  });

  it('keeps a user-named initial role', async () => {
    const { service, created, project } = await setup();
    await service.dispatchFromChat(request, 'personal', 'agent_team_test', {
      message: '请评审', projectDirectory: project, role: 'reviewer', submissionId: 'sub_named', runId: 'atrun_named',
    }, { runId: 'atrun_named', accept: () => undefined });

    expect(created[0]!.targetRole).toBe('reviewer');
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
});

describe('CodersService.records', () => {
  it('exposes the v10 Dispatcher decision and keeps a v9 Run on its captured mode', async () => {
    await setup();
    const now = new Date();
    const snapshot = (orchestrationVersion: 9 | 10) => ({ processId: 'bmad-tea', processVersion: '1', manifestHash: '', developerExecution: { kind: 'codex_app_server' as const }, orchestrationVersion, roles: [] });
    await db!.insert(coderVersions).values([
      { id: 'atver_9', workspaceId: 'workspace_personal', coderId: 'agent_team_test', version: 1, snapshot: snapshot(9) as never, createdAt: now },
      { id: 'atver_10', workspaceId: 'workspace_personal', coderId: 'agent_team_test', version: 2, snapshot: snapshot(10) as never, createdAt: now },
    ]);
    const base = { workspaceId: 'workspace_personal', coderId: 'agent_team_test', intent: 'goal', projectDirectory: '/repo', createdAt: now, updatedAt: now };
    await db!.insert(coderRuns).values([
      { ...base, id: 'atrun_v9', coderVersionId: 'atver_9', mode: 'implement_and_validate', langGraphThreadId: 'atthread_v9' },
      { ...base, id: 'atrun_v10', coderVersionId: 'atver_10', mode: 'validate_existing', modeRationale: 'The user asked to assess current behavior.', modeDecidedAt: now, langGraphThreadId: 'atthread_v10' },
    ]);
    const workspaces = { getWorkspace: async () => ({ id: 'workspace_personal' }) } as unknown as WorkspaceService;
    const teams = new CodersService(db!, workspaces, {} as AgentTeamRuntimeService, {} as AgentTeamConfigurationService);

    const records = await teams.records(request, 'personal', 'agent_team_test');
    const v9 = records.find((record) => record.id === 'atrun_v9')!;
    const v10 = records.find((record) => record.id === 'atrun_v10')!;
    expect(v9).toMatchObject({ mode: 'implement_and_validate', modeRationale: null, modeDecidedAt: null, orchestrationVersion: 9 });
    expect(v10).toMatchObject({ mode: 'validate_existing', modeRationale: 'The user asked to assess current behavior.', modeDecidedAt: now.toISOString(), orchestrationVersion: 10 });
  });
});
