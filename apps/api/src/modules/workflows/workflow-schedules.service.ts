import { BadRequestException, Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, lte } from 'drizzle-orm';
import type { Request } from 'express';
import type { RunStatus, WorkflowScheduleView } from '@worklite/contracts';
import { workflowRuns, workflowSchedules, workflowVersions, workflows, type Database, type StoredWorkflowDefinition } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { RunsService } from '../runs/runs.service';
import { WorkspaceService } from '../teams/teams.service';

@Injectable()
export class WorkflowSchedulesService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly runs: RunsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), 10_000);
    this.timer.unref();
    void this.recoverAndTick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async get(request: Request, workflowId: string): Promise<WorkflowScheduleView | null> {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    const [workflow] = await this.db.select({ id: workflows.id }).from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspace.id))).limit(1);
    if (!workflow) throw new NotFoundException('Workflow not found');
    const [row] = await this.scheduleRows(workspace.id, workflowId);
    return row ? toScheduleView(row) : null;
  }

  async syncPublishedVersion(version: typeof workflowVersions.$inferSelect): Promise<void> {
    if (!version.published) return;
    const definition = version.definition as StoredWorkflowDefinition | null;
    const timer = definition?.nodes.find((node) => node.type === 'worklite/timer');
    const config = timer && timer.config && typeof timer.config === 'object' && !Array.isArray(timer.config) ? timer.config as Record<string, unknown> : undefined;
    if (!timer || !config) {
      await this.db.delete(workflowSchedules).where(eq(workflowSchedules.workflowId, version.workflowId));
      return;
    }

    const intervalSeconds = Math.round(Number(config.intervalSeconds));
    const enabled = config.enabled === true;
    const now = new Date();
    const [existing] = await this.db.select().from(workflowSchedules).where(eq(workflowSchedules.workflowId, version.workflowId)).limit(1);
    if (existing) {
      await this.db.update(workflowSchedules).set({
        workflowVersionId: version.id,
        intervalSeconds,
        enabled,
        nextRunAt: enabled ? new Date(now.getTime() + intervalSeconds * 1_000) : existing.nextRunAt,
        updatedAt: now,
      }).where(eq(workflowSchedules.id, existing.id));
      return;
    }

    const [workflow] = await this.db.select({ workspaceId: workflows.workspaceId }).from(workflows).where(eq(workflows.id, version.workflowId)).limit(1);
    if (!workflow) return;

    await this.db.insert(workflowSchedules).values({
      id: `wfs_${randomUUID()}`,
      workspaceId: workflow.workspaceId,
      workflowId: version.workflowId,
      workflowVersionId: version.id,
      intervalSeconds,
      enabled,
      nextRunAt: enabled ? new Date(now.getTime() + intervalSeconds * 1_000) : now,
    });
  }

  private async recoverAndTick(): Promise<void> {
    await this.db.update(workflowSchedules).set({ running: false, lastStatus: 'failed', updatedAt: new Date() }).where(eq(workflowSchedules.running, true));
    await this.tick();
  }

  private async tick(): Promise<void> {
    const due = await this.db.select().from(workflowSchedules).where(and(
      eq(workflowSchedules.enabled, true),
      eq(workflowSchedules.running, false),
      lte(workflowSchedules.nextRunAt, new Date()),
    )).limit(20);
    for (const schedule of due) await this.startSchedule(schedule).catch(() => undefined);

    const running = await this.db.select().from(workflowSchedules).where(eq(workflowSchedules.running, true));
    for (const schedule of running) await this.finishSchedule(schedule);
  }

  private async startSchedule(schedule: typeof workflowSchedules.$inferSelect): Promise<{ runId: string }> {
    const now = new Date();
    const claimed = await this.db.update(workflowSchedules).set({
      running: true,
      lastRunAt: now,
      lastStatus: 'queued',
      nextRunAt: new Date(now.getTime() + schedule.intervalSeconds * 1_000),
      updatedAt: now,
    }).where(and(eq(workflowSchedules.id, schedule.id), eq(workflowSchedules.running, false))).run();
    if (claimed.changes === 0) throw new BadRequestException('The scheduled workflow is already running.');

    try {
      const { runId } = await this.runs.createScheduledRun(
        schedule.workspaceId,
        schedule.workflowId,
        schedule.workflowVersionId,
        { trigger: 'timer', purpose: 'workflow_timer' },
      );
      await this.db.update(workflowSchedules).set({ lastRunId: runId, updatedAt: new Date() }).where(eq(workflowSchedules.id, schedule.id));
      return { runId };
    } catch (error) {
      await this.db.update(workflowSchedules).set({ running: false, lastStatus: 'failed', updatedAt: new Date() }).where(eq(workflowSchedules.id, schedule.id));
      throw error;
    }
  }

  private async finishSchedule(schedule: typeof workflowSchedules.$inferSelect): Promise<void> {
    if (!schedule.lastRunId) return;
    const [run] = await this.db.select().from(workflowRuns).where(eq(workflowRuns.id, schedule.lastRunId)).limit(1);
    if (!run || run.status === 'queued' || run.status === 'running' || run.status === 'waiting_for_input') return;
    await this.db.update(workflowSchedules).set({ running: false, lastStatus: run.status, updatedAt: new Date() }).where(eq(workflowSchedules.id, schedule.id));
  }

  private scheduleRows(workspaceId: string, workflowId: string) {
    return this.db.select({ schedule: workflowSchedules, workflowName: workflows.name, workflowVersion: workflowVersions.version })
      .from(workflowSchedules)
      .innerJoin(workflows, eq(workflowSchedules.workflowId, workflows.id))
      .innerJoin(workflowVersions, eq(workflowSchedules.workflowVersionId, workflowVersions.id))
      .where(and(eq(workflowSchedules.workspaceId, workspaceId), eq(workflowSchedules.workflowId, workflowId)))
      .limit(1);
  }
}

function toScheduleView(row: { schedule: typeof workflowSchedules.$inferSelect; workflowName: string; workflowVersion: number }): WorkflowScheduleView {
  const { schedule } = row;
  return {
    id: schedule.id,
    workflowId: schedule.workflowId,
    workflowName: row.workflowName,
    workflowVersionId: schedule.workflowVersionId,
    workflowVersion: row.workflowVersion,
    intervalSeconds: schedule.intervalSeconds,
    enabled: schedule.enabled,
    running: schedule.running,
    nextRunAt: schedule.nextRunAt.toISOString(),
    lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
    lastRunId: schedule.lastRunId,
    lastStatus: schedule.lastStatus as RunStatus | null,
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
  };
}
