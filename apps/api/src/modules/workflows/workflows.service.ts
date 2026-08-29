import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Request } from 'express';
import type {
  ApplyWorkflowDraftOperationsRequest,
  CreateWorkflowRequest,
  WorkflowDefinition,
  WorkflowDetailView,
  WorkflowEditOperation,
  WorkflowVersionView,
  WorkflowView,
} from '@worklite/contracts';
import {
  emptyWorkflowDefinition,
  workflowDrafts,
  workflowEditRevisions,
  workflowVersions,
  workflowRuns,
  workflows,
  type Database,
  type StoredWorkflowDefinition,
  type StoredWorkflowEditOperation,
} from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';

@Injectable()
export class WorkflowsService {
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly workspaces: WorkspaceService) {}

  async list(request: Request, workspaceSlug: string): Promise<WorkflowView[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const rows = await this.db.select().from(workflows).where(eq(workflows.workspaceId, workspace.id));
    return Promise.all(rows.map((row) => this.toView(row, workspaceSlug)));
  }

  async get(request: Request, workspaceSlug: string, workflowId: string): Promise<WorkflowDetailView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const row = await this.findWorkflow(workspace.id, workflowId);
    if (!row) throw new NotFoundException('Workflow not found');
    await this.ensureDraft(row);
    return this.toDetail(row, workspaceSlug);
  }

  async create(request: Request, workspaceSlug: string, input: CreateWorkflowRequest): Promise<WorkflowDetailView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('Workflow name is required.');
    const workflowId = `wf_${randomUUID()}`;
    const draftId = `wfd_${randomUUID()}`;
    const revisionId = `wfr_${randomUUID()}`;
    const definition = normalizeDefinition(input.definition ?? emptyWorkflowDefinition);
    await this.db.transaction((transaction) => {
      transaction.insert(workflows).values({ id: workflowId, workspaceId: workspace.id, name, state: 'draft' }).run();
      transaction.insert(workflowEditRevisions).values({ id: revisionId, workspaceId: workspace.id, workflowId, draftId, parentRevisionId: null, source: 'manual', operations: [], snapshot: definition }).run();
      transaction.insert(workflowDrafts).values({ id: draftId, workspaceId: workspace.id, workflowId, currentRevisionId: revisionId, definition }).run();
    });
    return this.get(request, workspaceSlug, workflowId);
  }

  async update(request: Request, workspaceSlug: string, workflowId: string, input: Partial<CreateWorkflowRequest>): Promise<WorkflowDetailView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const existing = await this.findWorkflow(workspace.id, workflowId);
    if (!existing) throw new NotFoundException('Workflow not found');
    const name = input.name === undefined ? existing.name : input.name.trim();
    if (!name) throw new BadRequestException('Workflow name is required.');
    await this.db.update(workflows).set({ name, updatedAt: new Date() }).where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspace.id)));
    return this.get(request, workspaceSlug, workflowId);
  }

  async applyOperations(request: Request, workspaceSlug: string, workflowId: string, input: ApplyWorkflowDraftOperationsRequest): Promise<WorkflowDetailView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const workflow = await this.findWorkflow(workspace.id, workflowId);
    if (!workflow) throw new NotFoundException('Workflow not found');
    if (!input || typeof input.baseRevisionId !== 'string' || !Array.isArray(input.operations) || input.operations.length === 0) throw new BadRequestException('A base revision and at least one workflow operation are required.');
    await this.ensureDraft(workflow);
    const draft = await this.loadDraft(workspace.id, workflowId);
    if (!draft || draft.currentRevisionId !== input.baseRevisionId) throw new ConflictException('The workflow draft changed. Reload it before applying edits.');
    const currentRevision = await this.loadRevision(workspace.id, input.baseRevisionId);
    if (!currentRevision) throw new ConflictException('The workflow base revision is unavailable.');
    const nextDefinition = applyOperations(currentRevision.snapshot, input.operations);
    const revisionId = `wfr_${randomUUID()}`;
    await this.db.transaction((transaction) => {
      const current = transaction.select({ currentRevisionId: workflowDrafts.currentRevisionId }).from(workflowDrafts).where(and(eq(workflowDrafts.id, draft.id), eq(workflowDrafts.workspaceId, workspace.id))).limit(1).all()[0];
      if (!current || current.currentRevisionId !== input.baseRevisionId) throw new ConflictException('The workflow draft changed. Reload it before applying edits.');
      transaction.insert(workflowEditRevisions).values({ id: revisionId, workspaceId: workspace.id, workflowId, draftId: draft.id, parentRevisionId: input.baseRevisionId, source: input.source ?? 'manual', sourceInstruction: input.sourceInstruction, operations: input.operations as StoredWorkflowEditOperation[], snapshot: nextDefinition }).run();
      transaction.update(workflowDrafts).set({ currentRevisionId: revisionId, definition: nextDefinition, updatedAt: new Date() }).where(eq(workflowDrafts.id, draft.id)).run();
      transaction.update(workflows).set({ updatedAt: new Date() }).where(eq(workflows.id, workflowId)).run();
    });
    return this.get(request, workspaceSlug, workflowId);
  }

  async undo(request: Request, workspaceSlug: string, workflowId: string): Promise<WorkflowDetailView> {
    return this.moveDraftPointer(request, workspaceSlug, workflowId, 'undo');
  }

  async redo(request: Request, workspaceSlug: string, workflowId: string): Promise<WorkflowDetailView> {
    return this.moveDraftPointer(request, workspaceSlug, workflowId, 'redo');
  }

  async publish(request: Request, workspaceSlug: string, workflowId: string): Promise<WorkflowVersionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const workflow = await this.findWorkflow(workspace.id, workflowId);
    if (!workflow) throw new NotFoundException('Workflow not found');
    await this.ensureDraft(workflow);
    const draft = await this.loadDraft(workspace.id, workflowId);
    if (!draft || !draft.currentRevisionId) throw new BadRequestException('The workflow has no draft revision.');
    validateDefinition(draft.definition);
    const hasUnversionedAgent = draft.definition.nodes.some((node) => {
      const config = isRecord(node.config) ? node.config : {};
      return node.type === 'worklite/agent' && typeof config.agentVersionId !== 'string';
    });
    if (hasUnversionedAgent) throw new BadRequestException('Every Agent node must reference an immutable AgentVersion before publication.');
    const latest = await this.db.select({ version: workflowVersions.version }).from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId)).orderBy(desc(workflowVersions.version)).limit(1);
    const versionNumber = (latest[0]?.version ?? 0) + 1;
    const versionId = `wfv_${randomUUID()}`;
    const publishedAt = new Date();
    await this.db.transaction((transaction) => {
      transaction.insert(workflowVersions).values({ id: versionId, workspaceId: workspace.id, workflowId, version: versionNumber, published: true, schemaVersion: draft.definition.schemaVersion, nodes: draft.definition.nodes, definition: draft.definition, sourceRevisionId: draft.currentRevisionId, publishedAt, publishedBy: 'You' }).run();
      transaction.update(workflows).set({ state: 'published', updatedAt: publishedAt }).where(eq(workflows.id, workflowId)).run();
    });
    const [version] = await this.db.select().from(workflowVersions).where(eq(workflowVersions.id, versionId)).limit(1);
    if (!version) throw new NotFoundException('Workflow version could not be published');
    return toVersionView(version);
  }

  async versions(request: Request, workspaceSlug: string, workflowId: string): Promise<WorkflowVersionView[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const workflow = await this.findWorkflow(workspace.id, workflowId);
    if (!workflow) throw new NotFoundException('Workflow not found');
    const rows = await this.db.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.published, true))).orderBy(desc(workflowVersions.version));
    return rows.map(toVersionView);
  }

  async version(request: Request, workspaceSlug: string, versionId: string): Promise<WorkflowVersionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [row] = await this.db.select().from(workflowVersions).where(and(eq(workflowVersions.id, versionId), eq(workflowVersions.published, true))).limit(1);
    if (!row || row.workspaceId !== workspace.id) throw new NotFoundException('Workflow version not found');
    return toVersionView(row);
  }

  private async moveDraftPointer(request: Request, workspaceSlug: string, workflowId: string, direction: 'undo' | 'redo'): Promise<WorkflowDetailView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const workflow = await this.findWorkflow(workspace.id, workflowId);
    if (!workflow) throw new NotFoundException('Workflow not found');
    await this.ensureDraft(workflow);
    const draft = await this.loadDraft(workspace.id, workflowId);
    if (!draft?.currentRevisionId) return this.get(request, workspaceSlug, workflowId);
    const current = await this.loadRevision(workspace.id, draft.currentRevisionId);
    if (!current) return this.get(request, workspaceSlug, workflowId);
    const target = direction === 'undo'
      ? current.parentRevisionId ? await this.loadRevision(workspace.id, current.parentRevisionId) : null
      : (await this.db.select().from(workflowEditRevisions).where(and(eq(workflowEditRevisions.workspaceId, workspace.id), eq(workflowEditRevisions.draftId, draft.id), eq(workflowEditRevisions.parentRevisionId, current.id))).orderBy(desc(workflowEditRevisions.createdAt)).limit(1))[0] ?? null;
    if (!target) return this.get(request, workspaceSlug, workflowId);
    await this.db.update(workflowDrafts).set({ currentRevisionId: target.id, definition: target.snapshot, updatedAt: new Date() }).where(eq(workflowDrafts.id, draft.id));
    return this.get(request, workspaceSlug, workflowId);
  }

  private async findWorkflow(workspaceId: string, workflowId: string) {
    const [row] = await this.db.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspaceId))).limit(1);
    return row;
  }

  private async ensureDraft(workflow: typeof workflows.$inferSelect): Promise<void> {
    const [existing] = await this.db.select({ id: workflowDrafts.id }).from(workflowDrafts).where(eq(workflowDrafts.workflowId, workflow.id)).limit(1);
    if (existing) return;
    const draftId = `wfd_${randomUUID()}`;
    const revisionId = `wfr_${randomUUID()}`;
    await this.db.transaction((transaction) => {
      transaction.insert(workflowEditRevisions).values({ id: revisionId, workspaceId: workflow.workspaceId, workflowId: workflow.id, draftId, parentRevisionId: null, source: 'migration', sourceInstruction: 'Initialized from the existing workflow definition.', operations: [], snapshot: emptyWorkflowDefinition }).run();
      transaction.insert(workflowDrafts).values({ id: draftId, workspaceId: workflow.workspaceId, workflowId: workflow.id, currentRevisionId: revisionId, definition: emptyWorkflowDefinition }).run();
    });
  }

  private async loadDraft(workspaceId: string, workflowId: string) {
    const [draft] = await this.db.select().from(workflowDrafts).where(and(eq(workflowDrafts.workspaceId, workspaceId), eq(workflowDrafts.workflowId, workflowId))).limit(1);
    return draft;
  }

  private async loadRevision(workspaceId: string, revisionId: string) {
    const [revision] = await this.db.select().from(workflowEditRevisions).where(and(eq(workflowEditRevisions.workspaceId, workspaceId), eq(workflowEditRevisions.id, revisionId))).limit(1);
    return revision;
  }

  private async toDetail(row: typeof workflows.$inferSelect, workspaceSlug: string): Promise<WorkflowDetailView> {
    const view = await this.toView(row, workspaceSlug);
    const draft = await this.loadDraft(row.workspaceId, row.id);
    if (!draft) throw new NotFoundException('Workflow draft not found');
    const currentRevision = draft.currentRevisionId ? await this.loadRevision(row.workspaceId, draft.currentRevisionId) : null;
    const canRedo = currentRevision
      ? (await this.db.select({ id: workflowEditRevisions.id }).from(workflowEditRevisions).where(and(eq(workflowEditRevisions.draftId, draft.id), eq(workflowEditRevisions.parentRevisionId, currentRevision.id))).limit(1)).length > 0
      : false;
    return { ...view, draft: { id: draft.id, workflowId: draft.workflowId, revisionId: draft.currentRevisionId ?? '', definition: draft.definition as WorkflowDefinition, canUndo: Boolean(currentRevision?.parentRevisionId), canRedo, updatedAt: draft.updatedAt.toISOString() } };
  }

  private async toView(row: typeof workflows.$inferSelect, workspaceSlug: string): Promise<WorkflowView> {
    const [version] = await this.db.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, row.id), eq(workflowVersions.published, true))).orderBy(desc(workflowVersions.version)).limit(1);
    const [lastRun] = await this.db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, row.id)).orderBy(desc(workflowRuns.createdAt)).limit(1);
    return { id: row.id, workspaceSlug, latestVersionId: version?.id ?? null, name: row.name, state: row.state, stepCount: (version?.definition as StoredWorkflowDefinition | null)?.nodes.length ?? version?.nodes.length ?? 0, lastRunStatus: lastRun?.status ?? null, lastRunAt: lastRun?.createdAt.toISOString() ?? null, updatedAt: row.updatedAt.toISOString() };
  }
}

