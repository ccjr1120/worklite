import { BadRequestException, ConflictException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Client, EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { chatSubmissions, externalChats, feishuDeliveries, feishuEvents, type Database } from '@worklite/db';
import { DATABASE } from '../../../infrastructure/database.module';
import { AgentExecutionsService } from '../../agents/agent-executions.service';
import { CHAT_AGENT_ID, ChatDispatchService } from '../../agents/chat-dispatch.service';
import { AgentTeamDocumentsService } from '../../agent-teams/agent-team-documents.service';
import { AgentTeamsService } from '../../agent-teams/agent-teams.service';
import { RunsService } from '../../runs/runs.service';
import { PluginsService } from '../plugins.service';
import { renderCard, renderTaskCard, statusText, teamRoleName, teamRunMeta, type CardButton, type CardState, type CardTransport, type CardUpdate, type FeishuAction, type FeishuCard, type SavedCard } from './feishu-cards';
import { runtimeAdmissionClosed, runtimeWritesFrozen } from '../../../infrastructure/runtime-upgrade-state';
import { UpgradesService } from '../../upgrades/upgrades.service';
import type { ChatProjectTaskView } from '@worklite/contracts';

type FeishuActionReceipt = { accepted: true } | { accepted: false; reason: string };
type Json = Record<string, unknown>;
type Submission = typeof chatSubmissions.$inferSelect;
// One submission delivers one reply card plus one card per project task; each task card persists
// its own transport, message id and fingerprint inside the submission's rendered task cards.
type TaskCardEntry = SavedCard & { messageId?: string; fingerprint?: string };
type TaskCardMap = Record<string, TaskCardEntry>;
const request = {} as Request;
const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class FeishuService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeishuService.name);
  private client?: Client;
  private socket?: WSClient;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopped = false;
  private generation = 0;
  private unsubscribers: Array<() => void> = [];
  private allowedUserId = '';
  private intakePending = 0;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly plugins: PluginsService,
    private readonly dispatches: ChatDispatchService,
    private readonly executions: AgentExecutionsService,
    private readonly documents: AgentTeamDocumentsService,
    private readonly teams: AgentTeamsService,
    private readonly runs: RunsService,
    private readonly upgrades: UpgradesService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.WORKLITE_PREFLIGHT === '1') return;
    this.unsubscribers = [
      this.runs.subscribe((event) => {
        void this.db.update(chatSubmissions).set({ settled: false }).where(sql`json_extract(${chatSubmissions.reference}, '$.runId') = ${event.runId}`).then(() => undefined);
      }),
      this.teams.subscribe((event) => {
        void this.db.update(chatSubmissions).set({ settled: false }).where(sql`json_extract(${chatSubmissions.reference}, '$.kind') = 'team' and json_extract(${chatSubmissions.reference}, '$.runId') = ${event.runId}`).then(() => undefined);
      }),
    ];
    await this.connect();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.generation += 1;
    this.socket?.close({ force: true });
    if (this.timer) clearInterval(this.timer);
  }

  async connect(): Promise<void> {
    const generation = ++this.generation;
    this.socket?.close({ force: true });
    this.socket = undefined;
    this.client = undefined;
    if (this.timer) clearInterval(this.timer);
    const config = await this.plugins.feishuSecret();
    if (!config.feishuEnabled || !config.appSecret) {
      await this.plugins.updateFeishu({ feishuStatus: 'disconnected', feishuLastError: null });
      return;
    }
    this.stopped = false;
    const credentials = { appId: config.feishuAppId, appSecret: config.appSecret, loggerLevel: LoggerLevel.fatal };
    this.client = new Client(credentials);
    this.allowedUserId = config.feishuAllowedUserId;
    const state = async (status: 'connecting' | 'connected' | 'error', reason: string | null = null) => {
      if (generation === this.generation && !this.stopped) await this.plugins.updateFeishu({ feishuStatus: status, feishuLastError: reason });
    };
    this.socket = new WSClient({ ...credentials, autoReconnect: true,
      onReady: () => { void state('connected'); void this.work(); },
      onReconnected: () => { void state('connected'); void this.work(); },
      onReconnecting: () => { void state('connecting'); },
      onError: () => { void state('error', '飞书连接失败，请检查应用凭据、发布状态和长连接订阅配置。'); },
    });
    const dispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (event: unknown) => {
        if (generation !== this.generation || runtimeWritesFrozen()) throw new Error('Runtime is switching.');
        this.intakePending += 1;
        try { await this.receiveMessage(record(event), config.feishuAllowedUserId); } finally { this.intakePending -= 1; }
      },
      'card.action.trigger': async (event: unknown) => {
        if (generation !== this.generation || runtimeWritesFrozen()) throw new Error('Runtime is switching.');
        this.intakePending += 1;
        const receipt = await this.receiveAction(record(event), config.feishuAllowedUserId).finally(() => { this.intakePending -= 1; });
        return { toast: { type: receipt.accepted ? 'info' : 'error', content: receipt.accepted ? '已收到，正在处理' : `操作已被拒绝：${receipt.reason}` } };
      },
    });
    await state('connecting');
    this.timer = setInterval(() => { void this.work(); }, 2_000);
    void this.socket.start({ eventDispatcher: dispatcher }).catch(() => state('error', '无法建立飞书长连接，请检查应用配置。'));
  }

  async disconnect() {
    this.generation += 1;
    this.socket?.close({ force: true });
    this.socket = undefined;
    this.client = undefined;
    if (this.timer) clearInterval(this.timer);
    return this.plugins.updateFeishu({ feishuEnabled: false, feishuStatus: 'disconnected', feishuLastError: null });
  }

  async freezeForUpgrade(): Promise<void> {
    this.stopped = true; this.generation += 1;
    this.socket?.close({ force: true });
    if (this.timer) clearInterval(this.timer);
  }

  private async receiveMessage(event: Json, allowedUserId: string): Promise<void> {
    const message = record(event.message);
    const sender = record(event.sender);
    const userId = string(record(sender.sender_id).open_id);
    if (userId !== allowedUserId || sender.sender_type !== 'user' || message.chat_type !== 'p2p') return;
    const chatId = string(message.chat_id);
    const messageId = string(message.message_id);
    if (!chatId || !messageId) return;
    let text = '';
    if (message.message_type === 'text') {
      try { text = string(record(JSON.parse(string(message.content))).text).trim(); } catch { /* Unsupported payload receives explicit feedback below. */ }
    }
    await this.db.insert(externalChats).values({ id: chatId, workspaceId: 'workspace_personal', channel: 'feishu', externalId: chatId, userId }).onConflictDoNothing();
    const [chat] = await this.db.select().from(externalChats).where(and(eq(externalChats.id, chatId), eq(externalChats.channel, 'feishu'))).limit(1);
    const replyTo = string(message.parent_id) || string(message.root_id);
    let boundAction: FeishuAction | undefined;
    let parentSubmissionId: string | undefined;
    const execution = chat.executionId ? await this.executions.get(request, 'personal', CHAT_AGENT_ID, chat.executionId) : undefined;
    if (replyTo) {
      const [parent] = await this.db.select().from(chatSubmissions).where(and(eq(chatSubmissions.chatId, chatId), eq(chatSubmissions.outputMessageId, replyTo))).limit(1);
      boundAction = (parent?.renderedCard as SavedCard | null)?.replyAction;
      parentSubmissionId = parent?.id;
      if (!boundAction) {
        // A reply to a task card stays bound to that task's pending question.
        const candidates = await this.db.select().from(chatSubmissions).where(eq(chatSubmissions.chatId, chatId));
        for (const candidate of candidates) {
          const cards = (candidate.renderedTaskCards as TaskCardMap | null) ?? {};
          const entry = Object.values(cards).find((card) => card.messageId === replyTo && card.replyAction);
          if (entry?.replyAction) { boundAction = entry.replyAction; parentSubmissionId = candidate.id; break; }
        }
      }
    } else if (execution?.pendingQuestion) {
      boundAction = { kind: 'agent_answer', executionId: execution.id, questionId: execution.pendingQuestion.id };
    }
    const escapeFailedConversation = !boundAction && text === '新对话' && execution?.status === 'failed';
    const eventId = `message:${messageId}`;
    this.db.transaction((transaction) => {
      const receipt = transaction.insert(feishuEvents).values({ id: eventId, chatId, payload: { text, context: { content: message.content, messageId, messageType: message.message_type, createTime: message.create_time, parentId: message.parent_id, rootId: message.root_id }, ...(boundAction ? { action: boundAction, form: { answer: text }, ...(parentSubmissionId ? { submissionId: parentSubmissionId } : {}) } : {}) } }).onConflictDoNothing().run();
      let submissionExecutionId = chat.executionId;
      if (receipt.changes > 0 && escapeFailedConversation && chat.executionId) {
        const unbound = transaction.update(externalChats).set({ executionId: null, updatedAt: new Date() }).where(and(eq(externalChats.id, chatId), eq(externalChats.channel, 'feishu'), eq(externalChats.executionId, chat.executionId))).run();
        if (unbound.changes === 0) throw new ConflictException('This Feishu conversation is no longer bound to the failed Agent execution.');
        submissionExecutionId = null;
      }
      if (receipt.changes > 0 && text && !boundAction) transaction.insert(chatSubmissions).values({ id: eventId, workspaceId: chat.workspaceId, chatId, executionId: submissionExecutionId, message: text, target: { kind: 'conversation' } }).run();
    });
    void this.work();
  }

  private async receiveAction(event: Json, allowedUserId: string): Promise<FeishuActionReceipt> {
    const eventId = string(event.event_id) || digest(JSON.stringify(event));
    const operatorId = string(record(event.operator).open_id);
    if (operatorId !== allowedUserId) {
      this.logger.warn(`Feishu card action rejected: operator mismatch, eventId=${eventId}, operator=${digest(operatorId).slice(0, 12)}.`);
      return { accepted: false, reason: '操作者不匹配' };
    }
    const action = record(event.action);
    const value = record(action.value);
    const submissionId = string(value.submissionId);
    const actionKey = string(value.actionKey);
    const [submission] = await this.db.select().from(chatSubmissions).where(eq(chatSubmissions.id, submissionId)).limit(1);
    if (!submission) {
      this.logger.warn(`Feishu card action rejected: submission not found, eventId=${eventId}, submissionId=${submissionId}.`);
      return { accepted: false, reason: '任务卡片不存在' };
    }
    if (!submission.chatId) {
      this.logger.warn(`Feishu card action rejected: submission chat missing, eventId=${eventId}, submissionId=${submission.id}.`);
      return { accepted: false, reason: '任务卡片未关联对话' };
    }
    const [chat] = await this.db.select({ channel: externalChats.channel }).from(externalChats).where(eq(externalChats.id, submission.chatId)).limit(1);
    if (chat?.channel !== 'feishu') return { accepted: false, reason: '任务卡片未关联对话' };
    const saved = submission.renderedCard as SavedCard | null;
    const taskCards = (submission.renderedTaskCards as TaskCardMap | null) ?? {};
    let selected = saved?.actions[actionKey];
    if (!selected) {
      for (const entry of Object.values(taskCards)) {
        if (entry.actions?.[actionKey]) { selected = entry.actions[actionKey]; break; }
      }
    }
    if (!selected) {
      this.logger.warn(`Feishu card action rejected: action not found, eventId=${eventId}, chatId=${submission.chatId}, submissionId=${submission.id}, actionKey=${actionKey}.`);
      return { accepted: false, reason: '卡片操作不存在' };
    }
    const messageId = string(record(event.context).open_message_id);
    const allowedMessageIds = new Set([submission.outputMessageId, ...Object.values(taskCards).map((entry) => entry.messageId)].filter((value): value is string => Boolean(value)));
    if (!allowedMessageIds.has(messageId)) {
      this.logger.warn(`Feishu card action rejected: message mismatch, eventId=${eventId}, chatId=${submission.chatId}, submissionId=${submission.id}, actualMessageId=${messageId}.`);
      return { accepted: false, reason: '消息不匹配' };
    }
    // Persist only the server-rendered operation; callback fields cannot fabricate a Run or permission.
    await this.db.insert(feishuEvents).values({ id: `action:${eventId}`, chatId: submission.chatId, payload: { submissionId: submission.id, action: selected, form: record(action.form_value), context: { messageId: submission.outputMessageId, actionKey } } }).onConflictDoNothing();
    void this.work();
    return { accepted: true };
  }

  private async work(): Promise<void> {
    if (this.busy || this.stopped || runtimeWritesFrozen() || !this.client || this.socket?.getConnectionStatus().state !== 'connected') return;
    this.busy = true;
    try {
      const events = await this.db.select().from(feishuEvents).where(eq(feishuEvents.status, 'queued')).orderBy(asc(feishuEvents.createdAt), sql`feishu_events.rowid`);
      const blocked = new Set<string>();
      for (const event of events) {
        if (runtimeAdmissionClosed()) break;
        if (blocked.has(event.chatId) && !event.payload.action) continue;
        const [owner] = await this.db.select({ userId: externalChats.userId, channel: externalChats.channel }).from(externalChats).where(eq(externalChats.id, event.chatId)).limit(1);
        if (owner?.channel !== 'feishu' || owner.userId !== this.allowedUserId) continue;
        if (!event.payload.action) {
          const [placeholder] = await this.db.select().from(chatSubmissions).where(eq(chatSubmissions.id, event.id)).limit(1);
          if (placeholder && !placeholder.reference && !placeholder.error) {
            try { await this.deliver(placeholder); }
            catch { await this.plugins.updateFeishu({ feishuLastError: '飞书消息投递失败，请检查机器人消息、文件与卡片权限；恢复后自动继续投递。' }); }
          }
        }
        try {
          await this.processEvent(event);
          await this.db.update(feishuEvents).set({ status: 'done', error: null }).where(eq(feishuEvents.id, event.id));
        } catch (error) {
          if (error instanceof ConflictException && /already running|pending answer required/.test(error.message)) { blocked.add(event.chatId); continue; }
          const reason = error instanceof BadRequestException || error instanceof ConflictException ? error.message : '无法处理此请求，请重试或在 WorkLite 查看任务详情。';
          const [submission] = await this.db.select().from(chatSubmissions).where(eq(chatSubmissions.id, event.id)).limit(1);
          if (!submission) await this.db.insert(chatSubmissions).values({ id: event.id, workspaceId: 'workspace_personal', chatId: event.chatId, message: '', target: { kind: 'conversation' }, error: reason }).onConflictDoNothing();
          else await this.db.update(chatSubmissions).set({ error: reason }).where(eq(chatSubmissions.id, event.id));
          await this.db.update(feishuEvents).set({ status: 'failed', error: reason }).where(eq(feishuEvents.id, event.id));
        }
      }
      // Associate model-dispatched tasks with their originating external conversation.
      const children = await this.db.select().from(chatSubmissions).where(and(isNull(chatSubmissions.chatId), sql`${chatSubmissions.executionId} is not null`));
      for (const submission of children) {
        const [origin] = await this.db.select({ chatId: chatSubmissions.chatId }).from(chatSubmissions).where(and(eq(chatSubmissions.executionId, submission.executionId!), sql`${chatSubmissions.chatId} is not null`)).orderBy(asc(chatSubmissions.createdAt)).limit(1);
        if (origin?.chatId) await this.db.update(chatSubmissions).set({ chatId: origin.chatId }).where(eq(chatSubmissions.id, submission.id));
      }
      const submissions = await this.db.select().from(chatSubmissions).where(and(eq(chatSubmissions.workspaceId, 'workspace_personal'), eq(chatSubmissions.settled, false))).orderBy(asc(chatSubmissions.createdAt));
      for (const submission of submissions) {
        if (!submission.chatId) continue;
        const [owner] = await this.db.select({ userId: externalChats.userId, channel: externalChats.channel }).from(externalChats).where(eq(externalChats.id, submission.chatId)).limit(1);
        if (owner?.channel !== 'feishu' || owner.userId !== this.allowedUserId) continue;
        try { await this.deliver(submission); }
        catch { await this.plugins.updateFeishu({ feishuLastError: '飞书消息投递失败，请检查机器人消息、文件与卡片权限；恢复后自动继续投递。' }); }
      }
    } catch {
      await this.plugins.updateFeishu({ feishuLastError: '飞书消息处理暂时失败，已接收的消息会在恢复后继续处理。' }).catch(() => undefined);
    } finally { this.busy = false; }
  }

  private async processEvent(event: typeof feishuEvents.$inferSelect): Promise<void> {
    const [chat] = await this.db.select().from(externalChats).where(and(eq(externalChats.id, event.chatId), eq(externalChats.channel, 'feishu'))).limit(1);
    const payload = event.payload;
    if (payload.action) {
      await this.applyAction(event.id, chat.id, payload.action as FeishuAction, record(payload.form), string(payload.submissionId));
      return;
    }
    const text = string(payload.text);
    if (!text) throw new BadRequestException('目前支持文字消息；请直接发送文字。');
    const [received] = await this.db.select({ executionId: chatSubmissions.executionId }).from(chatSubmissions).where(eq(chatSubmissions.id, event.id)).limit(1);
    await this.dispatchFromChannel({ submissionId: event.id, message: text, target: { kind: 'conversation' }, executionId: received?.executionId ?? chat.executionId }, chat.id);
  }

  private async dispatchFromChannel(input: import('@worklite/contracts').DispatchChatRequest, chatId: string) {
    const [chat] = await this.db.select().from(externalChats).where(and(eq(externalChats.id, chatId), eq(externalChats.channel, 'feishu'))).limit(1);
    await this.db.insert(chatSubmissions).values({ id: input.submissionId, workspaceId: chat.workspaceId, chatId, executionId: input.executionId, message: input.message, target: input.target }).onConflictDoNothing();
    const result = await this.dispatches.dispatch(request, input);
    if (result.reference.kind === 'conversation') {
      const executionId = result.reference.executionId;
      this.db.transaction((transaction) => {
        const bound = transaction.update(externalChats).set({ executionId, updatedAt: new Date() }).where(and(eq(externalChats.id, chatId), eq(externalChats.channel, 'feishu'), input.executionId ? eq(externalChats.executionId, input.executionId) : isNull(externalChats.executionId))).run();
        if (bound.changes > 0) transaction.update(chatSubmissions).set({ executionId }).where(and(eq(chatSubmissions.chatId, chatId), isNull(chatSubmissions.executionId))).run();
      });
    }
    return result;
  }

  private async applyAction(eventId: string, chatId: string, action: FeishuAction, form: Json, parentId: string): Promise<void> {
    const answer = string(form.answer).trim();
    if (action.kind === 'answer') {
      const run = await this.teams.getRun(request, 'personal', action.runId);
      const pending = run.pendingInputs.find((item) => item.id === action.pendingInputId);
      if (pending?.status === 'answered') return; // Acknowledgement may have been interrupted after the domain committed.
      await this.teams.answer(request, 'personal', action.runId, { pendingInputId: action.pendingInputId, scopeRevision: action.scopeRevision, answer, authorizedCommands: string(form.commands).split('\n').map((item) => item.trim()).filter(Boolean) });
    } else if (action.kind === 'agent_answer') {
      const [accepted] = await this.db.select({ reference: chatSubmissions.reference }).from(chatSubmissions).where(eq(chatSubmissions.id, eventId)).limit(1);
      if (accepted?.reference) {
        if (action.newConversation && accepted.reference.kind === 'conversation') await this.db.update(externalChats).set({ executionId: accepted.reference.executionId, updatedAt: new Date() }).where(and(eq(externalChats.id, chatId), eq(externalChats.channel, 'feishu'), eq(externalChats.executionId, action.executionId)));
        return;
      }
      const current = await this.executions.get(request, 'personal', CHAT_AGENT_ID, action.executionId);
      if (current.status !== 'waiting_for_input' || current.pendingQuestion?.id !== action.questionId) throw new ConflictException('This Agent question is no longer active.');
      await this.dispatchFromChannel({ submissionId: eventId, message: action.answer ?? answer, target: { kind: 'conversation' }, executionId: action.executionId, questionId: action.questionId, recoveryDecision: action.recoveryDecision, newConversation: action.newConversation }, chatId);
    } else if (action.kind === 'project_task_answer') {
      await this.executions.answerProjectTask(request, 'personal', action.taskId, { questionId: action.questionId, answer: action.answer ?? answer });
    } else if (action.kind === 'project_task_control') {
      if (action.action === 'cancel') await this.executions.cancelProjectTask(request, 'personal', action.taskId);
    } else if (action.kind === 'control') {
      if (action.domain === 'conversation') {
        const [turn] = await this.db.select({ reference: chatSubmissions.reference }).from(chatSubmissions).where(eq(chatSubmissions.id, parentId)).limit(1);
        const [latest] = await this.db.select({ id: chatSubmissions.id }).from(chatSubmissions).where(and(eq(chatSubmissions.chatId, chatId), sql`json_extract(${chatSubmissions.reference}, '$.kind') = 'conversation'`)).orderBy(desc(chatSubmissions.createdAt), sql`chat_submissions.rowid desc`).limit(1);
        if (latest?.id !== parentId || turn?.reference?.kind !== 'conversation') throw new ConflictException('This conversation turn has already ended.');
        if (action.action === 'retry' && turn.reference.completionStatus === 'failed') {
          const { completionStatus, completionError, untilMessageId, ...reference } = turn.reference;
          await this.db.update(chatSubmissions).set({ reference }).where(eq(chatSubmissions.id, parentId));
        } else if (turn.reference.completionStatus) throw new ConflictException('This conversation turn has already ended.');
      }
      if (action.domain === 'team') {
        if (action.action === 'retry') await this.teams.retry(request, 'personal', action.runId, action.taskKey ?? '');
        else await this.teams[action.action](request, 'personal', action.runId);
      } else if (action.domain === 'workflow') {
        if (action.action === 'retry') await this.runs.retryNode(request, 'personal', action.runId, action.taskKey ?? '');
        else await this.runs[action.action](request, 'personal', action.runId);
      } else if (action.action === 'cancel') await this.executions.cancel(request, 'personal', CHAT_AGENT_ID, action.runId);
      else if (action.action === 'retry') await this.executions.retry(request, 'personal', CHAT_AGENT_ID, action.runId);
    } else if (action.kind === 'recovery') {
      const run = await this.teams.getRun(request, 'personal', action.runId);
      const operation = run.operations.find((item) => item.operationKey === action.operationKey);
      if (operation?.status !== 'uncertain') return;
      await this.teams.recover(request, 'personal', action.runId, { operationKey: action.operationKey, decision: action.decision });
    } else if (action.kind === 'delivery') {
      await this.db.update(chatSubmissions).set({ deliveryFingerprint: null, settled: false }).where(eq(chatSubmissions.id, parentId));
    } else {
      throw new ConflictException('此操作已不可用，请直接发送你的请求。');
    }
    await this.db.update(chatSubmissions).set({ settled: false, deliveryFingerprint: null }).where(eq(chatSubmissions.id, parentId));
  }

  private async deliver(submission: Submission): Promise<void> {
    const chatId = submission.chatId!;
    const reference = submission.reference;
    const state: CardState = { title: 'Chat', status: '已排队', content: submission.target.kind === 'conversation' ? '' : submission.message, buttons: [], conversation: submission.target.kind === 'conversation' };
    let terminal = false;
    // Project tasks dispatched in this submission's conversation turn each get their own card.
    let turnTasks: ChatProjectTaskView[] = [];
    const files: Array<{ id: string; name: string; content: string }> = [];
    if (submission.error) {
      state.status = '请求失败'; state.content = submission.error; terminal = true;
    } else if (reference?.kind === 'upgrade') {
      const job = this.upgrades.view(reference.jobId);
      const statuses: Record<string, string> = { proposed: '等待重新部署指令', authorized: '部署已启动', preflighting: '正在预检', draining: '正在交接任务', frozen: '即将切换', switching: '正在切换', recovering: '正在恢复旧版本', succeeded: '部署完成', rolled_back: '已恢复旧版本', failed: '部署未完成' };
      state.title = 'WorkLite 部署'; state.status = statuses[job.phase] ?? job.phase;
      state.conversation = false;
      state.content = `版本：${job.releaseHash.slice(0, 12)}\n${job.summary}`;
      if (job.error) state.content += `\n\n${job.error}`;
      terminal = ['proposed', 'succeeded', 'rolled_back', 'failed'].includes(job.phase);
    } else if (reference?.kind === 'conversation') {
      const execution = await this.executions.get(request, 'personal', CHAT_AGENT_ID, reference.executionId);
      const start = reference.afterMessageId ? execution.messages.findIndex((message) => message.id === reference.afterMessageId) + 1 : 0;
      const end = reference.completionStatus && reference.untilMessageId ? execution.messages.findIndex((message) => message.id === reference.untilMessageId) + 1 : undefined;
      const replies = new Map<string, string>();
      if (!reference.completionStatus) {
        const events = await this.executions.events(request, 'personal', CHAT_AGENT_ID, reference.executionId, reference.afterSequence);
        for (const { data } of events) {
          if (data.kind === 'message_delta') replies.set(data.messageId, (replies.get(data.messageId) ?? '') + data.delta);
        }
      }
      for (const message of execution.messages.slice(start, end)) {
        if (message.role === 'assistant') replies.set(message.id, message.content);
      }
      const response = [...replies.values()].join('\n\n');
      const executionStatus = reference.completionStatus ?? execution.status;
      state.status = executionStatus === 'completed' ? '' : executionStatus === 'running'
        ? execution.phase === 'model' ? response ? '正在回复…' : '正在思考…' : '正在处理…'
        : statusText[executionStatus] ?? executionStatus;
      const failure = reference.completionError || (!reference.completionStatus ? execution.error : null);
      const previousCard = submission.renderedCard as SavedCard | null;
      // Cancelled or failed model deltas may never become display messages. Keep their delivered text
      // when a settled turn is rendered again, including after interrupted native delivery.
      state.content = reference.completionStatus && previousCard?.content
        ? previousCard.content
        : [response, executionStatus === 'failed' ? failure : null].filter(Boolean).join('\n\n');
      if (!state.content && executionStatus === 'completed') state.content = previousCard?.questionText || '本轮对话已结束。';
      terminal = ['completed', 'failed', 'cancelled'].includes(executionStatus);
      if (terminal && !reference.completionStatus) await this.db.update(chatSubmissions).set({ reference: { ...reference, untilMessageId: execution.messages.at(-1)?.id ?? null, completionStatus: execution.status, completionError: execution.error } }).where(eq(chatSubmissions.id, submission.id));
      if (!reference.completionStatus && execution.status === 'waiting_for_input' && execution.pendingQuestion) {
        const question = execution.pendingQuestion;
        const action: Extract<FeishuAction, { kind: 'agent_answer' }> = { kind: 'agent_answer', executionId: execution.id, questionId: question.id };
        state.question = { text: question.question, action, replyOnly: Boolean(question.recovery) || question.action === 'new_conversation' || question.options.length > 0 };
        if (question.action === 'new_conversation') state.buttons.push({ label: '新对话', action: { ...action, answer: '开启新对话', newConversation: true } });
        if (question.recovery) {
          if (question.recovery.commandExecutionId) state.buttons.push({ label: '采用已有命令结果', action: { ...action, answer: '采用已有命令结果', recoveryDecision: 'adopt_command' } });
          state.buttons.push({ label: '标记操作失败', action: { ...action, answer: '标记操作失败', recoveryDecision: 'mark_failed' } });
        }
        state.buttons.push(...question.options.map((option) => ({ label: option, action: { ...action, answer: option } })));
      }
      if (!reference.completionStatus && (execution.status === 'running' || execution.status === 'waiting_for_input')) state.buttons.push({ label: '停止本轮对话', action: { kind: 'control', domain: 'conversation', runId: execution.id, action: 'cancel' } });
      if ((!reference.completionStatus || reference.completionStatus === 'failed') && execution.status === 'failed') state.buttons.push({ label: '重试本轮对话', action: { kind: 'control', domain: 'conversation', runId: execution.id, action: 'retry' } });
      const projectTasks = execution.toolCalls.flatMap((call) => call.projectTask ? [{ task: call.projectTask, createdAt: call.createdAt }] : []);
      // Attribute each task to this submission's turn by the turn's message window, so tasks from
      // earlier turns do not duplicate cards onto later replies.
      const windowStart = execution.messages[start]?.createdAt;
      const windowEnd = end !== undefined ? execution.messages[end]?.createdAt : undefined;
      turnTasks = projectTasks.filter(({ createdAt }) => (!windowStart || createdAt >= windowStart) && (!windowEnd || createdAt < windowEnd)).map(({ task }) => task);
      const shellCalls = execution.toolCalls.filter((call) => call.shell);
      if (shellCalls.length) state.details = [state.details, ...shellCalls.map((call) => ['Shell · ' + (statusText[call.status] ?? call.status), '工作目录：' + call.workingDirectory, call.shell!.command, 'Command：' + (call.commandExecutionId ?? '未启动'), '退出码：' + (call.exitCode ?? '无'), call.output].join('\n'))].filter(Boolean).join('\n\n');
      state.replyContent = state.content;
      state.streaming = executionStatus === 'running' && execution.phase === 'model' && response.length > 0;
      if (Buffer.byteLength(state.content) > 20_000) {
        if (terminal) files.push({ id: `reply:${submission.id}:${digest(state.content)}`, name: 'chat-reply.md', content: state.content });
        state.content = terminal ? '完整回复见 Markdown 文件。' : '正在生成较长回复，完成后将发送完整文件。';
        state.streaming = false;
      }
    } else if (reference?.kind === 'team') {
      state.title = 'Chat · Agent Team';
      const run = await this.teams.getRun(request, 'personal', reference.runId);
      const phaseText: Record<string, string> = { planning: '规划中', test_design: '测试设计中', development: '开发中', test_authoring: '测试编写中', test_execution: '测试执行中', review: '审查中', repair: '修复中', waiting: '等待输入', terminal: '已结束' };
      state.status = statusText[run.status] ?? run.status;
      if (run.progress && !['succeeded', 'failed', 'cancelled'].includes(run.status)) state.status += ` · ${phaseText[run.progress.phase] ?? run.progress.phase} ${run.progress.percent}%`;
      state.meta = teamRunMeta(run);
      state.details = run.tasks.map((task) => {
        const progressLine = task.progressText.trim().split(/\r?\n/, 1)[0] ?? '';
        return `- ${[task.taskKey, teamRoleName(task), task.model, statusText[task.status] ?? task.status, progressLine].filter(Boolean).join(' · ')}`;
      }).join('\n');
      const active = [...run.tasks].reverse().find((task) => task.retryable || ['running', 'waiting_for_input', 'waiting_for_recovery'].includes(task.status));
      state.content = `${run.intent}${active ? `\n\n当前任务：${active.assignmentTitle ?? active.taskKey}` : ''}`;
      if (run.status === 'failed' && active?.error) state.content += `\n\n${active.error}`;
      const pending = run.pendingInputs.find((item) => item.status === 'pending');
      if (pending?.kind === 'question') {
        const owner = run.tasks.find((task) => task.id === pending.taskAttemptId);
        const executorBacked = Boolean(owner && run.teamVersion.projectExecutorLaunches?.[owner.role]);
        state.question = { text: pending.question, action: { kind: 'answer', runId: run.id, pendingInputId: pending.id, scopeRevision: pending.scopeRevision }, commands: Boolean(owner && run.mode !== 'plan_only' && owner.role !== 'developer' && owner.role !== 'team-manager' && !executorBacked) };
      }
      if (pending?.kind === 'operation_recovery' && pending.operationKey) {
        state.content += `\n\n${pending.question}`;
        state.buttons.push(...(['adopt_command', 'mark_failed', 'replay'] as const).map((decision) => ({ label: ({ adopt_command: '采用已执行结果', mark_failed: '标记操作失败', replay: '重新执行此操作' })[decision], action: { kind: 'recovery', runId: run.id, operationKey: pending.operationKey!, decision } as FeishuAction })));
      }
      this.controls(state.buttons, 'team', run.id, run.status, active?.retryable ? active.taskKey : undefined);
      terminal = ['succeeded', 'failed', 'cancelled'].includes(run.status);
      if (run.outcome) state.content += `\n\n${run.outcome.summary}${run.outcome.unresolvedIssues.length ? `\n\n待解决：\n${run.outcome.unresolvedIssues.map((issue) => `- ${issue}`).join('\n')}` : ''}`;
      for (const document of run.documents) {
        try {
          const delivered = await this.documents.downloadDocument(request, 'personal', document.id);
          files.push({ id: `team:${document.id}`, name: delivered.fileName, content: delivered.content });
        } catch { state.content += `\n\n文档「${document.title}」尚未完成文件交付，可重试交付。`; state.buttons.push({ label: '重试文件交付', action: { kind: 'delivery' } }); }
      }
    } else if (reference?.kind === 'workflow') {
      let run = await this.runs.get(request, 'personal', reference.runId);
      if (run.pendingAction && (run.pendingAction.status === 'expired' || run.pendingAction.expiresAt && Date.parse(run.pendingAction.expiresAt) <= Date.now())) run = await this.runs.refreshPendingAction(request, 'personal', run.id);
      state.title = `Chat · ${run.workflowName}`;
      state.status = statusText[run.status] ?? run.status;
      state.details = run.nodeRuns?.map((node) => `- 步骤 ${node.position + 1} · ${statusText[node.status] ?? node.status}`).join('\n');
      state.content = run.currentStep ? `当前步骤：${run.currentStep}` : submission.message;
      const failed = run.nodeRuns?.find((node) => node.retryable);
      if (run.status === 'failed' && failed?.error) state.content += `\n\n${failed.error}`;
      if (run.pendingAction) {
        state.content += `\n\n${run.pendingAction.title}\n${run.pendingAction.description}`;
        if (run.pendingAction.qrCode) state.imageKey = await this.image(chatId, run.pendingAction.qrCode);
      }
      this.controls(state.buttons, 'workflow', run.id, run.status, run.nodeRuns?.find((node) => node.retryable)?.id);
      terminal = ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run.status);
      if (terminal && run.result != null) {
        const content = typeof run.result === 'string' ? run.result : JSON.stringify(run.result, null, 2);
        if (Buffer.byteLength(content) <= 20_000) state.content += `\n\n${content}`;
        else files.push({ id: `workflow-result:${run.id}:${digest(content)}`, name: 'workflow-result.json', content });
      }
      for (const artifact of run.artifacts ?? []) files.push({ id: `artifact:${artifact.id}`, name: `${artifact.name.replace(/[\/\\]/g, '_')}.${artifact.type === 'markdown' ? 'md' : artifact.type === 'json' ? 'json' : 'txt'}`, content: artifact.content });
    }
    for (const file of files) {
      try { await this.file(chatId, file.id, file.name, file.content); }
      catch { state.content += `\n\n文件「${file.name}」发送失败，请重试文件交付。`; state.buttons.push({ label: '重试文件交付', action: { kind: 'delivery' } }); }
    }
    if (Buffer.byteLength(state.content) > 20_000) {
      if (terminal) {
        try { await this.file(chatId, `summary:${submission.id}:${digest(state.content)}`, 'task-result.md', state.content); state.content = '完整结果见文件。'; }
        catch { state.content = '结果文件发送失败，请重试文件交付。'; state.buttons.push({ label: '重试文件交付', action: { kind: 'delivery' } }); }
      } else state.content = '任务正在执行，完整结果将在完成后交付。';
    }
    const saved = renderCard(submission.id, state);
    const fingerprint = digest(JSON.stringify(saved));
    const transport = (submission.renderedCard as SavedCard | null)?.transport;
    const renewStream = saved.card.config.streaming_mode && transport?.streamingStartedAt != null
      && Date.now() - transport.streamingStartedAt >= 9 * 60_000;
    const cardUnchanged = !transport || JSON.stringify(saved.card) === JSON.stringify(transport.card);
    // Each task card carries its own fingerprint; a pending update must be retried even when the
    // rendered content is unchanged.
    const taskCards = turnTasks.map((task) => ({ task, saved: renderTaskCard(submission.id, task), fingerprint: '' }));
    for (const entry of taskCards) entry.fingerprint = digest(JSON.stringify(entry.saved));
    const taskEntries = (submission.renderedTaskCards as TaskCardMap | null) ?? {};
    const tasksChanged = taskCards.some(({ task, fingerprint: fp }) => fp !== taskEntries[task.id]?.fingerprint || taskEntries[task.id]?.transport?.pending);
    const tasksTerminal = taskCards.every(({ task }) => ['succeeded', 'failed', 'cancelled'].includes(task.status));
    if (fingerprint === submission.deliveryFingerprint && cardUnchanged && !transport?.pending && !renewStream && !tasksChanged) {
      if (terminal && tasksTerminal) await this.db.update(chatSubmissions).set({ settled: true }).where(eq(chatSubmissions.id, submission.id));
      return;
    }
    await this.deliverCard(submission, 'reply', saved, renewStream);
    for (const { task, saved: taskSaved, fingerprint: fp } of taskCards) {
      const entry = this.slotSaved(submission, `task:${task.id}`) as TaskCardEntry | null;
      if (fp === entry?.fingerprint && !entry?.transport?.pending) continue;
      await this.deliverCard(submission, `task:${task.id}`, taskSaved, false);
      const [current] = await this.db.select({ cards: chatSubmissions.renderedTaskCards }).from(chatSubmissions).where(eq(chatSubmissions.id, submission.id)).limit(1);
      const cards: TaskCardMap = { ...((current?.cards as TaskCardMap | null) ?? {}) };
      if (cards[task.id]) cards[task.id] = { ...cards[task.id], fingerprint: fp };
      await this.db.update(chatSubmissions).set({ renderedTaskCards: cards as unknown as Record<string, Record<string, unknown>> }).where(eq(chatSubmissions.id, submission.id));
      submission.renderedTaskCards = cards as unknown as Submission['renderedTaskCards'];
    }
    await this.db.update(chatSubmissions).set({ deliveryFingerprint: fingerprint, settled: terminal && tasksTerminal, updatedAt: new Date() }).where(eq(chatSubmissions.id, submission.id));
  }

  private slotSaved(submission: Submission, slotKey: string): SavedCard | null {
    if (slotKey === 'reply') return submission.renderedCard as SavedCard | null;
    const cards = (submission.renderedTaskCards as TaskCardMap | null) ?? {};
    return cards[slotKey.slice(5)] ?? null;
  }

  private slotMessageId(submission: Submission, slotKey: string): string | null {
    if (slotKey === 'reply') return submission.outputMessageId;
    return (this.slotSaved(submission, slotKey) as TaskCardEntry | null)?.messageId ?? null;
  }

  private async persistCard(submission: Submission, slotKey: string, saved: SavedCard, transport: CardTransport): Promise<void> {
    if (slotKey === 'reply') {
      await this.db.update(chatSubmissions).set({ renderedCard: { ...saved, transport } as unknown as Json }).where(eq(chatSubmissions.id, submission.id));
      return;
    }
    const taskId = slotKey.slice(5);
    const [current] = await this.db.select({ cards: chatSubmissions.renderedTaskCards }).from(chatSubmissions).where(eq(chatSubmissions.id, submission.id)).limit(1);
    const cards: TaskCardMap = { ...((current?.cards as TaskCardMap | null) ?? {}) };
    cards[taskId] = { ...cards[taskId], ...saved, transport };
    await this.db.update(chatSubmissions).set({ renderedTaskCards: cards as unknown as Record<string, Record<string, unknown>> }).where(eq(chatSubmissions.id, submission.id));
    submission.renderedTaskCards = cards as unknown as Submission['renderedTaskCards'];
  }

  private async persistSlotMessageId(submission: Submission, slotKey: string, messageId: string): Promise<void> {
    if (slotKey === 'reply') {
      await this.db.update(chatSubmissions).set({ outputMessageId: messageId }).where(eq(chatSubmissions.id, submission.id));
      submission.outputMessageId = messageId;
      return;
    }
    const taskId = slotKey.slice(5);
    const [current] = await this.db.select({ cards: chatSubmissions.renderedTaskCards }).from(chatSubmissions).where(eq(chatSubmissions.id, submission.id)).limit(1);
    const cards: TaskCardMap = { ...((current?.cards as TaskCardMap | null) ?? {}) };
    if (cards[taskId]) cards[taskId] = { ...cards[taskId], messageId };
    await this.db.update(chatSubmissions).set({ renderedTaskCards: cards as unknown as Record<string, Record<string, unknown>> }).where(eq(chatSubmissions.id, submission.id));
    submission.renderedTaskCards = cards as unknown as Submission['renderedTaskCards'];
  }

  private async deliverCard(submission: Submission, slotKey: string, saved: SavedCard, renewStream: boolean): Promise<void> {
    const client = this.client;
    if (!client) throw new Error('Feishu is disconnected.');
    let transport = this.slotSaved(submission, slotKey)?.transport;
    let messageId = this.slotMessageId(submission, slotKey);
    // Historical message cards have no CardKit identity. Do not convert them or send a second reply.
    if (slotKey === 'reply' && messageId && !transport) {
      const reason = '此卡片来自旧版投递方式，请发送新请求以使用新版卡片。';
      await this.recordDelivery(submission.chatId!, `${submission.id}:legacy-card`, 'failed', { operation: 'card.update', messageId }, reason);
      throw new Error(reason);
    }
    if (!transport) {
      let reason = '飞书卡片创建暂时失败，恢复后将继续投递。';
      let platform: { code?: number; message?: string } | null = null;
      try {
        const result = await client.cardkit.v1.card.create({ data: { type: 'card_json', data: JSON.stringify(saved.card) } });
        platform = { code: result.code, message: result.msg };
        if (result.code) { reason = `飞书拒绝创建卡片（${result.code}）：${result.msg ?? ''}`; throw new Error(reason); }
        if (!result.data?.card_id) { reason = '飞书接受了创建请求，但未返回卡片 ID。'; throw new Error(reason); }
        transport = { cardId: result.data.card_id, sequence: 0, card: saved.card, streamingStartedAt: saved.card.config.streaming_mode ? Date.now() : null };
        // Preserve the entity before any later send or receipt write can be interrupted.
        await this.persistCard(submission, slotKey, saved, transport);
        await this.recordDelivery(submission.chatId!, `${submission.id}:${slotKey}:entity`, 'done', { operation: 'card.create', cardId: transport.cardId, platform, card: saved.card });
      } catch (error) {
        await this.recordDelivery(submission.chatId!, `${submission.id}:${slotKey}:entity`, 'failed', { operation: 'card.create', platform, card: saved.card }, reason);
        throw error;
      }
    }
    // Persist identity and action allow-list before sending or updating clickable content.
    await this.persistCard(submission, slotKey, saved, transport);
    if (!messageId) {
      let reason = '飞书卡片发送暂时失败，恢复后将继续投递。';
      let platform: { code?: number; message?: string } | null = null;
      try {
        const result = await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: {
          receive_id: submission.chatId!, msg_type: 'interactive',
          content: JSON.stringify({ type: 'card', data: { card_id: transport.cardId } }),
          uuid: digest(`card:${submission.id}:${slotKey}`).slice(0, 32),
        } });
        platform = { code: result.code, message: result.msg };
        if (result.code) { reason = `飞书拒绝发送卡片（${result.code}）：${result.msg ?? ''}`; throw new Error(reason); }
        if (!result.data?.message_id) { reason = '飞书接受了发送请求，但未返回消息 ID。'; throw new Error(reason); }
        messageId = result.data.message_id;
        await this.persistSlotMessageId(submission, slotKey, messageId);
        await this.recordDelivery(submission.chatId!, `${submission.id}:${slotKey}:message`, 'done', {
          operation: 'card.send', messageId, cardId: transport.cardId, platform, card: transport.card,
        });
      } catch (error) {
        await this.recordDelivery(submission.chatId!, `${submission.id}:${slotKey}:message`, 'failed', { operation: 'card.send', cardId: transport.cardId, platform, card: transport.card }, reason);
        throw error;
      }
    }
    await this.flushCardUpdate(submission, slotKey, saved, transport, messageId);
    const desired = saved.card;
    // Close before interaction changes, or explicitly reopen the platform's streaming window.
    if (transport.card.config.streaming_mode && (!desired.config.streaming_mode || renewStream)) {
      const config = { ...transport.card.config, streaming_mode: false };
      await this.updateCard(submission, slotKey, saved, transport, 'settings', JSON.stringify({ config }), { ...transport.card, config }, undefined, null, messageId);
    }
    const current = transport.card;
    const sameStructure = JSON.stringify(current.header) === JSON.stringify(desired.header)
      && JSON.stringify(current.body.elements.map((element) => [element.element_id, element.tag]))
        === JSON.stringify(desired.body.elements.map((element) => [element.element_id, element.tag]));
    if (!sameStructure) {
      await this.updateCard(submission, slotKey, saved, transport, 'card', JSON.stringify(desired), desired, undefined,
        desired.config.streaming_mode ? transport.streamingStartedAt ?? Date.now() : null, messageId);
      return;
    }
    if (JSON.stringify(transport.card.config) !== JSON.stringify(desired.config) || renewStream) {
      await this.updateCard(submission, slotKey, saved, transport, 'settings', JSON.stringify({ config: desired.config }),
        { ...transport.card, config: desired.config }, undefined,
        desired.config.streaming_mode ? renewStream ? Date.now() : transport.streamingStartedAt ?? Date.now() : null, messageId);
    }
    for (const element of desired.body.elements) {
      const previous = transport.card.body.elements.find((item) => item.element_id === element.element_id);
      if (JSON.stringify(previous) === JSON.stringify(element)) continue;
      const next = { ...transport.card, body: { elements: transport.card.body.elements.map((item) => item.element_id === element.element_id ? element : item) } };
      if (element.element_id === 'reply' && desired.config.streaming_mode) {
        await this.updateCard(submission, slotKey, saved, transport, 'content', String(element.content), next, 'reply', undefined, messageId);
      } else if (element.element_id === 'details') {
        // Replace only the inner text, preserving the reader's native panel expansion.
        const detail = (element.elements as Json[])[0];
        await this.updateCard(submission, slotKey, saved, transport, 'element', JSON.stringify(detail), next, 'task_details', undefined, messageId);
      } else {
        await this.updateCard(submission, slotKey, saved, transport, 'element', JSON.stringify(element), next, String(element.element_id), undefined, messageId);
      }
    }
  }

  private async updateCard(submission: Submission, slotKey: string, saved: SavedCard, transport: CardTransport,
    kind: CardUpdate['kind'], data: string, card: FeishuCard, elementId?: string,
    streamingStartedAt = transport.streamingStartedAt, messageId: string | null = null): Promise<void> {
    const sequence = transport.sequence + 1;
    transport.sequence = sequence;
    transport.pending = { kind, data, card, elementId, sequence, streamingStartedAt,
      uuid: digest(`${submission.id}:${slotKey}:${transport.cardId}:${sequence}`).slice(0, 32) };
    // Save the exact request first. A reconnect retries this UUID, payload and sequence before newer work.
    await this.persistCard(submission, slotKey, saved, transport);
    await this.flushCardUpdate(submission, slotKey, saved, transport, messageId);
  }

  private async flushCardUpdate(submission: Submission, slotKey: string, saved: SavedCard, transport: CardTransport, messageId: string | null): Promise<void> {
    const pending = transport.pending;
    if (!pending) return;
    const client = this.client;
    if (!client) throw new Error('Feishu is disconnected.');
    const { sequence, uuid } = pending;
    const path = { card_id: transport.cardId };
    const elementPath = { ...path, element_id: pending.elementId! };
    let reason = '飞书卡片更新暂时失败，恢复后将继续投递。';
    let platform: { code?: number; msg?: string } | null = null;
    let rejected = false;
    const key = `${submission.id}:${slotKey}:${transport.cardId}:${sequence}`;
    const payload = { operation: `card.${pending.kind}`, cardId: transport.cardId, messageId, request: pending };
    try {
      const result = pending.kind === 'settings'
        ? await client.cardkit.v1.card.settings({ path, data: { settings: pending.data, sequence, uuid } })
        : pending.kind === 'card'
          ? await client.cardkit.v1.card.update({ path, data: { card: { type: 'card_json', data: pending.data }, sequence, uuid } })
          : pending.kind === 'content'
            ? await client.cardkit.v1.cardElement.content({ path: elementPath, data: { content: pending.data, sequence, uuid } })
            : await client.cardkit.v1.cardElement.update({ path: elementPath, data: { element: pending.data, sequence, uuid } });
      platform = { code: result.code, msg: result.msg };
      if (result.code) { rejected = true; reason = `飞书拒绝更新卡片（${result.code}）：${result.msg ?? ''}`; throw new Error(reason); }
      await this.recordDelivery(submission.chatId!, key, 'done', { ...payload, platform });
      transport.card = pending.card;
      transport.streamingStartedAt = pending.streamingStartedAt;
      delete transport.pending;
      await this.persistCard(submission, slotKey, saved, transport);
    } catch (error) {
      await this.recordDelivery(submission.chatId!, key, 'failed', { ...payload, platform }, reason);
      // A platform rejection is a known non-effect. Keep its sequence consumed locally;
      // the next delivery may renew an expired stream and send current content with a new sequence.
      // Unknown transport outcomes retain the exact pending request for idempotent retry.
      if (rejected) {
        delete transport.pending;
        await this.persistCard(submission, slotKey, saved, transport);
      }
      throw error;
    }
  }

  private async recordDelivery(chatId: string, key: string, status: 'done' | 'failed', payload: Json, error: string | null = null) {
    const id = `outbound:${key}:${status}`;
    await this.db.insert(feishuEvents).values({ id, chatId, status, payload: { direction: 'outbound', ...payload }, error })
      .onConflictDoUpdate({ target: feishuEvents.id, set: { payload: { direction: 'outbound', ...payload }, error } });
  }

  private controls(buttons: CardButton[], domain: 'team' | 'workflow', runId: string, status: string, retryable?: string): void {
    if (status === 'queued' || status === 'running') buttons.push({ label: '暂停任务', action: { kind: 'control', domain, runId, action: 'pause' } });
    if (status === 'paused') buttons.push({ label: '继续任务', action: { kind: 'control', domain, runId, action: 'resume' } });
    if (['queued', 'running', 'paused', 'waiting_for_input'].includes(status)) buttons.push({ label: '取消任务', action: { kind: 'control', domain, runId, action: 'cancel' } });
    if (status === 'failed' && retryable) buttons.push({ label: '重试失败步骤', action: { kind: 'control', domain, runId, action: 'retry', taskKey: retryable } });
  }

  private async file(chatId: string, id: string, name: string, content: string): Promise<void> {
    const key = `${chatId}:${id}`;
    const [existing] = await this.db.select().from(feishuDeliveries).where(eq(feishuDeliveries.id, key)).limit(1);
    if (existing?.messageId) return;
    const client = this.client;
    if (!client) throw new Error('Feishu is disconnected.');
    let reason = '飞书文件投递失败。';
    let platform: { code?: number; message?: string } | null = null;
    try {
      const uploaded = await client.im.v1.file.create({ data: { file_type: 'stream', file_name: name, file: Buffer.from(content) } });
      if (!uploaded?.file_key) { reason = '飞书未返回文件标识。'; throw new Error(reason); }
      const sent = await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: uploaded.file_key }), uuid: digest(key).slice(0, 32) } });
      platform = { code: sent.code, message: sent.msg };
      if (sent.code) { reason = `飞书拒绝发送文件（${sent.code}）：${sent.msg ?? ''}`; throw new Error(reason); }
      if (!sent.data?.message_id) { reason = '飞书接受了文件消息，但未返回消息 ID。'; throw new Error(reason); }
      await this.db.insert(feishuDeliveries).values({ id: key, chatId, messageId: sent.data.message_id }).onConflictDoUpdate({ target: feishuDeliveries.id, set: { messageId: sent.data.message_id } });
      await this.recordDelivery(chatId, key, 'done', { operation: 'file.send', name, content, platform, messageId: sent.data.message_id });
    } catch (error) {
      await this.recordDelivery(chatId, key, 'failed', { operation: 'file.send', name, content, platform }, reason);
      throw error;
    }
  }

  private async image(chatId: string, source: string): Promise<string> {
    const key = `${chatId}:image:${digest(source)}`;
    const [existing] = await this.db.select().from(feishuDeliveries).where(eq(feishuDeliveries.id, key)).limit(1);
    if (existing?.messageId) return existing.messageId;
    const match = /^data:image\/[^;]+;base64,(.+)$/s.exec(source);
    if (!match || !this.client) throw new Error('QR image is unavailable.');
    const uploaded = await this.client.im.v1.image.create({ data: { image_type: 'message', image: Buffer.from(match[1], 'base64') } });
    if (!uploaded?.image_key) throw new Error('Feishu did not return an image key.');
    await this.db.insert(feishuDeliveries).values({ id: key, chatId, messageId: uploaded.image_key }).onConflictDoNothing();
    return uploaded.image_key;
  }
}
