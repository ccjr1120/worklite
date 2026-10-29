import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { CHAT_AGENT_ID, type AgentExecutionEventData, type AgentExecutionView, type ChatChannelView, type ChatConversationList, type ChatConversationRecords, type ChatConversationSummary, type ChatConversationView, type ChatSubmissionView } from '@worklite/contracts';
import { agentExecutionEvents, agentExecutions, executorRuns, agentToolCalls, agents, chatConfigurations, chatProjectTasks, chatSubmissions, externalChats, feishuDeliveries, feishuEvents, plugins, wechatEvents, workflowRuns, type Database, type StoredAgentDisplayMessage, type StoredAgentModelMessage } from '@worklite/db';
import { createModelGateway } from '@worklite/model-gateway';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { AgentExecutionsService } from './agent-executions.service';

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
      { id: 'feishu', name: '飞书', builtIn: false, presentation: ['cards', 'forms', 'QR images', 'files'] },
      { id: 'wechat', name: '微信', builtIn: false, presentation: ['text messages', 'QR images'] },
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
    const boundChatIds = [...new Set(rows.map((row) => row.chatId).filter((id): id is string => Boolean(id)))];
    const boundChats = boundChatIds.length ? await this.db.select({ id: externalChats.id, channel: externalChats.channel }).from(externalChats).where(inArray(externalChats.id, boundChatIds)) : [];
    const channelByChat = new Map(boundChats.map((chat) => [chat.id, chat.channel]));
    const items: ChatConversationSummary[] = rows.map((row) => ({
      id: row.id, executionId: row.id, title: row.title, channel: row.chatId ? channelByChat.get(row.chatId) ?? 'feishu' : 'web',
      channelConversationId: row.chatId, status: row.status,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    }));
    // A conversation with active background work (a project task, or a dispatched executor
    // Run / Workflow Run that has not settled) reads as in progress even though its turn settled.
    const activeBackground = await this.activeBackgroundExecutionIds(workspace.id);
    for (const item of items) {
      if (item.executionId && activeBackground.has(item.executionId) && item.status !== 'running' && item.status !== 'waiting_for_input') item.status = 'running';
    }
    const tasks = await this.db.select().from(chatSubmissions).where(and(eq(chatSubmissions.workspaceId, workspace.id), isNull(chatSubmissions.executionId), isNull(chatSubmissions.chatId), sql`${chatSubmissions.reference} is not null`));
    for (const task of tasks) {
      if (query.search?.trim() && !task.message.toLowerCase().includes(query.search.trim().toLowerCase())) continue;
      items.push({ id: task.id, executionId: null, title: task.message, channel: 'web', channelConversationId: null,
        status: task.error ? 'failed' : 'task', createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString() });
    }
    const waiting = await this.db.select().from(externalChats).where(and(eq(externalChats.workspaceId, workspace.id), isNull(externalChats.executionId)));
    for (const chat of waiting) {
      const events = channelEvents(chat.channel);
      const [receipt] = await this.db.select().from(events).where(and(eq(events.chatId, chat.id), sql`json_extract(${events.payload}, '$.direction') is null`)).orderBy(desc(events.createdAt)).limit(1);
      const title = typeof receipt?.payload.text === 'string' ? receipt.payload.text : '';
      if (query.search?.trim() && !title.toLowerCase().includes(query.search.trim().toLowerCase())) continue;
      items.push({ id: chat.id, executionId: null, title, channel: chat.channel, channelConversationId: chat.id,
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
    const receipts = chat && events ? await this.db.select().from(events).where(and(eq(events.chatId, chat.id), or(eq(events.status, 'queued'), eq(events.status, 'failed')))).orderBy(events.createdAt) : [];
    const pendingReceipts = receipts.filter((receipt) => typeof receipt.payload.text === 'string' && !receipt.payload.action)
      .map((receipt) => ({ id: receipt.id, text: receipt.payload.text as string, status: receipt.status as 'queued' | 'failed', error: receipt.error, createdAt: receipt.createdAt.toISOString() }));
    const conversation: ChatConversationSummary = {
      id, executionId: execution?.id ?? null,
      title: execution?.messages.find((message) => message.role === 'user')?.content ?? standalone?.message ?? pendingReceipts[0]?.text ?? '',
      channel: chat ? chat.channel : 'web', channelConversationId: chat?.id ?? null,
      status: execution?.status ?? (standalone ? standalone.error ? 'failed' : 'task' : pendingReceipts.some((receipt) => receipt.status === 'failed') ? 'failed' : 'queued'),
      createdAt: execution?.createdAt ?? (standalone?.createdAt ?? chat!.updatedAt).toISOString(), updatedAt: execution?.updatedAt ?? (standalone?.updatedAt ?? chat!.updatedAt).toISOString(),
    };
    if (execution && conversation.status !== 'running' && conversation.status !== 'waiting_for_input'
      && (await this.activeBackgroundExecutionIds(workspace.id)).has(execution.id)) conversation.status = 'running';
    const submissions = await this.db.select().from(chatSubmissions).where(and(eq(chatSubmissions.workspaceId, workspace.id),
      standalone ? eq(chatSubmissions.id, standalone.id) : or(execution ? eq(chatSubmissions.executionId, execution.id) : undefined, chat ? eq(chatSubmissions.chatId, chat.id) : undefined),
    )).orderBy(chatSubmissions.createdAt);
    const ingressIds = new Set(chat && events ? (await this.db.select({ id: events.id }).from(events).where(and(eq(events.chatId, chat.id), sql`json_extract(${events.payload}, '$.direction') is null`))).map((event) => event.id) : []);
    let channelDelivery: ChatConversationView['channelDelivery'] = 'web';
    if (chat?.channel === 'feishu') {
      const [binding] = await this.db.select({ userId: plugins.feishuAllowedUserId, enabled: plugins.feishuEnabled, status: plugins.feishuStatus }).from(plugins).where(and(eq(plugins.workspaceId, workspace.id), eq(plugins.id, 'feishu-bot'))).limit(1);
      channelDelivery = binding?.userId !== chat.userId ? 'unbound' : binding.enabled && binding.status === 'connected' ? 'connected' : 'disconnected';
    } else if (chat?.channel === 'wechat') {
      const [binding] = await this.db.select({ userId: plugins.wechatAllowedUserId, enabled: plugins.wechatEnabled, status: plugins.wechatStatus }).from(plugins).where(and(eq(plugins.workspaceId, workspace.id), eq(plugins.id, 'wechat-bot'))).limit(1);
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
    const receipts = chatId && events ? await this.db.select().from(events).where(eq(events.chatId, chatId)).orderBy(events.createdAt) : [];
    const deliveries = chatId && conversation.channel === 'feishu' ? await this.db.select().from(feishuDeliveries).where(eq(feishuDeliveries.chatId, chatId)) : [];
    return {
      conversation,
      execution,
      events: conversation.executionId ? await this.executions.recordsEvents(request, 'personal', CHAT_AGENT_ID, conversation.executionId) : [],
      receipts: receipts.map(({ id, payload, status, error, createdAt }) => ({ id, payload, status, error, createdAt: createdAt.toISOString() })),
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

  // Execution ids whose conversation owns background work that is still active: a running
  // or waiting project task, or a dispatched executor Run / Workflow Run that has not settled.
  private async activeBackgroundExecutionIds(workspaceId: string): Promise<Set<string>> {
    const tasks = await this.db.select({ executionId: chatProjectTasks.executionId }).from(chatProjectTasks)
      .where(and(eq(chatProjectTasks.workspaceId, workspaceId), inArray(chatProjectTasks.status, ['running', 'waiting_for_input'])));
    const teamRuns = await this.db.select({ executionId: chatSubmissions.executionId }).from(chatSubmissions)
      .innerJoin(executorRuns, sql`${executorRuns.id} = json_extract(${chatSubmissions.reference}, '$.runId')`)
      .where(and(eq(chatSubmissions.workspaceId, workspaceId), isNotNull(chatSubmissions.executionId),
        notInArray(executorRuns.status, ['succeeded', 'failed', 'cancelled'])));
    const workflows = await this.db.select({ executionId: chatSubmissions.executionId }).from(chatSubmissions)
      .innerJoin(workflowRuns, sql`${workflowRuns.id} = json_extract(${chatSubmissions.reference}, '$.runId')`)
      .where(and(eq(chatSubmissions.workspaceId, workspaceId), isNotNull(chatSubmissions.executionId),
        notInArray(workflowRuns.status, ['succeeded', 'failed', 'cancelled', 'timed_out'])));
    return new Set([...tasks, ...teamRuns, ...workflows].map((row) => row.executionId).filter((id): id is string => typeof id === 'string'));
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
