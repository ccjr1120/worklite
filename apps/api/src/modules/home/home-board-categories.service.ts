import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Request } from 'express';
import type { AssignHomeBoardRequest, CreateHomeBoardCategoryRequest, HomeBoardPreferencesView, UpdateHomeBoardCategoryRequest } from '@worklite/contracts';
import { homeBoardAssignments, homeBoardCategories, workflowVersions, workflows, type Database, type StoredWorkflowDefinition } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';

@Injectable()
export class HomeBoardCategoriesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
  ) {}

  async list(request: Request): Promise<HomeBoardPreferencesView> {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    const [categoryRows, assignmentRows] = await Promise.all([
      this.db.select().from(homeBoardCategories).where(eq(homeBoardCategories.workspaceId, workspace.id)).orderBy(asc(homeBoardCategories.position), asc(homeBoardCategories.createdAt)),
      this.db.select().from(homeBoardAssignments).where(eq(homeBoardAssignments.workspaceId, workspace.id)),
    ]);
    const workflowIds = new Map(categoryRows.map((category) => [category.id, [] as string[]]));
    for (const assignment of assignmentRows) workflowIds.get(assignment.categoryId)?.push(assignment.workflowId);

    return {
      categories: categoryRows.map((category) => ({
        id: category.id,
        workspaceSlug: workspace.slug,
        name: category.name,
        position: category.position,
        workflowIds: workflowIds.get(category.id) ?? [],
        createdAt: category.createdAt.toISOString(),
        updatedAt: category.updatedAt.toISOString(),
      })),
    };
  }

  async create(request: Request, input: CreateHomeBoardCategoryRequest): Promise<HomeBoardPreferencesView> {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    const name = normalizeName(input?.name);
    const existing = await this.list(request);
    if (existing.categories.some((category) => category.name === name)) throw new BadRequestException('A Home board category with this name already exists.');
    const now = new Date();
    await this.db.insert(homeBoardCategories).values({
      id: `hbcat_${randomUUID()}`,
      workspaceId: workspace.id,
      name,
      position: existing.categories.length,
      createdAt: now,
      updatedAt: now,
    });
    return this.list(request);
  }

  async update(request: Request, categoryId: string, input: UpdateHomeBoardCategoryRequest): Promise<HomeBoardPreferencesView> {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    const name = normalizeName(input?.name);
    await this.getCategory(workspace.id, categoryId);
    const duplicates = await this.db.select({ id: homeBoardCategories.id }).from(homeBoardCategories).where(and(eq(homeBoardCategories.workspaceId, workspace.id), eq(homeBoardCategories.name, name))).limit(1);
    if (duplicates[0] && duplicates[0].id !== categoryId) throw new BadRequestException('A Home board category with this name already exists.');
    await this.db.update(homeBoardCategories).set({ name, updatedAt: new Date() }).where(and(eq(homeBoardCategories.workspaceId, workspace.id), eq(homeBoardCategories.id, categoryId)));
    return this.list(request);
  }

  async delete(request: Request, categoryId: string): Promise<HomeBoardPreferencesView> {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    await this.getCategory(workspace.id, categoryId);
    await this.db.delete(homeBoardCategories).where(and(eq(homeBoardCategories.workspaceId, workspace.id), eq(homeBoardCategories.id, categoryId)));
    return this.list(request);
  }

  async assign(request: Request, input: AssignHomeBoardRequest): Promise<HomeBoardPreferencesView> {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    const workflowId = input?.workflowId;
    if (typeof workflowId !== 'string' || !workflowId) throw new BadRequestException('A Workflow id is required.');
    if (input.categoryId !== null && (typeof input.categoryId !== 'string' || !input.categoryId)) throw new BadRequestException('A category id or null is required.');

    await this.getDashboardWorkflow(workspace.id, workflowId);
    if (input.categoryId !== null) await this.getCategory(workspace.id, input.categoryId);

    const categoryId = input.categoryId;
    const now = new Date();
    await this.db.transaction((transaction) => {
      const [existing] = transaction.select().from(homeBoardAssignments).where(and(eq(homeBoardAssignments.workspaceId, workspace.id), eq(homeBoardAssignments.workflowId, workflowId))).limit(1).all();
      if (!categoryId) {
        transaction.delete(homeBoardAssignments).where(and(eq(homeBoardAssignments.workspaceId, workspace.id), eq(homeBoardAssignments.workflowId, workflowId))).run();
        return;
      }
      if (existing) {
        transaction.update(homeBoardAssignments).set({ categoryId, updatedAt: now }).where(and(eq(homeBoardAssignments.workspaceId, workspace.id), eq(homeBoardAssignments.workflowId, workflowId))).run();
        return;
      }
      transaction.insert(homeBoardAssignments).values({
        workspaceId: workspace.id,
        workflowId,
        categoryId,
        createdAt: now,
        updatedAt: now,
      }).run();
    });
    return this.list(request);
  }

  private async getCategory(workspaceId: string, categoryId: string) {
    const [category] = await this.db.select().from(homeBoardCategories).where(and(eq(homeBoardCategories.workspaceId, workspaceId), eq(homeBoardCategories.id, categoryId))).limit(1);
    if (!category) throw new NotFoundException('Home board category not found.');
    return category;
  }

  private async getDashboardWorkflow(workspaceId: string, workflowId: string) {
    const [workflow] = await this.db.select({ id: workflows.id }).from(workflows).where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId))).limit(1);
    if (!workflow) throw new NotFoundException('Workflow not found.');
    const [version] = await this.db.select({ definition: workflowVersions.definition }).from(workflowVersions)
      .where(and(eq(workflowVersions.workspaceId, workspaceId), eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.published, true)))
      .orderBy(desc(workflowVersions.version))
      .limit(1);
    const definition = version?.definition as StoredWorkflowDefinition | null | undefined;
    if (!definition?.nodes.some((node) => node.type === 'worklite/dashboard')) throw new BadRequestException('Only Workflow Dashboard-node boards can be assigned to Home categories.');
  }
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestException('A Home board category name is required.');
  return value.trim();
}