function normalizeDefinition(input: WorkflowDefinition | StoredWorkflowDefinition): StoredWorkflowDefinition {
  const definition = structuredClone(input) as StoredWorkflowDefinition;
  return { schemaVersion: definition.schemaVersion ?? 1, input: definition.input ?? {}, defaults: definition.defaults ?? { errorPolicy: 'stop' }, nodes: reindex(definition.nodes ?? []) };
}

function applyOperations(current: StoredWorkflowDefinition, operations: WorkflowEditOperation[]): StoredWorkflowDefinition {
  const next = normalizeDefinition(current);
  for (const operation of operations) {
    switch (operation.type) {
      case 'addNode':
        if (!Number.isInteger(operation.index) || operation.index < 0 || operation.index > next.nodes.length) throw new BadRequestException('The node insertion position is invalid.');
        if (next.nodes.some((node) => node.id === operation.node.id)) throw new BadRequestException('The node identifier already exists.');
        next.nodes.splice(operation.index, 0, structuredClone(operation.node));
        break;
      case 'removeNode': {
        const index = next.nodes.findIndex((node) => node.id === operation.nodeId);
        if (index < 0) throw new BadRequestException('The node to remove was not found.');
        next.nodes.splice(index, 1);
        break;
      }
      case 'updateNode': {
        const index = next.nodes.findIndex((node) => node.id === operation.nodeId);
        if (index < 0) throw new BadRequestException('The node to update was not found.');
        next.nodes[index] = { ...next.nodes[index], ...structuredClone(operation.patch) };
        break;
      }
      case 'moveNode': {
        const index = next.nodes.findIndex((node) => node.id === operation.nodeId);
        if (index < 0 || !Number.isInteger(operation.index) || operation.index < 0 || operation.index >= next.nodes.length) throw new BadRequestException('The node move position is invalid.');
        const [node] = next.nodes.splice(index, 1);
        next.nodes.splice(operation.index, 0, node);
        break;
      }
      case 'updateSettings':
        if (operation.input !== undefined) next.input = structuredClone(operation.input);
        if (operation.defaults !== undefined) next.defaults = structuredClone(operation.defaults);
        break;
    }
  }
  return { ...next, nodes: reindex(next.nodes) };
}

