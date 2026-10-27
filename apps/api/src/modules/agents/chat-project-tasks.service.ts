import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { agentExecutions, agentToolCalls, chatConfigurations, chatProjectOperations, chatProjectTasks, chatProjectTaskSubscriptions, type Database, type StoredProjectExecutor, type StoredProjectExecutorLaunch, type StoredProjectExecutorModelSource, type StoredProjectTaskSteerInstruction } from '@worklite/db';
import { splitChatAttachmentImages, type AnswerAgentQuestionRequest, type ChatProjectOperationDetailView, type ChatProjectTaskView } from '@worklite/contracts';
import { normalizePublicModelList } from '@worklite/model-gateway';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { ChatAttachmentsService } from './chat-attachments.service';
import { ClaudeCodeError } from './claude-code.service';
import { CodexAppServerError } from './codex-app-server.service';
import { ProjectExecutorService } from './project-executor.service';
import type { ProjectExecutorSteerPort } from './project-executor.types';
import { enqueueTaskMerge, mergeTaskWorktree, reconcileInterruptedMerge } from './git-worktree';

type Task = typeof chatProjectTasks.$inferSelect;
const RECENT_ACTIVITY_LIMIT = 20;
const FULL_ACTIVITY_LIMIT = 500;
const RECENT_OPERATION_LIMIT = 50;
const STEER_TEXT_LIMIT = 4000;
const ROUND_STARTED_PHASE = 'task.round_started';
const SETTLED_STATUSES: ReadonlyArray<Task['status']> = ['succeeded', 'failed', 'cancelled'];

// Round markers and steer lifecycle entries are WorkLite's own bookkeeping in the activity stream,
// not executor progress, so they never decide the card stage.
function isBookkeepingPhase(phase: string): boolean {
  return phase === ROUND_STARTED_PHASE || phase.startsWith('steer.');
}

// A task's rounds are the executor runs it has made (first run, each answer resumption, each
// steer-driven follow-up); consumedTurn on a steer instruction refers to this 1-based count.
function roundCount(activities: Task['activities']): number {
  return activities.filter((activity) => activity.phase === ROUND_STARTED_PHASE).length;
}

