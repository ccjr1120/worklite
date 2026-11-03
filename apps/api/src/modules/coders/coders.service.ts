import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { CODER_ACTIVE_RUN_STATUSES } from '@worklite/contracts';
import type {
  AgentTeamRunListPage,
  AgentTeamRunStatusCount,
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
  RecoverAgentTeamOperationRequest,
  UpdateAgentTeamRequest,
} from '@worklite/contracts';
import {
  coders,
  coderRuns,
  coderRunEvents,
  coderTaskAttempts,
  coderOperations,
  coderVersions,
  type AgentTeam,
  type Database,
  type StoredAgentTeamVersionSnapshot,
} from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { AgentTeamRuntimeService } from './coder-runtime.service';
import { AgentTeamConfigurationService, coderRevision } from './coder-configuration.service';
import { capturedCoderName } from './coder-run-summary';
import { RETIRED_AGENT_TEAM_IDS } from './coder-configuration';
import { PortkeyGatewayService } from '../model-providers/portkey-gateway.service';
import { activitiesByAttempt, buildRunNodes, currentRunNode, durationBetween, isRunInProgress, operationActivities, runTotalFromNodeStats, runTotalTokens, timelineByNode, unavailableTokens, type ActivityRow, type AttemptRow } from './coder-run-nodes';

const RUN_NODE_BATCH_LIMIT = 50;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_LOG_RETENTION_HOURS = 12;

/**
 * A Run's captured snapshot without its process files. The files are the bulk of every
 * snapshot (megabytes each) and list and node views never read them, so they are dropped
 * in SQLite instead of being transferred and parsed for each Run on every poll.
 */
function runListSnapshot() {
  return sql<StoredAgentTeamVersionSnapshot>`json_remove(${coderVersions.snapshot}, '$.processFiles')`
    .mapWith((value: string) => ({ ...JSON.parse(value), processFiles: [] }) as StoredAgentTeamVersionSnapshot);
}

function jsonExtractVersion() {
  return sql<number>`json_extract(${coderVersions.snapshot}, '$.orchestrationVersion')`;
}

