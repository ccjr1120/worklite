import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Request } from 'express';
import { CHAT_AGENT_ID, type AgentExecutionEventData, type AgentExecutionView, type ChatChannelView, type ChatConversationList, type ChatConversationRecords, type ChatConversationSummary, type ChatConversationView, type ChatSubmissionView } from '@worklite/contracts';
import { agentExecutionEvents, agentExecutions, agentToolCalls, agents, chatConfigurations, chatSubmissions, externalChats, feishuDeliveries, feishuEvents, chatChannels, wechatEvents, type Database, type StoredAgentDisplayMessage, type StoredAgentModelMessage } from '@worklite/db';
import { createModelGateway } from '@worklite/model-gateway';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { AgentExecutionsService } from './agent-executions.service';
import { activeChatBackgroundExecutionIds, chatConversationStatus } from './chat-conversation-status';

// The default summarize prompt gives a fresh conversation everything a reader who never saw the
// original transcript needs to continue it; the goal is stated, the shape is the model's choice.
// A non-empty summarizePrompt from Chat configuration replaces it verbatim — no placeholders.
const DEFAULT_SUMMARIZE_SYSTEM_PROMPT = '用户会提供一段完整的对话记录。总结这段对话，使一位没有看过它的助手仅凭你的总结就能无缝接续工作：保留关键结论、已做的决定、重要上下文与约束，以及尚未完成的事项。使用与对话相同的语言，只输出总结正文。';

