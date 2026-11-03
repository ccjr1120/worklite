import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { coderRuns, chatSubmissions, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { AgentTeamRuntimeService } from '../coders/coder-runtime.service';
import { AgentExecutionsService } from './agent-executions.service';

const REPORT_DEFER_MS = 15_000;
const MAX_DEFERRED_ATTEMPTS = 240;

// Reports the terminal outcome of a Chat-dispatched Coder Run back into the originating
// conversation, mirroring the background project task report. Cancelled Runs and
// waiting_for_input Runs are not reported: cancellation is user-driven and pending
// questions are already visible and answerable on the Chat task card.
@Injectable()
export class ChatTeamRunReportsService implements OnModuleInit {
  private readonly logger = new Logger(ChatTeamRunReportsService.name);
  private readonly reportTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly runtime: AgentTeamRuntimeService,
    private readonly executions: AgentExecutionsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.runtime.subscribe((event) => {
      if (event.type !== 'run.status') return;
      const status = (event.payload as { status?: unknown } | null)?.status;
      if (status !== 'succeeded' && status !== 'failed') return;
      void this.scheduleForRun(event.runId, 0)
        .catch((error) => this.logger.warn(`Chat Coder Run ${event.runId} report scheduling failed: ${error instanceof Error ? error.message : String(error)}`));
    });
    // Startup sweep: Runs that settled while no report landed (shutdown between settle and report).
    const sweep = setTimeout(() => {
      void this.sweepSettledRuns()
        .catch((error) => this.logger.warn(`Chat Coder Run report sweep failed: ${error instanceof Error ? error.message : String(error)}`));
    }, 5000);
    sweep.unref();
  }

  private async sweepSettledRuns(): Promise<void> {
    const rows = await this.db.select({ runId: coderRuns.id })
      .from(chatSubmissions)
      .innerJoin(coderRuns, sql`${coderRuns.id} = json_extract(${chatSubmissions.reference}, '$.runId')`)
      .where(and(
        // reportedAt alone cannot gate a report: a retried Run settles again after the
        // first report, so only a settle newer than the last report counts as unreported.
        or(isNull(chatSubmissions.reportedAt), gt(coderRuns.finishedAt, chatSubmissions.reportedAt)),
        isNotNull(chatSubmissions.executionId),
        inArray(coderRuns.status, ['succeeded', 'failed']),
        sql`json_extract(${chatSubmissions.reference}, '$.kind') = 'coder'`,
      ));
    for (const row of rows) await this.scheduleForRun(row.runId, 0);
  }

  private async scheduleForRun(runId: string, delayMs: number, deferredAttempts = 0): Promise<void> {
    const [row] = await this.db.select({
      submissionId: chatSubmissions.id,
      workspaceId: chatSubmissions.workspaceId,
      executionId: chatSubmissions.executionId,
      reportedAt: chatSubmissions.reportedAt,
      reference: chatSubmissions.reference,
      runStatus: coderRuns.status,
      runFinishedAt: coderRuns.finishedAt,
    })
      .from(chatSubmissions)
      .innerJoin(coderRuns, sql`${coderRuns.id} = json_extract(${chatSubmissions.reference}, '$.runId')`)
      .where(and(eq(coderRuns.id, runId), sql`json_extract(${chatSubmissions.reference}, '$.kind') = 'coder'`))
      .limit(1);
    if (!row || !row.executionId || row.reference?.kind !== 'coder') return;
    if (row.runStatus !== 'succeeded' && row.runStatus !== 'failed') return;
    // A Run retried after an earlier report settles again with a newer finishedAt; that
    // outcome has not been reported yet even though reportedAt is already set.
    if (row.reportedAt && (!row.runFinishedAt || row.runFinishedAt <= row.reportedAt)) return;
    this.scheduleReport(row.workspaceId, row.executionId, row.submissionId, runId, delayMs, deferredAttempts);
  }

  private scheduleReport(workspaceId: string, executionId: string, submissionId: string, runId: string, delayMs: number, deferredAttempts: number): void {
    if (this.reportTimers.has(submissionId)) return;
    const timer = setTimeout(() => {
      this.reportTimers.delete(submissionId);
      void this.report(workspaceId, executionId, submissionId, runId, deferredAttempts)
        .catch((error) => this.logger.warn(`Chat Coder Run ${runId} report failed: ${error instanceof Error ? error.message : String(error)}`));
    }, delayMs);
    this.reportTimers.set(submissionId, timer);
  }

  private async report(workspaceId: string, executionId: string, submissionId: string, runId: string, deferredAttempts: number): Promise<void> {
    const [submission] = await this.db.select({ reportedAt: chatSubmissions.reportedAt }).from(chatSubmissions)
      .where(eq(chatSubmissions.id, submissionId)).limit(1);
    if (!submission) return;
    const view = await this.runtime.getRunView(runId, workspaceId);
    if (view.status !== 'succeeded' && view.status !== 'failed') return;
    const finishedAt = view.finishedAt ? new Date(view.finishedAt) : null;
    if (submission.reportedAt && (!finishedAt || finishedAt <= submission.reportedAt)) return;
    const groupContext = view.groupId ? `历史对话 ${view.groupId} 可通过 inspect_coder_group 查看。` : '';
    const note = view.status === 'succeeded'
      ? `[后台 Coder 任务提醒] Coder 任务 ${view.id}（目录 ${view.projectDirectory}）已完成。${groupContext}结果摘要：${view.outcome?.summary ?? '无'}。请用简短回复向用户汇报该结果；不要向用户复述本提醒本身。`
      : (() => {
        const failedTask = [...view.tasks].reverse().find((task) => task.status === 'failed');
        return `[后台 Coder 任务提醒] Coder 任务 ${view.id}（目录 ${view.projectDirectory}）失败。${groupContext}失败任务 ${failedTask?.taskKey ?? '未知'}：${failedTask?.error ?? '未知错误'}。请用简短回复向用户汇报失败原因；用户要求继续时，通过 Router 为失败角色创建关联的新尝试；不要恢复旧执行器会话，也不要自行重新派发。`;
      })();
    const result = await this.executions.reportTeamRunSettled(workspaceId, executionId, submissionId, note);
    // A conversation blocked for hours keeps its unreported marker for the startup sweep instead of polling forever.
    if (result === 'busy' && deferredAttempts < MAX_DEFERRED_ATTEMPTS) {
      this.scheduleReport(workspaceId, executionId, submissionId, runId, REPORT_DEFER_MS, deferredAttempts + 1);
    }
  }
}
