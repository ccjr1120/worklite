import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { executorRuns, chatProjectTasks, chatSubmissions, workflowRuns, workflows, type Database } from '@worklite/db';
import type { AgentTeamRunProgress } from '@worklite/contracts';
import { DATABASE } from '../../infrastructure/database.module';
import { AgentTeamRuntimeService } from '../executors/executor-runtime.service';
import { AgentExecutionsService } from './agent-executions.service';
import { deriveTaskStage } from './chat-project-tasks.service';

export const DEFAULT_PROGRESS_NOTE_INTERVAL_SECONDS = 300;
const ACTIVE_RUN_STATUSES = ['queued', 'running', 'paused'] as const;
const TITLE_LIMIT = 80;
const PROGRESS_TEXT_LIMIT = 160;

export type ActiveWorkItem =
  | { kind: 'task'; id: string; goal: string; stage: string; activityCount: number; progressText: string; updatedAt?: string }
  | { kind: 'executor_category'; id: string; intent: string; status: string; progress: AgentTeamRunProgress | null; updatedAt?: string }
  | { kind: 'workflow'; id: string; workflowName: string; status: string; currentNodeId: string | null; updatedAt?: string };

type ConversationTarget = { executionId: string; workspaceId: string };

const truncate = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit)}…` : value;

// The visible-change signature: a tick whose summary matches the last reported one is skipped,
// so a quiet interval never produces a duplicate report while genuinely new progress does.
export function activeWorkSignature(items: ActiveWorkItem[]): string {
  return JSON.stringify(items.map((item) => item.kind === 'task'
    ? [item.kind, item.id, item.stage, item.activityCount, item.progressText]
    : item.kind === 'executor_category'
      ? [item.kind, item.id, item.status, item.progress?.phase ?? null, item.progress?.percent ?? null, item.progress?.completedAssignments ?? null]
      : [item.kind, item.id, item.status, item.currentNodeId]));
}

const formatInterval = (seconds: number) => seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;

export function buildActiveWorkNote(items: ActiveWorkItem[], intervalSeconds = DEFAULT_PROGRESS_NOTE_INTERVAL_SECONDS): string {
  const lines = items.map((item, index) => {
    if (item.kind === 'task') {
      const progress = item.progressText ? `，最新进展：${truncate(item.progressText, PROGRESS_TEXT_LIMIT)}` : '';
      return `${index + 1}. 项目任务 ${item.id}（${truncate(item.goal, TITLE_LIMIT)}）：运行中，阶段 ${item.stage}${progress}`;
    }
    if (item.kind === 'executor_category') {
      const progress = item.progress ? `，进度 ${item.progress.percent}%（阶段 ${item.progress.phase}，${item.progress.completedAssignments}/${item.progress.totalAssignments} 项开发任务完成）` : '';
      return `${index + 1}. 执行器任务 ${item.id}（${truncate(item.intent, TITLE_LIMIT)}）：${item.status}${progress}`;
    }
    return `${index + 1}. 工作流运行 ${item.id}（${item.workflowName}）：${item.status}${item.currentNodeId ? `，当前节点 ${item.currentNodeId}` : ''}`;
  });
  return `[活跃工作进展提醒] 当前对话仍有进行中的工作（约每 ${formatInterval(intervalSeconds)}提醒一次，工作全部结束或无新进展时自动停止）：\n${lines.join('\n')}\n请基于以上信息用一两句话向用户汇报最新进展摘要；不要向用户复述本提醒本身；直接回复，不要调用工具。`;
}

// Periodic progress reports for conversations with active background work: a running project
// task, or a queued/running/paused executor or Workflow Run dispatched from that conversation.
// waiting_for_input work is excluded — its question already reached the user through the
// settlement report. The recurring tick replaces the one-shot settlement reports' deferral:
// a busy conversation simply retries on the next tick, and a conversation whose summary is
// unchanged since its last report is skipped.
@Injectable()
export class ChatProgressReportsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatProgressReportsService.name);
  private readonly lastSignatures = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  readonly intervalSeconds: number;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly runtime: AgentTeamRuntimeService,
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
    const [taskRows, teamRows, workflowRows] = await Promise.all([
      this.db.select({ executionId: chatProjectTasks.executionId, workspaceId: chatProjectTasks.workspaceId })
        .from(chatProjectTasks).where(eq(chatProjectTasks.status, 'running')),
      this.db.select({ executionId: chatSubmissions.executionId, workspaceId: chatSubmissions.workspaceId })
        .from(chatSubmissions)
        .innerJoin(executorRuns, sql`${executorRuns.id} = json_extract(${chatSubmissions.reference}, '$.runId')`)
        .where(and(isNotNull(chatSubmissions.executionId), sql`json_extract(${chatSubmissions.reference}, '$.kind') = 'executor_category'`, inArray(executorRuns.status, [...ACTIVE_RUN_STATUSES]))),
      this.db.select({ executionId: chatSubmissions.executionId, workspaceId: chatSubmissions.workspaceId })
        .from(chatSubmissions)
        .innerJoin(workflowRuns, sql`${workflowRuns.id} = json_extract(${chatSubmissions.reference}, '$.runId')`)
        .where(and(isNotNull(chatSubmissions.executionId), sql`json_extract(${chatSubmissions.reference}, '$.kind') = 'workflow'`, inArray(workflowRuns.status, [...ACTIVE_RUN_STATUSES]))),
    ]);
    const targets = new Map<string, ConversationTarget>();
    for (const row of [...taskRows, ...teamRows, ...workflowRows]) {
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
    const signature = activeWorkSignature(items);
    if (this.lastSignatures.get(target.executionId) === signature) return;
    const result = await this.executions.reportActiveWorkProgress(target.workspaceId, target.executionId, buildActiveWorkNote(items, this.intervalSeconds), {
      items: items.map((item) => ({
        kind: item.kind,
        id: item.id,
        title: item.kind === 'task' ? truncate(item.goal, TITLE_LIMIT) : item.kind === 'executor_category' ? truncate(item.intent, TITLE_LIMIT) : item.workflowName,
        status: item.kind === 'task' ? 'running' : item.status,
        stage: item.kind === 'task' ? item.stage : item.kind === 'executor_category' ? item.progress?.phase ?? undefined : item.currentNodeId ?? undefined,
        progress: item.kind === 'task'
          ? truncate(item.progressText, PROGRESS_TEXT_LIMIT) || undefined
          : item.kind === 'executor_category' && item.progress
            ? `${item.progress.percent}% · ${item.progress.completedAssignments}/${item.progress.totalAssignments}`
            : undefined,
        updatedAt: item.updatedAt,
      })),
    });
    // busy leaves the marker unset so the next tick retries; reported and unavailable (the
    // conversation is gone or cancelled) both record the signature, so a cancelled conversation
    // stays silent until its visible work actually changes again.
    if (result !== 'busy') this.lastSignatures.set(target.executionId, signature);
  }

  private async collectActiveWork(target: ConversationTarget): Promise<ActiveWorkItem[]> {
    const [tasks, teamRows, workflowRows] = await Promise.all([
      this.db.select().from(chatProjectTasks)
        .where(and(eq(chatProjectTasks.executionId, target.executionId), eq(chatProjectTasks.status, 'running'))),
      this.db.select({ runId: executorRuns.id, intent: executorRuns.intent, status: executorRuns.status, updatedAt: executorRuns.updatedAt })
        .from(chatSubmissions)
        .innerJoin(executorRuns, sql`${executorRuns.id} = json_extract(${chatSubmissions.reference}, '$.runId')`)
        .where(and(eq(chatSubmissions.executionId, target.executionId), sql`json_extract(${chatSubmissions.reference}, '$.kind') = 'executor_category'`, inArray(executorRuns.status, [...ACTIVE_RUN_STATUSES]))),
      this.db.select({ runId: workflowRuns.id, status: workflowRuns.status, currentNodeId: workflowRuns.currentNodeId, workflowName: workflows.name, updatedAt: workflowRuns.updatedAt })
        .from(chatSubmissions)
        .innerJoin(workflowRuns, sql`${workflowRuns.id} = json_extract(${chatSubmissions.reference}, '$.runId')`)
        .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
        .where(and(eq(chatSubmissions.executionId, target.executionId), sql`json_extract(${chatSubmissions.reference}, '$.kind') = 'workflow'`, inArray(workflowRuns.status, [...ACTIVE_RUN_STATUSES]))),
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
      const progress = await this.runtime.getRunProgress(row.runId)
        .catch(() => null);
      items.push({ kind: 'executor_category', id: row.runId, intent: row.intent, status: row.status, progress, updatedAt: row.updatedAt.toISOString() });
    }
    for (const row of workflowRows) {
      items.push({ kind: 'workflow', id: row.runId, workflowName: row.workflowName, status: row.status, currentNodeId: row.currentNodeId, updatedAt: row.updatedAt.toISOString() });
    }
    return items;
  }
}
