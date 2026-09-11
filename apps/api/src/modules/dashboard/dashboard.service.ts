import { BadRequestException, Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, lte } from 'drizzle-orm';
import type { Request } from 'express';
import type { DashboardPayload, DashboardPayloadItem, DashboardView, RunStatus, UpdateDashboardRequest, UpsertWorkflowScheduleRequest, WorkflowScheduleView } from '@worklite/contracts';
import { dashboardDatasets, workflowRuns, workflowSchedules, workflowVersions, workflows, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { RunsService } from '../runs/runs.service';
import { WorkspaceService } from '../teams/teams.service';

@Injectable()
export class DashboardService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly workspaces: WorkspaceService, private readonly runs: RunsService) {}
  onModuleInit(): void { this.timer = setInterval(() => void this.tick(), 10_000); this.timer.unref(); void this.recoverAndTick(); }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async get(request: Request): Promise<DashboardView> {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    const [row] = await this.db.select({ dataset: dashboardDatasets, workflowName: workflows.name }).from(dashboardDatasets).innerJoin(workflows, eq(dashboardDatasets.workflowId, workflows.id)).where(eq(dashboardDatasets.workspaceId, workspace.id)).limit(1);
    if (!row) return { workflowId: null, workflowName: null, presentation: 'kanban', payload: null, schedule: null };
    const [schedule] = await this.scheduleRows(workspace.id, row.dataset.workflowId);
    return { workflowId: row.dataset.workflowId, workflowName: row.workflowName, presentation: row.dataset.presentation, payload: parseStoredPayload(row.dataset.payload), schedule: schedule ? toScheduleView(schedule) : null };
  }

  async update(request: Request, input: UpdateDashboardRequest): Promise<DashboardView> {
    if (!input || typeof input.workflowId !== 'string' || !input.workflowId.trim() || (input.presentation !== 'list' && input.presentation !== 'kanban')) throw new BadRequestException('A published workflow and dashboard presentation are required.');
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    await this.latestPublishedVersion(workspace.id, input.workflowId);
    await this.db.insert(dashboardDatasets).values({ id: `dbd_${randomUUID()}`, workspaceId: workspace.id, workflowId: input.workflowId, presentation: input.presentation }).onConflictDoUpdate({ target: dashboardDatasets.workspaceId, set: { workflowId: input.workflowId, presentation: input.presentation, payload: null, lastRunId: null, updatedAt: new Date() } });
    return this.get(request);
  }

  async upsertSchedule(request: Request, input: UpsertWorkflowScheduleRequest): Promise<WorkflowScheduleView> {
    if (!input || typeof input.workflowId !== 'string' || !input.workflowId.trim() || !Number.isFinite(input.intervalSeconds) || input.intervalSeconds < 300 || typeof input.enabled !== 'boolean') throw new BadRequestException('A workflow, enabled state, and interval of at least five minutes are required.');
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    const [dataset] = await this.db.select().from(dashboardDatasets).where(and(eq(dashboardDatasets.workspaceId, workspace.id), eq(dashboardDatasets.workflowId, input.workflowId))).limit(1);
    if (!dataset) throw new BadRequestException('Select this workflow for the dashboard before scheduling it.');
    const version = await this.latestPublishedVersion(workspace.id, input.workflowId);
    const now = new Date();
    await this.db.insert(workflowSchedules).values({ id: `wfs_${randomUUID()}`, workspaceId: workspace.id, workflowId: input.workflowId, workflowVersionId: version.id, intervalSeconds: Math.round(input.intervalSeconds), enabled: input.enabled, nextRunAt: new Date(now.getTime() + Math.round(input.intervalSeconds) * 1_000) }).onConflictDoUpdate({ target: workflowSchedules.workflowId, set: { workflowVersionId: version.id, intervalSeconds: Math.round(input.intervalSeconds), enabled: input.enabled, nextRunAt: new Date(now.getTime() + Math.round(input.intervalSeconds) * 1_000), updatedAt: now } });
    const [row] = await this.scheduleRows(workspace.id, input.workflowId);
    if (!row) throw new Error('Workflow schedule could not be saved.');
    return toScheduleView(row);
  }

  async runNow(request: Request): Promise<{ runId: string }> {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    const [dataset] = await this.db.select().from(dashboardDatasets).where(eq(dashboardDatasets.workspaceId, workspace.id)).limit(1);
    if (!dataset) throw new BadRequestException('Select a published workflow for the dashboard first.');
    const [schedule] = await this.db.select().from(workflowSchedules).where(and(eq(workflowSchedules.workspaceId, workspace.id), eq(workflowSchedules.workflowId, dataset.workflowId))).limit(1);
    if (schedule) return this.startSchedule(schedule);
    const version = await this.latestPublishedVersion(workspace.id, dataset.workflowId);
    const { runId } = await this.runs.createScheduledRun(workspace.id, dataset.workflowId, version.id, { trigger: 'manual', purpose: 'dashboard_refresh' });
    await this.db.update(dashboardDatasets).set({ lastRunId: runId, updatedAt: new Date() }).where(eq(dashboardDatasets.id, dataset.id));
    return { runId };
  }

  private async recoverAndTick(): Promise<void> { await this.db.update(workflowSchedules).set({ running: false, lastStatus: 'failed', updatedAt: new Date() }).where(eq(workflowSchedules.running, true)); await this.tick(); }
  private async tick(): Promise<void> {
    const due = await this.db.select().from(workflowSchedules).where(and(eq(workflowSchedules.enabled, true), eq(workflowSchedules.running, false), lte(workflowSchedules.nextRunAt, new Date()))).limit(20);
    for (const schedule of due) await this.startSchedule(schedule).catch(() => undefined);
    const running = await this.db.select().from(workflowSchedules).where(eq(workflowSchedules.running, true));
    for (const schedule of running) await this.finishSchedule(schedule);
    const pending = await this.db.select().from(dashboardDatasets);
    for (const dataset of pending) {
      if (dataset.lastRunId) await this.captureRun(dataset.id, dataset.lastRunId).catch(() => undefined);
    }
  }

  private async startSchedule(schedule: typeof workflowSchedules.$inferSelect): Promise<{ runId: string }> {
    const now = new Date();
    const claimed = await this.db.update(workflowSchedules).set({ running: true, lastRunAt: now, lastStatus: 'queued', nextRunAt: new Date(now.getTime() + schedule.intervalSeconds * 1_000), updatedAt: now }).where(and(eq(workflowSchedules.id, schedule.id), eq(workflowSchedules.running, false))).run();
    if (claimed.changes === 0) throw new BadRequestException('The scheduled workflow is already running.');
    try {
      const { runId } = await this.runs.createScheduledRun(schedule.workspaceId, schedule.workflowId, schedule.workflowVersionId, { trigger: 'schedule', purpose: 'dashboard_refresh' });
      await this.db.update(workflowSchedules).set({ lastRunId: runId, updatedAt: new Date() }).where(eq(workflowSchedules.id, schedule.id));
      await this.db.update(dashboardDatasets).set({ lastRunId: runId, updatedAt: new Date() }).where(and(eq(dashboardDatasets.workspaceId, schedule.workspaceId), eq(dashboardDatasets.workflowId, schedule.workflowId)));
      return { runId };
    } catch (error) { await this.db.update(workflowSchedules).set({ running: false, lastStatus: 'failed', updatedAt: new Date() }).where(eq(workflowSchedules.id, schedule.id)); throw error; }
  }

  private async finishSchedule(schedule: typeof workflowSchedules.$inferSelect): Promise<void> {
    if (!schedule.lastRunId) return;
    const [run] = await this.db.select().from(workflowRuns).where(eq(workflowRuns.id, schedule.lastRunId)).limit(1);
    if (!run || run.status === 'queued' || run.status === 'running') return;
    if (run.status === 'succeeded') await this.captureWorkflowResult(schedule.workspaceId, schedule.workflowId, run.id, run.result);
    await this.db.update(workflowSchedules).set({ running: false, lastStatus: run.status, updatedAt: new Date() }).where(eq(workflowSchedules.id, schedule.id));
  }

  private async captureRun(datasetId: string, runId: string): Promise<void> {
    const [run] = await this.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
    if (!run || run.status === 'queued' || run.status === 'running') return;
    if (run.status === 'succeeded') {
      await this.db.update(dashboardDatasets).set({ payload: parseDashboardPayload(run.result), lastRunId: null, updatedAt: new Date() }).where(and(eq(dashboardDatasets.id, datasetId), eq(dashboardDatasets.lastRunId, runId)));
      return;
    }
    await this.db.update(dashboardDatasets).set({ lastRunId: null, updatedAt: new Date() }).where(and(eq(dashboardDatasets.id, datasetId), eq(dashboardDatasets.lastRunId, runId)));
  }
  private async captureWorkflowResult(workspaceId: string, workflowId: string, runId: string, result: unknown): Promise<void> { await this.db.update(dashboardDatasets).set({ payload: parseDashboardPayload(result), lastRunId: runId, updatedAt: new Date() }).where(and(eq(dashboardDatasets.workspaceId, workspaceId), eq(dashboardDatasets.workflowId, workflowId))); }
  private async latestPublishedVersion(workspaceId: string, workflowId: string): Promise<typeof workflowVersions.$inferSelect> {
    const [row] = await this.db.select({ version: workflowVersions }).from(workflowVersions).innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id)).where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspaceId), eq(workflowVersions.published, true))).orderBy(desc(workflowVersions.version)).limit(1);
    if (!row) throw new NotFoundException('Published workflow not found');
    return row.version;
  }
  private scheduleRows(workspaceId: string, workflowId: string) { return this.db.select({ schedule: workflowSchedules, workflowName: workflows.name, workflowVersion: workflowVersions.version }).from(workflowSchedules).innerJoin(workflows, eq(workflowSchedules.workflowId, workflows.id)).innerJoin(workflowVersions, eq(workflowSchedules.workflowVersionId, workflowVersions.id)).where(and(eq(workflowSchedules.workspaceId, workspaceId), eq(workflowSchedules.workflowId, workflowId))).limit(1); }
}

