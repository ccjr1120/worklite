import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Request } from 'express';
import type { CreateRunRequest, RunView } from '@worklite/contracts';
import { workflowRuns, workflowVersions, workflows, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';

@Injectable()
export class RunsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
  ) {}

  async list(request: Request, workspaceSlug: string): Promise<RunView[]> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const rows = await this.db.select({ run: workflowRuns, workflow: workflows, version: workflowVersions })
      .from(workflowRuns)
      .innerJoin(workflows, eq(workflowRuns.workflowId, workflows.id))
      .innerJoin(workflowVersions, eq(workflowRuns.workflowVersionId, workflowVersions.id))
      .where(eq(workflowRuns.workspaceId, team.id))
      .orderBy(desc(workflowRuns.createdAt));
    return rows.map(({ run, workflow, version }) => this.toView(run, workflow, version, workspaceSlug, 'You'));
  }

  async get(request: Request, workspaceSlug: string, runId: string): Promise<RunView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [row] = await this.db.select({ run: workflowRuns, workflow: workflows, version: workflowVersions })
      .from(workflowRuns)
      .innerJoin(workflows, eq(workflowRuns.workflowId, workflows.id))
      .innerJoin(workflowVersions, eq(workflowRuns.workflowVersionId, workflowVersions.id))
      .where(eq(workflowRuns.id, runId)).limit(1);
    if (!row || row.run.workspaceId !== team.id) throw new NotFoundException('Run not found');
    return this.toView(row.run, row.workflow, row.version, workspaceSlug, 'You');
  }

  async createForVersion(request: Request, workflowVersionId: string, input: CreateRunRequest): Promise<{ runId: string }> {
    const [version] = await this.db.select({ version: workflowVersions, workflow: workflows })
      .from(workflowVersions)
      .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
      .where(eq(workflowVersions.id, workflowVersionId)).limit(1);
    if (!version) throw new NotFoundException('Workflow version not found');
    const runId = `run_${randomUUID()}`;
    await this.db.insert(workflowRuns).values({ id: runId, workspaceId: version.workflow.workspaceId, workflowId: version.workflow.id, workflowVersionId, input: input.input ?? null, status: 'queued' });
    this.schedule(runId);
    return { runId };
  }

  async cancel(request: Request, workspaceSlug: string, runId: string): Promise<RunView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [run] = await this.db.update(workflowRuns).set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() }).where(eq(workflowRuns.id, runId)).returning();
    if (!run || run.workspaceId !== team.id) throw new NotFoundException('Run not found');
    const [workflow] = await this.db.select().from(workflows).where(eq(workflows.id, run.workflowId)).limit(1);
    const [version] = await this.db.select().from(workflowVersions).where(eq(workflowVersions.id, run.workflowVersionId)).limit(1);
    if (!workflow || !version) throw new NotFoundException('Run dependencies not found');
    return this.toView(run, workflow, version, workspaceSlug, 'You');
  }

  private toView(run: typeof workflowRuns.$inferSelect, workflow: typeof workflows.$inferSelect, version: typeof workflowVersions.$inferSelect, workspaceSlug: string, initiator: string): RunView {
    const end = run.finishedAt?.getTime() ?? (run.status === 'queued' ? null : Date.now());
    return {
      id: run.id,
      workspaceSlug,
      workflowId: workflow.id,
      workflowName: workflow.name,
      version: `v${version.version}`,
      status: run.status,
      currentStep: run.currentNodeId,
      startedAt: run.createdAt.toISOString(),
      durationSeconds: end === null ? null : Math.max(0, Math.round((end - run.createdAt.getTime()) / 1000)),
      initiator,
    };
  }

  private schedule(runId: string): void {
    setTimeout(() => { void this.execute(runId); }, 0);
  }

  private async execute(runId: string): Promise<void> {
    try {
      await this.db.update(workflowRuns).set({ status: 'running', updatedAt: new Date() }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, 'queued')));
      await new Promise((resolve) => setTimeout(resolve, 25));
      const [run] = await this.db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
      if (run?.status !== 'running') return;
      await this.db.update(workflowRuns).set({ status: 'succeeded', result: { message: 'Workflow completed.' }, updatedAt: new Date(), finishedAt: new Date() }).where(eq(workflowRuns.id, runId));
    } catch {
      await this.db.update(workflowRuns).set({ status: 'failed', result: { message: 'Workflow execution failed.' }, updatedAt: new Date(), finishedAt: new Date() }).where(eq(workflowRuns.id, runId));
    }
  }
}
