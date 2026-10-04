import { BadRequestException, ConflictException, Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Client, EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { chatSubmissions, feishuChats, feishuDeliveries, feishuEvents, type Database } from '@worklite/db';
import { DATABASE } from '../../../infrastructure/database.module';
import { AgentExecutionsService } from '../../agents/agent-executions.service';
import { CHAT_AGENT_ID, ChatDispatchService } from '../../agents/chat-dispatch.service';
import { AgentTeamConversationService } from '../../agent-teams/agent-team-conversation.service';
import { AgentTeamsService } from '../../agent-teams/agent-teams.service';
import { RunsService } from '../../runs/runs.service';
import { PluginsService } from '../plugins.service';
import { renderCard, statusText, type CardButton, type CardState, type FeishuAction, type SavedCard } from './feishu-cards';
import { runtimeAdmissionClosed, runtimeWritesFrozen } from '../../../infrastructure/runtime-upgrade-state';
import { UpgradesService } from '../../upgrades/upgrades.service';

type Json = Record<string, unknown>;
type Submission = typeof chatSubmissions.$inferSelect;
const request = {} as Request;
const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class FeishuService implements OnModuleInit, OnModuleDestroy {
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
    private readonly conversations: AgentTeamConversationService,
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
      this.conversations.subscribe(() => {
        void this.db.update(chatSubmissions).set({ settled: false }).where(sql`json_extract(${chatSubmissions.reference}, '$.kind') = 'team'`).then(() => undefined);
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
        try { await this.receiveAction(record(event), config.feishuAllowedUserId); } finally { this.intakePending -= 1; }
        return { toast: { type: 'info', content: '已收到，正在处理' } };
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
    while (this.busy || this.intakePending) await new Promise((resolve) => setTimeout(resolve, 50));
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
    await this.db.insert(feishuChats).values({ id: chatId, workspaceId: 'workspace_personal', userId }).onConflictDoNothing();
    const [chat] = await this.db.select().from(feishuChats).where(eq(feishuChats.id, chatId)).limit(1);
    const replyTo = string(message.parent_id) || string(message.root_id);
    let boundAction: FeishuAction | undefined;
    let parentSubmissionId: string | undefined;
    if (replyTo) {
      const [parent] = await this.db.select().from(chatSubmissions).where(and(eq(chatSubmissions.chatId, chatId), eq(chatSubmissions.outputMessageId, replyTo))).limit(1);
      boundAction = (parent?.renderedCard as SavedCard | null)?.replyAction;
      parentSubmissionId = parent?.id;
    } else if (chat.executionId) {
      const execution = await this.executions.get(request, 'personal', CHAT_AGENT_ID, chat.executionId);
      if (execution.pendingQuestion) boundAction = { kind: 'agent_answer', executionId: execution.id, questionId: execution.pendingQuestion.id };
    }
    const eventId = `message:${messageId}`;
    this.db.transaction((transaction) => {
      const receipt = transaction.insert(feishuEvents).values({ id: eventId, chatId, payload: { text, context: { content: message.content, messageId, messageType: message.message_type, createTime: message.create_time, parentId: message.parent_id, rootId: message.root_id }, ...(boundAction ? { action: boundAction, form: { answer: text }, ...(parentSubmissionId ? { submissionId: parentSubmissionId } : {}) } : {}) } }).onConflictDoNothing().run();
      if (receipt.changes > 0 && text && !boundAction) transaction.insert(chatSubmissions).values({ id: eventId, workspaceId: chat.workspaceId, chatId, executionId: chat.executionId, message: text, target: { kind: 'conversation' } }).run();
    });
    void this.work();
  }

  private async receiveAction(event: Json, allowedUserId: string): Promise<void> {
    if (string(record(event.operator).open_id) !== allowedUserId) return;
    const action = record(event.action);
    const value = record(action.value);
    const [submission] = await this.db.select().from(chatSubmissions).where(eq(chatSubmissions.id, string(value.submissionId))).limit(1);
    const saved = submission?.renderedCard as SavedCard | null;
    const selected = saved?.actions[string(value.actionKey)];
    if (!submission?.chatId || !selected || string(record(event.context).open_message_id) !== submission.outputMessageId) return;
    // Persist only the server-rendered operation; callback fields cannot fabricate a Run or permission.
    const eventId = string(event.token) || digest(JSON.stringify(event));
    await this.db.insert(feishuEvents).values({ id: `action:${eventId}`, chatId: submission.chatId, payload: { submissionId: submission.id, action: selected, form: record(action.form_value), context: { messageId: submission.outputMessageId, actionKey: string(value.actionKey) } } }).onConflictDoNothing();
    void this.work();
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
        const [owner] = await this.db.select({ userId: feishuChats.userId }).from(feishuChats).where(eq(feishuChats.id, event.chatId)).limit(1);
        if (owner?.userId !== this.allowedUserId) continue;
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
      const children = await this.db.select({ submission: chatSubmissions, chat: feishuChats }).from(chatSubmissions)
        .innerJoin(feishuChats, eq(chatSubmissions.executionId, feishuChats.executionId)).where(isNull(chatSubmissions.chatId));
      for (const { submission, chat } of children) await this.db.update(chatSubmissions).set({ chatId: chat.id }).where(eq(chatSubmissions.id, submission.id));
      const submissions = await this.db.select().from(chatSubmissions).where(and(eq(chatSubmissions.workspaceId, 'workspace_personal'), eq(chatSubmissions.settled, false))).orderBy(asc(chatSubmissions.createdAt));
      for (const submission of submissions) {
        if (!submission.chatId) continue;
        const [owner] = await this.db.select({ userId: feishuChats.userId }).from(feishuChats).where(eq(feishuChats.id, submission.chatId)).limit(1);
        if (owner?.userId !== this.allowedUserId) continue;
        try { await this.deliver(submission); }
        catch { await this.plugins.updateFeishu({ feishuLastError: '飞书消息投递失败，请检查机器人消息、文件与卡片权限；恢复后自动继续投递。' }); }
      }
    } catch {
      await this.plugins.updateFeishu({ feishuLastError: '飞书消息处理暂时失败，已接收的消息会在恢复后继续处理。' }).catch(() => undefined);
    } finally { this.busy = false; }
  }

  private async processEvent(event: typeof feishuEvents.$inferSelect): Promise<void> {
    const [chat] = await this.db.select().from(feishuChats).where(eq(feishuChats.id, event.chatId)).limit(1);
    const payload = event.payload;
    if (payload.action) {
      await this.applyAction(event.id, chat.id, payload.action as FeishuAction, record(payload.form), string(payload.submissionId));
      return;
    }
    const text = string(payload.text);
    if (!text) throw new BadRequestException('目前支持文字消息；请直接发送文字。');
    await this.dispatchFromChannel({ submissionId: event.id, message: text, target: { kind: 'conversation' }, executionId: chat.executionId }, chat.id);
  }

  private async dispatchFromChannel(input: import('@worklite/contracts').DispatchChatRequest, chatId: string) {
    const [chat] = await this.db.select().from(feishuChats).where(eq(feishuChats.id, chatId)).limit(1);
    await this.db.insert(chatSubmissions).values({ id: input.submissionId, workspaceId: chat.workspaceId, chatId, executionId: input.executionId, message: input.message, target: input.target }).onConflictDoNothing();
    const result = await this.dispatches.dispatch(request, input);
    if (result.reference.kind === 'conversation') {
      const executionId = result.reference.executionId;
      this.db.transaction((transaction) => {
        transaction.update(feishuChats).set({ executionId, updatedAt: new Date() }).where(eq(feishuChats.id, chatId)).run();
        transaction.update(chatSubmissions).set({ executionId }).where(and(eq(chatSubmissions.chatId, chatId), isNull(chatSubmissions.executionId))).run();
      });
    }
    return result;
  }

  private async applyAction(eventId: string, chatId: string, action: FeishuAction, form: Json, parentId: string): Promise<void> {
    const answer = string(form.answer).trim();
    if (action.kind === 'intake') {
      const [chat] = await this.db.select().from(feishuChats).where(eq(feishuChats.id, chatId)).limit(1);
      await this.dispatchFromChannel({ submissionId: eventId, message: action.answer ?? answer, executionId: chat.executionId, target: { kind: 'team', teamId: action.teamId, intakeSubmissionId: action.intakeSubmissionId, intakeField: action.field } }, chatId);
    } else if (action.kind === 'answer') {
      const run = await this.teams.getRun(request, 'personal', action.runId);
      const pending = run.pendingInputs.find((item) => item.id === action.pendingInputId);
      if (pending?.status === 'answered') return; // Acknowledgement may have been interrupted after the domain committed.
      await this.teams.answer(request, 'personal', action.runId, { pendingInputId: action.pendingInputId, scopeRevision: action.scopeRevision, answer, authorizedCommands: string(form.commands).split('\n').map((item) => item.trim()).filter(Boolean) });
    } else if (action.kind === 'agent_answer') {
      const [accepted] = await this.db.select({ reference: chatSubmissions.reference }).from(chatSubmissions).where(eq(chatSubmissions.id, eventId)).limit(1);
      if (accepted?.reference) return;
      const current = await this.executions.get(request, 'personal', CHAT_AGENT_ID, action.executionId);
      if (current.status !== 'waiting_for_input' || current.pendingQuestion?.id !== action.questionId) throw new ConflictException('This Agent question is no longer active.');
      await this.dispatchFromChannel({ submissionId: eventId, message: action.answer ?? answer, target: { kind: 'conversation' }, executionId: action.executionId, questionId: action.questionId }, chatId);
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
    } else if (action.kind === 'upgrade') {
      this.upgrades.confirm(action.jobId, action.releaseHash, this.allowedUserId);
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
    const files: Array<{ id: string; name: string; content: string }> = [];
    if (submission.error) {
      state.status = '请求失败'; state.content = submission.error; terminal = true;
    } else if (reference?.kind === 'upgrade') {
      const job = this.upgrades.view(reference.jobId);
      const statuses: Record<string, string> = { awaiting_confirmation: '等待升级确认', authorized: '升级已确认', preflighting: '正在预检', draining: '正在交接任务', frozen: '即将切换', switching: '正在切换', recovering: '正在恢复旧版本', succeeded: '升级完成', rolled_back: '已恢复旧版本', failed: '升级未完成' };
      state.title = 'WorkLite 升级'; state.status = statuses[job.phase] ?? job.phase;
      state.conversation = false;
      state.content = `版本：${job.releaseHash.slice(0, 12)}\n${job.summary}\n\n确认将授权：安装依赖、编译与隔离预检、任务交接、数据备份、服务切换，以及失败时恢复旧版本。切换期间飞书可能短暂断连。`;
      if (job.error) state.content += `\n\n${job.error}`;
      if (job.phase === 'awaiting_confirmation') state.buttons.push({ label: '升级到此版本', action: { kind: 'upgrade', jobId: job.id, releaseHash: job.releaseHash } });
      terminal = ['succeeded', 'rolled_back', 'failed'].includes(job.phase);
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
        state.question = { text: question.question, action, replyOnly: question.options.length > 0 };
        state.buttons.push(...question.options.map((option) => ({ label: option, action: { ...action, answer: option } })));
      }
      if (!reference.completionStatus && (execution.status === 'running' || execution.status === 'waiting_for_input')) state.buttons.push({ label: '停止本轮对话', action: { kind: 'control', domain: 'conversation', runId: execution.id, action: 'cancel' } });
      if ((!reference.completionStatus || reference.completionStatus === 'failed') && execution.status === 'failed') state.buttons.push({ label: '重试本轮对话', action: { kind: 'control', domain: 'conversation', runId: execution.id, action: 'retry' } });
      state.replyContent = state.content;
      if (Buffer.byteLength(state.content) > 20_000) {
        if (terminal) files.push({ id: `reply:${submission.id}:${digest(state.content)}`, name: 'chat-reply.md', content: state.content });
        state.content = terminal ? '完整回复见 Markdown 文件。' : '正在生成较长回复，完成后将发送完整文件。';
      }
    } else if (reference?.kind === 'team') {
      const conversation = await this.conversations.getConversation(request, 'personal', reference.teamId);
      const intake = conversation.intakes.find((item) => item.submissionId === reference.intakeSubmissionId);
      if (!intake) throw new Error('Team intake not found.');
      state.title = 'Chat · Agent Team';
      state.status = statusText[intake.status] ?? intake.status;
      state.content = intake.goal ?? submission.message;
      if (!intake.runId) {
        const question = [...conversation.messages].reverse().find((message) => message.kind === 'coordinator_question' && message.intakeId === intake.id);
        if (intake.status === 'collecting' && question?.kind === 'coordinator_question') {
          const action: FeishuAction = { kind: 'intake', teamId: reference.teamId, intakeSubmissionId: reference.intakeSubmissionId, field: question.field };
          state.question = { text: question.text, action };
          state.buttons.push(...question.options.map((option) => ({ label: option.label, action: { ...action, answer: option.value } as FeishuAction })));
        }
        terminal = intake.status === 'failed';
      } else {
        const run = await this.teams.getRun(request, 'personal', intake.runId);
        state.status = statusText[run.status] ?? run.status;
        const active = [...run.tasks].reverse().find((task) => task.retryable || ['running', 'waiting_for_input', 'waiting_for_recovery'].includes(task.status));
        state.content = `${run.intent}\n\n${active ? `当前任务：${active.taskKey}` : ''}`;
        if (run.status === 'failed' && active?.error) state.content += `\n\n${active.error}`;
        const pending = run.pendingInputs.find((item) => item.status === 'pending');
        if (pending?.kind === 'question') state.question = { text: pending.question, action: { kind: 'answer', runId: run.id, pendingInputId: pending.id, scopeRevision: pending.scopeRevision }, commands: run.mode !== 'plan_only' };
        if (pending?.kind === 'operation_recovery' && pending.operationKey) {
          state.content += `\n\n${pending.question}`;
          state.buttons.push(...(['adopt_command', 'mark_failed', 'replay'] as const).map((decision) => ({ label: ({ adopt_command: '采用已执行结果', mark_failed: '标记操作失败', replay: '重新执行此操作' })[decision], action: { kind: 'recovery', runId: run.id, operationKey: pending.operationKey!, decision } as FeishuAction })));
        }
        this.controls(state.buttons, 'team', run.id, run.status, active?.retryable ? active.taskKey : undefined);
        terminal = ['succeeded', 'failed', 'cancelled'].includes(run.status);
        if (run.outcome) state.content += `\n\n${run.outcome.summary}${run.outcome.unresolvedIssues.length ? `\n\n待解决：\n${run.outcome.unresolvedIssues.map((issue) => `- ${issue}`).join('\n')}` : ''}`;
        for (const document of run.documents) {
          try {
            const delivered = await this.conversations.downloadDocument(request, 'personal', document.id);
            files.push({ id: `team:${document.id}`, name: delivered.fileName, content: delivered.content });
          } catch { state.content += `\n\n文档「${document.title}」尚未完成文件交付，可重试交付。`; state.buttons.push({ label: '重试文件交付', action: { kind: 'delivery' } }); }
        }
      }
    } else if (reference?.kind === 'workflow') {
      let run = await this.runs.get(request, 'personal', reference.runId);
      if (run.pendingAction && (run.pendingAction.status === 'expired' || run.pendingAction.expiresAt && Date.parse(run.pendingAction.expiresAt) <= Date.now())) run = await this.runs.refreshPendingAction(request, 'personal', run.id);
      state.title = `Chat · ${run.workflowName}`;
      state.status = statusText[run.status] ?? run.status;
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
    if (fingerprint === submission.deliveryFingerprint) {
      if (terminal) await this.db.update(chatSubmissions).set({ settled: true }).where(eq(chatSubmissions.id, submission.id));
      return;
    }
    // Persist the action allow-list before the message can be clicked.
    await this.db.update(chatSubmissions).set({ renderedCard: saved as unknown as Json }).where(eq(chatSubmissions.id, submission.id));
    const client = this.client;
    if (!client) return;
    let messageId = submission.outputMessageId;
    const operation = messageId ? 'card.update' : 'card.create';
    let platform: { code?: number; message?: string } | null = null;
    let reason = '飞书卡片投递失败。';
    try {
      if (messageId) {
        const result = await client.im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(saved.card) } });
        platform = { code: result.code, message: result.msg };
        if (result.code) { reason = `飞书拒绝更新卡片（${result.code}）：${result.msg ?? ''}`; throw new Error(reason); }
      } else {
        const result = await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(saved.card), uuid: digest(`card:${submission.id}`).slice(0, 32) } });
        platform = { code: result.code, message: result.msg };
        if (result.code) { reason = `飞书拒绝发送卡片（${result.code}）：${result.msg ?? ''}`; throw new Error(reason); }
        if (!result.data?.message_id) { reason = '飞书接受了发送请求，但未返回消息 ID。'; throw new Error(reason); }
        messageId = result.data.message_id;
      }
      await this.recordDelivery(chatId, `${submission.id}:${fingerprint}`, 'done', { operation, submissionId: submission.id, messageId, platform, card: saved.card });
    } catch (error) {
      await this.recordDelivery(chatId, `${submission.id}:${fingerprint}`, 'failed', { operation, submissionId: submission.id, messageId, platform, card: saved.card }, reason);
      throw error;
    }
    await this.db.update(chatSubmissions).set({ outputMessageId: messageId, deliveryFingerprint: fingerprint, settled: terminal, updatedAt: new Date() }).where(eq(chatSubmissions.id, submission.id));
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