function parseStoredPayload(value: unknown): DashboardPayload | null { try { return value === null ? null : parseDashboardPayload(value); } catch { return null; } }
function parseDashboardPayload(value: unknown): DashboardPayload {
  const record = asRecord(value); const leaf = record && Object.keys(record).length === 1 ? Object.values(record)[0] : undefined; const leafRecord = asRecord(leaf); const candidate = record?.type === 'worklite.dashboard' ? record : leafRecord?.type === 'worklite.dashboard' ? leafRecord : asRecord(record?.output);
  if (!candidate || candidate.type !== 'worklite.dashboard' || candidate.version !== 1 || typeof candidate.updatedAt !== 'string' || !Array.isArray(candidate.items)) throw new Error('Workflow result must be a worklite.dashboard version 1 payload.');
  const sourceRecord = candidate.source === undefined ? null : asRecord(candidate.source);
  if (candidate.source !== undefined && (!sourceRecord || typeof sourceRecord.kind !== 'string' || (sourceRecord.name !== undefined && typeof sourceRecord.name !== 'string'))) throw new Error('Dashboard payload source is invalid.');
  return { type: 'worklite.dashboard', version: 1, updatedAt: candidate.updatedAt, items: candidate.items.map(parseItem), ...(sourceRecord ? { source: { kind: sourceRecord.kind as string, ...(typeof sourceRecord.name === 'string' ? { name: sourceRecord.name } : {}) } } : {}) };
}
function parseItem(value: unknown): DashboardPayloadItem {
  const item = asRecord(value);
  if (!item || typeof item.id !== 'string' || !item.id.trim() || typeof item.title !== 'string' || !item.title.trim() || typeof item.status !== 'string' || !item.status.trim()) throw new Error('Each dashboard item requires id, title, and status.');
  const metadata = item.metadata === undefined ? undefined : asRecord(item.metadata); if (item.metadata !== undefined && !metadata) throw new Error('Dashboard item metadata must be an object.');
  return { id: item.id, title: item.title, status: item.status, priority: nullableString(item.priority), dueAt: nullableString(item.dueAt), url: nullableString(item.url), ...(metadata ? { metadata } : {}) };
}
function nullableString(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function asRecord(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function toScheduleView(row: { schedule: typeof workflowSchedules.$inferSelect; workflowName: string; workflowVersion: number }): WorkflowScheduleView { const { schedule } = row; return { id: schedule.id, workflowId: schedule.workflowId, workflowName: row.workflowName, workflowVersionId: schedule.workflowVersionId, workflowVersion: row.workflowVersion, intervalSeconds: schedule.intervalSeconds, enabled: schedule.enabled, running: schedule.running, nextRunAt: schedule.nextRunAt.toISOString(), lastRunAt: schedule.lastRunAt?.toISOString() ?? null, lastRunId: schedule.lastRunId, lastStatus: schedule.lastStatus as RunStatus | null, createdAt: schedule.createdAt.toISOString(), updatedAt: schedule.updatedAt.toISOString() }; }
