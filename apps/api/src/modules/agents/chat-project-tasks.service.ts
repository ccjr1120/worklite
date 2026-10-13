import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { agentExecutions, chatConfigurations, chatProjectOperations, chatProjectTasks, type Database, type StoredProjectExecutor } from '@worklite/db';
import type { AnswerAgentQuestionRequest, ChatProjectOperationDetailView, ChatProjectTaskView } from '@worklite/contracts';
import { DATABASE } from '../../infrastructure/database.module';
import { decryptSecret } from '../plugins/plugins.service';
import { ClaudeCodeError } from './claude-code.service';
import { CodexAppServerError } from './codex-app-server.service';
import { ProjectExecutorService } from './project-executor.service';

type Task = typeof chatProjectTasks.$inferSelect;
const RECENT_ACTIVITY_LIMIT = 20;
const RECENT_OPERATION_LIMIT = 50;

const attachmentUploadUrl = (task: Task) => {
  const apiUrl = process.env.WORKLITE_API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 23391}/api`;
  return `${apiUrl}/chat/attachments?${new URLSearchParams({ projectTaskId: task.id, conversationId: task.executionId }).toString()}`;
};

class InvalidTaskJsonError extends Error {
  constructor(readonly output: string) { super('The project executor returned invalid JSON.'); }
}

export const CHAT_PROJECT_TASK_TOOL = {
  name: 'project_task',
  description: 'Execute coding, repository investigation and local command requests by delegating the complete user task, relevant existing review findings and approved scope to a project executor, Codex or Claude Code, independently of Agent Team. This is the default for project work; do not first search files or run commands in Chat. The task runs in the background: the turn continues immediately after dispatch, progress stays visible on the task card, and completion or a task question is reported to the user automatically without polling. Only one active task per project directory; a concurrent request is rejected. Inspect previous task effects before taking over. Set executor only when the user names Codex or Claude Code; otherwise the Chat configuration\'s default executor applies. Omit model to use the executor\'s configured default; a requested model must be a Gateway public id on a protocol that executor supports. The executor works natively in the project directory with its own tools, without WorkLite proposal confirmation or individual command grants.',
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
    const concurrent = this.db.select({ id: chatProjectTasks.id }).from(chatProjectTasks)
      .where(and(eq(chatProjectTasks.workspaceId, workspaceId), eq(chatProjectTasks.projectDirectory, projectDirectory), inArray(chatProjectTasks.status, ['running', 'waiting_for_input']))).get();
    if (concurrent) throw new ConflictException('同一项目目录已有执行中的后台任务，请等待其结束或取消后再发起。');
    if (!execution?.capabilitySnapshot) throw new ConflictException('This Chat turn has no captured capabilities; start a new turn.');
    const executor: StoredProjectExecutor = (value.executor as StoredProjectExecutor | undefined) ?? execution.capabilitySnapshot.defaultExecutor ?? 'claude';
    const launch = await this.executors.captureLaunch(executor, requestedModel);
    const model = requestedModel ?? (launch.executor === 'codex' ? launch.model : null);
    if (model) await this.executors.requireModel(workspaceId, executor, model);
    const projectInstructions: Array<{ path: string; content: string }> = [];
    for (const path of ['AGENTS.md', 'AGENTS_WORKFLOW.md', 'CLAUDE.md']) {
      try { projectInstructions.push({ path, content: await readFile(join(projectDirectory, path), 'utf8') }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return this.db.insert(chatProjectTasks).values({ id: callId, workspaceId, executionId, goal, projectDirectory, model: model ?? '', snapshot: { launch, projectInstructions, capabilities: execution.capabilitySnapshot }, status: 'running' }).returning().get();
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

  view(taskId: string, workspaceId?: string): ChatProjectTaskView {
    const task = this.requireTask(taskId, workspaceId);
    const activityPhases: Record<string, number> = {};
    for (const activity of task.activities) {
      const phase = typeof activity.phase === 'string' ? activity.phase : 'unknown';
      activityPhases[phase] = (activityPhases[phase] ?? 0) + 1;
    }
    const allOperations = this.db.select().from(chatProjectOperations).where(eq(chatProjectOperations.taskId, taskId)).orderBy(asc(chatProjectOperations.createdAt)).all();
    const operationStatuses: Record<string, number> = {};
    for (const operation of allOperations) operationStatuses[operation.status] = (operationStatuses[operation.status] ?? 0) + 1;
    const activities = task.activities.slice(-RECENT_ACTIVITY_LIMIT).map((activity) => ({
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
      status: task.status, configurationRevision: task.snapshot.capabilities.revision, pendingQuestion: task.pendingQuestion,
      activityCount: task.activities.length, activityPhases, activities, progressText: typeof progressText === 'string' ? progressText : '', result: task.result, error: task.error,
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
      const configuration = this.db.select({ extensionPrompt: chatConfigurations.extensionPrompt }).from(chatConfigurations)
        .where(and(eq(chatConfigurations.workspaceId, task.workspaceId), eq(chatConfigurations.revision, capabilities.revision))).get();
      const output = await this.executors.execute({
        owner: 'chat', workspaceId: task.workspaceId, launch, model: task.model || null,
        projectDirectory: task.projectDirectory,
        skills: capabilities.skills.filter((skill) => skill.id !== 'sk_worklite_platform'),
        mcpServers: capabilities.mcpServers.map((server) => ({ id: server.id, name: server.name, endpoint: server.endpoint, allowedTools: server.allowedTools, ...(server.authSecret ? { authToken: decryptSecret(server.authSecret) } : {}) })),
        systemPrompt: [
          'Execute this Chat-owned project task independently of Agent Team. Follow the captured project instructions in the pinned reference files and discover additional applicable project instructions. Existing project confirmation, verification and service-lifecycle constraints remain authoritative; WorkLite adds no proposal confirmation or command grants. Keep work within the user task. Use supplied review findings and approved scope to check the affected code and make the requested changes without repeating the complete review. Inspect the actual working tree and prior effects before taking over interrupted work. Explain concrete progress as work proceeds. Never perform WorkLite installation, build, upgrade-runner or service replacement; its independent managed runner owns deployment. Return JSON: {"status":"succeeded","summary":"..."} or {"status":"waiting_for_input","pendingInput":{"question":"..."}}. Ask only for material missing information or authorization; evidence and clarification answers do not authorize unrelated work.',
          'To show an image such as a screenshot in your report, upload the file as the raw request body to attachmentUploadUrl from the input with its image media type, for example `curl -sS --data-binary @shot.png -H \'Content-Type: image/png\' "<attachmentUploadUrl>&fileName=shot.png"`. Only PNG, JPEG, GIF and WebP up to 10 MB are accepted. Put the returned `markdown` value, such as ![shot.png](/api/chat/attachments/att_…), in the summary exactly as returned; never reference local file paths or file:// URLs as images. Uploaded images expire with the request logs.',
          configuration?.extensionPrompt,
        ].filter(Boolean).join('\n\n'),
        references: task.snapshot.projectInstructions.map((instruction) => ({ path: `project-instructions/${instruction.path}`, content: instruction.content })),
        input: JSON.stringify({ goal: task.goal, projectDirectory: task.projectDirectory, taskId: task.id, attachmentUploadUrl: attachmentUploadUrl(task), ...(task.answers.length ? { answers: task.answers } : {}), ...(previousEvidence ? { previousEvidence } : {}) }),
        signal,
        onEvent: (detail) => activity(detail),
      });
      signal.throwIfAborted();
      let parsed: unknown;
      try { parsed = parseTaskJsonOutput(output); }
      catch { throw new InvalidTaskJsonError(output); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new InvalidTaskJsonError(output);
      const response = parsed as { status?: string; summary?: string; pendingInput?: { question?: string } };
      if (response.status === 'waiting_for_input' && response.pendingInput?.question?.trim()) {
        return this.waitForInput(task, response.pendingInput.question);
      }
      if (response.status !== 'succeeded' || typeof response.summary !== 'string' || !response.summary.trim()) throw new InvalidTaskJsonError(output);
      return this.update(taskId, { status: 'succeeded', result: response.summary, pendingQuestion: null });
    } catch (error) {
      if (signal.aborted) return this.update(taskId, { status: 'cancelled', pendingQuestion: null, reportedAt: new Date() });
      if (error instanceof InvalidTaskJsonError) return this.update(taskId, { status: 'failed', result: error.output, pendingQuestion: null, error: '执行器返回的结果不是有效 JSON 结果，原始输出已保留以供检查。' });
      return this.update(taskId, { status: 'failed', pendingQuestion: null, error: error instanceof CodexAppServerError || error instanceof ClaudeCodeError || error instanceof BadRequestException ? error.message : '项目任务执行失败，请查看关联的命令记录。' });
    }
  }

  private waitForInput(task: Task, question: string): Task {
    return this.update(task.id, { status: 'waiting_for_input', pendingQuestion: { id: `question_${randomUUID()}`, projectTaskId: task.id, question, options: [], createdAt: new Date().toISOString() } });
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

function parseTaskJsonOutput(output: string): unknown {
  let candidate = output.trim();
  if (candidate.startsWith('```')) candidate = candidate.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try { return JSON.parse(candidate) as unknown; }
  catch (strictError) {
    const escaped = escapeRawJsonStringControls(candidate);
    if (escaped === candidate) throw strictError;
    return JSON.parse(escaped) as unknown;
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
