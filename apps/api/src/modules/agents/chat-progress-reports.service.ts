import { displayMessagesColumn, projectTaskColumns, agentExecutions, auditLogs, coderRuns, chatProjectTasks, chatSubmissions, workflowRuns, workflowVersions, workflows, type Database } from '@worklite/db';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import type { AgentTeamRunProgress } from '@worklite/contracts';
import { DATABASE } from '../../infrastructure/database.module';
import { AgentTeamRuntimeService } from '../coders/coder-runtime.service';
import { AgentExecutionsService } from './agent-executions.service';
import { deriveTaskStage } from './chat-project-tasks.service';

export const DEFAULT_PROGRESS_NOTE_INTERVAL_SECONDS = 300;
const ACTIVE_CODER_RUN_STATUSES = ['queued', 'running'] as const;
const ACTIVE_WORKFLOW_RUN_STATUSES = ['queued', 'running', 'paused'] as const;
const TITLE_LIMIT = 80;
const PROGRESS_TEXT_LIMIT = 160;

export type ActiveWorkItem =
  | { kind: 'agent'; id: string; agentId: string; runId: string; agentName: string; task?: string; status: string; details: string; updatedAt?: string }
  | { kind: 'task'; id: string; goal: string; stage: string; activityCount: number; progressText: string; updatedAt?: string }
  | { kind: 'coder'; id: string; intent: string; status: string; progress: AgentTeamRunProgress | null; details?: string; updatedAt?: string }
  | { kind: 'workflow'; id: string; workflowName: string; status: string; currentNodeId: string | null; currentStep?: string; updatedAt?: string };

type ConversationTarget = { executionId: string; workspaceId: string };

