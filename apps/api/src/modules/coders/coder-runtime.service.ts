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
  AgentTeamMode,
  AgentTeamOperationRecoveryDecision,
  AgentTeamOperationView,
  AgentTeamPendingInputView,
  AgentTeamRole,
  AgentTeamRoleId,
  AgentTeamRunEvent,
  AgentTeamRunEventType,
  AgentTeamRunOutcome,
  AgentTeamRunProgress,
  AgentTeamRunStatus,
  AgentTeamRunView,
  AgentTeamTaskAttemptStatus,
  AgentTeamTaskAttemptView,
  AgentTeamTaskResult as AgentTeamTaskResultView,
  AnswerAgentTeamRunRequest,
  CreateAgentTeamRunRequest,
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
  createCoderGraph as createTeamGraph,
  DEVELOPER_LANE_IDS,
  getBmadTeaProcessManifest,
  isInterrupted,
  type AgentTeamDevelopmentAssignment,
  type AgentTeamDevelopmentAssignmentInput,
  type AgentTeamPendingInputAnswer,
  type AgentTeamProjectInstructionFile,
  type AgentTeamTargetedRepairRequest,
  readBmadTeaProcessFile,
  toGraphResult,
  type AgentTeamDocument,
  type AgentCoderGraphResult as AgentTeamGraphResult,
  type AgentCoderGraphState as AgentTeamGraphState,
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
import { enqueueTaskMerge, ensureTaskWorktree, ensureWorktreeAt, inspectGitRepository, mergeTaskWorktree, type PreparedTaskWorktree } from '../agents/git-worktree';
import { AgentTeamOperationJournalService } from './coder-operation-journal.service';
import { AgentTeamConfigurationService } from './coder-configuration.service';
import { AgentTeamManagerToolsService } from './coder-manager-tools.service';
import { AgentTeamMemoryToolsService } from './coder-memory-tools.service';
import { TeamMemoryMcpTokenService } from './coder-memory-mcp-token.service';
import { teamMemoryMcpRuntime } from './coder-memory-mcp';
import { buildTeamMemoryIndex } from './coder-memory-ranking';
import {
  CODER_DISPATCHER_ROLE,
  CODER_PROCESS_ID,
  CODER_PROCESS_VERSION,
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
  initialAgentTeamModeForRole,
  type AgentTeamRuntimeRole,
} from './coder-configuration';
import {
  createTeamGraphV4,
  type AgentTeamGraphV4Delegate,
  type AgentTeamLaneWorktree,
  type AgentTeamTaskRequestV4,
  type AgentTeamWorktreeTaskResult,
} from './coder-graph-v4';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { AgentJsonOutputError, normalizePublicModelList } from '@worklite/model-gateway';
import { retryTransientProviderFailure } from './coder-provider-retry';
import { capturedCoderName, deriveRunCurrent, effectiveTaskModel, taskRoleName } from './coder-run-summary';
import { CommandsService } from '../commands/commands.service';
import { createAgentTeamGroupGraph, type AgentTeamGroupGraphInitial, type AgentTeamGroupGraphState } from './coder-graph-v6';

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
const TASK_ROLES: Array<[RegExp, AgentTeamRole]> = [
  [/^repair_test_authoring_/, 'test_author'],
  [/^repair_test_execution_/, 'test_runner'],
  [/^repair_review_/, 'reviewer'],
  [/^repair_/, 'developer'],
  [/^planning$/, 'planner'],
  [/^test_design$/, 'test_designer'],
  [/^worktree_setup$/, 'worktree-manager'],
  [/^worktree_teardown$/, 'worktree-manager'],
  [/^development_join$/, 'developer'],
  [/^development_/, 'developer'],
  [/^development$/, 'developer'],
  [/^test_authoring$/, 'test_author'],
  [/^test_execution$/, 'test_runner'],
  [/^review$/, 'reviewer'],
];
const RESERVED_DEVELOPER_ID = 'developer';
// New group Runs capture this version. v1-v10 snapshots keep their captured
// prompts, tool surface and projection rules unchanged.
const CURRENT_GROUP_ORCHESTRATION_VERSION = 11;
const ROLE_MEMORY_TOOLS_VERSION = 11;

