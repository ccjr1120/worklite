import { BadRequestException, ConflictException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Request } from 'express';
import type { WechatLoginView } from '@worklite/contracts';
import { chatSubmissions, externalChats, wechatEvents, type Database } from '@worklite/db';
import { DATABASE } from '../../../infrastructure/database.module';
import { assertRuntimeAdmission, runtimeAdmissionClosed, runtimeWritesFrozen } from '../../../infrastructure/runtime-upgrade-state';
import { AgentExecutionsService } from '../../agents/agent-executions.service';
import { CHAT_AGENT_ID, ChatDispatchService } from '../../agents/chat-dispatch.service';
import { AgentTeamsService } from '../../agent-teams/agent-teams.service';
import { RunsService } from '../../runs/runs.service';
import { UpgradesService } from '../../upgrades/upgrades.service';
import { encryptSecret, PluginsService } from '../plugins.service';
import { statusText } from '../feishu/feishu-cards';
import { fetchBotQrCode, getUpdates, ILINK_DEFAULT_BASE_URL, ILINK_STALE_TOKEN_ERRCODE, ILinkApiError, mediaLabel, parseInboundMessage, pollQrCodeStatus, sendTextMessage, MESSAGE_TYPE_USER, type FetchLike, type ILinkRawMessage } from './ilink';

type Json = Record<string, unknown>;
type Submission = typeof chatSubmissions.$inferSelect;
// WeChat plain-text answers only bind to Chat conversation questions; Team/Workflow controls
// stay on their authoritative surfaces and are announced as text notifications.
type WechatAction = { kind: 'agent_answer'; executionId: string; questionId: string; answer?: string; newConversation?: boolean; recoveryDecision?: 'adopt_command' | 'mark_failed' };
type LoginSession = {
  id: string;
  status: 'pending' | 'scanned' | 'confirmed' | 'expired' | 'error';
  qrcode: string;
  qrCodeUrl: string | null;
  error: string | null;
  host: string;
  refreshes: number;
  abort: AbortController;
  startedAt: number;
};

const request = {} as Request;
const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const LOGIN_TTL_MS = 5 * 60_000;
const MAX_QR_REFRESHES = 2;
// WeChat text messages are whole sends with no edit channel; overlong content is truncated
// instead of split so one delivery state stays one platform message.
const MAX_TEXT_BYTES = 3_500;
const TRUNCATION_NOTE = '\n\n……（内容过长已截断，完整内容请在 WorkLite 查看）';

