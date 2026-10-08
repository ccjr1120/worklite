import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { agentExecutions, chatCodexOperations, chatCodexTasks, type Database, type StoredAgentPendingQuestion } from '@worklite/db';
import type { AnswerAgentQuestionRequest, ChatCodexTaskView } from '@worklite/contracts';
import { DATABASE } from '../../infrastructure/database.module';
import { CommandsService } from '../commands/commands.service';
import { CODEX_CLI_PLUGIN_ID, PluginsService, decryptSecret } from '../plugins/plugins.service';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { CodexAppServerError, CodexAppServerService } from './codex-app-server.service';
import { AgentInvocationRecoveryRequiredError, IsolatedAgentInvocationService, type AgentInvocationOperationJournal, type AgentInvocationOperationRecord } from './isolated-agent-invocation.service';

type Task = typeof chatCodexTasks.$inferSelect;
type Operation = typeof chatCodexOperations.$inferSelect;

export const CHAT_CODEX_TOOL = {
  name: 'codex',
  description: 'Execute coding, repository investigation and local command requests by delegating the complete user task directly to Codex App Server, independently of Agent Team. This is the default for project work; do not first search files or run commands in Chat. Inspect previous task effects before taking over. Select launchMode cx (WorkLite Gateway, ~/.codex-cli) or cxo (native Codex authentication, ~/.codex). Omit model to use that home’s default; use a Gateway public model id for cx and a native model id for cxo. Execute the clear user task directly through the same Codex executor as Team developer tasks, without WorkLite proposal confirmation or individual command grants.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['goal', 'projectDirectory'], properties: { goal: { type: 'string' }, projectDirectory: { type: 'string' }, model: { type: 'string' }, launchMode: { type: 'string', enum: ['cx', 'cxo'] } } },
} as const;

