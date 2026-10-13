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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { and, asc, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import type {
  AgentTeamCriterionAssessment,
  AgentTeamDocumentView,
  AgentTeamMode,
  AgentTeamOperationRecoveryDecision,
  AgentTeamOperationView,
  AgentTeamPendingInputView,
  AgentTeamRole,
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
  agentTeamConversations,
  agentTeamDocuments,
  agentTeamIntakes,
  agentTeamOperations,
  agentTeamPendingInputs,
  agentTeamRunEvents,
  agentTeamRuns,
  agentTeamTaskAttempts,
  agentTeams,
  agentTeamVersions,
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
  createTeamGraph,
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
  type AgentTeamGraphResult,
  type AgentTeamGraphState,
  type AgentTeamTaskRequest,
  type AgentTeamTaskResult,
} from '@worklite/team-runtime';
import { DATABASE } from '../../infrastructure/database.module';
import {
  AgentInvocationRecoveryRequiredError,
  IsolatedAgentInvocationService,
  type AgentInvocationOperationJournal,
} from '../agents/isolated-agent-invocation.service';
import { ProjectExecutorService } from '../agents/project-executor.service';
import { enqueueTaskMerge, ensureTaskWorktree, inspectGitRepository, mergeTaskWorktree, type PreparedTaskWorktree } from '../agents/git-worktree';
import { AgentTeamOperationJournalService } from './agent-team-operation-journal.service';
import {
  AGENT_TEAM_PROCESS_ID,
  AGENT_TEAM_PROCESS_VERSION,
  AGENT_TEAM_ROLE_INSTRUCTIONS,
  AGENT_TEAM_ROLE_TOOL_NAMES,
  BUILT_IN_AGENT_TEAM_ID,
} from './agent-team-configuration';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { CommandsService } from '../commands/commands.service';

const MAX_TOOL_RESULT_CHARS = 100_000;
const TASK_ROLES: Array<[RegExp, AgentTeamRole]> = [
  [/^repair_test_authoring_/, 'test_author'],
  [/^repair_test_execution_/, 'test_runner'],
  [/^repair_review_/, 'reviewer'],
  [/^repair_/, 'developer'],
  [/^planning$/, 'planner'],
  [/^test_design$/, 'test_designer'],
  [/^development_join$/, 'developer'],
  [/^development_/, 'developer'],
  [/^development$/, 'developer'],
  [/^test_authoring$/, 'test_author'],
  [/^test_execution$/, 'test_runner'],
  [/^review$/, 'reviewer'],
];
const RESERVED_DEVELOPER_ID = 'developer';

type Checkpointer = ReturnType<typeof createSqliteCheckpointer>;
type AgentTeamDatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type AgentTeamRunOrigin = { intakeId: string; conversationId: string };
type AgentTeamEventListener = (event: AgentTeamRunEvent) => void;
type RawTaskOutput = {
  status?: unknown;
  documents?: unknown;
  unresolvedIssues?: unknown;
  commandIds?: unknown;
  changedFiles?: unknown;
  completedAssignedWork?: unknown;
  criterionAssessments?: unknown;
  repairRequest?: unknown;
  repairRequests?: unknown;
  developmentAssignments?: unknown;
  pendingInput?: unknown;
};

@Injectable()
export class AgentTeamRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly checkpointer: Checkpointer;
  private readonly executions = new Map<string, Promise<void>>();
  private shuttingDown = false;
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly eventListeners = new Set<AgentTeamEventListener>();
  private readonly transactionEvents = new Map<object, AgentTeamRunEvent[]>();
  private readonly documentDeliveries = new Map<string, Promise<void>>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly config: ConfigService,
    private readonly invocations: IsolatedAgentInvocationService,
    private readonly executors: ProjectExecutorService,
    private readonly resources: WorkspaceResourcesService,
    private readonly operations: AgentTeamOperationJournalService,
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
    for (const controller of this.abortControllers.values()) controller.abort();
    await Promise.allSettled([...this.executions.values()]);
    this.checkpointer.db.close();
  }

  async createRun(
    workspaceId: string,
    request: CreateAgentTeamRunRequest,
    origin?: AgentTeamRunOrigin,
  ): Promise<AgentTeamRunView> {
    assertRuntimeAdmission();
    const intent = request?.intent?.trim();
    const projectDirectory = request?.projectDirectory?.trim();
    const mode = request?.mode;
    if (!intent) throw new BadRequestException('A TeamRun intent is required.');
    if (!projectDirectory || !isAbsolute(projectDirectory)) {
      throw new BadRequestException('An absolute project directory is required.');
    }
    if (mode !== 'plan_only' && mode !== 'validate_existing' && mode !== 'implement_and_validate') {
      throw new BadRequestException('A supported TeamRun mode is required.');
    }
    const authorizedCommands = normalizeAuthorizedCommands(request?.authorizedCommands);
    if (mode === 'plan_only' && authorizedCommands.length > 0) {
      throw new BadRequestException('Plan-only Agent Team runs cannot authorize commands.');
    }

    const runId = `atrun_${randomUUID()}`;
    const versionId = `atver_${randomUUID()}`;
    const resolvedProjectDirectory = resolve(projectDirectory);
    const projectInstructions = await this.readProjectInstructions(resolvedProjectDirectory);
    const outputDirectory = this.runOutputDirectory(runId);
    const [team] = await this.db.select().from(agentTeams)
      .where(and(eq(agentTeams.id, BUILT_IN_AGENT_TEAM_ID), eq(agentTeams.workspaceId, workspaceId)))
      .limit(1);
    if (!team) throw new NotFoundException('The built-in Agent Team was not found.');

    const snapshot = await this.createVersionSnapshot(team.roles);
    const now = new Date();
    await this.transaction((transaction) => {
      const [activeRun] = transaction.select({ id: agentTeamRuns.id })
        .from(agentTeamRuns)
        .where(and(
          eq(agentTeamRuns.teamId, team.id),
          inArray(agentTeamRuns.status, ['queued', 'running', 'waiting_for_input', 'paused']),
        ))
        .limit(1)
        .all();
      if (activeRun) throw new BadRequestException('The Agent Team already has an active Run.');

      const [latest] = transaction.select({ version: agentTeamVersions.version })
        .from(agentTeamVersions)
        .where(eq(agentTeamVersions.teamId, team.id))
        .orderBy(desc(agentTeamVersions.version))
        .limit(1)
        .all();
      transaction.insert(agentTeamVersions).values({
        id: versionId,
        workspaceId,
        teamId: team.id,
        version: (latest?.version ?? 0) + 1,
        snapshot,
      }).run();
      transaction.insert(agentTeamRuns).values({
        id: runId,
        workspaceId,
        teamId: team.id,
        teamVersionId: versionId,
        status: 'queued',
        intent,
        projectDirectory: resolvedProjectDirectory,
        projectInstructions,
        mode,
        authorizedCommands,
        scopeRevision: 1,
        langGraphThreadId: `atthread_${runId}`,
      }).run();
      if (origin) {
        const linkedIntakes = transaction.update(agentTeamIntakes).set({
          runId,
          unresolvedField: null,
          updatedAt: now,
        }).where(and(
          eq(agentTeamIntakes.id, origin.intakeId),
          eq(agentTeamIntakes.workspaceId, workspaceId),
          eq(agentTeamIntakes.conversationId, origin.conversationId),
          isNull(agentTeamIntakes.runId),
        )).returning({ id: agentTeamIntakes.id }).all();
        if (linkedIntakes.length !== 1) {
          throw new NotFoundException('The Agent Team conversation intake was not found.');
        }
        transaction.update(agentTeamConversations).set({
          latestProjectDirectory: resolvedProjectDirectory,
          updatedAt: now,
        }).where(eq(agentTeamConversations.id, origin.conversationId)).run();
      }
      this.appendEvent(transaction, runId, 'run.status', { status: 'queued' });
    });

    await mkdir(outputDirectory, { recursive: true });
    this.scheduleExecution(runId, this.initialGraphInput(await this.getRun(runId)));
    return this.getRunView(runId);
  }

  async deliverRunDocuments(runId: string, workspaceId?: string): Promise<void> {
    if (workspaceId) await this.getRun(runId, workspaceId);
    await this.deliverDocuments(runId);
  }

  async getRunView(runId: string, workspaceId?: string): Promise<AgentTeamRunView> {
    const run = await this.getRun(runId, workspaceId);
    const [origin] = await this.db.select({ conversationId: agentTeamIntakes.conversationId })
      .from(agentTeamIntakes)
      .where(eq(agentTeamIntakes.runId, runId))
      .limit(1);
    const [version] = await this.db.select().from(agentTeamVersions)
      .where(eq(agentTeamVersions.id, run.teamVersionId))
      .limit(1);
    if (!version) throw new NotFoundException('The Agent Team version was not found.');
    const [taskRows, documentRows, pendingRows, operationRows, activityRows] = await Promise.all([
      this.db.select().from(agentTeamTaskAttempts)
        .where(eq(agentTeamTaskAttempts.runId, runId))
        .orderBy(asc(agentTeamTaskAttempts.createdAt), asc(agentTeamTaskAttempts.attemptIndex)),
      this.db.select().from(agentTeamDocuments)
        .where(eq(agentTeamDocuments.runId, runId))
        .orderBy(asc(agentTeamDocuments.createdAt), asc(agentTeamDocuments.key), asc(agentTeamDocuments.revision)),
      this.db.select().from(agentTeamPendingInputs)
        .where(eq(agentTeamPendingInputs.runId, runId))
        .orderBy(asc(agentTeamPendingInputs.createdAt)),
      this.db.select().from(agentTeamOperations)
        .where(eq(agentTeamOperations.runId, runId))
        .orderBy(asc(agentTeamOperations.createdAt), asc(agentTeamOperations.key)),
      this.db.select().from(agentTeamRunEvents)
        .where(and(eq(agentTeamRunEvents.runId, runId), eq(agentTeamRunEvents.type, 'task.activity')))
        .orderBy(asc(agentTeamRunEvents.sequence)),
    ]);
    const progressTextByAttemptId = new Map<string, string>();
    for (const row of [...activityRows].reverse()) {
      const payload = row.payload as { taskAttemptId?: unknown; text?: unknown } | null;
      if (typeof payload?.taskAttemptId !== 'string' || progressTextByAttemptId.has(payload.taskAttemptId)) continue;
      if (typeof payload.text === 'string' && payload.text.trim()) {
        progressTextByAttemptId.set(payload.taskAttemptId, payload.text);
      }
    }
    return {
      id: run.id,
      teamId: run.teamId,
      teamVersion: {
        id: version.id,
        version: version.version,
        createdAt: version.createdAt.toISOString(),
        developerExecution: version.snapshot.developerExecution,
        developerExecutions: version.snapshot.developerExecutions,
        orchestrationVersion: version.snapshot.orchestrationVersion,
      },
      status: run.status,
      intent: run.intent,
      projectDirectory: run.projectDirectory,
      mode: run.mode,
      authorizedCommands: run.authorizedCommands,
      scopeRevision: run.scopeRevision,
      desiredControlState: run.desiredControlState,
      tasks: taskRows.map((row) => toTaskAttemptView(row, progressTextByAttemptId.get(row.id) ?? '')),
      documents: documentRows.map(toDocumentView),
      originatingConversationId: origin?.conversationId ?? null,
      pendingInputs: pendingRows.map(toPendingInputView),
      operations: operationRows.map(toOperationView),
      activities: activityRows.map((row) => ({ runId: row.runId, sequence: row.sequence, type: row.type, payload: row.payload, createdAt: row.createdAt.toISOString() })),
      progress: deriveRunProgress(run, taskRows),
      outcome: isRunOutcome(run.outcome) ? run.outcome : null,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    };
  }

  async getRunProgress(runId: string): Promise<AgentTeamRunProgress | null> {
    const [run] = await this.db.select().from(agentTeamRuns).where(eq(agentTeamRuns.id, runId)).limit(1);
    if (!run) return null;
    const taskRows = await this.db.select().from(agentTeamTaskAttempts)
      .where(eq(agentTeamTaskAttempts.runId, runId))
      .orderBy(asc(agentTeamTaskAttempts.createdAt), asc(agentTeamTaskAttempts.attemptIndex));
    return deriveRunProgress(run, taskRows);
  }

  async getRunEvents(runId: string, workspaceId?: string, afterSequence = 0): Promise<AgentTeamRunEvent[]> {
    await this.getRun(runId, workspaceId);
    const rows = await this.db.select().from(agentTeamRunEvents)
      .where(and(
        eq(agentTeamRunEvents.runId, runId),
        gt(agentTeamRunEvents.sequence, afterSequence),
      ))
      .orderBy(asc(agentTeamRunEvents.sequence));
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
    if (run.status !== 'waiting_for_input') throw new BadRequestException('The Agent Team run is not waiting for input.');
    if (request?.pendingInputId !== request?.pendingInputId?.trim() || !request.pendingInputId) {
      throw new BadRequestException('A pending input id is required.');
    }
    const [pendingInput] = await this.db.select({ kind: agentTeamPendingInputs.kind })
      .from(agentTeamPendingInputs)
      .where(and(
        eq(agentTeamPendingInputs.id, request.pendingInputId),
        eq(agentTeamPendingInputs.runId, runId),
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
    const grantedCommands = normalizeAuthorizedCommands(request?.authorizedCommands);
    if (run.mode === 'plan_only' && grantedCommands.length > 0) {
      throw new BadRequestException('Plan-only Agent Team runs cannot authorize commands.');
    }

    const version = await this.getVersion(run);
    const orchestrationVersion = version.snapshot.orchestrationVersion ?? 1;
    let resumeInterruptId: string | undefined;
    if (orchestrationVersion === 2) {
      const graph = this.createGraph(run, version);
      const snapshot = await graph.getState({ configurable: { thread_id: run.langGraphThreadId } });
      resumeInterruptId = snapshot.tasks
        .flatMap((task) => task.interrupts)
        .find((candidate) => (candidate.value as { id?: unknown } | undefined)?.id === request.pendingInputId)?.id;
      if (!resumeInterruptId) throw new BadRequestException('The pending input is no longer active.');
    }

    const now = new Date();
    const answered = await this.transaction((transaction) => {
      const rows = transaction.update(agentTeamPendingInputs).set({
        status: 'answered',
        answer: request.answer,
        answeredAt: now,
        updatedAt: now,
      }).where(and(
        eq(agentTeamPendingInputs.id, request.pendingInputId),
        eq(agentTeamPendingInputs.runId, runId),
        eq(agentTeamPendingInputs.scopeRevision, run.scopeRevision),
        eq(agentTeamPendingInputs.status, 'pending'),
      )).returning().all();
      if (rows.length === 0) return null;
      const [currentRun] = transaction.select({ authorizedCommands: agentTeamRuns.authorizedCommands })
        .from(agentTeamRuns)
        .where(eq(agentTeamRuns.id, runId))
        .limit(1)
        .all();
      const nextCommands = mergeAuthorizedCommands(currentRun?.authorizedCommands ?? [], grantedCommands);
      const remaining = transaction.select({ id: agentTeamPendingInputs.id })
        .from(agentTeamPendingInputs)
        .where(and(
          eq(agentTeamPendingInputs.runId, runId),
          eq(agentTeamPendingInputs.kind, 'question'),
          eq(agentTeamPendingInputs.status, 'pending'),
        ))
        .limit(1)
        .all();
      transaction.update(agentTeamRuns).set({
        status: remaining.length > 0 ? 'waiting_for_input' : 'running',
        desiredControlState: 'none',
        authorizedCommands: nextCommands,
        updatedAt: now,
      }).where(and(eq(agentTeamRuns.id, runId), eq(agentTeamRuns.status, 'waiting_for_input'))).run();
      this.appendEvent(transaction, runId, 'input.answered', {
        pendingInputId: request.pendingInputId,
        kind: 'question',
        answer: request.answer,
        ...(grantedCommands.length > 0 ? { authorizedCommands: grantedCommands } : {}),
      });
      this.appendProgressIfChanged(transaction, runId);
      return nextCommands;
    });
    if (!answered) throw new BadRequestException('The pending input is no longer active.');

    const resume = pendingInputAnswer(request.answer, answered);
    this.scheduleExecution(runId, new Command({
      resume: orchestrationVersion === 2 ? { [resumeInterruptId as string]: resume } : resume,
    }));
    return this.getRunView(runId);
  }

  async recover(runId: string, request: RecoverAgentTeamOperationRequest): Promise<AgentTeamRunView> {
    const operationKey = request?.operationKey?.trim();
    if (!operationKey || request.operationKey !== operationKey) {
      throw new BadRequestException('A stable Agent Team operation key is required.');
    }
    const decision = request?.decision;
    if (decision !== 'adopt_command' && decision !== 'mark_failed' && decision !== 'replay') {
      throw new BadRequestException('A supported operation recovery decision is required.');
    }

    const run = await this.getRun(runId);
    if (run.status !== 'waiting_for_input') {
      throw new BadRequestException('The Agent Team run is not waiting for operation recovery.');
    }
    const [operation] = await this.db.select().from(agentTeamOperations)
      .where(and(
        eq(agentTeamOperations.key, `${runId}:${operationKey}`),
        eq(agentTeamOperations.runId, runId),
      ))
      .limit(1);
    if (!operation || operation.status !== 'uncertain' || operation.recoveryDecision) {
      throw new BadRequestException('The Agent Team operation is not awaiting recovery.');
    }
    const [pendingInput] = await this.db.select().from(agentTeamPendingInputs)
      .where(and(
        eq(agentTeamPendingInputs.runId, runId),
        eq(agentTeamPendingInputs.kind, 'operation_recovery'),
        eq(agentTeamPendingInputs.operationKey, operationKey),
        eq(agentTeamPendingInputs.status, 'pending'),
      ))
      .orderBy(desc(agentTeamPendingInputs.createdAt))
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
      const updatedRun = transaction.update(agentTeamRuns).set({
        status: decision === 'mark_failed' ? 'failed' : 'running',
        desiredControlState: 'none',
        updatedAt: now,
        finishedAt: decision === 'mark_failed' ? now : null,
      }).where(and(
        eq(agentTeamRuns.id, runId),
        eq(agentTeamRuns.status, 'waiting_for_input'),
      )).returning().all();
      if (updatedRun.length === 0) throw new BadRequestException('The Agent Team run is no longer waiting for input.');

      const updatedOperation = transaction.update(agentTeamOperations).set({
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
        eq(agentTeamOperations.key, operation.key),
        eq(agentTeamOperations.status, 'uncertain'),
        isNull(agentTeamOperations.recoveryDecision),
      )).returning().all();
      if (updatedOperation.length === 0) throw new BadRequestException('The Agent Team operation is no longer awaiting recovery.');

      const answeredInput = transaction.update(agentTeamPendingInputs).set({
        status: 'answered',
        answer: decision,
        answeredAt: now,
        updatedAt: now,
      }).where(and(
        eq(agentTeamPendingInputs.id, pendingInput.id),
        eq(agentTeamPendingInputs.status, 'pending'),
      )).returning().all();
      if (answeredInput.length === 0) throw new BadRequestException('The operation recovery input is no longer active.');

      const supersededAttemptReason = decision === 'adopt_command'
        ? 'The uncertain operation was resolved by adopting its linked Command in a new task attempt.'
        : decision === 'replay'
          ? 'The uncertain operation was explicitly replayed in a new task attempt.'
          : operation.failureReason ?? 'The uncertain operation was marked failed.';
      const updatedAttempt = transaction.update(agentTeamTaskAttempts).set({
        status: 'failed',
        active: false,
        error: supersededAttemptReason,
        finishedAt: now,
      }).where(and(
        eq(agentTeamTaskAttempts.id, operation.taskAttemptId),
        eq(agentTeamTaskAttempts.status, 'waiting_for_recovery'),
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

    if (decision !== 'mark_failed') this.scheduleExecution(runId, null);
    return this.getRunView(runId);
  }

  upgradeQuiescent(): boolean { return this.executions.size === 0; }

  async pause(runId: string): Promise<AgentTeamRunView> {
    const run = await this.getRun(runId);
    if (run.status === 'paused') return this.getRunView(runId);
    if (run.status === 'waiting_for_input' || (run.status === 'queued' && !this.executions.has(runId))) {
      await this.setRunStatus(runId, 'paused');
    } else if (run.status === 'queued' || run.status === 'running') {
      await this.requestPause(runId);
    } else {
      throw new BadRequestException('A completed Agent Team run cannot be paused.');
    }
    return this.getRunView(runId);
  }

  async resume(runId: string): Promise<AgentTeamRunView> {
    const run = await this.getRun(runId);
    if (run.status !== 'paused') throw new BadRequestException('Only a paused Agent Team run can be resumed.');
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
      const requested = transaction.update(agentTeamRuns).set({
        desiredControlState: 'cancel_requested',
        updatedAt: now,
      }).where(and(
        eq(agentTeamRuns.id, runId),
        ne(agentTeamRuns.status, 'succeeded'),
        ne(agentTeamRuns.status, 'failed'),
        ne(agentTeamRuns.status, 'cancelled'),
      )).returning().all();
      if (requested.length === 0) return false;
      transaction.update(agentTeamPendingInputs).set({ status: 'cancelled', updatedAt: now })
        .where(and(
          eq(agentTeamPendingInputs.runId, runId),
          eq(agentTeamPendingInputs.status, 'pending'),
          ne(agentTeamPendingInputs.kind, 'operation_recovery'),
        )).run();
      this.appendEvent(transaction, runId, 'run.status', { status: 'cancel_requested' });
      return true;
    });
    if (!accepted) return this.getRunView(runId);

    this.abortControllers.get(runId)?.abort();
    if (!this.executions.has(runId) && !(await this.hasPendingOperationRecovery(runId))) {
      await this.failActiveAttempts(runId, 'cancelled', 'The Agent Team run was cancelled.');
      await this.finishCancelledRun(runId);
    }
    return this.getRunView(runId);
  }

  async retry(runId: string, taskKey: string): Promise<AgentTeamRunView> {
    const run = await this.getRun(runId);
    if (run.status !== 'failed') throw new BadRequestException('Only a failed Agent Team run can be retried.');
    const [failed] = await this.db.select().from(agentTeamTaskAttempts)
      .where(and(
        eq(agentTeamTaskAttempts.runId, runId),
        eq(agentTeamTaskAttempts.taskKey, taskKey),
        eq(agentTeamTaskAttempts.status, 'failed'),
        eq(agentTeamTaskAttempts.active, true),
      ))
      .orderBy(desc(agentTeamTaskAttempts.attemptIndex))
      .limit(1);
    if (!failed) throw new BadRequestException('The failed active Agent Team task was not found.');

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
      const failedRows = transaction.select({ id: agentTeamTaskAttempts.id, taskKey: agentTeamTaskAttempts.taskKey })
        .from(agentTeamTaskAttempts)
        .where(and(
          eq(agentTeamTaskAttempts.runId, runId),
          eq(agentTeamTaskAttempts.active, true),
          eq(agentTeamTaskAttempts.status, 'failed'),
        )).all();
      for (const row of failedRows) {
        if (fanOutPattern ? !fanOutPattern.test(row.taskKey) : row.taskKey !== taskKey) continue;
        transaction.update(agentTeamTaskAttempts).set({ active: false })
          .where(eq(agentTeamTaskAttempts.id, row.id)).run();
      }
      transaction.update(agentTeamRuns).set({
        status: 'running',
        desiredControlState: 'none',
        updatedAt: now,
        finishedAt: null,
      }).where(and(eq(agentTeamRuns.id, runId), eq(agentTeamRuns.status, 'failed'))).run();
      this.appendEvent(transaction, runId, 'run.status', { status: 'running' });
      this.appendProgressIfChanged(transaction, runId);
    });

    this.scheduleExecution(runId, null);
    return this.getRunView(runId);
  }

  private async initializeBuiltInTeam(): Promise<void> {
    const [existing] = await this.db.select({ id: agentTeams.id }).from(agentTeams)
      .where(and(eq(agentTeams.id, BUILT_IN_AGENT_TEAM_ID), eq(agentTeams.workspaceId, 'workspace_personal')))
      .limit(1);
    if (existing) return;

    const manifest = getBmadTeaProcessManifest();
    const roles = (Object.keys(AGENT_TEAM_ROLE_INSTRUCTIONS) as AgentTeamRole[]).map((role) => ({
      role,
      publicModelId: '',
      instructions: AGENT_TEAM_ROLE_INSTRUCTIONS[role],
      entryPoints: manifest.entryPoints[role] ?? [],
      skills: [],
      mcpServers: [],
      toolNames: [...AGENT_TEAM_ROLE_TOOL_NAMES[role]],
    }));
    await this.db.insert(agentTeams).values({
      id: BUILT_IN_AGENT_TEAM_ID,
      workspaceId: 'workspace_personal',
      name: 'WorkLite Software Team',
      description: 'Built-in BMAD and TEA software development team.',
      processId: AGENT_TEAM_PROCESS_ID,
      processVersion: AGENT_TEAM_PROCESS_VERSION,
      roles,
    }).onConflictDoNothing().run();
  }

  private async createVersionSnapshot(
    configuredRoles: StoredAgentTeamRoleConfiguration[],
  ): Promise<StoredAgentTeamVersionSnapshot> {
    const manifest = getBmadTeaProcessManifest();
    const processFiles = await Promise.all(manifest.files.map(async (file) => ({
      path: file.path,
      content: await readBmadTeaProcessFile(file.path),
    })));
    const developerRole = configuredRoles.find((role) => role.role === 'developer');
    const developerExecution = await this.executors.captureLaunch(developerRole?.executor ?? 'claude', null);
    return {
      processId: AGENT_TEAM_PROCESS_ID,
      processVersion: AGENT_TEAM_PROCESS_VERSION,
      processFiles,
      developerExecution,
      // v3 lanes share the role's single captured launch; the Planner decides
      // how many of the fixed pool lanes actually execute per Run.
      developerExecutions: { [RESERVED_DEVELOPER_ID]: developerExecution },
      orchestrationVersion: 3,
      roles: await Promise.all(configuredRoles.map(async (role) => {
        const entryPointContent = await Promise.all(role.entryPoints.map((path) => readBmadTeaProcessFile(path)));
        const processReferences = processReferencePaths(role.role, manifest);
        return {
          ...role,
          // An empty developer model keeps the executor's own default instead of the Team default model.
          publicModelId: role.publicModelId.trim() || (role.role === 'developer' ? '' : this.config.get<string>('AGENT_TEAM_DEFAULT_PUBLIC_MODEL_ID')?.trim() || ''),
          processReferences,
          instructions: [role.instructions, ...entryPointContent].filter(Boolean).join('\n\n---\n\n'),
        };
      })),
      recipeDefaults: { maxRepairRounds: 2 },
    };
  }

  private async recoverRuns(): Promise<void> {
    const runs = await this.db.select().from(agentTeamRuns)
      .where(inArray(agentTeamRuns.status, ['queued', 'running']))
      .orderBy(asc(agentTeamRuns.createdAt));
    for (const run of runs) {
      if (run.desiredControlState === 'cancel_requested' && !(await this.findInterruptedOperation(run.id))) {
        await this.failActiveAttempts(run.id, 'cancelled', 'The Agent Team run was cancelled.');
        await this.finishCancelledRun(run.id);
        continue;
      }
      if (run.status === 'queued') {
        if (run.desiredControlState === 'pause_requested') {
          await this.setRunStatus(run.id, 'paused');
        } else {
          await mkdir(this.runOutputDirectory(run.id), { recursive: true });
          this.scheduleExecution(run.id, this.initialGraphInput(run));
        }
        continue;
      }
      if (!this.executions.has(run.id)) await this.reconcileInterruptedRun(run);
    }
  }

  private async resumeInput(run: AgentTeamRun): Promise<AgentTeamGraphState | null> {
    const version = await this.getVersion(run);
    const graph = this.createGraph(run, version);
    const snapshot = await graph.getState({ configurable: { thread_id: run.langGraphThreadId } });
    const state = snapshot.values as AgentTeamGraphState | undefined;
    return isUsableGraphState(state, run) ? null : this.initialGraphInput(run);
  }

  private async hasPendingOperationRecovery(runId: string): Promise<boolean> {
    const [pending] = await this.db.select({ id: agentTeamPendingInputs.id })
      .from(agentTeamPendingInputs)
      .where(and(
        eq(agentTeamPendingInputs.runId, runId),
        eq(agentTeamPendingInputs.kind, 'operation_recovery'),
        eq(agentTeamPendingInputs.status, 'pending'),
      ))
      .limit(1);
    return pending !== undefined;
  }

  private async nextReplayOperationKey(operation: AgentTeamOperation): Promise<string> {
    const rows = await this.db.select({ operationKey: agentTeamOperations.operationKey })
      .from(agentTeamOperations)
      .where(and(
        eq(agentTeamOperations.runId, operation.runId),
        eq(agentTeamOperations.taskKey, operation.taskKey),
        eq(agentTeamOperations.toolName, operation.toolName),
        eq(agentTeamOperations.inputFingerprint, operation.inputFingerprint),
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
          interruptedOperation.failureReason ?? 'The Agent Team process was interrupted before the operation settled.',
        );
      }
      await this.setRunStatus(run.id, 'paused', undefined, 'none');
      return;
    }
    if (interruptedOperation) {
      await this.exposeOperationRecovery(
        run.id,
        interruptedOperation.key.slice(run.id.length + 1),
        interruptedOperation.failureReason ?? 'The Agent Team process was interrupted before the operation settled.',
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
    if (interrupted) {
      if ((version.snapshot.orchestrationVersion ?? 1) === 2) {
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
        await this.failStaleAttempts(run.id, 'The Agent Team checkpoint was missing or empty.');
        await this.setRunStatus(run.id, 'failed');
        return;
      }
      await this.finishSuccessfulRun(run.id, toGraphResult(state));
      return;
    }

    await this.failStaleAttempts(run.id, 'The Agent Team process was interrupted before the task settled.');
    this.scheduleExecution(run.id, null);
  }

  private async reconcileProjection(run: AgentTeamRun, state: AgentTeamGraphState): Promise<void> {
    await this.transaction((transaction) => {
      for (const [documentIndex, document] of (state.documents ?? []).entries()) {
        const revision = nextDocumentRevision(state.documents ?? [], document, documentIndex);
        const [existing] = transaction.select({ id: agentTeamDocuments.id })
          .from(agentTeamDocuments)
          .where(and(
            eq(agentTeamDocuments.runId, run.id),
            eq(agentTeamDocuments.key, document.key),
            eq(agentTeamDocuments.revision, revision),
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
        transaction.insert(agentTeamDocuments).values({
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

  private scheduleExecution(runId: string, input: AgentTeamGraphState | Command | null): void {
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

  private async executeGraph(runId: string, input: AgentTeamGraphState | Command | null): Promise<void> {
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
        await this.failActiveAttempts(runId, 'cancelled', 'The Agent Team run was cancelled.');
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
    const completedState = snapshot.values as AgentTeamGraphState;
    const documents = completedState.documents ?? [];
    await this.deliverDocuments(runId);
    await this.finishSuccessfulRun(runId, toGraphResult(completedState));
  }

  private createGraph(run: AgentTeamRun, version: AgentTeamVersion) {
    const snapshot = version.snapshot;
    const orchestrationVersion = snapshot.orchestrationVersion ?? 1;
    const developerRole = snapshot.roles.find((role) => role.role === 'developer');
    return createTeamGraph({
      executeTask: async (request) => this.executeTask(run.workspaceId, version, request),
    }, this.checkpointer, {
      maxRepairRounds: snapshot.recipeDefaults.maxRepairRounds,
      orchestrationVersion,
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
    if (!role) throw new Error(`Agent Team role ${taskRole} was not captured by this version.`);
    const attempt = await this.prepareTaskAttempt(run, request);
    if (attempt.status === 'completed' || attempt.status === 'waiting_for_input') {
      return attempt.result as AgentTeamTaskResult;
    }
    const controller = this.abortControllers.get(request.runId);
    const signal = controller?.signal ?? new AbortController().signal;
    const commandIds = new Set<string>();
    const orchestrationVersion = version.snapshot.orchestrationVersion ?? 1;
    // Each developer lane works in its own git worktree (when the project is a git repository)
    // and merges back on completion through the shared serialized queue.
    let laneWorktree: PreparedTaskWorktree | null = null;

    const produceOutput = async (correction?: string): Promise<string> => {
      if (taskRole === 'developer') {
        const developerId = request.developerId ?? RESERVED_DEVELOPER_ID;
        // v3 lanes share the role's single captured launch; only v2 snapshots
        // carry per-instance launches and configurations.
        const execution = version.snapshot.developerExecutions?.[developerId]
          ?? (orchestrationVersion === 3 ? version.snapshot.developerExecutions?.[RESERVED_DEVELOPER_ID] : undefined)
          ?? (developerId === RESERVED_DEVELOPER_ID ? version.snapshot.developerExecution : undefined);
        if (!execution || !('executor' in execution)) throw new Error('This Team version has no captured developer executor. Start a new Team Run.');
        const instance = orchestrationVersion !== 3 && developerId !== RESERVED_DEVELOPER_ID
          ? role.developerInstances?.find((candidate) => candidate.developerId === developerId)
          : undefined;
        if (orchestrationVersion !== 3 && developerId !== RESERVED_DEVELOPER_ID && !instance) {
          throw new Error(`Developer instance ${developerId} was not captured by this Team version.`);
        }
        const developerRole = instance ?? role;
        const model = developerRole.publicModelId.trim() || (execution.executor === 'codex' ? execution.model : null);
        if (model) await this.executors.requireModel(workspaceId, execution.executor, model);
        laneWorktree ??= await this.prepareDeveloperLane(run, attempt.id);
        const laneNote = laneWorktree ? `You work in your lane's dedicated git worktree (${laneWorktree.worktreePath}) on branch ${laneWorktree.worktreeBranch}; stay inside it and commit your finished changes on that branch before returning.` : null;
        const promptAddition = [developerPromptAddition(request), laneNote].filter(Boolean).join('\n\n') || undefined;
        const references = await Promise.all((developerRole.processReferences ?? []).map(async (path) => ({ path, content: await this.readCapturedProcessFile(version, path) })));
        return this.executors.execute({
          owner: 'team',
          workspaceId,
          launch: execution,
          model,
          systemPrompt: taskSystemPrompt(developerRole.instructions, true, promptAddition),
          input: JSON.stringify(taskContext(request, true, correction)),
          projectDirectory: laneWorktree?.worktreePath ?? request.projectDirectory,
          skills: developerRole.skills,
          mcpServers: (await this.resources.workflowMcpRuntimes(workspaceId, developerRole.mcpServers.map((server) => server.id)))
            .map((runtime) => {
              const snapshot = developerRole.mcpServers.find((server) => server.id === runtime.id);
              return snapshot ? { ...runtime, name: snapshot.name, allowedTools: snapshot.allowedToolNames } : runtime;
            }),
          references,
          signal,
          correlation: { source: 'team', teamRunId: request.runId, teamTaskAttemptId: attempt.id },
          onEvent: (activity) => {
            commandIds.add(activity.commandExecutionId);
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
        });
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
        systemPrompt: taskSystemPrompt(role.instructions, false, rolePromptAddition(taskRole, version.snapshot)),
        context: taskContext(request, false, correction),
        skills: role.skills,
        mcpRuntimes: (await this.resources.workflowMcpRuntimes(workspaceId, role.mcpServers.map((server) => server.id)))
          .map((runtime) => {
            const snapshot = role.mcpServers.find((server) => server.id === runtime.id);
            return snapshot
              ? { ...runtime, name: snapshot.name, allowedTools: snapshot.allowedToolNames }
              : runtime;
          }),
        builtinToolNames: role.toolNames,
        role: taskRole,
        projectDirectory: request.projectDirectory,
        authorizedCommands: request.authorizedCommands,
        processReferencePaths: role.processReferences ?? [],
        readProcessReference: (path) => this.readCapturedProcessFile(version, path),
        signal,
        jsonOutput: true,
        correlation: { source: 'team', teamRunId: request.runId, teamTaskAttemptId: attempt.id },
        // The upstream proxy closes a request that has not produced its first byte within
        // ~120s, and time-to-first-byte grows with the prompt: requests past ~200KB (~70k
        // tokens) stalled for 70-120s and then failed. Bound each tool result and the rolling
        // context so a long tool loop stays well inside that window; the oldest tool
        // exchanges are dropped first and the task context message is always kept.
        limits: { maxToolResultChars: 30_000, maxContextTokens: 30_000 },
        operation: { taskKey, journal: operationJournal },
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

    // A role output that fails validation earns exactly one corrective
    // re-invocation carrying the parse error before the attempt fails.
    let correction: string | undefined;
    for (let parseAttempt = 0; ; parseAttempt += 1) {
      try {
        const output = await produceOutput(correction);
        return await this.finishExecutorOutput(request, workspaceId, attempt.id, taskKey, output, commandIds, laneWorktree);
      } catch (error) {
        if (!(error instanceof TaskOutputValidationError) || parseAttempt >= 1) throw error;
        correction = [
          `Your previous reply could not be accepted: ${error.message}`,
          `Previous reply excerpt: ${error.outputExcerpt}`,
          'Return exactly one JSON object whose "status" is exactly one of: "waiting_for_input", "completed".',
        ].join('\n');
      }
    }
  }

  private async finishExecutorOutput(
    request: AgentTeamTaskRequest,
    workspaceId: string,
    attemptId: string,
    taskKey: string,
    output: string,
    commandIds: ReadonlySet<string>,
    laneWorktree?: PreparedTaskWorktree | null,
  ): Promise<AgentTeamTaskResult> {
    const parsed = parseTaskOutput(output, taskKey);
    if (parsed.status === 'waiting_for_input') {
      return this.finishWaitingAttempt(request, workspaceId, attemptId, parsed);
    }
    validateUpstreamDocuments(parsed.documents, request.upstream);
    if (laneWorktree) await this.mergeDeveloperLane(request.runId, attemptId, taskKey, laneWorktree);
    const result: Extract<AgentTeamTaskResult, { status: 'completed' }> = {
      ...parsed,
      commandIds: [...commandIds],
    };
    return this.finishCompletedAttempt(request, workspaceId, attemptId, result);
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
  private async mergeDeveloperLane(runId: string, attemptId: string, taskKey: string, worktree: PreparedTaskWorktree): Promise<void> {
    const run = await this.getRun(runId);
    const outcome = await enqueueTaskMerge(run.projectDirectory, worktree.baseBranch, () => mergeTaskWorktree({
      projectDirectory: run.projectDirectory,
      worktreePath: worktree.worktreePath,
      worktreeBranch: worktree.worktreeBranch,
      baseBranch: worktree.baseBranch,
    }).catch((error: unknown): { status: 'conflict'; error: string } => ({
      status: 'conflict',
      error: `自动合并 lane 分支 ${worktree.worktreeBranch} 时出现意外错误（${error instanceof Error ? error.message : String(error)}）；worktree ${worktree.worktreePath} 与分支已保留，请手动合并后清理。`,
    })));
    this.appendEvent(this.db, runId, 'task.activity', {
      taskAttemptId: attemptId, taskKey,
      phase: outcome.status === 'merged' ? 'worktree.merged' : 'worktree.merge_conflict',
      worktreePath: worktree.worktreePath, worktreeBranch: worktree.worktreeBranch, baseBranch: worktree.baseBranch,
      cleanupPending: outcome.status === 'merged' ? outcome.cleanupPending : undefined,
      error: outcome.status === 'conflict' ? outcome.error : undefined,
    });
    if (outcome.status === 'conflict') throw new Error(outcome.error);
  }

  private async readCapturedProcessFile(version: AgentTeamVersion, path: string): Promise<string> {
    const file = version.snapshot.processFiles.find((candidate) => candidate.path === path);
    if (!file) throw new Error(`Process reference ${path} was not captured by this Team version.`);
    return file.content;
  }

  private async prepareTaskAttempt(
    run: AgentTeamRun,
    request: AgentTeamTaskRequest,
  ): Promise<{ id: string; status: AgentTeamTaskAttemptStatus; result: unknown }> {
    const inputFingerprint = fingerprint(request);
    const { role, taskKey } = request.taskDefinition;
    const [existing] = await this.db.select().from(agentTeamTaskAttempts)
      .where(and(eq(agentTeamTaskAttempts.runId, run.id), eq(agentTeamTaskAttempts.taskKey, taskKey)))
      .orderBy(desc(agentTeamTaskAttempts.attemptIndex))
      .limit(1);
    if (existing?.active && existing.status === 'completed') {
      if (existing.inputFingerprint !== inputFingerprint) {
        throw new Error(`Agent Team task ${taskKey} produced a result for different input.`);
      }
      return { id: existing.id, status: 'completed', result: existing.result };
    }

    if (existing?.active && existing.status === 'waiting_for_recovery') {
      throw new Error(`Agent Team task ${taskKey} is waiting for operation recovery.`);
    }

    if (existing?.active && existing.status === 'waiting_for_input' && !request.answer) {
      return { id: existing.id, status: existing.status, result: existing.result };
    }

    const now = new Date();
    if (existing?.active && existing.status === 'waiting_for_input') {
      const resumedInput = { initial: existing.inputRevision, resumedWith: request };
      const [resumed] = await this.db.update(agentTeamTaskAttempts).set({
        status: 'running',
        inputRevision: resumedInput,
        inputFingerprint,
        result: null,
        error: null,
        finishedAt: null,
        startedAt: existing.startedAt ?? now,
      }).where(and(eq(agentTeamTaskAttempts.id, existing.id), eq(agentTeamTaskAttempts.status, 'waiting_for_input')))
        .returning();
      if (resumed) return { id: resumed.id, status: resumed.status, result: resumed.result };
    }
    if (existing?.active && existing.status === 'running') {
      throw new Error(`Agent Team task ${taskKey} is already running.`);
    }

    const attemptId = `atask_${randomUUID()}`;
    const [created] = await this.db.insert(agentTeamTaskAttempts).values({
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

  private async finishWaitingAttempt(
    request: AgentTeamTaskRequest,
    workspaceId: string,
    attemptId: string,
    result: Extract<AgentTeamTaskResult, { status: 'waiting_for_input' }>,
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
      const [desired] = transaction.select({ desiredControlState: agentTeamRuns.desiredControlState })
        .from(agentTeamRuns)
        .where(eq(agentTeamRuns.id, request.runId))
        .limit(1).all();
      if (desired?.desiredControlState === 'cancel_requested') {
        throw new DOMException('The Agent Team run was cancelled.', 'AbortError');
      }
      const updated = transaction.update(agentTeamTaskAttempts).set({
        status: 'waiting_for_input',
        result: persistedResult,
        finishedAt: now,
      }).where(and(
        eq(agentTeamTaskAttempts.id, attemptId),
        eq(agentTeamTaskAttempts.status, 'running'),
      )).returning().all();
      if (updated.length === 0) throw new Error('The Agent Team task attempt is no longer running.');
      transaction.insert(agentTeamPendingInputs).values({
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
      const [desired] = transaction.select({ desiredControlState: agentTeamRuns.desiredControlState })
        .from(agentTeamRuns)
        .where(eq(agentTeamRuns.id, request.runId))
        .limit(1).all();
      if (desired?.desiredControlState === 'cancel_requested') {
        throw new DOMException('The Agent Team run was cancelled.', 'AbortError');
      }
      const updated = transaction.update(agentTeamTaskAttempts).set({
        status: 'completed',
        result,
        error: null,
        finishedAt: now,
      }).where(and(
        eq(agentTeamTaskAttempts.id, attemptId),
        eq(agentTeamTaskAttempts.status, 'running'),
      )).returning().all();
      if (updated.length === 0) throw new Error('The Agent Team task attempt is no longer running.');
      for (const document of result.documents) {
        const [latest] = transaction.select({ revision: agentTeamDocuments.revision })
          .from(agentTeamDocuments)
          .where(and(eq(agentTeamDocuments.runId, request.runId), eq(agentTeamDocuments.key, document.key)))
          .orderBy(desc(agentTeamDocuments.revision))
          .limit(1).all();
        const revision = (latest?.revision ?? 0) + 1;
        transaction.insert(agentTeamDocuments).values({
          id: `atdoc_${randomUUID()}`,
          workspaceId,
          runId: request.runId,
          taskAttemptId: attemptId,
          key: document.key,
          revision,
          title: document.title,
          content: document.content,
          upstreamDocumentKeys: document.upstreamDocumentKeys,
        }).run();
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
      this.appendProgressIfChanged(transaction, request.runId);
    });
    await this.deliverDocuments(request.runId);
    return result;
  }

  private async requestPause(runId: string): Promise<void> {
    await this.db.update(agentTeamRuns).set({
      desiredControlState: 'pause_requested',
      updatedAt: new Date(),
    }).where(eq(agentTeamRuns.id, runId)).run();
    await this.appendEvent(this.db, runId, 'run.status', { status: 'pause_requested' });
  }

  private async findAnsweredInput(
    run: AgentTeamRun,
    pendingInputId: string,
  ): Promise<AgentTeamPendingInputAnswer | undefined> {
    const [row] = await this.db.select({ answer: agentTeamPendingInputs.answer })
      .from(agentTeamPendingInputs)
      .where(and(
        eq(agentTeamPendingInputs.id, pendingInputId),
        eq(agentTeamPendingInputs.runId, run.id),
        eq(agentTeamPendingInputs.status, 'answered'),
      ))
      .limit(1);
    return row?.answer === undefined || row.answer === null
      ? undefined
      : pendingInputAnswer(row.answer, run.authorizedCommands);
  }

  private async getDesiredControlState(
    runId: string,
  ): Promise<AgentTeamRunView['desiredControlState'] | undefined> {
    const [row] = await this.db.select({ desiredControlState: agentTeamRuns.desiredControlState })
      .from(agentTeamRuns)
      .where(eq(agentTeamRuns.id, runId))
      .limit(1);
    return row?.desiredControlState;
  }

  private async findInterruptedOperation(runId: string): Promise<AgentTeamOperation | undefined> {
    const rows = await this.db.select({ operation: agentTeamOperations })
      .from(agentTeamOperations)
      .innerJoin(agentTeamTaskAttempts, eq(agentTeamOperations.taskAttemptId, agentTeamTaskAttempts.id))
      .where(and(
        eq(agentTeamOperations.runId, runId),
        inArray(agentTeamOperations.status, ['reserved', 'uncertain']),
        isNull(agentTeamOperations.recoveryDecision),
        eq(agentTeamTaskAttempts.active, true),
        inArray(agentTeamTaskAttempts.status, ['running', 'waiting_for_recovery']),
      ))
      .orderBy(desc(agentTeamOperations.createdAt))
      .limit(1);
    return rows[0]?.operation;
  }

  private async exposeOperationRecovery(
    runId: string,
    operationKey: string,
    reason: string,
  ): Promise<boolean> {
    const [operation] = await this.db.select().from(agentTeamOperations)
      .where(and(
        eq(agentTeamOperations.key, `${runId}:${operationKey}`),
        eq(agentTeamOperations.runId, runId),
      ))
      .limit(1);
    if (!operation || operation.recoveryDecision || operation.status === 'completed' || operation.status === 'failed') {
      return false;
    }
    const [existingInput] = await this.db.select().from(agentTeamPendingInputs)
      .where(and(
        eq(agentTeamPendingInputs.runId, runId),
        eq(agentTeamPendingInputs.kind, 'operation_recovery'),
        eq(agentTeamPendingInputs.operationKey, operationKey),
      ))
      .orderBy(desc(agentTeamPendingInputs.createdAt))
      .limit(1);
    if (existingInput?.status !== 'pending' && existingInput) return false;

    const now = new Date();
    const pendingInputId = existingInput?.id ?? `atinput_${randomUUID()}`;
    const question = `Operation ${operationKey} has an uncertain effect. Choose adopt_command, mark_failed, or replay.`;
    return this.transaction((transaction) => {
      const updatedRun = transaction.update(agentTeamRuns).set({
        status: 'waiting_for_input',
        updatedAt: now,
      }).where(and(
        eq(agentTeamRuns.id, runId),
        eq(agentTeamRuns.status, 'running'),
      )).returning().all();
      if (updatedRun.length === 0) throw new Error('The Agent Team run is no longer running.');

      const updatedOperation = transaction.update(agentTeamOperations).set({
        status: 'uncertain',
        failureReason: reason,
        updatedAt: now,
      }).where(and(
        eq(agentTeamOperations.key, operation.key),
        isNull(agentTeamOperations.recoveryDecision),
      )).returning().all();
      if (updatedOperation.length === 0) throw new Error('The Agent Team operation was already recovered.');

      const updatedAttempt = transaction.update(agentTeamTaskAttempts).set({
        status: 'waiting_for_recovery',
        finishedAt: now,
      }).where(and(
        eq(agentTeamTaskAttempts.id, operation.taskAttemptId),
        inArray(agentTeamTaskAttempts.status, ['running', 'waiting_for_recovery']),
      )).returning().all();
      if (updatedAttempt.length === 0) throw new Error('The Agent Team task attempt is no longer active.');

      if (!existingInput) {
        transaction.insert(agentTeamPendingInputs).values({
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
    const [run] = await this.db.select().from(agentTeamRuns).where(eq(agentTeamRuns.id, runId)).limit(1);
    if (!run) return;
    if (error instanceof AgentInvocationRecoveryRequiredError) {
      if (await this.exposeOperationRecovery(run.id, error.operationKey, error.reason)) return;
    }
    if (run.desiredControlState === 'cancel_requested') {
      await this.failActiveAttempts(runId, 'cancelled', 'The Agent Team run was cancelled.');
      await this.finishCancelledRun(runId);
      return;
    }
    const reason = this.shuttingDown && isAbortError(error)
      ? 'The Agent Team process was interrupted by API shutdown.'
      : formatError(error);
    await this.failActiveAttempts(runId, 'failed', reason);
    await this.setRunStatus(runId, 'failed');
  }

  private async failActiveAttempts(
    runId: string,
    status: 'failed' | 'cancelled',
    reason: string,
  ): Promise<void> {
    const now = new Date();
    const rows = await this.db.update(agentTeamTaskAttempts).set({
      status,
      error: reason,
      finishedAt: now,
    }).where(and(
      eq(agentTeamTaskAttempts.runId, runId),
      eq(agentTeamTaskAttempts.active, true),
      inArray(agentTeamTaskAttempts.status, ['running', 'waiting_for_input', 'waiting_for_recovery']),
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
        .from(agentTeamTaskAttempts)
        .where(and(
          eq(agentTeamTaskAttempts.runId, runId),
          eq(agentTeamTaskAttempts.active, true),
          eq(agentTeamTaskAttempts.status, 'running'),
        ))
        .orderBy(desc(agentTeamTaskAttempts.attemptIndex)).all();
      for (const row of rows) {
        if (row.result !== null && row.result !== undefined) continue;
        transaction.update(agentTeamTaskAttempts).set({
          status: 'failed',
          error: reason,
          finishedAt: now,
        }).where(eq(agentTeamTaskAttempts.id, row.id)).run();
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
      const [desired] = transaction.select({ desiredControlState: agentTeamRuns.desiredControlState })
        .from(agentTeamRuns)
        .where(eq(agentTeamRuns.id, runId))
        .limit(1).all();
      if (desired?.desiredControlState === 'cancel_requested') return false;
      const rows = transaction.update(agentTeamRuns).set({
        status: 'succeeded',
        outcome,
        desiredControlState: 'none',
        updatedAt: now,
        finishedAt: now,
      }).where(and(
        eq(agentTeamRuns.id, runId),
        ne(agentTeamRuns.desiredControlState, 'cancel_requested'),
      )).returning().all();
      if (rows.length === 0) return false;
      this.appendEvent(transaction, runId, 'run.status', { status: 'succeeded', outcome });
      return true;
    });
    if (committed || await this.getDesiredControlState(runId) !== 'cancel_requested') return;
    await this.failActiveAttempts(runId, 'cancelled', 'The Agent Team run was cancelled.');
    await this.finishCancelledRun(runId);
  }

  private async finishCancelledRun(runId: string): Promise<void> {
    const now = new Date();
    await this.db.update(agentTeamPendingInputs).set({ status: 'cancelled', updatedAt: now })
      .where(and(eq(agentTeamPendingInputs.runId, runId), eq(agentTeamPendingInputs.status, 'pending'))).run();
    await this.setRunStatus(runId, 'cancelled', undefined, 'none');
  }

  private async setRunStatus(
    runId: string,
    status: AgentTeamRunStatus,
    outcome?: AgentTeamRunOutcome,
    desiredControlState?: AgentTeamRunView['desiredControlState'],
  ): Promise<void> {
    const now = new Date();
    const [row] = await this.db.update(agentTeamRuns).set({
      status,
      updatedAt: now,
      finishedAt: isTerminalRunStatus(status) ? now : null,
      ...(outcome === undefined ? {} : { outcome }),
      ...(desiredControlState === undefined ? {} : { desiredControlState }),
    }).where(eq(agentTeamRuns.id, runId)).returning();
    if (row) {
      await this.appendEvent(this.db, runId, 'run.status', { status, ...(outcome ? { outcome } : {}) });
      this.appendProgressIfChanged(this.db, runId);
    }
  }

  private async getVersion(run: AgentTeamRun): Promise<AgentTeamVersion> {
    const [version] = await this.db.select().from(agentTeamVersions)
      .where(eq(agentTeamVersions.id, run.teamVersionId))
      .limit(1);
    if (!version) throw new NotFoundException('The Agent Team version was not found.');
    return version;
  }

  private async getRun(runId: string, workspaceId?: string): Promise<AgentTeamRun> {
    const [run] = await this.db.select().from(agentTeamRuns)
      .where(workspaceId
        ? and(eq(agentTeamRuns.id, runId), eq(agentTeamRuns.workspaceId, workspaceId))
        : eq(agentTeamRuns.id, runId))
      .limit(1);
    if (!run) throw new NotFoundException('Agent Team run not found.');
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
    const [latest] = db.select({ sequence: agentTeamRunEvents.sequence })
      .from(agentTeamRunEvents)
      .where(eq(agentTeamRunEvents.runId, runId))
      .orderBy(desc(agentTeamRunEvents.sequence))
      .limit(1).all();
    const sequence = (latest?.sequence ?? 0) + 1;
    const createdAt = new Date();
    db.insert(agentTeamRunEvents).values({
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
    const [run] = db.select().from(agentTeamRuns).where(eq(agentTeamRuns.id, runId)).limit(1).all();
    if (!run) return;
    const taskRows = db.select().from(agentTeamTaskAttempts)
      .where(eq(agentTeamTaskAttempts.runId, runId))
      .orderBy(asc(agentTeamTaskAttempts.createdAt), asc(agentTeamTaskAttempts.attemptIndex))
      .all();
    const progress = deriveRunProgress(run, taskRows);
    const [latest] = db.select({ payload: agentTeamRunEvents.payload })
      .from(agentTeamRunEvents)
      .where(and(eq(agentTeamRunEvents.runId, runId), eq(agentTeamRunEvents.type, 'run.progress')))
      .orderBy(desc(agentTeamRunEvents.sequence))
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
    return this.config.get<string>('AGENT_TEAM_CHECKPOINT_PATH')
      ?? resolve(profileDataDirectory, 'agent-teams', 'checkpoints.sqlite');
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
    const documents = await this.db.select().from(agentTeamDocuments)
      .where(eq(agentTeamDocuments.runId, runId))
      .orderBy(asc(agentTeamDocuments.createdAt), asc(agentTeamDocuments.key), asc(agentTeamDocuments.revision));
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
          const delivered = transaction.update(agentTeamDocuments).set({
            deliveryStatus: 'delivered',
            deliveryError: null,
          }).where(and(
            eq(agentTeamDocuments.id, document.id),
            ne(agentTeamDocuments.deliveryStatus, 'delivered'),
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
          const failed = transaction.update(agentTeamDocuments).set({
            deliveryStatus: 'failed',
            deliveryError: reason,
          }).where(and(
            eq(agentTeamDocuments.id, document.id),
            ne(agentTeamDocuments.deliveryStatus, 'delivered'),
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
  role: AgentTeamRole,
  manifest: ReturnType<typeof getBmadTeaProcessManifest>,
): string[] {
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
    authorizedCommands: run.authorizedCommands,
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
  const [existing] = db.select().from(agentTeamTaskAttempts)
    .where(and(eq(agentTeamTaskAttempts.runId, run.id), eq(agentTeamTaskAttempts.taskKey, taskKey)))
    .orderBy(desc(agentTeamTaskAttempts.attemptIndex))
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
      db.update(agentTeamTaskAttempts).set({
        status: 'completed',
        result,
        error: null,
        finishedAt: now,
      }).where(eq(agentTeamTaskAttempts.id, existing.id)).run();
    }
    return existing.id;
  }

  const id = `atask_${randomUUID()}`;
  db.insert(agentTeamTaskAttempts).values({
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

function rolePromptAddition(role: AgentTeamRole, snapshot: StoredAgentTeamVersionSnapshot): string | undefined {
  if (snapshot.orchestrationVersion === 3) {
    if (role === 'planner') {
      return [
        `This Team Run may use up to ${DEVELOPER_LANE_IDS.length} Developers working in parallel; decide how many the task actually needs.`,
        'To split the implementation, add "developmentAssignments":[{"title":"...","scopeSummary":"...","ownedPaths":["path/or/prefix"]}] to the completed response. Assignments carry no developerId and map to Developers in order, their ownedPaths must not overlap, and each Developer must receive an independent, self-contained slice. Omit the field when a single Developer suffices.',
      ].join('\n');
    }
    if (role === 'reviewer') {
      return [
        'Development may have been executed by multiple Developers in parallel; each development result names its Developer.',
        'To request repairs, add "repairRequests":[{"developerId":"...","instruction":"specific repair instruction"}] targeting only the Developers that must change their own work. Do not use the legacy repairRequest field.',
      ].join('\n');
    }
    return undefined;
  }
  const developerIds = versionDeveloperIds(snapshot);
  if (developerIds.length < 2) return undefined;
  if (role === 'planner') {
    return [
      `This Team Run is developed by ${developerIds.length} Developers in parallel: ${developerIds.join(', ')}.`,
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

function taskSystemPrompt(instructions: string, executor: boolean, addition?: string): string {
  const prompt = `${instructions}

You are executing one WorkLite Agent Team task. Use tools only when the captured role configuration and project authorization permit them. Return exactly one JSON object whose "status" is exactly one of: "waiting_for_input", "completed".

Follow the captured project instructions supplied in the task context, and discover additional applicable AGENTS.md or AGENTS_WORKFLOW.md files before changing or assessing project files. If a project rule or missing user decision requires explicit authorization for an action, return the waiting_for_input response instead of taking that action. ${executor ? 'You run as a project executor in the project directory with your own native tools. WorkLite requires neither proposal confirmation nor exact-command grants. A previous attempt may have changed the project; inspect its actual state rather than assuming earlier work is absent or complete. Read pinned process references from the files listed in the system prompt.' : 'If a required shell command is not present verbatim in authorizedCommands, return the waiting_for_input response instead of calling bash. Use process_reference only with one of the exact pinned paths listed in the system prompt.'} Map the process package's project root to projectDirectory and its process output location to outputDirectory. The output directory is managed by WorkLite: return documents in JSON rather than writing planning output there directly.

When more user input is required, return:
{"status":"waiting_for_input","pendingInput":{"question":"One specific question"}}

Otherwise return:
{"status":"completed","documents":[{"key":"stable-document-key","title":"Document title","content":"Document content","upstreamDocumentKeys":["optional-upstream-key"]}],"unresolvedIssues":["specific unresolved issue"],"changedFiles":["path/to/changed/file"],"completedAssignedWork":true,"criterionAssessments":[{"criterion":"criterion","assessment":"met|unmet|not_verified","evidence":["evidence reference"]}]}

Use an empty changedFiles array when the task changed no project files. Set completedAssignedWork to false only when the assigned work remains incomplete, and record the reason in unresolvedIssues. The reviewer may add "repairRequest":{"taskKey":"development","instruction":"specific repair instruction"}. Do not invent command ids; WorkLite records actual command evidence.`;
  return addition ? `${prompt}\n\n${addition}` : prompt;
}

function taskContext(request: AgentTeamTaskRequest, executor: boolean, correction?: string): unknown {
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
    authorization: modeAuthorization(request.mode),
    ...(executor ? {} : { authorizedCommands: request.authorizedCommands }),
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
  };
}

function modeAuthorization(mode: AgentTeamMode): string {
  if (mode === 'plan_only') return 'Read the declared project. Do not modify project files or execute commands.';
  if (mode === 'validate_existing') return 'Read the declared project and run only checks authorized by the user and project instructions. Do not modify project files or author new tests.';
  return 'Read and modify the declared project only within the confirmed implementation scope, and run only checks authorized by the user and project instructions.';
}

class TaskOutputValidationError extends Error {
  readonly outputExcerpt: string;

  constructor(message: string, output: string) {
    super(message);
    this.name = 'TaskOutputValidationError';
    this.outputExcerpt = output.slice(0, 500);
  }
}

function parseTaskOutput(output: string, taskKey: string): AgentTeamTaskResult {
  try {
    return parseTaskOutputUnsafe(output, taskKey);
  } catch (error) {
    if (error instanceof TaskOutputValidationError) throw error;
    throw new TaskOutputValidationError(
      error instanceof Error ? error.message : String(error),
      output,
    );
  }
}

function parseTaskOutputUnsafe(output: string, taskKey: string): AgentTeamTaskResult {
  let value: RawTaskOutput;
  try {
    value = JSON.parse(output) as RawTaskOutput;
  } catch {
    throw new Error('The Agent Team role returned invalid JSON.');
  }
  if (value?.status === 'waiting_for_input') {
    const question = typeof (value.pendingInput as { question?: unknown } | undefined)?.question === 'string'
      ? ((value.pendingInput as { question: string }).question).trim()
      : undefined;
    if (!question) throw new Error('The Agent Team input request has no question.');
    return {
      status: 'waiting_for_input',
      pendingInput: { id: `placeholder_${randomUUID()}`, question, scopeRevision: 0 },
    };
  }
  if (value?.status !== 'completed') {
    throw new Error(`The Agent Team role returned an unsupported task status: ${JSON.stringify(value?.status)}.`);
  }
  if (typeof value.completedAssignedWork !== 'boolean') {
    throw new Error('The Agent Team role did not report assigned-work completion.');
  }
  const developmentAssignments = parseDevelopmentAssignments(value.developmentAssignments);
  const repairRequests = parseRepairRequests(value.repairRequests);
  return {
    status: 'completed',
    documents: parseDocuments(value.documents, taskKey),
    unresolvedIssues: parseStrings(value.unresolvedIssues, 'unresolved issue'),
    commandIds: [],
    changedFiles: parseStrings(value.changedFiles, 'changed file'),
    completedAssignedWork: value.completedAssignedWork,
    criterionAssessments: parseAssessments(value.criterionAssessments),
    repairRequest: parseRepairRequest(value.repairRequest),
    ...(developmentAssignments ? { developmentAssignments } : {}),
    ...(repairRequests ? { repairRequests } : {}),
  };
}

function parseDocuments(value: unknown, taskKey: string): AgentTeamDocument[] {
  if (!Array.isArray(value)) throw new Error('The Agent Team role returned no document list.');
  return value.map((item) => {
    const document = item as Partial<AgentTeamDocument>;
    if (typeof document.key !== 'string' || !document.key.trim()) throw new Error('A Team document key is required.');
    if (typeof document.title !== 'string' || !document.title.trim()) throw new Error('A Team document title is required.');
    if (typeof document.content !== 'string') throw new Error('Team document content must be text.');
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
      throw new Error(`Team document ${document.key} references unknown upstream document ${missingKey}.`);
    }
  }
}

function parseStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`The Agent Team role returned no ${field} list.`);
  return value.filter((item): item is string => typeof item === 'string');
}

function parseAssessments(value: unknown): AgentTeamCriterionAssessment[] {
  if (!Array.isArray(value)) throw new Error('The Agent Team role returned no criterion assessment list.');
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
    return {
      ...(typeof assignment.developerId === 'string' && assignment.developerId.trim()
        ? { developerId: assignment.developerId.trim() }
        : {}),
      title: assignment.title.trim(),
      scopeSummary: assignment.scopeSummary,
      ownedPaths: assignment.ownedPaths as string[],
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

function toTaskAttemptView(row: typeof agentTeamTaskAttempts.$inferSelect, progressText = ''): AgentTeamTaskAttemptView {
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
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

function toDocumentView(row: typeof agentTeamDocuments.$inferSelect): AgentTeamDocumentView {
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

function toPendingInputView(row: typeof agentTeamPendingInputs.$inferSelect): AgentTeamPendingInputView {
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

function toOperationView(row: typeof agentTeamOperations.$inferSelect): AgentTeamOperationView {
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

function deriveRunProgress(
  run: AgentTeamRun,
  taskRows: ReadonlyArray<typeof agentTeamTaskAttempts.$inferSelect>,
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
    if (/^repair_test_authoring/.test(taskKey)) return 'test_authoring';
    if (/^repair_test_execution/.test(taskKey)) return 'test_execution';
    if (/^repair_review/.test(taskKey)) return 'review';
    if (/^repair_/.test(taskKey)) return 'repair';
    if (taskKey === 'planning') return 'planning';
    if (taskKey === 'test_design') return 'test_design';
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

  // Percent derives from the coarse phase ladder; a repair round keeps the
  // development index, and only assignment completion refines the fraction.
  const PHASE_ORDER: ReadonlyArray<Exclude<AgentTeamRunProgress['phase'], 'terminal' | 'waiting' | 'repair'>> =
    ['planning', 'test_design', 'development', 'test_authoring', 'test_execution', 'review'];
  const workPhase = inFlight.length > 0
    ? phaseOfTaskKey(inFlight[inFlight.length - 1].taskKey)
    : latest ? phaseOfTaskKey(latest.taskKey) : 'planning';
  const ladderPhase = workPhase === 'repair' ? 'development' : workPhase;
  const phaseIndex = Math.max(0, PHASE_ORDER.indexOf(ladderPhase as (typeof PHASE_ORDER)[number]));
  const fraction = (workPhase === 'development' || workPhase === 'repair') && assignments.length > 0
    ? completedAssignments / assignments.length
    : 0;
  const percent = terminal ? 100 : Math.min(99, Math.round((100 * (phaseIndex + fraction)) / PHASE_ORDER.length));

  const activeDeveloperIds = terminal
    ? []
    : [...new Set(inFlight
      .filter((row) => row.role === 'developer')
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
    percent,
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
    Array.isArray(state.authorizedCommands) &&
    Array.isArray(state.documents) &&
    Array.isArray(state.unresolvedIssues) &&
    Array.isArray(state.commandIds) &&
    Array.isArray(state.criterionAssessments) &&
    typeof state.taskResults === 'object' &&
    state.taskResults !== null;
}

function recordCompletedCommand(
  record: { status: string; commandId?: string } | undefined,
  commandIds: Set<string>,
): void {
  if (record?.status === 'completed' && record.commandId) commandIds.add(record.commandId);
}

function normalizeAuthorizedCommands(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BadRequestException('Authorized commands must be an array.');
  const commands = value.map((command) => {
    if (typeof command !== 'string' || !command.trim()) {
      throw new BadRequestException('Each authorized command must be a non-empty string.');
    }
    return command.trim();
  });
  if (new Set(commands).size !== commands.length) {
    throw new BadRequestException('Authorized commands must be unique.');
  }
  return commands;
}

function mergeAuthorizedCommands(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])];
}

function pendingInputAnswer(answer: string, authorizedCommands: readonly string[]): AgentTeamPendingInputAnswer {
  return { answer, authorizedCommands };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : 'The Agent Team task failed.';
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
  const [attempt] = db.select({ taskKey: agentTeamTaskAttempts.taskKey })
    .from(agentTeamTaskAttempts)
    .where(eq(agentTeamTaskAttempts.id, taskAttemptId))
    .limit(1).all();
  return attempt?.taskKey ?? null;
}

function roleForTaskKey(taskKey: string): AgentTeamRole {
  return TASK_ROLES.find(([pattern]) => pattern.test(taskKey))?.[1] ?? 'reviewer';
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