@Injectable()
export class WechatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WechatService.name);
  private readonly fetchImpl: FetchLike = ((input, init) => fetch(input, init)) as FetchLike;
  private timer?: ReturnType<typeof setInterval>;
  private monitorAbort?: AbortController;
  private busy = false;
  private stopped = false;
  private generation = 0;
  private unsubscribers: Array<() => void> = [];
  private allowedUserId = '';
  private token = '';
  private baseUrl = ILINK_DEFAULT_BASE_URL;
  private login: LoginSession | null = null;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly plugins: PluginsService,
    private readonly dispatches: ChatDispatchService,
    private readonly executions: AgentExecutionsService,
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
    this.monitorAbort?.abort();
    this.login?.abort.abort();
    if (this.timer) clearInterval(this.timer);
  }

  loginView(): WechatLoginView | null {
    const session = this.login;
    if (!session) return null;
    if ((session.status === 'pending' || session.status === 'scanned') && Date.now() - session.startedAt > LOGIN_TTL_MS) {
      session.status = 'expired';
      session.abort.abort();
    }
    return {
      id: session.id,
      status: session.status,
      qrCodeUrl: session.status === 'pending' || session.status === 'scanned' ? session.qrCodeUrl : null,
      error: session.error,
    };
  }

  async startLogin(): Promise<WechatLoginView> {
    assertRuntimeAdmission();
    const current = this.loginView();
    if (current && (current.status === 'pending' || current.status === 'scanned')) return current;
    this.login?.abort.abort();
    const session: LoginSession = {
      id: `wlogin_${randomUUID()}`, status: 'pending', qrcode: '', qrCodeUrl: null, error: null,
      host: ILINK_DEFAULT_BASE_URL, refreshes: 0, abort: new AbortController(), startedAt: Date.now(),
    };
    this.login = session;
    try {
      const qr = await fetchBotQrCode(this.fetchImpl);
      if (this.login !== session) return this.loginView()!;
      session.qrcode = qr.qrcode;
      session.qrCodeUrl = qr.qrCodeUrl;
      void this.pollLogin(session);
    } catch {
      session.status = 'error';
      session.error = '无法获取微信登录二维码，请稍后重试。';
    }
    return this.loginView()!;
  }

  async cancelLogin(): Promise<void> {
    if (this.login && (this.login.status === 'pending' || this.login.status === 'scanned')) {
      this.login.abort.abort();
      this.login = null;
    }
  }

  private async pollLogin(session: LoginSession): Promise<void> {
    let failures = 0;
    while (this.login === session && (session.status === 'pending' || session.status === 'scanned')) {
      try {
        const result = await pollQrCodeStatus(this.fetchImpl, session.qrcode, session.host, session.abort.signal);
        if (this.login !== session || session.abort.signal.aborted) return;
        failures = 0;
        if (result.status === 'wait') continue;
        if (result.status === 'scaned') { session.status = 'scanned'; continue; }
        if (result.status === 'scaned_but_redirect') { if (result.redirectHost) session.host = `https://${result.redirectHost}`; continue; }
        if (result.status === 'expired') {
          if (session.refreshes < MAX_QR_REFRESHES) {
            // The platform expires a QR quickly; replace it in place so the visible flow heals itself.
            const qr = await fetchBotQrCode(this.fetchImpl);
            if (this.login !== session) return;
            session.qrcode = qr.qrcode;
            session.qrCodeUrl = qr.qrCodeUrl;
            session.refreshes += 1;
            session.status = 'pending';
            continue;
          }
          session.status = 'expired';
          return;
        }
        if (result.status === 'need_verifycode' || result.status === 'verify_code_blocked') {
          session.status = 'error';
          session.error = '微信要求额外安全验证，请稍后在微信中完成验证后重新扫码。';
          return;
        }
        if (result.status === 'binded_redirect') {
          session.status = 'error';
          session.error = '该微信账号已在其他位置登录，请先退出后重新扫码。';
          return;
        }
        await this.completeLogin(session, result);
        return;
      } catch {
        if (this.login !== session || session.abort.signal.aborted) return;
        failures += 1;
        if (failures >= 3) {
          session.status = 'error';
          session.error = '微信登录状态查询失败，请重新获取二维码。';
          return;
        }
        await sleep(2_000);
      }
    }
  }

  private async completeLogin(session: LoginSession, result: { botToken: string; botId: string; baseUrl: string; userId: string }): Promise<void> {
    if (!result.botToken || !result.botId) {
      session.status = 'error';
      session.error = '微信登录确认缺少凭据，请重新扫码。';
      return;
    }
    const config = await this.plugins.wechatSecret().catch(() => null);
    await this.plugins.updateWechat({
      wechatBotId: result.botId,
      wechatBotToken: encryptSecret(result.botToken),
      wechatBaseUrl: result.baseUrl || ILINK_DEFAULT_BASE_URL,
      // The scanning user becomes the allowed user, mirroring Feishu registration's auto-bind.
      ...(result.userId ? { wechatAllowedUserId: result.userId } : {}),
      wechatEnabled: true, wechatStatus: 'connecting', wechatLastError: null, wechatSyncBuf: '',
    });
    if (!result.userId && !config?.wechatAllowedUserId) await this.plugins.updateWechat({ wechatLastError: '登录成功，但未获得用户标识；请在渠道设置中手动填写允许的用户。' });
    session.status = 'confirmed';
    void this.connect();
  }

  async connect(): Promise<void> {
    const generation = ++this.generation;
    this.monitorAbort?.abort();
    this.monitorAbort = undefined;
    if (this.timer) clearInterval(this.timer);
    const config = await this.plugins.wechatSecret();
    if (!config.wechatEnabled || !config.botToken) {
      this.token = '';
      await this.plugins.updateWechat({ wechatStatus: 'disconnected', wechatLastError: null });
      return;
    }
    this.stopped = false;
    this.allowedUserId = config.wechatAllowedUserId;
    this.token = config.botToken;
    this.baseUrl = config.wechatBaseUrl || ILINK_DEFAULT_BASE_URL;
    const state = async (status: 'connecting' | 'connected' | 'error', reason: string | null = null) => {
      if (generation === this.generation && !this.stopped) await this.plugins.updateWechat({ wechatStatus: status, wechatLastError: reason });
    };
    await state('connecting');
    this.timer = setInterval(() => { void this.work(); }, 2_000);
    void this.monitor(generation, config.wechatSyncBuf, state);
  }

  async disconnect() {
    this.generation += 1;
    this.monitorAbort?.abort();
    this.monitorAbort = undefined;
    this.token = '';
    if (this.timer) clearInterval(this.timer);
    return this.plugins.updateWechat({ wechatEnabled: false, wechatStatus: 'disconnected', wechatLastError: null });
  }

  async freezeForUpgrade(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    this.monitorAbort?.abort();
    this.login?.abort.abort();
    if (this.timer) clearInterval(this.timer);
  }

  // The long-poll loop owns ingress. The sync cursor is persisted only after its messages are
  // recorded, so a restart redelivers at most the tail of the last batch and the idempotent
  // receipt insert absorbs the duplicates.
  private async monitor(generation: number, initialBuf: string, state: (status: 'connecting' | 'connected' | 'error', reason?: string | null) => Promise<void>): Promise<void> {
    let syncBuf = initialBuf;
    let failures = 0;
    let timeoutMs = 35_000;
    while (generation === this.generation && !this.stopped) {
      if (runtimeWritesFrozen()) break;
      const abort = new AbortController();
      this.monitorAbort = abort;
      try {
        const updates = await getUpdates(this.fetchImpl, { baseUrl: this.baseUrl, token: this.token, syncBuf, timeoutMs, signal: abort.signal });
        if (generation !== this.generation || this.stopped) break;
        failures = 0;
        if (updates.longpollingTimeoutMs) timeoutMs = updates.longpollingTimeoutMs;
        for (const raw of updates.msgs) await this.receiveMessage(raw);
        if (updates.getUpdatesBuf !== syncBuf) {
          syncBuf = updates.getUpdatesBuf;
          await this.plugins.updateWechat({ wechatSyncBuf: syncBuf });
        }
        await state('connected');
        void this.work();
      } catch (error) {
        if (abort.signal.aborted || generation !== this.generation || this.stopped) break;
        if (error instanceof ILinkApiError && (error.errcode === ILINK_STALE_TOKEN_ERRCODE || error.ret === ILINK_STALE_TOKEN_ERRCODE)) {
          // A stale token cannot recover by retrying; the user re-logins by QR.
          await state('error', '微信登录已过期，请重新扫码登录。');
          break;
        }
        failures += 1;
        if (failures >= 3) await state('connecting', '微信连接暂时失败，正在自动重试。');
        await sleep(failures >= 3 ? 30_000 : 2_000);
      }
    }
  }

  private async receiveMessage(raw: ILinkRawMessage): Promise<void> {
    const messageType = typeof raw.message_type === 'number' ? raw.message_type : Number(raw.message_type);
    if (messageType !== MESSAGE_TYPE_USER) return;
    const message = parseInboundMessage(raw);
    if (!message) return;
    if (message.groupId) return; // Group chat is outside the first version.
    if (message.fromUserId !== this.allowedUserId) {
      this.logger.warn(`WeChat message rejected: sender mismatch, messageId=${message.messageId}, sender=${digest(message.fromUserId).slice(0, 12)}.`);
      return;
    }
    const chatId = `wechat:${message.fromUserId}`;
    await this.db.insert(externalChats).values({ id: chatId, workspaceId: 'workspace_personal', channel: 'wechat', externalId: message.fromUserId, userId: message.fromUserId, contextToken: message.contextToken || null }).onConflictDoNothing();
    if (message.contextToken) await this.db.update(externalChats).set({ contextToken: message.contextToken, updatedAt: new Date() }).where(eq(externalChats.id, chatId));
    const [chat] = await this.db.select().from(externalChats).where(eq(externalChats.id, chatId)).limit(1);
    const execution = chat.executionId ? await this.executions.get(request, 'personal', CHAT_AGENT_ID, chat.executionId) : undefined;
    let boundAction: WechatAction | undefined;
    if (execution?.pendingQuestion) {
      const question = execution.pendingQuestion;
      // Recovery decisions have no buttons here; the two exact texts map to the domain decision.
      const recoveryDecision = question.recovery
        ? message.text === '采用已有命令结果' ? 'adopt_command' as const : message.text === '标记操作失败' ? 'mark_failed' as const : undefined
        : undefined;
      boundAction = {
        kind: 'agent_answer', executionId: execution.id, questionId: question.id,
        ...(question.action === 'new_conversation' ? { newConversation: true } : {}),
        ...(recoveryDecision ? { recoveryDecision } : {}),
      };
    }
    const escapeFailedConversation = !boundAction && message.text === '新对话' && execution?.status === 'failed';
    const eventId = `message:${message.messageId}`;
    this.db.transaction((transaction) => {
      const receipt = transaction.insert(wechatEvents).values({
        id: eventId, chatId,
        payload: {
          text: message.text,
          context: {
            messageId: message.messageId, createTimeMs: message.createTimeMs,
            ...(message.mediaKind ? { mediaKind: message.mediaKind } : {}),
            ...(message.contextToken ? { contextToken: message.contextToken } : {}),
          },
          ...(boundAction ? { action: boundAction, form: { answer: message.text } } : {}),
        },
      }).onConflictDoNothing().run();
      let submissionExecutionId = chat.executionId;
      if (receipt.changes > 0 && escapeFailedConversation && chat.executionId) {
        const unbound = transaction.update(externalChats).set({ executionId: null, updatedAt: new Date() }).where(and(eq(externalChats.id, chatId), eq(externalChats.executionId, chat.executionId))).run();
        if (unbound.changes === 0) throw new ConflictException('This WeChat conversation is no longer bound to the failed Agent execution.');
        submissionExecutionId = null;
      }
      if (receipt.changes > 0 && message.text && !boundAction) transaction.insert(chatSubmissions).values({ id: eventId, workspaceId: chat.workspaceId, chatId, executionId: submissionExecutionId, message: message.text, target: { kind: 'conversation' } }).run();
    });
    void this.work();
  }

  private async work(): Promise<void> {
    if (this.busy || this.stopped || runtimeWritesFrozen() || !this.token) return;
    this.busy = true;
    try {
      const events = await this.db.select().from(wechatEvents).where(eq(wechatEvents.status, 'queued')).orderBy(asc(wechatEvents.createdAt), sql`wechat_events.rowid`);
      const blocked = new Set<string>();
      for (const event of events) {
        if (runtimeAdmissionClosed()) break;
        if (blocked.has(event.chatId) && !event.payload.action) continue;
        const [owner] = await this.db.select({ userId: externalChats.userId, channel: externalChats.channel }).from(externalChats).where(eq(externalChats.id, event.chatId)).limit(1);
        if (owner?.channel !== 'wechat' || owner.userId !== this.allowedUserId) continue;
        if (!event.payload.action) {
          const [placeholder] = await this.db.select().from(chatSubmissions).where(eq(chatSubmissions.id, event.id)).limit(1);
          if (placeholder && !placeholder.reference && !placeholder.error) {
            try { await this.deliver(placeholder); }
            catch { await this.plugins.updateWechat({ wechatLastError: '微信消息投递失败，恢复后自动继续投递。' }); }
          }
        }
        try {
          await this.processEvent(event);
          await this.db.update(wechatEvents).set({ status: 'done', error: null }).where(eq(wechatEvents.id, event.id));
        } catch (error) {
          if (error instanceof ConflictException && /already running|pending answer required/.test(error.message)) { blocked.add(event.chatId); continue; }
          const reason = error instanceof BadRequestException || error instanceof ConflictException ? error.message : '无法处理此请求，请重试或在 WorkLite 查看任务详情。';
          const [submission] = await this.db.select().from(chatSubmissions).where(eq(chatSubmissions.id, event.id)).limit(1);
          if (!submission) await this.db.insert(chatSubmissions).values({ id: event.id, workspaceId: 'workspace_personal', chatId: event.chatId, message: '', target: { kind: 'conversation' }, error: reason }).onConflictDoNothing();
          else await this.db.update(chatSubmissions).set({ error: reason }).where(eq(chatSubmissions.id, event.id));
          await this.db.update(wechatEvents).set({ status: 'failed', error: reason }).where(eq(wechatEvents.id, event.id));
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
        if (owner?.channel !== 'wechat' || owner.userId !== this.allowedUserId) continue;
        try { await this.deliver(submission); }
        catch { await this.plugins.updateWechat({ wechatLastError: '微信消息投递失败，恢复后自动继续投递。' }); }
      }
    } catch {
      await this.plugins.updateWechat({ wechatLastError: '微信消息处理暂时失败，已接收的消息会在恢复后继续处理。' }).catch(() => undefined);
    } finally { this.busy = false; }
  }

  private async processEvent(event: typeof wechatEvents.$inferSelect): Promise<void> {
    const [chat] = await this.db.select().from(externalChats).where(eq(externalChats.id, event.chatId)).limit(1);
    const payload = event.payload;
    if (payload.action) {
      await this.applyAction(event.id, chat.id, payload.action as WechatAction, record(payload.form));
      return;
    }
    const text = string(payload.text);
    if (!text) throw new BadRequestException(`目前支持文字消息；${string(record(payload.context).mediaKind) ? `收到的${mediaLabel(record(payload.context).mediaKind as 'image' | 'voice' | 'file' | 'video')}无法处理，` : ''}请直接发送文字。`);
    const [received] = await this.db.select({ executionId: chatSubmissions.executionId }).from(chatSubmissions).where(eq(chatSubmissions.id, event.id)).limit(1);
    await this.dispatchFromChannel({ submissionId: event.id, message: text, target: { kind: 'conversation' }, executionId: received?.executionId ?? chat.executionId }, chat.id);
  }

  private async dispatchFromChannel(input: import('@worklite/contracts').DispatchChatRequest, chatId: string) {
    const [chat] = await this.db.select().from(externalChats).where(eq(externalChats.id, chatId)).limit(1);
    await this.db.insert(chatSubmissions).values({ id: input.submissionId, workspaceId: chat.workspaceId, chatId, executionId: input.executionId, message: input.message, target: input.target }).onConflictDoNothing();
    const result = await this.dispatches.dispatch(request, input);
    if (result.reference.kind === 'conversation') {
      const executionId = result.reference.executionId;
      this.db.transaction((transaction) => {
        const bound = transaction.update(externalChats).set({ executionId, updatedAt: new Date() }).where(and(eq(externalChats.id, chatId), input.executionId ? eq(externalChats.executionId, input.executionId) : isNull(externalChats.executionId))).run();
        if (bound.changes > 0) transaction.update(chatSubmissions).set({ executionId }).where(and(eq(chatSubmissions.chatId, chatId), isNull(chatSubmissions.executionId))).run();
      });
    }
    return result;
  }

  private async applyAction(eventId: string, chatId: string, action: WechatAction, form: Json): Promise<void> {
    const answer = string(form.answer).trim();
    const [accepted] = await this.db.select({ reference: chatSubmissions.reference }).from(chatSubmissions).where(eq(chatSubmissions.id, eventId)).limit(1);
    if (accepted?.reference) {
      if (action.newConversation && accepted.reference.kind === 'conversation') await this.db.update(externalChats).set({ executionId: accepted.reference.executionId, updatedAt: new Date() }).where(and(eq(externalChats.id, chatId), eq(externalChats.executionId, action.executionId)));
      return;
    }
    const current = await this.executions.get(request, 'personal', CHAT_AGENT_ID, action.executionId);
    if (current.status !== 'waiting_for_input' || current.pendingQuestion?.id !== action.questionId) throw new ConflictException('该问题已失效，请直接发送新的请求。');
    await this.dispatchFromChannel({ submissionId: eventId, message: action.answer ?? answer, target: { kind: 'conversation' }, executionId: action.executionId, questionId: action.questionId, recoveryDecision: action.recoveryDecision, newConversation: action.newConversation }, chatId);
    if (action.newConversation) {
      const [acceptedAnswer] = await this.db.select({ reference: chatSubmissions.reference }).from(chatSubmissions).where(eq(chatSubmissions.id, eventId)).limit(1);
      if (acceptedAnswer?.reference?.kind === 'conversation') await this.db.update(externalChats).set({ executionId: acceptedAnswer.reference.executionId, updatedAt: new Date() }).where(and(eq(externalChats.id, chatId), eq(externalChats.executionId, action.executionId)));
    }
  }

  // WeChat delivers whole text messages; there is no editable card or typewriter channel.
  // The fingerprint therefore covers only deliverable states — acceptance, a pending question,
  // a task status change, or the terminal reply — so ordinary model deltas never send.
  private async deliver(submission: Submission): Promise<void> {
    const chatId = submission.chatId!;
    const reference = submission.reference;
    let text = '已收到，正在处理…';
    let terminal = false;
    if (submission.error) {
      text = `请求失败：${submission.error}`;
      terminal = true;
    } else if (reference?.kind === 'upgrade') {
      const job = this.upgrades.view(reference.jobId);
      const statuses: Record<string, string> = { proposed: '等待重新部署指令', authorized: '部署已启动', preflighting: '正在预检', draining: '正在交接任务', frozen: '即将切换', switching: '正在切换', recovering: '正在恢复旧版本', succeeded: '部署完成', rolled_back: '已恢复旧版本', failed: '部署未完成' };
      text = `【WorkLite 部署】${statuses[job.phase] ?? job.phase}\n版本：${job.releaseHash.slice(0, 12)}${job.error ? `\n${job.error}` : ''}`;
      terminal = ['proposed', 'succeeded', 'rolled_back', 'failed'].includes(job.phase);
    } else if (reference?.kind === 'conversation') {
      const execution = await this.executions.get(request, 'personal', CHAT_AGENT_ID, reference.executionId);
      const start = reference.afterMessageId ? execution.messages.findIndex((message) => message.id === reference.afterMessageId) + 1 : 0;
      const executionStatus = reference.completionStatus ?? execution.status;
      terminal = ['completed', 'failed', 'cancelled'].includes(executionStatus);
      if (terminal && !reference.completionStatus) await this.db.update(chatSubmissions).set({ reference: { ...reference, untilMessageId: execution.messages.at(-1)?.id ?? null, completionStatus: execution.status, completionError: execution.error } }).where(eq(chatSubmissions.id, submission.id));
      if (terminal) {
        const end = reference.untilMessageId ? execution.messages.findIndex((message) => message.id === reference.untilMessageId) + 1 : undefined;
        const replies = execution.messages.slice(start, end).filter((message) => message.role === 'assistant').map((message) => message.content).filter(Boolean);
        const failure = reference.completionError || (!reference.completionStatus ? execution.error : null);
        if (executionStatus === 'failed') text = `对话失败：${failure ?? '未知错误'}${replies.length ? `\n\n${replies.join('\n\n')}` : ''}`;
        else if (executionStatus === 'cancelled') text = `本轮对话已取消。${replies.length ? `\n\n${replies.join('\n\n')}` : ''}`;
        else text = replies.join('\n\n') || '本轮对话已结束。';
      } else if (execution.status === 'waiting_for_input' && execution.pendingQuestion) {
        const question = execution.pendingQuestion;
        text = question.question;
        if (question.options.length) text += `\n\n${question.options.map((option, index) => `${index + 1}. ${option}`).join('\n')}`;
        if (question.action === 'new_conversation') text += '\n\n回复任意内容开始新对话。';
        else if (question.recovery) text += `\n\n请回复「采用已有命令结果」或「标记操作失败」。${question.recovery.commandExecutionId ? '也可回复其他内容说明处理方式。' : ''}`;
        else text += '\n\n请直接回复你的答案。';
      }
    } else if (reference?.kind === 'team') {
      const run = await this.teams.getRun(request, 'personal', reference.runId);
      terminal = ['succeeded', 'failed', 'cancelled'].includes(run.status);
      const pending = run.pendingInputs.find((item) => item.status === 'pending');
      if (terminal) {
        text = `【Agent Team】任务${statusText[run.status] ?? run.status}\n${run.intent}`;
        if (run.outcome) text += `\n\n${run.outcome.summary}${run.outcome.unresolvedIssues.length ? `\n\n待解决：\n${run.outcome.unresolvedIssues.map((issue) => `- ${issue}`).join('\n')}` : ''}`;
      } else if (pending) {
        text = `【Agent Team】任务等待你的输入\n${pending.question}\n\n请前往 WorkLite 处理该问题。`;
      } else {
        text = `【Agent Team】任务已开始执行\n${run.intent}`;
      }
    } else if (reference?.kind === 'workflow') {
      let run = await this.runs.get(request, 'personal', reference.runId);
      if (run.pendingAction && (run.pendingAction.status === 'expired' || run.pendingAction.expiresAt && Date.parse(run.pendingAction.expiresAt) <= Date.now())) run = await this.runs.refreshPendingAction(request, 'personal', run.id);
      terminal = ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run.status);
      if (terminal) {
        text = `【工作流】「${run.workflowName}」${statusText[run.status] ?? run.status}`;
        if (run.result != null) text += `\n\n${typeof run.result === 'string' ? run.result : JSON.stringify(run.result, null, 2)}`;
      } else if (run.pendingAction) {
        text = `【工作流】「${run.workflowName}」需要操作\n${run.pendingAction.title}\n${run.pendingAction.description}\n\n请前往 WorkLite 处理。`;
      } else {
        text = `【工作流】「${run.workflowName}」已开始执行${run.currentStep ? `\n当前步骤：${run.currentStep}` : ''}`;
      }
    }
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES) {
      let cut = text;
      while (Buffer.byteLength(cut) > MAX_TEXT_BYTES - Buffer.byteLength(TRUNCATION_NOTE)) cut = cut.slice(0, -1);
      text = cut + TRUNCATION_NOTE;
    }
    const fingerprint = digest(JSON.stringify({ kind: reference?.kind ?? 'pending', text, terminal }));
    if (fingerprint === submission.deliveryFingerprint) {
      if (terminal) await this.db.update(chatSubmissions).set({ settled: true }).where(eq(chatSubmissions.id, submission.id));
      return;
    }
    const [chat] = await this.db.select().from(externalChats).where(eq(externalChats.id, chatId)).limit(1);
    if (!chat) throw new Error('WeChat conversation is missing.');
    // The client id derives from the submission and content, so a retry after an uncertain
    // send replays the same platform idempotency key instead of producing a duplicate.
    const clientId = digest(`wechat:${submission.id}:${fingerprint}`).slice(0, 32);
    const key = `${submission.id}:${fingerprint.slice(0, 16)}`;
    try {
      const result = await sendTextMessage(this.fetchImpl, { baseUrl: this.baseUrl, token: this.token, toUserId: chat.externalId, text, contextToken: chat.contextToken ?? '', clientId });
      await this.db.update(chatSubmissions).set({ outputMessageId: result.messageId || clientId, deliveryFingerprint: fingerprint, settled: terminal, updatedAt: new Date() }).where(eq(chatSubmissions.id, submission.id));
      await this.recordDelivery(chatId, key, 'done', { operation: 'message.send', clientId, messageId: result.messageId || null, text });
    } catch (error) {
      const reason = error instanceof ILinkApiError ? error.message : '微信消息发送暂时失败，恢复后将继续投递。';
      await this.recordDelivery(chatId, key, 'failed', { operation: 'message.send', clientId, text }, reason);
      if (error instanceof ILinkApiError && (error.errcode === ILINK_STALE_TOKEN_ERRCODE || error.ret === ILINK_STALE_TOKEN_ERRCODE)) {
        await this.plugins.updateWechat({ wechatStatus: 'error', wechatLastError: '微信登录已过期，请重新扫码登录。' });
      }
      throw error;
    }
  }

  private async recordDelivery(chatId: string, key: string, status: 'done' | 'failed', payload: Json, error: string | null = null) {
    const id = `outbound:${key}:${status}`;
    await this.db.insert(wechatEvents).values({ id, chatId, status, payload: { direction: 'outbound', ...payload }, error })
      .onConflictDoUpdate({ target: wechatEvents.id, set: { payload: { direction: 'outbound', ...payload }, error } });
  }
}
