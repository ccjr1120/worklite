import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
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
  executorCategories,
  executorRuns,
  agentTeamVersions,
  type AgentTeam,
  type Database,
} from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { AgentTeamRuntimeService } from './executor-category-runtime.service';
import { AgentTeamConfigurationService } from './executor-category-configuration.service';

@Injectable()
export class AgentTeamsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly runtime: AgentTeamRuntimeService,
    private readonly configuration: AgentTeamConfigurationService,
  ) {}

  async get(request: Request, workspaceSlug: string, executorCategoryId: string): Promise<AgentTeamView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const team = await this.configuration.getTeam(workspace.id, executorCategoryId);
    if (team.deletedAt) throw new NotFoundException('This executor has been deleted.');
    return toTeamView(team);
  }

  async list(request: Request, workspaceSlug: string): Promise<AgentTeamView[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.configuration.reconcileSkills(workspace.id);
    const rows = await this.db.select().from(executorCategories)
      .where(and(eq(executorCategories.workspaceId, workspace.id), isNull(executorCategories.deletedAt))).orderBy(asc(executorCategories.name));
    return rows.map(toTeamView);
  }

  async update(
    request: Request,
    workspaceSlug: string,
    executorCategoryId: string,
    input: UpdateAgentTeamRequest,
  ): Promise<AgentTeamView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return toTeamView(await this.configuration.update(workspace.id, executorCategoryId, input));
  }

  async createRole(request: Request, workspaceSlug: string, executorCategoryId: string, input: Omit<AgentTeamRoleConfiguration, 'role'>): Promise<AgentTeamView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return toTeamView(await this.configuration.createRole(workspace.id, executorCategoryId, input));
  }

  async updateRole(request: Request, workspaceSlug: string, executorCategoryId: string, roleId: string, input: Partial<Omit<AgentTeamRoleConfiguration, 'role'>>): Promise<AgentTeamView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return toTeamView(await this.configuration.updateRole(workspace.id, executorCategoryId, roleId, input));
  }

  async deleteRole(request: Request, workspaceSlug: string, executorCategoryId: string, roleId: string): Promise<AgentTeamView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return toTeamView(await this.configuration.deleteRole(workspace.id, executorCategoryId, roleId));
  }

  async records(request: Request, workspaceSlug: string, executorCategoryId: string): Promise<AgentTeamRunSummary[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    // Allow reading records for retired categories, but validate the category exists or is retired
    try {
      await this.configuration.getTeam(workspace.id, executorCategoryId);
    } catch (error) {
      // If the team is not found because it's retired, allow reading the records anyway
      // The getTeam will throw BadRequestException for retired IDs, so we need to check that
      if (!(error instanceof BadRequestException)) {
        throw error;
      }
      // For retired IDs, fall through to query the records anyway
    }
    const rows = await this.db.select({ id: executorRuns.id, intent: executorRuns.intent,
      projectDirectory: executorRuns.projectDirectory, mode: executorRuns.mode,
      modeRationale: executorRuns.modeRationale, modeDecidedAt: executorRuns.modeDecidedAt, snapshot: agentTeamVersions.snapshot,
      status: executorRuns.status, createdAt: executorRuns.createdAt, finishedAt: executorRuns.finishedAt,
    }).from(executorRuns).innerJoin(agentTeamVersions, eq(agentTeamVersions.id, executorRuns.executorCategoryVersionId))
      .where(and(eq(executorRuns.executorCategoryId, executorCategoryId), eq(executorRuns.workspaceId, workspace.id)))
      .orderBy(desc(executorRuns.createdAt));
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
    executorCategoryId: string,
    input: CreateAgentTeamRunRequest,
    acceptance: Parameters<AgentTeamRuntimeService['createRun']>[2],
  ): Promise<AgentTeamRunView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.getTeam(executorCategoryId, workspace.id);
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

  async delete(request: Request, workspaceSlug: string, executorCategoryId: string, confirmTeamId: string): Promise<{ executorCategoryId: string; deletedAt: string }> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const result = await this.configuration.deleteTeam(workspace.id, executorCategoryId, confirmTeamId);
    return {
      executorCategoryId: result.executorCategoryId,
      deletedAt: result.deletedAt.toISOString(),
    };
  }

  private async getTeam(executorCategoryId: string, workspaceId: string): Promise<AgentTeam> {
    const [team] = await this.db.select().from(executorCategories)
      .where(and(eq(executorCategories.id, executorCategoryId), eq(executorCategories.workspaceId, workspaceId)))
      .limit(1);
    if (!team) throw new NotFoundException('Executor not found.');
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