@Injectable()
export class ChatConversationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly executions: AgentExecutionsService,
    private readonly resources: WorkspaceResourcesService,
  ) {}

  channels(): ChatChannelView[] {
    return [
      { id: 'web', name: 'Web', builtIn: true, presentation: ['streaming', 'markdown', 'questions', 'execution records'] },
      { id: 'wechat', name: '微信', builtIn: false, presentation: ['text messages', 'QR images'] },
    ];
  }

  /**
   * One page of the conversation list, newest first. Each source (Chat executions,
   * standalone tasks, external chats still waiting for their first turn) reads at most one
   * page plus one row past the cursor in SQL, so the work per request does not grow with
   * the total number of conversations. Only a search request, which is never polled, reads
   * the standalone-task and waiting-chat sources whole, because its text match runs in JS.
   */
  async list(request: Request, query: { cursor?: string; search?: string; channel?: string }): Promise<ChatConversationList> {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    const search = query.search?.trim() || undefined;
    const channel = query.channel || undefined;
    let boundary: { updatedAt: string; id: string } | null = null;
    if (query.cursor) {
      try { boundary = JSON.parse(Buffer.from(query.cursor, 'base64url').toString()) as { updatedAt: string; id: string }; }
      catch { throw new BadRequestException('Invalid conversation cursor.'); }
      if (!boundary || typeof boundary.updatedAt !== 'string' || typeof boundary.id !== 'string') throw new BadRequestException('Invalid conversation cursor.');
    }
    const boundaryMs = boundary ? Date.parse(boundary.updatedAt) : null;
    if (boundaryMs !== null && !Number.isFinite(boundaryMs)) throw new BadRequestException('Invalid conversation cursor.');
    const window = boundary && boundaryMs !== null ? { ms: boundaryMs, id: boundary.id } : null;

    // The outer column is qualified by hand: inside a select list Drizzle renders a column
    // unqualified, and a bare "id" here would resolve to chat_submissions.id.
    const chatIdOf = sql<string | null>`(select chat_id from chat_submissions where chat_submissions.execution_id = "agent_executions"."id" and chat_id is not null order by created_at desc limit 1)`;
    // Same derivation as the item's channel below: unbound is web, an unknown bound chat reads as feishu.
    const channelOf = sql<string>`(case when ${chatIdOf} is null then 'web' else coalesce((select channel from external_chats where external_chats.id = ${chatIdOf}), 'feishu') end)`;
    const rows = await pageWindow(window, agentExecutions.updatedAt, true, (bound, limit) => {
      const statement = this.db.select({
        id: agentExecutions.id,
        status: agentExecutions.status,
        title: sql<string>`coalesce(json_extract(${agentExecutions.displayMessages}, '$[0].content'), '')`,
        createdAt: agentExecutions.createdAt,
        updatedAt: agentExecutions.updatedAt,
        chatId: chatIdOf,
      }).from(agentExecutions).where(and(eq(agentExecutions.workspaceId, workspace.id), eq(agentExecutions.agentId, CHAT_AGENT_ID),
        search ? sql`${agentExecutions.displayMessages} like ${`%${search}%`}` : undefined,
        channel ? sql`${channelOf} = ${channel}` : undefined, bound)).orderBy(desc(agentExecutions.updatedAt), desc(agentExecutions.id));
      return limit === undefined ? statement : statement.limit(limit);
    });
    const boundChatIds = [...new Set(rows.map((row) => row.chatId).filter((id): id is string => Boolean(id)))];
    const boundChats = boundChatIds.length ? await this.db.select({ id: externalChats.id, channel: externalChats.channel }).from(externalChats).where(inArray(externalChats.id, boundChatIds)) : [];
    const channelByChat = new Map(boundChats.map((chat) => [chat.id, chat.channel]));
    const activeBackground = await activeChatBackgroundExecutionIds(this.db, workspace.id, rows.map((row) => row.id));
    const items: ChatConversationSummary[] = rows.map((row) => ({
      id: row.id, executionId: row.id, title: row.title, channel: row.chatId ? channelByChat.get(row.chatId) ?? 'feishu' : 'web',
      channelConversationId: row.chatId, status: chatConversationStatus(row.status, activeBackground.has(row.id)),
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    }));
    // Standalone tasks are always web conversations.
    const tasks = !channel || channel === 'web' ? await pageWindow(window, chatSubmissions.updatedAt, !search, (bound, limit) => {
      const statement = this.db.select().from(chatSubmissions).where(and(eq(chatSubmissions.workspaceId, workspace.id), isNull(chatSubmissions.executionId), isNull(chatSubmissions.chatId), sql`${chatSubmissions.reference} is not null`, bound))
        .orderBy(desc(chatSubmissions.updatedAt), desc(chatSubmissions.id));
      return limit === undefined ? statement : statement.limit(limit);
    }) : [];
    for (const task of tasks) {
      if (search && !task.message.toLowerCase().includes(search.toLowerCase())) continue;
      items.push({ id: task.id, executionId: null, title: task.message, channel: 'web', channelConversationId: null,
        status: task.error ? 'failed' : 'task', createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString() });
    }
    const waiting = !channel || channel !== 'web' ? await pageWindow(window, externalChats.updatedAt, !search, (bound, limit) => {
      const statement = this.db.select().from(externalChats).where(and(eq(externalChats.workspaceId, workspace.id), isNull(externalChats.executionId),
        channel ? eq(externalChats.channel, channel as 'feishu' | 'wechat') : undefined, bound)).orderBy(desc(externalChats.updatedAt), desc(externalChats.id));
      return limit === undefined ? statement : statement.limit(limit);
    }) : [];
    for (const chat of waiting) {
      const events = channelEvents(chat.channel);
      const [receipt] = await this.db.select().from(events).where(and(eq(events.chatId, chat.id), notOutboundEvent(events), sql`json_extract(${events.payload}, '$.direction') is null`)).orderBy(desc(events.createdAt)).limit(1);
      const title = typeof receipt?.payload.text === 'string' ? receipt.payload.text : '';
      if (search && !title.toLowerCase().includes(search.toLowerCase())) continue;
      items.push({ id: chat.id, executionId: null, title, channel: chat.channel, channelConversationId: chat.id,
        status: receipt?.status === 'failed' ? 'failed' : 'queued', createdAt: (receipt?.createdAt ?? chat.updatedAt).toISOString(), updatedAt: chat.updatedAt.toISOString() });
    }
    // The SQL windows only narrow the candidates; this filter and sort decide the page exactly as before.
    const filtered = items.filter((item) => (!channel || item.channel === channel) && (!boundary ||
      item.updatedAt < boundary.updatedAt || item.updatedAt === boundary.updatedAt && item.id.localeCompare(boundary.id) < 0))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
    const page = filtered.slice(0, 50);
    const last = page.at(-1);
    return { items: page, nextCursor: filtered.length > page.length && last ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, id: last.id })).toString('base64url') : null };
  }

  async get(request: Request, id: string): Promise<ChatConversationView> {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    let [row] = await this.db.select({ id: agentExecutions.id }).from(agentExecutions).where(and(eq(agentExecutions.id, id), eq(agentExecutions.workspaceId, workspace.id), eq(agentExecutions.agentId, CHAT_AGENT_ID))).limit(1);
    let chat: typeof externalChats.$inferSelect | undefined;
    let standalone: typeof chatSubmissions.$inferSelect | undefined;
    if (!row) {
      [chat] = await this.db.select().from(externalChats).where(and(eq(externalChats.id, id), eq(externalChats.workspaceId, workspace.id))).limit(1);
      if (!chat) [standalone] = await this.db.select().from(chatSubmissions).where(and(eq(chatSubmissions.id, id), eq(chatSubmissions.workspaceId, workspace.id), isNull(chatSubmissions.executionId), isNull(chatSubmissions.chatId))).limit(1);
      if (!chat && !standalone) throw new NotFoundException('Chat conversation not found.');
      if (chat?.executionId) [row] = await this.db.select({ id: agentExecutions.id }).from(agentExecutions).where(and(eq(agentExecutions.id, chat.executionId), eq(agentExecutions.workspaceId, workspace.id), eq(agentExecutions.agentId, CHAT_AGENT_ID))).limit(1);
    }
    if (row && !chat) {
      const [submission] = await this.db.select({ chatId: chatSubmissions.chatId }).from(chatSubmissions)
        .where(and(eq(chatSubmissions.executionId, row.id), sql`${chatSubmissions.chatId} is not null`)).orderBy(desc(chatSubmissions.createdAt)).limit(1);
      if (submission?.chatId) [chat] = await this.db.select().from(externalChats).where(and(eq(externalChats.id, submission.chatId), eq(externalChats.workspaceId, workspace.id))).limit(1);
    }
    const execution = row ? await this.executions.get(request, 'personal', CHAT_AGENT_ID, row.id) : null;
    // The conversation read model retains streamed text that an interrupted turn never committed
    // to displayMessages. It does not alter model context or scheduler state, and only an
    // interrupted turn can hold such deltas, so settled and live turns skip the event scan.
    if (execution && (execution.status === 'failed' || execution.status === 'cancelled')) {
      const savedIds = new Set(execution.messages.map((message) => message.id));
      const partial = new Map<string, typeof execution.messages[number]>();
      const deltas = await this.db.select().from(agentExecutionEvents).where(and(eq(agentExecutionEvents.executionId, execution.id), sql`json_extract(${agentExecutionEvents.data}, '$.kind') = 'message_delta'`)).orderBy(agentExecutionEvents.sequence);
      for (const event of deltas) {
        const data = event.data as AgentExecutionEventData;
        if (data.kind !== 'message_delta' || savedIds.has(data.messageId)) continue;
        const message = partial.get(data.messageId) ?? { id: data.messageId, role: 'assistant' as const, content: '', createdAt: event.createdAt.toISOString() };
        message.content += data.delta;
        if (data.progressReport) message.progressReport = data.progressReport;
        partial.set(message.id, message);
      }
      execution.messages = [...execution.messages, ...partial.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }
    const events = chat ? channelEvents(chat.channel) : null;
    // Feishu outbound delivery rows never carry a top-level text (card and file deliveries
    // record operation, card and platform fields), so they can never become pending
    // receipts; skipping them by id keeps this read off the delivery history, which can
    // hold hundreds of thousands of rows for one chat. WeChat outbound rows do carry text
    // and stay included as before.
    const receipts = chat && events ? await this.db.select().from(events).where(and(eq(events.chatId, chat.id),
      chat.channel === 'feishu' ? notOutboundEvent(events) : undefined,
      or(eq(events.status, 'queued'), eq(events.status, 'failed')))).orderBy(events.createdAt) : [];
    const pendingReceipts = receipts.filter((receipt) => typeof receipt.payload.text === 'string' && !receipt.payload.action)
      .map((receipt) => ({ id: receipt.id, text: receipt.payload.text as string, status: receipt.status as 'queued' | 'failed', error: receipt.error, createdAt: receipt.createdAt.toISOString() }));
    const conversation: ChatConversationSummary = {
      id, executionId: execution?.id ?? null,
      title: execution?.messages.find((message) => message.role === 'user')?.content ?? standalone?.message ?? pendingReceipts[0]?.text ?? '',
      channel: chat ? chat.channel : 'web', channelConversationId: chat?.id ?? null,
      status: execution?.conversationStatus ?? execution?.status ?? (standalone ? standalone.error ? 'failed' : 'task' : pendingReceipts.some((receipt) => receipt.status === 'failed') ? 'failed' : 'queued'),
      createdAt: execution?.createdAt ?? (standalone?.createdAt ?? chat!.updatedAt).toISOString(), updatedAt: execution?.updatedAt ?? (standalone?.updatedAt ?? chat!.updatedAt).toISOString(),
    };
    const submissions = await this.db.select().from(chatSubmissions).where(and(eq(chatSubmissions.workspaceId, workspace.id),
      standalone ? eq(chatSubmissions.id, standalone.id) : or(execution ? eq(chatSubmissions.executionId, execution.id) : undefined, chat ? eq(chatSubmissions.chatId, chat.id) : undefined),
    )).orderBy(chatSubmissions.createdAt);
    const ingressIds = new Set(chat && events ? (await this.db.select({ id: events.id }).from(events).where(and(eq(events.chatId, chat.id), notOutboundEvent(events), sql`json_extract(${events.payload}, '$.direction') is null`))).map((event) => event.id) : []);
    let channelDelivery: ChatConversationView['channelDelivery'] = 'web';
    if (chat?.channel === 'feishu') {
      const [binding] = await this.db.select({ userId: chatChannels.feishuAllowedUserId, enabled: chatChannels.feishuEnabled, status: chatChannels.feishuStatus }).from(chatChannels).where(and(eq(chatChannels.workspaceId, workspace.id), eq(chatChannels.id, 'feishu'))).limit(1);
      channelDelivery = binding?.userId !== chat.userId ? 'unbound' : binding.enabled && binding.status === 'connected' ? 'connected' : 'disconnected';
    } else if (chat?.channel === 'wechat') {
      const [binding] = await this.db.select({ userId: chatChannels.wechatAllowedUserId, enabled: chatChannels.wechatEnabled, status: chatChannels.wechatStatus }).from(chatChannels).where(and(eq(chatChannels.workspaceId, workspace.id), eq(chatChannels.id, 'wechat'))).limit(1);
      channelDelivery = binding?.userId !== chat.userId ? 'unbound' : binding.enabled && binding.status === 'connected' ? 'connected' : 'disconnected';
    }
    return { conversation, execution, pendingReceipts, submissions: submissions.map((submission) => toSubmission(submission,
      ingressIds.has(submission.id) ? chat?.channel ?? 'web' : submission.id.startsWith('web_') || submission.reference?.kind === 'conversation' || !submission.executionId ? 'web' : 'agent',
    )), channelDelivery };
  }

  async records(request: Request, id: string): Promise<ChatConversationRecords> {
    const { conversation, execution, submissions } = await this.get(request, id);
    const chatId = conversation.channelConversationId;
    const events = chatId && conversation.channel !== 'web' ? channelEvents(conversation.channel) : null;
    // A channel chat accumulates one row per delivery attempt, so the records keep the
    // newest RECORD_RECEIPT_LIMIT rows (oldest first) and report the full count.
    const latestReceipts = chatId && events ? await this.db.select().from(events).where(eq(events.chatId, chatId)).orderBy(desc(events.createdAt), desc(events.id)).limit(RECORD_RECEIPT_LIMIT) : [];
    const receipts = latestReceipts.reverse();
    const receiptsTotal = chatId && events && receipts.length >= RECORD_RECEIPT_LIMIT
      ? Number((await this.db.select({ count: sql<number>`count(*)` }).from(events).where(eq(events.chatId, chatId)))[0]?.count ?? receipts.length)
      : receipts.length;
    const deliveries = chatId && conversation.channel === 'feishu' ? await this.db.select().from(feishuDeliveries).where(eq(feishuDeliveries.chatId, chatId)) : [];
    return {
      conversation,
      execution,
      events: conversation.executionId ? await this.executions.recordsEvents(request, 'personal', CHAT_AGENT_ID, conversation.executionId) : [],
      receipts: receipts.map(({ id, payload, status, error, createdAt }) => ({ id, payload, status, error, createdAt: createdAt.toISOString() })),
      receiptsTotal,
      submissions,
      deliveries: deliveries.map(({ id, messageId }) => ({ id, messageId })),
    };
  }

  // Summarizing compresses the conversation in place: the generated summary becomes the
  // execution's whole stored model context, and a persisted divider marks the compression
  // point in the visible history, preceded by a user echo of the /summarize command so the
  // trigger stays visible. Earlier display messages stay readable but no longer
  // reach the model; a later summarize builds on the retained summary after the last divider.
  async summarize(request: Request, id: string): Promise<AgentExecutionView> {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    const [execution] = await this.db.select().from(agentExecutions).where(and(eq(agentExecutions.id, id), eq(agentExecutions.workspaceId, workspace.id), eq(agentExecutions.agentId, CHAT_AGENT_ID))).limit(1);
    if (!execution) throw new NotFoundException('Chat conversation not found.');
    if (execution.status === 'running' || execution.status === 'waiting_for_input') throw new ConflictException('Wait for the current turn to finish before summarizing.');
    const [unresolvedToolCall] = await this.db.select({ id: agentToolCalls.id }).from(agentToolCalls).where(and(eq(agentToolCalls.executionId, execution.id), eq(agentToolCalls.resultAppended, false))).limit(1);
    if (unresolvedToolCall) throw new ConflictException('请先重试本轮对话，处理尚未结束的工具调用；外部效果不会自动重跑。');
    const dividerIndex = execution.displayMessages.reduce((latest, message, index) => message.kind === 'summary_divider' ? index : latest, -1);
    const transcriptParts: string[] = [];
    if (dividerIndex >= 0) transcriptParts.push(`Earlier summary:\n${execution.displayMessages[dividerIndex].content}`);
    for (const message of execution.displayMessages.slice(dividerIndex + 1)) {
      if (message.kind === 'summary_divider') continue;
      transcriptParts.push(`${message.role === 'user' ? 'User' : 'Assistant'}:\n${message.content}`);
    }
    const transcript = transcriptParts.join('\n\n').trim();
    if (!transcript) throw new BadRequestException('This conversation has no messages to summarize.');
    const [agent] = await this.db.select().from(agents).where(and(eq(agents.id, CHAT_AGENT_ID), eq(agents.workspaceId, workspace.id))).limit(1);
    if (!agent?.providerId || !agent.model) throw new ConflictException('Configure a model provider and model before running this Agent.');
    const [configuration] = await this.db.select({ summarizePrompt: chatConfigurations.summarizePrompt }).from(chatConfigurations).where(eq(chatConfigurations.workspaceId, workspace.id)).orderBy(desc(chatConfigurations.revision)).limit(1);
    const runtime = await this.resources.providerRuntime(request, 'personal', agent.providerId, agent.model);
    const { text } = await createModelGateway().streamText({
      candidates: [{ provider: runtime.provider, model: runtime.model }],
      systemPrompt: configuration?.summarizePrompt.trim() || DEFAULT_SUMMARIZE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: transcript }],
      // Summarizing a conversation is work that conversation caused, so it is charged there.
      correlation: { surface: 'chat', conversationId: execution.id },
    }).result;
    const summary = text.trim();
    // The slash command is intercepted by the composer and never becomes a visible message,
    // so the server records it as an ordinary user display message just before the divider:
    // the history then reads "user: /summarize → divider" while the model context stays untouched.
    const commandEcho: StoredAgentDisplayMessage = { id: `msg_${randomUUID()}`, role: 'user', content: '/summarize', createdAt: new Date().toISOString() };
    const divider: StoredAgentDisplayMessage = { id: `msg_${randomUUID()}`, role: 'assistant', content: summary, createdAt: new Date().toISOString(), kind: 'summary_divider' };
    const modelMessages: StoredAgentModelMessage[] = [{ role: 'user', content: `Summary of the conversation so far, as the starting context for the rest of this conversation:\n\n${summary}` }];
    const updated = await this.db.update(agentExecutions).set({ modelMessages, displayMessages: [...execution.displayMessages, commandEcho, divider], updatedAt: new Date() })
      .where(and(eq(agentExecutions.id, execution.id), inArray(agentExecutions.status, ['completed', 'failed', 'cancelled'])));
    if (updated.changes === 0) throw new ConflictException('This conversation changed while it was being summarized. Try again.');
    await this.executions.publishSnapshotForExecution(workspace.id, execution.id);
    return this.executions.get(request, 'personal', CHAT_AGENT_ID, execution.id);
  }
}

