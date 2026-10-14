import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { agentExecutions, chatConfigurations, chatProjectOperations, chatProjectTasks, chatProjectTaskSubscriptions, type Database, type StoredProjectExecutor, type StoredProjectExecutorLaunch, type StoredProjectExecutorModelSource } from '@worklite/db';
import type { AnswerAgentQuestionRequest, ChatProjectOperationDetailView, ChatProjectTaskView } from '@worklite/contracts';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { ClaudeCodeError } from './claude-code.service';
import { CodexAppServerError } from './codex-app-server.service';
import { ProjectExecutorService } from './project-executor.service';
import { enqueueTaskMerge, inspectGitRepository, mergeTaskWorktree, prepareTaskWorktree, reconcileInterruptedMerge, removeTaskWorktree } from './git-worktree';

type Task = typeof chatProjectTasks.$inferSelect;
const RECENT_ACTIVITY_LIMIT = 20;
const FULL_ACTIVITY_LIMIT = 500;
const RECENT_OPERATION_LIMIT = 50;

const attachmentUploadUrl = (task: Task) => {
  const apiUrl = process.env.WORKLITE_API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 23391}/api`;
  return `${apiUrl}/chat/attachments?${new URLSearchParams({ projectTaskId: task.id, conversationId: task.executionId }).toString()}`;
};

// The card stage is derived from the executor's own activity stream; no percentage is
// fabricated because a project task has no known denominator.
function deriveTaskStage(task: Task): ChatProjectTaskView['stage'] {
  if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') return task.status;
  if (task.status === 'waiting_for_input' || task.status === 'waiting_for_recovery') return 'waiting';
  const latest = [...task.activities].reverse().find((activity) => typeof activity.phase === 'string');
  const phase = typeof latest?.phase === 'string' ? latest.phase : '';
  if (/(?:agent_message|item_completed|completed)$/.test(phase)) return 'responding';
  if (/tool_started|tool_completed|mcp\.call|skill\.script/.test(phase)) return 'working';
  return 'starting';
}

export const CHAT_PROJECT_TASK_TOOL = {
  name: 'project_task',
  description: 'Execute coding, repository investigation and local command requests by delegating the complete user task, relevant existing review findings and approved scope to a project executor, Codex or Claude Code, independently of Agent Team. This is the default for project work; do not first search files or run commands in Chat. The task runs in the background: the turn continues immediately after dispatch, progress stays visible on the task card, and completion or a task question is reported to the user automatically without polling. Tasks in the same project directory run in parallel: a task inside a git repository works in its own captured worktree and merges back automatically on success, while a directory outside git keeps one active task at a time. Inspect previous task effects before taking over. Set executor only when the user names Codex or Claude Code; otherwise the Chat configuration\'s default executor applies. Omit model to use the Chat configuration\'s declared default model for that executor, falling back to the executor\'s own configured default; a requested model must be a Gateway public id on a protocol that executor supports. The executor works natively in the task working directory with its own tools, without WorkLite proposal confirmation or individual command grants.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['goal', 'projectDirectory'], properties: { goal: { type: 'string' }, projectDirectory: { type: 'string' }, executor: { type: 'string', enum: ['claude', 'codex'] }, model: { type: 'string' } } },
} as const;

export const CHAT_PROJECT_TASK_ANSWER_TOOL = {
  name: 'answer_project_task',
  description: 'Answer the pending question of a conversation-owned background project task so it resumes running. The taskId and questionId come from the task record or its report; answer only what the user stated.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['taskId', 'questionId', 'answer'], properties: { taskId: { type: 'string' }, questionId: { type: 'string' }, answer: { type: 'string' } } },
} as const;

export const CHAT_PROJECT_TASK_CANCEL_TOOL = {
  name: 'cancel_project_task',
  description: 'Cancel an active conversation-owned background project task when the user asks to stop it.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['taskId'], properties: { taskId: { type: 'string' } } },
} as const;

@Injectable()
export class ChatProjectTasksService {
  private readonly active = new Map<string, { controller: AbortController; completion: Promise<Task> }>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly executors: ProjectExecutorService,
    private readonly resources: WorkspaceResourcesService,
  ) {}

  async capture(workspaceId: string, executionId: string, callId: string, input: unknown): Promise<Task> {
    const existing = this.db.select().from(chatProjectTasks).where(eq(chatProjectTasks.id, callId)).get();
    if (existing) return existing;
    const execution = this.db.select().from(agentExecutions).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.workspaceId, workspaceId))).get();
    const value = input as { goal?: unknown; projectDirectory?: unknown; model?: unknown; executor?: unknown };
    const goal = required(value?.goal, 'goal');
    const directory = required(value?.projectDirectory, 'projectDirectory');
    if (value?.executor !== undefined && value.executor !== 'codex' && value.executor !== 'claude') throw new BadRequestException('请选择 codex 或 claude 执行器。');
    const requestedModel = value?.model === undefined ? null : required(value.model, 'model');
    if (!isAbsolute(directory)) throw new BadRequestException('A project task requires an absolute project directory.');
    const projectDirectory = resolve(directory);
    const directoryStat = await stat(projectDirectory).catch((error: NodeJS.ErrnoException) => {
      throw new BadRequestException(`无法访问项目目录 ${projectDirectory}（${error.code ?? '未知文件系统错误'}）。`);
    });
    if (!directoryStat.isDirectory()) throw new BadRequestException(`项目路径不是目录：${projectDirectory}。`);
    // Git-backed tasks run in their own worktree, so same-directory tasks proceed in parallel
    // without a cap. Non-git directories keep native execution and the one-active-task rule.
    const repository = await inspectGitRepository(projectDirectory);
    if (!repository) {
      const concurrent = this.db.select({ id: chatProjectTasks.id }).from(chatProjectTasks)
        .where(and(eq(chatProjectTasks.workspaceId, workspaceId), eq(chatProjectTasks.projectDirectory, projectDirectory), inArray(chatProjectTasks.status, ['running', 'waiting_for_input']))).get();
      if (concurrent) throw new ConflictException('该目录不是 Git 仓库，无法创建任务隔离 worktree；同一目录同一时间只允许一个执行中的任务，请等待其结束或取消后再发起。');
    } else if (!repository.branch) {
      throw new BadRequestException(`项目目录 ${projectDirectory} 处于 detached HEAD，无法创建任务 worktree；请先切换到一个分支。`);
    }
    if (!execution?.capabilitySnapshot) throw new ConflictException('This Chat turn has no captured capabilities; start a new turn.');
    const executor: StoredProjectExecutor = (value.executor as StoredProjectExecutor | undefined) ?? execution.capabilitySnapshot.defaultExecutor ?? 'claude';
    // Model precedence: task parameter, then the Chat configuration's declared default for this
    // executor, then the executor's own local default. The launch records the effective model and its source.
    const declaredModel = execution.capabilitySnapshot.defaultExecutorModels?.[executor]?.trim() || null;
    const launch = await this.executors.captureLaunch(executor, requestedModel ?? declaredModel);
    const model = (requestedModel ?? declaredModel) || (launch.executor === 'codex' ? launch.model : null);
    if (model) await this.executors.requireModel(workspaceId, executor, model);
    const modelSource: StoredProjectExecutorModelSource = requestedModel ? 'task' : declaredModel ? 'configuration' : 'executor';
    const capturedLaunch: StoredProjectExecutorLaunch = launch.executor === 'codex'
      ? { ...launch, model: model ?? launch.model, modelSource }
      : { ...launch, model, modelSource };
    const projectInstructions: Array<{ path: string; content: string }> = [];
    for (const path of ['AGENTS.md', 'AGENTS_WORKFLOW.md', 'CLAUDE.md']) {
      try { projectInstructions.push({ path, content: await readFile(join(projectDirectory, path), 'utf8') }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    // Create the worktree only after every other validation has passed, so a rejected capture
    // never leaves one behind; a failed insert removes it again below.
    const worktree = repository?.branch ? await prepareTaskWorktree({ ...repository, branch: repository.branch }, callId).catch((error: unknown) => {
      throw new BadRequestException(`无法为任务创建 worktree：${error instanceof Error ? error.message : String(error)}`);
    }) : null;
    try {
      return this.db.insert(chatProjectTasks).values({
        id: callId, workspaceId, executionId, goal, projectDirectory, model: model ?? '',
        snapshot: { launch: capturedLaunch, projectInstructions, capabilities: execution.capabilitySnapshot }, status: 'running',
        worktreePath: worktree?.worktreePath ?? null, worktreeBranch: worktree?.worktreeBranch ?? null,
        baseBranch: worktree?.baseBranch ?? null, baseCommit: worktree?.baseCommit ?? null,
        mergeStatus: worktree ? 'not_attempted' : 'skipped_not_git',
      }).returning().get();
    } catch (error) {
      // A failed capture must not leave a stray worktree behind.
      if (worktree) await removeTaskWorktree(projectDirectory, worktree.worktreePath, worktree.worktreeBranch).catch(() => undefined);
      throw error;
    }
  }

  async run(taskId: string, onProgress: () => Promise<void>, onSettled?: (task: Task) => void): Promise<Task> {
    const active = this.active.get(taskId);
    if (active) {
      if (onSettled) void active.completion.then(onSettled, () => undefined);
      return active.completion;
    }
    const controller = new AbortController();
    const completion = this.execute(taskId, controller.signal, onProgress).finally(() => this.active.delete(taskId));
    if (onSettled) void completion.then(onSettled, () => undefined);
    this.active.set(taskId, { controller, completion });
    return completion;
  }

  async cancel(taskId: string): Promise<Task> {
    const active = this.active.get(taskId);
    if (active) { active.controller.abort(new Error('The project task was cancelled.')); return active.completion; }
    const task = this.requireTask(taskId);
    if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') return task;
    return this.update(taskId, { status: 'cancelled', pendingQuestion: null, reportedAt: new Date() });
  }

  async answer(workspaceId: string, taskId: string, input: AnswerAgentQuestionRequest, accept: (transaction: Parameters<Parameters<Database['transaction']>[0]>[0]) => void): Promise<Task> {
    const task = this.requireTask(taskId, workspaceId);
    const question = task.pendingQuestion;
    if (task.status === 'waiting_for_recovery') throw new ConflictException('此旧任务在等待操作恢复，无法继续；请创建新任务，已有记录仍保留。');
    if (!question || question.id !== input.questionId || task.status !== 'waiting_for_input') throw new ConflictException('This project task question is no longer active.');
    if (input.recoveryDecision) throw new BadRequestException('This question does not accept a recovery decision.');
    const answer = required(input.answer, 'answer');
    return this.db.transaction((transaction) => {
      const current = transaction.select().from(chatProjectTasks).where(eq(chatProjectTasks.id, taskId)).get()!;
      if (current.pendingQuestion?.id !== question.id || current.status !== 'waiting_for_input') throw new ConflictException('This project task question has already been answered.');
      accept(transaction);
      // The task runs again, so its next settlement must be reported anew.
      return transaction.update(chatProjectTasks).set({ status: 'running', pendingQuestion: null, error: null, reportedAt: null, answers: [...current.answers, { question: question.question, answer }], updatedAt: new Date() }).where(eq(chatProjectTasks.id, taskId)).returning().get();
    });
  }

  view(taskId: string, workspaceId?: string, options?: { activities?: 'recent' | 'full' }): ChatProjectTaskView {
    const task = this.requireTask(taskId, workspaceId);
    const activityPhases: Record<string, number> = {};
    for (const activity of task.activities) {
      const phase = typeof activity.phase === 'string' ? activity.phase : 'unknown';
      activityPhases[phase] = (activityPhases[phase] ?? 0) + 1;
    }
    const allOperations = this.db.select().from(chatProjectOperations).where(eq(chatProjectOperations.taskId, taskId)).orderBy(asc(chatProjectOperations.createdAt)).all();
    const operationStatuses: Record<string, number> = {};
    for (const operation of allOperations) operationStatuses[operation.status] = (operationStatuses[operation.status] ?? 0) + 1;
    // 'recent' (default) feeds the model context and stays small; 'full' serves the
    // expanded card and is hard-capped, with activitiesTruncated marking the cutoff.
    const full = options?.activities === 'full';
    const activityWindow = task.activities.slice(full ? -FULL_ACTIVITY_LIMIT : -RECENT_ACTIVITY_LIMIT);
    const activities = activityWindow.map((activity) => ({
      ...(typeof activity.phase === 'string' ? { phase: activity.phase } : {}),
      ...(typeof activity.itemType === 'string' ? { itemType: activity.itemType } : {}),
      ...(typeof activity.summary === 'string' ? { summary: activity.summary } : {}),
      ...(typeof activity.text === 'string' ? { text: activity.text } : {}),
      ...(typeof activity.commandExecutionId === 'string' ? { commandExecutionId: activity.commandExecutionId } : {}),
      ...(typeof activity.toolName === 'string' ? { toolName: activity.toolName } : {}),
      ...(typeof activity.createdAt === 'string' ? { createdAt: activity.createdAt } : {}),
    }));
    const operations = allOperations.slice(-RECENT_OPERATION_LIMIT).map(({ key, toolName, status, commandId, result, failureReason }) => ({
      key, toolName, status, commandExecutionId: commandId, inputSummary: operationInputSummary(result, toolName), failureReason,
    }));
    const launch = task.snapshot.launch && 'executor' in task.snapshot.launch ? task.snapshot.launch : undefined;
    const progressText = [...task.activities].reverse().find((activity) => typeof activity.text === 'string')?.text;
    return {
      executor: launch?.executor ?? null,
      ...(launch ? { launch } : {}),
      id: task.id, executionId: task.executionId, goal: task.goal, projectDirectory: task.projectDirectory, model: task.model,
      status: task.status, stage: deriveTaskStage(task), configurationRevision: task.snapshot.capabilities.revision, pendingQuestion: task.pendingQuestion,
      activityCount: task.activities.length, activityPhases, activities, progressText: typeof progressText === 'string' ? progressText : '', result: task.result, error: task.error,
      worktreePath: task.worktreePath, worktreeBranch: task.worktreeBranch, baseBranch: task.baseBranch, baseCommit: task.baseCommit,
      mergeStatus: task.mergeStatus, mergeError: task.mergeError,
      ...(full && task.activities.length > activityWindow.length ? { activitiesTruncated: true } : {}),
      operationCount: allOperations.length, operationStatuses, operations,
      createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString(),
    };
  }

  operation(taskId: string, operationKey: string, workspaceId?: string): ChatProjectOperationDetailView {
    this.requireTask(taskId, workspaceId);
    const operation = this.db.select().from(chatProjectOperations).where(and(eq(chatProjectOperations.key, operationKey), eq(chatProjectOperations.taskId, taskId))).get();
    if (!operation) throw new NotFoundException('Chat project task operation not found.');
    return { taskId, key: operation.key, toolName: operation.toolName, status: operation.status, commandExecutionId: operation.commandId, result: operation.result, failureReason: operation.failureReason };
  }

  list(executionId: string): ChatProjectTaskView[] {
    return this.db.select({ id: chatProjectTasks.id }).from(chatProjectTasks).where(eq(chatProjectTasks.executionId, executionId)).orderBy(asc(chatProjectTasks.createdAt)).all().map(({ id }) => this.view(id));
  }

  // Workspace-wide task discovery for cross-conversation awareness: any conversation can find
  // tasks dispatched by other conversations. Active tasks come first, then most recently updated.
  listWorkspace(workspaceId: string, options?: { status?: 'active' | 'settled' | 'all'; limit?: number }): ChatProjectTaskView[] {
    const status = options?.status ?? 'all';
    const condition = status === 'active' ? inArray(chatProjectTasks.status, ['running', 'waiting_for_input'])
      : status === 'settled' ? inArray(chatProjectTasks.status, ['succeeded', 'failed', 'cancelled'])
        : undefined;
    const rows = this.db.select({ id: chatProjectTasks.id }).from(chatProjectTasks)
      .where(and(eq(chatProjectTasks.workspaceId, workspaceId), condition))
      .orderBy(desc(chatProjectTasks.updatedAt))
      .limit(Math.min(Math.max(options?.limit ?? 50, 1), 200))
      .all();
    return rows.map(({ id }) => this.view(id, workspaceId));
  }

  // One-shot subscription: when the task next settles, the subscribing conversation receives the
  // standard background-task report and the subscription is consumed.
  subscribe(workspaceId: string, taskId: string, subscriberExecutionId: string): { subscribed: boolean } {
    const task = this.requireTask(taskId, workspaceId);
    const execution = this.db.select({ id: agentExecutions.id }).from(agentExecutions)
      .where(and(eq(agentExecutions.id, subscriberExecutionId), eq(agentExecutions.workspaceId, workspaceId))).get();
    if (!execution) throw new NotFoundException('Chat conversation not found.');
    if (task.executionId === subscriberExecutionId) return { subscribed: false };
    const existing = this.db.select({ id: chatProjectTaskSubscriptions.id }).from(chatProjectTaskSubscriptions)
      .where(and(eq(chatProjectTaskSubscriptions.taskId, taskId), eq(chatProjectTaskSubscriptions.subscriberExecutionId, subscriberExecutionId))).get();
    if (existing) return { subscribed: true };
    this.db.insert(chatProjectTaskSubscriptions).values({ id: `csub_${randomUUID()}`, workspaceId, taskId, subscriberExecutionId }).onConflictDoNothing().run();
    return { subscribed: true };
  }

  // Subscriptions whose task has settled and whose report has not run yet (startup sweep).
  pendingSubscriptionReports(): Array<{ subscriptionId: string; task: Task; subscriberExecutionId: string }> {
    const rows = this.db.select().from(chatProjectTaskSubscriptions).all();
    return rows.flatMap((row) => {
      const task = this.db.select().from(chatProjectTasks).where(eq(chatProjectTasks.id, row.taskId)).get();
      if (!task || !['succeeded', 'failed', 'waiting_for_input'].includes(task.status)) return [];
      return [{ subscriptionId: row.id, task, subscriberExecutionId: row.subscriberExecutionId }];
    });
  }

  // Subscriptions of one settled task; reporting consumes (deletes) each row.
  subscriptionsFor(taskId: string): Array<{ id: string; subscriberExecutionId: string }> {
    return this.db.select({ id: chatProjectTaskSubscriptions.id, subscriberExecutionId: chatProjectTaskSubscriptions.subscriberExecutionId })
      .from(chatProjectTaskSubscriptions).where(eq(chatProjectTaskSubscriptions.taskId, taskId)).all();
  }

  consumeSubscription(subscriptionId: string): void {
    this.db.delete(chatProjectTaskSubscriptions).where(eq(chatProjectTaskSubscriptions.id, subscriptionId)).run();
  }

  // Background tasks stay active after their originating turn settles, so conversation-level
  // cancel and the conversation list read this query rather than the turn's unresolved calls.
  activeForExecution(executionId: string): Task[] {
    return this.db.select().from(chatProjectTasks)
      .where(and(eq(chatProjectTasks.executionId, executionId), inArray(chatProjectTasks.status, ['running', 'waiting_for_input'])))
      .all();
  }

  // Settled tasks whose report never ran (for example the API stopped between settlement and the
  // report turn) are picked up once at startup. Restart-interrupted tasks are already marked reported.
  unreportedSettled(): Task[] {
    return this.db.select().from(chatProjectTasks)
      .where(and(isNull(chatProjectTasks.reportedAt), inArray(chatProjectTasks.status, ['succeeded', 'failed', 'waiting_for_input'])))
      .all();
  }

  private async execute(taskId: string, signal: AbortSignal, onProgress: () => Promise<void>): Promise<Task> {
    let task = this.requireTask(taskId);
    if (['succeeded', 'cancelled'].includes(task.status)) return task;
    if (task.status === 'waiting_for_recovery') return this.update(taskId, { status: 'failed', pendingQuestion: null, error: '此旧任务在等待操作恢复，无法继续；请创建新任务，已有记录仍保留。' });
    const previousEvidence = task.activities.length ? this.view(taskId) : undefined;
    // A re-run (retry or answer) clears the report marker so the next settlement reports again.
    task = this.update(taskId, { status: 'running', pendingQuestion: null, error: null, reportedAt: null });
    const activity = async (detail: Record<string, unknown>) => {
      this.db.transaction((transaction) => {
        const current = transaction.select().from(chatProjectTasks).where(eq(chatProjectTasks.id, taskId)).get()!;
        transaction.update(chatProjectTasks).set({ activities: [...current.activities, { ...detail, createdAt: new Date().toISOString() }], updatedAt: new Date() }).where(eq(chatProjectTasks.id, taskId)).run();
      });
      await onProgress();
    };
    try {
      const launch = task.snapshot.launch;
      if (!launch || !('executor' in launch)) throw new BadRequestException('此旧任务未记录执行器；请创建新任务，已有记录仍保留。');
      const capabilities = task.snapshot.capabilities;
      // Git-backed tasks execute inside their captured worktree; the original directory stays
      // on the record for display and merge-back.
      const workingDirectory = task.worktreePath ?? task.projectDirectory;
      const configuration = this.db.select({ extensionPrompt: chatConfigurations.extensionPrompt, projectTaskMcpServerIds: chatConfigurations.projectTaskMcpServerIds }).from(chatConfigurations)
        .where(and(eq(chatConfigurations.workspaceId, task.workspaceId), eq(chatConfigurations.revision, capabilities.revision))).get();
      // Chat hands no Skills to its executor, including from snapshots captured before selection was removed.
      // MCP servers declared in the Chat configuration are injected into Claude Code tasks only, through the
      // shared per-task handover; their credentials are resolved in server memory and never enter the prompt.
      const declaredMcpServers = launch.executor === 'claude' && configuration?.projectTaskMcpServerIds.length
        ? await this.resources.workflowMcpRuntimes(task.workspaceId, configuration.projectTaskMcpServerIds)
        : [];
      const output = await this.executors.execute({
        owner: 'chat', workspaceId: task.workspaceId, launch, model: task.model || null,
        projectDirectory: workingDirectory,
        skills: [],
        mcpServers: declaredMcpServers,
        systemPrompt: [
          `Execute this Chat-owned project task independently of Agent Team. Work entirely inside the current working directory, which is the task's dedicated workspace, and never switch to another checkout of the same repository. Follow the captured project instructions in the pinned reference files and discover additional applicable project instructions. Existing project confirmation, verification and service-lifecycle constraints remain authoritative; WorkLite adds no proposal confirmation or command grants. Keep work within the user task. Use supplied review findings and approved scope to check the affected code and make the requested changes without repeating the complete review. Inspect the actual working tree and prior effects before taking over interrupted work. Explain concrete progress as work proceeds. Never perform WorkLite installation, build, upgrade-runner or service replacement; its independent managed runner owns deployment.${task.worktreePath ? ' Commit your finished changes on the current branch before returning; the platform merges that branch back automatically.' : ''} Return JSON: {"status":"succeeded","summary":"..."} or {"status":"waiting_for_input","pendingInput":{"question":"..."}}. Ask only for material missing information or authorization; evidence and clarification answers do not authorize unrelated work.`,
          'To show an image such as a screenshot in your report, upload the file as the raw request body to attachmentUploadUrl from the input with its image media type, for example `curl -sS --data-binary @shot.png -H \'Content-Type: image/png\' "<attachmentUploadUrl>&fileName=shot.png"`. Only PNG, JPEG, GIF and WebP up to 10 MB are accepted. Put the returned `markdown` value, such as ![shot.png](/api/chat/attachments/att_…), in the summary exactly as returned; never reference local file paths or file:// URLs as images. Uploaded images expire with the request logs.',
          configuration?.extensionPrompt,
        ].filter(Boolean).join('\n\n'),
        references: task.snapshot.projectInstructions.map((instruction) => ({ path: `project-instructions/${instruction.path}`, content: instruction.content })),
        input: JSON.stringify({ goal: task.goal, projectDirectory: workingDirectory, taskId: task.id, attachmentUploadUrl: attachmentUploadUrl(task), ...(task.answers.length ? { answers: task.answers } : {}), ...(previousEvidence ? { previousEvidence } : {}) }),
        signal,
        onEvent: (detail) => activity(detail),
      });
      signal.throwIfAborted();
      const settlement = settleChatProjectTask(output, recentActivityTexts(this.requireTask(taskId).activities));
      if (settlement.status === 'waiting_for_input') return this.waitForInput(task, settlement.question);
      return this.mergeAndSettle(taskId, settlement);
    } catch (error) {
      if (signal.aborted) return this.update(taskId, { status: 'cancelled', pendingQuestion: null, reportedAt: new Date() });
      return this.update(taskId, { status: 'failed', pendingQuestion: null, error: error instanceof CodexAppServerError || error instanceof ClaudeCodeError || error instanceof BadRequestException || error instanceof NotFoundException ? error.message : '项目任务执行失败，请查看关联的命令记录。' });
    }
  }

  private waitForInput(task: Task, question: string): Task {
    return this.update(task.id, { status: 'waiting_for_input', pendingQuestion: { id: `question_${randomUUID()}`, projectTaskId: task.id, question, options: [], createdAt: new Date().toISOString() } });
  }

  // A successful git-backed task merges its branch back on the original checkout through the
  // shared per-checkout serialized queue; a conflict fails the task and retains the worktree.
  private mergeAndSettle(taskId: string, settlement: ExtractedSettlement): Promise<Task> | Task {
    const task = this.requireTask(taskId);
    if (!task.worktreePath || !task.worktreeBranch || !task.baseBranch) {
      return this.update(taskId, { status: 'succeeded', result: settlement.result, pendingQuestion: null, error: settlement.error });
    }
    return enqueueTaskMerge(task.projectDirectory, task.baseBranch, () => this.mergeWorktree(taskId, settlement));
  }

  private async mergeWorktree(taskId: string, settlement: ExtractedSettlement): Promise<Task> {
    const task = this.requireTask(taskId);
    if (!task.worktreePath || !task.worktreeBranch || !task.baseBranch) {
      return this.update(taskId, { status: 'succeeded', result: settlement.result, pendingQuestion: null, error: settlement.error });
    }
    this.update(taskId, { mergeStatus: 'merging' });
    const outcome = await mergeTaskWorktree({ projectDirectory: task.projectDirectory, worktreePath: task.worktreePath, worktreeBranch: task.worktreeBranch, baseBranch: task.baseBranch })
      .catch((error: unknown): { status: 'conflict'; error: string } => ({
        status: 'conflict',
        error: `自动合并任务分支 ${task.worktreeBranch} 时出现意外错误（${error instanceof Error ? error.message : String(error)}）；worktree ${task.worktreePath} 与分支已保留，请手动合并后清理。`,
      }));
    if (outcome.status === 'conflict') {
      return this.update(taskId, { status: 'failed', mergeStatus: 'conflict', mergeError: outcome.error, result: settlement.result, pendingQuestion: null, error: outcome.error });
    }
    return this.update(taskId, {
      status: 'succeeded', result: settlement.result, pendingQuestion: null, error: settlement.error,
      mergeStatus: outcome.cleanupPending ? 'merged_cleanup_pending' : 'merged',
    });
  }

  // Tasks interrupted mid-merge by an API restart: abort any partial merge and fail the task so
  // the settlement report explains the retained worktree.
  async reconcileInterruptedMerges(): Promise<void> {
    const tasks = this.db.select().from(chatProjectTasks).where(eq(chatProjectTasks.mergeStatus, 'merging')).all();
    for (const task of tasks) {
      await reconcileInterruptedMerge(task).catch(() => undefined);
      this.update(task.id, {
        status: 'failed', mergeStatus: 'conflict', pendingQuestion: null,
        mergeError: `API 重启中断了任务分支 ${task.worktreeBranch ?? ''} 的自动合并；worktree ${task.worktreePath ?? ''} 与分支已保留，请手动合并后清理。`,
        error: 'API 重启中断了自动合并，任务改动保留在其 worktree 中，请手动合并。',
      });
    }
  }

  private requireTask(taskId: string, workspaceId?: string): Task {
    const task = this.db.select().from(chatProjectTasks).where(and(eq(chatProjectTasks.id, taskId), workspaceId ? eq(chatProjectTasks.workspaceId, workspaceId) : undefined)).get();
    if (!task) throw new NotFoundException('Chat project task not found.');
    return task;
  }

  private update(taskId: string, patch: Partial<Omit<Task, 'id' | 'snapshot'>>): Task {
    return this.db.update(chatProjectTasks).set({ ...patch, updatedAt: new Date() }).where(eq(chatProjectTasks.id, taskId)).returning().get();
  }
}

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field} is required.`);
  return value.trim();
}

// The executor's final output is model-generated text: models routinely surround the result JSON
// with prose or markdown fences, and Claude Code's result event can carry an earlier progress
// report while the real result JSON sits in the last agent message. Settlement therefore accepts
// the first shape-valid result object found in the output, then in the executor's most recent
// message activities; a cleanly finished executor with unparseable output degrades to a succeeded
// task holding the raw output instead of failing, with the degradation recorded in `error`.
export type ChatProjectTaskSettlement =
  | { status: 'succeeded'; result: string; error: string | null }
  | { status: 'waiting_for_input'; question: string };

type ExtractedSettlement = Extract<ChatProjectTaskSettlement, { status: 'succeeded' }>;

export function settleChatProjectTask(output: string, activityTexts: readonly string[]): ChatProjectTaskSettlement {
  const parsed = extractTaskResult(output);
  if (parsed) return parsed.status === 'waiting_for_input'
    ? { status: 'waiting_for_input', question: parsed.question }
    : { status: 'succeeded', result: parsed.summary, error: null };
  for (const text of activityTexts) {
    const recovered = extractTaskResult(text);
    if (recovered) return recovered.status === 'waiting_for_input'
      ? { status: 'waiting_for_input', question: recovered.question }
      : { status: 'succeeded', result: recovered.summary, error: '执行器最终结果事件不含有效的结果 JSON，已从执行器最近的消息中恢复任务结果（解析降级）。' };
  }
  return { status: 'succeeded', result: output, error: '执行器最终输出不含有效的结果 JSON；执行器进程正常结束，原始输出已作为任务结果保留（解析降级）。' };
}

type ExtractedTaskResult = { status: 'succeeded'; summary: string } | { status: 'waiting_for_input'; question: string };

export function extractTaskResult(text: string): ExtractedTaskResult | null {
  for (const candidate of resultJsonCandidates(text)) {
    const value = parseJsonLenient(candidate);
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const result = value as { status?: unknown; summary?: unknown; pendingInput?: { question?: unknown } };
    if (result.status === 'waiting_for_input' && typeof result.pendingInput?.question === 'string' && result.pendingInput.question.trim()) {
      return { status: 'waiting_for_input', question: result.pendingInput.question.trim() };
    }
    if (result.status === 'succeeded' && typeof result.summary === 'string' && result.summary.trim()) {
      return { status: 'succeeded', summary: result.summary };
    }
  }
  return null;
}

function recentActivityTexts(activities: Task['activities']): string[] {
  return [...activities].reverse()
    .map((activity) => activity.text)
    .filter((text): text is string => typeof text === 'string')
    .slice(0, 5);
}

function* resultJsonCandidates(output: string): Generator<string> {
  const trimmed = output.trim();
  if (trimmed) yield trimmed;
  if (trimmed.startsWith('```')) yield trimmed.replace(/^```[^\n]*\n?/, '').replace(/\s*```\s*$/, '');
  for (const match of output.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) yield match[1].trim();
  yield* embeddedJsonObjects(output);
}

