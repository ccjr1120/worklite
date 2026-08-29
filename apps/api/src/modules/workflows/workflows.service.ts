import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { Request } from 'express';
import type { CreateWorkflowRequest, WorkflowView } from '@worklite/contracts';
import { workflows, workflowVersions, workflowRuns, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';

@Injectable()
export class WorkflowsService {
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly workspaces: WorkspaceService) {}

  async list(request: Request, workspaceSlug: string): Promise<WorkflowView[]> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const rows = await this.db.select().from(workflows).where(eq(workflows.workspaceId, team.id));
    return Promise.all(rows.map((row) => this.toView(row, workspaceSlug)));
  }

  async get(request: Request, workspaceSlug: string, workflowId: string): Promise<WorkflowView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [row] = await this.db.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1);
    if (!row || row.workspaceId !== team.id) throw new NotFoundException('Workflow not found');
    return this.toView(row, workspaceSlug);
  }

  async create(request: Request, workspaceSlug: string, input: CreateWorkflowRequest): Promise<WorkflowView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const workflowId = `wf_${randomUUID()}`;
    const versionId = `wfv_${randomUUID()}`;
    const [row] = await this.db.insert(workflows).values({ id: workflowId, workspaceId: team.id, name: input.name.trim(), state: 'draft' }).returning();
    if (!row) throw new NotFoundException('Workflow could not be created');
    await this.db.insert(workflowVersions).values({ id: versionId, workflowId, version: 1, schemaVersion: 1, published: false, nodes: [] });
    return this.toView(row, workspaceSlug);
  }

  async update(request: Request, workspaceSlug: string, workflowId: string, input: Partial<CreateWorkflowRequest>): Promise<WorkflowView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [row] = await this.db.update(workflows).set({
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      updatedAt: new Date(),
    }).where(eq(workflows.id, workflowId)).returning();
    if (!row || row.workspaceId !== team.id) throw new NotFoundException('Workflow not found');
    return this.toView(row, workspaceSlug);
  }

  private async toView(row: typeof workflows.$inferSelect, workspaceSlug: string): Promise<WorkflowView> {
    const [version] = await this.db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, row.id)).orderBy(desc(workflowVersions.version)).limit(1);
    const [lastRun] = await this.db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, row.id)).orderBy(desc(workflowRuns.createdAt)).limit(1);
    return {
      id: row.id,
      workspaceSlug,
      latestVersionId: version?.id ?? null,
      name: row.name,
      state: row.state,
      stepCount: version?.nodes.length ?? 0,
      lastRunStatus: lastRun?.status ?? null,
      lastRunAt: lastRun?.createdAt.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
