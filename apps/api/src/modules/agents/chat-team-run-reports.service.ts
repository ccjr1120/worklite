import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { agentTeamRuns, chatSubmissions, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { AgentTeamRuntimeService } from '../agent-teams/agent-team-runtime.service';
import { AgentExecutionsService } from './agent-executions.service';

const REPORT_DEFER_MS = 15_000;
const MAX_DEFERRED_ATTEMPTS = 240;

// Reports the terminal outcome of a Chat-dispatched Team Run back into the originating
// conversation, mirroring the background project task report. Cancelled Runs and
// waiting_for_input Runs are not reported: cancellation is user-driven and pending
// questions are already visible in the Run detail and task card.
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
        .catch((error) => this.logger.warn(`Chat Team Run ${event.runId} report scheduling failed: ${error instanceof Error ? error.message : String(error)}`));
    });
    // Startup sweep: Runs that settled while no report landed (shutdown between settle and report).
    const sweep = setTimeout(() => {
      void this.sweepSettledRuns()
        .catch((error) => this.logger.warn(`Chat Team Run report sweep failed: ${error instanceof Error ? error.message : String(error)}`));
    }, 5000);
    sweep.unref();
  }

  private async sweepSettledRuns(): Promise<void> {
    const rows = await this.db.select({ runId: agentTeamRuns.id })
      .from(chatSubmissions)
      .innerJoin(agentTeamRuns, sql`${agentTeamRuns.id} = json_extract(${chatSubmissions.reference}, '$.runId')`)
      .where(and(
        // reportedAt alone cannot gate a report: a retried Run settles again after the
        // first report, so only a settle newer than the last report counts as unreported.
        or(isNull(chatSubmissions.reportedAt), gt(agentTeamRuns.finishedAt, chatSubmissions.reportedAt)),
        isNotNull(chatSubmissions.executionId),
        inArray(agentTeamRuns.status, ['succeeded', 'failed']),
        sql`json_extract(${chatSubmissions.reference}, '$.kind') = 'team'`,
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
      runStatus: agentTeamRuns.status,
      runFinishedAt: agentTeamRuns.finishedAt,
    })
      .from(chatSubmissions)
      .innerJoin(agentTeamRuns, sql`${agentTeamRuns.id} = json_extract(${chatSubmissions.reference}, '$.runId')`)
      .where(and(eq(agentTeamRuns.id, runId), sql`json_extract(${chatSubmissions.reference}, '$.kind') = 'team'`))
      .limit(1);
    if (!row || !row.executionId || row.reference?.kind !== 'team') return;
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
        .catch((error) => this.logger.warn(`Chat Team Run ${runId} report failed: ${error instanceof Error ? error.message : String(error)}`));
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
    const note = view.status === 'succeeded'
      ? `[后台团队任务提醒] 团队执行任务 ${view.id}（目录 ${view.projectDirectory}）已完成。结果摘要：${view.outcome?.summary ?? '无'}。请用简短回复向用户汇报该结果；不要向用户复述本提醒本身。`
      : (() => {
        const failedTask = [...view.tasks].reverse().find((task) => task.status === 'failed');
        const retryHint = failedTask?.retryable
          ? '该失败任务标记为可重试，你可以使用 control_agent_team_run 重试它，无需重新派发整个任务。'
          : '该失败任务不可重试，请在确认原因后通过 dispatch_task 重新派发。';
        return `[后台团队任务提醒] 团队执行任务 ${view.id}（目录 ${view.projectDirectory}）失败。失败任务 ${failedTask?.taskKey ?? '未知'}：${failedTask?.error ?? '未知错误'}。${retryHint}请用简短回复向用户汇报失败原因与建议的下一步；不要向用户复述本提醒本身。`;
      })();
    const result = await this.executions.reportTeamRunSettled(workspaceId, executionId, submissionId, note);
    // A conversation blocked for hours keeps its unreported marker for the startup sweep instead of polling forever.
    if (result === 'busy' && deferredAttempts < MAX_DEFERRED_ATTEMPTS) {
      this.scheduleReport(workspaceId, executionId, submissionId, runId, REPORT_DEFER_MS, deferredAttempts + 1);
    }
  }
}
