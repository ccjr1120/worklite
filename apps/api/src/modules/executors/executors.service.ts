import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import type { Request } from 'express';
import type {
  AgentTeamRunListPage,
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
import { AgentTeamRuntimeService } from './executor-runtime.service';
import { AgentTeamConfigurationService, executorRevision } from './executor-configuration.service';
import { capturedExecutorName } from './executor-run-summary';
import { RETIRED_AGENT_TEAM_IDS } from './executor-configuration';

@Injectable()
export class ExecutorsService {
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
      .where(and(
        eq(executorCategories.workspaceId, workspace.id),
        isNull(executorCategories.deletedAt),
        notInArray(executorCategories.id, [...RETIRED_AGENT_TEAM_IDS]),
      )).orderBy(asc(executorCategories.name));
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
    await this.configuration.getTeam(workspace.id, executorCategoryId);
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

  async listRuns(
    request: Request,
    workspaceSlug: string,
    executorCategoryIds: string[],
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<AgentTeamRunListPage> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const pageLimit = Math.min(Math.max(Number.isFinite(limit) ? Math.floor(limit!) : 50, 1), 200);
    const cursorValue = cursor ? parseRunListCursor(cursor) : null;
    const conditions = [eq(executorRuns.workspaceId, workspace.id)];

    if (executorCategoryIds.length > 0) {
      conditions.push(inArray(executorRuns.executorCategoryId, executorCategoryIds));
    }
    if (cursorValue) {
      conditions.push(or(
        lt(executorRuns.createdAt, cursorValue.createdAt),
        and(
          eq(executorRuns.createdAt, cursorValue.createdAt),
          lt(executorRuns.id, cursorValue.id),
        ),
      )!);
    }

    const rows = await this.db.select({
      id: executorRuns.id,
      intent: executorRuns.intent,
      projectDirectory: executorRuns.projectDirectory,
      mode: executorRuns.mode,
      modeRationale: executorRuns.modeRationale,
      modeDecidedAt: executorRuns.modeDecidedAt,
      status: executorRuns.status,
      createdAt: executorRuns.createdAt,
      finishedAt: executorRuns.finishedAt,
      executorCategoryId: executorRuns.executorCategoryId,
      currentExecutorName: executorCategories.name,
      snapshot: agentTeamVersions.snapshot,
      total: sql<number>`count(*) over()`,
    }).from(executorRuns)
      .innerJoin(executorCategories, eq(executorCategories.id, executorRuns.executorCategoryId))
      .innerJoin(agentTeamVersions, eq(agentTeamVersions.id, executorRuns.executorCategoryVersionId))
      .where(and(...conditions))
      .orderBy(desc(executorRuns.createdAt), desc(executorRuns.id))
      .limit(pageLimit + 1);

    const pageRows = rows.slice(0, pageLimit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(({ snapshot, total: _total, currentExecutorName, ...row }) => ({
        ...row,
        executorName: capturedExecutorName(snapshot, currentExecutorName),
        modeDecidedAt: row.modeDecidedAt?.toISOString() ?? null,
        orchestrationVersion: snapshot.orchestrationVersion ?? 1,
        createdAt: row.createdAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
      })),
      nextCursor: last ? encodeRunListCursor(last.createdAt, last.id) : null,
      total: Number(pageRows[0]?.total ?? rows.length),
    };
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

function encodeRunListCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString('base64url');
}

function parseRunListCursor(value: string): { createdAt: Date; id: string } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Invalid executor run cursor.');
  }

  if (!decoded || typeof decoded !== 'object' || !('createdAt' in decoded) || !('id' in decoded)
    || typeof decoded.createdAt !== 'string' || typeof decoded.id !== 'string' || !decoded.id) {
    throw new BadRequestException('Invalid executor run cursor.');
  }
  const createdAt = new Date(decoded.createdAt);
  if (!Number.isFinite(createdAt.getTime())) throw new BadRequestException('Invalid executor run cursor.');
  return { createdAt, id: decoded.id };
}

function toTeamView(row: AgentTeam): AgentTeamView {
  return {
    id: row.id,
    name: row.name,
    revision: executorRevision(row),
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
