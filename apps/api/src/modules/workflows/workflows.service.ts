import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
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
  agentVersions,
  skills,
  workflows,
  type Database,
  type StoredWorkflowDefinition,
  type StoredWorkflowEditOperation,
} from '@worklite/db';
import { topologicallySortWorkflow } from '@worklite/workflow-engine';
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
    validateDefinition(definition, false);
    await this.db.transaction((transaction) => {
      transaction.insert(workflows).values({ id: workflowId, workspaceId: workspace.id, name, state: 'draft' }).run();
      transaction.insert(workflowDrafts).values({ id: draftId, workspaceId: workspace.id, workflowId, currentRevisionId: revisionId, definition }).run();
      transaction.insert(workflowEditRevisions).values({ id: revisionId, workspaceId: workspace.id, workflowId, draftId, parentRevisionId: null, source: 'manual', operations: [], snapshot: definition }).run();
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
    validateDefinition(nextDefinition, false);
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
    validateDefinition(draft.definition, true);
    const agentVersionIds = draft.definition.nodes.flatMap((node) => {
      const config = isRecord(node.config) ? node.config : {};
      return node.type === 'worklite/generic-agent' && typeof config.agentVersionId === 'string' ? [config.agentVersionId] : [];
    });
    const availableAgentVersions = agentVersionIds.length === 0 ? [] : await this.db.select({ id: agentVersions.id, skillIds: agentVersions.skillIds }).from(agentVersions).where(and(eq(agentVersions.workspaceId, workspace.id), inArray(agentVersions.id, agentVersionIds)));
    if (availableAgentVersions.length !== new Set(agentVersionIds).size) throw new BadRequestException('Every Agent node must reference an AgentVersion from this workspace.');
    const skillSetIds = [...new Set(draft.definition.nodes.flatMap((node) => {
      if (node.type !== 'worklite/skill-set') return [];
      const skillIds = isRecord(node.config) ? node.config.skillIds : [];
      return Array.isArray(skillIds) ? skillIds.filter((skillId): skillId is string => typeof skillId === 'string') : [];
    }))];
    const availableSkills = skillSetIds.length === 0 ? [] : await this.db.select({ id: skills.id }).from(skills).where(and(eq(skills.workspaceId, workspace.id), inArray(skills.id, skillSetIds)));
    if (availableSkills.length !== skillSetIds.length) throw new BadRequestException('Every Skill Set must reference Skills from this workspace.');
    const versionsById = new Map(availableAgentVersions.map((version) => [version.id, version]));
    for (const node of draft.definition.nodes.filter((candidate) => candidate.type === 'worklite/generic-agent')) {
      const config = isRecord(node.config) ? node.config : {};
      const version = typeof config.agentVersionId === 'string' ? versionsById.get(config.agentVersionId) : undefined;
      const skillEdge = draft.definition.edges.find((edge) => edge.targetNodeId === node.id && edge.targetPort === 'skills');
      const skillNode = skillEdge ? draft.definition.nodes.find((candidate) => candidate.id === skillEdge.sourceNodeId) : undefined;
      const requestedSkillIds = skillNode && isRecord(skillNode.config) && Array.isArray(skillNode.config.skillIds) ? skillNode.config.skillIds : [];
      if (!version || requestedSkillIds.some((skillId) => typeof skillId !== 'string' || !(version.skillIds ?? []).includes(skillId))) {
        throw new BadRequestException('Every connected Skill must be authorized by the Generic Agent AgentVersion.');
      }
    }
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
    validateDefinition(draft.definition, false);
    const currentRevision = draft.currentRevisionId ? await this.loadRevision(row.workspaceId, draft.currentRevisionId) : null;
    const canRedo = currentRevision
      ? (await this.db.select({ id: workflowEditRevisions.id }).from(workflowEditRevisions).where(and(eq(workflowEditRevisions.draftId, draft.id), eq(workflowEditRevisions.parentRevisionId, currentRevision.id))).limit(1)).length > 0
      : false;
    return { ...view, draft: { id: draft.id, workflowId: draft.workflowId, revisionId: draft.currentRevisionId ?? '', definition: draft.definition as WorkflowDefinition, canUndo: Boolean(currentRevision?.parentRevisionId), canRedo, updatedAt: draft.updatedAt.toISOString() } };
  }

  private async toView(row: typeof workflows.$inferSelect, workspaceSlug: string): Promise<WorkflowView> {
    const [version] = await this.db.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, row.id), eq(workflowVersions.published, true))).orderBy(desc(workflowVersions.version)).limit(1);
    const [lastRun] = await this.db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, row.id)).orderBy(desc(workflowRuns.createdAt)).limit(1);
    return { id: row.id, workspaceSlug, latestVersionId: version?.id ?? null, latestVersion: version?.version ?? null, name: row.name, state: row.state, stepCount: (version?.definition as StoredWorkflowDefinition | null)?.nodes.length ?? version?.nodes.length ?? 0, lastRunStatus: lastRun?.status ?? null, lastRunAt: lastRun?.createdAt.toISOString() ?? null, updatedAt: row.updatedAt.toISOString() };
  }
}

