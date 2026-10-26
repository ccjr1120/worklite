import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Request } from 'express';
import type {
  AgentTeamRoleConfiguration,
  AgentTeamRunEvent,
  AgentTeamRunView,
  AgentTeamRunSummary,
  AgentTeamView,
  AnswerAgentTeamRunRequest,
  CreateAgentTeamRunRequest,
  RecoverAgentTeamOperationRequest,
  UpdateAgentTeamRequest,
} from '@worklite/contracts';
import {
  agentTeams,
  agentTeamRuns,
  agentTeamVersions,
  type AgentTeam,
  type Database,
} from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { AgentTeamRuntimeService } from './agent-team-runtime.service';
import { AgentTeamConfigurationService } from './agent-team-configuration.service';

@Injectable()
export class AgentTeamsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly runtime: AgentTeamRuntimeService,
    private readonly configuration: AgentTeamConfigurationService,
  ) {}

  async get(request: Request, workspaceSlug: string, teamId: string): Promise<AgentTeamView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return toTeamView(await this.configuration.getTeam(workspace.id, teamId));
  }

  async list(request: Request, workspaceSlug: string): Promise<AgentTeamView[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.configuration.reconcileSkills(workspace.id);
    const rows = await this.db.select().from(agentTeams)
      .where(eq(agentTeams.workspaceId, workspace.id)).orderBy(asc(agentTeams.name));
    return rows.map(toTeamView);
  }

  async update(
    request: Request,
    workspaceSlug: string,
    teamId: string,
    input: UpdateAgentTeamRequest,
  ): Promise<AgentTeamView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return toTeamView(await this.configuration.update(workspace.id, teamId, input));
  }

  async createRole(request: Request, workspaceSlug: string, teamId: string, input: Omit<AgentTeamRoleConfiguration, 'role'>): Promise<AgentTeamView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return toTeamView(await this.configuration.createRole(workspace.id, teamId, input));
  }

  async updateRole(request: Request, workspaceSlug: string, teamId: string, roleId: string, input: Partial<Omit<AgentTeamRoleConfiguration, 'role'>>): Promise<AgentTeamView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return toTeamView(await this.configuration.updateRole(workspace.id, teamId, roleId, input));
  }

  async deleteRole(request: Request, workspaceSlug: string, teamId: string, roleId: string): Promise<AgentTeamView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return toTeamView(await this.configuration.deleteRole(workspace.id, teamId, roleId));
  }

  async records(request: Request, workspaceSlug: string, teamId: string): Promise<AgentTeamRunSummary[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.configuration.getTeam(workspace.id, teamId);
    const rows = await this.db.select({ id: agentTeamRuns.id, intent: agentTeamRuns.intent,
      projectDirectory: agentTeamRuns.projectDirectory, mode: agentTeamRuns.mode,
      modeRationale: agentTeamRuns.modeRationale, modeDecidedAt: agentTeamRuns.modeDecidedAt, snapshot: agentTeamVersions.snapshot,
      status: agentTeamRuns.status, createdAt: agentTeamRuns.createdAt, finishedAt: agentTeamRuns.finishedAt,
    }).from(agentTeamRuns).innerJoin(agentTeamVersions, eq(agentTeamVersions.id, agentTeamRuns.teamVersionId))
      .where(and(eq(agentTeamRuns.teamId, teamId), eq(agentTeamRuns.workspaceId, workspace.id)))
      .orderBy(desc(agentTeamRuns.createdAt));
    return rows.map(({ snapshot, ...row }) => ({
      ...row,
      modeDecidedAt: row.modeDecidedAt?.toISOString() ?? null,
      orchestrationVersion: snapshot.orchestrationVersion ?? 1,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    }));
  }

  async createRun(
    request: Request,
    workspaceSlug: string,
    teamId: string,
    input: CreateAgentTeamRunRequest,
    acceptance: Parameters<AgentTeamRuntimeService['createRun']>[2],
  ): Promise<AgentTeamRunView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.getTeam(teamId, workspace.id);
    return this.runtime.createRun(workspace.id, input, acceptance);
  }

  async getRun(request: Request, workspaceSlug: string, runId: string): Promise<AgentTeamRunView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return this.runtime.getRunView(runId, workspace.id);
  }

  async events(
    request: Request,
    workspaceSlug: string,
    runId: string,
    afterSequence: number,
  ): Promise<AgentTeamRunEvent[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return this.runtime.getRunEvents(runId, workspace.id, afterSequence);
  }

  subscribe(listener: (event: AgentTeamRunEvent) => void): () => void {
    return this.runtime.subscribe(listener);
  }

  async answer(
    request: Request,
    workspaceSlug: string,
    runId: string,
    input: AnswerAgentTeamRunRequest,
  ): Promise<AgentTeamRunView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.runtime.getRunView(runId, workspace.id);
    return this.runtime.answer(runId, input);
  }

  async recover(
    request: Request,
    workspaceSlug: string,
    runId: string,
    input: RecoverAgentTeamOperationRequest,
  ): Promise<AgentTeamRunView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.runtime.getRunView(runId, workspace.id);
    return this.runtime.recover(runId, input);
  }

  async pause(request: Request, workspaceSlug: string, runId: string): Promise<AgentTeamRunView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.runtime.getRunView(runId, workspace.id);
    return this.runtime.pause(runId);
  }

  async resume(request: Request, workspaceSlug: string, runId: string): Promise<AgentTeamRunView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.runtime.getRunView(runId, workspace.id);
    return this.runtime.resume(runId);
  }

  async cancel(request: Request, workspaceSlug: string, runId: string): Promise<AgentTeamRunView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.runtime.getRunView(runId, workspace.id);
    return this.runtime.cancel(runId);
  }

  async retry(
    request: Request,
    workspaceSlug: string,
    runId: string,
    taskKey: string,
  ): Promise<AgentTeamRunView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.runtime.getRunView(runId, workspace.id);
    return this.runtime.retry(runId, taskKey);
  }

  private async getTeam(teamId: string, workspaceId: string): Promise<AgentTeam> {
    const [team] = await this.db.select().from(agentTeams)
      .where(and(eq(agentTeams.id, teamId), eq(agentTeams.workspaceId, workspaceId)))
      .limit(1);
    if (!team) throw new NotFoundException('Agent Team not found.');
    return team;
  }

}

function toTeamView(row: AgentTeam): AgentTeamView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    processId: row.processId,
    processVersion: row.processVersion,
    maxConcurrentRuns: row.maxConcurrentRuns,
    workingPractice: row.workingPractice,
    projectGitPolicy: row.projectGitPolicy,
    // Stored roles predating orchestration v3 may still carry the removed
    // developerInstances/developerConcurrency fields; reads drop them and the
    // next save persists the clean shape.
    roles: row.roles.map((role) => ({
      role: role.role,
      publicModelId: role.publicModelId,
      instructions: role.instructions,
      entryPoints: role.entryPoints,
      skillIds: role.skills.map((skill) => skill.id),
      mcpServerIds: role.mcpServers.map((server) => server.id),
      toolNames: role.toolNames,
      ...(role.displayName ? { displayName: role.displayName } : {}),
      ...(role.executor ? { executor: role.executor } : role.role === 'developer' ? { executor: 'claude' as const } : {}),
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}