// Run statuses that hold or wait for one of the team's parallel execution slots.
const SLOT_ACTIVE_STATUSES = ['running', 'waiting_for_input', 'paused'] as const;
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
  completedAssignedWork?: unknown;
  criterionAssessments?: unknown;
  projectGitDecisions?: unknown;
  repairRequest?: unknown;
  repairRequests?: unknown;
  developmentAssignments?: unknown;
  pendingInput?: unknown;
  worktreeSetup?: unknown;
  worktreeTeardown?: unknown;
  message?: unknown;
  handoff?: unknown;
  dispatchDecision?: unknown;
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
    private readonly teamManagerTools: AgentTeamManagerToolsService,
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

  async createRun(
    workspaceId: string,
    request: CreateAgentTeamRunRequest,
    acceptance: AgentTeamRunAcceptance,
  ): Promise<AgentTeamRunView> {
    assertRuntimeAdmission();
    const intent = request?.intent?.trim();
    const projectDirectory = request?.projectDirectory?.trim();
    const mode = request?.mode;
    if (!intent) throw new BadRequestException('A TeamRun intent is required.');
    if (!projectDirectory || !isAbsolute(projectDirectory)) {
      throw new BadRequestException('An absolute workspace directory is required.');
    }
    if (mode !== 'plan_only' && mode !== 'validate_existing' && mode !== 'implement_and_validate') {
      throw new BadRequestException('A supported TeamRun mode is required.');
    }
    const [existing] = await this.db.select({ id: coderRuns.id }).from(coderRuns)
      .where(and(eq(coderRuns.id, acceptance.runId), eq(coderRuns.workspaceId, workspaceId))).limit(1);
    if (existing) return this.getRunView(existing.id, workspaceId);
    await this.resources.reconcileWorkspaceSkills(workspaceId);
    const runId = acceptance.runId;
    const versionId = `atver_${randomUUID()}`;
    const resolvedProjectDirectory = resolve(projectDirectory);
    const projectInstructions = await this.readProjectInstructions(resolvedProjectDirectory);
    const [team] = await this.db.select().from(coders)
      .where(and(eq(coders.id, COMPANY_CODER_ID), eq(coders.workspaceId, workspaceId)))
      .limit(1);
    if (!team) throw new NotFoundException('The built-in Coder was not found.');
    if (team.deletedAt) throw new BadRequestException('This Coder has been deleted and is no longer available for dispatch.');

    const snapshot = await this.createVersionSnapshot(team.roles, team.workingPractice, 5, '', team.name);
    await this.transaction((transaction) => {
      const [latest] = transaction.select({ version: coderVersions.version })
        .from(coderVersions)
        .where(eq(coderVersions.coderId, team.id))
        .orderBy(desc(coderVersions.version))
        .limit(1)
        .all();
      transaction.insert(coderVersions).values({
        id: versionId,
        workspaceId,
        coderId: team.id,
        version: (latest?.version ?? 0) + 1,
        snapshot,
      }).run();
      transaction.insert(coderRuns).values({
        id: runId,
        workspaceId,
        coderId: team.id,
        coderVersionId: versionId,
        // Runs always enter as queued; the cap-aware starter begins them FIFO once a
        // parallel slot is free (maxConcurrentRuns, default 3).
        status: 'queued',
        intent,
        projectDirectory: resolvedProjectDirectory,
        projectInstructions,
        mode,
        scopeRevision: 1,
        langGraphThreadId: `atthread_${runId}`,
      }).run();
      acceptance.accept(transaction, runId);
      this.appendEvent(transaction, runId, 'run.status', { status: 'queued' });
    });

    await this.maybeStartQueuedRuns(team.id);
    return this.getRunView(runId);
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
    if (request.targetRole === 'executor-manager') {
      throw new BadRequestException('Executor Manager is not an active work role in new Runs.');
    }
    if (!team.roles.some((role) => role.role === request.targetRole)) {
      throw new BadRequestException('Select an active role in this Coder.');
    }
    const runId = acceptance.runId;
    const versionId = `atver_${randomUUID()}`;
    const snapshot = await this.createVersionSnapshot(team.roles, team.workingPractice, CURRENT_GROUP_ORCHESTRATION_VERSION, team.projectGitPolicy, team.name);
    const primary = repositories[0];
    const now = new Date();
    // Determine mode based on targetRole.
    // - If dispatcher: placeholder plan_only mode (dispatcher will decide)
    // - If planner and no dispatcher in team: implement_and_validate (direct entry, no mode decision)
    // - Otherwise: use initialAgentTeamModeForRole
    const hasDispatcher = team.roles.some((r) => r.role === CODER_DISPATCHER_ROLE);
    const isDefaultEntry = request.targetRole === CODER_DISPATCHER_ROLE || (request.targetRole === 'planner' && !hasDispatcher);
    const mode = request.targetRole === CODER_DISPATCHER_ROLE
      ? 'plan_only'
      : initialAgentTeamModeForRole(request.targetRole);
    const modeRationale = request.targetRole === CODER_DISPATCHER_ROLE
      ? null
      : (isDefaultEntry && !hasDispatcher ? `Coder has no Dispatcher; the Run entered at its Planner with ${mode} (default entry).` : directRoleModeRationale(request.targetRole));
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
        mode,
        modeRationale,
        modeDecidedAt: request.targetRole === CODER_DISPATCHER_ROLE ? null : now,
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
  // running, waiting, or paused Run, or by a queued Run whose execution is already scheduled.
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
      await mkdir(this.runOutputDirectory(run.id), { recursive: true });
      // resumeInput picks the fresh graph input for a new Run and the checkpoint resume for
      // a re-queued one (e.g. retry), so the starter covers both.
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
    for (const row of [...activityRows].reverse()) {
      const payload = row.payload as { taskAttemptId?: unknown; text?: unknown } | null;
      if (typeof payload?.taskAttemptId !== 'string' || progressTextByAttemptId.has(payload.taskAttemptId)) continue;
      if (typeof payload.text === 'string' && payload.text.trim()) {
        progressTextByAttemptId.set(payload.taskAttemptId, payload.text);
      }
    }
    const worktree = runWorktreeColumns(run);
    const teamDefaultModel = this.config.get<string>('CODER_DEFAULT_PUBLIC_MODEL_ID') ?? '';
    const tasks = taskRows.map((row) => toTaskAttemptView(row, progressTextByAttemptId.get(row.id) ?? '', {
      roleName: taskRoleName(version.snapshot, row.role),
      model: effectiveTaskModel(version.snapshot, row, teamDefaultModel),
    }));
    const [executor] = version.snapshot.coderName?.trim() ? [] : await this.db.select({ name: coders.name })
      .from(coders).where(eq(coders.id, run.coderId)).limit(1);
    return {
      id: run.id,
      coderId: run.coderId,
      coderName: capturedCoderName(version.snapshot, executor?.name ?? run.coderId),
      groupId: run.groupId,
      targetRole: run.targetRole,
      repositoryIds: run.repositoryIds,
      teamVersion: {
        id: version.id,
        version: version.version,
        ...(version.snapshot.coderName ? { coderName: version.snapshot.coderName } : {}),
        createdAt: version.createdAt.toISOString(),
        developerExecution: version.snapshot.developerExecution,
        developerExecutions: version.snapshot.developerExecutions,
        projectExecutorLaunches: version.snapshot.projectExecutorLaunches,
        orchestrationVersion: version.snapshot.orchestrationVersion,
      },
      status: run.status,
      intent: run.intent,
      projectDirectory: run.projectDirectory,
      mode: run.mode,
      modeRationale: run.modeRationale ?? null,
      modeDecidedAt: run.modeDecidedAt?.toISOString() ?? null,
      // Run worktree evidence: retained on conflict, failure, or interruption so the
      // operator can resolve manually. Surfaced until the contracts lane adds the fields.
      worktreeBasePath: worktree.worktreeBasePath ?? null,
      runBranch: worktree.runBranch ?? null,
      // Historical evidence: only Runs from before direct Coder command execution carry
      // granted command strings. New Runs always report an empty list.
      authorizedCommands: run.authorizedCommands,
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
    const orchestrationVersion: number = version.snapshot.orchestrationVersion ?? 1;
    let resumeInterruptId: string | undefined;
    // Lane-based graphs (v2, v4) resume the exact interrupted input node by interrupt id so
    // one lane's answer never lands in another lane's pending question.
    if (orchestrationVersion === 2 || orchestrationVersion === 4 || orchestrationVersion === 5 || orchestrationVersion === 6 || orchestrationVersion === 7 || orchestrationVersion === 8 || orchestrationVersion === 9 || orchestrationVersion === 10 || orchestrationVersion === 11) {
      const graph = this.createGraph(run, version);
      const snapshot = await graph.getState({ configurable: { thread_id: run.langGraphThreadId } });
      resumeInterruptId = snapshot.tasks
        .flatMap((task) => task.interrupts)
        .find((candidate) => (candidate.value as { id?: unknown } | undefined)?.id === request.pendingInputId)?.id;
      if (!resumeInterruptId) throw new BadRequestException('The pending input is no longer active.');
    }

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
      resume: orchestrationVersion === 2 || orchestrationVersion === 4 || orchestrationVersion === 5 || orchestrationVersion === 6 || orchestrationVersion === 7 || orchestrationVersion === 8 || orchestrationVersion === 9 || orchestrationVersion === 10 || orchestrationVersion === 11 ? { [resumeInterruptId as string]: resume } : resume,
    }));
    return this.getRunView(runId);
  }

  async recover(runId: string, request: RecoverAgentTeamOperationRequest): Promise<AgentTeamRunView> {
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

  async pause(runId: string): Promise<AgentTeamRunView> {
    const run = await this.getRun(runId);
    if (run.status === 'paused') return this.getRunView(runId);
    // A live Claude question keeps its executor session in this process; pausing would leave
    // it holding a slot with no way to resume it, so it must be answered or cancelled instead.
    if ([...this.liveQuestions.values()].some((live) => live.runId === runId)) {
      throw new BadRequestException('This Coder run has a live Claude question; answer it or cancel the run.');
    }
    if (run.status === 'waiting_for_input' || (run.status === 'queued' && !this.executions.has(runId))) {
      await this.setRunStatus(runId, 'paused');
    } else if (run.status === 'queued' || run.status === 'running') {
      await this.requestPause(runId);
    } else {
      throw new BadRequestException('A completed Coder run cannot be paused.');
    }
    return this.getRunView(runId);
  }

  async resume(runId: string): Promise<AgentTeamRunView> {
    const run = await this.getRun(runId);
    if (run.status !== 'paused') throw new BadRequestException('Only a paused Coder run can be resumed.');
    if (await this.hasPendingOperationRecovery(runId)) {
      await this.setRunStatus(runId, 'waiting_for_input');
      return this.getRunView(runId);
    }
    const input = await this.resumeInput(run);
    await this.setRunStatus(runId, 'running');
    this.scheduleExecution(runId, input);
    return this.getRunView(runId);
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

  async retry(runId: string, taskKey: string): Promise<AgentTeamRunView> {
    const run = await this.getRun(runId);
    if (run.status !== 'failed') throw new BadRequestException('Only a failed Coder run can be retried.');
    const [failed] = await this.db.select().from(coderTaskAttempts)
      .where(and(
        eq(coderTaskAttempts.runId, runId),
        eq(coderTaskAttempts.taskKey, taskKey),
        eq(coderTaskAttempts.status, 'failed'),
        eq(coderTaskAttempts.active, true),
      ))
      .orderBy(desc(coderTaskAttempts.attemptIndex))
      .limit(1);
    if (!failed) throw new BadRequestException('The failed active Coder task was not found.');

    // A failed Developer lane retries its whole fan-out: successful sibling lanes keep their
    // results, and the dispatcher re-dispatches every lane that has none.
    const repairFanOut = /^repair_(\d+)(?=_|$)/.exec(taskKey);
    const fanOutPattern = /^development(_|$)/.test(taskKey)
      ? /^development(_|$)/
      : repairFanOut
        ? new RegExp(`^repair_${repairFanOut[1]}(_|$)`)
        : null;

    const now = new Date();
    await this.transaction((transaction) => {
      const failedRows = transaction.select({ id: coderTaskAttempts.id, taskKey: coderTaskAttempts.taskKey })
        .from(coderTaskAttempts)
        .where(and(
          eq(coderTaskAttempts.runId, runId),
          eq(coderTaskAttempts.active, true),
          eq(coderTaskAttempts.status, 'failed'),
        )).all();
      for (const row of failedRows) {
        if (fanOutPattern ? !fanOutPattern.test(row.taskKey) : row.taskKey !== taskKey) continue;
        transaction.update(coderTaskAttempts).set({ active: false })
          .where(eq(coderTaskAttempts.id, row.id)).run();
      }
      transaction.update(coderRuns).set({
        // Retry re-enters through the queue so a retried Run never oversubscribes the
        // parallel cap; the starter resumes from the persisted checkpoint.
        status: 'queued',
        desiredControlState: 'none',
        updatedAt: now,
        finishedAt: null,
      }).where(and(eq(coderRuns.id, runId), eq(coderRuns.status, 'failed'))).run();
      this.appendEvent(transaction, runId, 'run.status', { status: 'queued' });
      this.appendProgressIfChanged(transaction, runId);
    });

    await this.maybeStartQueuedRuns(run.coderId);
    return this.getRunView(runId);
  }

  private async initializeBuiltInTeam(): Promise<void> {
    const [existing] = await this.db.select().from(coders)
      .where(and(eq(coders.id, COMPANY_CODER_ID), eq(coders.workspaceId, 'workspace_personal')))
      .limit(1);
    if (!existing) {
      const roles = (Object.keys(CODER_ROLE_INSTRUCTIONS) as AgentTeamRuntimeRole[])
        .filter((role) => role !== 'executor-manager')
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
      // Seed a useful initial Planner -> Implementer configuration for new installations.
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
        description: 'Built-in two-step Coder: a Planner plans, then the Implementer implements.',
        processId: CODER_PROCESS_ID,
        processVersion: CODER_PROCESS_VERSION,
        roles,
        workingPractice: 'Scale planning to the task. Answer read-only requests directly; hand implementation to the Implementer when needed. Follow the user and repository instructions.',
        projectGitPolicy: DEFAULT_DIRECT_GIT_POLICY,
      }).onConflictDoNothing().run();
    }
  }

  private async createVersionSnapshot(
    configuredRoles: StoredAgentTeamRoleConfiguration[],
    workingPractice = '',
    orchestrationVersion: 5 | 6 | 7 | 8 | 9 | 10 | 11 = 5,
    projectGitPolicy = '',
    coderName?: string,
  ): Promise<StoredAgentTeamVersionSnapshot> {
    const manifest = getBmadTeaProcessManifest();
    const processFiles = await Promise.all(manifest.files.map(async (file) => ({
      path: file.path,
      content: await readBmadTeaProcessFile(file.path),
    })));
    const developerRole = configuredRoles.find((role) => role.role === 'developer');
    const developerExecution = await this.executors.captureLaunch(developerRole?.executor ?? 'claude', null);
    const projectExecutorLaunches = orchestrationVersion === 7 || orchestrationVersion === 8 || orchestrationVersion === 9 || orchestrationVersion === 10 || orchestrationVersion === 11
      ? Object.fromEntries(await Promise.all(configuredRoles.filter((role) => role.executor && role.role !== 'executor-manager').map(async (role) => [
        role.role,
        await this.executors.captureLaunch(role.executor!, null),
      ])))
      : undefined;
    return {
      processId: CODER_PROCESS_ID,
      processVersion: CODER_PROCESS_VERSION,
      processFiles,
      developerExecution,
      // v5 reuses the fixed four-lane Developer pool. The Planner chooses how many
      // assignments execute; each lane shares the role's captured launch.
      developerExecutions: { [RESERVED_DEVELOPER_ID]: developerExecution },
      ...(projectExecutorLaunches ? { projectExecutorLaunches } : {}),
      // v5 remains the ordinary fixed workflow; v6-v10 start from a persisted group message.
      orchestrationVersion,
      // The Coder name is captured by value so a later rename only affects new Runs.
      ...(coderName ? { coderName } : {}),
      workingPractice,
      ...(orchestrationVersion === 9 || orchestrationVersion === 10 || orchestrationVersion === 11 ? { projectGitPolicy } : {}),
      roles: await Promise.all(configuredRoles.filter((role) => (orchestrationVersion !== 8 && orchestrationVersion !== 9 && orchestrationVersion !== 10 && orchestrationVersion !== 11) || role.role !== 'executor-manager').map(async (role) => {
        const entryPointContent = await Promise.all(role.entryPoints.map((path) => readBmadTeaProcessFile(path)));
        const processReferences = processReferencePaths(role.role, manifest);
        return {
          ...role,
          // An empty developer model keeps the executor's own default instead of the executor default model.
          // role.publicModelId may be one model id or an ordered fallback list; the executor default
          // (used only for a non-executor, non-Developer role) is always a single declared model.
          publicModelId: normalizePublicModelList(role.publicModelId).length > 0
            ? role.publicModelId
            : (role.executor || role.role === 'developer' ? '' : this.config.get<string>('CODER_DEFAULT_PUBLIC_MODEL_ID')?.trim() || ''),
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
      // Queued Runs start through the cap-aware starter (below) once interrupted running
      // Runs have been reconciled and hold their slots again.
      if (run.status === 'queued') {
        if (run.desiredControlState === 'pause_requested') await this.setRunStatus(run.id, 'paused');
        continue;
      }
      if (!this.executions.has(run.id)) await this.reconcileInterruptedRun(run);
    }
    for (const coderId of new Set(runs.map((run) => run.coderId))) {
      await this.maybeStartQueuedRuns(coderId);
    }
  }

  private async resumeInput(run: AgentTeamRun): Promise<AgentTeamGraphState | AgentTeamGroupGraphState | null> {
    const version = await this.getVersion(run);
    const graph = this.createGraph(run, version);
    const snapshot = await graph.getState({ configurable: { thread_id: run.langGraphThreadId } });
    if (isGroupOrchestrationVersion(version.snapshot.orchestrationVersion)) {
      // A group Run with an existing usable checkpoint is resuming an in-progress graph:
      // the checkpointer already holds its state, so passing null lets LangGraph replay it.
      // A brand-new Run has no checkpoint at all (empty channel_versions), so LangGraph's
      // isResuming check is false and a null/undefined input never reaches the "__start__"
      // channel: the graph's own 'start' node seeds the real state from its closure and
      // ignores this value, but Pregel still requires a non-null write to schedule it.
      const groupState = snapshot.values as AgentTeamGroupGraphState | undefined;
      return isUsableGroupGraphState(groupState, run) ? null : ({} as AgentTeamGroupGraphState);
    }
    const state = snapshot.values as AgentTeamGraphState | undefined;
    return isUsableGraphState(state, run) ? null : this.initialGraphInput(run);
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

  private initialGraphInput(run: AgentTeamRun): AgentTeamGraphState {
    return initialGraphState(run, this.runOutputDirectory(run.id));
  }

  private async reconcileInterruptedRun(run: AgentTeamRun): Promise<void> {
    const interruptedOperation = await this.findInterruptedOperation(run.id);
    if (run.desiredControlState === 'pause_requested') {
      if (interruptedOperation) {
        await this.exposeOperationRecovery(
          run.id,
          interruptedOperation.key.slice(run.id.length + 1),
          interruptedOperation.failureReason ?? 'The Coder process was interrupted before the operation settled.',
        );
      }
      await this.setRunStatus(run.id, 'paused', undefined, 'none');
      return;
    }
    if (interruptedOperation) {
      await this.exposeOperationRecovery(
        run.id,
        interruptedOperation.key.slice(run.id.length + 1),
        interruptedOperation.failureReason ?? 'The Coder process was interrupted before the operation settled.',
      );
      await this.setRunStatus(run.id, 'waiting_for_input');
      return;
    }

    const version = await this.getVersion(run);
    const graph = this.createGraph(run, version);
    const snapshot = await graph.getState({ configurable: { thread_id: run.langGraphThreadId } });
    const state = snapshot.values as AgentTeamGraphState | undefined;
    const validState = isUsableGraphState(state, run);
    if (validState) await this.reconcileProjection(run, state);
    const interrupted = snapshot.tasks.some((task) => task.interrupts.length > 0);
    if (isGroupOrchestrationVersion(version.snapshot.orchestrationVersion)) {
      const groupState = snapshot.values as AgentTeamGroupGraphState | undefined;
      const validGroupState = isUsableGroupGraphState(groupState, run);
      const activeAttempts = await this.db.select({ id: coderTaskAttempts.id }).from(coderTaskAttempts)
        .where(and(eq(coderTaskAttempts.runId, run.id), eq(coderTaskAttempts.active, true), eq(coderTaskAttempts.status, 'running')));
      if (activeAttempts.length > 0) {
        await this.failStaleAttempts(run.id, 'The Coder process was interrupted while a role task was active. Inspect repository state before retrying; the task was not replayed.');
        await this.transaction((transaction) => {
          const [current] = transaction.select({ groupId: coderRuns.groupId, workspaceId: coderRuns.workspaceId })
            .from(coderRuns).where(eq(coderRuns.id, run.id)).limit(1).all();
          if (current?.groupId) this.appendGroupMessage(transaction, {
            workspaceId: current.workspaceId,
            groupId: current.groupId,
            sender: 'system',
            kind: 'status',
            body: '服务中断时有角色任务正在运行。任务没有自动重放；请先检查仓库实际状态，再选择重试或重新执行。',
            runId: run.id,
          });
        });
        await this.setRunStatus(run.id, 'failed');
        await this.maybeStartQueuedRuns(run.coderId);
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
      return;
    }
    if (interrupted) {
      const orchestrationVersion: number = version.snapshot.orchestrationVersion ?? 1;
      if (orchestrationVersion === 2 || orchestrationVersion === 4 || orchestrationVersion === 5 || orchestrationVersion === 6 || orchestrationVersion === 7 || orchestrationVersion === 8 || orchestrationVersion === 9 || orchestrationVersion === 10 || orchestrationVersion === 11) {
        const resume: Record<string, AgentTeamPendingInputAnswer> = {};
        let unanswered = false;
        for (const interrupt of snapshot.tasks.flatMap((task) => task.interrupts)) {
          const pendingInputId = (interrupt.value as { id?: unknown } | undefined)?.id;
          const answeredInput = validState && typeof pendingInputId === 'string'
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
      const answeredInput = validState && state?.pendingInput
        ? await this.findAnsweredInput(run, state.pendingInput.id)
        : undefined;
      if (answeredInput) {
        await this.setRunStatus(run.id, 'running', undefined, 'none');
        this.scheduleExecution(run.id, new Command({ resume: answeredInput }));
        return;
      }
      await this.setRunStatus(run.id, 'waiting_for_input');
      return;
    }
    if (!validState || snapshot.next.length === 0) {
      if (!validState) {
        await this.failStaleAttempts(run.id, 'The Coder checkpoint was missing or empty.');
        await this.setRunStatus(run.id, 'failed');
        await this.maybeStartQueuedRuns(run.coderId);
        return;
      }
      await this.finishSuccessfulRun(run.id, toGraphResult(state));
      return;
    }

    await this.failStaleAttempts(run.id, 'The Coder process was interrupted before the task settled.');
    this.scheduleExecution(run.id, null);
  }

  private async reconcileProjection(run: AgentTeamRun, state: AgentTeamGraphState): Promise<void> {
    await this.transaction((transaction) => {
      for (const [documentIndex, document] of (state.documents ?? []).entries()) {
        const revision = nextDocumentRevision(state.documents ?? [], document, documentIndex);
        const [existing] = transaction.select({ id: coderDocuments.id })
          .from(coderDocuments)
          .where(and(
            eq(coderDocuments.runId, run.id),
            eq(coderDocuments.key, document.key),
            eq(coderDocuments.revision, revision),
          ))
          .limit(1).all();
        if (existing) continue;
        const attemptId = ensureProjectionAttempt(
          transaction,
          run,
          document.producingTaskKey,
          state.documents ?? [],
          state.taskResults[document.producingTaskKey],
        );
        transaction.insert(coderDocuments).values({
          id: `atdoc_${randomUUID()}`,
          workspaceId: run.workspaceId,
          runId: run.id,
          taskAttemptId: attemptId,
          key: document.key,
          revision,
          title: document.title,
          content: document.content,
          upstreamDocumentKeys: document.upstreamDocumentKeys,
        }).run();
        this.appendEvent(transaction, run.id, 'document.committed', {
          taskKey: document.producingTaskKey,
          documentKey: document.key,
          revision,
        });
      }
    });
    await this.deliverDocuments(run.id);
  }

  private scheduleExecution(runId: string, input: AgentTeamGraphState | AgentTeamGroupGraphState | Command | null): void {
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

  private async executeGraph(runId: string, input: AgentTeamGraphState | AgentTeamGroupGraphState | Command | null): Promise<void> {
    const run = await this.getRun(runId);
    const version = await this.getVersion(run);
    const graph = this.createGraph(run, version);
    const controller = new AbortController();
    this.abortControllers.set(runId, controller);
    // A partial answer resumes the graph while other Developers still wait: keep the
    // waiting_for_input status instead of forcing a running flicker.
    if (run.status !== 'waiting_for_input') await this.setRunStatus(runId, 'running');
    let sawInterrupt = false;
    let pauseAtBoundary = false;
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
        if (await this.getDesiredControlState(runId) === 'pause_requested') {
          const snapshot = await graph.getState({ configurable: { thread_id: run.langGraphThreadId } });
          if (snapshot.next.length > 0) {
            pauseAtBoundary = true;
            break;
          }
        }
      }
    } finally {
      this.abortControllers.delete(runId);
    }

    if (pauseAtBoundary) {
      await this.setRunStatus(runId, 'paused', undefined, 'none');
      return;
    }
    if (sawInterrupt) {
      const desiredControlState = await this.getDesiredControlState(runId);
      if (desiredControlState === 'cancel_requested') {
        await this.failActiveAttempts(runId, 'cancelled', 'The Coder run was cancelled.');
        await this.finishCancelledRun(runId);
        return;
      }
      if (desiredControlState === 'pause_requested') {
        await this.setRunStatus(runId, 'paused', undefined, 'none');
        return;
      }
      await this.setRunStatus(runId, 'waiting_for_input');
      return;
    }
    const snapshot = await graph.getState({ configurable: { thread_id: run.langGraphThreadId } });
    const completedState = snapshot.values as AgentTeamGraphState | AgentTeamGroupGraphState;
    await this.deliverDocuments(runId);
    if (isGroupOrchestrationVersion(version.snapshot.orchestrationVersion)) {
      await this.finishGroupRunSuccessful(runId, completedState as AgentTeamGroupGraphState);
    } else {
      await this.finishSuccessfulRun(runId, toGraphResult(completedState as AgentTeamGraphState));
    }
  }

  private createGraph(run: AgentTeamRun, version: AgentTeamVersion) {
    const snapshot = version.snapshot;
    const orchestrationVersion: number = snapshot.orchestrationVersion ?? 1;
    if (isGroupOrchestrationVersion(orchestrationVersion)) {
      if (!run.groupContext) throw new Error('This Coder group Run has no captured group context. Start a new Run.');
      const initial: AgentTeamGroupGraphInitial = {
        runId: run.id,
        intent: run.intent,
        mode: run.mode,
        projectDirectory: run.projectDirectory,
        outputDirectory: this.runOutputDirectory(run.id),
        scopeRevision: run.scopeRevision,
        projectInstructions: run.projectInstructions,
        groupContext: run.groupContext as AgentTeamGroupRunContext,
        orchestrationVersion,
        implementationRoleId: snapshot.roles.find((role) => role.executor)?.role,
      };
      return createAgentTeamGroupGraph({
        executeTask: async (request) => this.executeTask(run.workspaceId, version, request),
        documentReferences: (runId, taskKey) => this.getTaskDocumentReferences(runId, taskKey),
        bindGroupDirectories: (runId, directories, source) => this.bindGroupDirectories(runId, directories, source),
      }, this.checkpointer, initial);
    }
    // v4 and v5 run the app-local Worktree Manager topology over the fixed lane pool.
    if (orchestrationVersion === 4 || orchestrationVersion === 5) {
      const delegate: AgentTeamGraphV4Delegate = {
        executeTask: async (request) => this.executeTask(run.workspaceId, version, request),
      };
      return createTeamGraphV4(delegate, this.checkpointer, {
        maxRepairRounds: snapshot.recipeDefaults.maxRepairRounds,
      });
    }
    const developerRole = snapshot.roles.find((role) => role.role === 'developer');
    return createTeamGraph({
      executeTask: async (request) => this.executeTask(run.workspaceId, version, request),
    }, this.checkpointer, {
      maxRepairRounds: snapshot.recipeDefaults.maxRepairRounds,
      // v4/v5 use the app-local graph above; v5 sets up an advisory strategy document
      // and leaves the worktree state empty so Developer lanes run in the workspace.
      orchestrationVersion: orchestrationVersion as 1 | 2 | 3,
      developerIds: orchestrationVersion === 3 ? DEVELOPER_LANE_IDS : versionDeveloperIds(snapshot),
      developerConcurrency: orchestrationVersion === 3
        ? DEVELOPER_LANE_IDS.length
        : snapshot.recipeDefaults.maxDeveloperConcurrency ?? developerRole?.developerConcurrency,
    });
  }

  private async executeTask(
    workspaceId: string,
    version: AgentTeamVersion,
    request: AgentTeamTaskRequest,
  ): Promise<AgentTeamTaskResult> {
    const run = await this.getRun(request.runId);
    const { role: taskRole, taskKey } = request.taskDefinition;
    const role = version.snapshot.roles.find((item) => item.role === taskRole);
    if (!role) throw new Error(`Coder role ${taskRole} was not captured by this version.`);
    if (taskRole === 'executor-manager' && (!request.groupContext || version.snapshot.orchestrationVersion !== 7)) {
      throw new Error('Executor Manager is available only in captured historical v7 group Runs.');
    }
    if (taskRole === 'executor-manager' && normalizePublicModelList(role.publicModelId).length === 0) {
      throw new Error('The captured historical Executor Manager role has no configured model.');
    }
    const attempt = await this.prepareTaskAttempt(run, request);
    if (attempt.status === 'completed' || attempt.status === 'waiting_for_input') {
      return attempt.result as AgentTeamTaskResult;
    }
    const orchestrationVersion: number = version.snapshot.orchestrationVersion ?? 1;
    // A v6-v9 project-executor task cannot launch without a real directory. On an
    // empty-scope Run the runtime raises the directory question itself; an answer that
    // carries directories binds them and the task re-runs with a real project directory.
    if (isGroupOrchestrationVersion(orchestrationVersion) && role.executor && !request.projectDirectory.trim()) {
      return this.finishWaitingAttempt(request, workspaceId, attempt.id, {
        status: 'waiting_for_input',
        pendingInput: {
          id: `placeholder_${randomUUID()}`,
          question: '这项开发任务还没有绑定的项目目录。请提供该任务的绝对项目目录；在回答中附带目录会将其注册并绑定到本次任务。',
          scopeRevision: 0,
        },
      });
    }
    // v5 uses the Worktree Manager as an advisory project-strategy planner. It does not
    // inspect one assumed Git root or invoke the v4 worktree lifecycle.
    if (orchestrationVersion === 4 && (taskKey === 'worktree_setup' || taskKey === 'worktree_teardown')) {
      const skipped = await this.shortCircuitWorktreeManager(run, request, workspaceId, attempt.id);
      if (skipped) return skipped;
    }
    const controller = this.abortControllers.get(request.runId);
    const signal = controller?.signal ?? new AbortController().signal;
    const commandIds = new Set<string>();
    // Model calls this attempt has finished. Tools run only after a call finishes, so while it is
    // zero a failed model-loop invocation has had no side effect and can be repeated safely.
    let modelRoundsCompleted = 0;
    // v1-v3 lanes use the historical runtime-managed worktree and merge paths. v4 lanes
    // receive their worktree from the Worktree Manager setup; v5 delegates Git choices to
    // the Developer executor and starts it in the supplied workspace root.
    let laneWorktree: PreparedTaskWorktree | null = null;
    let laneMergeTarget: { projectDirectory: string; baseBranch: string } | null = null;
    const requestLane: AgentTeamLaneWorktree | undefined = (request as AgentTeamTaskRequestV4).laneWorktree;

    const produceOutput = async (correction?: string): Promise<string> => {
      if (taskRole === 'developer' || ((orchestrationVersion === 7 || orchestrationVersion === 8 || orchestrationVersion === 9 || orchestrationVersion === 10 || orchestrationVersion === 11) && role.executor)) {
        const developerId = request.developerId ?? RESERVED_DEVELOPER_ID;
        // v3/v4/v5 lanes share the role's single captured launch; only v2 snapshots
        // carry per-instance launches and configurations.
        const roleExecution = orchestrationVersion === 7 || orchestrationVersion === 8 || orchestrationVersion === 9 || orchestrationVersion === 10 || orchestrationVersion === 11 ? version.snapshot.projectExecutorLaunches?.[taskRole] : undefined;
        const execution = roleExecution ?? version.snapshot.developerExecutions?.[developerId]
          ?? (orchestrationVersion === 3 || orchestrationVersion === 4 || orchestrationVersion === 5 || orchestrationVersion === 6 || orchestrationVersion === 7 || orchestrationVersion === 8 || orchestrationVersion === 9 || orchestrationVersion === 10 || orchestrationVersion === 11 ? version.snapshot.developerExecutions?.[RESERVED_DEVELOPER_ID] : undefined)
          ?? (developerId === RESERVED_DEVELOPER_ID ? version.snapshot.developerExecution : undefined);
        if (!execution || !('executor' in execution)) throw new Error('This Coder version has no captured developer executor. Start a new Coder Run.');
        const sharedLaunch = orchestrationVersion === 3 || orchestrationVersion === 4 || orchestrationVersion === 5 || orchestrationVersion === 6 || orchestrationVersion === 7 || orchestrationVersion === 8 || orchestrationVersion === 9 || orchestrationVersion === 10 || orchestrationVersion === 11;
        const instance = !sharedLaunch && developerId !== RESERVED_DEVELOPER_ID
          ? role.developerInstances?.find((candidate) => candidate.developerId === developerId)
          : undefined;
        if (!sharedLaunch && developerId !== RESERVED_DEVELOPER_ID && !instance) {
          throw new Error(`Developer instance ${developerId} was not captured by this Coder version.`);
        }
        const developerRole = instance ?? role;
        // A project executor launches one native process; it has no Gateway-level fallback loop, so a
        // declared fallback list here only ever uses its first (primary) candidate.
        const model = normalizePublicModelList(developerRole.publicModelId)[0] ?? (execution.executor === 'codex' ? execution.model : null);
        if (model) await this.executors.requireModel(workspaceId, execution.executor, model);
        if (!laneWorktree && orchestrationVersion !== 5 && orchestrationVersion !== 6 && orchestrationVersion !== 7 && orchestrationVersion !== 8 && orchestrationVersion !== 9 && orchestrationVersion !== 10 && orchestrationVersion !== 11) {
          if (requestLane) {
            laneWorktree = {
              worktreePath: requestLane.worktreePath,
              worktreeBranch: requestLane.worktreeBranch,
              baseBranch: requestLane.runBranch,
              baseCommit: '',
            };
            laneMergeTarget = { projectDirectory: requestLane.baseWorktreePath, baseBranch: requestLane.runBranch };
          } else {
            laneWorktree = await this.prepareDeveloperLane(run, attempt.id);
          }
        }
        const laneNote = laneWorktree ? `You work in your lane's dedicated git worktree (${laneWorktree.worktreePath}) on branch ${laneWorktree.worktreeBranch}; stay inside it and commit your finished changes on that branch before returning.` : null;
        const promptAddition = [developerPromptAddition(request), rolePromptAddition(taskRole, version.snapshot, request), groupRolePromptAddition(version.snapshot, request), laneNote].filter(Boolean).join('\n\n') || undefined;
        const references = await Promise.all([
          ...(developerRole.processReferences ?? []).map(async (path) => ({ path, content: await this.readCapturedProcessFile(version, path) })),
          ...(request.groupContext ? request.fileReferences ?? [] : []).map(async (reference) => ({
            path: `team-documents/${reference.documentId}-v${reference.revision}.md`,
            content: (await this.readGroupDocumentForTask(run.groupId!, reference.documentId, reference.revision, request.fileReferences ?? [])).content,
          })),
        ]);
        // v11 project executors reach Coder memory through a per-task MCP binding. The
        // token is revoked as soon as the executor returns, fails or is cancelled.
        const memoryToken = orchestrationVersion >= ROLE_MEMORY_TOOLS_VERSION
          ? this.memoryTokens.register(this.memoryActorContext(workspaceId, run, request, attempt.id, taskRole))
          : null;
        try {
          const mcpServers = (await this.resources.workflowMcpRuntimes(workspaceId, developerRole.mcpServers.map((server) => server.id)))
            .map((runtime) => {
              const snapshot = developerRole.mcpServers.find((server) => server.id === runtime.id);
              // An empty captured selection means the server was never configured; the
              // live runtime then carries its auto-discovered tools.
              return snapshot?.allowedToolNames.length ? { ...runtime, name: snapshot.name, allowedTools: snapshot.allowedToolNames } : runtime;
            });
          return await this.executors.execute({
            owner: 'coder',
            workspaceId,
            launch: execution,
            model,
            systemPrompt: taskSystemPrompt(developerRole.instructions, true, promptAddition),
            input: JSON.stringify(taskContext(request, true, correction)),
            projectDirectory: laneWorktree?.worktreePath ?? request.projectDirectory,
            skills: developerRole.skills,
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
        systemPrompt: taskRole === 'executor-manager'
          ? teamManagerSystemPrompt(groupRolePromptAddition(version.snapshot, request))
          : taskSystemPrompt(role.instructions, false, [taskRole === 'planner' ? 'Every completed Planner response must include a non-empty plan document in documents, with the goal, decisions, steps and validation or findings appropriate to the request. Do not invent implementation work for read-only requests.' : undefined, rolePromptAddition(taskRole, version.snapshot, request), groupRolePromptAddition(version.snapshot, request)].filter(Boolean).join('\n\n') || undefined),
        context: taskContext(request, false, correction),
        skills: taskRole === 'executor-manager' ? [] : role.skills,
        mcpRuntimes: taskRole === 'executor-manager' ? [] : (await this.resources.workflowMcpRuntimes(workspaceId, role.mcpServers.map((server) => server.id)))
          .map((runtime) => {
            const snapshot = role.mcpServers.find((server) => server.id === runtime.id);
            // An empty captured selection means the server was never configured; the
            // live runtime then carries its auto-discovered tools.
            return snapshot?.allowedToolNames.length
              ? { ...runtime, name: snapshot.name, allowedTools: snapshot.allowedToolNames }
              : runtime;
          }),
        builtinToolNames: taskRole === 'executor-manager' ? [] : isGroupOrchestrationVersion(orchestrationVersion) ? [...role.toolNames, 'read_coder_document'] : role.toolNames,
        // v11 role memory tools are managed tools: they bypass the built-in role
        // allowlist and are bound to this Run's Coder and repository scope server-side.
        ...(roleMemoryManagedToolsEnabled(orchestrationVersion, taskRole) ? {
          managedTools: this.memoryTools.toolDefinitions(),
          executeManagedTool: (call) => this.memoryTools.execute({
            context: this.memoryActorContext(workspaceId, run, request, attempt.id, taskRole),
            taskKey,
            call,
          }),
        } : {}),
        ...(taskRole === 'executor-manager' ? {
          managedTools: this.teamManagerTools.toolDefinitions(),
          executeManagedTool: (call) => this.teamManagerTools.execute({
            workspaceId,
            groupId: request.groupContext!.groupId,
            runId: request.runId,
            taskKey,
            sourceMessageId: request.groupContext!.initialMessageId,
            call,
          }),
        } : {}),
        role: taskRole,
        projectDirectory: taskRole === 'executor-manager' ? '' : request.projectDirectory,
        processReferencePaths: taskRole === 'executor-manager' ? [] : role.processReferences ?? [],
        readProcessReference: (path) => this.readCapturedProcessFile(version, path),
        ...(request.groupContext && taskRole !== 'executor-manager' ? {
          readTeamDocument: async (documentId: string, revision: number) => this.readGroupDocumentForTask(
            request.groupContext!.groupId,
            documentId,
            revision,
            request.fileReferences ?? [],
          ),
        } : {}),
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
            nothingRan: () => modelRoundsCompleted === 0,
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
        return await this.finishCoderOutput(request, workspaceId, attempt.id, taskKey, output, commandIds, laneWorktree, laneMergeTarget, orchestrationVersion, version.snapshot.roles.map((item) => item.role));
      } catch (error) {
        if (!(error instanceof TaskOutputValidationError) || parseAttempt >= 1) throw error;
        if (error.output.length > 100_000) throw error;
        correctionOutput = error.message;
        previousOutput = error.output;
      }
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
    laneWorktree?: PreparedTaskWorktree | null,
    laneMergeTarget?: { projectDirectory: string; baseBranch: string } | null,
    orchestrationVersion = 1,
    supportedRoleIds: readonly string[] = [],
  ): Promise<AgentTeamTaskResult> {
    const parsed = parseTaskOutput(output, taskKey, supportedRoleIds);
    if (parsed.status === 'waiting_for_input') {
      return this.finishWaitingAttempt(request, workspaceId, attemptId, parsed);
    }
    if (orchestrationVersion >= 10 && request.taskDefinition.role === CODER_DISPATCHER_ROLE && !parsed.dispatchDecision) {
      throw new TaskOutputValidationError('The v10 Dispatcher completed without the required dispatchDecision object.', output);
    }
    if (request.taskDefinition.role === 'planner' && !parsed.documents.some((document) => document.content.trim())) {
      throw new TaskOutputValidationError('Planner must return a non-empty plan document in documents.', output);
    }
    validateUpstreamDocuments(parsed.documents, request.upstream);
    if (laneWorktree) await this.mergeDeveloperLane(request.runId, attemptId, taskKey, laneWorktree, laneMergeTarget);
    const result: ParsedCompletedTaskResult = {
      ...parsed,
      commandIds: [...commandIds],
    };
    // The Worktree Manager's validated output is executed by the runtime before the result
    // commits: shape and convention errors throw TaskOutputValidationError (earning the
    // single corrective re-invocation), git failures fail the attempt outright.
    const executed = orchestrationVersion === 5 || orchestrationVersion === 6 || orchestrationVersion === 7 || orchestrationVersion === 8 || orchestrationVersion === 9 || orchestrationVersion === 10 || orchestrationVersion === 11
      ? { ...result, worktreeSetup: undefined, worktreeTeardown: undefined }
      : await this.applyWorktreeManagerOutput(request, attemptId, output, result);
    return this.finishCompletedAttempt(request, workspaceId, attemptId, executed);
  }

  // A git-backed lane creates (or reuses, on resume) its own worktree keyed by the attempt.
  private async prepareDeveloperLane(run: AgentTeamRun, attemptId: string): Promise<PreparedTaskWorktree | null> {
    const repository = await inspectGitRepository(run.projectDirectory);
    if (!repository?.branch) return null;
    const suffix = attemptId.replace(/[^a-zA-Z0-9]/g, '').slice(-8).toLowerCase();
    const worktree = await ensureTaskWorktree({ ...repository, branch: repository.branch }, suffix);
    this.appendEvent(this.db, run.id, 'task.activity', {
      taskAttemptId: attemptId, phase: 'worktree.prepared',
      worktreePath: worktree.worktreePath, worktreeBranch: worktree.worktreeBranch, baseBranch: worktree.baseBranch,
    });
    return worktree;
  }

  // A completed lane merges its branch back through the shared serialized queue; a conflict
  // fails the attempt with the conflicting file list and retains the worktree for manual resolution.
  // v4 lanes merge into the Run base worktree (target override) instead of the original checkout.
  private async mergeDeveloperLane(
    runId: string,
    attemptId: string,
    taskKey: string,
    worktree: PreparedTaskWorktree,
    target?: { projectDirectory: string; baseBranch: string } | null,
  ): Promise<void> {
    const run = await this.getRun(runId);
    const mergeDirectory = target?.projectDirectory ?? run.projectDirectory;
    const mergeBase = target?.baseBranch ?? worktree.baseBranch;
    const outcome = await enqueueTaskMerge(mergeDirectory, mergeBase, () => mergeTaskWorktree({
      projectDirectory: mergeDirectory,
      worktreePath: worktree.worktreePath,
      worktreeBranch: worktree.worktreeBranch,
      baseBranch: mergeBase,
    }).catch((error: unknown): { status: 'conflict'; error: string } => ({
      status: 'conflict',
      error: `自动合并 lane 分支 ${worktree.worktreeBranch} 时出现意外错误（${error instanceof Error ? error.message : String(error)}）；worktree ${worktree.worktreePath} 与分支已保留，请手动合并后清理。`,
    })));
    this.appendEvent(this.db, runId, 'task.activity', {
      taskAttemptId: attemptId, taskKey,
      phase: outcome.status === 'merged' ? 'worktree.merged' : 'worktree.merge_conflict',
      worktreePath: worktree.worktreePath, worktreeBranch: worktree.worktreeBranch, baseBranch: mergeBase,
      cleanupPending: outcome.status === 'merged' ? outcome.cleanupPending : undefined,
      error: outcome.status === 'conflict' ? outcome.error : undefined,
    });
    if (outcome.status === 'conflict') throw new Error(outcome.error);
  }

  // Skips the Worktree Manager invocation when there is nothing it could manage: non-git
  // projects have no worktrees to set up, and a teardown without a recorded setup has
  // nothing to merge or clean. Returns the completed result when it short-circuited.
  private async shortCircuitWorktreeManager(
    run: AgentTeamRun,
    request: AgentTeamTaskRequest,
    workspaceId: string,
    attemptId: string,
  ): Promise<AgentTeamTaskResult | null> {
    const { taskKey } = request.taskDefinition;
    if (taskKey === 'worktree_setup') {
      const repository = await inspectGitRepository(run.projectDirectory);
      if (repository?.branch) return null;
      this.appendEvent(this.db, run.id, 'task.activity', {
        taskAttemptId: attemptId, taskKey,
        phase: 'worktree.skipped', scope: 'run',
        reason: 'The project directory is not a git repository on a branch; the Run works in place.',
      });
      return this.finishCompletedAttempt(request, workspaceId, attemptId, emptyWorktreeManagerResult());
    }
    if (runWorktreeColumns(run).worktreeBasePath) return null;
    this.appendEvent(this.db, run.id, 'task.activity', {
      taskAttemptId: attemptId, taskKey,
      phase: 'worktree.skipped', scope: 'run',
      reason: 'The Run recorded no worktree setup; there is nothing to tear down.',
    });
    return this.finishCompletedAttempt(request, workspaceId, attemptId, emptyWorktreeManagerResult());
  }

  private async applyWorktreeManagerOutput(
    request: AgentTeamTaskRequest,
    attemptId: string,
    output: string,
    result: ParsedCompletedTaskResult,
  ): Promise<ParsedCompletedTaskResult> {
    const { taskKey } = request.taskDefinition;
    if (taskKey === 'worktree_setup') return this.executeWorktreeSetup(request, attemptId, output, result);
    if (taskKey === 'worktree_teardown') return this.executeWorktreeTeardown(request, attemptId, output, result);
    return result;
  }

  // Validates the declared layout against the fixed naming convention, then creates the base
  // and lane worktrees idempotently and records them on the Run as evidence.
  private async executeWorktreeSetup(
    request: AgentTeamTaskRequest,
    attemptId: string,
    output: string,
    result: ParsedCompletedTaskResult,
  ): Promise<ParsedCompletedTaskResult> {
    const declared = result.worktreeSetup;
    if (!declared) {
      throw new TaskOutputValidationError('The worktree-manager completed worktree_setup without a "worktreeSetup" layout.', output);
    }
    const run = await this.getRun(request.runId);
    const repository = await inspectGitRepository(run.projectDirectory);
    if (!repository?.branch) {
      throw new Error('The Run worktree setup reached execution on a project that is not a git repository on a branch.');
    }
    const expected = expectedRunWorktreeLayout(run, request.developmentAssignments ?? []);
    const problems: string[] = [];
    if (declared.baseWorktreePath !== expected.baseWorktreePath) {
      problems.push(`baseWorktreePath must be exactly ${expected.baseWorktreePath}`);
    }
    if (declared.runBranch !== expected.runBranch) {
      problems.push(`runBranch must be exactly ${expected.runBranch}`);
    }
    const expectedLanes = new Map(expected.lanes.map((lane) => [lane.laneId, lane]));
    const seenLanes = new Set<string>();
    for (const lane of declared.lanes) {
      const expectedLane = expectedLanes.get(lane.laneId);
      if (!expectedLane) {
        problems.push(`lanes must not include unassigned lane ${lane.laneId}`);
        continue;
      }
      seenLanes.add(lane.laneId);
      if (lane.worktreePath !== expectedLane.worktreePath) {
        problems.push(`lane ${lane.laneId} worktreePath must be exactly ${expectedLane.worktreePath}`);
      }
      if (lane.branch !== expectedLane.branch) {
        problems.push(`lane ${lane.laneId} branch must be exactly ${expectedLane.branch}`);
      }
    }
    for (const laneId of expectedLanes.keys()) {
      if (!seenLanes.has(laneId)) problems.push(`lanes is missing lane ${laneId}`);
    }
    if (problems.length > 0) {
      throw new TaskOutputValidationError(`The worktree-manager layout violates the naming convention: ${problems.join('; ')}.`, output);
    }

    await ensureWorktreeAt(run.projectDirectory, expected.baseWorktreePath, expected.runBranch, repository.commit);
    this.appendEvent(this.db, run.id, 'task.activity', {
      taskAttemptId: attemptId, taskKey: 'worktree_setup',
      phase: 'worktree.prepared', scope: 'run',
      worktreePath: expected.baseWorktreePath, worktreeBranch: expected.runBranch, baseBranch: repository.branch,
    });
    for (const lane of expected.lanes) {
      await ensureWorktreeAt(run.projectDirectory, lane.worktreePath, lane.branch, expected.runBranch);
      this.appendEvent(this.db, run.id, 'task.activity', {
        taskAttemptId: attemptId, taskKey: 'worktree_setup',
        phase: 'worktree.prepared', scope: 'lane', laneId: lane.laneId,
        worktreePath: lane.worktreePath, worktreeBranch: lane.branch, baseBranch: expected.runBranch,
      });
    }
    // The Run carries its worktree evidence for the Web view and for conflict/failure reports.
    // The columns land with the packages/db lane; bridged until that merge.
    await this.db.update(coderRuns).set({
      worktreeBasePath: expected.baseWorktreePath,
      runBranch: expected.runBranch,
      updatedAt: new Date(),
    } as Partial<typeof coderRuns.$inferInsert>).where(eq(coderRuns.id, run.id)).run();

    const worktreeSetup: WorktreeSetupPlan = {
      baseWorktreePath: expected.baseWorktreePath,
      runBranch: expected.runBranch,
      originalBranch: repository.branch,
      lanes: expected.lanes.map((lane) => ({ ...lane })),
    };
    return { ...result, worktreeSetup };
  }

  // Executes the teardown decision: merge the Run branch back into the project's original
  // branch and clean up, or retain everything with a reason. A merge conflict fails the
  // attempt, which fails the Run and retains all worktrees and branches as evidence.
  private async executeWorktreeTeardown(
    request: AgentTeamTaskRequest,
    attemptId: string,
    output: string,
    result: ParsedCompletedTaskResult,
  ): Promise<ParsedCompletedTaskResult> {
    const declared = result.worktreeTeardown;
    if (!declared) {
      throw new TaskOutputValidationError('The worktree-manager completed worktree_teardown without a "worktreeTeardown" decision.', output);
    }
    const run = await this.getRun(request.runId);
    const columns = runWorktreeColumns(run);
    if (!columns.worktreeBasePath || !columns.runBranch) return result;
    const worktreeBasePath = columns.worktreeBasePath;
    const runBranch = columns.runBranch;

    if (declared.action === 'retain') {
      this.appendEvent(this.db, run.id, 'task.activity', {
        taskAttemptId: attemptId, taskKey: 'worktree_teardown',
        phase: 'worktree.retained', scope: 'run',
        worktreePath: worktreeBasePath, worktreeBranch: runBranch,
        reason: declared.reason ?? null,
      });
      return result;
    }

    const originalBranch = await this.runOriginalBranch(run.id);
    if (!originalBranch) {
      throw new Error(`The Run worktree setup result is missing the original branch; worktree ${worktreeBasePath} and branch ${runBranch} are retained.`);
    }
    const outcome = await enqueueTaskMerge(run.projectDirectory, originalBranch, () => mergeTaskWorktree({
      projectDirectory: run.projectDirectory,
      worktreePath: worktreeBasePath,
      worktreeBranch: runBranch,
      baseBranch: originalBranch,
    }).catch((error: unknown): { status: 'conflict'; error: string } => ({
      status: 'conflict',
      error: `自动合并 Run 分支 ${runBranch} 时出现意外错误（${error instanceof Error ? error.message : String(error)}）；worktree ${worktreeBasePath} 与分支已保留，请手动合并后清理。`,
    })));
    this.appendEvent(this.db, run.id, 'task.activity', {
      taskAttemptId: attemptId, taskKey: 'worktree_teardown',
      phase: outcome.status === 'merged' ? 'worktree.merged' : 'worktree.merge_conflict',
      scope: 'run',
      worktreePath: worktreeBasePath, worktreeBranch: runBranch, baseBranch: originalBranch,
      cleanupPending: outcome.status === 'merged' ? outcome.cleanupPending : undefined,
      error: outcome.status === 'conflict' ? outcome.error : undefined,
    });
    if (outcome.status === 'conflict') throw new Error(outcome.error);
    return result;
  }

  // The original branch is captured by the setup task result so teardown never guesses.
  private async runOriginalBranch(runId: string): Promise<string | null> {
    const [setup] = await this.db.select({ result: coderTaskAttempts.result })
      .from(coderTaskAttempts)
      .where(and(
        eq(coderTaskAttempts.runId, runId),
        eq(coderTaskAttempts.taskKey, 'worktree_setup'),
        eq(coderTaskAttempts.status, 'completed'),
        eq(coderTaskAttempts.active, true),
      ))
      .orderBy(desc(coderTaskAttempts.attemptIndex))
      .limit(1);
    const worktreeSetup = (setup?.result as AgentTeamWorktreeTaskResult | null | undefined)?.worktreeSetup;
    return typeof worktreeSetup?.originalBranch === 'string' && worktreeSetup.originalBranch
      ? worktreeSetup.originalBranch
      : null;
  }

  private async readCapturedProcessFile(version: AgentTeamVersion, path: string): Promise<string> {
    const file = version.snapshot.processFiles.find((candidate) => candidate.path === path);
    if (!file) throw new Error(`Process reference ${path} was not captured by this Coder version.`);
    return file.content;
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
    const [created] = await this.db.insert(coderTaskAttempts).values({
      id: attemptId,
      workspaceId: run.workspaceId,
      runId: run.id,
      taskKey,
      attemptIndex: (existing?.attemptIndex ?? 0) + 1,
      role,
      status: 'running',
      inputRevision: request,
      inputFingerprint,
      developerId: request.developerId ?? null,
      assignmentTitle: request.assignment?.title ?? null,
      startedAt: now,
    }).returning();
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
          recipientRole: request.taskDefinition.role,
          kind: 'question',
          body: result.pendingInput.question,
          runId: request.runId,
          taskAttemptId: attemptId,
          repositoryIds: request.assignment?.repositoryIds ?? run.repositoryIds,
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
      if (request.taskDefinition.role === CODER_DISPATCHER_ROLE && result.dispatchDecision) {
        transaction.update(coderRuns).set({
          mode: result.dispatchDecision.mode,
          modeRationale: result.dispatchDecision.rationale,
          modeDecidedAt: now,
          updatedAt: now,
        }).where(eq(coderRuns.id, request.runId)).run();
      }
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
          recipientRole: result.handoff?.role,
          kind: result.handoff ? 'handoff' : 'text',
          body,
          runId: request.runId,
          taskAttemptId: attemptId,
          repositoryIds: request.assignment?.repositoryIds ?? run.repositoryIds,
          fileReferences,
        });
      }
      this.appendProgressIfChanged(transaction, request.runId);
    });
    await this.deliverDocuments(request.runId);
    return result;
  }

  private async requestPause(runId: string): Promise<void> {
    await this.db.update(coderRuns).set({
      desiredControlState: 'pause_requested',
      updatedAt: new Date(),
    }).where(eq(coderRuns.id, runId)).run();
    await this.appendEvent(this.db, runId, 'run.status', { status: 'pause_requested' });
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
        ...(row.developerId ? { developerId: row.developerId } : {}),
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

  private async finishSuccessfulRun(runId: string, result: AgentTeamGraphResult): Promise<void> {
    const outcome: AgentTeamRunOutcome = {
      summary: result.mode === 'plan_only'
        ? 'Planning and test design completed.'
        : result.mode === 'validate_existing'
          ? 'Existing implementation validation completed.'
          : 'Implementation and validation completed.',
      unresolvedIssues: [...result.unresolvedIssues],
      criterionAssessments: [...result.criterionAssessments],
    };
    const now = new Date();
    const committed = await this.transaction((transaction) => {
      const [desired] = transaction.select({ desiredControlState: coderRuns.desiredControlState })
        .from(coderRuns)
        .where(eq(coderRuns.id, runId))
        .limit(1).all();
      if (desired?.desiredControlState === 'cancel_requested') return false;
      const rows = transaction.update(coderRuns).set({
        status: 'succeeded',
        outcome,
        desiredControlState: 'none',
        updatedAt: now,
        finishedAt: now,
      }).where(and(
        eq(coderRuns.id, runId),
        ne(coderRuns.desiredControlState, 'cancel_requested'),
      )).returning().all();
      if (rows.length === 0) return false;
      this.appendEvent(transaction, runId, 'run.status', { status: 'succeeded', outcome });
      return true;
    });
    if (committed) {
      // A terminal Run frees its parallel slot; start the earliest queued Run (FIFO).
      const [run] = await this.db.select({ coderId: coderRuns.coderId }).from(coderRuns)
        .where(eq(coderRuns.id, runId)).limit(1);
      if (run) await this.maybeStartQueuedRuns(run.coderId);
      return;
    }
    if (await this.getDesiredControlState(runId) !== 'cancel_requested') return;
    await this.failActiveAttempts(runId, 'cancelled', 'The Coder run was cancelled.');
    await this.finishCancelledRun(runId);
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
      summary: state.handoffLimitReached
        ? 'Stopped after the automatic handoff limit; the group can continue with a new message.'
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
        if (state.handoffLimitReached) {
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
      kind: 'text' | 'question' | 'handoff' | 'control' | 'status' | 'file';
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
  if (!['dispatcher', 'planner', 'test_designer', 'developer', 'test_author', 'test_runner', 'reviewer', 'worktree-manager'].includes(role)) return [];
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

function initialGraphState(run: AgentTeamRun, outputDirectory: string): AgentTeamGraphState {
  return {
    runId: run.id,
    intent: run.intent,
    mode: run.mode,
    projectDirectory: run.projectDirectory,
    outputDirectory,
    scopeRevision: run.scopeRevision,
    projectInstructions: run.projectInstructions,
    documents: [],
    unresolvedIssues: [],
    commandIds: [],
    criterionAssessments: [],
    taskResults: {},
    pendingInput: null,
    activeTaskKey: null,
    taskAnswers: {},
    taskPendingInputIds: {},
    repairRound: 0,
    repairInstruction: null,
    repairRequest: undefined,
    continueRepair: false,
  };
}

function ensureProjectionAttempt(
  db: Database | AgentTeamDatabaseTransaction,
  run: AgentTeamRun,
  taskKey: string,
  documents: readonly AgentTeamDocument[],
  taskResult: Extract<AgentTeamTaskResult, { status: 'completed' }> | undefined,
): string {
  const [existing] = db.select().from(coderTaskAttempts)
    .where(and(eq(coderTaskAttempts.runId, run.id), eq(coderTaskAttempts.taskKey, taskKey)))
    .orderBy(desc(coderTaskAttempts.attemptIndex))
    .limit(1).all();
  const now = new Date();
  if (existing) {
    if (existing.status !== 'completed') {
      const previousResult = existing.result as Partial<Extract<AgentTeamTaskResult, { status: 'completed' }>> | null;
      const result = projectedTaskResult(
        taskResult,
        previousResult,
        documents.filter((document) => document.producingTaskKey === taskKey),
      );
      db.update(coderTaskAttempts).set({
        status: 'completed',
        result,
        error: null,
        finishedAt: now,
      }).where(eq(coderTaskAttempts.id, existing.id)).run();
    }
    return existing.id;
  }

  const id = `atask_${randomUUID()}`;
  db.insert(coderTaskAttempts).values({
    id,
    workspaceId: run.workspaceId,
    runId: run.id,
    taskKey,
    attemptIndex: 1,
    role: roleForTaskKey(taskKey),
    status: 'completed',
    inputRevision: { source: 'langgraph-checkpoint', taskKey },
    inputFingerprint: fingerprint({ source: 'langgraph-checkpoint', runId: run.id, taskKey }),
    result: projectedTaskResult(
      taskResult,
      null,
      documents.filter((document) => document.producingTaskKey === taskKey),
    ),
    startedAt: now,
    finishedAt: now,
  }).run();
  return id;
}

function projectedTaskResult(
  taskResult: Extract<AgentTeamTaskResult, { status: 'completed' }> | undefined,
  previousResult: Partial<Extract<AgentTeamTaskResult, { status: 'completed' }>> | null,
  documents: AgentTeamDocument[],
): Extract<AgentTeamTaskResult, { status: 'completed' }> {
  if (taskResult) return { ...taskResult, documents };
  return {
    status: 'completed',
    documents,
    unresolvedIssues: Array.isArray(previousResult?.unresolvedIssues) ? previousResult.unresolvedIssues : [],
    commandIds: Array.isArray(previousResult?.commandIds) ? previousResult.commandIds : [],
    changedFiles: Array.isArray(previousResult?.changedFiles) ? previousResult.changedFiles : [],
    completedAssignedWork: previousResult?.completedAssignedWork === true,
    criterionAssessments: Array.isArray(previousResult?.criterionAssessments) ? previousResult.criterionAssessments : [],
  };
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

function versionDeveloperIds(snapshot: StoredAgentTeamVersionSnapshot): string[] {
  const developerRole = snapshot.roles.find((role) => role.role === 'developer');
  return [
    RESERVED_DEVELOPER_ID,
    ...(developerRole?.developerInstances ?? []).map((instance) => instance.developerId),
  ];
}

// Default persisted configuration for one predefined Coder role.
function defaultRoleConfiguration(role: AgentTeamRuntimeRole): StoredAgentTeamRoleConfiguration {
  const manifest = getBmadTeaProcessManifest();
  return {
    role: agentTeamContractRole(role) as StoredAgentTeamRoleConfiguration['role'],
    ...(role === 'executor-manager' ? { displayName: 'Executor Manager' } : role === CODER_DISPATCHER_ROLE ? { displayName: 'Dispatcher' } : {}),
    publicModelId: '',
    instructions: CODER_ROLE_INSTRUCTIONS[role] ?? `You are the ${role} role in the Coder. Complete the addressed task and report the result clearly.`,
    entryPoints: manifest.entryPoints[role] ?? [],
    skills: [],
    mcpServers: [],
    toolNames: [...(CODER_ROLE_TOOL_NAMES[role] ?? [])],
  };
}


function taskAttribution(request: AgentTeamTaskRequest): { developerId?: string; assignmentTitle?: string } {
  return {
    ...(request.developerId ? { developerId: request.developerId } : {}),
    ...(request.assignment?.title ? { assignmentTitle: request.assignment.title } : {}),
  };
}

function developerPromptAddition(request: AgentTeamTaskRequest): string | undefined {
  const sections: string[] = [];
  if (request.assignment) {
    sections.push([
      `This development fan-out is executed by multiple Developers in parallel. You are Developer "${request.developerId ?? RESERVED_DEVELOPER_ID}", responsible only for the assignment "${request.assignment.title}".`,
      `Assignment scope: ${request.assignment.scopeSummary}`,
      request.assignment.ownedPaths.length > 0
        ? `You may only create or modify files under: ${request.assignment.ownedPaths.join(', ')}. Another Developer owns every other path; do not modify files outside your owned paths.`
        : 'The assignment declares no owned paths; limit your changes to the assignment scope.',
    ].join('\n'));
  }
  const siblingResults = request.siblingResults ? Object.entries(request.siblingResults) : [];
  if (siblingResults.length > 0) {
    sections.push([
      'Other Developers already completed their assignments. Respect their committed work and do not undo it:',
      ...siblingResults.map(([developerId, result]) => [
        `- ${developerId}: changed files ${result.changedFiles.join(', ') || '(none)'}`,
        result.unresolvedIssues.length > 0 ? `; unresolved issues: ${result.unresolvedIssues.join('; ')}` : '',
      ].join('')),
    ].join('\n'));
  }
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

export function rolePromptAddition(
  role: AgentTeamRuntimeRole,
  snapshot: StoredAgentTeamVersionSnapshot,
  request?: AgentTeamTaskRequest,
): string | undefined {
  const orchestrationVersion: number = snapshot.orchestrationVersion ?? 1;
  if (orchestrationVersion === 6 || orchestrationVersion === 7 || orchestrationVersion === 8 || orchestrationVersion === 9 || orchestrationVersion === 10 || orchestrationVersion === 11) {
    const projectGitPolicy = (orchestrationVersion === 9 || orchestrationVersion === 10 || orchestrationVersion === 11) && snapshot.roles.some((item) => item.role === role && (role === 'planner' || item.role === 'developer' || item.executor))
      ? snapshot.projectGitPolicy?.trim()
      : '';
    return [
      'This is a message addressed to your one configured Coder role. Complete the stated goal or ask one specific question when blocked.',
      'Follow the user\'s explicit instructions and the target repository\'s applicable instructions before team defaults. Do not assume a base branch, worktree location, commit, merge, push, or cleanup is required; determine the appropriate Git actions from the actual state and authorization.',
      ...(role === 'planner' ? [
        'Choose the depth of planning and any subsequent roles from the actual task, user instructions, repository requirements, and roles available in this team. A small, low-risk change needs only a focused plan and necessary handoff; involve additional configured review or testing roles only when required or useful. Respect an explicitly requested workflow. Do not invent roles or assign verification to a role whose configuration prohibits it.',
        'For structural exploration, use an available code index appropriate to the target when it covers the relevant paths; check coverage and freshness, then read missing or stale source directly. Once an index is known not to cover a repository, do not repeatedly query it for that repository. Use evidence already collected and do not repeatedly write or search memory for the same task.',
        'After reasonable investigation, deliver the requested plan or result as soon as material decisions are supported. State non-blocking assumptions and unresolved uncertainties; ask only when a missing answer changes a material decision. Preserve prior user decisions and approval. Give a concise progress update if work is prolonged.',
        'Scale investigation to the actual request. Identify its distinct questions and evidence needed for each; answer a capability question from its defining implementation and relevant entry points before exploring downstream effects. Investigate migration, historical references, or exhaustive impact only to the extent requested or necessary to answer.',
        'Use targeted searches and bounded file excerpts. Combine independent patterns for the same path in one grep using regex alternation; use read startLine/endLine for focused excerpts. Start with likely definitions and callers; narrow by path and symbol before expanding. Avoid repeatedly scanning or reading the same large file when existing evidence already answers the question. If output is truncated, narrow the query rather than assuming absence.',
        'Stop investigating each question when its requested scope is supported by sufficient evidence. Satisfy every explicit requirement, including an explicitly requested exhaustive impact analysis; do not silently narrow the request or claim completeness without evidence. State any remaining uncertainty and its effect.',
        'For a request that only asks for read-only investigation or an answer, report the findings in the required Planner document and omit implementation handoff, proposed code changes, and Git or worktree decisions unless the user requested them. Do not perform changes or validation commands prohibited by the user.',
        'Issue independent tool calls together in the same round instead of one call per round. Each round resends the whole conversation, so the number of rounds drives cost.',
        'When the request already states the root cause, the plan, or the exact edits, do not re-investigate them. Confirm at most that the named files and symbols exist, then write the deliverable and hand off.',
        ...(snapshot.roles.some((item) => item.executor) ? [
          'When handing implementation to the implementation role, deliver a plan document it can execute without its own investigation: the goal and the decisions with brief reasons; a change list naming each file path, the function, component or symbol, and the intended change; what must not change; risks; and acceptance criteria. Investigate until those decisions and locations are supported, then stop. Do not read whole implementations only to restate them, and do not write complete code or diffs unless the exact edit is itself the decision.',
        ] : []),
      ] : []),
      ...(role === snapshot.roles.find((item) => item.executor)?.role && role !== 'planner' ? [
        'When a Planner plan document is handed to you, treat it as the decided scope. Read only the files and symbols it names before editing them. Do not search the repository broadly, re-investigate its findings, or re-verify its decisions. If the code differs from the plan, apply the change only when the plan\'s intent at that location is unambiguous; otherwise leave it unchanged and report the mismatch in unresolvedIssues instead of investigating further.',
      ] : []),
      `To pass work onward, include a handoff object with a role id captured by this Coder version and a specific goal. Omit handoff when your work is complete or you are waiting for the user.`,
      `Captured role ids (use the id exactly in handoff.role, not the display name): ${snapshot.roles.map((item) => {
        const label = item.displayName?.trim();
        const tags = [label && label !== item.role ? `display name "${label}"` : '', item.executor ? 'implementation role' : ''].filter(Boolean);
        return tags.length ? `${item.role} (${tags.join(', ')})` : item.role;
      }).join('; ')}.`,
      (() => {
        const implementationRole = snapshot.roles.find((item) => item.executor)?.role;
        return role === implementationRole
          ? `Split by default whenever the work touches multiple distinct files, modules or components, even within what reads as a single task; return up to four developmentAssignments with non-overlapping ownedPaths and optional repositoryIds, and hand off to ${implementationRole}. WorkLite runs those assignments in parallel using this same captured ${implementationRole} configuration. Keep a single assignment only when the pieces are tightly coupled and cannot be verified independently; when in doubt, split rather than bundle.`
          : implementationRole
            ? `When assigning implementation work to the single configured ${implementationRole} role, split the request into separate developmentAssignments by default whenever it touches multiple distinct files, modules or components, even within what reads as a single task (for example a UI or code change and a separate documentation or configuration change, or changes to unrelated files or components, or several files that each need their own edit within one larger change); each assignment must state its repository scope and non-overlapping paths. Keep a single assignment only when the pieces are tightly coupled and cannot be verified independently: the same edit depends on another change in the same file or component, or splitting would leave an assignment unable to typecheck, build or be tested on its own. When in doubt, split rather than bundle.`
            : '';
      })(),
      request?.projectDirectory?.trim()
        ? ''
        : 'This task has no bound project directory yet. Identify the absolute project directory from the message, the Coder\'s known repositories listed in the task context, Coder memories, or working practice, and return identified directories as "repositoryDirectories":["/absolute/path"] in the completed response; WorkLite registers them as group repositories and binds them to this Run. If you cannot determine the directory, return waiting_for_input with one specific question asking the user for the absolute project directory.',
      'Return a concise user-facing message in the message field. Put complete written deliverables in documents and refer to their file versions; the next role receives file references and can read them on demand with read_coder_document (or through the materialized reference files as Developer).',
      ...(projectGitPolicy ? [`Coder project Git policy:\n${projectGitPolicy}`] : []),
      ...(orchestrationVersion >= 10 && role === CODER_DISPATCHER_ROLE ? [
        `You are the initial Dispatcher for this Run. Decide its execution mode from the original request and the actual project context; the user does not select a mode. Captured roles: ${snapshot.roles.map((item) => item.role).join(', ')}.`,
        'Allowed modes: plan_only (investigate and plan without changing project files), validate_existing (assess or test existing behavior without implementing changes), implement_and_validate (change project files and verify the result).',
        'Choose the least invasive mode that fully satisfies the request. Choose implement_and_validate only when the request clearly requires project changes. If the request is ambiguous and could change production code, return exactly one focused waiting_for_input question; otherwise decide immediately and do not ask the user to choose a mode.',
        'Return dispatchDecision with the chosen mode and a one-sentence rationale. Hand off to planner for plan_only or implement_and_validate, and to test_designer for validate_existing; WorkLite enforces this route.',
        'Include dispatchDecision in the completed JSON, for example: {"status":"completed","message":"...","documents":[],"unresolvedIssues":[],"changedFiles":[],"completedAssignedWork":true,"criterionAssessments":[],"dispatchDecision":{"mode":"plan_only","rationale":"..."},"handoff":{"role":"planner","goal":"..."}}.',
      ] : []),
    ].filter(Boolean).join('\n');
  }
  if (orchestrationVersion === 3 || orchestrationVersion === 4 || orchestrationVersion === 5) {
    if (orchestrationVersion === 5 && role === 'planner') {
      return [
        `This Coder Run may use up to ${DEVELOPER_LANE_IDS.length} Developers working in parallel; decide how many the task actually needs.`,
        'The supplied projectDirectory is a workspace root. It may contain several repositories, project directories, or none at the root; identify the relevant project roots before planning and do not assume the workspace root is one Git repository.',
        'For every development assignment, name the relevant project directory in its title or scopeSummary and use ownedPaths relative to the supplied workspace root, including the project path prefix. Keep ownedPaths non-overlapping across all assignments.',
        'The Worktree Manager will provide an advisory per-project Git strategy. Do not require a branch or worktree for every project.',
        'To split the implementation, add "developmentAssignments":[{"title":"...","scopeSummary":"...","ownedPaths":["path/or/prefix"]}] to the completed response. Assignments carry no developerId and map to Developers in order; omit the field when a single Developer suffices.',
      ].join('\n');
    }
    if (role === 'planner') {
      return [
        `This Coder Run may use up to ${DEVELOPER_LANE_IDS.length} Developers working in parallel; decide how many the task actually needs.`,
        'To split the implementation, add "developmentAssignments":[{"title":"...","scopeSummary":"...","ownedPaths":["path/or/prefix"]}] to the completed response. Assignments carry no developerId and map to Developers in order, their ownedPaths must not overlap, and each Developer must receive an independent, self-contained slice. Omit the field when a single Developer suffices.',
      ].join('\n');
    }
    if (role === 'reviewer') {
      return [
        'Development may have been executed by multiple Developers in parallel; each development result names its Developer.',
        'To request repairs, add "repairRequests":[{"developerId":"...","instruction":"specific repair instruction"}] targeting only the Developers that must change their own work. Do not use the legacy repairRequest field.',
      ].join('\n');
    }
    if (orchestrationVersion === 5 && role === 'developer') {
      return [
        'The supplied projectDirectory is a workspace root and may contain multiple independent repositories. Inspect each assigned project and its local instructions before acting.',
        'Choose per project whether to stay on its current branch, switch to or create a feature branch, or use a worktree. The Worktree Manager document is advice; adjust it when the actual repository state or assigned work calls for a different choice.',
        'A worktree is scoped to one project, never the whole multi-project workspace. WorkLite does not create or merge worktrees or branches for this Run. Use your native tools for any Git operations you decide to perform. If you select a worktree, decide whether and when to integrate its changes so later Coder roles can inspect and test them. Include projectGitDecisions in the completed response, with one entry per affected project: {"projectPath":"workspace-relative/path","strategy":"no_git|current_branch|feature_branch|worktree","branch":"optional","worktreePath":"optional"}. Report the selected strategy, branch or worktree path, and outcome.',
      ].join('\n');
    }
    if (orchestrationVersion === 5 && role === 'worktree-manager' && request?.taskDefinition.taskKey === 'worktree_setup') {
      return projectStrategyPlannerPromptAddition(request);
    }
    if (orchestrationVersion === 4 && role === 'worktree-manager' && request) {
      return worktreeManagerPromptAddition(request);
    }
    return undefined;
  }
  const developerIds = versionDeveloperIds(snapshot);
  if (developerIds.length < 2) return undefined;
  if (role === 'planner') {
    return [
      `This Coder Run is developed by ${developerIds.length} Developers in parallel: ${developerIds.join(', ')}.`,
      'Split the implementation into one development assignment per Developer and add "developmentAssignments":[{"developerId":"...","title":"...","scopeSummary":"...","ownedPaths":["path/or/prefix"]}] to the completed response.',
      'Assignments must not overlap: no two assignments may own the same path. Give each Developer an independent, self-contained slice and use every listed Developer exactly once.',
    ].join('\n');
  }
  if (role === 'reviewer') {
    return [
      'Development was executed by multiple Developers in parallel; each development result names its Developer.',
      'To request repairs, add "repairRequests":[{"developerId":"...","instruction":"specific repair instruction"}] targeting only the Developers that must change their own work. Do not use the legacy repairRequest field.',
    ].join('\n');
  }
  return undefined;
}

function projectStrategyPlannerPromptAddition(_request: AgentTeamTaskRequest): string {
  return [
    'For orchestration v5, this is an advisory strategy-planning task. It supersedes any older task-goal or role instruction that describes WorkLite-created worktrees or teardown. The supplied projectDirectory is a workspace root that may contain multiple projects and repositories; inspect the workspace and the Planner assignments without assuming the root itself is a Git repository.',
    'Return a document with key "project_workspace_strategy" and title "Project workspace strategy". In its content, list each affected project directory and recommend one of: work in the current branch, switch to or create a feature branch, or use a worktree for that project. Explain the choice briefly in light of the assigned work and parallel Developers.',
    'A worktree recommendation applies to its project only, never to the entire workspace. No Git action is required or authorized by this recommendation. Developers inspect actual repository state and may choose another strategy. WorkLite will not create, merge, or clean up branches or worktrees for this Run.',
    'Do not return worktreeSetup or worktreeTeardown fields. Complete with the strategy document in documents; report uncertainty as an unresolved issue rather than inventing repository state.',
  ].join('\n');
}

// The Worktree Manager plans with exact values; the runtime validates them against this same
// convention before executing any git effect.
function worktreeManagerPromptAddition(request: AgentTeamTaskRequest): string {
  const projectName = basename(request.projectDirectory);
  const baseWorktreePath = join(dirname(request.projectDirectory), `${projectName}-run-${request.runId}`);
  const runBranch = `worklite/run-${request.runId}`;
  const lanes = (request.developmentAssignments ?? []).map((assignment) => ({
    laneId: assignment.developerId,
    worktreePath: `${baseWorktreePath}-dev-${assignment.developerId}`,
    branch: `${runBranch}-dev-${assignment.developerId}`,
  }));
  const setup = [
    'For the worktree_setup task, add a "worktreeSetup" object to the completed response with exactly these values (the runtime validates them and creates the worktrees idempotently):',
    `"worktreeSetup":{"baseWorktreePath":${JSON.stringify(baseWorktreePath)},"runBranch":${JSON.stringify(runBranch)},"lanes":[${lanes.map((lane) => `{"laneId":${JSON.stringify(lane.laneId)},"worktreePath":${JSON.stringify(lane.worktreePath)},"branch":${JSON.stringify(lane.branch)}}`).join(',')}]}`,
  ].join('\n');
  const teardown = [
    'For the worktree_teardown task, add "worktreeTeardown":{"action":"merge-and-cleanup"} to the completed response to merge the Run branch back into the project\'s original branch and remove the Run worktrees, or "worktreeTeardown":{"action":"retain","reason":"..."} to keep every worktree and branch when the evidence says something is wrong.',
    'A merge conflict, failure, or interruption retains ALL worktrees and branches automatically and reports them as Run evidence; only choose "retain" when the review evidence itself demands it.',
  ].join('\n');
  return [
    'This Coder Run manages its git worktrees through you. You never run git commands: your validated structured output is executed by the runtime.',
    setup,
    teardown,
  ].join('\n\n');
}

function taskSystemPrompt(instructions: string, executor: boolean, addition?: string): string {
  const prompt = `${instructions}

You are executing one WorkLite Coder task. Use tools only when the captured role configuration and project authorization permit them. Return exactly one JSON object whose "status" is exactly one of: "waiting_for_input", "completed".

Follow the captured project instructions supplied in the task context, and discover additional applicable AGENTS.md or AGENTS_WORKFLOW.md files before changing or assessing project files. If a project rule or missing user decision requires explicit authorization for an action, return the waiting_for_input response instead of taking that action. ${executor ? 'You run as a project executor in the project directory with your own native tools. WorkLite requires neither proposal confirmation nor exact-command grants. A previous attempt may have changed the project; inspect its actual state rather than assuming earlier work is absent or complete. Read pinned process references from the files listed in the system prompt.' : 'Run whatever shell commands the task needs with bash directly; WorkLite requires no command grant and records every execution as Command evidence. Use process_reference only with one of the exact pinned paths listed in the system prompt.'} Map the process package's project root to projectDirectory and its process output location to outputDirectory. The output directory is managed by WorkLite: return documents in JSON rather than writing planning output there directly.

Scale investigation and verification to the task. Use supplied handoff evidence to target the necessary checks; expand investigation only when evidence is missing or conflicts with the current code. Avoid repeating equivalent searches or checks without a new reason. Report unrelated baseline failures rather than repeatedly rerunning them or changing unrelated code.

When more user input is required, return:
{"status":"waiting_for_input","pendingInput":{"question":"One specific question"}}

Otherwise return:
{"status":"completed","message":"Concise user-facing update","documents":[{"key":"stable-document-key","title":"Document title","content":"Document content","upstreamDocumentKeys":["optional-upstream-key"]}],"unresolvedIssues":["specific unresolved issue"],"changedFiles":["path/to/changed/file"],"completedAssignedWork":true,"criterionAssessments":[{"criterion":"criterion","assessment":"met|unmet|not_verified","evidence":["evidence reference"]}],"developmentAssignments":[{"title":"...","scopeSummary":"...","ownedPaths":["..."],"repositoryIds":["repo-id"]}],"handoff":{"role":"reviewer","goal":"Review the completed implementation","repositoryIds":["repo-id"]}}

Use an empty changedFiles array when the task changed no project files. Set completedAssignedWork to false only when the assigned work remains incomplete, and record the reason in unresolvedIssues. The reviewer may add "repairRequest":{"taskKey":"development","instruction":"specific repair instruction"}. Do not invent command ids; WorkLite records actual command evidence.`;
  return addition ? `${prompt}\n\n${addition}` : prompt;
}

function teamManagerSystemPrompt(addition?: string): string {
  const prompt = [
    'You are Executor Manager, a narrowed Chat Agent inside one Coder group.',
    'Use only the supplied Coder management tools to inspect or change that Coder’s configuration, roles, and Coder memories.',
    'You cannot see project paths, read or modify project files, run Commands, use Skills, call MCP servers, use Chat memory, or manage unrelated WorkLite resources.',
    'The Executor Manager role cannot be deleted. Configuration changes apply to future Runs; this Run keeps its captured Coder version.',
    'Return exactly one JSON object whose status is "completed" or "waiting_for_input". For a completed result include message, documents:[], unresolvedIssues:[], changedFiles:[], completedAssignedWork:true, and criterionAssessments:[]. Keep the user-facing message concise and report tool outcomes accurately.',
  ].join('\n');
  return addition ? `${prompt}\n\n${addition}` : prompt;
}

export function isGroupOrchestrationVersion(version: number | undefined): version is 6 | 7 | 8 | 9 | 10 | 11 {
  return version === 6 || version === 7 || version === 8 || version === 9 || version === 10 || version === 11;
}

// v10 and older roles have no Coder memory tool surface; v11 gives every ordinary
// work role the managed search/read/write/update tools.
export function roleMemoryManagedToolsEnabled(orchestrationVersion: number | undefined, taskRole: string): boolean {
  return (orchestrationVersion ?? 0) >= ROLE_MEMORY_TOOLS_VERSION && taskRole !== 'executor-manager';
}

function taskContext(request: AgentTeamTaskRequest, executor: boolean, correction?: string): unknown {
  if (request.taskDefinition.role === 'executor-manager') {
    return {
      ...(correction ? { correction } : {}),
      task: request.taskDefinition,
      intent: request.intent,
      taskGroup: {
        groupId: request.groupContext?.groupId,
        addressedMessage: request.groupMessage ?? request.groupContext?.initialMessage,
        transcriptPolicy: 'Only this addressed request is model context. Use the Coder tools to read Coder configuration or memory.',
      },
    };
  }
  const selectedRepositoryIds = request.assignment?.repositoryIds?.length
    ? request.assignment.repositoryIds
    : request.groupContext?.repositories.map((repository) => repository.id) ?? [];
  const selectedRepositorySet = new Set(selectedRepositoryIds);
  const selectedRepositories = request.groupContext?.repositories.filter((repository) => selectedRepositorySet.has(repository.id)) ?? [];
  return {
    ...(correction ? { correction } : {}),
    task: {
      ...request.taskDefinition,
      mode: request.mode,
      scopeRevision: request.scopeRevision,
      ...(request.pendingInputId ? { pendingInputId: request.pendingInputId } : {}),
      ...(request.answer ? { answer: request.answer } : {}),
      ...(request.repairInstruction ? { repairInstruction: request.repairInstruction } : {}),
    },
    intent: request.intent,
    projectDirectory: request.projectDirectory,
    outputDirectory: request.outputDirectory,
    authorization: modeAuthorization(request.mode, request.taskDefinition.role),
    projectInstructions: request.projectInstructions,
    upstreamDocuments: request.upstream,
    ...(request.assignment ? { assignment: request.assignment } : {}),
    ...(request.developmentAssignments ? { developmentAssignments: request.developmentAssignments } : {}),
    ...(request.siblingResults && Object.keys(request.siblingResults).length > 0
      ? {
        siblingResults: Object.fromEntries(Object.entries(request.siblingResults).map(([developerId, result]) => [
          developerId,
          {
            changedFiles: result.changedFiles,
            unresolvedIssues: result.unresolvedIssues,
            completedAssignedWork: result.completedAssignedWork,
          },
        ])),
      }
      : {}),
    ...(request.groupContext ? {
      taskGroup: {
        groupId: request.groupContext.groupId,
        originalRequest: request.groupContext.initialMessage,
        addressedMessage: request.groupMessage ?? request.groupContext.initialMessage,
        explicitHandoffSummary: request.handoffSummary || undefined,
        fileReferences: request.fileReferences ?? [],
        repositories: selectedRepositories.map(({ id, name, directory }) => ({ id, name, directory })),
        ...(request.groupContext.knownRepositories?.length
          ? { knownRepositories: request.groupContext.knownRepositories }
          : {}),
        transcriptPolicy: 'The group transcript is visible to the user but omitted here. Only this request and explicitly handed-off context belong to your input.',
      },
    } : {}),
  };
}

export function groupRolePromptAddition(
  snapshot: StoredAgentTeamVersionSnapshot,
  request: AgentTeamTaskRequest,
): string | undefined {
  if (!request.groupContext || !isGroupOrchestrationVersion(snapshot.orchestrationVersion)) return undefined;
  const isInitiallyAddressedRole = request.taskDefinition.taskKey === `group_0_${request.groupContext.targetRole}`;
  // v11 roles can search, read and write Coder memory. The initially addressed role
  // keeps the full captured projection; every other role gets a bounded index.
  if (snapshot.orchestrationVersion === 11) {
    const workingPractice = snapshot.workingPractice?.trim();
    const memories = request.groupContext.memories ?? [];
    const repositories = request.groupContext.repositories.map((repository) => ({
      memoryRepositoryId: repository.memoryRepositoryId,
      name: repository.name,
    }));
    const fullProjection = teamMemoryProjection(memories);
    const index = buildTeamMemoryIndex(memories, {
      goal: request.intent || request.groupContext.initialMessage,
      repositories,
    });
    return [
      isInitiallyAddressedRole
        ? 'This is the initially addressed role for a Chat-dispatched Coder Run. Use the captured Coder context to guide this request.'
        : 'This is a work role inside a Chat-dispatched Coder Run. Use the captured Coder context to guide this request.',
      ...(isInitiallyAddressedRole && workingPractice ? [`Coder working practice:\n${workingPractice}`] : []),
      ...(isInitiallyAddressedRole
        ? [
          ...(fullProjection ? [`Coder memories:\n${fullProjection}`] : []),
          'Coder memory tools are available: coder_memory_search, coder_memory_read, coder_memory_write and coder_memory_update. A memory you save applies immediately to later searches and is projected into the next dispatch.',
          'Chat retains full Coder configuration and memory management; you may search, read and write memories within this Run repository scope.',
        ]
        : [
          `Coder memory index (${index.length} ${index.length === 1 ? 'entry' : 'entries'}):`,
          ...(index.length ? index : ['- (no Coder memories yet)']),
          'This is an index, not the full text. Use coder_memory_search to find relevant memories and coder_memory_read to read one in full.',
          'You may save durable Coder facts with coder_memory_write; Chat retains full Coder configuration and memory management.',
        ]),
      'Group messages are scoped by recipient and repository. Do not assume another role can see your message or that a visible transcript entry is model input.',
      'Pause, resume, cancel and retry requests are handled by the control service and are never normal task instructions.',
      request.taskDefinition.role === 'worktree-manager'
        ? 'In orchestration v6-v11, provide advisory per-project Git strategy guidance only. Do not create, merge, or clean branches or worktrees; the project executor chooses and performs Git operations after inspecting each project.'
        : '',
    ].filter(Boolean).join('\n');
  }
  if (snapshot.orchestrationVersion === 7 && request.taskDefinition.role === 'executor-manager') {
    const roles = snapshot.roles.map((role) => `${role.role}${role.displayName ? ` (${role.displayName})` : ''}`).join(', ');
    const workingPractice = snapshot.workingPractice?.trim();
    const memories = teamMemoryProjection(request.groupContext?.memories ?? []);
    return [
      'This is the narrowed Chat inside Coder. Manage only this Coder’s roles, working practice, concurrency setting and Coder memories through the provided Coder management tools.',
      ...(workingPractice ? [`Coder working practice:\n${workingPractice}`] : []),
      ...(memories ? [`Coder memories:\n${memories}`] : []),
      'Do not request or reveal project paths, read or change project files, run Commands, use Skills, call MCP servers, manage Chat memory, or change unrelated workspace resources.',
      'The Executor Manager role is protected. Changes to Coder configuration apply to future Runs; the current Run keeps its captured version. A newly created role can receive work in a later message after it appears in the active role list.',
      `Roles captured by this Run: ${roles}.`,
      'Return a concise user-facing update in the message field. Do not claim a configuration or memory change succeeded unless its tool returned success.',
    ].join('\n');
  }
  if ((snapshot.orchestrationVersion === 8 || snapshot.orchestrationVersion === 9 || snapshot.orchestrationVersion === 10) && request.taskDefinition.taskKey === `group_0_${request.groupContext.targetRole}`) {
    const workingPractice = snapshot.workingPractice?.trim();
    const memories = teamMemoryProjection(request.groupContext.memories ?? []);
    return [
      'This is the initially addressed role for a Chat-dispatched Coder Run. Use the captured Coder context to guide this request.',
      ...(workingPractice ? [`Coder working practice:\n${workingPractice}`] : []),
      ...(memories ? [`Coder memories:\n${memories}`] : []),
      'Coder settings, roles and memories are managed by Chat through protected platform operations. Do not claim to read or change Coder memories or settings yourself.',
    ].join('\n');
  }
  const memoryRule = snapshot.orchestrationVersion === 8 || snapshot.orchestrationVersion === 9 || snapshot.orchestrationVersion === 10
    ? 'Coder long-term memory is separate from Chat memory and is managed by Chat. Only the initially addressed role in a new v8-v10 Run receives its bounded captured memory projection; handoff roles receive none and no Coder role may add, update, or delete memories.'
    : 'Coder long-term memory is separate from Chat memory and belongs to the Executor Manager. Only the Executor Manager receives Coder memories and may add, update, or delete them; other roles must not claim to read or save memory.';
  return [
    'Group messages are scoped by recipient and repository. Do not assume another role can see your message or that a visible transcript entry is model input.',
    'Pause, resume, cancel and retry requests are handled by the control service and are never normal task instructions.',
    memoryRule,
    request.taskDefinition.role === 'worktree-manager'
      ? 'In orchestration v6-v10, provide advisory per-project Git strategy guidance only. Do not create, merge, or clean branches or worktrees; the project executor chooses and performs Git operations after inspecting each project.'
      : '',
  ].filter(Boolean).join('\n\n');
}

// v8-v10 initially addressed roles and historical v7 Executor Manager turns receive a bounded
// projection of captured Coder/repository-scoped memories. Legacy role-scoped entries
// are never injected.
const TEAM_MEMORY_PROMPT_ENTRIES = 50;
const TEAM_MEMORY_PROMPT_CHARS = 6000;

function teamMemoryProjection(memories: Array<{ role: string | null; content: string }>): string {
  const lines: string[] = [];
  let total = 0;
  for (const memory of memories) {
    if (memory.role) continue;
    const content = memory.content.trim();
    if (!content || lines.length >= TEAM_MEMORY_PROMPT_ENTRIES || total + content.length > TEAM_MEMORY_PROMPT_CHARS) break;
    lines.push(`- ${content}`);
    total += content.length;
  }
  return lines.join('\n');
}

function modeAuthorization(mode: AgentTeamMode, role: AgentTeamRoleId): string {
  if (mode === 'plan_only') return 'Read the declared project. Do not modify project files or execute commands.';
  if (mode === 'validate_existing') return 'Read the declared project and run the checks this task and the project instructions call for. Do not modify project files or author new tests.';
  // The Implementer only carries out the Planner's plan; it does not run tests or validate its own work.
  if (role === 'implementer') return 'Read and modify the declared project only within the confirmed implementation scope. Do not run tests or validate the result.';
  return 'Read and modify the declared project only within the confirmed implementation scope, and run the checks this task and the project instructions call for.';
}

function directRoleModeRationale(role: AgentTeamRoleId): string {
  const mode = initialAgentTeamModeForRole(role);
  if (mode === 'plan_only') return `The user addressed the ${role} role directly, so this Run starts in the planning path.`;
  if (mode === 'validate_existing') return `The user addressed the ${role} role directly, so this Run starts in the validation path.`;
  return `The user addressed the ${role} role directly, so this Run starts in the implementation path.`;
}

class TaskOutputValidationError extends Error {
  constructor(message: string, readonly output: string) {
    super(message);
    this.name = 'TaskOutputValidationError';
  }
}

// Worktree Manager output shapes. The setup plan is validated against the fixed naming
// convention before the runtime executes it; the executed payload additionally carries the
// project's original branch (see AgentTeamWorktreeSetupState in executor-graph-v4).
type WorktreeLanePlan = { laneId: string; worktreePath: string; branch: string };
type WorktreeSetupPlan = { baseWorktreePath: string; runBranch: string; lanes: WorktreeLanePlan[]; originalBranch?: string };
type WorktreeTeardownDecision = { action: 'merge-and-cleanup' | 'retain'; reason?: string };
type ParsedCompletedTaskResult = Extract<AgentTeamTaskResult, { status: 'completed' }> & {
  worktreeSetup?: WorktreeSetupPlan;
  worktreeTeardown?: WorktreeTeardownDecision;
};
type ParsedTaskResult = ParsedCompletedTaskResult | Extract<AgentTeamTaskResult, { status: 'waiting_for_input' }>;

function emptyWorktreeManagerResult(): ParsedCompletedTaskResult {
  return {
    status: 'completed',
    documents: [],
    unresolvedIssues: [],
    commandIds: [],
    changedFiles: [],
    completedAssignedWork: true,
    criterionAssessments: [],
  };
}

// The fixed v4 Run worktree layout: base worktree ../<project>-run-<runId> on branch
// worklite/run-<runId>, plus one lane worktree per development assignment.
function expectedRunWorktreeLayout(
  run: AgentTeamRun,
  assignments: readonly AgentTeamDevelopmentAssignment[],
): { baseWorktreePath: string; runBranch: string; lanes: WorktreeLanePlan[] } {
  const baseWorktreePath = join(dirname(run.projectDirectory), `${basename(run.projectDirectory)}-run-${run.id}`);
  const runBranch = `worklite/run-${run.id}`;
  return {
    baseWorktreePath,
    runBranch,
    lanes: assignments.map((assignment) => ({
      laneId: assignment.developerId,
      worktreePath: `${baseWorktreePath}-dev-${assignment.developerId}`,
      branch: `${runBranch}-dev-${assignment.developerId}`,
    })),
  };
}

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
    return {
      status: 'waiting_for_input',
      pendingInput: { id: `placeholder_${randomUUID()}`, question, scopeRevision: 0 },
    };
  }
  if (value?.status !== 'completed') {
    throw new Error(`The Coder role returned an unsupported task status: ${JSON.stringify(value?.status)}.`);
  }
  if (typeof value.completedAssignedWork !== 'boolean') {
    throw new Error('The Coder role did not report assigned-work completion.');
  }
  const developmentAssignments = parseDevelopmentAssignments(value.developmentAssignments);
  const projectGitDecisions = parseProjectGitDecisions(value.projectGitDecisions);
  const repairRequests = parseRepairRequests(value.repairRequests);
  const worktreeSetup = parseWorktreeSetupPlan(value.worktreeSetup);
  const worktreeTeardown = parseWorktreeTeardownDecision(value.worktreeTeardown);
  const message = typeof value.message === 'string' ? value.message.trim() : undefined;
  if (value.message !== undefined && typeof value.message !== 'string') {
    throw new Error('The Coder role message must be text.');
  }
  const handoff = parseRoleHandoff(value.handoff, supportedRoleIds);
  const dispatchDecision = parseDispatchDecision(value.dispatchDecision);
  const repositoryDirectories = parseRepositoryDirectories(value.repositoryDirectories);
  return {
    status: 'completed',
    documents: parseDocuments(value.documents, taskKey),
    unresolvedIssues: parseStrings(value.unresolvedIssues, 'unresolved issue'),
    commandIds: [],
    changedFiles: parseStrings(value.changedFiles, 'changed file'),
    completedAssignedWork: value.completedAssignedWork,
    criterionAssessments: parseAssessments(value.criterionAssessments),
    ...(projectGitDecisions ? { projectGitDecisions } : {}),
    repairRequest: parseRepairRequest(value.repairRequest),
    ...(developmentAssignments ? { developmentAssignments } : {}),
    ...(repairRequests ? { repairRequests } : {}),
    ...(worktreeSetup ? { worktreeSetup } : {}),
    ...(worktreeTeardown ? { worktreeTeardown } : {}),
    ...(message ? { message } : {}),
    ...(handoff ? { handoff } : {}),
    ...(dispatchDecision ? { dispatchDecision } : {}),
    ...(repositoryDirectories ? { repositoryDirectories } : {}),
  };
}

function parseDispatchDecision(value: unknown): Extract<AgentTeamTaskResult, { status: 'completed' }>['dispatchDecision'] {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('dispatchDecision must be an object.');
  const decision = value as { mode?: unknown; rationale?: unknown };
  if (decision.mode !== 'plan_only' && decision.mode !== 'validate_existing' && decision.mode !== 'implement_and_validate') {
    throw new Error('dispatchDecision.mode must be plan_only, validate_existing or implement_and_validate.');
  }
  if (typeof decision.rationale !== 'string' || !decision.rationale.trim()) {
    throw new Error('dispatchDecision.rationale must be a non-empty sentence.');
  }
  return { mode: decision.mode, rationale: decision.rationale.trim() };
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

function parseRoleHandoff(value: unknown, supportedRoleIds: readonly string[]): Extract<AgentTeamTaskResult, { status: 'completed' }>['handoff'] {
  if (value === undefined || value === null) return undefined;
  const handoff = value as { role?: unknown; goal?: unknown; repositoryIds?: unknown };
  if (typeof handoff.role !== 'string' || !supportedRoleIds.includes(handoff.role)) {
    const rejected = typeof handoff.role === 'string' ? `"${handoff.role}"` : 'a missing role';
    throw new Error(`A role handoff needs a role captured by this Coder version; got ${rejected}. Valid handoff.role values: ${supportedRoleIds.join(', ') || 'none'}.`);
  }
  if (typeof handoff.goal !== 'string' || !handoff.goal.trim()) {
    throw new Error('A role handoff needs a specific goal.');
  }
  if (handoff.repositoryIds !== undefined
    && (!Array.isArray(handoff.repositoryIds) || handoff.repositoryIds.some((id) => typeof id !== 'string' || !id.trim()))) {
    throw new Error('A role handoff repository scope must contain repository ids.');
  }
  return {
    role: handoff.role as AgentTeamRuntimeRole,
    goal: handoff.goal.trim(),
    ...(Array.isArray(handoff.repositoryIds) && handoff.repositoryIds.length > 0
      ? { repositoryIds: [...new Set(handoff.repositoryIds.map((id) => (id as string).trim()))] }
      : {}),
  };
}

function parseProjectGitDecisions(
  value: unknown,
): Extract<AgentTeamTaskResult, { status: 'completed' }>['projectGitDecisions'] {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('projectGitDecisions must be an array.');
  return value.map((item) => {
    const decision = item as { projectPath?: unknown; strategy?: unknown; branch?: unknown; worktreePath?: unknown };
    if (typeof decision?.projectPath !== 'string' || !decision.projectPath.trim()) {
      throw new Error('Each projectGitDecisions entry needs a projectPath.');
    }
    if (!['no_git', 'current_branch', 'feature_branch', 'worktree'].includes(String(decision.strategy))) {
      throw new Error('Each projectGitDecisions entry needs a supported strategy.');
    }
    for (const field of ['branch', 'worktreePath'] as const) {
      if (decision[field] !== undefined && typeof decision[field] !== 'string') {
        throw new Error(`projectGitDecisions ${field} must be text when supplied.`);
      }
    }
    return {
      projectPath: decision.projectPath.trim(),
      strategy: decision.strategy as 'no_git' | 'current_branch' | 'feature_branch' | 'worktree',
      ...(typeof decision.branch === 'string' && decision.branch.trim() ? { branch: decision.branch.trim() } : {}),
      ...(typeof decision.worktreePath === 'string' && decision.worktreePath.trim() ? { worktreePath: decision.worktreePath.trim() } : {}),
    };
  });
}

function parseWorktreeSetupPlan(value: unknown): WorktreeSetupPlan | undefined {
  if (value === undefined || value === null) return undefined;
  const plan = value as Partial<WorktreeSetupPlan>;
  if (typeof plan.baseWorktreePath !== 'string' || !plan.baseWorktreePath.trim()) {
    throw new Error('The worktree-manager setup needs a baseWorktreePath.');
  }
  if (typeof plan.runBranch !== 'string' || !plan.runBranch.trim()) {
    throw new Error('The worktree-manager setup needs a runBranch.');
  }
  if (!Array.isArray(plan.lanes)) throw new Error('The worktree-manager setup needs a lanes list.');
  const lanes = plan.lanes.map((item) => {
    const lane = item as Partial<WorktreeLanePlan>;
    if (typeof lane.laneId !== 'string' || !lane.laneId.trim()
      || typeof lane.worktreePath !== 'string' || !lane.worktreePath.trim()
      || typeof lane.branch !== 'string' || !lane.branch.trim()) {
      throw new Error('A worktree-manager lane needs a laneId, worktreePath, and branch.');
    }
    return { laneId: lane.laneId.trim(), worktreePath: lane.worktreePath.trim(), branch: lane.branch.trim() };
  });
  return { baseWorktreePath: plan.baseWorktreePath.trim(), runBranch: plan.runBranch.trim(), lanes };
}

function parseWorktreeTeardownDecision(value: unknown): WorktreeTeardownDecision | undefined {
  if (value === undefined || value === null) return undefined;
  const decision = value as Partial<WorktreeTeardownDecision>;
  if (decision.action !== 'merge-and-cleanup' && decision.action !== 'retain') {
    throw new Error('The worktree-manager teardown action must be "merge-and-cleanup" or "retain".');
  }
  if (decision.reason !== undefined && typeof decision.reason !== 'string') {
    throw new Error('The worktree-manager teardown reason must be text.');
  }
  return decision.reason?.trim()
    ? { action: decision.action, reason: decision.reason.trim() }
    : { action: decision.action };
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

function parseRepairRequest(value: unknown): Extract<AgentTeamTaskResult, { status: 'completed' }>['repairRequest'] {
  if (value === undefined || value === null) return undefined;
  const request = value as { taskKey?: unknown; instruction?: unknown };
  if (request.taskKey !== 'development' || typeof request.instruction !== 'string' || !request.instruction.trim()) {
    throw new Error('The reviewer returned an invalid repair request.');
  }
  return { taskKey: 'development', instruction: request.instruction.trim() };
}

function parseDevelopmentAssignments(value: unknown): AgentTeamDevelopmentAssignmentInput[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('The planner returned invalid development assignments.');
  return value.map((item) => {
    const assignment = item as Partial<AgentTeamDevelopmentAssignmentInput>;
    if (typeof assignment.title !== 'string' || !assignment.title.trim()) {
      throw new Error('A development assignment title is required.');
    }
    if (typeof assignment.scopeSummary !== 'string') {
      throw new Error('A development assignment scope summary must be text.');
    }
    if (!Array.isArray(assignment.ownedPaths) || assignment.ownedPaths.some((path) => typeof path !== 'string')) {
      throw new Error('A development assignment owned path list must be strings.');
    }
      if (assignment.repositoryIds !== undefined
        && (!Array.isArray(assignment.repositoryIds) || assignment.repositoryIds.some((id) => typeof id !== 'string' || !id.trim()))) {
        throw new Error('A development assignment repository list must contain repository ids.');
      }
    return {
      ...(typeof assignment.developerId === 'string' && assignment.developerId.trim()
        ? { developerId: assignment.developerId.trim() }
        : {}),
      title: assignment.title.trim(),
      scopeSummary: assignment.scopeSummary,
      ownedPaths: assignment.ownedPaths as string[],
      ...(assignment.repositoryIds?.length ? { repositoryIds: [...new Set(assignment.repositoryIds.map((id) => id.trim()))] } : {}),
    };
  });
}

function parseRepairRequests(value: unknown): AgentTeamTargetedRepairRequest[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('The reviewer returned invalid repair requests.');
  return value.map((item) => {
    const request = item as Partial<AgentTeamTargetedRepairRequest>;
    if (typeof request.developerId !== 'string' || !request.developerId.trim()
      || typeof request.instruction !== 'string' || !request.instruction.trim()) {
      throw new Error('A repair request needs a developerId and an instruction.');
    }
    return { developerId: request.developerId.trim(), instruction: request.instruction.trim() };
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
    status: row.status,
    inputFingerprint: row.inputFingerprint,
    result: row.result as AgentTeamTaskResultView | null,
    error: row.error,
    retryable: row.status === 'failed' && row.active,
    developerId: row.developerId,
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
  type CompletedResult = Extract<AgentTeamTaskResultView, { status: 'completed' }>;
  const activeRows = taskRows.filter((row) => row.active);
  const completedResultOf = (row: (typeof activeRows)[number]): CompletedResult | undefined =>
    row.status === 'completed' && row.result !== null && row.result !== undefined
      && (row.result as { status?: unknown }).status === 'completed'
      ? row.result as CompletedResult
      : undefined;

  const planningRow = [...activeRows].reverse()
    .find((row) => row.taskKey === 'planning' && completedResultOf(row));
  const planningResult = planningRow ? completedResultOf(planningRow) : undefined;
  // v3 planner output carries no developerId; assignments map to lanes in order.
  const rawAssignments = planningResult?.developmentAssignments?.length
    ? planningResult.developmentAssignments
    : planningResult
      ? [{ title: 'Development', scopeSummary: '', ownedPaths: [] }]
      : [];
  const assignments: AgentTeamDevelopmentAssignment[] = rawAssignments.map((assignment, index) => ({
    ...assignment,
    developerId: assignment.developerId ?? DEVELOPER_LANE_IDS[index] ?? RESERVED_DEVELOPER_ID,
  }));

  // A repair round targets only the lanes named by the latest completed review.
  const reviewRow = [...activeRows].reverse().find((row) =>
    (row.taskKey === 'review' || /^repair_review_\d+$/.test(row.taskKey)) && completedResultOf(row));
  const reviewResult = reviewRow ? completedResultOf(reviewRow) : undefined;
  let currentRound = 0;
  let repairTargets: ReadonlySet<string> | null = null;
  if (reviewRow && reviewResult?.repairRequests?.length) {
    const reviewRound = /^repair_review_(\d+)$/.exec(reviewRow.taskKey);
    currentRound = reviewRound ? Number(reviewRound[1]) + 1 : 1;
    repairTargets = new Set(reviewResult.repairRequests.map((request) => request.developerId));
  }

  let completedAssignments = 0;
  for (const assignment of assignments) {
    if (currentRound > 0 && repairTargets && !repairTargets.has(assignment.developerId)) {
      completedAssignments += 1;
      continue;
    }
    const laneTaskKey = currentRound > 0
      ? (assignment.developerId === RESERVED_DEVELOPER_ID ? `repair_${currentRound}` : `repair_${currentRound}_${assignment.developerId}`)
      : (assignment.developerId === RESERVED_DEVELOPER_ID ? 'development' : `development_${assignment.developerId}`);
    if (activeRows.some((row) => row.taskKey === laneTaskKey && completedResultOf(row))) {
      completedAssignments += 1;
    }
  }

  const phaseOfTaskKey = (taskKey: string): AgentTeamRunProgress['phase'] => {
    const groupRole = /^group_\d+_(.+)$/.exec(taskKey)?.[1];
    if (groupRole) {
      const phases: Record<string, AgentTeamRunProgress['phase']> = {
        planner: 'planning', test_designer: 'test_design', developer: 'development', implementer: 'development',
        test_author: 'test_authoring', test_runner: 'test_execution', reviewer: 'review',
      };
      return phases[groupRole] ?? 'working';
    }
    if (/^repair_test_authoring/.test(taskKey)) return 'test_authoring';
    if (/^repair_test_execution/.test(taskKey)) return 'test_execution';
    if (/^repair_review/.test(taskKey)) return 'review';
    if (/^repair_/.test(taskKey)) return 'repair';
    if (taskKey === 'planning') return 'planning';
    if (taskKey === 'test_design') return 'test_design';
    // Worktree setup prepares development; teardown finalizes after review (the default).
    if (taskKey === 'worktree_setup') return 'development';
    if (taskKey === 'development' || taskKey.startsWith('development_')) return 'development';
    if (taskKey === 'test_authoring') return 'test_authoring';
    if (taskKey === 'test_execution') return 'test_execution';
    return 'review';
  };

  const terminal = isTerminalRunStatus(run.status);
  const inFlight = activeRows.filter((row) =>
    row.status === 'running' || row.status === 'waiting_for_input' || row.status === 'waiting_for_recovery');
  const latest = [...activeRows].reverse().find((row) => completedResultOf(row) || row.status === 'failed');
  let phase: AgentTeamRunProgress['phase'];
  if (terminal) phase = 'terminal';
  else if (run.status === 'waiting_for_input') phase = 'waiting';
  else if (inFlight.length > 0) phase = phaseOfTaskKey(inFlight[inFlight.length - 1].taskKey);
  else {
    phase = latest ? phaseOfTaskKey(latest.taskKey) : 'planning';
  }

  // developerId is only ever set on lane-based task attempts (any implementation role,
  // not just one literally named 'developer'), so this filters correctly for Direct too.
  const activeDeveloperIds = terminal
    ? []
    : [...new Set(inFlight
      .filter((row) => row.developerId !== null)
      .map((row) => row.developerId ?? RESERVED_DEVELOPER_ID))]
      .sort((left, right) => left === RESERVED_DEVELOPER_ID ? -1 : right === RESERVED_DEVELOPER_ID ? 1 : left.localeCompare(right));

  let nextStep: AgentTeamRunProgress['nextStep'];
  if (terminal) nextStep = 'finish';
  else if (run.status === 'waiting_for_input') nextStep = 'answer_question';
  else if (phase === 'development' || phase === 'repair') {
    nextStep = activeDeveloperIds.length > 0 ? 'await_assignment_completion' : 'dispatch_assignments';
  } else if (phase === 'test_authoring') nextStep = 'test_execution';
  else if (phase === 'test_execution') nextStep = 'review';
  else if (phase === 'review') nextStep = 'finish';
  else nextStep = 'dispatch_assignments';

  return {
    phase,
    nextStep,
    totalAssignments: assignments.length,
    completedAssignments,
    activeDeveloperIds,
    waitingReason: run.status === 'waiting_for_input'
      ? 'user_input'
      : run.status === 'paused' || run.desiredControlState === 'pause_requested'
        ? 'pause_boundary'
        : null,
  };
}

function isUsableGraphState(value: unknown, run: AgentTeamRun): value is AgentTeamGraphState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<AgentTeamGraphState>;
  return state.runId === run.id &&
    state.intent === run.intent &&
    state.mode === run.mode &&
    state.projectDirectory === run.projectDirectory &&
    typeof state.outputDirectory === 'string' &&
    Array.isArray(state.projectInstructions) &&
    JSON.stringify(state.projectInstructions) === JSON.stringify(run.projectInstructions) &&
    state.scopeRevision === run.scopeRevision &&
    Array.isArray(state.documents) &&
    Array.isArray(state.unresolvedIssues) &&
    Array.isArray(state.commandIds) &&
    Array.isArray(state.criterionAssessments) &&
    typeof state.taskResults === 'object' &&
    state.taskResults !== null;
}

function isUsableGroupGraphState(value: unknown, run: AgentTeamRun): value is AgentTeamGroupGraphState {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !run.groupContext) return false;
  const state = value as Partial<AgentTeamGroupGraphState>;
  const groupContext = state.groupContext;
  return state.runId === run.id
    && state.intent === run.intent
    && state.mode === run.mode
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

function roleForTaskKey(taskKey: string): AgentTeamRole {
  return TASK_ROLES.find(([pattern]) => pattern.test(taskKey))?.[1] ?? 'reviewer';
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
