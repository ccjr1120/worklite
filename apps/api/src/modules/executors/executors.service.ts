import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import type { Request } from 'express';
import type {
  AgentTeamRunListPage,
  AgentTeamRunNodeTree,
  AgentTeamRunOverview,
  AgentTeamRunStatus,
  GatewayAttributionGroup,
  GatewayRequestLogTimeline,
  AgentTeamRoleConfiguration,
  AgentTeamRunEvent,
  AgentTeamRunView,
  AgentTeamRunSummary,
  AgentTeamView,
  CreateAgentTeamRequest,
  AnswerAgentTeamRunRequest,
  CreateAgentTeamRunRequest,
  RecoverAgentTeamOperationRequest,
  UpdateAgentTeamRequest,
} from '@worklite/contracts';
import {
  executorCategories,
  executorRuns,
  executorRunEvents,
  executorTaskAttempts,
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
import { PortkeyGatewayService } from '../model-providers/portkey-gateway.service';
import { activitiesByAttempt, buildRunNodes, currentRunNode, durationBetween, isRunInProgress, runTotalTokens, timelineByNode, unavailableTokens, type ActivityRow, type AttemptRow } from './executor-run-nodes';

const RUN_NODE_BATCH_LIMIT = 50;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_LOG_RETENTION_HOURS = 12;

@Injectable()
export class ExecutorsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly runtime: AgentTeamRuntimeService,
    private readonly configuration: AgentTeamConfigurationService,
    // Token figures are read-only Gateway evidence; without the Gateway they are reported unavailable.
    @Optional() private readonly gateway?: PortkeyGatewayService,
  ) {}

  private readonly logger = new Logger(ExecutorsService.name);

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

  async create(request: Request, workspaceSlug: string, input: CreateAgentTeamRequest): Promise<AgentTeamView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return toTeamView(await this.configuration.create(workspace.id, input));
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
    const overviews = await this.runOverviews(pageRows);
    return {
      items: pageRows.map(({ snapshot, total: _total, currentExecutorName, ...row }) => ({
        ...row,
        executorName: capturedExecutorName(snapshot, currentExecutorName),
        overview: overviews.get(row.id)!,
        modeDecidedAt: row.modeDecidedAt?.toISOString() ?? null,
        orchestrationVersion: snapshot.orchestrationVersion ?? 1,
        createdAt: row.createdAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
      })),
      nextCursor: last ? encodeRunListCursor(last.createdAt, last.id) : null,
      total: Number(pageRows[0]?.total ?? rows.length),
    };
  }

  /**
   * Overview columns for one page of Runs with a fixed number of reads: one Gateway
   * statistics call grouped by team_run for the whole page, and for the in-progress Runs
   * only, one attempt query and one activity query.
   */
  private async runOverviews(rows: ReadonlyArray<{ id: string; status: AgentTeamRunStatus; createdAt: Date; finishedAt: Date | null; snapshot: Parameters<typeof currentRunNode>[0] }>): Promise<Map<string, AgentTeamRunOverview>> {
    const nowMs = Date.now();
    const overviews = new Map<string, AgentTeamRunOverview>();
    if (!rows.length) return overviews;
    const statsByRun = await this.runStats(rows.map((row) => row.id), rows, 'team_run');
    const active = rows.filter((row) => isRunInProgress(row.status));
    const activeIds = active.map((row) => row.id);
    let attempts: AttemptRow[] = [];
    let activityRows: ActivityRow[] = [];
    if (activeIds.length) {
      [attempts, activityRows] = await Promise.all([
        this.db.select().from(executorTaskAttempts)
          .where(inArray(executorTaskAttempts.runId, activeIds))
          .orderBy(asc(executorTaskAttempts.createdAt), asc(executorTaskAttempts.attemptIndex)),
        this.db.select({ runId: executorRunEvents.runId, sequence: executorRunEvents.sequence, payload: executorRunEvents.payload, createdAt: executorRunEvents.createdAt })
          .from(executorRunEvents)
          .where(and(inArray(executorRunEvents.runId, activeIds), eq(executorRunEvents.type, 'task.activity')))
          .orderBy(asc(executorRunEvents.sequence)),
      ]);
    }
    const activities = activitiesByAttempt(activityRows);
    for (const row of rows) {
      const totalTokens = statsByRun
        ? runTotalTokens(statsByRun.find((group) => group.teamRunId === row.id))
        : unavailableTokens('gateway_unavailable');
      const overview: AgentTeamRunOverview = { totalTokens, durationMs: durationBetween(row.createdAt, row.finishedAt, nowMs) };
      if (isRunInProgress(row.status)) {
        const currentNode = currentRunNode(row.snapshot, attempts.filter((attempt) => attempt.runId === row.id), activities);
        if (currentNode) overview.currentNode = currentNode;
      }
      overviews.set(row.id, overview);
    }
    return overviews;
  }

  // One statistics read for a set of Runs, or null when the Gateway cannot answer.
  private async runStats(runIds: string[], rows: ReadonlyArray<{ createdAt: Date }>, groupBy: 'team_run' | 'node_run'): Promise<GatewayAttributionGroup[] | null> {
    if (!this.gateway || !runIds.length) return null;
    const from = new Date(Math.min(...rows.map((row) => row.createdAt.getTime()))).toISOString();
    try {
      const stats = await this.gateway.stats({ from, to: new Date().toISOString(), groupBy, teamRunId: runIds.join(',') });
      return stats.attribution.groups;
    } catch (error) {
      this.logger.warn(`Gateway statistics for ${runIds.length} Runs are unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async runTimeline(runIds: string[], rows: ReadonlyArray<{ createdAt: Date }>): Promise<GatewayRequestLogTimeline | null> {
    if (!this.gateway || !runIds.length) return null;
    const from = new Date(Math.min(...rows.map((row) => row.createdAt.getTime()))).toISOString();
    try {
      return await this.gateway.requestLogTimeline({ from, to: new Date().toISOString(), teamRunId: runIds.join(',') });
    } catch (error) {
      this.logger.warn(`Gateway request timeline for ${runIds.length} Runs is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Read-only node trees for several Runs. The number of reads is fixed regardless of how
   * many Runs are asked for: the Runs, their attempts, their activity, one Gateway
   * statistics call grouped by node_run and one request timeline call.
   */
  async runNodes(request: Request, workspaceSlug: string, runIds: string[], executorCategoryIds: string[]): Promise<AgentTeamRunNodeTree> {
    const ids = [...new Set(runIds.map((id) => id.trim()).filter(Boolean))];
    if (!ids.length) throw new BadRequestException('runIds is required.');
    if (ids.length > RUN_NODE_BATCH_LIMIT) throw new BadRequestException(`At most ${RUN_NODE_BATCH_LIMIT} runIds are accepted.`);
    const invalid = ids.find((id) => !RUN_ID_PATTERN.test(id));
    if (invalid) throw new BadRequestException(`Invalid executor run id ${invalid}.`);
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const conditions = [eq(executorRuns.workspaceId, workspace.id), inArray(executorRuns.id, ids)];
    if (executorCategoryIds.length) conditions.push(inArray(executorRuns.executorCategoryId, executorCategoryIds));
    const runs = await this.db.select({ id: executorRuns.id, createdAt: executorRuns.createdAt, snapshot: agentTeamVersions.snapshot })
      .from(executorRuns)
      .innerJoin(agentTeamVersions, eq(agentTeamVersions.id, executorRuns.executorCategoryVersionId))
      .where(and(...conditions));
    if (!runs.length) return { runs: [], requestLogRetentionHours: REQUEST_LOG_RETENTION_HOURS };
    const foundIds = runs.map((run) => run.id);
    const [attempts, activityRows, stats, timeline] = await Promise.all([
      this.db.select().from(executorTaskAttempts)
        .where(inArray(executorTaskAttempts.runId, foundIds))
        .orderBy(asc(executorTaskAttempts.createdAt), asc(executorTaskAttempts.attemptIndex)),
      this.db.select({ runId: executorRunEvents.runId, sequence: executorRunEvents.sequence, payload: executorRunEvents.payload, createdAt: executorRunEvents.createdAt })
        .from(executorRunEvents)
        .where(and(inArray(executorRunEvents.runId, foundIds), eq(executorRunEvents.type, 'task.activity')))
        .orderBy(asc(executorRunEvents.sequence)),
      this.runStats(foundIds, runs, 'node_run'),
      this.runTimeline(foundIds, runs),
    ]);
    const statsByNode = stats ? new Map(stats.filter((group) => group.nodeRunId).map((group) => [group.nodeRunId!, group])) : null;
    const runsWithUnattributedTraffic = new Set((stats ?? []).filter((group) => !group.nodeRunId && group.teamRunId).map((group) => group.teamRunId!));
    const activities = activitiesByAttempt(activityRows);
    const requestsByNode = timelineByNode(timeline);
    const nowMs = Date.now();
    const order = new Map(ids.map((id, index) => [id, index]));
    return {
      runs: [...runs].sort((a, b) => order.get(a.id)! - order.get(b.id)!).map((run) => ({
        runId: run.id,
        nodes: buildRunNodes(run.id, run.snapshot, attempts.filter((attempt) => attempt.runId === run.id), activities, { statsByNode, runsWithUnattributedTraffic, timeline, requestsByNode }, nowMs),
      })),
      requestLogRetentionHours: timeline?.retentionHours ?? REQUEST_LOG_RETENTION_HOURS,
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