function reindex(nodes: StoredWorkflowDefinition['nodes']): StoredWorkflowDefinition['nodes'] {
  return nodes.map((node, index) => ({ ...node, position: index + 1 }));
}

function validateDefinition(definition: StoredWorkflowDefinition): void {
  if (!Number.isInteger(definition.schemaVersion) || !definition.input || !definition.defaults || !Array.isArray(definition.nodes)) throw new BadRequestException('The workflow definition is invalid.');
  const ids = new Set<string>();
  definition.nodes.forEach((node, index) => {
    if (!node.id || ids.has(node.id) || node.position !== index + 1 || !node.type || !node.typeVersion) throw new BadRequestException('The workflow contains an invalid node sequence.');
    ids.add(node.id);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function toVersionView(row: typeof workflowVersions.$inferSelect): WorkflowVersionView {
  const definition = (row.definition as StoredWorkflowDefinition | null) ?? { ...emptyWorkflowDefinition, schemaVersion: row.schemaVersion, nodes: row.nodes };
  return { id: row.id, workflowId: row.workflowId, version: row.version, schemaVersion: definition.schemaVersion, definition: definition as WorkflowDefinition, sourceRevisionId: row.sourceRevisionId, publishedAt: (row.publishedAt ?? row.createdAt).toISOString(), publishedBy: row.publishedBy ?? 'You' };
}