@Injectable()
export class ChatCodexTasksService {
  private readonly active = new Map<string, { controller: AbortController; completion: Promise<Task> }>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly invocations: IsolatedAgentInvocationService,
    private readonly codex: CodexAppServerService,
    private readonly plugins: PluginsService,
    private readonly resources: WorkspaceResourcesService,
    private readonly commands: CommandsService,
  ) {}

  async capture(workspaceId: string, executionId: string, callId: string, input: unknown): Promise<Task> {
    const existing = this.db.select().from(chatCodexTasks).where(eq(chatCodexTasks.id, callId)).get();
    if (existing) return existing;
    const execution = this.db.select().from(agentExecutions).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.workspaceId, workspaceId))).get();
    const value = input as { goal?: unknown; projectDirectory?: unknown; model?: unknown; launchMode?: unknown };
    const goal = required(value?.goal, 'goal');
    const directory = required(value?.projectDirectory, 'projectDirectory');
    if (value?.launchMode !== undefined && value.launchMode !== 'cx' && value.launchMode !== 'cxo') throw new BadRequestException('请选择 cx 或 cxo 启动方式。');
    const requestedModel = value?.model === undefined ? undefined : required(value.model, 'model');
    if (!isAbsolute(directory)) throw new BadRequestException('Codex requires an absolute project directory.');
    const projectDirectory = resolve(directory);
    if (!(await stat(projectDirectory)).isDirectory()) throw new BadRequestException('The project directory is unavailable.');
    const { launch, commandArguments } = await this.codex.captureLaunch(await this.plugins.commandArguments(CODEX_CLI_PLUGIN_ID), value.launchMode, requestedModel);
    const model = launch.model;
    if (launch.mode === 'cx') {
      const runtime = await this.resources.publicModelRuntime(workspaceId, model);
      if (runtime.protocol !== 'openai/responses' && runtime.protocol !== 'codex/responses') throw new BadRequestException('Choose an openai/responses or codex/responses model from the current Gateway catalog.');
    }
    if (!execution?.capabilitySnapshot) throw new ConflictException('This Chat turn has no captured capabilities; start a new turn.');
    const projectInstructions: Array<{ path: string; content: string }> = [];
    for (const path of ['AGENTS.md', 'AGENTS_WORKFLOW.md']) {
      try { projectInstructions.push({ path, content: await readFile(join(projectDirectory, path), 'utf8') }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return this.db.insert(chatCodexTasks).values({ id: callId, workspaceId, executionId, goal, projectDirectory, model, snapshot: { launch, commandArguments, projectInstructions, capabilities: execution.capabilitySnapshot }, status: 'running' }).returning().get();
  }

  async run(taskId: string, onProgress: () => Promise<void>): Promise<Task> {
    const active = this.active.get(taskId);
    if (active) return active.completion;
    const controller = new AbortController();
    const completion = this.execute(taskId, controller.signal, onProgress).finally(() => this.active.delete(taskId));
    this.active.set(taskId, { controller, completion });
    return completion;
  }

  async cancel(taskId: string): Promise<Task> {
    const active = this.active.get(taskId);
    if (active) { active.controller.abort(new Error('The Codex task was cancelled.')); return active.completion; }
    const task = this.requireTask(taskId);
    const unresolved = this.unresolved(taskId);
    if (unresolved) return this.waitForRecovery(task, unresolved);
    if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') return task;
    return this.update(taskId, { status: 'cancelled', pendingQuestion: null });
  }

  async answer(workspaceId: string, taskId: string, input: AnswerAgentQuestionRequest, accept: (transaction: Parameters<Parameters<Database['transaction']>[0]>[0]) => void): Promise<Task> {
    const task = this.requireTask(taskId, workspaceId);
    const question = task.pendingQuestion;
    if (!question || question.id !== input.questionId || !['waiting_for_input', 'waiting_for_recovery'].includes(task.status)) throw new ConflictException('This Codex question is no longer active.');
    const answer = required(input.answer, 'answer');
    let operation: Operation | undefined;
    let operationPatch: Partial<Operation> | undefined;
    let failed = false;
    if (question.recovery) {
      operation = this.db.select().from(chatCodexOperations).where(and(eq(chatCodexOperations.key, question.recovery.operationKey), eq(chatCodexOperations.taskId, taskId))).get();
      if (!operation || !['reserved', 'uncertain'].includes(operation.status)) throw new ConflictException('This operation no longer requires recovery.');
      if (input.recoveryDecision === 'adopt_command') {
        if (!operation.commandId) throw new BadRequestException('This operation has no Command result to adopt.');
        const command = await this.commands.get(operation.commandId);
        if ((command.status !== 'succeeded' && command.status !== 'failed') || command.exitCode === null) throw new ConflictException('The Command has no conclusive result. Inspect it or mark the operation failed.');
        const output = await this.commands.output(operation.commandId);
        operationPatch = { status: 'completed', result: { ...(operation.result as object), output: { type: command.status === 'succeeded' ? 'text' : 'error-text', value: output }, commandId: command.id }, failureReason: null };
      } else if (input.recoveryDecision === 'mark_failed') {
        if (operation.commandId) {
          const command = await this.commands.cancel(operation.commandId);
          if (['queued', 'running', 'cancelling'].includes(command.status)) await this.commands.waitForCompletion(command.id);
        }
        operationPatch = { status: 'failed', failureReason: 'The user settled this operation without replay.' };
        failed = true;
      } else throw new BadRequestException('Choose a structured recovery decision; prose never replays an operation.');
    } else if (input.recoveryDecision) throw new BadRequestException('This question does not accept a recovery decision.');
    return this.db.transaction((transaction) => {
      const current = transaction.select().from(chatCodexTasks).where(eq(chatCodexTasks.id, taskId)).get()!;
      if (current.pendingQuestion?.id !== question.id || !['waiting_for_input', 'waiting_for_recovery'].includes(current.status)) throw new ConflictException('This Codex question has already been answered.');
      accept(transaction);
      if (operation && operationPatch) transaction.update(chatCodexOperations).set({ ...operationPatch, updatedAt: new Date() }).where(eq(chatCodexOperations.key, operation.key)).run();
      return transaction.update(chatCodexTasks).set({ status: failed ? 'failed' : 'running', pendingQuestion: null, error: failed ? '用户已将不确定操作标记为失败；未重放操作。' : null, answers: [...current.answers, { question: question.question, answer }], updatedAt: new Date() }).where(eq(chatCodexTasks.id, taskId)).returning().get();
    });
  }

  view(taskId: string, workspaceId?: string): ChatCodexTaskView {
    const task = this.requireTask(taskId, workspaceId);
    return { ...(task.snapshot.launch ? { launch: { mode: task.snapshot.launch.mode, home: task.snapshot.launch.home, modelProvider: task.snapshot.launch.modelProvider, settings: task.snapshot.launch.settings } } : {}), id: task.id, executionId: task.executionId, goal: task.goal, projectDirectory: task.projectDirectory, model: task.model, status: task.status, configurationRevision: task.snapshot.capabilities.revision, pendingQuestion: task.pendingQuestion, activities: task.activities, result: task.result, error: task.error, operations: this.db.select().from(chatCodexOperations).where(eq(chatCodexOperations.taskId, taskId)).orderBy(asc(chatCodexOperations.createdAt)).all().map(({ key, toolName, status, commandId, result, failureReason }) => ({ key, toolName, status, commandExecutionId: commandId, result, failureReason })), createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString() };
  }

  list(executionId: string): ChatCodexTaskView[] {
    return this.db.select({ id: chatCodexTasks.id }).from(chatCodexTasks).where(eq(chatCodexTasks.executionId, executionId)).orderBy(asc(chatCodexTasks.createdAt)).all().map(({ id }) => this.view(id));
  }

  private async execute(taskId: string, signal: AbortSignal, onProgress: () => Promise<void>): Promise<Task> {
    let task = this.requireTask(taskId);
    if (['succeeded', 'cancelled'].includes(task.status)) return task;
    if (this.db.select().from(chatCodexOperations).where(and(eq(chatCodexOperations.taskId, taskId), eq(chatCodexOperations.status, 'failed'))).get()) {
      return this.update(taskId, { status: 'failed', pendingQuestion: null, error: '操作已标记为失败；未重放操作。' });
    }
    const unresolved = this.unresolved(taskId);
    if (unresolved) return this.waitForRecovery(task, unresolved);
    task = this.update(taskId, { status: 'running', pendingQuestion: null, error: null });
    const activity = async (detail: Record<string, unknown>) => {
      this.db.transaction((transaction) => {
        const current = transaction.select().from(chatCodexTasks).where(eq(chatCodexTasks.id, taskId)).get()!;
        transaction.update(chatCodexTasks).set({ activities: [...current.activities, { ...detail, createdAt: new Date().toISOString() }], updatedAt: new Date() }).where(eq(chatCodexTasks.id, taskId)).run();
      });
      await onProgress();
    };
    try {
      if (!task.snapshot.launch) throw new BadRequestException('此旧任务未捕获启动方式；请创建新 Codex 任务，已有记录仍保留。');
      const output = await this.invocations.execute({
        executionOwner: 'chat', workspaceId: task.workspaceId, publicModelId: task.model,
        codexServerCommandArguments: task.snapshot.commandArguments, codexLaunch: task.snapshot.launch,
        projectDirectory: task.projectDirectory, role: 'developer', builtinToolNames: ['read', 'glob', 'grep', 'write', 'bash'],
        skills: task.snapshot.capabilities.skills,
        mcpRuntimes: task.snapshot.capabilities.mcpServers.filter((server) => server.endpoint.trim()).map((server) => ({ id: server.id, name: server.name, endpoint: server.endpoint, allowedTools: server.allowedTools, ...(server.authSecret ? { authToken: decryptSecret(server.authSecret) } : {}) })),
        systemPrompt: [task.snapshot.capabilities.agent.systemPrompt, 'You execute this Chat-owned project task independently of Agent Team. Do not dispatch the task back to Team. Follow captured project instructions and discover any additional applicable instructions before editing. Existing project confirmation, verification and service-lifecycle constraints remain authoritative. Never perform installation, build, upgrade-runner or service replacement for WorkLite through this task; its independent managed runner owns deployment. Execute the captured user task directly using the same Codex executor as Team developer tasks. WorkLite requires neither proposal confirmation nor per-command grants for Codex. Keep work within the user task. Return JSON: {"status":"succeeded","summary":"..."} or {"status":"waiting_for_input","pendingInput":{"question":"..."}}. Request only material missing information or authorization. Evidence and clarification answers do not authorize unrelated work.'].join('\n\n'),
        context: { goal: task.goal, projectDirectory: task.projectDirectory, projectInstructions: task.snapshot.projectInstructions, answers: task.answers, previousEvidence: this.view(taskId) },
        signal, operation: { taskKey: taskId, journal: this.journal(taskId) },
        onBackendEvent: (detail) => activity(detail),
        onBuiltinTool: (detail) => activity({ phase: 'project.tool', ...detail }),
        onMcpCall: (detail) => activity({ phase: 'mcp.call', ...detail }),
      });
      signal.throwIfAborted();
      const parsed = JSON.parse(output.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')) as { status?: string; summary?: string; pendingInput?: { question?: string } };
      if (parsed.status === 'waiting_for_input' && parsed.pendingInput?.question?.trim()) {
        return this.waitForInput(task, parsed.pendingInput.question);
      }
      if (parsed.status !== 'succeeded' || typeof parsed.summary !== 'string' || !parsed.summary.trim()) throw new Error('Invalid Codex result.');
      return this.update(taskId, { status: 'succeeded', result: parsed.summary, pendingQuestion: null });
    } catch (error) {
      const uncertain = this.unresolved(taskId);
      if (uncertain) return this.waitForRecovery(task, uncertain);
      if (error instanceof AgentInvocationRecoveryRequiredError) return this.waitForInput(task, '操作结果需要核对后才能继续。请检查任务记录。');
      if (signal.aborted) return this.update(taskId, { status: 'cancelled', pendingQuestion: null });
      return this.update(taskId, { status: 'failed', pendingQuestion: null, error: error instanceof CodexAppServerError || error instanceof BadRequestException ? error.message : 'Codex 任务执行失败，请查看关联的命令记录。' });
    }
  }

  private waitForInput(task: Task, question: string): Task {
    return this.update(task.id, { status: 'waiting_for_input', pendingQuestion: { id: `question_${randomUUID()}`, codexTaskId: task.id, question, options: [], createdAt: new Date().toISOString() } });
  }

  private waitForRecovery(task: Task, operation: Operation): Task {
    if (operation.status === 'reserved') this.db.update(chatCodexOperations).set({ status: 'uncertain', updatedAt: new Date() }).where(eq(chatCodexOperations.key, operation.key)).run();
    const pendingQuestion: StoredAgentPendingQuestion = { id: `question_${randomUUID()}`, codexTaskId: task.id, question: '此操作的结果不确定。核对已有命令结果后选择采用，或将操作标记为失败；不会自动重放。', options: [], recovery: { operationKey: operation.key, ...(operation.commandId ? { commandExecutionId: operation.commandId } : {}) }, createdAt: new Date().toISOString() };
    return this.update(task.id, { status: 'waiting_for_recovery', pendingQuestion });
  }

  private unresolved(taskId: string): Operation | undefined {
    return this.db.select().from(chatCodexOperations).where(and(eq(chatCodexOperations.taskId, taskId), inArray(chatCodexOperations.status, ['reserved', 'uncertain']))).orderBy(asc(chatCodexOperations.createdAt)).get();
  }

  private requireTask(taskId: string, workspaceId?: string): Task {
    const task = this.db.select().from(chatCodexTasks).where(and(eq(chatCodexTasks.id, taskId), workspaceId ? eq(chatCodexTasks.workspaceId, workspaceId) : undefined)).get();
    if (!task) throw new NotFoundException('Chat Codex task not found.');
    return task;
  }

  private update(taskId: string, patch: Partial<Omit<Task, 'id' | 'snapshot'>>): Task {
    return this.db.update(chatCodexTasks).set({ ...patch, updatedAt: new Date() }).where(eq(chatCodexTasks.id, taskId)).returning().get();
  }

  private journal(taskId: string): AgentInvocationOperationJournal {
    const find = (key: string) => this.db.select().from(chatCodexOperations).where(and(eq(chatCodexOperations.key, key), eq(chatCodexOperations.taskId, taskId))).get();
    const record = (row: Operation): AgentInvocationOperationRecord => ({ key: row.key, taskKey: row.taskKey, operationKey: row.operationKey, toolName: row.toolName, inputFingerprint: row.inputFingerprint, status: row.status, ...(row.commandId ? { commandId: row.commandId } : {}), ...(row.result ? { result: row.result } : {}), ...(row.failureReason ? { failureReason: row.failureReason } : {}) });
    return {
      findOperation: async (key) => { const row = find(key); return row ? record(row) : undefined; },
      findReplayOperation: async () => undefined,
      reserveOperation: (request, commandId, transaction) => record((transaction ?? this.db).insert(chatCodexOperations).values({ key: `${taskId}:${request.operationKey}`, taskId, taskKey: request.taskKey, operationKey: request.operationKey, toolName: request.toolName, inputFingerprint: request.inputFingerprint, status: 'reserved', commandId, result: request.pendingResult }).returning().get()),
      completeOperation: async (key, result, commandId) => record(this.db.update(chatCodexOperations).set({ status: 'completed', result, ...(commandId ? { commandId } : {}), updatedAt: new Date() }).where(and(eq(chatCodexOperations.key, key), eq(chatCodexOperations.taskId, taskId))).returning().get()),
      markOperationUncertain: async (key, reason) => record(this.db.update(chatCodexOperations).set({ status: 'uncertain', failureReason: reason, updatedAt: new Date() }).where(and(eq(chatCodexOperations.key, key), eq(chatCodexOperations.taskId, taskId))).returning().get()),
      failOperation: async (key, reason) => record(this.db.update(chatCodexOperations).set({ status: 'failed', failureReason: reason, updatedAt: new Date() }).where(and(eq(chatCodexOperations.key, key), eq(chatCodexOperations.taskId, taskId))).returning().get()),
      attachReplayCommand: () => { throw new ConflictException('Chat Codex tasks never automatically replay uncertain operations.'); },
    };
  }
}

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field} is required.`);
  return value.trim();
}
