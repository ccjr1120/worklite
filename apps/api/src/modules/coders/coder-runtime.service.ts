import { assertRuntimeAdmission, runtimeAdmissionClosed } from '../../infrastructure/runtime-upgrade-state';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { and, asc, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import type {
  AgentTeamCriterionAssessment,
  AgentTeamDocumentView,
  AgentTeamOperationRecoveryDecision,
  AgentTeamOperationView,
  AgentTeamPendingInputView,
  AgentTeamRoleId,
  AgentTeamRunEvent,
  AgentTeamRunEventType,
  AgentTeamRunOutcome,
  AgentTeamRunProgress,
  AgentTeamRunStatus,
  AgentTeamRunView,
  AgentTeamTaskResult as AgentTeamTaskResultView,
  AgentTeamTaskAttemptStatus,
  AgentTeamTaskAttemptView,
  AnswerAgentTeamRunRequest,
  RecoverAgentTeamOperationRequest,
} from '@worklite/contracts';
import {
  coderDocuments,
  coderGroupEvents,
  coderGroupMessages,
  coderGroups,
  coderGroupRepositories,
  coderOperations,
  coderPendingInputs,
  coderRepositories,
  coderRunEvents,
  coderRuns,
  coderTaskAttempts,
  coders,
  coderVersions,
  type AgentTeamRun,
  type AgentTeamOperation,
  type AgentTeamVersion,
  type Database,
  type StoredAgentTeamRoleConfiguration,
  type StoredAgentTeamVersionSnapshot,
} from '@worklite/db';
import {
  Command,
  createSqliteCheckpointer,
  getBmadTeaProcessManifest,
  isInterrupted,
  AgentTeamTaskStoppedError,
  type AgentTeamPendingInputAnswer,
  type AgentTeamProjectInstructionFile,
  readBmadTeaProcessFile,
  type AgentTeamDocument,
  type AgentTeamTaskRequest,
  type AgentTeamTaskResult,
  type AgentTeamGroupRunContext,
} from '@worklite/team-runtime';
import { DATABASE } from '../../infrastructure/database.module';
import {
  AgentInvocationRecoveryRequiredError,
  IsolatedAgentInvocationService,
  type AgentInvocationOperationJournal,
} from '../agents/isolated-agent-invocation.service';
import { ProjectExecutorService } from '../agents/project-executor.service';
import { isGatewayPublicModel } from '../agents/project-executor.types';
import { AgentTeamOperationJournalService } from './coder-operation-journal.service';
import { AgentTeamConfigurationService } from './coder-configuration.service';
import { AgentTeamMemoryToolsService } from './coder-memory-tools.service';
import { TeamMemoryMcpTokenService } from './coder-memory-mcp-token.service';
import { teamMemoryMcpRuntime } from './coder-memory-mcp';
import { buildTeamMemoryIndex } from './coder-memory-ranking';
import {
  CODER_PROCESS_ID,
  CODER_PROCESS_VERSION,
  CODER_ROUTER_ROLE,
  CODER_ROLE_INSTRUCTIONS,
  CODER_ROLE_TOOL_NAMES,
  COMPANY_CODER_ID,
  QUICK_CODER_ID,
  DEFAULT_MAX_CONCURRENT_RUNS,
  DEFAULT_COMPANY_PROJECT_GIT_POLICY,
  DEFAULT_DIRECT_GIT_POLICY,
  DIRECT_IMPLEMENTER_DISPLAY_NAME,
  DIRECT_PLANNER_INSTRUCTIONS,
  agentTeamContractRole,
  type AgentTeamRuntimeRole,
} from './coder-configuration';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { AgentJsonOutputError, normalizePublicModelList } from '@worklite/model-gateway';
import { retryTransientProviderFailure } from './coder-provider-retry';
import { capturedCoderName, deriveRunCurrent, effectiveTaskModel, taskRoleName } from './coder-run-summary';
import { CommandsService } from '../commands/commands.service';
import { createAgentTeamGroupGraph, type AgentTeamGroupGraphInitial, type AgentTeamGroupGraphState } from './coder-router-graph';

const MAX_TOOL_RESULT_CHARS = 100_000;
// Every Planner round resends its whole history, so input cost grows with rounds times context.
// These bounds keep each result small and ask the Planner to converge before the hard stop.
// No context trimming: dropping early messages invalidates the provider's cached prefix.
export const PLANNER_INVOCATION_LIMITS = {
  maxToolRounds: 30,
  budgetReminderAtRound: 18,
  maxToolResultChars: 12_000,
  builtinOutput: { readLines: 300, grepLines: 150 },
} as const;
// All created and executable Coding Team Runs use the current Router graph.
const CURRENT_GROUP_ORCHESTRATION_VERSION = 12;

// Run statuses that hold or wait for one of the team's parallel execution slots.
const SLOT_ACTIVE_STATUSES = ['running', 'waiting_for_input'] as const;
const QUEUED_OR_ACTIVE_STATUSES = ['queued', ...SLOT_ACTIVE_STATUSES] as const;

type Checkpointer = ReturnType<typeof createSqliteCheckpointer>;
type AgentTeamDatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type AgentTeamRunAcceptance = { runId: string; accept: (transaction: AgentTeamDatabaseTransaction, runId: string) => void };
type AgentTeamEventListener = (event: AgentTeamRunEvent) => void;
type AgentTeamGroupRunRequest = {
  coderId: string;
  groupId: string;
  groupMessageId: string;
  targetRole: AgentTeamRuntimeRole;
  repositoryIds: string[];
  intent: string;
  groupContext: NonNullable<AgentTeamRun['groupContext']>;
};
type RawTaskOutput = {
  status?: unknown;
  documents?: unknown;
  unresolvedIssues?: unknown;
  commandIds?: unknown;
  changedFiles?: unknown;
  completedWork?: unknown;
  criterionAssessments?: unknown;
  routerPlan?: unknown;
  pendingInput?: unknown;
  message?: unknown;
  repositoryDirectories?: unknown;
};

// The coderRuns.worktreeBasePath/runBranch and coders.maxConcurrentRuns columns land
// with the packages/db lane; access is bridged until that merge.
type RunWorktreeColumns = { worktreeBasePath?: string | null; runBranch?: string | null };
type TeamConcurrencyColumn = { maxConcurrentRuns?: number | null };

function runWorktreeColumns(run: AgentTeamRun): RunWorktreeColumns {
  return run as AgentTeamRun & RunWorktreeColumns;
}

@Injectable()
export class AgentTeamRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly checkpointer: Checkpointer;
  private readonly executions = new Map<string, Promise<void>>();
  private shuttingDown = false;
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly taskAbortControllers = new Map<string, AbortController>();
  private readonly eventListeners = new Set<AgentTeamEventListener>();
  private readonly transactionEvents = new Map<object, AgentTeamRunEvent[]>();
  private readonly documentDeliveries = new Map<string, Promise<void>>();
  // Serializes queued-Run starts per team so the parallel cap is never oversubscribed.
  private readonly runStarters = new Map<string, Promise<void>>();
  // Claude AskUserQuestion waits parked inside a still-running executor session, keyed by
  // pending input id. Answering resolves the wait so the same SDK session continues.
  private readonly liveQuestions = new Map<string, { runId: string; resolve: (answer: string | undefined) => void }>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly config: ConfigService,
    private readonly invocations: IsolatedAgentInvocationService,
    private readonly executors: ProjectExecutorService,
    private readonly resources: WorkspaceResourcesService,
    private readonly operations: AgentTeamOperationJournalService,
    private readonly teamConfiguration: AgentTeamConfigurationService,
    private readonly memoryTools: AgentTeamMemoryToolsService,
    private readonly memoryTokens: TeamMemoryMcpTokenService,
    private readonly commands: CommandsService,
  ) {
    this.checkpointer = createSqliteCheckpointer(this.checkpointPath());
  }

  async onModuleInit(): Promise<void> {
    await this.initializeBuiltInTeam();
    if (!runtimeAdmissionClosed()) await this.recoverRuns();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.releaseLiveQuestions();
    for (const controller of this.abortControllers.values()) controller.abort();
    await Promise.allSettled([...this.executions.values()]);
    this.checkpointer.db.close();
  }

  async createGroupRun(
    workspaceId: string,
    request: AgentTeamGroupRunRequest,
    acceptance: AgentTeamRunAcceptance,
  ): Promise<AgentTeamRunView> {
    assertRuntimeAdmission();
    const intent = request?.intent?.trim();
    if (!intent) throw new BadRequestException('A group role task needs a message.');
    if (!request.coderId || !request.groupId || !request.groupMessageId || !request.targetRole || request.groupContext.groupId !== request.groupId) {
      throw new BadRequestException('The Coder group context is incomplete.');
    }
    const repositories = request.groupContext.repositories.filter((repository) => request.repositoryIds.includes(repository.id));
    // An empty selection is a valid empty-scope Run: the addressed role identifies the
    // project directory from context or asks the user, and directories bind explicitly.
    if (repositories.length !== new Set(request.repositoryIds).size
      || repositories.some((repository) => !isAbsolute(repository.directory))) {
      throw new BadRequestException('Select repositories that belong to this group task.');
    }
    const [existing] = await this.db.select({ id: coderRuns.id }).from(coderRuns)
      .where(and(eq(coderRuns.id, acceptance.runId), eq(coderRuns.workspaceId, workspaceId))).limit(1);
    if (existing) return this.getRunView(existing.id, workspaceId);
    await this.resources.reconcileWorkspaceSkills(workspaceId);

    const [team] = await this.db.select().from(coders)
      .where(and(eq(coders.id, request.coderId), eq(coders.workspaceId, workspaceId)))
      .limit(1);
    if (!team) throw new NotFoundException('Coder not found.');
    if (team.deletedAt) throw new BadRequestException('This Coder has been deleted and is no longer available for dispatch.');
    if (request.targetRole !== CODER_ROUTER_ROLE || request.groupContext.targetRole !== CODER_ROUTER_ROLE) {
      throw new BadRequestException('New Coding Team Runs must start at Router.');
    }
    const runId = acceptance.runId;
    const versionId = `atver_${randomUUID()}`;
    const snapshot = await this.createVersionSnapshot(team.roles, team.workingPractice, team.projectGitPolicy, team.name);
    const primary = repositories[0];
    const now = new Date();
    await this.transaction((transaction) => {
      const [latest] = transaction.select({ version: coderVersions.version })
        .from(coderVersions).where(eq(coderVersions.coderId, team.id))
        .orderBy(desc(coderVersions.version)).limit(1).all();
      transaction.insert(coderVersions).values({
        id: versionId, workspaceId, coderId: team.id, version: (latest?.version ?? 0) + 1, snapshot,
      }).run();
      transaction.insert(coderRuns).values({
        id: runId,
        workspaceId,
        coderId: team.id,
        coderVersionId: versionId,
        groupId: request.groupId,
        groupMessageId: request.groupMessageId,
        targetRole: request.targetRole,
        repositoryIds: request.repositoryIds,
        groupContext: request.groupContext,
        status: 'queued',
        intent,
        projectDirectory: primary ? resolve(primary.directory) : '',
        projectInstructions: primary?.projectInstructions ?? [],
        scopeRevision: 1,
        langGraphThreadId: `atthread_${runId}`,
        createdAt: now,
        updatedAt: now,
      }).run();
      acceptance.accept(transaction, runId);
      this.appendEvent(transaction, runId, 'run.status', { status: 'queued', groupId: request.groupId });
    });
    await this.maybeStartQueuedRuns(team.id);
    return this.getRunView(runId);
  }

  readGroupProjectInstructions(directory: string): Promise<AgentTeamProjectInstructionFile[]> {
    if (!isAbsolute(directory)) throw new BadRequestException('Repository directories must be absolute paths.');
    return this.readProjectInstructions(resolve(directory));
  }

  private async normalizeBindingDirectories(value: readonly string[] | undefined): Promise<string[]> {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new BadRequestException('Directories must be an array of absolute paths.');
    const directories: string[] = [];
    for (const candidate of value) {
      if (typeof candidate !== 'string' || !isAbsolute(candidate.trim())) {
        throw new BadRequestException('Directories must be absolute paths.');
      }
      const directory = resolve(candidate.trim());
      let info;
      try { info = await stat(directory); } catch { throw new BadRequestException(`Directory does not exist: ${directory}`); }
      if (!info.isDirectory()) throw new BadRequestException(`Path is not a directory: ${directory}`);
      directories.push(directory);
    }
    return [...new Set(directories)];
  }

  // Explicit directory binding: directories named by a user answer or identified by a role
  // register as group repositories under the canonical Coder identity and extend the Run's
  // captured scope in one transaction, with the source recorded as group evidence.
  async bindGroupDirectories(
    runId: string,
    directories: readonly string[],
    source: 'answer' | 'role',
  ): Promise<NonNullable<AgentTeamRun['groupContext']>['repositories']> {
    const run = await this.getRun(runId);
    if (!run.groupId || !run.groupContext) {
      throw new BadRequestException('Only a Coder group Run can bind project directories.');
    }
    const prepared = await this.normalizeBindingDirectories(directories);
    if (!prepared.length) return [];
    const withInstructions = await Promise.all(prepared.map(async (directory) => ({
      directory,
      name: basename(directory) || directory,
      projectInstructions: await this.readGroupProjectInstructions(directory),
    })));
    const bound: NonNullable<AgentTeamRun['groupContext']>['repositories'] = [];
    await this.transaction((transaction) => {
      const [current] = transaction.select().from(coderRuns).where(eq(coderRuns.id, runId)).limit(1).all();
      if (!current?.groupId || !current.groupContext) {
        throw new BadRequestException('Only a Coder group Run can bind project directories.');
      }
      const now = new Date();
      const nextRepositoryIds = [...current.repositoryIds];
      const nextContextRepositories = [...current.groupContext.repositories];
      for (const repository of withInstructions) {
        const [existingGroupRepository] = transaction.select().from(coderGroupRepositories)
          .where(and(eq(coderGroupRepositories.groupId, current.groupId!), eq(coderGroupRepositories.directory, repository.directory)))
          .limit(1).all();
        let entry: NonNullable<AgentTeamRun['groupContext']>['repositories'][number];
        if (existingGroupRepository) {
          entry = {
            id: existingGroupRepository.id,
            memoryRepositoryId: existingGroupRepository.teamRepositoryId,
            name: existingGroupRepository.name,
            directory: existingGroupRepository.directory,
            projectInstructions: repository.projectInstructions,
          };
        } else {
          const [teamRepository] = transaction.select({ id: coderRepositories.id }).from(coderRepositories)
            .where(and(eq(coderRepositories.coderId, current.coderId), eq(coderRepositories.directory, repository.directory)))
            .limit(1).all();
          const teamRepositoryId = teamRepository?.id ?? `atrepo_${createHash('sha256').update(`${current.coderId}:${repository.directory}`).digest('hex')}`;
          if (!teamRepository) transaction.insert(coderRepositories).values({
            id: teamRepositoryId,
            workspaceId: current.workspaceId,
            coderId: current.coderId,
            name: repository.name,
            directory: repository.directory,
            createdAt: now,
            updatedAt: now,
          }).run();
          const groupRepositoryId = `atrepo_${randomUUID()}`;
          transaction.insert(coderGroupRepositories).values({
            id: groupRepositoryId,
            workspaceId: current.workspaceId,
            groupId: current.groupId!,
            teamRepositoryId,
            name: repository.name,
            directory: repository.directory,
            createdAt: now,
          }).run();
          entry = {
            id: groupRepositoryId,
            memoryRepositoryId: teamRepositoryId,
            name: repository.name,
            directory: repository.directory,
            projectInstructions: repository.projectInstructions,
          };
        }
        if (!nextContextRepositories.some((item) => item.id === entry.id)) nextContextRepositories.push(entry);
        if (!nextRepositoryIds.includes(entry.id)) nextRepositoryIds.push(entry.id);
        bound.push(entry);
      }
      transaction.update(coderRuns).set({
        repositoryIds: nextRepositoryIds,
        groupContext: { ...current.groupContext, repositories: nextContextRepositories },
        ...(current.projectDirectory ? {} : { projectDirectory: bound[0]!.directory }),
        updatedAt: now,
      }).where(eq(coderRuns.id, runId)).run();
      this.appendGroupMessage(transaction, {
        workspaceId: current.workspaceId,
        groupId: current.groupId!,
        sender: 'system',
        kind: 'status',
        body: `已将项目目录绑定到本次任务：${withInstructions.map((repository) => repository.directory).join('、')}（${source === 'answer' ? '来自用户回答' : '由角色识别'}）。`,
        runId,
        repositoryIds: bound.map((repository) => repository.id),
      });
      this.appendGroupEvent(transaction, current.groupId!, 'repository.updated', {
        repositories: withInstructions.map(({ directory, name }) => ({ directory, name })),
        source,
        runId,
      });
    });
    return bound;
  }

  private async getTaskDocumentReferences(runId: string, taskKey: string) {
    return this.db.select({ documentId: coderDocuments.id, revision: coderDocuments.revision, title: coderDocuments.title })
      .from(coderDocuments)
      .innerJoin(coderTaskAttempts, eq(coderDocuments.taskAttemptId, coderTaskAttempts.id))
      .where(and(
        eq(coderTaskAttempts.runId, runId),
        eq(coderTaskAttempts.taskKey, taskKey),
        eq(coderTaskAttempts.active, true),
      ))
      .orderBy(asc(coderDocuments.createdAt));
  }

  private async readGroupDocumentForTask(
    groupId: string,
    documentId: string,
    revision: number,
    allowed: readonly { documentId: string; revision: number; title: string }[],
  ): Promise<{ title: string; content: string }> {
    if (!allowed.some((reference) => reference.documentId === documentId && reference.revision === revision)) {
      throw new BadRequestException('The requested Coder document version was not handed to this task.');
    }
    const [document] = await this.db.select().from(coderDocuments)
      .where(and(eq(coderDocuments.id, documentId), eq(coderDocuments.revision, revision))).limit(1);
    if (!document) throw new NotFoundException('The Coder document version was not found.');
    const [sourceRun] = await this.db.select({ groupId: coderRuns.groupId }).from(coderRuns)
      .where(eq(coderRuns.id, document.runId)).limit(1);
    if (sourceRun?.groupId !== groupId) throw new BadRequestException('The Coder document belongs to another task group.');
    return { title: document.title, content: document.content };
  }

  private async getMaxConcurrentRuns(coderId: string): Promise<number> {
    const [team] = await this.db.select().from(coders).where(eq(coders.id, coderId)).limit(1);
    const configured = (team as (typeof team & TeamConcurrencyColumn) | undefined)?.maxConcurrentRuns;
    return typeof configured === 'number' && Number.isInteger(configured) && configured >= 1
      ? configured
      : DEFAULT_MAX_CONCURRENT_RUNS;
  }

  private maybeStartQueuedRuns(coderId: string): Promise<void> {
    const serialized = (this.runStarters.get(coderId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.startQueuedRuns(coderId));
    this.runStarters.set(coderId, serialized);
    void serialized.finally(() => { if (this.runStarters.get(coderId) === serialized) this.runStarters.delete(coderId); });
    return serialized;
  }

  // Starts queued Runs in creation order while a parallel slot is free. A slot is held by a
  // running or waiting Run, or by a queued Run whose execution is already scheduled.
  private async startQueuedRuns(coderId: string): Promise<void> {
    if (this.shuttingDown) return;
    const cap = await this.getMaxConcurrentRuns(coderId);
    for (;;) {
      const activeRows = await this.db.select({ id: coderRuns.id, status: coderRuns.status })
        .from(coderRuns)
        .where(and(
          eq(coderRuns.coderId, coderId),
          inArray(coderRuns.status, [...QUEUED_OR_ACTIVE_STATUSES]),
        ))
        .orderBy(asc(coderRuns.createdAt));
      const occupied = activeRows.filter((row) => row.status !== 'queued' || this.executions.has(row.id)).length;
      if (occupied >= cap) return;
      const next = activeRows.find((row) => row.status === 'queued' && !this.executions.has(row.id));
      if (!next) return;
      const run = await this.getRun(next.id);
      if (run.desiredControlState !== 'none') return;
      const version = await this.getVersion(run);
      if (version.snapshot.orchestrationVersion !== CURRENT_GROUP_ORCHESTRATION_VERSION || !run.groupContext) {
        await this.failStaleAttempts(run.id, 'This Run uses a retired orchestration version and cannot be started.');
        await this.setRunStatus(run.id, 'failed');
        continue;
      }
      await mkdir(this.runOutputDirectory(run.id), { recursive: true });
      // resumeInput picks the fresh graph input or the persisted Router checkpoint.
      this.scheduleExecution(run.id, await this.resumeInput(run));
    }
  }

  async deliverRunDocuments(runId: string, workspaceId?: string): Promise<void> {
    if (workspaceId) await this.getRun(runId, workspaceId);
    await this.deliverDocuments(runId);
  }

  async getRunView(runId: string, workspaceId?: string): Promise<AgentTeamRunView> {
    const run = await this.getRun(runId, workspaceId);
    const [version] = await this.db.select().from(coderVersions)
      .where(eq(coderVersions.id, run.coderVersionId))
      .limit(1);
    if (!version) throw new NotFoundException('The Coder version was not found.');
    const [taskRows, documentRows, pendingRows, operationRows, activityRows] = await Promise.all([
      this.db.select().from(coderTaskAttempts)
        .where(eq(coderTaskAttempts.runId, runId))
        .orderBy(asc(coderTaskAttempts.createdAt), asc(coderTaskAttempts.attemptIndex)),
      this.db.select().from(coderDocuments)
        .where(eq(coderDocuments.runId, runId))
        .orderBy(asc(coderDocuments.createdAt), asc(coderDocuments.key), asc(coderDocuments.revision)),
      this.db.select().from(coderPendingInputs)
        .where(eq(coderPendingInputs.runId, runId))
        .orderBy(asc(coderPendingInputs.createdAt)),
      this.db.select().from(coderOperations)
        .where(eq(coderOperations.runId, runId))
        .orderBy(asc(coderOperations.createdAt), asc(coderOperations.key)),
      this.db.select().from(coderRunEvents)
        .where(and(eq(coderRunEvents.runId, runId), eq(coderRunEvents.type, 'task.activity')))
        .orderBy(asc(coderRunEvents.sequence)),
    ]);
    const progressTextByAttemptId = new Map<string, string>();
    const checklistByAttemptId = new Map<string, Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }>>();
    for (const row of [...activityRows].reverse()) {
      const payload = row.payload as { taskAttemptId?: unknown; text?: unknown } | null;
      if (typeof payload?.taskAttemptId === 'string' && typeof payload.text === 'string' && !checklistByAttemptId.has(payload.taskAttemptId)) {
        const checklist = parseExecutorChecklist(payload.text);
        if (checklist.length) checklistByAttemptId.set(payload.taskAttemptId, checklist);
      }
      if (typeof payload?.taskAttemptId !== 'string' || progressTextByAttemptId.has(payload.taskAttemptId)) continue;
      if (typeof payload.text === 'string' && payload.text.trim()) {
        progressTextByAttemptId.set(payload.taskAttemptId, payload.text);
      }
    }
    const worktree = runWorktreeColumns(run);
    const teamDefaultModel = this.config.get<string>('CODER_DEFAULT_PUBLIC_MODEL_ID') ?? '';
    const tasks = taskRows.map((row) => {
      const task = toTaskAttemptView(row, progressTextByAttemptId.get(row.id) ?? '', {
        roleName: taskRoleName(version.snapshot, row.role),
        model: effectiveTaskModel(version.snapshot, row, teamDefaultModel),
      });
      task.checklist = checklistByAttemptId.get(row.id);
      return task;
    });
    return {
      id: run.id,
      coderId: run.coderId,
      coderName: capturedCoderName(version.snapshot),
      groupId: run.groupId,
      targetRole: run.targetRole,
      repositoryIds: run.repositoryIds,
      teamVersion: {
        id: version.id,
        version: version.version,
        coderName: version.snapshot.coderName,
        createdAt: version.createdAt.toISOString(),
        projectExecutorLaunches: version.snapshot.projectExecutorLaunches,
        orchestrationVersion: version.snapshot.orchestrationVersion,
      },
      status: run.status,
      intent: run.intent,
      projectDirectory: run.projectDirectory,
      // Run worktree evidence: retained on conflict, failure, or interruption so the
      // operator can resolve manually. Surfaced until the contracts lane adds the fields.
      worktreeBasePath: worktree.worktreeBasePath ?? null,
      runBranch: worktree.runBranch ?? null,
      scopeRevision: run.scopeRevision,
      desiredControlState: run.desiredControlState,
      tasks,
      documents: documentRows.map(toDocumentView),
      pendingInputs: pendingRows.map(toPendingInputView),
      operations: operationRows.map(toOperationView),
      activities: activityRows.map((row) => ({ runId: row.runId, sequence: row.sequence, type: row.type, payload: row.payload, createdAt: row.createdAt.toISOString() })),
      progress: deriveRunProgress(run, taskRows),
      current: deriveRunCurrent(tasks),
      outcome: isRunOutcome(run.outcome) ? run.outcome : null,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      // Excess fields bridged until the contracts lane adds worktreeBasePath/runBranch.
    } as AgentTeamRunView;
  }

  async getRunProgress(runId: string): Promise<AgentTeamRunProgress | null> {
    const [run] = await this.db.select().from(coderRuns).where(eq(coderRuns.id, runId)).limit(1);
    if (!run) return null;
    const taskRows = await this.db.select().from(coderTaskAttempts)
      .where(eq(coderTaskAttempts.runId, runId))
      .orderBy(asc(coderTaskAttempts.createdAt), asc(coderTaskAttempts.attemptIndex));
    return deriveRunProgress(run, taskRows);
  }

  async getRunEvents(runId: string, workspaceId?: string, afterSequence = 0): Promise<AgentTeamRunEvent[]> {
    await this.getRun(runId, workspaceId);
    const rows = await this.db.select().from(coderRunEvents)
      .where(and(
        eq(coderRunEvents.runId, runId),
        gt(coderRunEvents.sequence, afterSequence),
      ))
      .orderBy(asc(coderRunEvents.sequence));
    return rows.map((row) => ({
      runId: row.runId,
      sequence: row.sequence,
      type: row.type,
      payload: row.payload,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  subscribe(listener: AgentTeamEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async answer(runId: string, request: AnswerAgentTeamRunRequest): Promise<AgentTeamRunView> {
    await this.assertRouterRun(runId);
    const run = await this.getRun(runId);
    if (run.status !== 'waiting_for_input') throw new BadRequestException('The Coder run is not waiting for input.');
    if (request?.pendingInputId !== request?.pendingInputId?.trim() || !request.pendingInputId) {
      throw new BadRequestException('A pending input id is required.');
    }
    const [pendingInput] = await this.db.select({ kind: coderPendingInputs.kind })
      .from(coderPendingInputs)
      .where(and(
        eq(coderPendingInputs.id, request.pendingInputId),
        eq(coderPendingInputs.runId, runId),
      ))
      .limit(1);
    if (!pendingInput) throw new BadRequestException('The pending input was not found.');
    if (pendingInput.kind === 'operation_recovery') {
      throw new BadRequestException('Operation recovery inputs are resolved through operation recovery.');
    }
    if (typeof request.answer !== 'string' || !request.answer.trim()) {
      throw new BadRequestException('A pending input answer is required.');
    }
    if (request.scopeRevision !== run.scopeRevision) {
      throw new BadRequestException('The pending input scope revision is stale.');
    }
    // Directories carried by an answer are validated before the answer is accepted, so an
    // invalid path rejects the whole answer instead of consuming it.
    const directories = await this.normalizeBindingDirectories(request?.directories);

    // A live Claude question: the graph never interrupted, the executor session is still
    // parked on this answer. Deliver it there instead of resuming a LangGraph interrupt.
    const live = this.liveQuestions.get(request.pendingInputId);
    if (live && live.runId === runId) {
      const now = new Date();
      const answered = await this.transaction((transaction) => {
        const rows = transaction.update(coderPendingInputs).set({ status: 'answered', answer: request.answer, answeredAt: now, updatedAt: now })
          .where(and(
            eq(coderPendingInputs.id, request.pendingInputId),
            eq(coderPendingInputs.runId, runId),
            eq(coderPendingInputs.scopeRevision, run.scopeRevision),
            eq(coderPendingInputs.status, 'pending'),
          )).returning().all();
        if (rows.length === 0) return null;
        transaction.update(coderTaskAttempts).set({ status: 'running', result: null })
          .where(and(eq(coderTaskAttempts.id, rows[0].taskAttemptId), eq(coderTaskAttempts.status, 'waiting_for_input'))).run();
        const remaining = transaction.select({ id: coderPendingInputs.id }).from(coderPendingInputs)
          .where(and(eq(coderPendingInputs.runId, runId), eq(coderPendingInputs.kind, 'question'), eq(coderPendingInputs.status, 'pending')))
          .limit(1).all();
        transaction.update(coderRuns).set({ status: remaining.length > 0 ? 'waiting_for_input' : 'running', updatedAt: now })
          .where(and(eq(coderRuns.id, runId), eq(coderRuns.status, 'waiting_for_input'))).run();
        this.appendEvent(transaction, runId, 'input.answered', { pendingInputId: request.pendingInputId, kind: 'question', answer: request.answer });
        this.appendProgressIfChanged(transaction, runId);
        return true;
      });
      if (!answered) throw new BadRequestException('The pending input is no longer active.');
      this.liveQuestions.delete(request.pendingInputId);
      live.resolve(request.answer);
      return this.getRunView(runId);
    }

    const version = await this.getVersion(run);
    const graph = this.createGraph(run, version);
    const snapshot = await graph.getState({ configurable: { thread_id: run.langGraphThreadId } });
    const resumeInterruptId = snapshot.tasks
      .flatMap((task) => task.interrupts)
      .find((candidate) => (candidate.value as { id?: unknown } | undefined)?.id === request.pendingInputId)?.id;
    if (!resumeInterruptId) throw new BadRequestException('The pending input is no longer active.');

    const now = new Date();
    const answered = await this.transaction((transaction) => {
      const rows = transaction.update(coderPendingInputs).set({
        status: 'answered',
        answer: request.answer,
        answeredAt: now,
        updatedAt: now,
      }).where(and(
        eq(coderPendingInputs.id, request.pendingInputId),
        eq(coderPendingInputs.runId, runId),
        eq(coderPendingInputs.scopeRevision, run.scopeRevision),
        eq(coderPendingInputs.status, 'pending'),
      )).returning().all();
      if (rows.length === 0) return null;
      const remaining = transaction.select({ id: coderPendingInputs.id })
        .from(coderPendingInputs)
        .where(and(
          eq(coderPendingInputs.runId, runId),
          eq(coderPendingInputs.kind, 'question'),
          eq(coderPendingInputs.status, 'pending'),
        ))
        .limit(1)
        .all();
      transaction.update(coderRuns).set({
        status: remaining.length > 0 ? 'waiting_for_input' : 'running',
        desiredControlState: 'none',
        updatedAt: now,
      }).where(and(eq(coderRuns.id, runId), eq(coderRuns.status, 'waiting_for_input'))).run();
      this.appendEvent(transaction, runId, 'input.answered', {
        pendingInputId: request.pendingInputId,
        kind: 'question',
        answer: request.answer,
        ...(directories.length > 0 ? { directories } : {}),
      });
      this.appendProgressIfChanged(transaction, runId);
      return true;
    });
    if (!answered) throw new BadRequestException('The pending input is no longer active.');

    const resume = pendingInputAnswer(request.answer, directories);
    this.scheduleExecution(runId, new Command({
      resume: { [resumeInterruptId]: resume },
    }));
    return this.getRunView(runId);
  }

  async recover(runId: string, request: RecoverAgentTeamOperationRequest): Promise<AgentTeamRunView> {
    await this.assertRouterRun(runId);
    const operationKey = request?.operationKey?.trim();
    if (!operationKey || request.operationKey !== operationKey) {
      throw new BadRequestException('A stable Coder operation key is required.');
    }
    const decision = request?.decision;
    if (decision !== 'adopt_command' && decision !== 'mark_failed' && decision !== 'replay') {
      throw new BadRequestException('A supported operation recovery decision is required.');
    }

    const run = await this.getRun(runId);
    if (run.status !== 'waiting_for_input') {
      throw new BadRequestException('The Coder run is not waiting for operation recovery.');
    }
    const [operation] = await this.db.select().from(coderOperations)
      .where(and(
        eq(coderOperations.key, `${runId}:${operationKey}`),
        eq(coderOperations.runId, runId),
      ))
      .limit(1);
    if (!operation || operation.status !== 'uncertain' || operation.recoveryDecision) {
      throw new BadRequestException('The Coder operation is not awaiting recovery.');
    }
    const [pendingInput] = await this.db.select().from(coderPendingInputs)
      .where(and(
        eq(coderPendingInputs.runId, runId),
        eq(coderPendingInputs.kind, 'operation_recovery'),
        eq(coderPendingInputs.operationKey, operationKey),
        eq(coderPendingInputs.status, 'pending'),
      ))
      .orderBy(desc(coderPendingInputs.createdAt))
      .limit(1);
    if (!pendingInput || pendingInput.taskAttemptId !== operation.taskAttemptId) {
      throw new BadRequestException('The operation recovery input is no longer active.');
    }

    let adoptedResult: unknown;
    if (decision === 'adopt_command') {
      if (!operation.commandId) {
        throw new BadRequestException('The uncertain operation has no linked Command to adopt.');
      }
      const command = await this.commands.get(operation.commandId);
      if (command.status !== 'succeeded' && command.status !== 'failed') {
        throw new BadRequestException('Only a terminal succeeded or failed Command can be adopted.');
      }
      const call = persistedToolCall(operation.result);
      if (!call) {
        throw new BadRequestException('The uncertain operation has no persisted tool call to adopt.');
      }
      const output = await this.commands.output(command.id);
      adoptedResult = {
        call,
        output: {
          type: command.status === 'succeeded' ? 'text' : 'error-text',
          value: boundedToolResult(output, MAX_TOOL_RESULT_CHARS),
        },
        commandId: command.id,
      };
    }

    const replayOperationKey = decision === 'replay'
      ? await this.nextReplayOperationKey(operation)
      : undefined;
    const now = new Date();
    const recoveryDecision: AgentTeamOperationRecoveryDecision = decision === 'adopt_command'
      ? { type: 'adopt_command' }
      : decision === 'mark_failed'
        ? { type: 'mark_failed' }
        : { type: 'replay', replayOperationKey: replayOperationKey! };

    const committed = await this.transaction((transaction) => {
      const updatedRun = transaction.update(coderRuns).set({
        status: decision === 'mark_failed' ? 'failed' : 'running',
        desiredControlState: 'none',
        updatedAt: now,
        finishedAt: decision === 'mark_failed' ? now : null,
      }).where(and(
        eq(coderRuns.id, runId),
        eq(coderRuns.status, 'waiting_for_input'),
      )).returning().all();
      if (updatedRun.length === 0) throw new BadRequestException('The Coder run is no longer waiting for input.');

      const updatedOperation = transaction.update(coderOperations).set({
        ...(decision === 'adopt_command'
          ? { status: 'completed' as const, result: adoptedResult, failureReason: null }
          : {}),
        ...(decision === 'mark_failed'
          ? { status: 'failed' as const, failureReason: operation.failureReason ?? 'The uncertain operation was marked failed.' }
          : {}),
        recoveryDecision,
        recoveryDecidedAt: now,
        updatedAt: now,
      }).where(and(
        eq(coderOperations.key, operation.key),
        eq(coderOperations.status, 'uncertain'),
        isNull(coderOperations.recoveryDecision),
      )).returning().all();
      if (updatedOperation.length === 0) throw new BadRequestException('The Coder operation is no longer awaiting recovery.');

      const answeredInput = transaction.update(coderPendingInputs).set({
        status: 'answered',
        answer: decision,
        answeredAt: now,
        updatedAt: now,
      }).where(and(
        eq(coderPendingInputs.id, pendingInput.id),
        eq(coderPendingInputs.status, 'pending'),
      )).returning().all();
      if (answeredInput.length === 0) throw new BadRequestException('The operation recovery input is no longer active.');

      const supersededAttemptReason = decision === 'adopt_command'
        ? 'The uncertain operation was resolved by adopting its linked Command in a new task attempt.'
        : decision === 'replay'
          ? 'The uncertain operation was explicitly replayed in a new task attempt.'
          : operation.failureReason ?? 'The uncertain operation was marked failed.';
      const updatedAttempt = transaction.update(coderTaskAttempts).set({
        status: 'failed',
        active: false,
        error: supersededAttemptReason,
        finishedAt: now,
      }).where(and(
        eq(coderTaskAttempts.id, operation.taskAttemptId),
        eq(coderTaskAttempts.status, 'waiting_for_recovery'),
      )).returning().all();
      if (updatedAttempt.length === 0) throw new BadRequestException('The operation recovery task attempt is no longer waiting.');

      this.appendEvent(transaction, runId, 'operation.updated', {
        operationKey,
        status: decision === 'adopt_command' ? 'completed' : decision === 'mark_failed' ? 'failed' : 'uncertain',
        recoveryDecision,
      });
      this.appendEvent(transaction, runId, 'input.answered', {
        pendingInputId: pendingInput.id,
        kind: 'operation_recovery',
        decision,
      });
      this.appendEvent(transaction, runId, 'task.failed', {
        taskAttemptId: operation.taskAttemptId,
        taskKey: operation.taskKey,
        error: supersededAttemptReason,
        recoveryDecision: decision,
      });
      this.appendEvent(transaction, runId, 'run.status', {
        status: decision === 'mark_failed' ? 'failed' : 'running',
      });
      return true;
    });
    if (!committed) throw new BadRequestException('The operation recovery decision was not committed.');

    if (decision === 'mark_failed') await this.maybeStartQueuedRuns(run.coderId);
    else this.scheduleExecution(runId, null);
    return this.getRunView(runId);
  }

  upgradeQuiescent(): boolean { return this.executions.size === 0; }

  // Ends every live question wait of a Run with no answer (cancel, shutdown).
  private releaseLiveQuestions(runId?: string): void {
    for (const [id, live] of [...this.liveQuestions]) {
      if (runId !== undefined && live.runId !== runId) continue;
      this.liveQuestions.delete(id);
      live.resolve(undefined);
    }
  }

  async cancel(runId: string): Promise<AgentTeamRunView> {
    const run = await this.getRun(runId);
    if (isTerminalRunStatus(run.status)) return this.getRunView(runId);
    const now = new Date();
    const accepted = await this.transaction((transaction) => {
      const requested = transaction.update(coderRuns).set({
        desiredControlState: 'cancel_requested',
        updatedAt: now,
      }).where(and(
        eq(coderRuns.id, runId),
        ne(coderRuns.status, 'succeeded'),
        ne(coderRuns.status, 'failed'),
        ne(coderRuns.status, 'cancelled'),
      )).returning().all();
      if (requested.length === 0) return false;
      transaction.update(coderPendingInputs).set({ status: 'cancelled', updatedAt: now })
        .where(and(
          eq(coderPendingInputs.runId, runId),
          eq(coderPendingInputs.status, 'pending'),
          ne(coderPendingInputs.kind, 'operation_recovery'),
        )).run();
      this.appendEvent(transaction, runId, 'run.status', { status: 'cancel_requested' });
      return true;
    });
    if (!accepted) return this.getRunView(runId);

    this.releaseLiveQuestions(runId);
    this.abortControllers.get(runId)?.abort();
    if (!this.executions.has(runId) && !(await this.hasPendingOperationRecovery(runId))) {
      await this.failActiveAttempts(runId, 'cancelled', 'The Coder run was cancelled.');
      await this.finishCancelledRun(runId);
    }
    return this.getRunView(runId);
  }

  async stopTaskAttempt(runId: string, taskAttemptId: string): Promise<AgentTeamRunView> {
    await this.assertRouterRun(runId);
    const run = await this.getRun(runId);
    const outcome = await this.transaction((transaction) => {
      const [attempt] = transaction.select().from(coderTaskAttempts)
        .where(and(eq(coderTaskAttempts.id, taskAttemptId), eq(coderTaskAttempts.runId, runId)))
        .limit(1).all();
      if (!attempt) throw new NotFoundException('The selected role task was not found in this Run.');
      if (attempt.status === 'stop_requested' || attempt.status === 'stopped') return 'already_stopping' as const;
      if (attempt.status !== 'running') return 'already_settled' as const;
      const updated = transaction.update(coderTaskAttempts).set({
        status: 'stop_requested',
        error: 'Stop requested from Chat.',
      }).where(and(eq(coderTaskAttempts.id, attempt.id), eq(coderTaskAttempts.status, 'running'))).returning().all();
      if (!updated.length) return 'already_settled' as const;
      this.appendEvent(transaction, runId, 'task.stop_requested', { taskAttemptId, taskKey: attempt.taskKey, role: attempt.role });
      this.appendGroupMessage(transaction, {
        workspaceId: run.workspaceId,
        groupId: run.groupId!,
        sender: 'system',
        kind: 'control',
        body: `已收到停止 ${attempt.role} 任务的请求。`,
        runId,
        taskAttemptId,
      });
      return 'requested' as const;
    });
    if (outcome === 'requested') {
      const controller = this.taskAbortControllers.get(taskAttemptId);
      if (controller) controller.abort(new DOMException('The Coder role task was stopped by Chat.', 'AbortError'));
      else await this.finishStoppedAttempt(runId, taskAttemptId, 'Stopped after its execution process had exited.');
    }
    return this.getRunView(runId);
  }

  async assertRouterRun(runId: string): Promise<void> {
    const run = await this.getRun(runId);
    const version = await this.getVersion(run);
    if (version.snapshot.orchestrationVersion !== CURRENT_GROUP_ORCHESTRATION_VERSION || run.groupContext?.targetRole !== CODER_ROUTER_ROLE) {
      throw new BadRequestException('This operation is available only for v12 Router-coordinated Runs.');
    }
  }

  private async finishStoppedAttempt(runId: string, taskAttemptId: string, reason: string): Promise<void> {
    const now = new Date();
    await this.transaction((transaction) => {
      const [attempt] = transaction.update(coderTaskAttempts).set({
        status: 'stopped',
        error: reason,
        finishedAt: now,
      }).where(and(eq(coderTaskAttempts.id, taskAttemptId), eq(coderTaskAttempts.status, 'stop_requested'))).returning().all();
      if (!attempt) return;
      this.appendEvent(transaction, runId, 'task.stopped', {
        taskAttemptId,
        taskKey: attempt.taskKey,
        role: attempt.role,
        reason,
      });
      const [run] = transaction.select({ workspaceId: coderRuns.workspaceId, groupId: coderRuns.groupId })
        .from(coderRuns).where(eq(coderRuns.id, runId)).limit(1).all();
      if (run?.groupId) this.appendGroupMessage(transaction, {
        workspaceId: run.workspaceId,
        groupId: run.groupId,
        sender: 'system',
        kind: 'status',
        body: `${attempt.role} 任务已停止。`,
        runId,
        taskAttemptId,
      });
      this.appendProgressIfChanged(transaction, runId);
    });
  }

  private async initializeBuiltInTeam(): Promise<void> {
    const [existing] = await this.db.select().from(coders)
      .where(and(eq(coders.id, COMPANY_CODER_ID), eq(coders.workspaceId, 'workspace_personal')))
      .limit(1);
    if (!existing) {
      const roles = (Object.keys(CODER_ROLE_INSTRUCTIONS) as AgentTeamRuntimeRole[])
        .map((role) => defaultRoleConfiguration(role));
      await this.db.insert(coders).values({
        id: COMPANY_CODER_ID,
        workspaceId: 'workspace_personal',
        name: 'CompanyCoder',
        description: 'Built-in BMAD and TEA Coder for company projects and requirements.',
        processId: CODER_PROCESS_ID,
        processVersion: CODER_PROCESS_VERSION,
        roles,
        projectGitPolicy: DEFAULT_COMPANY_PROJECT_GIT_POLICY,
      }).onConflictDoNothing().run();
    }

    const [directTeam] = await this.db.select().from(coders)
      .where(and(eq(coders.id, QUICK_CODER_ID), eq(coders.workspaceId, 'workspace_personal')))
      .limit(1);
    if (!directTeam) {
      // Seed a small role set; Router decides which roles each request needs.
      const roles: StoredAgentTeamRoleConfiguration[] = [
        {
          ...defaultRoleConfiguration('planner'),
          // Its Planner is a single lightweight step, not the BMAD/TEA process;
          // it carries no BMAD entry-point skill content.
          entryPoints: [],
          instructions: DIRECT_PLANNER_INSTRUCTIONS,
        },
        {
          ...defaultRoleConfiguration('implementer'),
          displayName: DIRECT_IMPLEMENTER_DISPLAY_NAME,
          entryPoints: [],
          // Its Implementer runs on an execution engine (see produceOutput), not as a chat-completed role.
          executor: 'claude',
        },
      ];
      await this.db.insert(coders).values({
        id: QUICK_CODER_ID,
        workspaceId: 'workspace_personal',
        name: 'QuickCoder',
        description: 'Built-in Coder with planning and implementation roles coordinated by Router.',
        processId: CODER_PROCESS_ID,
        processVersion: CODER_PROCESS_VERSION,
        roles,
        workingPractice: 'Router coordinates the configured roles for each task. Follow the user and repository instructions.',
        projectGitPolicy: DEFAULT_DIRECT_GIT_POLICY,
      }).onConflictDoNothing().run();
    }
  }

  private async createVersionSnapshot(
    configuredRoles: StoredAgentTeamRoleConfiguration[],
    workingPractice: string,
    projectGitPolicy: string,
    coderName: string,
  ): Promise<StoredAgentTeamVersionSnapshot> {
    const manifest = getBmadTeaProcessManifest();
    const processFiles = await Promise.all(manifest.files.map(async (file) => ({
      path: file.path,
      content: await readBmadTeaProcessFile(file.path),
    })));
    const activeRoles = configuredRoles;
    const rolesForVersion = activeRoles.some((role) => role.role === CODER_ROUTER_ROLE)
      ? activeRoles
      : [...activeRoles, defaultRoleConfiguration(CODER_ROUTER_ROLE)];
    const projectExecutorLaunches = Object.fromEntries(await Promise.all(rolesForVersion.filter((role) => role.executor).map(async (role) => [
        role.role,
        await this.executors.captureLaunch(role.executor!, null),
      ])));
    return {
      processId: CODER_PROCESS_ID,
      processVersion: CODER_PROCESS_VERSION,
      processFiles,
      projectExecutorLaunches,
      orchestrationVersion: CURRENT_GROUP_ORCHESTRATION_VERSION,
      // The Coder name is captured by value so a later rename only affects new Runs.
      coderName,
      workingPractice,
      projectGitPolicy,
      roles: await Promise.all(rolesForVersion.map(async (role) => {
        const entryPointContent = await Promise.all(role.entryPoints.map((path) => readBmadTeaProcessFile(path)));
        const processReferences = processReferencePaths(role.role, manifest);
        return {
          ...role,
          // An empty model on an engine-backed role keeps that executor's own default.
          // Model-based roles use the configured Coder default when no role model is declared.
          publicModelId: normalizePublicModelList(role.publicModelId).length > 0
            ? role.publicModelId
            : (role.executor ? '' : this.config.get<string>('CODER_DEFAULT_PUBLIC_MODEL_ID')?.trim() || ''),
          processReferences,
          instructions: [role.instructions, ...entryPointContent].filter(Boolean).join('\n\n---\n\n'),
        };
      })),
      recipeDefaults: { maxRepairRounds: 2 },
    };
  }

  private async recoverRuns(): Promise<void> {
    await this.failLostLiveQuestions();
    const runs = await this.db.select().from(coderRuns)
      .where(inArray(coderRuns.status, ['queued', 'running']))
      .orderBy(asc(coderRuns.createdAt));
    for (const run of runs) {
      if (run.desiredControlState === 'cancel_requested' && !(await this.findInterruptedOperation(run.id))) {
        await this.failActiveAttempts(run.id, 'cancelled', 'The Coder run was cancelled.');
        await this.finishCancelledRun(run.id);
        continue;
      }
      // Queued Runs start through the cap-aware starter once interrupted running Runs
      // have been reconciled and hold their slots again.
      if (run.status === 'queued') continue;
      if (!this.executions.has(run.id)) await this.reconcileInterruptedRun(run);
    }
    for (const coderId of new Set(runs.map((run) => run.coderId))) {
      await this.maybeStartQueuedRuns(coderId);
    }
  }

  private async resumeInput(run: AgentTeamRun): Promise<AgentTeamGroupGraphState | null> {
    const version = await this.getVersion(run);
    const graph = this.createGraph(run, version);
    const snapshot = await graph.getState({ configurable: { thread_id: run.langGraphThreadId } });
    // A saved Router checkpoint resumes in place. A new Router Run needs a non-null
    // write to schedule the graph's start node.
    const groupState = snapshot.values as AgentTeamGroupGraphState | undefined;
    return isUsableGroupGraphState(groupState, run) ? null : ({} as AgentTeamGroupGraphState);
  }

  private async hasPendingOperationRecovery(runId: string): Promise<boolean> {
    const [pending] = await this.db.select({ id: coderPendingInputs.id })
      .from(coderPendingInputs)
      .where(and(
        eq(coderPendingInputs.runId, runId),
        eq(coderPendingInputs.kind, 'operation_recovery'),
        eq(coderPendingInputs.status, 'pending'),
      ))
      .limit(1);
    return pending !== undefined;
  }

  private async nextReplayOperationKey(operation: AgentTeamOperation): Promise<string> {
    const rows = await this.db.select({ operationKey: coderOperations.operationKey })
      .from(coderOperations)
      .where(and(
        eq(coderOperations.runId, operation.runId),
        eq(coderOperations.taskKey, operation.taskKey),
        eq(coderOperations.toolName, operation.toolName),
        eq(coderOperations.inputFingerprint, operation.inputFingerprint),
      ));
    const prefix = `${operation.toolName}:${operation.inputFingerprint}:replay_`;
    const replayCount = rows
      .map((row) => row.operationKey.startsWith(prefix) ? Number(row.operationKey.slice(prefix.length)) : 0)
      .filter((index) => Number.isInteger(index) && index > 0)
      .reduce((maximum, index) => Math.max(maximum, index), 0);
    return `${prefix}${replayCount + 1}`;
  }

  private async reconcileInterruptedRun(run: AgentTeamRun): Promise<void> {
    const version = await this.getVersion(run);
    if (version.snapshot.orchestrationVersion !== CURRENT_GROUP_ORCHESTRATION_VERSION || !run.groupContext) {
      await this.failStaleAttempts(run.id, 'This Run uses a retired orchestration version and cannot be resumed.');
      await this.setRunStatus(run.id, 'failed');
      await this.maybeStartQueuedRuns(run.coderId);
      return;
    }

    const interruptedOperation = await this.findInterruptedOperation(run.id);
    if (interruptedOperation) {
      await this.exposeOperationRecovery(
        run.id,
        interruptedOperation.key.slice(run.id.length + 1),
        interruptedOperation.failureReason ?? 'The Coder process was interrupted before the operation settled.',
      );
      await this.setRunStatus(run.id, 'waiting_for_input');
      return;
    }

    const graph = this.createGraph(run, version);
    const snapshot = await graph.getState({ configurable: { thread_id: run.langGraphThreadId } });
    const groupState = snapshot.values as AgentTeamGroupGraphState | undefined;
    const validGroupState = isUsableGroupGraphState(groupState, run);
    const interrupted = snapshot.tasks.some((task) => task.interrupts.length > 0);
    const activeAttempts = await this.db.select({ id: coderTaskAttempts.id, status: coderTaskAttempts.status })
      .from(coderTaskAttempts)
      .where(and(eq(coderTaskAttempts.runId, run.id), eq(coderTaskAttempts.active, true), inArray(coderTaskAttempts.status, ['running', 'stop_requested'])));
    if (activeAttempts.length > 0) {
      await this.failStaleAttempts(run.id, 'The Coder process was interrupted while a role task was active. Its partial project changes were preserved and the task was not replayed.');
      for (const attempt of activeAttempts) {
        if (attempt.status === 'stop_requested') await this.finishStoppedAttempt(run.id, attempt.id, 'Stopped after the Coder process was interrupted.');
      }
      if (!validGroupState) {
        await this.setRunStatus(run.id, 'failed');
        await this.maybeStartQueuedRuns(run.coderId);
        return;
      }
      await this.transaction((transaction) => {
        const [current] = transaction.select({ groupId: coderRuns.groupId, workspaceId: coderRuns.workspaceId })
          .from(coderRuns).where(eq(coderRuns.id, run.id)).limit(1).all();
        if (current?.groupId) this.appendGroupMessage(transaction, {
          workspaceId: current.workspaceId,
          groupId: current.groupId,
          sender: 'system',
          kind: 'status',
          body: '服务中断时正在运行的角色任务已记录为失败，未自动重放。Router 将根据已保存的结果继续协调。',
          runId: run.id,
        });
      });
      await this.setRunStatus(run.id, 'running', undefined, 'none');
      this.scheduleExecution(run.id, null);
      return;
    }
    if (interrupted) {
      const resume: Record<string, AgentTeamPendingInputAnswer> = {};
      let unanswered = false;
      for (const interrupt of snapshot.tasks.flatMap((task) => task.interrupts)) {
        const pendingInputId = (interrupt.value as { id?: unknown } | undefined)?.id;
        const answeredInput = validGroupState && typeof pendingInputId === 'string'
          ? await this.findAnsweredInput(run, pendingInputId)
          : undefined;
        if (answeredInput && interrupt.id) resume[interrupt.id] = answeredInput;
        else unanswered = true;
      }
      if (Object.keys(resume).length > 0) {
        await this.setRunStatus(run.id, unanswered ? 'waiting_for_input' : 'running', undefined, 'none');
        this.scheduleExecution(run.id, new Command({ resume }));
        return;
      }
      await this.setRunStatus(run.id, 'waiting_for_input');
      return;
    }
    if (!validGroupState) {
      await this.failStaleAttempts(run.id, 'The Coder checkpoint was missing or empty.');
      await this.setRunStatus(run.id, 'failed');
      await this.maybeStartQueuedRuns(run.coderId);
      return;
    }
    if (snapshot.next.length === 0) await this.finishGroupRunSuccessful(run.id, groupState);
    else {
      await this.setRunStatus(run.id, 'running', undefined, 'none');
      this.scheduleExecution(run.id, null);
    }
  }

  private scheduleExecution(runId: string, input: AgentTeamGroupGraphState | Command | null): void {
    if (this.shuttingDown || this.executions.has(runId)) return;
    const execution = this.executeGraph(runId, input)
      .catch(async (error) => {
        await this.handleGraphFailure(runId, error);
      })
      .finally(() => {
        this.executions.delete(runId);
        this.abortControllers.delete(runId);
      });
    this.executions.set(runId, execution);
    void execution;
  }

  private async executeGraph(runId: string, input: AgentTeamGroupGraphState | Command | null): Promise<void> {
    const run = await this.getRun(runId);
    const version = await this.getVersion(run);
    const graph = this.createGraph(run, version);
    const controller = new AbortController();
    this.abortControllers.set(runId, controller);
    // A partial answer resumes the graph while other Developers still wait: keep the
    // waiting_for_input status instead of forcing a running flicker.
    if (run.status !== 'waiting_for_input') await this.setRunStatus(runId, 'running');
    let sawInterrupt = false;
    try {
      const stream = await graph.stream(input as Parameters<typeof graph.stream>[0], {
        configurable: { thread_id: run.langGraphThreadId },
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        if (isInterrupted(chunk)) {
          sawInterrupt = true;
          continue;
        }
      }
    } finally {
      this.abortControllers.delete(runId);
    }

    if (sawInterrupt) {
      const desiredControlState = await this.getDesiredControlState(runId);
      if (desiredControlState === 'cancel_requested') {
        await this.failActiveAttempts(runId, 'cancelled', 'The Coder run was cancelled.');
        await this.finishCancelledRun(runId);
        return;
      }
      await this.setRunStatus(runId, 'waiting_for_input');
      return;
    }
    const snapshot = await graph.getState({ configurable: { thread_id: run.langGraphThreadId } });
    const completedState = snapshot.values as AgentTeamGroupGraphState;
    await this.deliverDocuments(runId);
    await this.finishGroupRunSuccessful(runId, completedState);
  }

  private createGraph(run: AgentTeamRun, version: AgentTeamVersion) {
    const snapshot = version.snapshot;
    if (snapshot.orchestrationVersion !== CURRENT_GROUP_ORCHESTRATION_VERSION) {
      throw new BadRequestException('This Run uses a retired orchestration version and cannot continue or recover. Start a new Router Run.');
    }
    if (!run.groupContext) throw new BadRequestException('This Router Run has no captured group context. Start a new Run.');
    const initial: AgentTeamGroupGraphInitial = {
      runId: run.id,
      intent: run.intent,
      projectDirectory: run.projectDirectory,
      outputDirectory: this.runOutputDirectory(run.id),
      scopeRevision: run.scopeRevision,
      projectInstructions: run.projectInstructions,
      groupContext: run.groupContext as AgentTeamGroupRunContext,
      orchestrationVersion: CURRENT_GROUP_ORCHESTRATION_VERSION,
      writeCapableRoles: snapshot.roles.filter((role) => role.executor || role.toolNames.includes('write') || role.toolNames.includes('bash')).map((role) => role.role),
    };
    return createAgentTeamGroupGraph({
      executeTask: async (request) => this.executeTask(run.workspaceId, version, request),
      documentReferences: (runId, taskKey) => this.getTaskDocumentReferences(runId, taskKey),
      recoverTaskAttempt: (runId, taskKey) => this.recoverGroupTaskAttempt(runId, taskKey),
      bindGroupDirectories: (runId, directories, source) => this.bindGroupDirectories(runId, directories, source),
    }, this.checkpointer, initial);
  }

  private async executeTask(
    workspaceId: string,
    version: AgentTeamVersion,
    request: AgentTeamTaskRequest,
  ): Promise<AgentTeamTaskResult> {
    const run = await this.getRun(request.runId);
    const { role: taskRole, taskKey } = request.taskDefinition;
    if (version.snapshot.orchestrationVersion !== CURRENT_GROUP_ORCHESTRATION_VERSION || !request.groupContext) {
      throw new BadRequestException('This Run uses a retired orchestration version and cannot execute tasks.');
    }
    const role = version.snapshot.roles.find((item) => item.role === taskRole);
    if (!role) throw new Error(`Coder role ${taskRole} was not captured by this version.`);
    const attempt = await this.prepareTaskAttempt(run, request);
    if (attempt.status === 'completed' || attempt.status === 'waiting_for_input') {
      return attempt.result as AgentTeamTaskResult;
    }
    const taskController = new AbortController();
    this.taskAbortControllers.set(attempt.id, taskController);
    const runController = this.abortControllers.get(request.runId);
    const signal = runController
      ? AbortSignal.any([taskController.signal, runController.signal])
      : taskController.signal;
    try {
    const [attemptState] = await this.db.select({ status: coderTaskAttempts.status }).from(coderTaskAttempts)
      .where(eq(coderTaskAttempts.id, attempt.id)).limit(1);
    if (attemptState?.status === 'stop_requested' || attemptState?.status === 'stopped') throw new AgentTeamTaskStoppedError('The Coder role task was stopped by Chat.');
    const orchestrationVersion = CURRENT_GROUP_ORCHESTRATION_VERSION;
    if (role.executor && !request.projectDirectory.trim()) {
      return this.finishWaitingAttempt(request, workspaceId, attempt.id, {
        status: 'waiting_for_input',
        pendingInput: {
          id: `placeholder_${randomUUID()}`,
          question: '这项开发任务还没有绑定的项目目录。请提供该任务的绝对项目目录；在回答中附带目录会将其注册并绑定到本次任务。',
          scopeRevision: 0,
        },
      });
    }
    const commandIds = new Set<string>();
    // Model calls this attempt has finished. Tools run only after a call finishes, so while it is
    // zero a failed model-loop invocation has had no side effect and can be repeated safely.
    let modelRoundsCompleted = 0;
    const produceOutput = async (correction?: string): Promise<string> => {
      if (role.executor) {
        const execution = version.snapshot.projectExecutorLaunches?.[taskRole];
        if (!execution || !('executor' in execution)) throw new Error(`The Router Run has no captured executor for ${taskRole}.`);
        // A project executor launches one native process; it has no Gateway-level fallback loop, so a
        // declared fallback list here only ever uses its first (primary) candidate.
        const model = normalizePublicModelList(role.publicModelId)[0] ?? (execution.executor === 'codex' ? execution.model : null);
        if (model) await this.executors.requireModel(workspaceId, execution.executor, model);
        const promptAddition = [rolePromptAddition(taskRole, version.snapshot, request), groupRolePromptAddition(version.snapshot, request)].filter(Boolean).join('\n\n') || undefined;
        const references = await Promise.all([
          ...(role.processReferences ?? []).map(async (path) => ({ path, content: await this.readCapturedProcessFile(version, path) })),
          ...(request.fileReferences ?? []).map(async (reference) => ({
            path: `team-documents/${reference.documentId}-v${reference.revision}.md`,
            content: (await this.readGroupDocumentForTask(run.groupId!, reference.documentId, reference.revision, request.fileReferences ?? [])).content,
          })),
        ]);
        const memoryToken = this.memoryTokens.register(this.memoryActorContext(workspaceId, run, request, attempt.id, taskRole));
        try {
          const mcpServers = (await this.resources.workflowMcpRuntimes(workspaceId, role.mcpServers.map((server) => server.id)))
            .map((runtime) => {
              const snapshot = role.mcpServers.find((server) => server.id === runtime.id);
              // An empty captured selection means the server was never configured; the
              // live runtime then carries its auto-discovered tools.
              return snapshot?.allowedToolNames.length ? { ...runtime, name: snapshot.name, allowedTools: snapshot.allowedToolNames } : runtime;
            });
          return await this.executors.execute({
            owner: 'coder',
            workspaceId,
            launch: execution,
            model,
            systemPrompt: taskSystemPrompt(role.instructions, true, promptAddition),
            input: JSON.stringify(taskContext(request, correction)),
            projectDirectory: request.projectDirectory,
            skills: role.skills,
            mcpServers: memoryToken ? [...mcpServers, teamMemoryMcpRuntime(memoryToken)] : mcpServers,
            references,
            signal,
            // The developer role runs in a project executor; it is kept apart from the
            // Coder's model-loop traffic by its own surface rather than merged into it.
            correlation: { surface: 'coder_project_task', coderId: run.coderId, teamRunId: request.runId, teamRole: taskRole, teamTaskAttemptId: attempt.id, nodeRunId: attempt.id, executor: execution.executor },
            onEvent: (activity) => {
              // Claude Agent SDK activities carry no CommandExecution id (no own process record);
              // only Codex activities do.
              if (activity.commandExecutionId) commandIds.add(activity.commandExecutionId);
              this.appendEvent(this.db, request.runId, 'task.activity', {
                taskAttemptId: attempt.id,
                taskKey,
                ...taskAttribution(request),
                ...activity,
                ...(execution.executor === 'claude' && activity.phase === 'claude.session_started' ? { sessionPersisted: true } : {}),
              });
            },
            onTextDelta: (delta) => this.appendEvent(this.db, request.runId, 'task.delta', {
              taskAttemptId: attempt.id,
              taskKey,
              ...taskAttribution(request),
              delta,
            }),
            // Only Claude's AskUserQuestion reads this: the question is persisted and shown like
            // any Coder question, but the executor session stays open and receives the answer.
            onQuestion: (question) => this.waitForLiveAnswer(request, workspaceId, attempt.id, question, signal),
          });
        } finally {
          if (memoryToken) this.memoryTokens.revoke(memoryToken);
        }
      }
      const scopedJournal = this.operations.forAttempt({
        workspaceId,
        runId: request.runId,
        taskAttemptId: attempt.id,
      });
      const operationJournal: AgentInvocationOperationJournal = {
        ...scopedJournal,
        findOperation: async (operationKey) => {
          const record = await scopedJournal.findOperation(operationKey);
          recordCompletedCommand(record, commandIds);
          return record;
        },
        findReplayOperation: async (taskKey, replayOperationKey) => {
          const record = await scopedJournal.findReplayOperation(taskKey, replayOperationKey);
          recordCompletedCommand(record, commandIds);
          return record;
        },
        completeOperation: async (operationKey, result, commandId) => {
          const record = await scopedJournal.completeOperation(operationKey, result, commandId);
          recordCompletedCommand(record, commandIds);
          return record;
        },
      };
      return this.invocations.execute({
        workspaceId,
        publicModelId: role.publicModelId,
        systemPrompt: taskSystemPrompt(role.instructions, false, [taskRole === 'planner' ? 'Every completed Planner response must include a non-empty plan document in documents, with the goal, decisions, steps and validation or findings appropriate to the request. Do not invent implementation work for read-only requests.' : undefined, rolePromptAddition(taskRole, version.snapshot, request), groupRolePromptAddition(version.snapshot, request)].filter(Boolean).join('\n\n') || undefined),
        context: taskContext(request, correction),
        skills: role.skills,
        mcpRuntimes: (await this.resources.workflowMcpRuntimes(workspaceId, role.mcpServers.map((server) => server.id)))
          .map((runtime) => {
            const snapshot = role.mcpServers.find((server) => server.id === runtime.id);
            // An empty captured selection means the server was never configured; the
            // live runtime then carries its auto-discovered tools.
            return snapshot?.allowedToolNames.length
              ? { ...runtime, name: snapshot.name, allowedTools: snapshot.allowedToolNames }
              : runtime;
          }),
        builtinToolNames: [...role.toolNames, 'read_coder_document'],
        managedTools: this.memoryTools.toolDefinitions(),
        executeManagedTool: (call) => this.memoryTools.execute({
          context: this.memoryActorContext(workspaceId, run, request, attempt.id, taskRole),
          taskKey,
          call,
        }),
        role: taskRole,
        projectDirectory: request.projectDirectory,
        processReferencePaths: role.processReferences ?? [],
        readProcessReference: (path) => this.readCapturedProcessFile(version, path),
        readTeamDocument: async (documentId: string, revision: number) => this.readGroupDocumentForTask(
            request.groupContext!.groupId,
            documentId,
            revision,
            request.fileReferences ?? [],
          ),
        signal,
        jsonOutput: true,
        correlation: { surface: 'coder', coderId: run.coderId, teamRunId: request.runId, teamRole: taskRole, teamTaskAttemptId: attempt.id, nodeRunId: attempt.id },
        limits: taskRole === 'planner' ? PLANNER_INVOCATION_LIMITS : { maxToolResultChars: 30_000 },
        operation: { taskKey, journal: operationJournal },
        onModelRound: () => {
          modelRoundsCompleted += 1;
        },
        onTextDelta: (delta) => this.appendEvent(this.db, request.runId, 'task.delta', {
          taskAttemptId: attempt.id,
          taskKey,
          ...taskAttribution(request),
          delta,
        }),
        onSkillScript: (activity) => {
          commandIds.add(activity.commandExecutionId);
        },
        onBuiltinTool: (activity) => {
          commandIds.add(activity.commandExecutionId);
        },
      });
    };

    // Repair malformed output using a tool-free model call, never by restarting the
    // project executor with permission to repeat the original work.
    let correctionOutput: string | undefined;
    let previousOutput = '';
    for (let parseAttempt = 0; ; parseAttempt += 1) {
      try {
        let output: string;
        try {
          output = await retryTransientProviderFailure({
            invoke: () => {
              modelRoundsCompleted = 0;
              if (correctionOutput === undefined) return produceOutput();
              const model = normalizePublicModelList(role.publicModelId)[0];
              if (!isGatewayPublicModel(model)) {
                throw new Error('Cannot repair the Coder result without a configured Gateway model; the original task was not rerun.');
              }
              return this.invocations.execute({
                workspaceId,
                publicModelId: model,
                systemPrompt: 'Repair the provided Coder result into one valid JSON object. Preserve all facts, fields and values; do not invent work or evidence. Return only the JSON object.',
                context: { validationError: correctionOutput, previousReply: previousOutput },
                skills: [],
                mcpRuntimes: [],
                builtinToolNames: [],
                signal,
                jsonOutput: true,
                correlation: { surface: 'coder', coderId: run.coderId, teamRunId: request.runId, teamRole: taskRole, teamTaskAttemptId: attempt.id, nodeRunId: attempt.id },
                onModelRound: () => { modelRoundsCompleted += 1; },
              });
            },
            nothingRan: () => correctionOutput !== undefined || (!role.executor && modelRoundsCompleted === 0),
            signal,
            onRetry: ({ retry, delayMs, reason }) => this.appendEvent(this.db, request.runId, 'task.activity', {
              taskAttemptId: attempt.id,
              taskKey,
              ...taskAttribution(request),
              kind: 'provider_retry',
              message: `模型服务暂时不可用，${Math.round(delayMs / 1000)} 秒后重试（第 ${retry} 次）：${reason}`,
            }),
          });
        } catch (error) {
          // A reply with no JSON at all (for example a Markdown report) earns the same single
          // correction as a reply whose JSON fails validation.
          if (error instanceof AgentJsonOutputError) throw new TaskOutputValidationError('The reply contained no JSON object.', error.output);
          throw error;
        }
        return await this.finishCoderOutput(request, workspaceId, attempt.id, taskKey, output, commandIds, version.snapshot.roles.map((item) => item.role));
      } catch (error) {
        if (!(error instanceof TaskOutputValidationError) || parseAttempt >= 1) throw error;
        if (error.output.length > 100_000) throw error;
        correctionOutput = error.message;
        previousOutput = error.output;
      }
    }
    } catch (error) {
      const [latestAttempt] = await this.db.select({ status: coderTaskAttempts.status }).from(coderTaskAttempts)
        .where(eq(coderTaskAttempts.id, attempt.id)).limit(1);
      if (latestAttempt?.status === 'stop_requested' || latestAttempt?.status === 'stopped') {
        const reason = 'Stopped by Chat.';
        if (latestAttempt.status === 'stop_requested') await this.finishStoppedAttempt(run.id, attempt.id, reason);
        throw new AgentTeamTaskStoppedError(reason);
      }
      throw error;
    } finally {
      this.taskAbortControllers.delete(attempt.id);
    }
  }

  // Server-owned actor binding for one role turn. coderId, runId, attempt and the
  // repository scope never come from model input.
  private memoryActorContext(
    workspaceId: string,
    run: AgentTeamRun,
    request: AgentTeamTaskRequest,
    taskAttemptId: string,
    role: string,
  ) {
    return {
      workspaceId,
      coderId: run.coderId,
      groupId: run.groupId ?? request.groupContext?.groupId ?? null,
      runId: run.id,
      taskAttemptId,
      role,
      sourceMessageId: run.groupMessageId ?? request.groupContext?.initialMessageId ?? null,
      allowedRepositoryIds: request.groupContext?.repositories.map((repository) => repository.memoryRepositoryId) ?? [],
      // The task context shows each group repository's own id; memory is scoped by the Coder
      // repository behind it, so a role that passes the id it can see still lands in scope.
      repositoryIdAliases: Object.fromEntries((request.groupContext?.repositories ?? []).map((repository) => [repository.id, repository.memoryRepositoryId])),
      createdBy: 'role' as const,
    };
  }

  private async finishCoderOutput(
    request: AgentTeamTaskRequest,
    workspaceId: string,
    attemptId: string,
    taskKey: string,
    output: string,
    commandIds: ReadonlySet<string>,
    supportedRoleIds: readonly string[],
  ): Promise<AgentTeamTaskResult> {
    const parsed = parseTaskOutput(output, taskKey, supportedRoleIds);
    if (parsed.status === 'waiting_for_input') {
      return this.finishWaitingAttempt(request, workspaceId, attemptId, parsed);
    }
    if (request.taskDefinition.role === CODER_ROUTER_ROLE && !parsed.routerPlan) {
      throw new TaskOutputValidationError('Router completed without the required routerPlan object.', output);
    }
    if (request.taskDefinition.role === CODER_ROUTER_ROLE && request.groupContext?.continuation) {
      const continuation = request.groupContext.continuation;
      const assignments = parsed.routerPlan?.action === 'dispatch' ? parsed.routerPlan.assignments : [];
      if (assignments.length !== 1 || assignments[0]?.role !== continuation.role) {
        throw new TaskOutputValidationError(`A continuation must dispatch exactly one task to ${continuation.role}.`, output);
      }
    }
    if (request.taskDefinition.role !== CODER_ROUTER_ROLE && parsed.routerPlan) {
      throw new TaskOutputValidationError('A work role cannot choose the next role; return the result to Router.', output);
    }
    if (request.taskDefinition.role === 'planner' && !parsed.documents.some((document) => document.content.trim())) {
      throw new TaskOutputValidationError('Planner must return a non-empty plan document in documents.', output);
    }
    validateUpstreamDocuments(parsed.documents, request.upstream);
    const result: ParsedCompletedTaskResult = {
      ...parsed,
      commandIds: [...commandIds],
    };
    return this.finishCompletedAttempt(request, workspaceId, attemptId, result);
  }

  private async readCapturedProcessFile(version: AgentTeamVersion, path: string): Promise<string> {
    const file = version.snapshot.processFiles.find((candidate) => candidate.path === path);
    if (!file) throw new Error(`Process reference ${path} was not captured by this Coder version.`);
    return file.content;
  }

  private async recoverGroupTaskAttempt(runId: string, taskKey: string): Promise<{
    role: AgentTeamRoleId;
    status: 'completed' | 'failed' | 'stopped' | 'waiting_for_input';
    summary: string;
    fileReferences?: Array<{ documentId: string; revision: number; title: string }>;
    changedFiles?: string[];
    unresolvedIssues?: string[];
    pendingInput?: Extract<AgentTeamTaskResult, { status: 'waiting_for_input' }>['pendingInput'];
  } | null> {
    let [attempt] = await this.db.select().from(coderTaskAttempts)
      .where(and(eq(coderTaskAttempts.runId, runId), eq(coderTaskAttempts.taskKey, taskKey), eq(coderTaskAttempts.active, true)))
      .orderBy(desc(coderTaskAttempts.attemptIndex)).limit(1);
    if (!attempt) return null;
    if (attempt.status === 'running') {
      const reason = 'The Coder process was interrupted while this role task was running. The task was not replayed.';
      const now = new Date();
      await this.transaction((transaction) => {
        const [failed] = transaction.update(coderTaskAttempts).set({ status: 'failed', error: reason, finishedAt: now })
          .where(and(eq(coderTaskAttempts.id, attempt!.id), eq(coderTaskAttempts.status, 'running'))).returning().all();
        if (!failed) return;
        this.appendEvent(transaction, runId, 'task.failed', { taskAttemptId: failed.id, taskKey, error: reason });
        const [run] = transaction.select({ workspaceId: coderRuns.workspaceId, groupId: coderRuns.groupId })
          .from(coderRuns).where(eq(coderRuns.id, runId)).limit(1).all();
        if (run?.groupId) this.appendGroupMessage(transaction, {
          workspaceId: run.workspaceId,
          groupId: run.groupId,
          sender: 'system',
          kind: 'status',
          body: `${failed.role} 任务因服务中断而失败；任务没有自动重放。`,
          runId,
          taskAttemptId: failed.id,
        });
      });
      [attempt] = await this.db.select().from(coderTaskAttempts).where(eq(coderTaskAttempts.id, attempt.id)).limit(1);
    } else if (attempt.status === 'stop_requested') {
      await this.finishStoppedAttempt(runId, attempt.id, 'Stopped after the Coder process was interrupted.');
      [attempt] = await this.db.select().from(coderTaskAttempts).where(eq(coderTaskAttempts.id, attempt.id)).limit(1);
    }
    if (!attempt) return null;
    const result = attempt.result as AgentTeamTaskResult | null;
    const documents = await this.db.select({ id: coderDocuments.id, revision: coderDocuments.revision, title: coderDocuments.title })
      .from(coderDocuments).where(eq(coderDocuments.taskAttemptId, attempt.id)).orderBy(asc(coderDocuments.createdAt));
    const fileReferences = documents.map((document) => ({ documentId: document.id, revision: document.revision, title: document.title }));
    if (attempt.status === 'completed') return {
      role: attempt.role,
      status: 'completed',
      summary: result?.status === 'completed' ? result.message?.trim() || 'Role task completed.' : 'Role task completed.',
      fileReferences,
      changedFiles: result?.status === 'completed' ? [...result.changedFiles] : [],
      unresolvedIssues: result?.status === 'completed' ? [...result.unresolvedIssues] : [],
    };
    if (attempt.status === 'stopped') return { role: attempt.role, status: 'stopped', summary: attempt.error ?? 'Stopped by Chat.' };
    if (attempt.status === 'waiting_for_input' && result?.status === 'waiting_for_input') return {
      role: attempt.role,
      status: 'waiting_for_input',
      summary: result.pendingInput.question,
      pendingInput: result.pendingInput,
    };
    return { role: attempt.role, status: 'failed', summary: attempt.error ?? 'Role task failed.' };
  }

  private async prepareTaskAttempt(
    run: AgentTeamRun,
    request: AgentTeamTaskRequest,
  ): Promise<{ id: string; status: AgentTeamTaskAttemptStatus; result: unknown }> {
    const inputFingerprint = fingerprint(request);
    const { role, taskKey } = request.taskDefinition;
    const [existing] = await this.db.select().from(coderTaskAttempts)
      .where(and(eq(coderTaskAttempts.runId, run.id), eq(coderTaskAttempts.taskKey, taskKey)))
      .orderBy(desc(coderTaskAttempts.attemptIndex))
      .limit(1);
    if (existing?.active && existing.status === 'completed') {
      if (existing.inputFingerprint !== inputFingerprint) {
        throw new Error(`Coder task ${taskKey} produced a result for different input.`);
      }
      return { id: existing.id, status: 'completed', result: existing.result };
    }

    if (existing?.active && existing.status === 'waiting_for_recovery') {
      throw new Error(`Coder task ${taskKey} is waiting for operation recovery.`);
    }

    if (existing?.active && existing.status === 'waiting_for_input' && !request.answer) {
      return { id: existing.id, status: existing.status, result: existing.result };
    }

    const now = new Date();
    if (existing?.active && existing.status === 'waiting_for_input') {
      const resumedInput = { initial: existing.inputRevision, resumedWith: request };
      const [resumed] = await this.db.update(coderTaskAttempts).set({
        status: 'running',
        inputRevision: resumedInput,
        inputFingerprint,
        result: null,
        error: null,
        finishedAt: null,
        startedAt: existing.startedAt ?? now,
      }).where(and(eq(coderTaskAttempts.id, existing.id), eq(coderTaskAttempts.status, 'waiting_for_input')))
        .returning();
      if (resumed) return { id: resumed.id, status: resumed.status, result: resumed.result };
    }
    if (existing?.active && existing.status === 'running') {
      throw new Error(`Coder task ${taskKey} is already running.`);
    }

    const attemptId = `atask_${randomUUID()}`;
    const created = await this.transaction((transaction) => {
      const [attempt] = transaction.insert(coderTaskAttempts).values({
        id: attemptId,
        workspaceId: run.workspaceId,
        runId: run.id,
        taskKey,
        attemptIndex: (existing?.attemptIndex ?? 0) + 1,
        role,
        continuedFromAttemptId: request.groupContext?.continuation?.role === role
          ? request.groupContext.continuation.sourceTaskAttemptId
          : null,
        status: 'running',
        inputRevision: request,
        inputFingerprint,
        assignmentTitle: role === CODER_ROUTER_ROLE ? null : request.taskDefinition.goal,
        startedAt: now,
      }).returning().all();
      if (run.groupId && request.groupContext?.targetRole === CODER_ROUTER_ROLE && role !== CODER_ROUTER_ROLE) {
        this.appendGroupMessage(transaction, {
          workspaceId: run.workspaceId,
          groupId: run.groupId,
          sender: 'role',
          senderRole: CODER_ROUTER_ROLE,
          recipientRole: role,
          kind: 'assignment',
          body: request.taskDefinition.goal,
          runId: run.id,
          taskAttemptId: attemptId,
          repositoryIds: request.groupContext?.repositories.map((repository) => repository.id) ?? run.repositoryIds,
        });
      }
      return attempt!;
    });
    this.appendEvent(this.db, run.id, 'task.started', {
      taskAttemptId: attemptId,
      taskKey: request.taskDefinition.taskKey,
      role: request.taskDefinition.role,
      ...taskAttribution(request),
      attemptIndex: created.attemptIndex,
    });
    await this.appendProgressIfChanged(this.db, run.id);
    return { id: created.id, status: created.status, result: created.result };
  }

  // Persists a live Claude question, moves the Run to waiting_for_input and parks until
  // `answer()` (or cancel/shutdown, which resolve undefined) releases it.
  private async waitForLiveAnswer(
    request: AgentTeamTaskRequest,
    workspaceId: string,
    attemptId: string,
    question: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const waiting = await this.finishWaitingAttempt(request, workspaceId, attemptId, {
      status: 'waiting_for_input',
      pendingInput: { id: '', question, scopeRevision: request.scopeRevision },
    }, true);
    if (waiting.status !== 'waiting_for_input') return undefined;
    const pendingInputId = waiting.pendingInput.id;
    const answer = new Promise<string | undefined>((resolve) => {
      const onAbort = () => { this.liveQuestions.delete(pendingInputId); resolve(undefined); };
      if (signal.aborted) { resolve(undefined); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      this.liveQuestions.set(pendingInputId, {
        runId: request.runId,
        resolve: (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      });
    });
    await this.setRunStatus(request.runId, 'waiting_for_input');
    return answer;
  }

  // API restart: a Claude question waiting on a live executor session lost that session.
  // The Run is failed with the question and activities kept; nothing is replayed.
  private async failLostLiveQuestions(): Promise<void> {
    const attempts = await this.db.select({ id: coderTaskAttempts.id, runId: coderTaskAttempts.runId, result: coderTaskAttempts.result })
      .from(coderTaskAttempts)
      .where(and(eq(coderTaskAttempts.active, true), eq(coderTaskAttempts.status, 'waiting_for_input')));
    const runIds = new Set(attempts
      .filter((attempt) => (attempt.result as { liveSession?: unknown } | null)?.liveSession === true)
      .map((attempt) => attempt.runId));
    const reason = 'API 已重启，等待回答的 Claude 会话已中断且未重放；请先检查仓库实际状态，再选择重试或重新执行。';
    for (const runId of runIds) {
      const run = await this.getRun(runId);
      if (isTerminalRunStatus(run.status)) continue;
      await this.db.update(coderPendingInputs).set({ status: 'cancelled', updatedAt: new Date() })
        .where(and(eq(coderPendingInputs.runId, runId), eq(coderPendingInputs.status, 'pending'), eq(coderPendingInputs.kind, 'question')));
      await this.failActiveAttempts(runId, 'failed', reason);
      if (run.groupId) {
        const groupId = run.groupId;
        await this.transaction((transaction) => {
          this.appendGroupMessage(transaction, { workspaceId: run.workspaceId, groupId, sender: 'system', kind: 'status', body: reason, runId });
        });
      }
      await this.setRunStatus(runId, 'failed');
      await this.maybeStartQueuedRuns(run.coderId);
    }
  }

  private async finishWaitingAttempt(
    request: AgentTeamTaskRequest,
    workspaceId: string,
    attemptId: string,
    result: Extract<AgentTeamTaskResult, { status: 'waiting_for_input' }>,
    // A live Claude question keeps the attempt's executor session open: the attempt is not
    // finished, and `liveSession` marks it so a restart can tell it was in-process state.
    live = false,
  ): Promise<AgentTeamTaskResult> {
    const now = new Date();
    const pendingInputId = `atinput_${randomUUID()}`;
    const persistedResult: Extract<AgentTeamTaskResult, { status: 'waiting_for_input' }> = {
      status: 'waiting_for_input',
      pendingInput: {
        id: pendingInputId,
        question: result.pendingInput.question,
        scopeRevision: request.scopeRevision,
      },
    };
    await this.transaction((transaction) => {
      const [desired] = transaction.select({ desiredControlState: coderRuns.desiredControlState })
        .from(coderRuns)
        .where(eq(coderRuns.id, request.runId))
        .limit(1).all();
      if (desired?.desiredControlState === 'cancel_requested') {
        throw new DOMException('The Coder run was cancelled.', 'AbortError');
      }
      const updated = transaction.update(coderTaskAttempts).set({
        status: 'waiting_for_input',
        result: live ? { ...persistedResult, liveSession: true } : persistedResult,
        ...(live ? {} : { finishedAt: now }),
      }).where(and(
        eq(coderTaskAttempts.id, attemptId),
        eq(coderTaskAttempts.status, 'running'),
      )).returning().all();
      if (updated.length === 0) throw new Error('The Coder task attempt is no longer running.');
      transaction.insert(coderPendingInputs).values({
        id: pendingInputId,
        workspaceId,
        runId: request.runId,
        taskAttemptId: attemptId,
        kind: 'question',
        question: persistedResult.pendingInput.question,
        scopeRevision: request.scopeRevision,
        status: 'pending',
      }).run();
      this.appendEvent(transaction, request.runId, 'task.waiting', {
        taskAttemptId: attemptId,
        taskKey: request.taskDefinition.taskKey,
        ...taskAttribution(request),
        pendingInputId,
        kind: 'question',
      });
      this.appendEvent(transaction, request.runId, 'input.requested', {
        pendingInputId,
        kind: 'question',
        question: persistedResult.pendingInput.question,
        scopeRevision: request.scopeRevision,
        taskKey: request.taskDefinition.taskKey,
        ...taskAttribution(request),
      });
      const [run] = transaction.select({ groupId: coderRuns.groupId, repositoryIds: coderRuns.repositoryIds })
        .from(coderRuns).where(eq(coderRuns.id, request.runId)).limit(1).all();
      if (run?.groupId) {
        this.appendGroupMessage(transaction, {
          workspaceId,
          groupId: run.groupId,
          sender: 'role',
          senderRole: request.taskDefinition.role,
          recipientRole: request.groupContext?.targetRole === CODER_ROUTER_ROLE && request.taskDefinition.role !== CODER_ROUTER_ROLE ? CODER_ROUTER_ROLE : undefined,
          kind: 'question',
          body: result.pendingInput.question,
          runId: request.runId,
          taskAttemptId: attemptId,
          repositoryIds: request.groupContext?.repositories.map((repository) => repository.id) ?? run.repositoryIds,
        });
      }
      this.appendProgressIfChanged(transaction, request.runId);
    });
    return Promise.resolve(persistedResult);
  }

  private async finishCompletedAttempt(
    request: AgentTeamTaskRequest,
    workspaceId: string,
    attemptId: string,
    result: Extract<AgentTeamTaskResult, { status: 'completed' }>,
  ): Promise<AgentTeamTaskResult> {
    const { taskKey } = request.taskDefinition;
    const now = new Date();
    await this.transaction((transaction) => {
      const [desired] = transaction.select({ desiredControlState: coderRuns.desiredControlState })
        .from(coderRuns)
        .where(eq(coderRuns.id, request.runId))
        .limit(1).all();
      if (desired?.desiredControlState === 'cancel_requested') {
        throw new DOMException('The Coder run was cancelled.', 'AbortError');
      }
      const updated = transaction.update(coderTaskAttempts).set({
        status: 'completed',
        result,
        error: null,
        finishedAt: now,
      }).where(and(
        eq(coderTaskAttempts.id, attemptId),
        eq(coderTaskAttempts.status, 'running'),
      )).returning().all();
      if (updated.length === 0) throw new Error('The Coder task attempt is no longer running.');
      const fileReferences: Array<{ documentId: string; revision: number; title: string }> = [];
      for (const document of result.documents) {
        const [latest] = transaction.select({ revision: coderDocuments.revision })
          .from(coderDocuments)
          .where(and(eq(coderDocuments.runId, request.runId), eq(coderDocuments.key, document.key)))
          .orderBy(desc(coderDocuments.revision))
          .limit(1).all();
        const revision = (latest?.revision ?? 0) + 1;
        const documentId = `atdoc_${randomUUID()}`;
        transaction.insert(coderDocuments).values({
          id: documentId,
          workspaceId,
          runId: request.runId,
          taskAttemptId: attemptId,
          key: document.key,
          revision,
          title: document.title,
          content: document.content,
          upstreamDocumentKeys: document.upstreamDocumentKeys,
        }).run();
        fileReferences.push({ documentId, revision, title: document.title });
        this.appendEvent(transaction, request.runId, 'document.committed', {
          taskAttemptId: attemptId,
          taskKey,
          documentKey: document.key,
          revision,
        });
      }
      this.appendEvent(transaction, request.runId, 'task.completed', {
        taskAttemptId: attemptId,
        taskKey,
        ...taskAttribution(request),
        result,
      });
      const [run] = transaction.select({ groupId: coderRuns.groupId, repositoryIds: coderRuns.repositoryIds, workspaceId: coderRuns.workspaceId })
        .from(coderRuns).where(eq(coderRuns.id, request.runId)).limit(1).all();
      if (run?.groupId) {
        const body = result.message?.trim()
          || (result.documents.length > 0 ? `已提交文件：${result.documents.map((document) => document.title).join('、')}` : '任务已完成。');
        this.appendGroupMessage(transaction, {
          workspaceId: run.workspaceId,
          groupId: run.groupId,
          sender: 'role',
          senderRole: request.taskDefinition.role,
          recipientRole: request.taskDefinition.role === CODER_ROUTER_ROLE ? undefined : CODER_ROUTER_ROLE,
          kind: request.taskDefinition.role === CODER_ROUTER_ROLE ? 'text' : 'result',
          body,
          runId: request.runId,
          taskAttemptId: attemptId,
          repositoryIds: request.groupContext?.repositories.map((repository) => repository.id) ?? run.repositoryIds,
          fileReferences,
        });
      }
      this.appendProgressIfChanged(transaction, request.runId);
    });
    await this.deliverDocuments(request.runId);
    return result;
  }

  private async findAnsweredInput(
    run: AgentTeamRun,
    pendingInputId: string,
  ): Promise<AgentTeamPendingInputAnswer | undefined> {
    const [row] = await this.db.select({ answer: coderPendingInputs.answer })
      .from(coderPendingInputs)
      .where(and(
        eq(coderPendingInputs.id, pendingInputId),
        eq(coderPendingInputs.runId, run.id),
        eq(coderPendingInputs.status, 'answered'),
      ))
      .limit(1);
    return row?.answer === undefined || row.answer === null
      ? undefined
      : pendingInputAnswer(row.answer);
  }

  private async getDesiredControlState(
    runId: string,
  ): Promise<AgentTeamRunView['desiredControlState'] | undefined> {
    const [row] = await this.db.select({ desiredControlState: coderRuns.desiredControlState })
      .from(coderRuns)
      .where(eq(coderRuns.id, runId))
      .limit(1);
    return row?.desiredControlState;
  }

  private async findInterruptedOperation(runId: string): Promise<AgentTeamOperation | undefined> {
    const rows = await this.db.select({ operation: coderOperations })
      .from(coderOperations)
      .innerJoin(coderTaskAttempts, eq(coderOperations.taskAttemptId, coderTaskAttempts.id))
      .where(and(
        eq(coderOperations.runId, runId),
        inArray(coderOperations.status, ['reserved', 'uncertain']),
        isNull(coderOperations.recoveryDecision),
        eq(coderTaskAttempts.active, true),
        inArray(coderTaskAttempts.status, ['running', 'waiting_for_recovery']),
      ))
      .orderBy(desc(coderOperations.createdAt))
      .limit(1);
    return rows[0]?.operation;
  }

  private async exposeOperationRecovery(
    runId: string,
    operationKey: string,
    reason: string,
  ): Promise<boolean> {
    const [operation] = await this.db.select().from(coderOperations)
      .where(and(
        eq(coderOperations.key, `${runId}:${operationKey}`),
        eq(coderOperations.runId, runId),
      ))
      .limit(1);
    if (!operation || operation.recoveryDecision || operation.status === 'completed' || operation.status === 'failed') {
      return false;
    }
    const [existingInput] = await this.db.select().from(coderPendingInputs)
      .where(and(
        eq(coderPendingInputs.runId, runId),
        eq(coderPendingInputs.kind, 'operation_recovery'),
        eq(coderPendingInputs.operationKey, operationKey),
      ))
      .orderBy(desc(coderPendingInputs.createdAt))
      .limit(1);
    if (existingInput?.status !== 'pending' && existingInput) return false;

    const now = new Date();
    const pendingInputId = existingInput?.id ?? `atinput_${randomUUID()}`;
    const question = `Operation ${operationKey} has an uncertain effect. Choose adopt_command, mark_failed, or replay.`;
    return this.transaction((transaction) => {
      const updatedRun = transaction.update(coderRuns).set({
        status: 'waiting_for_input',
        updatedAt: now,
      }).where(and(
        eq(coderRuns.id, runId),
        eq(coderRuns.status, 'running'),
      )).returning().all();
      if (updatedRun.length === 0) throw new Error('The Coder run is no longer running.');

      const updatedOperation = transaction.update(coderOperations).set({
        status: 'uncertain',
        failureReason: reason,
        updatedAt: now,
      }).where(and(
        eq(coderOperations.key, operation.key),
        isNull(coderOperations.recoveryDecision),
      )).returning().all();
      if (updatedOperation.length === 0) throw new Error('The Coder operation was already recovered.');

      const updatedAttempt = transaction.update(coderTaskAttempts).set({
        status: 'waiting_for_recovery',
        finishedAt: now,
      }).where(and(
        eq(coderTaskAttempts.id, operation.taskAttemptId),
        inArray(coderTaskAttempts.status, ['running', 'waiting_for_recovery']),
      )).returning().all();
      if (updatedAttempt.length === 0) throw new Error('The Coder task attempt is no longer active.');

      if (!existingInput) {
        transaction.insert(coderPendingInputs).values({
          id: pendingInputId,
          workspaceId: operation.workspaceId,
          runId,
          taskAttemptId: operation.taskAttemptId,
          kind: 'operation_recovery',
          question,
          operationKey,
          scopeRevision: updatedRun[0].scopeRevision,
          status: 'pending',
        }).run();
      }

      this.appendEvent(transaction, runId, 'operation.updated', {
        operationKey,
        status: 'uncertain',
      });
      this.appendEvent(transaction, runId, 'task.waiting', {
        taskAttemptId: operation.taskAttemptId,
        taskKey: operation.taskKey,
        pendingInputId,
        kind: 'operation_recovery',
        operationKey,
      });
      this.appendEvent(transaction, runId, 'input.requested', {
        pendingInputId,
        kind: 'operation_recovery',
        question,
        operationKey,
        scopeRevision: updatedRun[0].scopeRevision,
      });
      this.appendEvent(transaction, runId, 'run.status', { status: 'waiting_for_input' });
      return true;
    });
  }

  private async handleGraphFailure(runId: string, error: unknown): Promise<void> {
    const [run] = await this.db.select().from(coderRuns).where(eq(coderRuns.id, runId)).limit(1);
    if (!run) return;
    if (error instanceof AgentInvocationRecoveryRequiredError) {
      if (await this.exposeOperationRecovery(run.id, error.operationKey, error.reason)) return;
    }
    if (run.desiredControlState === 'cancel_requested') {
      await this.failActiveAttempts(runId, 'cancelled', 'The Coder run was cancelled.');
      await this.finishCancelledRun(runId);
      return;
    }
    const reason = this.shuttingDown && isAbortError(error)
      ? 'The Coder process was interrupted by API shutdown.'
      : formatError(error);
    await this.failActiveAttempts(runId, 'failed', reason);
    await this.setRunStatus(runId, 'failed');
    // A graph-level failure never reaches the per-task completion paths that normally post a
    // group message, so the group transcript would otherwise show nothing beyond the task
    // band's status change. Post the failure directly into the transcript the reader is
    // already watching.
    if (run.groupId) {
      const groupId = run.groupId;
      await this.transaction((transaction) => {
        this.appendGroupMessage(transaction, {
          workspaceId: run.workspaceId,
          groupId,
          sender: 'system',
          kind: 'status',
          body: reason,
          runId,
        });
      });
    }
    await this.maybeStartQueuedRuns(run.coderId);
  }

  private async failActiveAttempts(
    runId: string,
    status: 'failed' | 'cancelled',
    reason: string,
  ): Promise<void> {
    const now = new Date();
    const rows = await this.db.update(coderTaskAttempts).set({
      status,
      error: reason,
      finishedAt: now,
    }).where(and(
      eq(coderTaskAttempts.runId, runId),
      eq(coderTaskAttempts.active, true),
      inArray(coderTaskAttempts.status, ['running', 'waiting_for_input', 'waiting_for_recovery']),
    ))
      .returning();
    for (const row of rows) {
      await this.appendEvent(this.db, runId, 'task.failed', {
        taskAttemptId: row.id,
        taskKey: row.taskKey,
        ...(row.assignmentTitle ? { assignmentTitle: row.assignmentTitle } : {}),
        error: reason,
        cancelled: status === 'cancelled',
      });
    }
    this.appendProgressIfChanged(this.db, runId);
  }

  private async failStaleAttempts(runId: string, reason: string): Promise<void> {
    const now = new Date();
    await this.transaction((transaction) => {
      const rows = transaction.select()
        .from(coderTaskAttempts)
        .where(and(
          eq(coderTaskAttempts.runId, runId),
          eq(coderTaskAttempts.active, true),
          eq(coderTaskAttempts.status, 'running'),
        ))
        .orderBy(desc(coderTaskAttempts.attemptIndex)).all();
      for (const row of rows) {
        if (row.result !== null && row.result !== undefined) continue;
        transaction.update(coderTaskAttempts).set({
          status: 'failed',
          error: reason,
          finishedAt: now,
        }).where(eq(coderTaskAttempts.id, row.id)).run();
        this.appendEvent(transaction, runId, 'task.failed', {
          taskAttemptId: row.id,
          taskKey: row.taskKey,
          error: reason,
        });
      }
    });
  }

  private async finishGroupRunSuccessful(runId: string, state: AgentTeamGroupGraphState): Promise<void> {
    const attempts = await this.db.select().from(coderTaskAttempts)
      .where(and(eq(coderTaskAttempts.runId, runId), eq(coderTaskAttempts.active, true)))
      .orderBy(asc(coderTaskAttempts.createdAt));
    const unresolvedIssues = attempts.flatMap((attempt) => {
      const result = attempt.result as { unresolvedIssues?: unknown } | null;
      return Array.isArray(result?.unresolvedIssues)
        ? result.unresolvedIssues.filter((issue): issue is string => typeof issue === 'string')
        : [];
    });
    const outcome: AgentTeamRunOutcome = {
      summary: state.routerLimitReached
        ? 'Stopped after the Router task limit; the group can continue with a new message.'
        : 'The addressed Coder role work completed.',
      unresolvedIssues,
      criterionAssessments: [],
    };
    const now = new Date();
    const committed = await this.transaction((transaction) => {
      const [run] = transaction.select({ groupId: coderRuns.groupId, coderId: coderRuns.coderId, workspaceId: coderRuns.workspaceId })
        .from(coderRuns).where(eq(coderRuns.id, runId)).limit(1).all();
      if (!run) return false;
      const [desired] = transaction.select({ desiredControlState: coderRuns.desiredControlState })
        .from(coderRuns).where(eq(coderRuns.id, runId)).limit(1).all();
      if (desired?.desiredControlState === 'cancel_requested') return false;
      const updated = transaction.update(coderRuns).set({
        status: 'succeeded', outcome, desiredControlState: 'none', updatedAt: now, finishedAt: now,
      }).where(and(eq(coderRuns.id, runId), ne(coderRuns.desiredControlState, 'cancel_requested'))).returning().all();
      if (updated.length === 0) return false;
      this.appendEvent(transaction, runId, 'run.status', { status: 'succeeded', outcome });
      if (run.groupId) {
        this.appendGroupEvent(transaction, run.groupId, 'run.updated', { runId, status: 'succeeded' });
        if (state.routerLimitReached) {
          this.appendGroupMessage(transaction, {
            workspaceId: run.workspaceId,
            groupId: run.groupId,
            sender: 'system',
            kind: 'status',
            body: '自动交接达到 16 次上限，当前执行已停止。你可以在群里继续 @角色 发起下一项工作。',
            runId,
          });
        }
      }
      return true;
    });
    if (committed) await this.maybeStartQueuedRuns((await this.getRun(runId)).coderId);
    else if (await this.getDesiredControlState(runId) === 'cancel_requested') {
      await this.failActiveAttempts(runId, 'cancelled', 'The Coder run was cancelled.');
      await this.finishCancelledRun(runId);
    }
  }

  private appendGroupMessage(
    transaction: AgentTeamDatabaseTransaction,
    input: {
      workspaceId: string;
      groupId: string;
      sender: 'user' | 'role' | 'system';
      senderRole?: AgentTeamRuntimeRole;
      recipientRole?: AgentTeamRuntimeRole;
      kind: 'text' | 'question' | 'assignment' | 'result' | 'control' | 'status' | 'file';
      body: string;
      runId?: string;
      taskAttemptId?: string;
      repositoryIds?: string[];
      fileReferences?: Array<{ documentId: string; revision: number; title: string }>;
      submissionId?: string;
      deliveryStatus?: 'pending' | 'delivered' | 'failed';
    },
  ): void {
    const [latest] = transaction.select({ sequence: coderGroupMessages.sequence })
      .from(coderGroupMessages).where(eq(coderGroupMessages.groupId, input.groupId))
      .orderBy(desc(coderGroupMessages.sequence)).limit(1).all();
    const now = new Date();
    const message = {
      id: `atmsg_${randomUUID()}`,
      workspaceId: input.workspaceId,
      groupId: input.groupId,
      sequence: (latest?.sequence ?? 0) + 1,
      sender: input.sender,
      senderRole: input.senderRole ?? null,
      recipientRole: input.recipientRole ?? null,
      kind: input.kind,
      body: input.body,
      runId: input.runId ?? null,
      taskAttemptId: input.taskAttemptId ?? null,
      repositoryIds: input.repositoryIds ?? [],
      fileReferences: input.fileReferences ?? [],
      submissionId: input.submissionId ?? null,
      deliveryStatus: input.deliveryStatus ?? 'delivered',
      createdAt: now,
    };
    transaction.insert(coderGroupMessages).values(message).run();
    this.appendGroupEvent(transaction, input.groupId, 'message', { message });
    transaction.update(coderGroups).set({ updatedAt: now }).where(eq(coderGroups.id, input.groupId)).run();
  }

  private appendGroupEvent(
    transaction: AgentTeamDatabaseTransaction,
    groupId: string,
    type: 'message' | 'repository.updated' | 'run.updated' | 'memory.updated',
    payload: Record<string, unknown>,
  ): void {
    const [latest] = transaction.select({ sequence: coderGroupEvents.sequence })
      .from(coderGroupEvents).where(eq(coderGroupEvents.groupId, groupId))
      .orderBy(desc(coderGroupEvents.sequence)).limit(1).all();
    transaction.insert(coderGroupEvents).values({
      groupId,
      sequence: (latest?.sequence ?? 0) + 1,
      type,
      payload,
    }).run();
  }

  private async finishCancelledRun(runId: string): Promise<void> {
    const now = new Date();
    await this.db.update(coderPendingInputs).set({ status: 'cancelled', updatedAt: now })
      .where(and(eq(coderPendingInputs.runId, runId), eq(coderPendingInputs.status, 'pending'))).run();
    await this.setRunStatus(runId, 'cancelled', undefined, 'none');
    const [run] = await this.db.select({ coderId: coderRuns.coderId }).from(coderRuns)
      .where(eq(coderRuns.id, runId)).limit(1);
    if (run) await this.maybeStartQueuedRuns(run.coderId);
  }

  private async setRunStatus(
    runId: string,
    status: AgentTeamRunStatus,
    outcome?: AgentTeamRunOutcome,
    desiredControlState?: AgentTeamRunView['desiredControlState'],
  ): Promise<void> {
    const now = new Date();
    const [row] = await this.db.update(coderRuns).set({
      status,
      updatedAt: now,
      finishedAt: isTerminalRunStatus(status) ? now : null,
      ...(outcome === undefined ? {} : { outcome }),
      ...(desiredControlState === undefined ? {} : { desiredControlState }),
    }).where(eq(coderRuns.id, runId)).returning();
    if (row) {
      await this.appendEvent(this.db, runId, 'run.status', { status, ...(outcome ? { outcome } : {}) });
      if (row.groupId) {
        await this.transaction((transaction) => {
          this.appendGroupEvent(transaction, row.groupId!, 'run.updated', { runId, status });
          transaction.update(coderGroups).set({ updatedAt: now }).where(eq(coderGroups.id, row.groupId!)).run();
        });
      }
      this.appendProgressIfChanged(this.db, runId);
    }
  }

  private async getVersion(run: AgentTeamRun): Promise<AgentTeamVersion> {
    const [version] = await this.db.select().from(coderVersions)
      .where(eq(coderVersions.id, run.coderVersionId))
      .limit(1);
    if (!version) throw new NotFoundException('The Coder version was not found.');
    return version;
  }

  private async getRun(runId: string, workspaceId?: string): Promise<AgentTeamRun> {
    const [run] = await this.db.select().from(coderRuns)
      .where(workspaceId
        ? and(eq(coderRuns.id, runId), eq(coderRuns.workspaceId, workspaceId))
        : eq(coderRuns.id, runId))
      .limit(1);
    if (!run) throw new NotFoundException('Coder run not found.');
    return run;
  }

  private async transaction<T>(
    operation: (transaction: AgentTeamDatabaseTransaction) => T | Promise<T>,
  ): Promise<T> {
    const events: AgentTeamRunEvent[] = [];
    let transaction: AgentTeamDatabaseTransaction | undefined;
    try {
      const result = await this.db.transaction((candidate) => {
        transaction = candidate;
        this.transactionEvents.set(candidate, events);
        return operation(candidate);
      });
      if (transaction) this.transactionEvents.delete(transaction);
      this.publishEvents(events);
      return result;
    } catch (error) {
      if (transaction) this.transactionEvents.delete(transaction);
      throw error;
    }
  }

  private appendEvent(
    db: Database | AgentTeamDatabaseTransaction,
    runId: string,
    type: AgentTeamRunEventType,
    payload: unknown,
  ): void {
    const [latest] = db.select({ sequence: coderRunEvents.sequence })
      .from(coderRunEvents)
      .where(eq(coderRunEvents.runId, runId))
      .orderBy(desc(coderRunEvents.sequence))
      .limit(1).all();
    const sequence = (latest?.sequence ?? 0) + 1;
    const createdAt = new Date();
    db.insert(coderRunEvents).values({
      runId,
      sequence,
      type,
      payload,
      createdAt,
    }).run();
    const event: AgentTeamRunEvent = {
      runId,
      sequence,
      type,
      payload,
      createdAt: createdAt.toISOString(),
    };
    const pending = this.transactionEvents.get(db);
    if (pending) pending.push(event);
    else this.publishEvents([event]);
  }

  private appendProgressIfChanged(
    db: Database | AgentTeamDatabaseTransaction,
    runId: string,
  ): void {
    const [run] = db.select().from(coderRuns).where(eq(coderRuns.id, runId)).limit(1).all();
    if (!run) return;
    const taskRows = db.select().from(coderTaskAttempts)
      .where(eq(coderTaskAttempts.runId, runId))
      .orderBy(asc(coderTaskAttempts.createdAt), asc(coderTaskAttempts.attemptIndex))
      .all();
    const progress = deriveRunProgress(run, taskRows);
    const [latest] = db.select({ payload: coderRunEvents.payload })
      .from(coderRunEvents)
      .where(and(eq(coderRunEvents.runId, runId), eq(coderRunEvents.type, 'run.progress')))
      .orderBy(desc(coderRunEvents.sequence))
      .limit(1).all();
    if (latest && JSON.stringify(latest.payload) === JSON.stringify(progress)) return;
    this.appendEvent(db, runId, 'run.progress', progress);
  }

  private publishEvents(events: readonly AgentTeamRunEvent[]): void {
    if (events.length === 0) return;
    for (const listener of this.eventListeners) {
      for (const event of events) listener(event);
    }
  }

  private checkpointPath(): string {
    const configuredSqlitePath = this.config.get<string>('SQLITE_PATH') ?? '../../.data/deployment/worklite.db';
    const sqlitePath = isAbsolute(configuredSqlitePath)
      ? configuredSqlitePath
      : resolve(process.cwd(), configuredSqlitePath);
    const profileDataDirectory = dirname(sqlitePath);
    return this.config.get<string>('CODER_CHECKPOINT_PATH')
      ?? resolve(profileDataDirectory, 'executor-categories', 'checkpoints.sqlite');
  }

  private runOutputDirectory(runId: string): string {
    return resolve(dirname(this.checkpointPath()), 'runs', runId);
  }

  private async readProjectInstructions(projectDirectory: string): Promise<AgentTeamProjectInstructionFile[]> {
    const paths = ['AGENTS.md', 'AGENTS_WORKFLOW.md'];
    return Promise.all(paths.map(async (path) => {
      try {
        return { path, content: await readFile(join(projectDirectory, path), 'utf8') };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    })).then((files) => files.filter((file): file is AgentTeamProjectInstructionFile => file !== null));
  }

  private deliverDocuments(runId: string): Promise<void> {
    const previous = this.documentDeliveries.get(runId) ?? Promise.resolve();
    const delivery = previous
      .catch(() => undefined)
      .then(() => this.deliverDocumentsNow(runId));
    this.documentDeliveries.set(runId, delivery);
    void delivery.finally(() => {
      if (this.documentDeliveries.get(runId) === delivery) this.documentDeliveries.delete(runId);
    });
    return delivery;
  }

  private async deliverDocumentsNow(runId: string): Promise<void> {
    const documents = await this.db.select().from(coderDocuments)
      .where(eq(coderDocuments.runId, runId))
      .orderBy(asc(coderDocuments.createdAt), asc(coderDocuments.key), asc(coderDocuments.revision));
    if (documents.length === 0) return;
    const outputDirectory = this.runOutputDirectory(runId);
    try {
      await mkdir(outputDirectory, { recursive: true });
      await Promise.all(documents.map((document) => writeFile(
        join(outputDirectory, agentTeamDocumentFileName(document.key, document.revision)),
        document.content,
        'utf8',
      )));
      await this.transaction((transaction) => {
        for (const document of documents) {
          const delivered = transaction.update(coderDocuments).set({
            deliveryStatus: 'delivered',
            deliveryError: null,
          }).where(and(
            eq(coderDocuments.id, document.id),
            ne(coderDocuments.deliveryStatus, 'delivered'),
          )).returning().all();
          if (delivered.length > 0) {
            this.appendEvent(transaction, runId, 'document.delivered', {
              documentId: document.id,
              taskAttemptId: document.taskAttemptId,
              taskKey: taskKeyForDocument(transaction, document.taskAttemptId),
              documentKey: document.key,
              revision: document.revision,
              fileName: agentTeamDocumentFileName(document.key, document.revision),
            });
          }
        }
      });
    } catch (error) {
      const reason = formatError(error);
      await this.transaction((transaction) => {
        for (const document of documents) {
          const failed = transaction.update(coderDocuments).set({
            deliveryStatus: 'failed',
            deliveryError: reason,
          }).where(and(
            eq(coderDocuments.id, document.id),
            ne(coderDocuments.deliveryStatus, 'delivered'),
          )).returning().all();
          if (failed.length > 0) {
            this.appendEvent(transaction, runId, 'document.delivery_failed', {
              documentId: document.id,
              taskAttemptId: document.taskAttemptId,
              taskKey: taskKeyForDocument(transaction, document.taskAttemptId),
              documentKey: document.key,
              revision: document.revision,
              fileName: agentTeamDocumentFileName(document.key, document.revision),
              error: reason,
            });
          }
        }
      }).catch(() => undefined);
    }
  }
}

function processReferencePaths(
  role: AgentTeamRoleId,
  manifest: ReturnType<typeof getBmadTeaProcessManifest>,
): string[] {
  if (!['planner', 'test_designer', 'developer', 'test_author', 'test_runner', 'reviewer'].includes(role)) return [];
  const prefixes = role === 'test_designer' || role === 'test_author'
    ? ['upstream/tea/', 'licenses/']
    : ['upstream/bmad/', 'licenses/'];
  return manifest.files
    .map((file) => file.path)
    .filter((path) => prefixes.some((prefix) => path.startsWith(prefix)));
}

export function agentTeamDocumentFileName(key: string, revision: number): string {
  const safeKey = key
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 80) || 'document';
  return `${revision}-${createHash('sha256').update(key).digest('hex').slice(0, 8)}-${safeKey}.md`;
}

function nextDocumentRevision(
  documents: readonly AgentTeamDocument[],
  document: AgentTeamDocument,
  throughIndex: number,
): number {
  let revision = 0;
  for (let index = 0; index <= throughIndex; index += 1) {
    if (documents[index]?.key === document.key) revision += 1;
  }
  return revision;
}

// Default persisted configuration for one predefined Coder role.
function defaultRoleConfiguration(role: AgentTeamRuntimeRole): StoredAgentTeamRoleConfiguration {
  const manifest = getBmadTeaProcessManifest();
  return {
    role: agentTeamContractRole(role) as StoredAgentTeamRoleConfiguration['role'],
    publicModelId: '',
    instructions: CODER_ROLE_INSTRUCTIONS[role] ?? `You are the ${role} role in the Coder. Complete the addressed task and report the result clearly.`,
    entryPoints: manifest.entryPoints[role] ?? [],
    skills: [],
    mcpServers: [],
    toolNames: [...(CODER_ROLE_TOOL_NAMES[role] ?? [])],
  };
}


function taskAttribution(request: AgentTeamTaskRequest): { assignmentTitle?: string } {
  return {
    ...(request.taskDefinition.role === CODER_ROUTER_ROLE ? {} : { assignmentTitle: request.taskDefinition.goal }),
  };
}

export function rolePromptAddition(
  role: AgentTeamRuntimeRole,
  snapshot: StoredAgentTeamVersionSnapshot,
  _request?: AgentTeamTaskRequest,
): string | undefined {
  if (snapshot.orchestrationVersion !== CURRENT_GROUP_ORCHESTRATION_VERSION) return undefined;
  const projectGitPolicy = snapshot.projectGitPolicy?.trim();
  if (role === CODER_ROUTER_ROLE) {
    const capabilities = snapshot.roles.filter((item) => item.role !== CODER_ROUTER_ROLE).map((item) => {
      const tools = item.toolNames?.length ? item.toolNames.join(', ') : 'no project tools';
      return `${item.role}${item.displayName ? ` (${item.displayName})` : ''}: ${item.executor ? `${item.executor} execution engine` : `model role; tools ${tools}`}`;
    });
    return [
      'You are Router, the only coordinator for this Run. Decide each next step from the original goal and persisted task results.',
      'Use only configured roles and authorized repositories. Assign concrete tasks, declare dependencies only when needed, and let independent work run in parallel. Every result returns to Router.',
      'Answer directly when no role task is needed. Ask one focused question when a material user decision is missing. Protected operations require explicit user authorization and a role with the needed capability.',
      `Configured roles and capabilities: ${capabilities.join('; ') || '(none)'}.`,
      ...(projectGitPolicy ? [`Coder project Git policy:
${projectGitPolicy}`] : []),
      'Return a routerPlan with action "finish" or action "dispatch" and one or more assignments.',
    ].join('\n');
  }
  return [
    'Router assigned this task to you. Complete it within the stated repository scope and return evidence, changed files, documents, and unresolved issues to Router.',
    'Do not assign another role or claim that the whole Run is complete.',
    ...(projectGitPolicy ? [`Coder project Git policy:
${projectGitPolicy}`] : []),
  ].join('\n');
}

export function parseExecutorChecklist(text: string): Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }> {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*[-*]\s+\[([ xX~])\]\s+(.+?)\s*$/);
    if (!match) return [];
    return [{ step: match[2]!, status: match[1] === '~' ? 'in_progress' as const : match[1]?.toLowerCase() === 'x' ? 'completed' as const : 'pending' as const }];
  });
}

function taskSystemPrompt(instructions: string, executor: boolean, addition?: string): string {
  const prompt = `${instructions}

${executor ? 'For multi-step work, publish a concise implementation checklist in a progress message before implementation. Use one Markdown checkbox per line: - [ ] pending, - [~] in progress, - [x] completed. When a step changes, publish the entire updated checklist again. Mark a step completed only after actually completing it; revise the list when the work changes. Continue reporting normally and return the required final JSON.' : ''}

You are executing one WorkLite Coder task. Use tools only when the captured role configuration and project authorization permit them. Return exactly one JSON object whose "status" is exactly one of: "waiting_for_input", "completed".

Follow the captured project instructions supplied in the task context, and discover additional applicable AGENTS.md or AGENTS_WORKFLOW.md files before changing or assessing project files. If a project rule or missing user decision requires explicit authorization for an action, return the waiting_for_input response instead of taking that action. ${executor ? 'You run as a project executor in the project directory with your own native tools. WorkLite requires neither proposal confirmation nor exact-command grants. A previous attempt may have changed the project; inspect its actual state rather than assuming earlier work is absent or complete. Read pinned process references from the files listed in the system prompt.' : 'Run whatever shell commands the task needs with bash directly; WorkLite requires no command grant and records every execution as Command evidence. Use process_reference only with one of the exact pinned paths listed in the system prompt.'} Map the process package's project root to projectDirectory and its process output location to outputDirectory. The output directory is managed by WorkLite: return documents in JSON rather than writing planning output there directly.

Scale investigation and verification to the task. Use supplied task context to target the necessary checks; expand investigation only when evidence is missing or conflicts with the current code. Avoid repeating equivalent searches or checks without a new reason. Report unrelated baseline failures rather than repeatedly rerunning them or changing unrelated code.

When more user input is required, return:
{"status":"waiting_for_input","pendingInput":{"question":"One specific question"}}

Otherwise return:
{"status":"completed","message":"Concise update for Router","documents":[{"key":"stable-document-key","title":"Document title","content":"Document content","upstreamDocumentKeys":["optional-upstream-key"]}],"unresolvedIssues":["specific unresolved issue"],"changedFiles":["path/to/changed/file"],"completedWork":true,"criterionAssessments":[{"criterion":"criterion","assessment":"met|unmet|not_verified","evidence":["evidence reference"]}]}

Only Router includes routerPlan. Router must choose "finish" or dispatch one or more specific tasks to configured roles. Work roles return their result without choosing another role. Use an empty changedFiles array when no project files changed. Set completedWork to false only when the requested task remains incomplete, and explain why in unresolvedIssues. Do not invent command ids; WorkLite records actual command evidence.`;
  return addition ? `${prompt}\n\n${addition}` : prompt;
}

function taskContext(request: AgentTeamTaskRequest, correction?: string): unknown {
  const groupContext = request.groupContext;
  if (!groupContext) throw new Error('Router task context is required.');
  return {
    ...(correction ? { correction } : {}),
    task: {
      ...request.taskDefinition,
      scopeRevision: request.scopeRevision,
      ...(request.pendingInputId ? { pendingInputId: request.pendingInputId } : {}),
      ...(request.answer ? { answer: request.answer } : {}),
    },
    intent: request.intent,
    projectDirectory: request.projectDirectory,
    outputDirectory: request.outputDirectory,
    projectInstructions: request.projectInstructions,
    upstreamDocuments: request.upstream,
    taskGroup: {
      groupId: groupContext.groupId,
      originalRequest: groupContext.initialMessage,
      addressedMessage: request.groupMessage ?? groupContext.initialMessage,
      taskContextSummary: request.taskContextSummary || undefined,
      fileReferences: request.fileReferences ?? [],
      repositories: groupContext.repositories.map(({ id, name, directory }) => ({ id, name, directory })),
      ...(groupContext.knownRepositories?.length ? { knownRepositories: groupContext.knownRepositories } : {}),
      transcriptPolicy: 'The group transcript is visible to the user but omitted here. Use only this task and its supplied context.',
    },
  };
}

export function groupRolePromptAddition(
  snapshot: StoredAgentTeamVersionSnapshot,
  request: AgentTeamTaskRequest,
): string | undefined {
  const context = request.groupContext;
  if (!context) return undefined;
  const memories = context.memories ?? [];
  const index = buildTeamMemoryIndex(memories, {
    goal: request.intent || context.initialMessage,
    repositories: context.repositories.map(({ memoryRepositoryId, name }) => ({ memoryRepositoryId, name })),
  });
  if (request.taskDefinition.role === CODER_ROUTER_ROLE) {
    const projection = teamMemoryProjection(memories);
    return [
      'Use the original user goal and persisted task results supplied in this Router turn; messages outside that context are not model input.',
      `User-requested role: ${context.requestedRole ?? '(none)'}.`,
      `Authorized repositories: ${JSON.stringify(context.repositories.map(({ id, name }) => ({ id, name })))}`,
      ...(snapshot.workingPractice?.trim() ? [`Coder working practice:\n${snapshot.workingPractice.trim()}`] : []),
      ...(projection ? [`Coder memories:\n${projection}`] : []),
      'Router has read-only project tools. It cannot edit project files or call deployment tools.',
      'Every role result returns to Router. Router alone chooses whether to wait, assign more roles, or finish.',
    ].join('\n');
  }
  return [
    'This task was assigned by Router. Its goal, repository scope, dependencies, and prior result summaries are included in the task context.',
    `Coder memory index (${index.length} ${index.length === 1 ? 'entry' : 'entries'}):`,
    ...(index.length ? index : ['- (no Coder memories yet)']),
    'Use coder_memory_search and coder_memory_read for relevant saved context. Memory tools are restricted to this Run and its captured repository scope.',
    ...(context.continuation?.role === request.taskDefinition.role ? [
      `Continue task ${context.continuation.taskKey} from its saved goal and progress. Prior attempt: ${context.continuation.sourceTaskAttemptId}.`,
      `Original goal: ${context.continuation.goal}`,
      `Saved progress: ${context.continuation.savedProgress}`,
      `Prior documents: ${context.continuation.fileReferences.map((file) => `${file.title} (${file.documentId}, revision ${file.revision})`).join('; ') || '(none)'}`,
    ] : []),
    'Return your result to Router. Do not hand work to another role or claim the Run is complete.',
  ].join('\n');
}

const TEAM_MEMORY_PROMPT_ENTRIES = 50;
const TEAM_MEMORY_PROMPT_CHARS = 6000;

function teamMemoryProjection(memories: Array<{ content: string }>): string {
  const lines: string[] = [];
  let total = 0;
  for (const memory of memories) {
    const content = memory.content.trim();
    if (!content || lines.length >= TEAM_MEMORY_PROMPT_ENTRIES || total + content.length > TEAM_MEMORY_PROMPT_CHARS) break;
    lines.push(`- ${content}`);
    total += content.length;
  }
  return lines.join('\n');
}

class TaskOutputValidationError extends Error {
  constructor(message: string, readonly output: string) {
    super(message);
    this.name = 'TaskOutputValidationError';
  }
}

type ParsedCompletedTaskResult = Extract<AgentTeamTaskResult, { status: 'completed' }>;
type ParsedTaskResult = ParsedCompletedTaskResult | Extract<AgentTeamTaskResult, { status: 'waiting_for_input' }>;

export function parseTaskOutput(output: string, taskKey: string, supportedRoleIds: readonly string[] = []): ParsedTaskResult {
  try {
    return parseTaskOutputUnsafe(output, taskKey, supportedRoleIds);
  } catch (error) {
    if (error instanceof TaskOutputValidationError) throw error;
    throw new TaskOutputValidationError(
      error instanceof Error ? error.message : String(error),
      output,
    );
  }
}

function parseTaskOutputUnsafe(output: string, taskKey: string, supportedRoleIds: readonly string[]): ParsedTaskResult {
  let value: RawTaskOutput;
  try {
    const trimmed = output.trim();
    const fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```[\t ]*$/i.exec(trimmed);
    value = JSON.parse(fenced ? fenced[1] : trimmed) as RawTaskOutput;
  } catch {
    throw new Error('The Coder role returned invalid JSON.');
  }
  if (value?.status === 'waiting_for_input') {
    const question = typeof (value.pendingInput as { question?: unknown } | undefined)?.question === 'string'
      ? ((value.pendingInput as { question: string }).question).trim()
      : undefined;
    if (!question) throw new Error('The Coder input request has no question.');
    return { status: 'waiting_for_input', pendingInput: { id: `placeholder_${randomUUID()}`, question, scopeRevision: 0 } };
  }
  if (value?.status !== 'completed') throw new Error(`The Coder role returned an unsupported task status: ${JSON.stringify(value?.status)}.`);
  if (typeof value.completedWork !== 'boolean') throw new Error('The Coder role did not report task completion.');
  const supportedFields = new Set(['status', 'documents', 'unresolvedIssues', 'changedFiles', 'completedWork', 'criterionAssessments', 'routerPlan', 'pendingInput', 'message', 'repositoryDirectories']);
  const unsupportedField = Object.keys(value).find((key) => !supportedFields.has(key));
  if (unsupportedField) throw new Error(`The Coder role returned an unsupported field: ${unsupportedField}.`);
  const message = typeof value.message === 'string' ? value.message.trim() : undefined;
  if (value.message !== undefined && typeof value.message !== 'string') throw new Error('The Coder role message must be text.');
  const routerPlan = parseRouterPlan(value.routerPlan, supportedRoleIds);
  const repositoryDirectories = parseRepositoryDirectories(value.repositoryDirectories);
  return {
    status: 'completed',
    documents: parseDocuments(value.documents, taskKey),
    unresolvedIssues: parseStrings(value.unresolvedIssues, 'unresolved issue'),
    commandIds: [],
    changedFiles: parseStrings(value.changedFiles, 'changed file'),
    completedWork: value.completedWork,
    criterionAssessments: parseAssessments(value.criterionAssessments),
    ...(message ? { message } : {}),
    ...(routerPlan ? { routerPlan } : {}),
    ...(repositoryDirectories ? { repositoryDirectories } : {}),
  };
}

function parseRouterPlan(value: unknown, supportedRoleIds: readonly string[]): Extract<AgentTeamTaskResult, { status: 'completed' }>['routerPlan'] {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('routerPlan must be an object.');
  const plan = value as { action?: unknown; assignments?: unknown };
  if (plan.action === 'finish') return { action: 'finish' };
  if (plan.action !== 'dispatch' || !Array.isArray(plan.assignments) || plan.assignments.length === 0 || plan.assignments.length > 12) {
    throw new Error('routerPlan must dispatch one to twelve assignments or finish.');
  }
  const ids = new Set<string>();
  const assignments = plan.assignments.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Each Router assignment must be an object.');
    const item = raw as { id?: unknown; role?: unknown; goal?: unknown; dependencyIds?: unknown; repositoryIds?: unknown };
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(item.id) || ids.has(item.id)) {
      throw new Error('Router assignment ids must be unique stable identifiers.');
    }
    ids.add(item.id);
    if (typeof item.role !== 'string' || !supportedRoleIds.includes(item.role) || item.role === CODER_ROUTER_ROLE) {
      throw new Error('Router may assign only configured work roles.');
    }
    if (typeof item.goal !== 'string' || !item.goal.trim() || item.goal.length > 8_000) throw new Error('Each Router assignment needs a specific goal of at most 8000 characters.');
    const parseIds = (input: unknown, label: string): string[] => {
      if (input === undefined) return [];
      if (!Array.isArray(input) || input.length > 12 || input.some((entry) => typeof entry !== 'string' || !entry.trim())) {
        throw new Error(`${label} must contain at most twelve non-empty ids.`);
      }
      const unique = [...new Set(input.map((entry) => (entry as string).trim()))];
      if (unique.length !== input.length) throw new Error(`${label} must not contain duplicate ids.`);
      return unique;
    };
    return {
      id: item.id,
      role: item.role,
      goal: item.goal.trim(),
      dependencyIds: parseIds(item.dependencyIds, 'Router assignment dependencies'),
      ...(item.repositoryIds === undefined ? {} : { repositoryIds: parseIds(item.repositoryIds, 'Router assignment repository scope') }),
    };
  });
  for (const item of assignments) {
    if (item.dependencyIds.includes(item.id)) throw new Error(`Router assignment ${item.id} cannot depend on itself.`);
    if (item.dependencyIds.some((id) => !ids.has(id))) throw new Error(`Router assignment ${item.id} has a dependency outside the current dispatch plan.`);
  }
  assertAcyclicRouterAssignments(assignments);
  return { action: 'dispatch', assignments };
}

function assertAcyclicRouterAssignments(assignments: readonly { id: string; dependencyIds: readonly string[] }[]): void {
  const dependencies = new Map(assignments.map((assignment) => [assignment.id, assignment.dependencyIds]));
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) throw new Error('Router assignment dependencies must not contain a cycle.');
    if (visited.has(id)) return;
    active.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    active.delete(id);
    visited.add(id);
  };
  for (const assignment of assignments) visit(assignment.id);
}

function parseRepositoryDirectories(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('repositoryDirectories must be an array of absolute paths.');
  const directories = value.map((item) => {
    if (typeof item !== 'string' || !isAbsolute(item.trim())) {
      throw new Error('Each repositoryDirectories entry must be an absolute path.');
    }
    return resolve(item.trim());
  });
  const unique = [...new Set(directories)];
  return unique.length ? unique : undefined;
}

function parseDocuments(value: unknown, taskKey: string): AgentTeamDocument[] {
  if (!Array.isArray(value)) throw new Error('The Coder role returned no document list.');
  return value.map((item) => {
    const document = item as Partial<AgentTeamDocument>;
    if (typeof document.key !== 'string' || !document.key.trim()) throw new Error('A Coder document key is required.');
    if (typeof document.title !== 'string' || !document.title.trim()) throw new Error('A Coder document title is required.');
    if (typeof document.content !== 'string') throw new Error('Coder document content must be text.');
    return {
      key: document.key.trim(),
      title: document.title.trim(),
      content: document.content,
      producingTaskKey: taskKey,
      upstreamDocumentKeys: Array.isArray(document.upstreamDocumentKeys)
        ? document.upstreamDocumentKeys.filter((key): key is string => typeof key === 'string')
        : [],
    };
  });
}

function validateUpstreamDocuments(
  documents: readonly AgentTeamDocument[],
  upstream: readonly AgentTeamDocument[],
): void {
  const availableKeys = new Set(upstream.map((document) => document.key));
  for (const document of documents) {
    const missingKey = document.upstreamDocumentKeys.find((key) => !availableKeys.has(key));
    if (missingKey) {
      throw new Error(`Coder document ${document.key} references unknown upstream document ${missingKey}.`);
    }
  }
}

function parseStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`The Coder role returned no ${field} list.`);
  return value.filter((item): item is string => typeof item === 'string');
}

function parseAssessments(value: unknown): AgentTeamCriterionAssessment[] {
  if (!Array.isArray(value)) throw new Error('The Coder role returned no criterion assessment list.');
  return value.map((item) => {
    const assessment = item as Partial<AgentTeamCriterionAssessment>;
    if (typeof assessment.criterion !== 'string' || !assessment.criterion.trim()) {
      throw new Error('A criterion assessment criterion is required.');
    }
    if (assessment.assessment !== 'met' && assessment.assessment !== 'unmet' && assessment.assessment !== 'not_verified') {
      throw new Error('A criterion assessment value is unsupported.');
    }
    return {
      criterion: assessment.criterion.trim(),
      assessment: assessment.assessment,
      evidence: Array.isArray(assessment.evidence)
        ? assessment.evidence.filter((item): item is string => typeof item === 'string')
        : [],
    };
  });
}

function toTaskAttemptView(
  row: typeof coderTaskAttempts.$inferSelect,
  progressText = '',
  derived: Pick<AgentTeamTaskAttemptView, 'roleName' | 'model'> = { roleName: null, model: null },
): AgentTeamTaskAttemptView {
  return {
    id: row.id,
    taskKey: row.taskKey,
    attemptIndex: row.attemptIndex,
    role: row.role,
    continuedFromAttemptId: row.continuedFromAttemptId,
    status: row.status,
    inputFingerprint: row.inputFingerprint,
    result: row.result as AgentTeamTaskResultView | null,
    error: row.error,
    assignmentTitle: row.assignmentTitle,
    progressText,
    ...derived,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

function toDocumentView(row: typeof coderDocuments.$inferSelect): AgentTeamDocumentView {
  return {
    id: row.id,
    runId: row.runId,
    taskAttemptId: row.taskAttemptId,
    key: row.key,
    revision: row.revision,
    title: row.title,
    content: row.content,
    upstreamDocumentKeys: row.upstreamDocumentKeys,
    deliveryStatus: row.deliveryStatus,
    deliveryError: row.deliveryError,
    fileName: agentTeamDocumentFileName(row.key, row.revision),
    createdAt: row.createdAt.toISOString(),
  };
}

function toPendingInputView(row: typeof coderPendingInputs.$inferSelect): AgentTeamPendingInputView {
  return {
    id: row.id,
    runId: row.runId,
    taskAttemptId: row.taskAttemptId,
    kind: row.kind,
    question: row.question,
    operationKey: row.operationKey,
    scopeRevision: row.scopeRevision,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    answeredAt: row.answeredAt?.toISOString() ?? null,
  };
}

function toOperationView(row: typeof coderOperations.$inferSelect): AgentTeamOperationView {
  return {
    key: row.key.startsWith(`${row.runId}:`) ? row.key.slice(row.runId.length + 1) : row.key,
    runId: row.runId,
    taskAttemptId: row.taskAttemptId,
    taskKey: row.taskKey,
    operationKey: row.operationKey,
    toolName: row.toolName,
    inputFingerprint: row.inputFingerprint,
    status: row.status,
    commandId: row.commandId,
    failureReason: row.failureReason,
    recoveryDecision: row.recoveryDecision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isRunOutcome(value: unknown): value is AgentTeamRunOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const outcome = value as Partial<AgentTeamRunOutcome>;
  return typeof outcome.summary === 'string' && Array.isArray(outcome.unresolvedIssues) && Array.isArray(outcome.criterionAssessments);
}

function isTerminalRunStatus(status: AgentTeamRunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function deriveRunProgress(
  run: AgentTeamRun,
  taskRows: ReadonlyArray<typeof coderTaskAttempts.$inferSelect>,
): AgentTeamRunProgress {
  const activeRows = taskRows.filter((row) => row.active);
  const terminal = isTerminalRunStatus(run.status);
  const inFlight = activeRows.filter((row) =>
    ['running', 'stop_requested', 'waiting_for_input', 'waiting_for_recovery'].includes(row.status));
  const totalTasks = new Set(activeRows.map((row) => row.taskKey)).size;
  const completedTasks = new Set(activeRows.filter((row) => row.status === 'completed').map((row) => row.taskKey)).size;
  const phase: AgentTeamRunProgress['phase'] = terminal
    ? 'terminal'
    : run.status === 'waiting_for_input'
      ? 'waiting'
      : inFlight.some((row) => row.role === CODER_ROUTER_ROLE)
        ? 'routing'
        : inFlight.length > 0
          ? 'working'
          : 'routing';
  const nextStep: AgentTeamRunProgress['nextStep'] = terminal
    ? 'finish'
    : run.status === 'waiting_for_input'
      ? 'answer_question'
      : inFlight.some((row) => row.role !== CODER_ROUTER_ROLE)
        ? 'await_task_results'
        : 'route_tasks';

  return {
    phase,
    nextStep,
    totalTasks,
    completedTasks,
    activeTaskKeys: terminal ? [] : [...new Set(inFlight.map((row) => row.taskKey))],
    waitingReason: run.status === 'waiting_for_input'
      ? 'user_input'
      : null,
  };
}

function isUsableGroupGraphState(value: unknown, run: AgentTeamRun): value is AgentTeamGroupGraphState {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !run.groupContext) return false;
  const state = value as Partial<AgentTeamGroupGraphState>;
  const groupContext = state.groupContext;
  return state.runId === run.id
    && state.intent === run.intent
    && state.projectDirectory === run.projectDirectory
    && state.scopeRevision === run.scopeRevision
    && groupContext?.groupId === run.groupContext.groupId
    && Array.isArray(groupContext?.repositories)
    && Array.isArray(groupContext?.memories)
    && Array.isArray(state.selectedRepositoryIds)
    && Number.isInteger(state.step)
    && state.step! >= 0;
}

function recordCompletedCommand(
  record: { status: string; commandId?: string } | undefined,
  commandIds: Set<string>,
): void {
  if (record?.status === 'completed' && record.commandId) commandIds.add(record.commandId);
}

function pendingInputAnswer(answer: string, directories: readonly string[] = []): AgentTeamPendingInputAnswer {
  return directories.length ? { answer, directories } : { answer };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function formatError(error: unknown): string {
  // LangGraph's EmptyInputError surfaces its internal channel key (e.g. "__start__") rather
  // than a reason a user can act on; translate it into a readable orchestration-start failure.
  if (error instanceof Error && error.name === 'EmptyInputError') {
    return `The Coder run could not start: the orchestration engine received no input for its entry node (${error.message}). Retry the dispatch; if this recurs, it indicates an orchestration bug rather than a model or task failure.`;
  }
  return error instanceof Error ? error.message : 'The Coder task failed.';
}

function boundedToolResult(value: string, maxChars: number): string {
  return value.length > maxChars
    ? `${value.slice(0, maxChars)}\n[Tool output truncated; use available evidence and report gaps.]`
    : value;
}

function persistedToolCall(value: unknown): unknown | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = (value as { call?: unknown }).call;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : undefined;
}

function taskKeyForDocument(
  db: Database | AgentTeamDatabaseTransaction,
  taskAttemptId: string,
): string | null {
  const [attempt] = db.select({ taskKey: coderTaskAttempts.taskKey })
    .from(coderTaskAttempts)
    .where(eq(coderTaskAttempts.id, taskAttemptId))
    .limit(1).all();
  return attempt?.taskKey ?? null;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