@Injectable()
export class CodersService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly runtime: AgentTeamRuntimeService,
    private readonly configuration: AgentTeamConfigurationService,
    // Token figures are read-only Gateway evidence; without the Gateway they are reported unavailable.
    @Optional() private readonly gateway?: PortkeyGatewayService,
  ) {}

  private readonly logger = new Logger(CodersService.name);

  async get(request: Request, workspaceSlug: string, coderId: string): Promise<AgentTeamView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const team = await this.configuration.getTeam(workspace.id, coderId);
    if (team.deletedAt) throw new NotFoundException('This Coder has been deleted.');
    return toTeamView(team);
  }

  async list(request: Request, workspaceSlug: string): Promise<AgentTeamView[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.configuration.reconcileSkills(workspace.id);
    const rows = await this.db.select().from(coders)
      .where(and(
        eq(coders.workspaceId, workspace.id),
        isNull(coders.deletedAt),
        notInArray(coders.id, [...RETIRED_AGENT_TEAM_IDS]),
      )).orderBy(asc(coders.name));
    return rows.map(toTeamView);
  }

  async create(request: Request, workspaceSlug: string, input: CreateAgentTeamRequest): Promise<AgentTeamView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return toTeamView(await this.configuration.create(workspace.id, input));
  }

  async update(
    request: Request,
    workspaceSlug: string,
    coderId: string,
    input: UpdateAgentTeamRequest,
  ): Promise<AgentTeamView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return toTeamView(await this.configuration.update(workspace.id, coderId, input));
  }

  async createRole(request: Request, workspaceSlug: string, coderId: string, input: Omit<AgentTeamRoleConfiguration, 'role'>): Promise<AgentTeamView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return toTeamView(await this.configuration.createRole(workspace.id, coderId, input));
  }

  async updateRole(request: Request, workspaceSlug: string, coderId: string, roleId: string, input: Partial<Omit<AgentTeamRoleConfiguration, 'role'>>): Promise<AgentTeamView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return toTeamView(await this.configuration.updateRole(workspace.id, coderId, roleId, input));
  }

  async deleteRole(request: Request, workspaceSlug: string, coderId: string, roleId: string): Promise<AgentTeamView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return toTeamView(await this.configuration.deleteRole(workspace.id, coderId, roleId));
  }

  async records(request: Request, workspaceSlug: string, coderId: string): Promise<AgentTeamRunSummary[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.configuration.getTeam(workspace.id, coderId);
    const rows = await this.db.select({ id: coderRuns.id, intent: coderRuns.intent,
      projectDirectory: coderRuns.projectDirectory,
      orchestrationVersion: sql<12>`json_extract(${coderVersions.snapshot}, '$.orchestrationVersion')`,
      status: coderRuns.status, createdAt: coderRuns.createdAt, finishedAt: coderRuns.finishedAt,
    }).from(coderRuns).innerJoin(coderVersions, eq(coderVersions.id, coderRuns.coderVersionId))
      .where(and(
        eq(coderRuns.coderId, coderId),
        eq(coderRuns.workspaceId, workspace.id),
        sql`${jsonExtractVersion()} = 12`,
      ))
      .orderBy(desc(coderRuns.createdAt));
    return rows.map(({ orchestrationVersion, ...row }) => ({
      ...row,
      orchestrationVersion,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    }));
  }

  /** Queued and active Run counts for every Coder in one grouped read. */
  async statusCounts(request: Request, workspaceSlug: string): Promise<AgentTeamRunStatusCount[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const rows = await this.db.select({ coderId: coderRuns.coderId, status: coderRuns.status, count: sql<number>`count(*)` })
      .from(coderRuns)
      .where(and(eq(coderRuns.workspaceId, workspace.id), inArray(coderRuns.status, ['queued', ...CODER_ACTIVE_RUN_STATUSES])))
      .groupBy(coderRuns.coderId, coderRuns.status);
    return rows.map((row) => ({ coderId: row.coderId, status: row.status, count: Number(row.count) }));
  }

  async listRuns(
    request: Request,
    workspaceSlug: string,
    coderIds: string[],
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<AgentTeamRunListPage> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const pageLimit = Math.min(Math.max(Number.isFinite(limit) ? Math.floor(limit!) : 50, 1), 200);
    const cursorValue = cursor ? parseRunListCursor(cursor) : null;
    const conditions = [eq(coderRuns.workspaceId, workspace.id), sql`${jsonExtractVersion()} = 12`];

    if (coderIds.length > 0) {
      conditions.push(inArray(coderRuns.coderId, coderIds));
    }
    if (cursorValue) {
      conditions.push(or(
        lt(coderRuns.createdAt, cursorValue.createdAt),
        and(
          eq(coderRuns.createdAt, cursorValue.createdAt),
          lt(coderRuns.id, cursorValue.id),
        ),
      )!);
    }

    const rows = await this.db.select({
      id: coderRuns.id,
      intent: coderRuns.intent,
      projectDirectory: coderRuns.projectDirectory,
      status: coderRuns.status,
      createdAt: coderRuns.createdAt,
      finishedAt: coderRuns.finishedAt,
      coderId: coderRuns.coderId,
      snapshot: runListSnapshot(),
      total: sql<number>`count(*) over()`,
    }).from(coderRuns)
      .innerJoin(coders, eq(coders.id, coderRuns.coderId))
      .innerJoin(coderVersions, eq(coderVersions.id, coderRuns.coderVersionId))
      .where(and(...conditions))
      .orderBy(desc(coderRuns.createdAt), desc(coderRuns.id))
      .limit(pageLimit + 1);

    const pageRows = rows.slice(0, pageLimit);
    const last = pageRows.at(-1);
    const overviews = await this.runOverviews(pageRows);
    return {
      items: pageRows.map(({ snapshot, total: _total, ...row }) => ({
        ...row,
        coderName: capturedCoderName(snapshot),
        overview: overviews.get(row.id)!,
        orchestrationVersion: snapshot.orchestrationVersion,
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
        this.db.select().from(coderTaskAttempts)
          .where(inArray(coderTaskAttempts.runId, activeIds))
          .orderBy(asc(coderTaskAttempts.createdAt), asc(coderTaskAttempts.attemptIndex)),
        this.db.select({ runId: coderRunEvents.runId, sequence: coderRunEvents.sequence, payload: coderRunEvents.payload, createdAt: coderRunEvents.createdAt })
          .from(coderRunEvents)
          .where(and(inArray(coderRunEvents.runId, activeIds), eq(coderRunEvents.type, 'task.activity')))
          .orderBy(asc(coderRunEvents.sequence)),
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
  async runNodes(request: Request, workspaceSlug: string, runIds: string[], coderIds: string[]): Promise<AgentTeamRunNodeTree> {
    const ids = [...new Set(runIds.map((id) => id.trim()).filter(Boolean))];
    if (!ids.length) throw new BadRequestException('runIds is required.');
    if (ids.length > RUN_NODE_BATCH_LIMIT) throw new BadRequestException(`At most ${RUN_NODE_BATCH_LIMIT} runIds are accepted.`);
    const invalid = ids.find((id) => !RUN_ID_PATTERN.test(id));
    if (invalid) throw new BadRequestException(`Invalid Coder run id ${invalid}.`);
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const conditions = [eq(coderRuns.workspaceId, workspace.id), inArray(coderRuns.id, ids)];
    if (coderIds.length) conditions.push(inArray(coderRuns.coderId, coderIds));
    const runs = await this.db.select({ id: coderRuns.id, createdAt: coderRuns.createdAt, snapshot: runListSnapshot() })
      .from(coderRuns)
      .innerJoin(coderVersions, eq(coderVersions.id, coderRuns.coderVersionId))
      .where(and(...conditions));
    if (!runs.length) return { runs: [], requestLogRetentionHours: REQUEST_LOG_RETENTION_HOURS };
    const foundIds = runs.map((run) => run.id);
    const [attempts, activityRows, operations, stats, timeline] = await Promise.all([
      this.db.select().from(coderTaskAttempts)
        .where(inArray(coderTaskAttempts.runId, foundIds))
        .orderBy(asc(coderTaskAttempts.createdAt), asc(coderTaskAttempts.attemptIndex)),
      this.db.select({ runId: coderRunEvents.runId, sequence: coderRunEvents.sequence, payload: coderRunEvents.payload, createdAt: coderRunEvents.createdAt })
        .from(coderRunEvents)
        .where(and(inArray(coderRunEvents.runId, foundIds), eq(coderRunEvents.type, 'task.activity')))
        .orderBy(asc(coderRunEvents.sequence)),
      this.db.select({ key: coderOperations.key, runId: coderOperations.runId, taskAttemptId: coderOperations.taskAttemptId, toolName: coderOperations.toolName, status: coderOperations.status, createdAt: coderOperations.createdAt, updatedAt: coderOperations.updatedAt }).from(coderOperations)
        .where(inArray(coderOperations.runId, foundIds))
        .orderBy(asc(coderOperations.createdAt)),
      this.runStats(foundIds, runs, 'node_run'),
      this.runTimeline(foundIds, runs),
    ]);
    const statsByNode = stats ? new Map(stats.filter((group) => group.nodeRunId).map((group) => [group.nodeRunId!, group])) : null;
    const runsWithUnattributedTraffic = new Set((stats ?? []).filter((group) => !group.nodeRunId && group.teamRunId).map((group) => group.teamRunId!));
    const activities = activitiesByAttempt([...activityRows, ...operationActivities(operations)]);
    const requestsByNode = timelineByNode(timeline);
    const nowMs = Date.now();
    const order = new Map(ids.map((id, index) => [id, index]));
    return {
      runs: [...runs].sort((a, b) => order.get(a.id)! - order.get(b.id)!).map((run) => ({
        runId: run.id,
        nodes: buildRunNodes(run.id, run.snapshot, attempts.filter((attempt) => attempt.runId === run.id), activities, { statsByNode, runsWithUnattributedTraffic, timeline, requestsByNode }, nowMs),
        totalTokens: runTotalFromNodeStats(stats, run.id),
      })),
      requestLogRetentionHours: timeline?.retentionHours ?? REQUEST_LOG_RETENTION_HOURS,
    };
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

  async cancel(request: Request, workspaceSlug: string, runId: string): Promise<AgentTeamRunView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.runtime.getRunView(runId, workspace.id);
    return this.runtime.cancel(runId);
  }

  async delete(request: Request, workspaceSlug: string, coderId: string, confirmTeamId: string): Promise<{ coderId: string; deletedAt: string }> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const result = await this.configuration.deleteTeam(workspace.id, coderId, confirmTeamId);
    return {
      coderId: result.coderId,
      deletedAt: result.deletedAt.toISOString(),
    };
  }

  private async getTeam(coderId: string, workspaceId: string): Promise<AgentTeam> {
    const [team] = await this.db.select().from(coders)
      .where(and(eq(coders.id, coderId), eq(coders.workspaceId, workspaceId)))
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
    throw new BadRequestException('Invalid Coder run cursor.');
  }

  if (!decoded || typeof decoded !== 'object' || !('createdAt' in decoded) || !('id' in decoded)
    || typeof decoded.createdAt !== 'string' || typeof decoded.id !== 'string' || !decoded.id) {
    throw new BadRequestException('Invalid Coder run cursor.');
  }
  const createdAt = new Date(decoded.createdAt);
  if (!Number.isFinite(createdAt.getTime())) throw new BadRequestException('Invalid Coder run cursor.');
  return { createdAt, id: decoded.id };
}

function toTeamView(row: AgentTeam): AgentTeamView {
  return {
    id: row.id,
    name: row.name,
    revision: coderRevision(row),
    description: row.description,
    processId: row.processId,
    processVersion: row.processVersion,
    maxConcurrentRuns: row.maxConcurrentRuns,
    workingPractice: row.workingPractice,
    projectGitPolicy: row.projectGitPolicy,
    roles: row.roles.map((role) => ({
      role: role.role,
      publicModelId: role.publicModelId,
      instructions: role.instructions,
      entryPoints: role.entryPoints,
      skillIds: role.skills.map((skill) => skill.id),
      mcpServerIds: role.mcpServers.map((server) => server.id),
      toolNames: role.toolNames,
      ...(role.displayName ? { displayName: role.displayName } : {}),
      ...(role.executor ? { executor: role.executor } : {}),
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