function normalizeDefinition(input: WorkflowDefinition | StoredWorkflowDefinition): StoredWorkflowDefinition {
  const definition = structuredClone(input) as StoredWorkflowDefinition;
  return { schemaVersion: definition.schemaVersion ?? 3, input: definition.input ?? {}, defaults: definition.defaults ?? { errorPolicy: 'stop' }, nodes: definition.nodes ?? [], edges: definition.edges ?? [] };
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
        next.edges = next.edges.filter((edge) => edge.sourceNodeId !== operation.nodeId && edge.targetNodeId !== operation.nodeId);
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
        if (index < 0) throw new BadRequestException('The node to move was not found.');
        next.nodes[index] = { ...next.nodes[index], position: structuredClone(operation.position) };
        break;
      }
      case 'addEdge':
        if (next.edges.some((edge) => edge.id === operation.edge.id)) throw new BadRequestException('The edge identifier already exists.');
        next.edges.push(structuredClone(operation.edge));
        break;
      case 'removeEdge': {
        const index = next.edges.findIndex((edge) => edge.id === operation.edgeId);
        if (index < 0) throw new BadRequestException('The edge to remove was not found.');
        next.edges.splice(index, 1);
        break;
      }
      case 'updateSettings':
        if (operation.input !== undefined) next.input = structuredClone(operation.input);
        if (operation.defaults !== undefined) next.defaults = structuredClone(operation.defaults);
        break;
    }
  }
  return next;
}

function validateDefinition(definition: StoredWorkflowDefinition, requireAgentVersions: boolean): void {
  if (definition.schemaVersion !== 3) throw new BadRequestException('Workflow schema version 3 is required.');
  if (!definition.input || !definition.defaults || !Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) throw new BadRequestException('The workflow definition is invalid.');
  const ids = new Set<string>();
  definition.nodes.forEach((node) => {
    if (!node.id || ids.has(node.id) || !node.type || !node.typeVersion || !Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y)) throw new BadRequestException('The workflow contains an invalid node.');
    if (!['worklite/input', 'worklite/text', 'worklite/skill-set', 'worklite/generic-agent'].includes(node.type)) throw new BadRequestException(`The node type ${node.type} is not supported.`);
    if (node.type === 'worklite/generic-agent') {
      const config = isRecord(node.config) ? node.config : null;
      if (!config) throw new BadRequestException('Generic Agent node configuration must be an object.');
      if (requireAgentVersions && (typeof config.agentVersionId !== 'string' || !config.agentVersionId.trim())) throw new BadRequestException('Every Generic Agent node must reference an immutable AgentVersion before publication.');
    }
    if (node.type === 'worklite/text') {
      const config = isRecord(node.config) ? node.config : null;
      if (!config || (config.text !== undefined && typeof config.text !== 'string')) throw new BadRequestException('Text node configuration must contain a string text value.');
    }
    if (node.type === 'worklite/skill-set') {
      const config = isRecord(node.config) ? node.config : null;
      if (!config || !Array.isArray(config.skillIds) || config.skillIds.some((skillId) => typeof skillId !== 'string')) throw new BadRequestException('Skill Set node configuration must contain Skill identifiers.');
    }
    ids.add(node.id);
  });

  const edgeIds = new Set<string>();
  const inputs = new Set<string>();
  for (const edge of definition.edges) {
    const source = definition.nodes.find((node) => node.id === edge.sourceNodeId);
    const target = definition.nodes.find((node) => node.id === edge.targetNodeId);
    const inputKey = `${edge.targetNodeId}:${edge.targetPort}`;
    if (!edge.id || edgeIds.has(edge.id)) throw new BadRequestException('The workflow contains a duplicate edge identifier.');
    if (!source || !target) throw new BadRequestException('A workflow edge references an unavailable node.');
    if (source.id === target.id) throw new BadRequestException('A workflow node cannot connect to itself.');
    if (edge.sourcePort !== 'output' || target.type !== 'worklite/generic-agent' || !['context', 'systemPrompt', 'skills'].includes(edge.targetPort)) throw new BadRequestException('The workflow edge references an unavailable port.');
    if (edge.targetPort === 'systemPrompt' && source.type !== 'worklite/text') throw new BadRequestException('Generic Agent systemPrompt must connect to a Text node.');
    if (edge.targetPort === 'skills' && source.type !== 'worklite/skill-set') throw new BadRequestException('Generic Agent skills must connect to a Skill Set node.');
    if (edge.targetPort === 'context' && source.type === 'worklite/skill-set') throw new BadRequestException('A Skill Set cannot provide Generic Agent context.');
    if (inputs.has(inputKey)) throw new BadRequestException('A workflow input port accepts only one edge.');
    if (definition.edges.some((candidate) => candidate.id !== edge.id && candidate.sourceNodeId === edge.sourceNodeId && candidate.sourcePort === edge.sourcePort && candidate.targetNodeId === edge.targetNodeId && candidate.targetPort === edge.targetPort)) throw new BadRequestException('The workflow contains a duplicate connection.');
    edgeIds.add(edge.id);
    inputs.add(inputKey);
  }

  if (requireAgentVersions) {
    for (const node of definition.nodes.filter((candidate) => candidate.type === 'worklite/generic-agent')) {
      const connectedPorts = new Set(definition.edges.filter((edge) => edge.targetNodeId === node.id).map((edge) => edge.targetPort));
      if (!connectedPorts.has('context') || !connectedPorts.has('systemPrompt')) throw new BadRequestException('Every Generic Agent requires connected context and systemPrompt inputs before publication.');
    }
  }

  try {
    topologicallySortWorkflow(definition);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'The workflow graph is invalid.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function toVersionView(row: typeof workflowVersions.$inferSelect): WorkflowVersionView {
  const definition = row.definition as StoredWorkflowDefinition | null;
  if (!definition) throw new BadRequestException('Workflow schema version 3 is required.');
  validateDefinition(definition, false);
  return { id: row.id, workflowId: row.workflowId, version: row.version, schemaVersion: definition.schemaVersion, definition: definition as WorkflowDefinition, sourceRevisionId: row.sourceRevisionId, publishedAt: (row.publishedAt ?? row.createdAt).toISOString(), publishedBy: row.publishedBy ?? 'You' };
}
