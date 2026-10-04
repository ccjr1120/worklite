import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { CHAT_AGENT_ID, type AgentExecutionEventData, type ChatChannelView, type ChatConversationList, type ChatConversationRecords, type ChatConversationSummary, type ChatConversationView, type ChatSubmissionView } from '@worklite/contracts';
import { agentExecutionEvents, agentExecutions, chatSubmissions, feishuChats, feishuDeliveries, feishuEvents, plugins, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { AgentExecutionsService } from './agent-executions.service';

@Injectable()
export class ChatConversationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly executions: AgentExecutionsService,
  ) {}

  channels(): ChatChannelView[] {
    return [
      { id: 'web', name: 'Web', builtIn: true, presentation: ['streaming', 'markdown', 'questions', 'execution records'] },
      { id: 'feishu', name: '飞书', builtIn: false, presentation: ['cards', 'forms', 'QR images', 'files'] },
    ];
  }

  async list(request: Request, query: { cursor?: string; search?: string; channel?: string }): Promise<ChatConversationList> {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    const rows = await this.db.select({
      id: agentExecutions.id,
      status: agentExecutions.status,
      title: sql<string>`coalesce(json_extract(${agentExecutions.displayMessages}, '$[0].content'), '')`,
      createdAt: agentExecutions.createdAt,
      updatedAt: agentExecutions.updatedAt,
      chatId: sql<string | null>`(select chat_id from chat_submissions where execution_id = ${agentExecutions.id} and chat_id is not null order by created_at desc limit 1)`,
    }).from(agentExecutions).where(and(eq(agentExecutions.workspaceId, workspace.id), eq(agentExecutions.agentId, CHAT_AGENT_ID),
      query.search?.trim() ? sql`${agentExecutions.displayMessages} like ${`%${query.search.trim()}%`}` : undefined));
    const items: ChatConversationSummary[] = rows.map((row) => ({
      id: row.id, executionId: row.id, title: row.title, channel: row.chatId ? 'feishu' : 'web',
      channelConversationId: row.chatId, status: row.status,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    }));
    const tasks = await this.db.select().from(chatSubmissions).where(and(eq(chatSubmissions.workspaceId, workspace.id), isNull(chatSubmissions.executionId), isNull(chatSubmissions.chatId), sql`${chatSubmissions.reference} is not null`));
    for (const task of tasks) {
      if (query.search?.trim() && !task.message.toLowerCase().includes(query.search.trim().toLowerCase())) continue;
      items.push({ id: task.id, executionId: null, title: task.message, channel: 'web', channelConversationId: null,
        status: task.error ? 'failed' : 'task', createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString() });
    }
    const waiting = await this.db.select().from(feishuChats).where(and(eq(feishuChats.workspaceId, workspace.id), isNull(feishuChats.executionId)));
    for (const chat of waiting) {
      const [receipt] = await this.db.select().from(feishuEvents).where(and(eq(feishuEvents.chatId, chat.id), sql`json_extract(${feishuEvents.payload}, '$.direction') is null`)).orderBy(desc(feishuEvents.createdAt)).limit(1);
      const title = typeof receipt?.payload.text === 'string' ? receipt.payload.text : '';
      if (query.search?.trim() && !title.toLowerCase().includes(query.search.trim().toLowerCase())) continue;
      items.push({ id: chat.id, executionId: null, title, channel: 'feishu', channelConversationId: chat.id,
        status: receipt?.status === 'failed' ? 'failed' : 'queued', createdAt: (receipt?.createdAt ?? chat.updatedAt).toISOString(), updatedAt: chat.updatedAt.toISOString() });
    }
    let boundary: { updatedAt: string; id: string } | null = null;
    if (query.cursor) {
      try { boundary = JSON.parse(Buffer.from(query.cursor, 'base64url').toString()) as { updatedAt: string; id: string }; }
      catch { throw new BadRequestException('Invalid conversation cursor.'); }
      if (!boundary || typeof boundary.updatedAt !== 'string' || typeof boundary.id !== 'string') throw new BadRequestException('Invalid conversation cursor.');
    }
    const filtered = items.filter((item) => (!query.channel || item.channel === query.channel) && (!boundary ||
      item.updatedAt < boundary.updatedAt || item.updatedAt === boundary.updatedAt && item.id.localeCompare(boundary.id) < 0))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
    const page = filtered.slice(0, 50);
    const last = page.at(-1);
    return { items: page, nextCursor: filtered.length > page.length && last ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, id: last.id })).toString('base64url') : null };
  }

  async get(request: Request, id: string): Promise<ChatConversationView> {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    let [row] = await this.db.select().from(agentExecutions).where(and(eq(agentExecutions.id, id), eq(agentExecutions.workspaceId, workspace.id), eq(agentExecutions.agentId, CHAT_AGENT_ID))).limit(1);
    let chat: typeof feishuChats.$inferSelect | undefined;
    let standalone: typeof chatSubmissions.$inferSelect | undefined;
    if (!row) {
      [chat] = await this.db.select().from(feishuChats).where(and(eq(feishuChats.id, id), eq(feishuChats.workspaceId, workspace.id))).limit(1);
      if (!chat) [standalone] = await this.db.select().from(chatSubmissions).where(and(eq(chatSubmissions.id, id), eq(chatSubmissions.workspaceId, workspace.id), isNull(chatSubmissions.executionId), isNull(chatSubmissions.chatId))).limit(1);
      if (!chat && !standalone) throw new NotFoundException('Chat conversation not found.');
      if (chat?.executionId) [row] = await this.db.select().from(agentExecutions).where(and(eq(agentExecutions.id, chat.executionId), eq(agentExecutions.workspaceId, workspace.id), eq(agentExecutions.agentId, CHAT_AGENT_ID))).limit(1);
    }
    if (row && !chat) {
      const [submission] = await this.db.select({ chatId: chatSubmissions.chatId }).from(chatSubmissions)
        .where(and(eq(chatSubmissions.executionId, row.id), sql`${chatSubmissions.chatId} is not null`)).orderBy(desc(chatSubmissions.createdAt)).limit(1);
      if (submission?.chatId) [chat] = await this.db.select().from(feishuChats).where(and(eq(feishuChats.id, submission.chatId), eq(feishuChats.workspaceId, workspace.id))).limit(1);
    }
    const execution = row ? await this.executions.get(request, 'personal', CHAT_AGENT_ID, row.id) : null;
    if (execution) {
      // The conversation read model retains streamed text that a failed turn never committed
      // to displayMessages. It does not alter model context or scheduler state.
      const savedIds = new Set(execution.messages.map((message) => message.id));
      const partial = new Map<string, typeof execution.messages[number]>();
      const deltas = await this.db.select().from(agentExecutionEvents).where(and(eq(agentExecutionEvents.executionId, execution.id), sql`json_extract(${agentExecutionEvents.data}, '$.kind') = 'message_delta'`)).orderBy(agentExecutionEvents.sequence);
      for (const event of deltas) {
        const data = event.data as AgentExecutionEventData;
        if (data.kind !== 'message_delta' || savedIds.has(data.messageId)) continue;
        const message = partial.get(data.messageId) ?? { id: data.messageId, role: 'assistant' as const, content: '', createdAt: event.createdAt.toISOString() };
        message.content += data.delta;
        partial.set(message.id, message);
      }
      execution.messages = [...execution.messages, ...partial.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }
    const receipts = chat ? await this.db.select().from(feishuEvents).where(and(eq(feishuEvents.chatId, chat.id), or(eq(feishuEvents.status, 'queued'), eq(feishuEvents.status, 'failed')))).orderBy(feishuEvents.createdAt) : [];
    const pendingReceipts = receipts.filter((receipt) => typeof receipt.payload.text === 'string' && !receipt.payload.action)
      .map((receipt) => ({ id: receipt.id, text: receipt.payload.text as string, status: receipt.status as 'queued' | 'failed', error: receipt.error, createdAt: receipt.createdAt.toISOString() }));
    const conversation: ChatConversationSummary = {
      id, executionId: execution?.id ?? null,
      title: execution?.messages.find((message) => message.role === 'user')?.content ?? standalone?.message ?? pendingReceipts[0]?.text ?? '',
      channel: chat ? 'feishu' : 'web', channelConversationId: chat?.id ?? null,
      status: execution?.status ?? (standalone ? standalone.error ? 'failed' : 'task' : pendingReceipts.some((receipt) => receipt.status === 'failed') ? 'failed' : 'queued'),
      createdAt: execution?.createdAt ?? (standalone?.createdAt ?? chat!.updatedAt).toISOString(), updatedAt: execution?.updatedAt ?? (standalone?.updatedAt ?? chat!.updatedAt).toISOString(),
    };
    const submissions = await this.db.select().from(chatSubmissions).where(and(eq(chatSubmissions.workspaceId, workspace.id),
      standalone ? eq(chatSubmissions.id, standalone.id) : or(execution ? eq(chatSubmissions.executionId, execution.id) : undefined, chat ? eq(chatSubmissions.chatId, chat.id) : undefined),
    )).orderBy(chatSubmissions.createdAt);
    const ingressIds = new Set(chat ? (await this.db.select({ id: feishuEvents.id }).from(feishuEvents).where(and(eq(feishuEvents.chatId, chat.id), sql`json_extract(${feishuEvents.payload}, '$.direction') is null`))).map((event) => event.id) : []);
    let channelDelivery: ChatConversationView['channelDelivery'] = 'web';
    if (chat) {
      const [binding] = await this.db.select({ userId: plugins.feishuAllowedUserId, enabled: plugins.feishuEnabled, status: plugins.feishuStatus }).from(plugins).where(and(eq(plugins.workspaceId, workspace.id), eq(plugins.id, 'feishu-bot'))).limit(1);
      channelDelivery = binding?.userId !== chat.userId ? 'unbound' : binding.enabled && binding.status === 'connected' ? 'connected' : 'disconnected';
    }
    return { conversation, execution, pendingReceipts, submissions: submissions.map((submission) => toSubmission(submission,
      ingressIds.has(submission.id) ? 'feishu' : submission.id.startsWith('web_') || submission.reference?.kind === 'conversation' || !submission.executionId ? 'web' : 'agent',
    )), channelDelivery };
  }

  async records(request: Request, id: string): Promise<ChatConversationRecords> {
    const { conversation, execution, submissions } = await this.get(request, id);
    const chatId = conversation.channelConversationId;
    const receipts = chatId ? await this.db.select().from(feishuEvents).where(eq(feishuEvents.chatId, chatId)).orderBy(feishuEvents.createdAt) : [];
    const deliveries = chatId ? await this.db.select().from(feishuDeliveries).where(eq(feishuDeliveries.chatId, chatId)) : [];
    return {
      conversation,
      execution,
      events: conversation.executionId ? await this.executions.events(request, 'personal', CHAT_AGENT_ID, conversation.executionId) : [],
      receipts: receipts.map(({ id, payload, status, error, createdAt }) => ({ id, payload, status, error, createdAt: createdAt.toISOString() })),
      submissions,
      deliveries: deliveries.map(({ id, messageId }) => ({ id, messageId })),
    };
  }
}

function toSubmission({ id, executionId, message, reference, outputMessageId, renderedCard, settled, error, createdAt, updatedAt }: typeof chatSubmissions.$inferSelect, origin: string): ChatSubmissionView {
  return { id, origin, executionId, message, reference, outputMessageId, renderedCard, settled, error, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() };
}