const truncate = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit)}…` : value;

// The visible-change signature: a tick whose summary matches the last reported one is skipped,
// so a quiet interval never produces a duplicate report while genuinely new progress does.
export function activeWorkSignature(items: ActiveWorkItem[]): string {
  return JSON.stringify(items.map((item) => item.kind === 'agent' ? [item.kind, item.id, item.task, item.status, item.details] : item.kind === 'task'
    ? [item.kind, item.id, item.stage, item.activityCount, item.progressText]
    : item.kind === 'coder'
      ? [item.kind, item.id, item.status, item.progress, item.details]
      : [item.kind, item.id, item.status, item.currentNodeId]));
}

const formatInterval = (seconds: number) => seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;

export function buildActiveWorkNote(items: ActiveWorkItem[], intervalSeconds = DEFAULT_PROGRESS_NOTE_INTERVAL_SECONDS): string {
  const lines = items.map((item, index) => {
    if (item.kind === 'agent') return `${index + 1}. Agent ${item.agentName}：${item.status}，最新进展：${item.details}`;
    if (item.kind === 'task') {
      const progress = item.progressText ? `，最新进展：${truncate(item.progressText, PROGRESS_TEXT_LIMIT)}` : '';
      return `${index + 1}. 项目任务 ${item.id}（${truncate(item.goal, TITLE_LIMIT)}）：运行中，阶段 ${item.stage}${progress}`;
    }
    if (item.kind === 'coder') {
      return `${index + 1}. Coder 任务 ${item.id}（${truncate(item.intent, TITLE_LIMIT)}）：${item.status}${item.details ? `，最新进展：${item.details}` : ''}`;
    }
    return `${index + 1}. 工作流运行 ${item.id}（${item.workflowName}）：${item.status}${item.currentStep ? `，当前步骤 ${item.currentStep}` : ''}`;
  });
  return `[活跃工作进展提醒] 当前对话仍有进行中的工作（约每 ${formatInterval(intervalSeconds)}提醒一次，工作全部结束或无新进展时自动停止）：\n${lines.join('\n')}\n请按任务逐项分别汇报，只使用各任务自己的信息；不要合并任务或推测进展；不要向用户复述本提醒本身；直接回复，不要调用工具。`;
}

// Periodic progress reports for conversations with active background work: a running project
// task, or a queued/running Coder Run or queued/running/paused Workflow Run dispatched from that conversation.
// waiting_for_input work is excluded — its question already reached the user through the
// settlement report. The recurring tick replaces the one-shot settlement reports' deferral:
// a busy conversation simply retries on the next tick, and a conversation whose summary is
// unchanged since its last report is skipped.
@Injectable()
export class ChatProgressReportsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatProgressReportsService.name);
  private readonly lastSignatures = new Map<string, Map<string, string>>();
  private timer: NodeJS.Timeout | null = null;
  readonly intervalSeconds: number;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Optional() @Inject(AgentTeamRuntimeService) private readonly runtime: AgentTeamRuntimeService | undefined,
    private readonly executions: AgentExecutionsService,
    private readonly config: ConfigService,
  ) {
    const configured = this.config.get<string>('CHAT_PROGRESS_NOTE_INTERVAL_SECONDS');
    const seconds = configured === undefined || configured === '' ? DEFAULT_PROGRESS_NOTE_INTERVAL_SECONDS : Number(configured);
    if (!Number.isFinite(seconds) || seconds <= 0) this.logger.warn(`CHAT_PROGRESS_NOTE_INTERVAL_SECONDS=${configured} is not a positive number; using ${DEFAULT_PROGRESS_NOTE_INTERVAL_SECONDS} seconds.`);
    this.intervalSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_PROGRESS_NOTE_INTERVAL_SECONDS;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick()
        .catch((error) => this.logger.warn(`Chat progress report tick failed: ${error instanceof Error ? error.message : String(error)}`));
    }, this.intervalSeconds * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const targets = await this.conversationsWithActiveWork();
    // Drop signatures of conversations without active work so a restarted task reports again
    // and the map stays bounded.
    const active = new Set(targets.map((target) => target.executionId));
    for (const executionId of [...this.lastSignatures.keys()]) {
      if (!active.has(executionId)) this.lastSignatures.delete(executionId);
    }
    for (const target of targets) {
      await this.tickConversation(target)
        .catch((error) => this.logger.warn(`Chat progress report for ${target.executionId} failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private async conversationsWithActiveWork(): Promise<ConversationTarget[]> {
    const [taskRows, teamRows, workflowRows, agentRows] = await Promise.all([
      this.db.select({ executionId: chatProjectTasks.executionId, workspaceId: chatProjectTasks.workspaceId })
        .from(chatProjectTasks).where(eq(chatProjectTasks.status, 'running')),
      this.db.select({ executionId: chatSubmissions.executionId, workspaceId: chatSubmissions.workspaceId })
        .from(chatSubmissions)
        .innerJoin(coderRuns, sql`${coderRuns.id} = json_extract(${chatSubmissions.reference}, '$.runId')`)
        .where(and(isNotNull(chatSubmissions.executionId), sql`json_extract(${chatSubmissions.reference}, '$.kind') = 'coder'`, inArray(coderRuns.status, [...ACTIVE_CODER_RUN_STATUSES]))),
      this.db.select({ executionId: chatSubmissions.executionId, workspaceId: chatSubmissions.workspaceId })
        .from(chatSubmissions)
        .innerJoin(workflowRuns, sql`${workflowRuns.id} = json_extract(${chatSubmissions.reference}, '$.runId')`)
        .where(and(isNotNull(chatSubmissions.executionId), sql`json_extract(${chatSubmissions.reference}, '$.kind') = 'workflow'`, inArray(workflowRuns.status, [...ACTIVE_WORKFLOW_RUN_STATUSES]))),
      this.backgroundAgents(),
    ]);
    const targets = new Map<string, ConversationTarget>();
    for (const row of [...taskRows, ...teamRows, ...workflowRows, ...agentRows]) {
      if (row.executionId && !targets.has(row.executionId)) targets.set(row.executionId, { executionId: row.executionId, workspaceId: row.workspaceId });
    }
    return [...targets.values()];
  }

  private async tickConversation(target: ConversationTarget): Promise<void> {
    const items = await this.collectActiveWork(target);
    if (!items.length) {
      this.lastSignatures.delete(target.executionId);
      return;
    }
    const previous = this.lastSignatures.get(target.executionId) ?? new Map<string, string>();
    const changed = items.filter((item) => previous.get(`${item.kind}:${item.id}`) !== activeWorkSignature([item]));
    if (!changed.length) return;
    const result = await this.executions.reportActiveWorkProgress(target.workspaceId, target.executionId, buildActiveWorkNote(changed, this.intervalSeconds), {
      items: changed.map((item) => ({
        kind: item.kind,
        id: item.id,
        title: item.kind === 'agent' ? item.agentName : item.kind === 'task' ? truncate(item.goal, TITLE_LIMIT) : item.kind === 'coder' ? truncate(item.intent, TITLE_LIMIT) : item.workflowName,
        status: item.kind === 'task' ? 'running' : item.status,
        stage: item.kind === 'task' ? item.stage : item.kind === 'workflow' ? item.currentStep : undefined,
        progress: item.kind === 'task'
          ? truncate(item.progressText, PROGRESS_TEXT_LIMIT) || undefined
          : item.kind === 'agent' || item.kind === 'coder' ? item.details : item.currentStep,
        updatedAt: item.updatedAt,
        ...(item.kind === 'agent' ? { agentId: item.agentId, runId: item.runId, task: item.task } : {}),
      })),
    });
    // busy leaves the marker unset so the next tick retries; reported and unavailable (the
    // conversation is gone or cancelled) both record the signature, so a cancelled conversation
    // stays silent until its visible work actually changes again.
    if (result !== 'busy') this.lastSignatures.set(target.executionId, new Map(items.map((item) => [`${item.kind}:${item.id}`, activeWorkSignature([item])])));
  }

  private backgroundAgents(target?: ConversationTarget) {
    return this.db.select({
      executionId: sql<string>`json_extract(${auditLogs.metadata}, '$.conversationId')`, workspaceId: auditLogs.workspaceId,
      id: agentExecutions.id, agentId: agentExecutions.agentId, status: agentExecutions.status, phase: agentExecutions.phase,
      messages: displayMessagesColumn, updatedAt: agentExecutions.updatedAt,
      agentName: sql<string>`json_extract(${auditLogs.metadata}, '$.agentName')`,
      runId: sql<string>`coalesce(json_extract(${auditLogs.metadata}, '$.invocationId'), ${agentExecutions.id})`,
    }).from(auditLogs).innerJoin(agentExecutions, and(eq(agentExecutions.id, auditLogs.resource), eq(agentExecutions.workspaceId, auditLogs.workspaceId)))
      .where(and(eq(auditLogs.action, 'chat_agent.dispatched'), eq(agentExecutions.status, 'running'),
        target ? eq(auditLogs.workspaceId, target.workspaceId) : undefined,
        target ? sql`json_extract(${auditLogs.metadata}, '$.conversationId') = ${target.executionId}` : undefined)).orderBy(auditLogs.createdAt, auditLogs.id);
  }

  private async collectActiveWork(target: ConversationTarget): Promise<ActiveWorkItem[]> {
    const [tasks, teamRows, workflowRows, agentRows] = await Promise.all([
      this.db.select(projectTaskColumns).from(chatProjectTasks)
        .where(and(eq(chatProjectTasks.executionId, target.executionId), eq(chatProjectTasks.status, 'running'))),
      this.db.select({ runId: coderRuns.id, intent: coderRuns.intent, status: coderRuns.status, updatedAt: coderRuns.updatedAt })
        .from(chatSubmissions)
        .innerJoin(coderRuns, sql`${coderRuns.id} = json_extract(${chatSubmissions.reference}, '$.runId')`)
        .where(and(eq(chatSubmissions.executionId, target.executionId), sql`json_extract(${chatSubmissions.reference}, '$.kind') = 'coder'`, inArray(coderRuns.status, [...ACTIVE_CODER_RUN_STATUSES]))),
      this.db.select({ runId: workflowRuns.id, status: workflowRuns.status, currentNodeId: workflowRuns.currentNodeId, workflowName: workflows.name, nodes: workflowVersions.nodes, updatedAt: workflowRuns.updatedAt })
        .from(chatSubmissions)
        .innerJoin(workflowRuns, sql`${workflowRuns.id} = json_extract(${chatSubmissions.reference}, '$.runId')`)
        .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
        .innerJoin(workflowVersions, eq(workflowVersions.id, workflowRuns.workflowVersionId))
        .where(and(eq(chatSubmissions.executionId, target.executionId), sql`json_extract(${chatSubmissions.reference}, '$.kind') = 'workflow'`, inArray(workflowRuns.status, [...ACTIVE_WORKFLOW_RUN_STATUSES]))),
      this.backgroundAgents(target),
    ]);
    const items: ActiveWorkItem[] = tasks.map((task) => ({
      kind: 'task',
      id: task.id,
      goal: task.goal,
      stage: deriveTaskStage(task),
      activityCount: task.activities.length,
      progressText: [...task.activities].reverse().find((activity) => typeof activity.text === 'string' && activity.text.trim())?.text as string ?? '',
      updatedAt: task.updatedAt.toISOString(),
    }));
    for (const row of teamRows) {
      const progress = this.runtime ? await this.runtime.getRunProgress(row.runId).catch(() => null) : null;
      const view = this.runtime ? await this.runtime.getRunView(row.runId, target.workspaceId).catch(() => null) : null;
      const details = view?.tasks.filter((task) => task.status === 'running' || task.status === 'waiting_for_input')
        .map((task) => task.checklist?.length ? task.checklist.map((item) => `${item.status === 'completed' ? '- [x]' : item.status === 'in_progress' ? '- [~]' : '- [ ]'} ${item.step}`).join('\n') : [task.roleName || task.assignmentTitle, task.progressText.trim() || task.assignmentTitle].filter(Boolean).join('：'))
        .filter(Boolean).join('\n');
      items.push({ kind: 'coder', id: row.runId, intent: row.intent, status: row.status, progress, details: details || undefined, updatedAt: row.updatedAt.toISOString() });
    }
    for (const row of workflowRows) {
      const node = row.nodes?.find((candidate) => candidate.id === row.currentNodeId);
      const config = node?.config && typeof node.config === 'object' ? node.config as Record<string, unknown> : null;
      const currentStep = [config?.label, config?.name, config?.title].find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
      items.push({ kind: 'workflow', id: row.runId, workflowName: row.workflowName, status: row.status, currentNodeId: row.currentNodeId, currentStep, updatedAt: row.updatedAt.toISOString() });
    }
    for (const row of agentRows) {
      const children = await this.db.select({ metadata: auditLogs.metadata }).from(auditLogs).where(and(eq(auditLogs.workspaceId, target.workspaceId), eq(auditLogs.resource, row.id), eq(auditLogs.action, 'agent.invocation'))).orderBy(auditLogs.createdAt, auditLogs.id);
      const labels: Record<string, string> = { running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消', waiting_for_input: '等待输入' };
      // A recovered attempt replaces the old failure in current progress; audit history remains intact.
      const latestAttempts = new Map<string, typeof children[number]>();
      for (const child of children) {
        const metadata = child.metadata;
        if (!metadata.parentRunId || typeof metadata.agentName !== 'string' || typeof metadata.status !== 'string' || !labels[metadata.status]) continue;
        const key = `${String(metadata.parentRunId)}:${String(metadata.agentId ?? metadata.agentName)}`;
        const previous = latestAttempts.get(key);
        const time = typeof metadata.createdAt === 'string' ? Date.parse(metadata.createdAt) : 0;
        const previousTime = typeof previous?.metadata.createdAt === 'string' ? Date.parse(previous.metadata.createdAt) : 0;
        if (!previous || (metadata.status === 'running' && previous.metadata.status !== 'running') || (previous.metadata.status !== 'running' && time >= previousTime) || (metadata.status === 'running' && time >= previousTime)) latestAttempts.set(key, child);
      }
      const childProgress = [...latestAttempts.values()].map(({ metadata }) => `${metadata.agentName}：${labels[metadata.status as string]}`).join('；');
      const latest = [...row.messages].reverse().find((message) => message.role === 'assistant' && message.content.trim())?.content;
      const details = truncate(childProgress || latest || ({ model: '正在分析与处理任务', skill: '正在执行工具', recovery: '正在恢复执行' }[row.phase] ?? '任务执行中'), PROGRESS_TEXT_LIMIT);
      const task = [...row.messages].reverse().find((message) => message.role === 'user' && message.content.trim())?.content;
      items.push({ kind: 'agent', id: row.id, agentId: row.agentId, agentName: row.agentName, runId: row.runId, task, status: row.status, details, updatedAt: row.updatedAt.toISOString() });
    }
    return items;
  }
}