// Scans for balanced objects so a result JSON embedded in prose still parses; the `"status"`
// prefilter keeps prose braces and schema examples out of the parse attempts.
function* embeddedJsonObjects(text: string): Generator<string> {
  let yielded = 0;
  for (let start = 0; start < text.length && yielded < 100; start += 1) {
    if (text[start] !== '{') continue;
    const end = balancedObjectEnd(text, start);
    if (end < 0) continue;
    const candidate = text.slice(start, end);
    if (candidate.includes('"status"')) { yielded += 1; yield candidate; }
  }
}

function balancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function parseJsonLenient(candidate: string): unknown {
  try { return JSON.parse(candidate) as unknown; }
  catch {
    const escaped = escapeRawJsonStringControls(candidate);
    if (escaped === candidate) return undefined;
    try { return JSON.parse(escaped) as unknown; }
    catch { return undefined; }
  }
}

function escapeRawJsonStringControls(value: string): string {
  let inString = false;
  let escaped = false;
  let result = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (!inString) {
      result += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      result += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      result += character;
      inString = false;
      continue;
    }
    if (code < 0x20) result += code === 0x0a ? '\\n' : code === 0x0d ? '\\r' : code === 0x09 ? '\\t' : `\\u${code.toString(16).padStart(4, '0')}`;
    else result += character;
  }
  return result;
}

function operationInputSummary(result: unknown, toolName: string): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const call = (result as Record<string, unknown>).call;
  if (!call || typeof call !== 'object' || Array.isArray(call)) return null;
  const input = (call as Record<string, unknown>).input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const values = input as Record<string, unknown>;
  const value = (key: string) => typeof values[key] === 'string' && (values[key] as string).trim() ? (values[key] as string).trim() : null;
  const parts = toolName === 'bash' ? [value('command')]
    : toolName === 'grep' ? [value('pattern'), value('path')]
      : ['read', 'write', 'glob', 'process_reference'].includes(toolName) ? [value('path') ?? value('pattern')]
        : [];
  const summary = parts.filter((part): part is string => part !== null).join(' · ').replace(/\s+/g, ' ');
  return summary ? (summary.length > 180 ? `${summary.slice(0, 177)}…` : summary) : null;
}