const attachmentUploadUrl = (task: Task) => {
  const apiUrl = process.env.WORKLITE_API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 23391}/api`;
  return `${apiUrl}/chat/attachments?${new URLSearchParams({ projectTaskId: task.id, conversationId: task.executionId }).toString()}`;
};

// The card stage is derived from the executor's own activity stream; no percentage is
// fabricated because a project task has no known denominator. Exported for the periodic
// progress report, which summarizes active tasks with the same stage vocabulary.
export function deriveTaskStage(task: Task): ChatProjectTaskView['stage'] {
  if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') return task.status;
  if (task.status === 'waiting_for_input' || task.status === 'waiting_for_recovery') return 'waiting';
  const latest = [...task.activities].reverse().find((activity) => typeof activity.phase === 'string' && !isBookkeepingPhase(activity.phase));
  const phase = typeof latest?.phase === 'string' ? latest.phase : '';
  if (/(?:agent_message|item_completed|completed)$/.test(phase)) return 'responding';
  if (/tool_started|tool_completed|mcp\.call|skill\.script/.test(phase)) return 'working';
  return 'starting';
}

export const CHAT_PROJECT_TASK_TOOL = {
  name: 'project_task',
  description: 'Execute coding, repository investigation, local command and user-requested prompt-editing tasks by delegating the complete user task, relevant existing review findings and user-requested scope to a project executor, Codex or Claude Code, independently of Agent Team. This is the default for project work; do not first search files or run commands in Chat. The absolute projectDirectory may be one repository or a workspace containing multiple projects, and need not itself be a Git repository. The executor inspects relevant projects and decides per project whether to work on the current branch, switch to or create a feature branch, or use a project-specific worktree. WorkLite does not create branches or worktrees, merge branches, or clean up executor-managed Git state for new tasks. If a worktree is chosen, it belongs to one project rather than wrapping the whole workspace. For a WorkLite task that combines a code change and redeployment, set redeployAfterSuccess true; the managed runner starts from the WorkLite project root after task success. Do not set it for redeploy-only requests or other projects. The executor makes the code changes in the supplied checkout and does not run deployment commands. The task runs in the background: the turn continues immediately after dispatch, progress stays visible on the task card, and completion or a task question is reported to the user automatically without polling. Each model response may contain at most one project_task call, optionally alongside update_plan; never batch separate project_task calls. For one goal spanning multiple projects, use one call with their common workspace root. Tasks in the same workspace may run in parallel when dispatched separately; inspect previous task effects and actual workspace state before taking over or overlapping work. Set readOnly true when the goal is purely investigative — reading, searching, explaining or troubleshooting without any file changes; it adds a read-only instruction to the executor. Omit readOnly (or set false) whenever the task may create, modify or delete files. Set executor only when the user names Codex or Claude Code; otherwise the Chat configuration\'s default executor applies. Omit model to use the Chat configuration\'s declared default model for that executor, falling back to the executor\'s own configured default; a requested model must be a Gateway public id on a protocol that executor supports. The executor works natively in the supplied workspace with its own tools, without WorkLite proposal confirmation or individual command grants, and reports the project and Git strategy used. If a later user message adds to, narrows or corrects a running task\'s requirements, Chat passes it to that task with steer_project_task instead of dispatching again. If the message replaces the goal with different work, Chat asks whether to continue unchanged or cancel and create a new task, and it dispatches a replacement only after the old task\'s persisted status is cancelled.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['goal', 'projectDirectory'], properties: { goal: { type: 'string' }, projectDirectory: { type: 'string', description: 'Absolute repository or workspace root directory; it may contain multiple projects and need not itself be a Git repository.' }, readOnly: { type: 'boolean', description: 'True only for a purely investigative task that must not change files; it adds a read-only instruction. It does not select a Git strategy.' }, redeployAfterSuccess: { type: 'boolean', description: 'For a task combining a WorkLite code change and redeployment, set true; the task must target WorkLite’s managed project root and the managed runner starts after successful completion.' }, executor: { type: 'string', enum: ['claude', 'codex'] }, model: { type: 'string' } } },
} as const;

export const CHAT_PROJECT_TASK_ANSWER_TOOL = {
  name: 'answer_project_task',
  description: 'Answer the pending question of a conversation-owned background project task so it resumes running. The taskId and questionId come from the task record or its report; the task card is read-only and Chat calls this tool with the user\'s response. Answer only what the user stated.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['taskId', 'questionId', 'answer'], properties: { taskId: { type: 'string' }, questionId: { type: 'string' }, answer: { type: 'string' } } },
} as const;

export const CHAT_PROJECT_TASK_STEER_TOOL = {
  name: 'steer_project_task',
  description: 'Send a supplementary instruction (a correction, added requirement or narrowed scope stated by the user) to a running conversation-owned project task without cancelling or restarting it; the captured goal stays and the instruction is an increment on it. Codex receives it live in its current turn (status delivered). Claude Code, or a Codex turn that cannot accept it right now, queues it (status queued); when the current round ends the task runs a follow-up round that receives every queued instruction as userCorrections together with the previous round\'s evidence. Only a running task accepts one: answer a waiting task\'s question with answer_project_task, and dispatch a new project_task for a settled task. Pass the user\'s instruction faithfully; do not add requirements the user did not state.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['taskId', 'text'], properties: { taskId: { type: 'string' }, text: { type: 'string', description: 'The user\'s supplementary instruction, at most 4000 characters.' } } },
} as const;

export const CHAT_PROJECT_TASK_CANCEL_TOOL = {
  name: 'cancel_project_task',
  description: 'Cancel an active conversation-owned background project task when the user asks to stop it or has chosen cancel-and-create for a revised goal. Read its returned status; if it is still active, wait and inspect until it settles, and dispatch a replacement project_task only when persisted status is cancelled. On failure or any other terminal status do not dispatch a replacement.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['taskId'], properties: { taskId: { type: 'string' } } },
} as const;

@Injectable()
export class ChatProjectTasksService {
  private readonly active = new Map<string, { controller: AbortController; completion: Promise<Task> }>();
  // The live mid-turn delivery channel for whichever round of a task is currently executing, set
  // only while that round's executors.execute() call is in flight. Absent between rounds, during
  // waiting_for_input, or for an executor (Claude Code) that never populates its `deliver`.
  private readonly steerPorts = new Map<string, ProjectExecutorSteerPort>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly executors: ProjectExecutorService,
    private readonly resources: WorkspaceResourcesService,
    private readonly attachments: ChatAttachmentsService,
  ) {}

  async capture(workspaceId: string, executionId: string, callId: string, input: unknown): Promise<Task> {
    const existing = this.db.select().from(chatProjectTasks).where(eq(chatProjectTasks.id, callId)).get();
    if (existing) return existing;
    const execution = this.db.select().from(agentExecutions).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.workspaceId, workspaceId))).get();
    const value = input as { goal?: unknown; projectDirectory?: unknown; readOnly?: unknown; redeployAfterSuccess?: unknown; model?: unknown; executor?: unknown };
    const goal = required(value?.goal, 'goal');
    const directory = required(value?.projectDirectory, 'projectDirectory');
    if (value?.executor !== undefined && value.executor !== 'codex' && value.executor !== 'claude') throw new BadRequestException('请选择 codex 或 claude 执行器。');
    if (value?.readOnly !== undefined && typeof value.readOnly !== 'boolean') throw new BadRequestException('readOnly must be a boolean.');
    const readOnly = value?.readOnly === true;
    if (value?.redeployAfterSuccess !== undefined && typeof value.redeployAfterSuccess !== 'boolean') throw new BadRequestException('redeployAfterSuccess must be a boolean.');
    const redeployAfterSuccess = value?.redeployAfterSuccess === true;
    let redeployAuthorization: { userMessageId: string } | undefined;
    if (redeployAfterSuccess) {
      const userMessage = [...(execution?.displayMessages ?? [])].reverse().find((message) => message.role === 'user');
      const modelUserIndex = execution?.modelMessages.map((message) => message.role).lastIndexOf('user') ?? -1;
      const modelUser = modelUserIndex >= 0 ? execution?.modelMessages[modelUserIndex] : undefined;
      const toolCall = this.db.select({ toolCallId: agentToolCalls.toolCallId, input: agentToolCalls.input, mcpToolName: agentToolCalls.mcpToolName, status: agentToolCalls.status })
        .from(agentToolCalls).where(eq(agentToolCalls.id, callId)).get();
      const currentToolCall = execution?.modelMessages.slice(modelUserIndex + 1).some((message) => message.role === 'assistant'
        && message.content.some((part) => part.type === 'tool-call' && part.toolCallId === toolCall?.toolCallId));
      const toolInput = toolCall?.input as { redeployAfterSuccess?: unknown } | undefined;
      if (execution?.status !== 'running' || !userMessage || modelUser?.role !== 'user' || modelUser.content !== userMessage.content
        || !currentToolCall || toolCall?.mcpToolName !== 'project_task' || toolCall.status !== 'running'
        || toolInput?.redeployAfterSuccess !== true) {
        throw new BadRequestException('Automatic redeployment must be attached to the current user request and its project_task call.');
      }
      redeployAuthorization = { userMessageId: userMessage.id };
    }
    const requestedModel = value?.model === undefined ? null : required(value.model, 'model');
    if (!isAbsolute(directory)) throw new BadRequestException('A project task requires an absolute workspace directory.');
    const projectDirectory = resolve(directory);
    const directoryStat = await stat(projectDirectory).catch((error: NodeJS.ErrnoException) => {
      throw new BadRequestException(`无法访问项目目录 ${projectDirectory}（${error.code ?? '未知文件系统错误'}）。`);
    });
    if (!directoryStat.isDirectory()) throw new BadRequestException(`项目路径不是目录：${projectDirectory}。`);
    if (redeployAfterSuccess && readOnly) throw new BadRequestException('A read-only project task cannot request redeployment after success.');
    const managedProjectRoot = process.env.WORKLITE_PROJECT_ROOT;
    if (redeployAfterSuccess && managedProjectRoot && projectDirectory !== resolve(managedProjectRoot)) {
      throw new BadRequestException('A redeploy-after-success task must use the managed WorkLite project root.');
    }
    if (!execution?.capabilitySnapshot) throw new ConflictException('This Chat turn has no captured capabilities; start a new turn.');
    const executor: StoredProjectExecutor = (value.executor as StoredProjectExecutor | undefined) ?? execution.capabilitySnapshot.defaultExecutor ?? 'claude';
    // Model precedence: task parameter, then the Chat configuration's declared default for this
    // executor, then the executor's own local default. The launch records the effective model and its
    // source. A project executor launches one native process with no Gateway-level fallback loop, so a
    // declared fallback list here only ever uses its first (primary) candidate.
    const declaredModel = normalizePublicModelList(execution.capabilitySnapshot.defaultExecutorModels?.[executor] ?? '')[0] ?? null;
    const model = requestedModel ?? declaredModel;
    const launch = await this.executors.captureLaunch(executor, model);
    if (model) await this.executors.requireModel(workspaceId, executor, model);
    const modelSource: StoredProjectExecutorModelSource = requestedModel ? 'task' : declaredModel ? 'configuration' : 'executor';
    const capturedLaunch: StoredProjectExecutorLaunch = { ...launch, model, modelSource };
    // Images the user attached to the request that produced this call. Only the turn's own user
    // message is read, so an image pasted in an earlier turn never leaks into an unrelated task.
    const inboundImages = this.inboundImagesOf(workspaceId, [...(execution?.displayMessages ?? [])].reverse().find((message) => message.role === 'user')?.content ?? '');
    const projectInstructions: Array<{ path: string; content: string }> = [];
    for (const path of ['AGENTS.md', 'AGENTS_WORKFLOW.md', 'CLAUDE.md']) {
      try { projectInstructions.push({ path, content: await readFile(join(projectDirectory, path), 'utf8') }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return this.db.insert(chatProjectTasks).values({
      id: callId, workspaceId, executionId, goal, projectDirectory, model: model ?? '',
      snapshot: { launch: capturedLaunch, projectInstructions, capabilities: execution.capabilitySnapshot, readOnly, ...(inboundImages.length ? { inboundImages } : {}), ...(redeployAfterSuccess ? { redeployAfterSuccess, redeployAuthorization } : {}) }, status: 'running',
      worktreePath: null, worktreeBranch: null, baseBranch: null, baseCommit: null,
      mergeStatus: 'not_attempted',
    }).returning().get();
  }

  // Attachment images embedded in a user message, kept only when the attachment is still live and
  // owned by this workspace, so a task never carries a reference it cannot resolve later.
  private inboundImagesOf(workspaceId: string, content: string): Array<{ attachmentId: string; description: string }> {
    const seen = new Set<string>();
    return splitChatAttachmentImages(content).images.flatMap((image) => {
      if (seen.has(image.id)) return [];
      seen.add(image.id);
      try { this.attachments.open(workspaceId, image.id); }
      catch { return []; }
      return [{ attachmentId: image.id, description: image.alt }];
    });
  }

  // Reads the captured inbound images back out of the attachment store for one executor round. An
  // image that expired or was deleted meanwhile is skipped rather than failing the round.
  private async loadInboundImages(task: Task): Promise<Array<{ fileName: string; description?: string; body: Buffer }>> {
    const captured = task.snapshot.inboundImages ?? [];
    const loaded = await Promise.all(captured.map((image) => this.attachments.load(task.workspaceId, image.attachmentId)
      // The captured description is the Markdown alt text, which defaults to the file name; repeating
      // it next to the path would tell the executor nothing.
      .then((file) => file ? { fileName: file.fileName, ...(image.description && image.description !== file.fileName ? { description: image.description } : {}), body: file.body } : null)));
    return loaded.filter((image): image is { fileName: string; description?: string; body: Buffer } => image !== null);
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
      ...(typeof activity.seq === 'number' ? { seq: activity.seq } : {}),
      ...(typeof activity.round === 'number' ? { round: activity.round } : {}),
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
      steerQueue: task.steerQueue,
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
    const task = this.requireTask(taskId);
    if (['succeeded', 'cancelled'].includes(task.status)) return task;
    if (task.status === 'waiting_for_recovery') return this.update(taskId, { status: 'failed', pendingQuestion: null, error: '此旧任务在等待操作恢复，无法继续；请创建新任务，已有记录仍保留。' });
    // Runs rounds back to back, within the same background execute() call, until a round settles
    // with no steer instruction left stranded. A steer submitted after this round's goal was built
    // but before its settlement committed (the race between executors.execute() returning and the
    // user's request reaching the DB) would otherwise sit 'queued' forever on an already-succeeded
    // task with no future run to pick it up; looping here is what keeps the task continuous instead
    // of needing the user to notice and re-dispatch.
    for (;;) {
      const round = await this.executeRound(taskId, signal, onProgress);
      if (round.status !== 'ran') return round.task;
      const stranded = round.task.steerQueue.some((instruction) => instruction.status === 'queued');
      if (!stranded) return this.mergeAndSettle(taskId, round.settlement);
      // Record this round's result as interim progress before another round folds in the
      // stranded instruction; the final settlement overwrites it once a round truly finishes.
      this.update(taskId, { result: round.settlement.result, error: round.settlement.error });
    }
  }

  // Runs exactly one executor round and returns its outcome without merging or settling: a caller
  // loops on 'ran' with queued steers still pending, and otherwise finalizes (waiting_for_input,
  // cancelled, or failed) as-is.
  private async executeRound(taskId: string, signal: AbortSignal, onProgress: () => Promise<void>)
    : Promise<{ status: 'waiting_for_input' | 'cancelled' | 'failed'; task: Task } | { status: 'ran'; task: Task; settlement: ExtractedSettlement }> {
    let task = this.requireTask(taskId);
    const previousEvidence = task.activities.length ? this.view(taskId) : undefined;
    const round = roundCount(task.activities) + 1;
    // A re-run (retry, answer, or another round in this same loop) clears the report marker so the
    // next settlement reports again.
    task = this.update(taskId, { status: 'running', pendingQuestion: null, error: null, reportedAt: null });
    this.appendActivities(taskId, [{ phase: ROUND_STARTED_PHASE, round, summary: `Round ${round}` }]);
    // The round boundary: queued steer instructions are marked consumed (with the round number and
    // time) and handed to this round's input in one transaction, so a later round or a repeated call
    // can never inject the same instruction twice. Nothing is consumed once the task has settled.
    const pendingSteers = this.consumeQueuedSteers(taskId, round);
    task = this.requireTask(taskId);
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
      // Historical tasks with a captured WorkLite worktree keep their recorded merge path.
      // New tasks run from the supplied workspace root, and readOnly remains an instruction.
      const workingDirectory = task.worktreePath ?? task.projectDirectory;
      const readOnlyInstruction = task.snapshot.readOnly === true || task.mergeStatus === 'skipped_read_only'
        ? ' This is a read-only investigation task: answer from reading and searching only, and do not create, modify or delete any file in the project directory or elsewhere.'
        : '';
      const legacyWorktreeInstruction = task.worktreePath
        ? `The task was captured with the historical WorkLite-managed worktree ${task.worktreePath} on branch ${task.worktreeBranch ?? ''}; commit your finished changes there so the recorded legacy merge path can handle them.`
        : '';
      const redeployInstruction = task.snapshot.redeployAfterSuccess
        ? 'The current user explicitly requested both this WorkLite code change and redeployment. Apply every change directly in the exact supplied managed project root checkout; do not create or switch to a separate branch or worktree because the managed runner snapshots this checkout after you report success. Do not ask for another confirmation. Do not run installation, deployment, upgrade-runner or service-replacement commands yourself; after your task reaches succeeded, the WorkLite API starts the managed runner automatically. Perform the requested non-deployment verification and report its result.'
        : '';
      const configuration = this.db.select({ executorContext: chatConfigurations.executorContext, projectTaskMcpServerIds: chatConfigurations.projectTaskMcpServerIds }).from(chatConfigurations)
        .where(and(eq(chatConfigurations.workspaceId, task.workspaceId), eq(chatConfigurations.revision, capabilities.revision))).get();
      // Chat hands no Skills to its executor, including from snapshots captured before selection was removed.
      // MCP servers declared in the Chat configuration are injected into Claude Code tasks only, through the
      // shared per-task handover; their credentials are resolved in server memory and never enter the prompt.
      const declaredMcpServers = launch.executor === 'claude' && configuration?.projectTaskMcpServerIds.length
        ? await this.resources.workflowMcpRuntimes(task.workspaceId, configuration.projectTaskMcpServerIds)
        : [];
      const steerPort: ProjectExecutorSteerPort = {};
      this.steerPorts.set(taskId, steerPort);
      const inboundImages = await this.loadInboundImages(task);
      const output = await this.executors.execute({
        owner: 'chat', workspaceId: task.workspaceId, launch, model: task.model || null,
        // A project task's Gateway traffic belongs to the conversation that dispatched
        // it and is kept apart from that conversation's own model loop by the surface.
        correlation: { surface: 'chat_project_task', conversationId: task.executionId, projectTaskId: task.id, executor: launch.executor },
        projectDirectory: workingDirectory,
        skills: [],
        mcpServers: declaredMcpServers,
        executorContext: configuration?.executorContext,
        systemPrompt: [
          `Execute this Chat-owned project task independently of Agent Team. The supplied working directory is a workspace root: it may contain multiple projects or repositories and need not itself be a Git repository. Inspect the relevant project directories, their applicable instructions, actual working trees and prior task effects before changing files or taking over interrupted work. Decide independently for each relevant project whether to use its current branch, switch to or create a feature branch, or create a worktree for that project, unless a captured redeployAfterSuccess request requires the exact supplied checkout. Do not assume every project needs a worktree, and do not create one around the entire workspace. WorkLite does not create branches or worktrees, merge branches, or clean up Git state for new tasks; you own any Git operations you choose and should report the project paths, strategy, branch or worktree paths, and outcome in your summary. Follow captured workspace-root instructions in the pinned reference files and discover additional applicable project instructions. Follow project instructions for code conventions and useful verification, but the current user's explicit requested scope takes priority; do not add a confirmation step for a clearly requested change. Keep work within the user task. Use supplied review findings and user-requested scope to check affected code without repeating the complete review. Explain concrete progress as work proceeds.${redeployInstruction} Do not perform WorkLite installation, deployment, upgrade-runner or service replacement commands yourself; the managed runner owns that lifecycle.${legacyWorktreeInstruction}${readOnlyInstruction} The user may submit a mid-run correction while you are working; if your input carries userCorrections, the user is redirecting or adjusting the task itself (not answering a question you asked), so weigh them as the current instruction over the original goal where they conflict and continue the same task without starting over or discarding unrelated completed work. Return JSON: {"status":"succeeded","summary":"..."} or {"status":"waiting_for_input","pendingInput":{"question":"..."}}. Ask only for material missing information and follow the user’s task and corrections.`,
          'To show an image such as a screenshot in your report, upload the file as the raw request body to attachmentUploadUrl from the input with its image media type, for example `curl -sS --data-binary @shot.png -H \'Content-Type: image/png\' "<attachmentUploadUrl>&fileName=shot.png"`. Only PNG, JPEG, GIF and WebP up to 10 MB are accepted. Put the returned `markdown` value, such as ![shot.png](/api/chat/attachments/att_…), in the summary exactly as returned; never reference local file paths or file:// URLs as images. Uploaded images expire with the request logs.',
        ].filter(Boolean).join('\n\n'),
        references: task.snapshot.projectInstructions.map((instruction) => ({ path: `project-instructions/${instruction.path}`, content: instruction.content })),
        images: inboundImages,
        input: JSON.stringify({
          goal: task.goal, projectDirectory: workingDirectory, taskId: task.id, attachmentUploadUrl: attachmentUploadUrl(task),
          // The user's own images for this task. The system prompt holds the authoritative absolute
          // paths, written by the executor boundary that materialized the files.
          ...(inboundImages.length ? { userImageCount: inboundImages.length } : {}),
          ...(task.snapshot.redeployAfterSuccess ? { redeployAfterSuccess: true } : {}),
          ...(task.answers.length ? { answers: task.answers } : {}),
          ...(previousEvidence ? { previousEvidence } : {}),
          // Instructions the user submitted mid-run that could not reach (or were queued ahead of) a
          // live turn. Delivered-but-evidence-only entries are not repeated here; the executor's own
          // turn already saw them.
          ...(pendingSteers.length ? { userCorrections: pendingSteers.map((instruction) => instruction.text) } : {}),
        }),
        signal,
        steerPort,
        onEvent: (detail) => activity(detail),
      });
      signal.throwIfAborted();
      const settlement = settleChatProjectTask(output, recentActivityTexts(this.requireTask(taskId).activities));
      if (settlement.status === 'waiting_for_input') return { status: 'waiting_for_input', task: this.waitForInput(task, settlement.question) };
      return { status: 'ran', task: this.requireTask(taskId), settlement };
    } catch (error) {
      if (signal.aborted) return { status: 'cancelled', task: this.update(taskId, { status: 'cancelled', pendingQuestion: null, reportedAt: new Date() }) };
      return { status: 'failed', task: this.update(taskId, { status: 'failed', pendingQuestion: null, error: error instanceof CodexAppServerError || error instanceof ClaudeCodeError || error instanceof BadRequestException || error instanceof NotFoundException ? error.message : '项目任务执行失败，请查看关联的命令记录。' }) };
    } finally {
      this.steerPorts.delete(taskId);
    }
  }

  // Submits a mid-run correction without cancelling the task. It is an increment on the captured
  // goal, never a replacement. Only a running task accepts one: a task waiting for a question's
  // answer has no live round, and that answer is its own resumption path; a settled task is final.
  // If the current round has a live steerable turn (Codex, through turn/steer) the text is delivered
  // there at Codex's own boundary and marked delivered (applied) with this round's number; a race
  // with the turn's own completion, a non-steerable turn, or an executor without a live channel
  // (Claude Code always) queues it instead, and the next round boundary injects every queued
  // instruction into that round's input together with the prior round's evidence.
  async steer(workspaceId: string, taskId: string, text: string): Promise<ChatProjectTaskView> {
    this.requireSteerable(this.requireTask(taskId, workspaceId));
    const trimmed = required(text, 'text');
    if (trimmed.length > STEER_TEXT_LIMIT) throw new BadRequestException(`text must be at most ${STEER_TEXT_LIMIT} characters.`);
    const delivered = await this.steerPorts.get(taskId)?.deliver?.(trimmed).catch(() => false);
    this.db.transaction((transaction) => {
      const current = transaction.select().from(chatProjectTasks).where(eq(chatProjectTasks.id, taskId)).get()!;
      this.requireSteerable(current);
      const now = new Date().toISOString();
      const seq = current.steerQueue.reduce((max, entry, index) => Math.max(max, entry.seq ?? index + 1), 0) + 1;
      const round = roundCount(current.activities);
      const instruction: StoredProjectTaskSteerInstruction = {
        id: `steer_${randomUUID()}`, seq, source: 'user', text: trimmed, createdAt: now,
        ...(delivered ? { status: 'delivered' as const, consumedAt: now, consumedTurn: round } : { status: 'queued' as const }),
      };
      const entries = [{ phase: 'steer.submitted', seq, round, summary: `Steer #${seq} submitted (${instruction.status})` }];
      if (delivered) entries.push({ phase: 'steer.applied', seq, round, summary: `Steer #${seq} applied in round ${round}` });
      transaction.update(chatProjectTasks).set({
        steerQueue: [...current.steerQueue, instruction],
        activities: [...current.activities, ...entries.map((entry) => ({ ...entry, createdAt: now }))],
        updatedAt: new Date(),
      }).where(eq(chatProjectTasks.id, taskId)).run();
    });
    return this.view(taskId, workspaceId);
  }

  // Why a task cannot take a steering instruction; every message keeps the "not running" prefix.
  private requireSteerable(task: Task): void {
    if (task.status === 'running' && task.mergeStatus !== 'merging') return;
    const reason = task.status === 'waiting_for_input' ? 'it is waiting for an answer to its question; answer the question instead'
      : task.status === 'running' ? 'its branch is being merged'
        : SETTLED_STATUSES.includes(task.status) ? `it already ${task.status}`
          : `its status is ${task.status}`;
    throw new ConflictException(`This project task is not running, so it cannot accept a steering instruction: ${reason}.`);
  }

  // Marks every still-queued instruction consumed for `round` and returns them in submission order.
  // Reads and writes inside one transaction, so a second call finds nothing left; a settled task
  // consumes nothing.
  private consumeQueuedSteers(taskId: string, round: number): StoredProjectTaskSteerInstruction[] {
    return this.db.transaction((transaction) => {
      const current = transaction.select().from(chatProjectTasks).where(eq(chatProjectTasks.id, taskId)).get()!;
      if (SETTLED_STATUSES.includes(current.status)) return [];
      const pending = current.steerQueue.filter((instruction) => instruction.status === 'queued' && !instruction.consumedAt)
        .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
      if (!pending.length) return [];
      const now = new Date().toISOString();
      const consumed = new Map(pending.map((instruction) => [instruction.id, { ...instruction, status: 'consumed' as const, consumedAt: now, consumedTurn: round }]));
      transaction.update(chatProjectTasks).set({
        steerQueue: current.steerQueue.map((instruction) => consumed.get(instruction.id) ?? instruction),
        activities: [...current.activities, ...pending.map((instruction) => ({ phase: 'steer.applied', seq: instruction.seq, round, summary: `Steer #${instruction.seq ?? ''} applied in round ${round}`, createdAt: now }))],
        updatedAt: new Date(),
      }).where(eq(chatProjectTasks.id, taskId)).run();
      return [...consumed.values()];
    });
  }

  private appendActivities(taskId: string, entries: Array<Record<string, unknown>>): void {
    this.db.transaction((transaction) => {
      const current = transaction.select().from(chatProjectTasks).where(eq(chatProjectTasks.id, taskId)).get()!;
      const createdAt = new Date().toISOString();
      transaction.update(chatProjectTasks).set({ activities: [...current.activities, ...entries.map((entry) => ({ ...entry, createdAt }))], updatedAt: new Date() }).where(eq(chatProjectTasks.id, taskId)).run();
    });
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
