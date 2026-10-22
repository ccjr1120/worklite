import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { createDb, initializeDatabase, agentTeamRuns, agentTeamVersions, agentTeams, type Database } from '@worklite/db';
import { AgentTeamGroupsService } from './agent-team-groups.service';
import { AgentTeamsService } from './agent-teams.service';
import type { AgentTeamConfigurationService } from './agent-team-configuration.service';
import { AGENT_TEAM_DISPATCHER_ROLE } from './agent-team-configuration';
import type { AgentTeamRuntimeService } from './agent-team-runtime.service';
import type { WorkspaceService } from '../teams/teams.service';

// Agent Teams no longer accept a mode: Chat dispatch addresses the Team
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
  await db.insert(agentTeams).values({
    id: 'agent_team_test',
    workspaceId: 'workspace_personal',
    name: 'Test Team',
    description: 'test',
    processId: 'bmad-tea',
    processVersion: '1',
    roles: [role(AGENT_TEAM_DISPATCHER_ROLE), role('planner'), role('reviewer')],
    createdAt: now,
    updatedAt: now,
  });
  const created: Array<Parameters<AgentTeamRuntimeService['createGroupRun']>[1]> = [];
  const runtime = {
    readGroupProjectInstructions: async () => [],
    createGroupRun: async (_workspaceId: string, request: Parameters<AgentTeamRuntimeService['createGroupRun']>[1]) => { created.push(request); },
  } as unknown as AgentTeamRuntimeService;
  const workspaces = { getWorkspace: async () => ({ id: 'workspace_personal' }) } as unknown as WorkspaceService;
  const project = mkdtempSync(join(tmpdir(), 'worklite-team-dispatch-'));
  directories.push(project);
  return { service: new AgentTeamGroupsService(db, workspaces, runtime), created, project };
}

const request = {} as Request;

describe('AgentTeamGroupsService.dispatchFromChat', () => {
  it('dispatches without a mode and addresses the Team Dispatcher by default', async () => {
    const { service, created, project } = await setup();
    await service.dispatchFromChat(request, 'personal', 'agent_team_test', {
      message: '帮我看看这个项目', projectDirectory: project, submissionId: 'sub_default', runId: 'atrun_default',
    }, { runId: 'atrun_default', accept: () => undefined });

    expect(created).toHaveLength(1);
    expect(created[0]!.targetRole).toBe(AGENT_TEAM_DISPATCHER_ROLE);
    expect(created[0]).not.toHaveProperty('mode');
  });

  it('ignores a deprecated mode from an older caller without failing', async () => {
    const { service, created, project } = await setup();
    const legacy = { message: '只出方案', projectDirectory: project, submissionId: 'sub_legacy', runId: 'atrun_legacy', mode: 'implement_and_validate' };
    await service.dispatchFromChat(request, 'personal', 'agent_team_test', legacy, { runId: 'atrun_legacy', accept: () => undefined });

    expect(created).toHaveLength(1);
    expect(created[0]!.targetRole).toBe(AGENT_TEAM_DISPATCHER_ROLE);
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

describe('AgentTeamsService.records', () => {
  it('exposes the v10 Dispatcher decision and keeps a v9 Run on its captured mode', async () => {
    await setup();
    const now = new Date();
    const snapshot = (orchestrationVersion: 9 | 10) => ({ processId: 'bmad-tea', processVersion: '1', manifestHash: '', developerExecution: { kind: 'codex_app_server' as const }, orchestrationVersion, roles: [] });
    await db!.insert(agentTeamVersions).values([
      { id: 'atver_9', workspaceId: 'workspace_personal', teamId: 'agent_team_test', version: 1, snapshot: snapshot(9) as never, createdAt: now },
      { id: 'atver_10', workspaceId: 'workspace_personal', teamId: 'agent_team_test', version: 2, snapshot: snapshot(10) as never, createdAt: now },
    ]);
    const base = { workspaceId: 'workspace_personal', teamId: 'agent_team_test', intent: 'goal', projectDirectory: '/repo', createdAt: now, updatedAt: now };
    await db!.insert(agentTeamRuns).values([
      { ...base, id: 'atrun_v9', teamVersionId: 'atver_9', mode: 'implement_and_validate', langGraphThreadId: 'atthread_v9' },
      { ...base, id: 'atrun_v10', teamVersionId: 'atver_10', mode: 'validate_existing', modeRationale: 'The user asked to assess current behavior.', modeDecidedAt: now, langGraphThreadId: 'atthread_v10' },
    ]);
    const workspaces = { getWorkspace: async () => ({ id: 'workspace_personal' }) } as unknown as WorkspaceService;
    const teams = new AgentTeamsService(db!, workspaces, {} as AgentTeamRuntimeService, {} as AgentTeamConfigurationService);

    const records = await teams.records(request, 'personal', 'agent_team_test');
    const v9 = records.find((record) => record.id === 'atrun_v9')!;
    const v10 = records.find((record) => record.id === 'atrun_v10')!;
    expect(v9).toMatchObject({ mode: 'implement_and_validate', modeRationale: null, modeDecidedAt: null, orchestrationVersion: 9 });
    expect(v10).toMatchObject({ mode: 'validate_existing', modeRationale: 'The user asked to assess current behavior.', modeDecidedAt: now.toISOString(), orchestrationVersion: 10 });
  });
});
