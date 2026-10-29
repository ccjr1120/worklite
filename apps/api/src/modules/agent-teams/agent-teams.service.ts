import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
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

  async listRuns(
    request: Request,
    workspaceSlug: string,
    teamIds: string[] = [],
    cursor?: string,
    limit?: number,
  ): Promise<{ items: Array<Record<string, unknown>>; nextCursor: string | null; total: number }> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const LIMIT_MAX = 200;
    const LIMIT_DEFAULT = 50;
    const normalizedLimit = Math.min(limit ?? LIMIT_DEFAULT, LIMIT_MAX);

    // Deduplicate and validate teamIds
    const uniqueTeamIds = [...new Set(teamIds)];
    if (uniqueTeamIds.length > 0) {
      const validTeams = await this.db.select({ id: agentTeams.id })
        .from(agentTeams)
        .where(and(eq(agentTeams.workspaceId, workspace.id)))
        .then(rows => new Set(rows.map(r => r.id)));
      // Filter to valid teams only; if any are invalid, just keep the valid ones
      const filtered = uniqueTeamIds.filter(id => validTeams.has(id));
      uniqueTeamIds.length = 0;
      uniqueTeamIds.push(...filtered);
    }

    // Parse cursor if provided
    let cursorCreatedAt: Date | undefined;
    let cursorId: string | undefined;
    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
        const [createdAtStr, id] = decoded.split(':');
        cursorCreatedAt = new Date(createdAtStr);
        cursorId = id;
        if (isNaN(cursorCreatedAt.getTime())) throw new Error('Invalid cursor');
      } catch {
        throw new Error('Invalid cursor format');
      }
    }

    // Build query conditions
    let whereCondition: unknown = eq(agentTeamRuns.workspaceId, workspace.id);

    if (uniqueTeamIds.length > 0) {
      whereCondition = and(whereCondition, inArray(agentTeamRuns.teamId, uniqueTeamIds));
    }

    // Add cursor condition for keyset pagination
    if (cursorCreatedAt && cursorId) {
      const cursorCondition = or(
        lt(agentTeamRuns.createdAt, cursorCreatedAt),
        and(eq(agentTeamRuns.createdAt, cursorCreatedAt), lt(agentTeamRuns.id, cursorId)),
      );
      whereCondition = and(whereCondition, cursorCondition);
    }

    // Fetch one extra row to determine if there's a next page
    const rows = await this.db.select({
      id: agentTeamRuns.id,
      intent: agentTeamRuns.intent,
      projectDirectory: agentTeamRuns.projectDirectory,
      mode: agentTeamRuns.mode,
      modeRationale: agentTeamRuns.modeRationale,
      modeDecidedAt: agentTeamRuns.modeDecidedAt,
      snapshot: agentTeamVersions.snapshot,
      status: agentTeamRuns.status,
      createdAt: agentTeamRuns.createdAt,
      finishedAt: agentTeamRuns.finishedAt,
      teamId: agentTeamRuns.teamId,
      teamName: agentTeams.name,
    })
      .from(agentTeamRuns)
      .innerJoin(agentTeamVersions, eq(agentTeamVersions.id, agentTeamRuns.teamVersionId))
      .innerJoin(agentTeams, eq(agentTeams.id, agentTeamRuns.teamId))
      .where(whereCondition)
      .orderBy(desc(agentTeamRuns.createdAt), desc(agentTeamRuns.id))
      .limit(normalizedLimit + 1);

    const hasMore = rows.length > normalizedLimit;
    const items = rows.slice(0, normalizedLimit);
    let nextCursor: string | null = null;

    if (hasMore && items.length > 0) {
      const lastItem = items[items.length - 1];
      nextCursor = Buffer.from(`${lastItem.createdAt.toISOString()}:${lastItem.id}`).toString('base64');
    }

    // Compute total count with the same filters (without cursor pagination)
    let countCondition: any = eq(agentTeamRuns.workspaceId, workspace.id);
    if (uniqueTeamIds.length > 0) {
      countCondition = and(countCondition, inArray(agentTeamRuns.teamId, uniqueTeamIds));
    }

    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(agentTeamRuns)
      .where(countCondition);

    const total = Number(countResult[0]?.count) || 0;

    return {
      items: items.map(({ snapshot, ...row }) => ({
        ...row,
        modeDecidedAt: row.modeDecidedAt?.toISOString() ?? null,
        orchestrationVersion: snapshot.orchestrationVersion ?? 1,
        createdAt: row.createdAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
      })),
      nextCursor,
      total,
    };
  }

  private async getTeam(teamId: string, workspaceId: string): Promise<AgentTeam> {
    const [team] = await this.db.select().from(agentTeams)
      .where(and(eq(agentTeams.id, teamId), eq(agentTeams.workspaceId, workspaceId)))
      .limit(1);
    if (!team) throw new NotFoundException('Coding Executors team not found.');
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