function toSubmission({ id, executionId, message, reference, outputMessageId, renderedCard, renderedTaskCards, settled, error, createdAt, updatedAt }: typeof chatSubmissions.$inferSelect, origin: string): ChatSubmissionView {
  return { id, origin, executionId, message, reference, outputMessageId, renderedCard, renderedTaskCards, settled, error, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() };
}

// Feishu and WeChat keep structurally identical per-channel receipt tables; the channel column
// on the external chat selects which one a read model queries.
function channelEvents(channel: string) {
  return (channel === 'wechat' ? wechatEvents : feishuEvents) as typeof feishuEvents;
}

/**
 * Excludes outbound delivery rows by their id prefix. recordDelivery is the only writer of
 * `outbound:` ids and always stores direction 'outbound', so this never removes a row that a
 * `direction is null` filter would keep; it lets SQLite skip those rows through the
 * (chat_id, id) index instead of parsing every delivery payload.
 */
function notOutboundEvent(events: typeof feishuEvents): SQL {
  return or(lt(events.id, 'outbound:'), gte(events.id, 'outbound;'))!;
}

const CONVERSATION_PAGE_SIZE = 50;
const RECORD_RECEIPT_LIMIT = 500;

/**
 * Reads the rows of one conversation-list source that can appear on the requested page.
 *
 * The page order compares updatedAt first and then ids with localeCompare, which SQL
 * cannot reproduce, so ids are never compared in SQL. With a cursor, every row sharing the
 * cursor's updatedAt is read and the caller's filter decides among them; below it, one
 * page plus one row is read, and when that cut falls inside a group of equal updatedAt
 * values the whole group is read as well. `bounded` false reads every row at or below the
 * cursor, for sources whose remaining filter runs in JS.
 */
async function pageWindow<T extends { id: string; updatedAt: Date }>(
  window: { ms: number; id: string } | null,
  column: SQLiteColumn,
  bounded: boolean,
  read: (bound: SQL | undefined, limit: number | undefined) => PromiseLike<T[]>,
): Promise<T[]> {
  const at = window ? new Date(window.ms) : null;
  if (!bounded) return read(at ? lte(column, at) : undefined, undefined);
  const rows = [...(at ? await read(eq(column, at), undefined) : [])];
  const below = await read(at ? lt(column, at) : undefined, CONVERSATION_PAGE_SIZE + 1);
  rows.push(...below);
  if (below.length > CONVERSATION_PAGE_SIZE) rows.push(...await read(eq(column, below.at(-1)!.updatedAt), undefined));
  const seen = new Set<string>();
  return rows.filter((row) => !seen.has(row.id) && Boolean(seen.add(row.id)));
}
